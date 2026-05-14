import { NextResponse } from "next/server";
import OpenAI from "openai";
import { trackOpenAIUsage, resetCampaignAIUsage } from "@/lib/ai-usage";

// 5-minute timeout: required for Top X scans on large lead lists (5K-10K records).
// At 10K leads:
//   - listRecords pagination: ~15-20s
//   - Smart Compile deterministic scoring: <1s
//   - Optional fuzzy AI on borderline candidates: 10-30s
//   - Tasks creation: 1-2s
// Total well under 300s. Default Vercel function timeout (10s) was guaranteed to fail.
export const maxDuration = 300;

const API_KEY = process.env.AIRTABLE_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID; // master base — stores Campaigns registry
const API = "https://api.airtable.com/v0";
const META = "https://api.airtable.com/v0/meta/bases";

const hdrs = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};
const authHdr = { Authorization: `Bearer ${API_KEY}` };

// ─── Helpers to build URLs per base ─────────────────────────────
const baseUrl = (baseId) => `${API}/${baseId}`;
const metaUrl = (baseId) => `${META}/${baseId}`;

// ─── Extract base ID from Airtable URL ──────────────────────────
function extractBaseId(input) {
  if (!input) return null;
  const s = input.trim();
  // Direct base ID
  if (/^app[a-zA-Z0-9]{10,17}$/.test(s)) return s;
  // URL: https://airtable.com/appXXXXX/...
  const m = s.match(/airtable\.com\/(app[a-zA-Z0-9]{10,17})/);
  return m ? m[1] : null;
}

// ═══════════════════════════════════════════════════════════════
// CORE CRUD — all take baseId as first param
// ═══════════════════════════════════════════════════════════════

async function listRecords(baseId, table, params = {}) {
  const qs = new URLSearchParams();
  if (params.view) qs.set("view", params.view);
  if (params.maxRecords) qs.set("maxRecords", params.maxRecords);
  if (params.filterByFormula) qs.set("filterByFormula", params.filterByFormula);
  if (params.sort) {
    params.sort.forEach((s, i) => {
      qs.set(`sort[${i}][field]`, s.field);
      if (s.direction) qs.set(`sort[${i}][direction]`, s.direction);
    });
  }
  let allRecords = [];
  let offset = null;
  do {
    const url = offset
      ? `${baseUrl(baseId)}/${encodeURIComponent(table)}?${qs.toString()}&offset=${offset}`
      : `${baseUrl(baseId)}/${encodeURIComponent(table)}?${qs.toString()}`;

    // Airtable rate limit: 5 req/sec per base. With 100 paginated calls for 10K records,
    // we shouldn't hit this naturally (sequential), but if other API calls are happening
    // in parallel we might. Retry on 429 with exponential backoff.
    let res;
    let attempt = 0;
    const maxAttempts = 4;
    while (attempt < maxAttempts) {
      res = await fetch(url, { headers: authHdr });
      if (res.status !== 429) break;
      const backoffMs = Math.min(30000, 1000 * Math.pow(2, attempt)); // 1s, 2s, 4s, 8s, capped at 30s
      console.warn(`[listRecords] 429 rate limit on ${table}, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${maxAttempts})`);
      await new Promise(r => setTimeout(r, backoffMs));
      attempt++;
    }

    if (!res.ok) {
      const err = await res.text();
      console.error(`LIST ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);
  return allRecords;
}

// Cache to avoid re-checking fields on every write within the same request
const _ensuredFieldsCache = new Map(); // key: baseId+table, value: Set of field names

// Known field type overrides — autoEnsure uses these instead of defaulting to singleLineText
const FIELD_TYPE_MAP = {
  "Score": { type: "number", options: { precision: 0 } },
  "Score Reason": { type: "multilineText" },
  "Top N": { type: "number", options: { precision: 0 } },
  "DM Step": { type: "number", options: { precision: 0 } },
  "Description": { type: "multilineText" },
  "Scoring Prompt": { type: "multilineText" },
  "Scoring Fields": { type: "multilineText" },
  "Compiled Rules JSON": { type: "multilineText" },
  "Outreach Config": { type: "multilineText" },
  "Keywords": { type: "multilineText" },
  "Job Title Keywords": { type: "multilineText" },
  "Signal": { type: "multilineText" },
  "Tables": { type: "multilineText" },
  "Notes": { type: "multilineText" },
  // Common lead-content fields that tend to be long-form. Created as multilineText
  // so they display correctly in Airtable instead of as truncated single-line text.
  "Lead Summary": { type: "multilineText" },
  "Lead Description": { type: "multilineText" },
  "Lead Relevance Score Reason": { type: "multilineText" },
  "Lead Relevance Score": { type: "number", options: { precision: 1 } },
  "About": { type: "multilineText" },
  "Headline": { type: "multilineText" },
  "Bio": { type: "multilineText" },
  "Reasoning": { type: "multilineText" },
};

async function autoEnsureFields(baseId, table, records) {
  const fieldNames = new Set();
  for (const r of records) {
    const fields = r.fields || r;
    for (const k of Object.keys(fields)) {
      const clean = cleanFieldName(k);
      if (clean && clean !== "id") fieldNames.add(clean);
    }
  }
  if (!fieldNames.size) return;

  const cacheKey = `${baseId}:${table}`;
  const cached = _ensuredFieldsCache.get(cacheKey) || new Set();
  const toEnsure = [...fieldNames].filter(f => !cached.has(f));
  if (!toEnsure.length) return;

  // Build field defs with correct types
  const fieldDefs = toEnsure.map(name => {
    const override = FIELD_TYPE_MAP[name];
    if (override) return { name, ...override };
    return { name, type: "singleLineText" };
  });

  try {
    await ensureCustomFields(baseId, table, fieldDefs);
    toEnsure.forEach(f => cached.add(f));
    _ensuredFieldsCache.set(cacheKey, cached);
  } catch (e) {
    console.warn(`autoEnsureFields ${table}:`, e.message);
  }
}

async function createRecords(baseId, table, records) {
  await autoEnsureFields(baseId, table, records);
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ fields: sanitizeFields(r) }));
    const validBatch = batch.filter(r => Object.keys(r.fields).length > 0);
    if (!validBatch.length) continue;

    const res = await fetch(`${baseUrl(baseId)}/${encodeURIComponent(table)}`, {
      method: "POST", headers: hdrs,
      body: JSON.stringify({ records: validBatch, typecast: true }),
    });
    if (res.ok) {
      const data = await res.json();
      results.push(...(data.records || []));
      continue;
    }

    // Batch failed — fall back to one-at-a-time so we skip bad records instead of losing the whole batch
    const err = await res.text();
    console.warn(`CREATE ${table}: batch of ${validBatch.length} failed (${err.slice(0, 120)}), inserting one-by-one...`);

    for (const rec of validBatch) {
      try {
        const r1 = await fetch(`${baseUrl(baseId)}/${encodeURIComponent(table)}`, {
          method: "POST", headers: hdrs,
          body: JSON.stringify({ records: [{ fields: stringifyFields(rec.fields) }], typecast: true }),
        });
        if (r1.ok) {
          const d = await r1.json();
          results.push(...(d.records || []));
        } else {
          const e1 = await r1.text();
          console.error(`CREATE ${table} skip record:`, e1.slice(0, 100), "→", JSON.stringify(rec.fields).slice(0, 150));
        }
      } catch (e) { console.error(`CREATE ${table} single:`, e.message); }
    }
  }
  return results;
}

async function updateRecords(baseId, table, records) {
  await autoEnsureFields(baseId, table, records);
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ id: r.id, fields: sanitizeFields(r.fields || r) }));
    const validBatch = batch.filter(r => r.id && Object.keys(r.fields).length > 0);
    if (!validBatch.length) continue;

    const res = await fetch(`${baseUrl(baseId)}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: hdrs,
      body: JSON.stringify({ records: validBatch, typecast: true }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`UPDATE ${table} error:`, err.slice(0, 300));
      const safeBatch = validBatch.map(r => ({ id: r.id, fields: stringifyFields(r.fields) }));
      const retry = await fetch(`${baseUrl(baseId)}/${encodeURIComponent(table)}`, {
        method: "PATCH", headers: hdrs,
        body: JSON.stringify({ records: safeBatch, typecast: true }),
      });
      if (retry.ok) { const d = await retry.json(); results.push(...(d.records || [])); continue; }
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    results.push(...(data.records || []));
  }
  return results;
}

// Clean field name: strip invisible chars, BOM, zero-width, trim
function cleanFieldName(name) {
  return name
    .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, "") // zero-width, BOM, non-breaking space
    .replace(/[^\x20-\x7E\u00C0-\u024F\u0400-\u04FF\u4E00-\u9FFF\u3000-\u303F]/g, "") // keep printable + common intl
    .trim();
}

// Sanitize: clean field names + values for Airtable compatibility
function sanitizeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || k === "id") continue;
    if (v === "") continue;
    const cleanKey = cleanFieldName(k);
    if (!cleanKey) continue;
    if (FIELD_TYPE_MAP[cleanKey]?.type === "number") {
      const num = parseFloat(v);
      if (!isNaN(num)) out[cleanKey] = FIELD_TYPE_MAP[cleanKey]?.options?.precision === 0 ? Math.round(num) : num;
      else out[cleanKey] = String(v);
      continue;
    }
    if (typeof v === "object") { out[cleanKey] = JSON.stringify(v); continue; }
    out[cleanKey] = typeof v === "string" ? v : String(v);
  }
  return out;
}

// Fallback: everything as strings + clean names
function stringifyFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined || v === "") continue;
    const cleanKey = cleanFieldName(k);
    if (!cleanKey) continue;
    out[cleanKey] = String(v);
  }
  return out;
}

async function deleteRecords(baseId, table, recordIds) {
  const results = [];
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    const qs = batch.map(id => `records[]=${id}`).join("&");
    const res = await fetch(`${baseUrl(baseId)}/${encodeURIComponent(table)}?${qs}`, {
      method: "DELETE", headers: authHdr,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`DELETE ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    results.push(...(data.records || []));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// SCHEMA / FIELD MANAGEMENT
// ═══════════════════════════════════════════════════════════════

const SCHEMA = {
  "Accounts": [
    { name: "Name", type: "singleLineText" },
    { name: "Domain", type: "singleLineText" },
    { name: "Industry", type: "singleLineText" },
    { name: "Size", type: "singleLineText" },
    { name: "LinkedIn URL", type: "singleLineText" },
    { name: "Country", type: "singleLineText" },
  ],
  "Leads": [
    { name: "Name", type: "singleLineText" },
    { name: "Email", type: "singleLineText" },
    { name: "Title", type: "singleLineText" },
    { name: "Company", type: "singleLineText" },
    { name: "LinkedIn URL", type: "singleLineText" },
    { name: "Phone", type: "singleLineText" },
    { name: "Campaign Tag", type: "singleLineText" },
    { name: "Custom Code", type: "singleLineText" },
    { name: "GA Sessions", type: "number", options: { precision: 0 } },
    { name: "GA Engaged Sessions", type: "number", options: { precision: 0 } },
    { name: "GA Views", type: "number", options: { precision: 0 } },
    { name: "GA Views Per Session", type: "number", options: { precision: 2 } },
    { name: "GA Engagement Time", type: "number", options: { precision: 0 } },
    { name: "GA Avg Session Duration", type: "number", options: { precision: 1 } },
    { name: "GA Last Visit", type: "singleLineText" },
    { name: "GA Engagement Score", type: "number", options: { precision: 0 } },
    { name: "GA Last Synced At", type: "singleLineText" },
    // ─── Lead Movement tracking fields (auto-created on first scan run) ───
    { name: "Current Company", type: "singleLineText" },
    { name: "Current Job Title", type: "singleLineText" },
    { name: "Current Role Started At", type: "singleLineText" },
    { name: "Days In Current Role", type: "number", options: { precision: 0 } },
    { name: "Previous Company", type: "singleLineText" },
    { name: "Previous Job Title", type: "singleLineText" },
    { name: "Last LinkedIn Check", type: "singleLineText" },
    { name: "Movement Detected", type: "singleLineText" },
  ],
  "Task Rules": [
    { name: "Name", type: "singleLineText" },
    { name: "Description", type: "multilineText" },
    { name: "Task Type", type: "singleLineText" },
    { name: "Scan Target", type: "singleLineText" },
    { name: "Ease", type: "singleLineText" },
    { name: "Strength", type: "singleLineText" },
    { name: "Sources", type: "singleLineText" },
    { name: "Keywords", type: "multilineText" },
    { name: "Job Title Keywords", type: "multilineText" },
    { name: "Scoring Prompt", type: "multilineText" },
  ],
  "Prompts": [
    { name: "Name", type: "singleLineText" },
    { name: "Task Rule", type: "singleLineText" },
    { name: "Prompt", type: "multilineText" },
  ],
  "Tasks": [
    { name: "Company", type: "singleLineText" },
    { name: "Task Rule", type: "singleLineText" },
    { name: "Score", type: "number", options: { precision: 0 } },
    { name: "Score Reason", type: "multilineText" },
    { name: "Scan Target", type: "singleLineText" },
    { name: "Signal", type: "singleLineText" },
    { name: "Source", type: "singleLineText" },
    { name: "URL", type: "url" },
    { name: "Task Type", type: "singleLineText" },
    { name: "Date", type: "singleLineText" },
    { name: "Created", type: "singleLineText" },
    { name: "Phone", type: "singleLineText" },
    { name: "HubSpot Task ID", type: "singleLineText" },
    { name: "HubSpot Last Synced", type: "singleLineText" },
    // Lead Movement field — distinguishes Hired / Promoted / Exited tasks
    { name: "Movement Type", type: "singleLineText" },
  ],
  "Outreach": [
    { name: "Lead Name", type: "singleLineText" },
    { name: "LinkedIn URL", type: "singleLineText" },
    { name: "Campaign", type: "singleLineText" },
    { name: "Mode", type: "singleLineText" },
    { name: "Status", type: "singleLineText" },
    { name: "Company", type: "singleLineText" },
    { name: "Title", type: "singleLineText" },
    { name: "Email", type: "singleLineText" },
    { name: "Signal", type: "multilineText" },
    { name: "DM Step", type: "number", options: { precision: 0 } },
    { name: "Next Action Date", type: "singleLineText" },
    { name: "Created At", type: "singleLineText" },
    { name: "Connection Sent At", type: "singleLineText" },
    { name: "Connection Accepted At", type: "singleLineText" },
    { name: "Last DM Sent At", type: "singleLineText" },
    { name: "Replied At", type: "singleLineText" },
    { name: "Unipile Chat ID", type: "singleLineText" },
    { name: "Notes", type: "multilineText" },
  ],
  "Campaigns": [
    { name: "Name", type: "singleLineText" },
    { name: "Base ID", type: "singleLineText" },
    { name: "Features", type: "singleLineText" },
    { name: "Description", type: "multilineText" },
    { name: "Emoji", type: "singleLineText" },
    { name: "Tables", type: "multilineText" },
    { name: "HubSpot API Key", type: "singleLineText" },
    { name: "Smartlead API Key", type: "singleLineText" },
    { name: "LinkedIn Account ID", type: "singleLineText" },
    { name: "GA4 Property ID", type: "singleLineText" },
    { name: "GA Service Account JSON", type: "multilineText" },
    { name: "GA OAuth Refresh Token", type: "multilineText" },
    { name: "GA OAuth Email", type: "singleLineText" },
    { name: "GA Last Sync", type: "singleLineText" },
    { name: "Sender Profile", type: "multilineText" },
    { name: "Email Reference", type: "multilineText" },
    { name: "Email Purpose", type: "multilineText" },
    { name: "Email CTA Link", type: "singleLineText" },
    { name: "Email CTA Purpose", type: "multilineText" },
    { name: "Client Password", type: "singleLineText" },
    { name: "Client Access", type: "singleLineText" },
    // RapidAPI cost tracking — auto-populated by /api/scan-leads
    { name: "RapidAPI Calls Count", type: "number", options: { precision: 0 } },
    { name: "RapidAPI Total Cost USD", type: "number", options: { precision: 4 } },
    { name: "RapidAPI Last Call At", type: "singleLineText" },
    { name: "RapidAPI Usage Reset At", type: "singleLineText" },
    { name: "RapidAPI Per Call Cost USD", type: "number", options: { precision: 4 } },
  ],
  "Email Offers": [
    { name: "Name", type: "singleLineText" },
    { name: "Offer Description", type: "multilineText" },
    { name: "CTA Link", type: "singleLineText" },
    { name: "CTA Purpose", type: "multilineText" },
    { name: "Last Used At", type: "singleLineText" },
    { name: "Use Count", type: "number", options: { precision: 0 } },
  ],
  // Maps Unipile LinkedIn account_id → Airtable base ID for client. Lets one webhook
  // URL handle events from all clients — events route based on which account fired them.
  "Account Routing": [
    { name: "Name", type: "singleLineText" },
    { name: "Account ID", type: "singleLineText" },
    { name: "Account Name", type: "singleLineText" },
    { name: "Provider", type: "singleLineText" },
    { name: "Campaign Base ID", type: "singleLineText" },
    { name: "Client Name", type: "singleLineText" },
    { name: "Active", type: "checkbox", options: { icon: "check", color: "greenBright" } },
    { name: "Last Event At", type: "singleLineText" },
    { name: "Notes", type: "multilineText" },
  ],
  // Captures webhook events for accounts NOT yet in the routing table. Lets user see
  // what fell through and decide which campaign to route them to.
  "Unrouted Triggers": [
    { name: "Name", type: "singleLineText" },
    { name: "Account ID", type: "singleLineText" },
    { name: "Event Type", type: "singleLineText" },
    { name: "Event ID", type: "singleLineText" },
    { name: "Lead Name", type: "singleLineText" },
    { name: "Lead Profile URL", type: "singleLineText" },
    { name: "Signal Text", type: "multilineText" },
    { name: "Raw Payload", type: "multilineText" },
    { name: "Received", type: "singleLineText" },
  ],
};

// ─── Fetch current tables from a base ───────────────────────
async function fetchTables(baseId) {
  const res = await fetch(`${metaUrl(baseId)}/tables`, { headers: authHdr });
  if (res.status === 401 || res.status === 403) {
    const err = await res.text();
    throw new Error(`Auth failed (${res.status}). Token needs scopes: data.records:read/write, schema.bases:read/write. ${err.slice(0, 150)}`);
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to fetch schema: ${res.status} — ${err.slice(0, 200)}`);
  }
  const { tables } = await res.json();
  return tables || [];
}

// ─── Create a table with fields ─────────────────────────────
async function createTable(baseId, tableName, fieldDefs) {
  // Airtable requires at least one field to create a table.
  // The first field becomes the primary field (must be singleLineText, email, or url).
  const fields = fieldDefs.map(f => {
    const fd = { name: f.name, type: f.type };
    if (f.options) fd.options = f.options;
    return fd;
  });
  const res = await fetch(`${metaUrl(baseId)}/tables`, {
    method: "POST", headers: hdrs,
    body: JSON.stringify({ name: tableName, fields }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to create table "${tableName}": ${res.status} — ${err.slice(0, 200)}`);
  }
  return await res.json();
}

// ─── Add a single field to an existing table ────────────────
async function addField(baseId, tableId, fieldDef) {
  const body = { name: fieldDef.name, type: fieldDef.type || "singleLineText" };
  if (fieldDef.options) body.options = fieldDef.options;
  const res = await fetch(`${metaUrl(baseId)}/tables/${tableId}/fields`, {
    method: "POST", headers: hdrs, body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    if (err.includes("DUPLICATE_FIELD_NAME")) return { status: "skipped" };
    throw new Error(`${fieldDef.name}: ${err.slice(0, 120)}`);
  }
  return { status: "created" };
}

// ─── Ensure a table + its fields exist ──────────────────────
// Creates the table if missing, then adds any missing fields.
async function ensureTable(baseId, tableName, requiredFields, existingTables) {
  const results = { tables_created: [], fields_created: [], fields_skipped: [], errors: [] };
  let table = existingTables.find(t => t.name === tableName);

  if (!table) {
    // Create the table with all fields at once
    try {
      const created = await createTable(baseId, tableName, requiredFields);
      results.tables_created.push(tableName);
      results.fields_created.push(...requiredFields.map(f => `${tableName}.${f.name}`));
      return results; // all fields created with the table
    } catch (e) {
      results.errors.push(e.message);
      return results;
    }
  }

  // Table exists — add missing fields
  const existingNames = new Set((table.fields || []).map(f => f.name));
  for (const field of requiredFields) {
    if (existingNames.has(field.name)) {
      results.fields_skipped.push(`${tableName}.${field.name}`);
      continue;
    }
    try {
      const r = await addField(baseId, table.id, field);
      if (r.status === "skipped") results.fields_skipped.push(`${tableName}.${field.name}`);
      else results.fields_created.push(`${tableName}.${field.name}`);
    } catch (e) {
      results.errors.push(e.message);
    }
  }
  return results;
}

// ─── Ensure custom fields exist (auto-creates table too) ────
// fieldDefs: string[] | {name, type, options}[]
async function ensureCustomFields(baseId, tableName, fieldDefs) {
  const results = { created: [], skipped: [], errors: [] };
  let tables;
  try {
    tables = await fetchTables(baseId);
  } catch (e) {
    results.errors.push(e.message);
    return results;
  }

  // Normalize fieldDefs
  const normalized = fieldDefs.map(fd => typeof fd === "string"
    ? { name: fd, type: "singleLineText" }
    : { name: fd.name, type: fd.type || "singleLineText", options: fd.options }
  );

  let table = tables.find(t => t.name === tableName);

  // Create the table if it doesn't exist
  if (!table) {
    try {
      await createTable(baseId, tableName, normalized);
      results.created.push(...normalized.map(f => f.name));
      return results;
    } catch (e) {
      results.errors.push(e.message);
      return results;
    }
  }

  // Table exists — add missing fields
  const existingNames = new Set((table.fields || []).map(f => f.name));
  for (const fd of normalized) {
    if (existingNames.has(fd.name)) {
      results.skipped.push(fd.name);
      continue;
    }
    try {
      const r = await addField(baseId, table.id, fd);
      if (r.status === "skipped") results.skipped.push(fd.name);
      else results.created.push(fd.name);
    } catch (e) {
      results.errors.push(e.message);
    }
  }
  return results;
}

// ─── Setup: ensure ALL required tables + fields ─────────────
async function setupSchema(baseId) {
  let tables;
  try {
    tables = await fetchTables(baseId);
  } catch (e) {
    throw e;
  }

  const results = {
    tables_created: [], fields_created: [], fields_skipped: [], errors: [],
    tables_found: tables.map(t => t.name),
  };

  // Campaigns table only lives on the master base, not per-campaign bases
  const isMasterBase = baseId === MASTER_BASE_ID;
  const MASTER_ONLY_TABLES = ["Campaigns", "Account Routing", "Unrouted Triggers"];

  for (const [tableName, requiredFields] of Object.entries(SCHEMA)) {
    if (!isMasterBase && MASTER_ONLY_TABLES.includes(tableName)) continue;
    const r = await ensureTable(baseId, tableName, requiredFields, tables);
    results.tables_created.push(...r.tables_created);
    results.fields_created.push(...r.fields_created);
    results.fields_skipped.push(...r.fields_skipped);
    results.errors.push(...r.errors);

    // If we just created a table, refresh the tables list so subsequent
    // ensureTable calls see it
    if (r.tables_created.length > 0) {
      try { tables = await fetchTables(baseId); } catch (_) {}
    }
  }

  // Update tables_found to include any we just created
  results.tables_found = [...new Set([...results.tables_found, ...results.tables_created])];

  return results;
}

// ═══════════════════════════════════════════════════════════════
// DISCOVER — probe an Airtable base, return tables & fields
// ═══════════════════════════════════════════════════════════════

async function discoverBase(baseId) {
  const res = await fetch(`${metaUrl(baseId)}/tables`, { headers: authHdr });
  if (res.status === 401 || res.status === 403) {
    throw new Error("Access denied. Make sure your personal token has access to all bases (Settings → API → Personal Access Token → Scopes: schema.bases:read + data.records:read/write on 'All current and future bases').");
  }
  if (res.status === 404) {
    throw new Error("Base not found. Check the URL — it should look like https://airtable.com/appXXXXXXXXXXX");
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Airtable error ${res.status}: ${err.slice(0, 200)}`);
  }
  const { tables } = await res.json();
  const tableNames = (tables || []).map(t => t.name);
  return {
    baseId,
    tables: (tables || []).map(t => ({
      name: t.name,
      fields: (t.fields || []).map(f => ({ name: f.name, type: f.type })),
    })),
    tableNames,
  };
}

// ═══════════════════════════════════════════════════════════════
// CAMPAIGN REGISTRY — stored in master base's Campaigns table
// ═══════════════════════════════════════════════════════════════

async function listCampaigns() {
  try {
    return await listRecords(MASTER_BASE_ID, "Campaigns");
  } catch (e) {
    console.error("listCampaigns error:", e);
    return [];
  }
}

// Auto-ensure Campaigns table + all fields exist before writing
async function ensureCampaignFields() {
  try {
    const tables = await fetchTables(MASTER_BASE_ID);
    await ensureTable(MASTER_BASE_ID, "Campaigns", SCHEMA["Campaigns"], tables);
  } catch (e) {
    console.error("ensureCampaignFields error:", e);
  }
}

async function createCampaign(fields) {
  await ensureCampaignFields();
  return await createRecords(MASTER_BASE_ID, "Campaigns", [fields]);
}

async function deleteCampaign(recordId) {
  return await deleteRecords(MASTER_BASE_ID, "Campaigns", [recordId]);
}

async function updateCampaign(records) {
  await ensureCampaignFields();
  return await updateRecords(MASTER_BASE_ID, "Campaigns", records);
}

// ═══════════════════════════════════════════════════════════════
// TOP X SCORING ENGINE
// ═══════════════════════════════════════════════════════════════

async function runTopXScoring(baseId, rule, campaignId = null) {
  const scanTarget = rule.scanTarget || "leads";
  const topN = rule.topN || 10;
  const scoringFields = rule.scoringFields || [];
  const scoringPrompt = (rule.scoringPrompt || "").trim();
  if (!scoringFields.length && !scoringPrompt) return { error: "No scoring fields or AI prompt defined", tasks: [] };
  const table = scanTarget === "accounts" ? "Accounts" : "Leads";
  const records = await listRecords(baseId, table);
  if (!records.length) return { error: `No ${table.toLowerCase()} found`, tasks: [] };

  // ─── Step 1: Weighted numeric scoring (skipped if no fields) ──
  // Each field is normalized differently based on type:
  //   - boolean-ish ("True"/"False"/"Yes"/"No"/"Not Sure"): True=1, Not Sure=0.5, False=0
  //   - numeric: parsed as float, normalized against actual observed min/max
  //   - text/multiselect: returns null, contributes 0 to the score (warned in editor)
  const totalWeight = scoringFields.reduce((sum, sf) => sum + (sf.weight || 0), 0);
  const fieldStats = {};

  function extractFieldValue(rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === "") return null;
    if (rawValue === true) return 1;
    if (rawValue === false) return 0;
    // Airtable arrays (multiselect, lookup, linked records) — not currently scorable
    if (Array.isArray(rawValue)) return null;
    if (typeof rawValue === "object") return null;
    const asString = String(rawValue).trim().toLowerCase();
    if (asString === "true" || asString === "yes" || asString === "y") return 1;
    if (asString === "false" || asString === "no" || asString === "n") return 0;
    if (asString === "not sure" || asString === "maybe" || asString === "unknown") return 0.5;
    const num = parseFloat(rawValue);
    return isNaN(num) ? null : num;
  }

  // Stack-safe min/max — `Math.min(...arr)` throws RangeError above ~80k args.
  // For our typical sizes (1k-10k records) this is fine, but no reason to risk it.
  function safeMinMax(arr) {
    let min = Infinity, max = -Infinity;
    for (const v of arr) { if (v < min) min = v; if (v > max) max = v; }
    return { min, max };
  }

  for (const sf of scoringFields) {
    const values = records.map(r => extractFieldValue(r.fields?.[sf.field])).filter(v => v !== null);
    if (values.length === 0) {
      fieldStats[sf.field] = { min: 0, max: 1, allEmpty: true };
      continue;
    }
    const isBoolean = values.every(v => v === 0 || v === 0.5 || v === 1);
    if (isBoolean) {
      fieldStats[sf.field] = { min: 0, max: 1, isBoolean: true };
    } else {
      const { min, max } = safeMinMax(values);
      fieldStats[sf.field] = { min, max };
    }
  }

  const scored = records.map(r => {
    const fields = r.fields || {};
    let cs = 0;
    if (scoringFields.length > 0) {
      for (const sf of scoringFields) {
        const w = totalWeight > 0 ? (sf.weight || 0) / totalWeight : 1 / scoringFields.length;
        const raw = extractFieldValue(fields[sf.field]);
        const st = fieldStats[sf.field];
        if (raw === null || st.allEmpty) continue; // explicit no-contribution
        const range = st.max - st.min;
        cs += (range > 0 ? ((raw - st.min) / range) * 100 : 0) * w;
      }
    }
    // Capture both potential lead identifiers — used downstream for task creation
    const leadName = fields.Name || fields["Full Name"] || fields.Company || "Unknown";
    const leadCompany = fields.Company || fields.Account || "";
    return { record: r, numericScore: Math.round(cs), name: leadName, company: leadCompany };
  });

  // ─── Step 2: AI scoring (only if prompt provided + OpenAI key) ──
  const hasNumeric = scoringFields.length > 0;
  let useAI = scoringPrompt && OPENAI_KEY;

  // When sending records to AI, only include fields that matter: scoring-target fields,
  // identifiers (Name, Title, Company), and any field referenced by name in the prompt.
  // Sending all 30+ Airtable fields wastes tokens and confuses the AI.
  function pickRelevantFields(fields) {
    const keep = new Set([
      "Name", "Full Name", "Title", "Lead Title", "Company", "Account", "Industry",
      "Email", "LinkedIn URL", "Linkedin URL", "Phone",
    ]);
    // Add explicitly-weighted fields
    for (const sf of scoringFields) keep.add(sf.field);
    // Add fields whose name appears verbatim in the user's prompt
    if (scoringPrompt) {
      for (const fname of Object.keys(fields)) {
        if (scoringPrompt.includes(fname)) keep.add(fname);
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(fields)) {
      if (keep.has(k) && v !== null && v !== undefined) out[k] = v;
    }
    return out;
  }

  // Track these outside the useAI block so they're in scope at the final return.
  // Default values for the case where AI scoring isn't used at all.
  let skippedAtCap = 0;
  let actualCandidateCount = 0;

  if (useAI) {
    // Sort with deterministic tie-break by name so re-running yields stable output
    scored.sort((a, b) => (b.numericScore - a.numericScore) || a.name.localeCompare(b.name));

    // Hard cap on pure-AI mode: 600 records (40 batches × ~3s each = ~120s wall clock).
    // Above this, even with 300s budget, Vercel would timeout. The legacy path was never
    // designed for 5K-10K records — Smart Compile is the answer for that scale.
    // For hybrid mode (numeric + AI), we already cap at topN * 3, so this only affects pure-AI.
    const PURE_AI_HARD_CAP = 600;
    const candidateCount = hasNumeric
      ? Math.min(scored.length, topN * 3)
      : Math.min(scored.length, PURE_AI_HARD_CAP);
    actualCandidateCount = candidateCount;
    const candidates = scored.slice(0, candidateCount);
    const rest = scored.slice(candidateCount);
    skippedAtCap = (!hasNumeric && scored.length > PURE_AI_HARD_CAP)
      ? scored.length - PURE_AI_HARD_CAP
      : 0;
    if (skippedAtCap > 0) {
      console.warn(`[TOP-X] Pure-AI mode capped at ${PURE_AI_HARD_CAP} records (skipped ${skippedAtCap}). Use Smart Compile for full coverage.`);
    }

    const BATCH = hasNumeric ? 5 : 15;

    try {
      const openai = new OpenAI({ apiKey: OPENAI_KEY });
      console.log(`[TOP-X] AI scoring ${candidates.length} records in batches of ${BATCH}`);
      for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        if (i % (BATCH * 10) === 0 || i === 0) console.log(`[TOP-X] Progress: ${i}/${candidates.length} scored...`);
        const recordSummaries = batch.map((item, idx) => {
          const f = pickRelevantFields(item.record.fields || {});
          // Per-field budget: 250 chars (was 80) — enough to preserve URLs and short bios
          const dataStr = Object.entries(f)
            .map(([k, v]) => {
              const valStr = Array.isArray(v) ? v.join(", ") : String(v);
              const val = valStr === "" ? "(empty)" : valStr.slice(0, 250);
              return `${k}: ${val}`;
            })
            .join(" | ");
          return `[${idx}] ${item.name} — ${dataStr}`;
        }).join("\n");

        const completion = await openai.chat.completions.create({
          model: "gpt-5.4-mini",
          temperature: 0.2,
          max_completion_tokens: BATCH > 10 ? 4000 : 2048,
          messages: [
            { role: "system", content: `You are a data-driven B2B lead scoring engine. Score each record 0-100 based STRICTLY on the user's criteria and the ACTUAL DATA VALUES in each record.

CRITICAL RULES:
- Score based on the FIELD VALUES provided, NOT on how impressive a person's name/title/company sounds
- If the scoring criteria reference specific fields (e.g. website visits, engagement score, revenue) and those fields are ZERO, EMPTY, or MISSING in the record → score MUST be below 30
- A "Co-Founder" at a great company with zero engagement data scores LOW, not high
- Only score high (70+) when the actual data values demonstrate what the criteria asks for
- "No data" or "0" in key metric fields = low score, period

Return ONLY JSON: [{"idx":0,"score":85,"reason":"max 15 words explaining which data values drove this score"},...]. One entry per record. No markdown.` },
            { role: "user", content: `Scoring Criteria:\n${scoringPrompt}\n\n${scoringFields.length > 0 ? "Scoring Fields (weighted): " + scoringFields.map(sf => sf.field + " (" + sf.weight + "%)").join(", ") + "\n\n" : ""}Records:\n${recordSummaries}` }
          ],
        });
        trackOpenAIUsage({ campaignId, completion, action: "topx_score_batch" });

        const text = completion.choices[0]?.message?.content || "[]";
        const cleaned = text.replace(/```json\n?|```/g, "").trim();
        try {
          let aiScores = JSON.parse(cleaned);
          if (!Array.isArray(aiScores)) {
            aiScores = aiScores.results || aiScores.scores || aiScores.data || [];
          }
          if (!Array.isArray(aiScores)) {
            console.warn("[TOP-X] AI did not return an array, got:", typeof aiScores, JSON.stringify(aiScores).slice(0, 200));
            aiScores = [];
          }
          for (const as of aiScores) {
            if (as && as.idx !== undefined && as.score !== undefined && batch[as.idx]) {
              const s = parseInt(as.score);
              if (!isNaN(s)) {
                batch[as.idx].aiScore = Math.max(0, Math.min(100, s));
                batch[as.idx].aiReason = (as.reason || as.tier || "").slice(0, 100);
              }
            }
          }
        } catch (parseErr) {
          console.warn("AI scoring parse error, attempting recovery:", parseErr.message);
          try {
            const orderA = cleaned.matchAll(/\{[^{}]*?"idx"\s*:\s*(\d+)[^{}]*?"score"\s*:\s*(\d+)/g);
            for (const m of orderA) {
              const idx = parseInt(m[1]); const score = parseInt(m[2]);
              if (batch[idx] && !isNaN(score)) {
                batch[idx].aiScore = Math.max(0, Math.min(100, score));
                batch[idx].aiReason = "AI scored (partial recovery)";
              }
            }
            const orderB = cleaned.matchAll(/\{[^{}]*?"score"\s*:\s*(\d+)[^{}]*?"idx"\s*:\s*(\d+)/g);
            for (const m of orderB) {
              const score = parseInt(m[1]); const idx = parseInt(m[2]);
              if (batch[idx] && !isNaN(score) && batch[idx].aiScore === undefined) {
                batch[idx].aiScore = Math.max(0, Math.min(100, score));
                batch[idx].aiReason = "AI scored (partial recovery)";
              }
            }
          } catch (recoveryErr) {
            console.error("AI scoring recovery also failed:", recoveryErr.message);
          }
        }
      }

      // Retry unscored individually (cap at 50 to avoid runaway costs)
      const unscored = candidates.filter(item => item.aiScore === undefined);
      if (unscored.length > 0 && unscored.length <= 50) {
        console.log(`[TOP-X] Retrying ${unscored.length} unscored records individually`);
        for (const item of unscored) {
          try {
            const f = pickRelevantFields(item.record.fields || {});
            const dataStr = Object.entries(f)
              .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : (v === "" ? "(empty)" : String(v).slice(0, 300))}`)
              .join(" | ");
            const retry = await openai.chat.completions.create({
              model: "gpt-5.4-mini", temperature: 0.2, max_completion_tokens: 200,
              messages: [
                { role: "system", content: `Score this record 0-100 based STRICTLY on its data values. If key metric fields are zero/empty, score below 30. Return ONLY: {"score":85,"reason":"max 15 words citing actual data values"}` },
                { role: "user", content: `Criteria:\n${scoringPrompt}\n\nRecord: ${item.name} — ${dataStr}` }
              ],
            });
            trackOpenAIUsage({ campaignId, completion: retry, action: "topx_score_retry" });
            const rt = (retry.choices[0]?.message?.content || "").replace(/```json\n?|```/g, "").trim();
            const rd = JSON.parse(rt);
            if (rd.score !== undefined) {
              item.aiScore = Math.max(0, Math.min(100, Math.round(rd.score)));
              item.aiReason = (rd.reason || rd.tier || "").slice(0, 100);
            }
          } catch (e) { /* individual retry failed, keep unscored */ }
        }
      }

      const aiScoredCount = candidates.filter(item => item.aiScore !== undefined).length;
      console.log(`[TOP-X] AI scored ${aiScoredCount}/${candidates.length} records successfully`);
      for (const item of candidates) {
        if (item.aiScore !== undefined) {
          item.compositeScore = hasNumeric
            ? Math.round(item.numericScore * 0.4 + item.aiScore * 0.6)
            : item.aiScore;
        } else {
          // AI failed for this record. In pure-AI mode, no numeric score exists, so it
          // stays at 0 and gets pushed to bottom — better than artificially boosting it.
          item.compositeScore = item.numericScore;
          item.aiFailed = true;
        }
      }
      rest.forEach(item => { item.compositeScore = item.numericScore; });
      scored.length = 0;
      scored.push(...candidates, ...rest);
    } catch (e) {
      console.error("AI scoring failed, falling back to numeric:", e.message);
      useAI = false;
      scored.forEach(item => { item.compositeScore = item.numericScore; });
    }
  } else {
    scored.forEach(item => { item.compositeScore = item.numericScore; });
  }

  // Final sort with deterministic tie-break
  scored.sort((a, b) => (b.compositeScore - a.compositeScore) || a.name.localeCompare(b.name));

  const fieldList = scoringFields.map(sf => sf.field).join(", ");
  const todayStr = new Date().toISOString().slice(0, 10);
  const nowISO = new Date().toISOString();

  const tasks = scored.slice(0, topN).map(item => {
    const score = parseInt(item.compositeScore) || 0;
    const aiScore = parseInt(item.aiScore) || 0;
    const numScore = parseInt(item.numericScore) || 0;
    const f = item.record.fields || {};

    // Build a transparent Signal showing how this score was derived
    const signalLines = [];
    if (item.aiReason) {
      signalLines.push(`💡 ${item.aiReason}`);
      signalLines.push(`📊 Score: ${score}/100 (${hasNumeric ? `numeric ${numScore} blended with AI ${aiScore}` : `AI ${aiScore}`})`);
    } else if (item.aiFailed) {
      signalLines.push(`⚠️ AI scoring failed — ranked by ${hasNumeric ? "numeric score" : "position"}: ${score}/100`);
    } else if (hasNumeric) {
      signalLines.push(`📊 Score: ${score}/100 (weighted by ${fieldList})`);
    } else {
      signalLines.push(`📊 Score: ${score}/100`);
    }
    if (scoringFields.length > 0) {
      const breakdown = scoringFields.map(sf => {
        const raw = f[sf.field];
        const display = raw === undefined || raw === null || raw === "" ? "(empty)" : String(raw).slice(0, 60);
        return `   • ${sf.field} (${sf.weight}%): ${display}`;
      });
      signalLines.push(``, `📋 Field values:`, ...breakdown);
    }

    // Task fields. The Tasks table in the user's master base uses "Name" as the primary
    // field (see chat from 2026-04-23 19:00 — confirmed schema). Putting lead name here
    // and company in "Company" — DON'T accidentally write the lead's name to Company.
    return {
      Name: item.name,                              // primary — the lead OR the account name
      Company: scanTarget === "accounts" ? item.name : item.company,
      "Task Rule": rule.name || "Top X",
      Score: Math.max(0, Math.min(100, score)),
      "Scan Target": item.name,                     // for backwards compat with existing Tasks records
      "Lead Title": f.Title || f["Lead Title"] || "",
      Email: f.Email || "",
      "LinkedIn URL": f["LinkedIn URL"] || f["Linkedin URL"] || "",
      Phone: f.Phone || "",
      Signal: signalLines.join("\n"),
      Source: useAI ? "Top X + AI Scoring" : "Top X Scoring",
      URL: f["LinkedIn URL"] || f["Linkedin URL"] || "",
      "Task Type": "top_x",
      Date: todayStr,
      Created: nowISO,
    };
  });
  return {
    tasks,
    totalRecords: records.length,
    topN,
    aiScored: !!useAI,
    legacy: {
      skipped_at_cap: skippedAtCap,
      cap_reason: skippedAtCap > 0
        ? `Legacy AI-per-record mode capped at ${actualCandidateCount} records (Vercel timeout risk). Enable Smart Compile to score all ${records.length} records.`
        : null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// SMART COMPILE: extract structured rules from a natural-language scoring prompt
// so we can score thousands of leads deterministically without per-record AI calls.
// ═══════════════════════════════════════════════════════════════

// JSON Schema reference for the AI compiler. Kept inline so we can paste it in the prompt.
// Operators chosen to be minimal-but-complete for B2B lead scoring:
//   - equals / not_equals: exact match on string or number
//   - contains_any_of / contains_all_of / not_contains: substring or set ops on text
//   - between / gt / gte / lt / lte: numeric range checks
//   - is_empty / is_not_empty: presence checks
//   - regex: escape hatch for custom matching
// score_contribution can be negative (penalty rule). partial_credit lets booleans
// give half-points for "Not Sure"-style middle states.
const COMPILE_SYSTEM_PROMPT = `You are a B2B lead scoring rule compiler. You take natural-language scoring criteria and convert them into deterministic, executable JSON rules.

Your job is to extract STRUCTURED RULES that JavaScript can execute without further AI calls. The user has 100s-1000s of records and we cannot afford to call AI for each one.

OUTPUT FORMAT — return ONLY this JSON, no markdown, no preamble:

{
  "rules": [
    {
      "id": "r1",
      "description": "what this rule checks",
      "field": "EXACT field name from the schema below",
      "operator": "one of: equals | not_equals | contains_any_of | contains_all_of | not_contains | between | gt | gte | lt | lte | is_empty | is_not_empty | regex",
      "value": "for equals/not_equals/contains/regex",
      "values": ["array for contains_any_of/contains_all_of/not_contains"],
      "min": number, "max": number,
      "case_sensitive": false,
      "score_contribution": 25,
      "partial_credit": {"Not Sure": 12.5}
    }
  ],
  "fuzzy_check": {
    "enabled": false,
    "criterion": "natural-language criterion that genuinely needs AI judgment, e.g. 'does the bio suggest interest in X'",
    "fields_to_read": ["Title", "Headline"],
    "trigger_when_deterministic_score_between": [40, 80],
    "max_adjustment": 20
  },
  "max_possible_score": 100,
  "notes": "any caveats or assumptions you made"
}

CRITICAL RULES:
1. ONLY use field names that appear in the schema. If the user references a field that doesn't exist, OMIT that rule and add a note.
2. score_contribution values across all positive rules should add up to roughly 100 (the max possible score). If user defines tiers (e.g. "80-100 = ..."), pick contributions that produce those tiers when rules combine.
3. score_contribution can be NEGATIVE for penalty rules (e.g. "subtract 50 if already a customer").
4. fuzzy_check should be enabled ONLY when criteria genuinely need text interpretation (e.g. "headline suggests interest in X", "title sounds related to finance"). If user's criteria are all explicit field comparisons, set fuzzy_check.enabled to false.
5. If a boolean field has a "Not Sure" middle state, use partial_credit to give half points.
6. Be CONCRETE. Don't write "title contains finance-related keywords" — list the actual keywords: ["CFO", "Finance", "Controller", "Treasurer"].
7. For numeric ranges, use the exact bounds the user gave. If they say "between 200 and 2000", use min:200 max:2000.
8. case_sensitive defaults to false.
9. CROSS-REFERENCE: When the user message includes an "Account fields" section, you MAY reference account-level fields by prefixing with "Account." (e.g. field "Account.Decentralized" or "Account.Industry"). Only do this when the user's prompt clearly references account-level criteria. The lead-account match is automatic via domain/website/LinkedIn URL.

Return only the JSON. No explanations outside the "notes" field.`;

async function compileTopXRules(baseId, { prompt, scanTarget }, campaignId = null) {
  if (!OPENAI_KEY) return { error: "OPENAI_API_KEY not set in Vercel env" };
  if (!prompt || !prompt.trim()) return { error: "Prompt required" };

  const tableName = scanTarget === "accounts" ? "Accounts" : "Leads";
  // Pull schema + 10 sample records. At 5K-10K record scale, the AI compiler benefits
  // from seeing more variety — Title, Industry, etc. often have 20+ distinct values,
  // and 3 samples can mislead rule extraction. Use maxRecords param so we don't pull
  // the full table just to take 10.
  const [fieldDefs, sampleRecords] = await Promise.all([
    getTableFields(baseId, tableName),
    listRecords(baseId, tableName, { maxRecords: 10 }),
  ]);

  if (!fieldDefs.length) {
    return { error: `Could not read schema for ${tableName} table. Check Airtable token has schema:read scope.` };
  }

  // Cross-reference: if scanning Leads, also pull Accounts schema so the AI can write
  // rules that reference Account.X fields. The user's prompt may say things like
  // "score high if account is decentralized" — we need the Accounts schema available
  // for the AI to know what fields exist.
  let accountFieldDefs = [];
  let accountSampleRecords = [];
  if (scanTarget !== "accounts") {
    try {
      [accountFieldDefs, accountSampleRecords] = await Promise.all([
        getTableFields(baseId, "Accounts"),
        listRecords(baseId, "Accounts", { maxRecords: 10 }),
      ]);
    } catch (e) {
      console.warn("[compile] Could not load Accounts schema for cross-reference:", e.message);
    }
  }

  // Format the schema for the AI: name + type + sample values seen
  const formatSchemaLines = (defs, samples, prefix = "") => defs.map(fd => {
    const sampleVals = samples
      .map(r => r.fields?.[fd.name])
      .filter(v => v !== undefined && v !== null && v !== "")
      .slice(0, 3)
      .map(v => Array.isArray(v) ? `[${v.join(", ")}]` : String(v).slice(0, 60));
    const samplesStr = sampleVals.length ? ` — examples: ${sampleVals.join(" | ")}` : "";
    return `- ${prefix}${fd.name} (${fd.type})${samplesStr}`;
  }).join("\n");

  const schemaLines = formatSchemaLines(fieldDefs, sampleRecords);
  const accountSchemaLines = accountFieldDefs.length > 0
    ? formatSchemaLines(accountFieldDefs, accountSampleRecords, "Account.")
    : "";

  try {
    const openai = new OpenAI({ apiKey: OPENAI_KEY });
    // The compiler runs ONCE per rule (cached after that). Use the flagship model
    // for higher-quality field extraction and less hallucination of non-existent
    // field names. Cost is ~$0.03 per compile call, vs ~$0.005 with mini.
    // Mini works too if cost is critical, but mistakes cascade across all records.
    const userMessageParts = [
      `Available fields in ${tableName} table:\n${schemaLines}`,
    ];
    if (accountSchemaLines) {
      userMessageParts.push(
        `\n\nCROSS-REFERENCE: This is a Lead scan. You can ALSO reference Account-level fields by prefixing with "Account.". The lead's matching account is found via domain/website/LinkedIn URL. Available Account fields:\n${accountSchemaLines}\n\nWhen the user's prompt references account-level criteria (e.g. "if the company is decentralized", "if the account has high revenue"), use rules with field names like "Account.Decentralized" or "Account.Revenue".`
      );
    }
    userMessageParts.push(`\n\nUser's scoring prompt:\n"""\n${prompt}\n"""\n\nCompile this to executable rules.`);

    const completion = await openai.chat.completions.create({
      model: "gpt-5.4",
      temperature: 0.1, // very low — we want consistent rules
      max_completion_tokens: 4000,
      messages: [
        { role: "system", content: COMPILE_SYSTEM_PROMPT },
        { role: "user", content: userMessageParts.join("") },
      ],
    });
    trackOpenAIUsage({ campaignId, completion, action: "compile_topx_rules" });

    const text = completion.choices[0]?.message?.content || "{}";
    const cleaned = text.replace(/```json\n?|```/g, "").trim();
    let compiled;
    try {
      compiled = JSON.parse(cleaned);
    } catch (e) {
      return { error: `AI returned invalid JSON: ${e.message}`, raw: cleaned.slice(0, 500) };
    }

    // Validate the shape — if the AI hallucinated a non-existent field, flag it.
    // Account.X fields validate against the Accounts schema; bare names against the lead/account scan target.
    const validFieldNames = new Set(fieldDefs.map(f => f.name));
    const validAccountFieldNames = new Set(accountFieldDefs.map(f => f.name));
    const warnings = [];
    if (!Array.isArray(compiled.rules)) {
      return { error: "Compiled output missing 'rules' array", raw: cleaned.slice(0, 500) };
    }
    const checkFieldName = (fieldName, ruleLabel) => {
      if (!fieldName) return;
      if (fieldName.startsWith("Account.")) {
        const realName = fieldName.slice("Account.".length);
        if (validAccountFieldNames.size === 0) {
          warnings.push(`${ruleLabel} references "${fieldName}" but Accounts schema isn't available — rule will not match anything`);
        } else if (!validAccountFieldNames.has(realName)) {
          warnings.push(`${ruleLabel} references unknown account field "${realName}"`);
        }
      } else if (!validFieldNames.has(fieldName)) {
        warnings.push(`${ruleLabel} references unknown field "${fieldName}"`);
      }
    };
    for (const rule of compiled.rules) {
      checkFieldName(rule.field, `Rule "${rule.description || rule.id}"`);
    }
    if (compiled.fuzzy_check?.fields_to_read) {
      for (const f of compiled.fuzzy_check.fields_to_read) {
        checkFieldName(f, `Fuzzy check`);
      }
    }

    compiled.compiled_at = new Date().toISOString();
    compiled.version = 1;

    // Sanity-check score contributions. If the AI over-allocated (e.g., 5 rules each
    // worth 30 = max 150), records will cluster at 100 and lose differentiation.
    // Normalize back down so total positive contributions equal max_possible_score.
    const positiveTotal = (compiled.rules || [])
      .filter(r => (r.score_contribution || 0) > 0)
      .reduce((s, r) => s + r.score_contribution, 0);
    const maxScore = compiled.max_possible_score || 100;
    if (positiveTotal > maxScore * 1.2) {
      const factor = maxScore / positiveTotal;
      console.log(`[TOP-X-COMPILE] Positive contributions summed to ${positiveTotal}, normalizing by factor ${factor.toFixed(2)}`);
      for (const rule of compiled.rules) {
        if ((rule.score_contribution || 0) > 0) {
          rule.score_contribution = Math.round(rule.score_contribution * factor);
        }
        // Scale partial credit values too
        if (rule.partial_credit) {
          for (const k of Object.keys(rule.partial_credit)) {
            rule.partial_credit[k] = Math.round(rule.partial_credit[k] * factor);
          }
        }
      }
      warnings.push(`Normalized score contributions (was sum=${positiveTotal}, now ~${maxScore})`);
    }

    return { ok: true, compiled, warnings, schema_used: fieldDefs };
  } catch (e) {
    return { error: `Compile failed: ${e.message}` };
  }
}

// ═══════════════════════════════════════════════════════════════
// RULE EXECUTOR — runs compiled rules against records deterministically.
// No AI calls. Should handle 10k records in <100ms.
// ═══════════════════════════════════════════════════════════════

function executeCompiledRule(rule, fieldValue) {
  // Returns: { matched: bool, score: number } where score is the contribution to add
  if (fieldValue === undefined || fieldValue === null) {
    // Empty fields only match is_empty operator
    if (rule.operator === "is_empty") return { matched: true, score: rule.score_contribution || 0 };
    if (rule.operator === "is_not_empty") return { matched: false, score: 0 };
    return { matched: false, score: 0 };
  }

  // Normalize for comparison
  const caseSensitive = !!rule.case_sensitive;
  const stringify = v => Array.isArray(v) ? v.join(", ") : String(v);
  const fv = stringify(fieldValue);
  const fvCmp = caseSensitive ? fv : fv.toLowerCase();

  switch (rule.operator) {
    case "equals": {
      const target = stringify(rule.value);
      const targetCmp = caseSensitive ? target : target.toLowerCase();
      if (fvCmp === targetCmp) return { matched: true, score: rule.score_contribution || 0 };
      // Check partial credit for boolean middle states
      if (rule.partial_credit) {
        for (const [pcVal, pcScore] of Object.entries(rule.partial_credit)) {
          const pcCmp = caseSensitive ? pcVal : pcVal.toLowerCase();
          if (fvCmp === pcCmp) return { matched: true, score: pcScore };
        }
      }
      return { matched: false, score: 0 };
    }
    case "not_equals": {
      const target = stringify(rule.value);
      const targetCmp = caseSensitive ? target : target.toLowerCase();
      return { matched: fvCmp !== targetCmp, score: fvCmp !== targetCmp ? (rule.score_contribution || 0) : 0 };
    }
    case "contains_any_of": {
      if (!Array.isArray(rule.values)) return { matched: false, score: 0 };
      for (const v of rule.values) {
        const vCmp = caseSensitive ? String(v) : String(v).toLowerCase();
        if (fvCmp.includes(vCmp)) return { matched: true, score: rule.score_contribution || 0 };
      }
      return { matched: false, score: 0 };
    }
    case "contains_all_of": {
      if (!Array.isArray(rule.values)) return { matched: false, score: 0 };
      for (const v of rule.values) {
        const vCmp = caseSensitive ? String(v) : String(v).toLowerCase();
        if (!fvCmp.includes(vCmp)) return { matched: false, score: 0 };
      }
      return { matched: true, score: rule.score_contribution || 0 };
    }
    case "not_contains": {
      if (!Array.isArray(rule.values)) {
        const v = stringify(rule.value);
        const vCmp = caseSensitive ? v : v.toLowerCase();
        return { matched: !fvCmp.includes(vCmp), score: !fvCmp.includes(vCmp) ? (rule.score_contribution || 0) : 0 };
      }
      for (const v of rule.values) {
        const vCmp = caseSensitive ? String(v) : String(v).toLowerCase();
        if (fvCmp.includes(vCmp)) return { matched: false, score: 0 };
      }
      return { matched: true, score: rule.score_contribution || 0 };
    }
    case "between": {
      const num = parseFloat(fv);
      if (isNaN(num)) return { matched: false, score: 0 };
      const inRange = num >= rule.min && num <= rule.max;
      return { matched: inRange, score: inRange ? (rule.score_contribution || 0) : 0 };
    }
    case "gt": case "gte": case "lt": case "lte": {
      const num = parseFloat(fv);
      const target = parseFloat(rule.value);
      if (isNaN(num) || isNaN(target)) return { matched: false, score: 0 };
      const ok = rule.operator === "gt" ? num > target
              : rule.operator === "gte" ? num >= target
              : rule.operator === "lt" ? num < target
              : num <= target;
      return { matched: ok, score: ok ? (rule.score_contribution || 0) : 0 };
    }
    case "is_empty": {
      const isE = !fv || fv === "";
      return { matched: isE, score: isE ? (rule.score_contribution || 0) : 0 };
    }
    case "is_not_empty": {
      const isNE = !!fv && fv !== "";
      return { matched: isNE, score: isNE ? (rule.score_contribution || 0) : 0 };
    }
    case "regex": {
      try {
        const re = new RegExp(rule.value, caseSensitive ? "" : "i");
        return { matched: re.test(fv), score: re.test(fv) ? (rule.score_contribution || 0) : 0 };
      } catch { return { matched: false, score: 0 }; }
    }
    default:
      return { matched: false, score: 0 };
  }
}

function applyCompiledRules(records, compiled, accountIndex = null) {
  const rules = compiled?.rules || [];
  const maxScore = compiled?.max_possible_score || 100;
  // Track cross-reference matching for the response
  let leadsMatched = 0;
  let leadsUnmatched = 0;

  return records.map(r => {
    const fields = r.fields || {};
    let score = 0;
    const matched = [];

    // Cross-reference: find matching account if any rule references Account.* fields
    let accountFields = null;
    let accountMatchInfo = null;
    if (accountIndex && accountIndex.hasAccountRules) {
      const acct = lookupAccountForLead(fields, accountIndex);
      if (acct) {
        accountFields = acct.account.fields || {};
        accountMatchInfo = { matched: true, accountName: accountFields.Name, matchKey: acct.matchedBy };
        leadsMatched++;
      } else {
        accountMatchInfo = { matched: false };
        leadsUnmatched++;
      }
    }

    for (const rule of rules) {
      // Resolve field reference: "Account.X" pulls from accountFields, otherwise from lead
      const fieldName = rule.field || "";
      let fv;
      if (fieldName.startsWith("Account.")) {
        const realFieldName = fieldName.slice("Account.".length);
        // If this lead has no matching account, the field is "no value" — contributes 0,
        // matches is_empty, fails everything else. Better than penalizing unmapped leads.
        fv = accountFields ? accountFields[realFieldName] : undefined;
      } else {
        fv = fields[fieldName];
      }
      const result = executeCompiledRule(rule, fv);
      if (result.matched) {
        score += result.score;
        matched.push({ rule_id: rule.id, description: rule.description, contribution: result.score, source: fieldName.startsWith("Account.") ? "account" : "lead" });
      }
    }

    // Clamp to 0-100 (allow rules to over-allocate, then we clip)
    const clamped = Math.max(0, Math.min(100, Math.round(score)));
    const leadName = fields.Name || fields["Full Name"] || fields.Company || "Unknown";
    const leadCompany = fields.Company || fields.Account || "";
    return {
      record: r,
      deterministicScore: clamped,
      rawScore: score, // before clamp, useful for debugging
      matchedRules: matched,
      name: leadName,
      company: leadCompany,
      accountMatch: accountMatchInfo,
    };
  });
}

// Cross-reference helper: extract domain/website/linkedin keys from a record's fields.
// Multiple keys per record because we try domain first, fall back to LinkedIn URL.
// Normalization is critical here — get any of these wrong and matching silently fails:
//   - domains: lowercase, no http(s)://, no www., no trailing slash, no path
//   - linkedin URLs: same, but keep the /company/<slug> path since that's the identity
function extractCompanyKeys(fields) {
  const keys = { domain: null, linkedinUrl: null };

  // Try Domain field first, then derive from Website, then from Email
  const domainCandidate = fields.Domain || fields["Domain"] || "";
  const websiteCandidate = fields.Website || fields["Website"] || fields["Company Website"] || "";
  const emailCandidate = fields.Email || "";

  if (domainCandidate) {
    keys.domain = normalizeDomain(domainCandidate);
  } else if (websiteCandidate) {
    keys.domain = normalizeDomain(websiteCandidate);
  } else if (emailCandidate) {
    // Extract domain from email: john@acme.com → acme.com
    // Skip personal email providers (gmail, yahoo, outlook, etc.) — those don't map to a B2B account
    const atIdx = emailCandidate.lastIndexOf("@");
    if (atIdx > 0) {
      const emailDomain = emailCandidate.slice(atIdx + 1).toLowerCase().trim();
      if (!isPersonalEmailDomain(emailDomain)) {
        keys.domain = emailDomain;
      }
    }
  }

  // LinkedIn URL — could be in either "Company LinkedIn", "LinkedIn URL", or "Linkedin URL" fields.
  // For Accounts table, "LinkedIn URL" is the company's. For Leads, it's usually the person's,
  // but some imports populate "Company LinkedIn" separately.
  const liCandidate = fields["Company LinkedIn"] || fields["Company LinkedIn URL"] || "";
  if (liCandidate) {
    keys.linkedinUrl = normalizeCompanyLinkedIn(liCandidate);
  }

  return keys;
}

// For Accounts: their "LinkedIn URL" field IS the company LinkedIn (different from Leads).
// Separate function so we don't accidentally pull a lead's personal LinkedIn for Account matching.
function extractAccountKeys(fields) {
  const keys = { domain: null, linkedinUrl: null };
  if (fields.Domain) keys.domain = normalizeDomain(fields.Domain);
  else if (fields.Website || fields["Company Website"]) {
    keys.domain = normalizeDomain(fields.Website || fields["Company Website"]);
  }
  // Account.LinkedIn URL is the company's
  const li = fields["LinkedIn URL"] || fields["Linkedin URL"] || fields["Company LinkedIn"] || "";
  if (li) keys.linkedinUrl = normalizeCompanyLinkedIn(li);
  return keys;
}

function normalizeDomain(input) {
  if (!input) return null;
  let s = String(input).toLowerCase().trim();
  // Strip protocol
  s = s.replace(/^https?:\/\//, "");
  // Strip www.
  s = s.replace(/^www\./, "");
  // Strip path / query / hash — only keep the host
  s = s.split("/")[0].split("?")[0].split("#")[0];
  // Strip trailing dot
  s = s.replace(/\.$/, "");
  // Strip port if any
  s = s.split(":")[0];
  return s || null;
}

function normalizeCompanyLinkedIn(input) {
  if (!input) return null;
  let s = String(input).toLowerCase().trim();
  s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  // Keep the path because /company/<slug> IS the identity
  s = s.replace(/\/$/, "").replace(/\?.*/, "").replace(/#.*/, "");
  // Extract just the /company/<slug> portion to avoid LinkedIn vanity URL drift
  const m = s.match(/linkedin\.com\/(company|school)\/([^\/]+)/);
  if (m) return `linkedin.com/${m[1]}/${m[2]}`;
  return s;
}

// Domains that are personal email providers — never match these to B2B accounts
const PERSONAL_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "yahoo.co.uk", "outlook.com", "hotmail.com", "icloud.com",
  "live.com", "aol.com", "protonmail.com", "proton.me", "msn.com", "ymail.com",
  "me.com", "mac.com", "googlemail.com", "rediffmail.com", "zoho.com",
]);
function isPersonalEmailDomain(d) { return PERSONAL_EMAIL_DOMAINS.has(d); }

// Build account index: maps that let us look up an account by any of its keys in O(1)
function buildAccountIndex(accounts, hasAccountRules) {
  const byDomain = new Map();
  const byLinkedIn = new Map();
  for (const acct of accounts) {
    const keys = extractAccountKeys(acct.fields || {});
    if (keys.domain && !byDomain.has(keys.domain)) byDomain.set(keys.domain, acct);
    if (keys.linkedinUrl && !byLinkedIn.has(keys.linkedinUrl)) byLinkedIn.set(keys.linkedinUrl, acct);
  }
  return { byDomain, byLinkedIn, totalAccounts: accounts.length, hasAccountRules };
}

// Try domain match first (most reliable), fall back to LinkedIn URL match
function lookupAccountForLead(leadFields, accountIndex) {
  const leadKeys = extractCompanyKeys(leadFields);
  if (leadKeys.domain && accountIndex.byDomain.has(leadKeys.domain)) {
    return { account: accountIndex.byDomain.get(leadKeys.domain), matchedBy: "domain" };
  }
  if (leadKeys.linkedinUrl && accountIndex.byLinkedIn.has(leadKeys.linkedinUrl)) {
    return { account: accountIndex.byLinkedIn.get(leadKeys.linkedinUrl), matchedBy: "linkedin" };
  }
  return null;
}

// Detect whether any rule in the compiled set references Account.* fields.
// Used to skip the account fetch entirely when no rules need it.
function compiledRulesReferenceAccounts(compiled) {
  if (!compiled?.rules) return false;
  for (const rule of compiled.rules) {
    if (rule.field && rule.field.startsWith("Account.")) return true;
  }
  // Also check fuzzy_check.fields_to_read
  if (compiled.fuzzy_check?.fields_to_read) {
    for (const f of compiled.fuzzy_check.fields_to_read) {
      if (typeof f === "string" && f.startsWith("Account.")) return true;
    }
  }
  return false;
}

// Smart-compile mode runner: scores deterministically + optionally runs AI fuzzy adjustment
// on borderline candidates. Total AI calls scale with O(1) for compile + O(N/15) for fuzzy
// (where N is candidates in the borderline window), instead of O(records/15).
async function runTopXSmartCompile(baseId, rule, compiled, campaignId = null) {
  const scanTarget = rule.scanTarget || "leads";
  const topN = rule.topN || 10;
  const table = scanTarget === "accounts" ? "Accounts" : "Leads";

  // Validate compiled input — fail loudly rather than silently returning alphabetical
  // top 10 when rules are empty/broken
  if (!compiled || !Array.isArray(compiled.rules) || compiled.rules.length === 0) {
    return {
      error: "Smart Compile is enabled but no rules are compiled. Click 'Compile to Rules' first, or disable Smart Compile to use the legacy AI-per-record path.",
      tasks: [],
    };
  }

  // Cross-reference: if any rule references Account.* fields, fetch accounts and build index.
  // Only meaningful when scanning Leads (Account-scan aggregates are a separate future feature).
  let accountIndex = null;
  let crossRefStats = null;
  let accountsLoadError = null;
  const needsAccounts = scanTarget === "leads" && compiledRulesReferenceAccounts(compiled);
  let recordsListMs = 0;
  let accountsListMs = 0;

  const tFetch0 = Date.now();
  const records = scanTarget === "accounts"
    ? await listRecords(baseId, "Accounts")
    : await listRecords(baseId, "Leads");
  recordsListMs = Date.now() - tFetch0;
  if (!records.length) return { error: `No ${table.toLowerCase()} found`, tasks: [] };

  if (needsAccounts) {
    const tAcct0 = Date.now();
    try {
      const accounts = await listRecords(baseId, "Accounts");
      accountsListMs = Date.now() - tAcct0;
      accountIndex = buildAccountIndex(accounts, true);
      console.log(`[TOP-X-SMART] Built account index: ${accountIndex.totalAccounts} accounts, ${accountIndex.byDomain.size} domain keys, ${accountIndex.byLinkedIn.size} LinkedIn keys`);
    } catch (e) {
      // Accounts table missing or inaccessible. Log and continue without cross-reference.
      // Account.X rules will contribute 0 across the board, but the run won't fail.
      console.warn(`[TOP-X-SMART] Could not load Accounts table (${e.message}). Account.X rules will not match.`);
      accountIndex = null;
      accountsLoadError = e.message;
    }
  }

  // Step 1: Deterministic scoring across ALL records (zero AI calls)
  const t0 = Date.now();
  const scored = applyCompiledRules(records, compiled, accountIndex);
  const deterministicMs = Date.now() - t0;
  console.log(`[TOP-X-SMART] Scored ${scored.length} records deterministically in ${deterministicMs}ms`);

  // If cross-reference was active, compute match coverage stats
  if (accountIndex) {
    const matched = scored.filter(s => s.accountMatch?.matched).length;
    const unmatched = scored.length - matched;
    crossRefStats = {
      enabled: true,
      total_leads: scored.length,
      matched_to_account: matched,
      unmatched: unmatched,
      match_rate_pct: scored.length > 0 ? Math.round((matched / scored.length) * 100) : 0,
      total_accounts_indexed: accountIndex.totalAccounts,
    };
    console.log(`[TOP-X-SMART] Cross-reference match: ${matched}/${scored.length} leads (${crossRefStats.match_rate_pct}%)`);
  } else if (needsAccounts) {
    // Rules wanted account context but we couldn't load Accounts. Surface clearly.
    crossRefStats = {
      enabled: true,
      failed: true,
      error: accountsLoadError || "Accounts table not loaded — Account.* rules contributed 0 to all leads",
      total_leads: scored.length,
      matched_to_account: 0,
      unmatched: scored.length,
      match_rate_pct: 0,
      total_accounts_indexed: 0,
    };
  }

  // Step 2: Sort by deterministic score (with stable tie-break by name)
  scored.sort((a, b) => (b.deterministicScore - a.deterministicScore) || a.name.localeCompare(b.name));

  // Step 3: AI fuzzy adjustment — only for borderline candidates IF fuzzy_check is enabled
  let fuzzyAdjusted = 0;
  let fuzzyApiCalls = 0;
  let fuzzySkipped = 0;
  const fuzzyCheck = compiled?.fuzzy_check;
  if (fuzzyCheck?.enabled && fuzzyCheck?.criterion && OPENAI_KEY) {
    const [winLow, winHigh] = fuzzyCheck.trigger_when_deterministic_score_between || [40, 80];
    const maxAdj = Math.abs(fuzzyCheck.max_adjustment || 20);
    // Cap fuzzy AI calls. At 10K leads with a wide [40,80] window, you might have
    // 5000 borderline candidates — we can't AI-score all of them. Sort by deterministic
    // score (already done above) and take the top slice closest to the cutoff.
    // Cap is the larger of (topN * 4) and 100 — covers large topN like 200, but caps
    // at a reasonable absolute for typical topN=10 cases.
    const FUZZY_CAP = Math.max(topN * 4, 100);
    const borderlineCandidates = scored.filter(s => s.deterministicScore >= winLow && s.deterministicScore <= winHigh);
    // Take the highest-scoring borderlines first — they're closest to the topN cutoff
    // and most likely to swap with adjustment
    const candidates = borderlineCandidates.slice(0, FUZZY_CAP);
    fuzzySkipped = Math.max(0, borderlineCandidates.length - candidates.length);

    if (candidates.length > 0) {
      console.log(`[TOP-X-SMART] Fuzzy-adjusting ${candidates.length} borderline candidates`);
      try {
        const openai = new OpenAI({ apiKey: OPENAI_KEY });
        const BATCH = 15;
        const fieldsToRead = fuzzyCheck.fields_to_read || ["Title", "Headline", "About"];
        for (let i = 0; i < candidates.length; i += BATCH) {
          const batch = candidates.slice(i, i + BATCH);
          fuzzyApiCalls++;
          const summaries = batch.map((item, idx) => {
            const f = item.record.fields || {};
            const parts = fieldsToRead.map(fname => {
              const v = f[fname];
              if (v === undefined || v === null || v === "") return null;
              return `${fname}: ${String(Array.isArray(v) ? v.join(", ") : v).slice(0, 300)}`;
            }).filter(Boolean);
            return `[${idx}] ${item.name} — ${parts.join(" | ")}`;
          }).join("\n");

          const completion = await openai.chat.completions.create({
            model: "gpt-5.4-mini",
            temperature: 0.2,
            max_completion_tokens: 1500,
            messages: [
              { role: "system", content: `You are a B2B lead scoring fuzzy-check engine. For each record, return an adjustment (-${maxAdj} to +${maxAdj}) based on the criterion. Return ONLY: [{"idx":0,"adjustment":15,"reason":"max 12 words"},...]. No markdown.` },
              { role: "user", content: `Criterion: ${fuzzyCheck.criterion}\n\nRecords (read ${fieldsToRead.join(", ")}):\n${summaries}` },
            ],
          });
          trackOpenAIUsage({ campaignId, completion, action: "topx_fuzzy_check" });
          const text = completion.choices[0]?.message?.content || "[]";
          const cleaned = text.replace(/```json\n?|```/g, "").trim();
          try {
            let adjustments = JSON.parse(cleaned);
            if (!Array.isArray(adjustments)) adjustments = adjustments.results || adjustments.adjustments || [];
            for (const adj of adjustments) {
              if (adj && adj.idx !== undefined && adj.adjustment !== undefined && batch[adj.idx]) {
                const a = Math.max(-maxAdj, Math.min(maxAdj, parseFloat(adj.adjustment)));
                if (!isNaN(a)) {
                  batch[adj.idx].fuzzyAdjustment = a;
                  batch[adj.idx].fuzzyReason = (adj.reason || "").slice(0, 100);
                  fuzzyAdjusted++;
                }
              }
            }
          } catch (e) {
            console.warn("[TOP-X-SMART] Fuzzy parse failed:", e.message);
          }
        }
      } catch (e) {
        console.error("[TOP-X-SMART] Fuzzy AI call failed, using deterministic only:", e.message);
      }
    }
  }

  // Step 4: Compute final scores (deterministic + fuzzy adjustment) and re-sort
  for (const s of scored) {
    s.finalScore = Math.max(0, Math.min(100, s.deterministicScore + (s.fuzzyAdjustment || 0)));
  }
  scored.sort((a, b) => (b.finalScore - a.finalScore) || a.name.localeCompare(b.name));

  // Step 5: Build top N tasks
  const todayStr = new Date().toISOString().slice(0, 10);
  const nowISO = new Date().toISOString();
  const tasks = scored.slice(0, topN).map(item => {
    const f = item.record.fields || {};
    // Split matched rules by source so the user can see which contributions came from
    // the lead's own data vs the cross-referenced account
    const leadMatches = item.matchedRules.filter(m => m.source !== "account");
    const accountMatches = item.matchedRules.filter(m => m.source === "account");

    const buildLines = (label, list) => list.length === 0
      ? null
      : [`${label}`, ...list.map(m => `   ✓ ${m.description}: ${m.contribution >= 0 ? "+" : ""}${m.contribution}`)];

    const signalLines = [
      `📊 Score: ${item.finalScore}/100 (deterministic: ${item.deterministicScore}${item.fuzzyAdjustment ? `, fuzzy adj: ${item.fuzzyAdjustment > 0 ? "+" : ""}${item.fuzzyAdjustment}` : ""})`,
      ``,
    ];

    // Lead-side rules
    const leadLines = buildLines("📋 Lead-side rules matched:", leadMatches);
    if (leadLines) signalLines.push(...leadLines);
    else if (item.matchedRules.length === 0) signalLines.push("📋 No rules matched.");

    // Account-side rules — only shown if cross-reference was used
    if (accountMatches.length > 0) {
      const acctName = item.accountMatch?.accountName || "(unknown)";
      const matchKey = item.accountMatch?.matchKey || "?";
      signalLines.push(``, `🏢 Account: ${acctName} (matched by ${matchKey})`);
      const acctLines = buildLines(`Account-side rules matched:`, accountMatches);
      if (acctLines) signalLines.push(...acctLines.slice(1)); // skip "matched:" duplicate
    } else if (item.accountMatch && !item.accountMatch.matched && accountIndex) {
      // Cross-reference enabled but this lead didn't match an account
      signalLines.push(``, `⚠️ No account matched (rules referencing Account.* contributed 0)`);
    }

    if (item.fuzzyReason) signalLines.push(``, `🤖 Fuzzy check: ${item.fuzzyReason}`);

    return {
      Name: item.name,
      Company: scanTarget === "accounts" ? item.name : item.company,
      "Task Rule": rule.name || "Top X (Smart)",
      Score: item.finalScore,
      "Scan Target": item.name,
      "Lead Title": f.Title || f["Lead Title"] || "",
      Email: f.Email || "",
      "LinkedIn URL": f["LinkedIn URL"] || f["Linkedin URL"] || "",
      Phone: f.Phone || "",
      Signal: signalLines.join("\n"),
      Source: fuzzyApiCalls > 0 ? "Top X Smart (Rules + AI)" : "Top X Smart (Rules)",
      URL: f["LinkedIn URL"] || f["Linkedin URL"] || "",
      "Task Type": "top_x",
      Date: todayStr,
      Created: nowISO,
    };
  });

  return {
    tasks,
    totalRecords: records.length,
    topN,
    aiScored: fuzzyApiCalls > 0,
    smartCompile: {
      deterministic_ms: deterministicMs,
      records_list_ms: recordsListMs,
      accounts_list_ms: accountsListMs,
      fuzzy_api_calls: fuzzyApiCalls,
      fuzzy_adjusted_count: fuzzyAdjusted,
      fuzzy_skipped: fuzzySkipped, // borderline candidates we didn't AI-check (cost cap)
      total_rules_applied: compiled?.rules?.length || 0,
    },
    crossRef: crossRefStats,
  };
}

// ═══════════════════════════════════════════════════════════════

async function getTableFields(baseId, tableName) {
  try {
    const res = await fetch(`${metaUrl(baseId)}/tables`, { headers: authHdr });
    if (!res.ok) return [];
    const { tables } = await res.json();
    const table = tables.find(t => t.name === tableName);
    if (!table) return [];
    return (table.fields || []).map(f => ({ name: f.name, type: f.type }));
  } catch (e) {
    console.error("getTableFields error:", e);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST CONNECTION
// ═══════════════════════════════════════════════════════════════

async function testConnection(baseId) {
  const result = { steps: [] };
  try {
    const res = await fetch(`${metaUrl(baseId)}/tables`, { headers: authHdr });
    if (!res.ok) {
      const err = await res.text();
      result.steps.push({ step: "Read schema", ok: false, msg: `HTTP ${res.status}: ${err.slice(0, 150)}` });
      return result;
    }
    const { tables } = await res.json();
    result.steps.push({ step: "Read schema", ok: true, msg: `Found ${tables.length} tables: ${tables.map(t => t.name).join(", ")}` });
    const testTable = tables[0];
    if (!testTable) {
      result.steps.push({ step: "Write test", ok: false, msg: "No tables found" });
      return result;
    }
    const tfn = `_test_ss_${Date.now()}`;
    const cr = await fetch(`${metaUrl(baseId)}/tables/${testTable.id}/fields`, {
      method: "POST", headers: hdrs, body: JSON.stringify({ name: tfn, type: "singleLineText" }),
    });
    if (!cr.ok) {
      const err = await cr.text();
      result.steps.push({ step: "Write test", ok: false, msg: err.includes("NOT_AUTHORIZED") || cr.status === 403 ? 'Token needs "schema.bases:write" scope.' : `HTTP ${cr.status}: ${err.slice(0, 150)}` });
      return result;
    }
    result.steps.push({ step: "Write test", ok: true, msg: `Created "${tfn}" in ${testTable.name}` });
    result.steps.push({ step: "Cleanup", ok: true, msg: `Delete "${tfn}" from "${testTable.name}" manually` });
    return result;
  } catch (e) {
    result.steps.push({ step: "Connection", ok: false, msg: e.message });
    return result;
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════

export async function POST(request) {
  try {
    if (!API_KEY) {
      return NextResponse.json({ error: "AIRTABLE_API_KEY not configured" }, { status: 500 });
    }

    const body = await request.json();
    const { action, table, records, recordIds, params, fieldNames, rule } = body;
    // baseId: use provided, else fall back to master
    const baseId = body.baseId || MASTER_BASE_ID;
    // campaignId: optional. Used to attribute OpenAI usage costs to the right
    // campaign for per-client billing. Frontend should send this for any action
    // that triggers OpenAI calls (run_topx, compile_topx_rules, run_topx_smart).
    // If missing, tracking is skipped silently — no error.
    const campaignId = body.campaignId || null;

    if (!baseId) {
      return NextResponse.json({ error: "No baseId provided and no AIRTABLE_BASE_ID configured" }, { status: 500 });
    }

    // SECURITY: Detect requests originating from /client/[id] pages. Used to block
    // admin-only actions from being called by a client's browser. Referer is not
    // bulletproof (can be spoofed) but blocks the realistic leak vector — a client's
    // own browser making calls from their own session. For real defense-in-depth
    // we'd add server-side auth tokens; this is the minimal patch for the reported leak.
    const referer = request.headers.get("referer") || "";
    const isFromClientPage = /\/client\/[^/?#]+/.test(referer);
    // Actions that must NEVER be callable from a client page. Each of these
    // either enumerates campaigns, modifies the campaign registry, OR mutates
    // campaign data. Clients have READ access to their own campaign data via
    // the data tabs (Accounts, Leads, Tasks, Rules, Prompts) but should not
    // be able to create/update/delete records or change schema.
    const ADMIN_ONLY_ACTIONS = new Set([
      "list_campaigns",
      "create_campaign",
      "delete_campaign",
      "update_campaign",
      "discover", // exposes base structure of arbitrary URLs
      "create",   // mutate records
      "update",   // mutate records
      "delete",   // delete records
      "setup",    // schema mutations
      "ensure_fields", // schema mutations
      "generate_custom_codes", // batch mutation
      "compile_topx_rules",    // costs OpenAI tokens
      "run_topx",              // costs OpenAI tokens
      "run_topx_smart",        // costs OpenAI tokens
      "reset_ai_usage",        // billing/admin operation — clients cannot reset their own meter
    ]);
    if (isFromClientPage && ADMIN_ONLY_ACTIONS.has(action)) {
      console.warn(`[SECURITY] Action "${action}" blocked from client-mode referer: ${referer}`);
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }

    switch (action) {
      // ─── Campaign Registry (always uses master base) ────────
      case "list_campaigns": {
        if (!MASTER_BASE_ID) return NextResponse.json({ records: [] });
        // SECURITY: This endpoint enumerates ALL campaigns (including base IDs and
        // names). The referer-based block above protects against the realistic vector.
        const data = await listCampaigns();
        return NextResponse.json({ records: data });
      }
      case "get_campaign": {
        if (!MASTER_BASE_ID) return NextResponse.json({ error: "No master base" }, { status: 500 });
        const { campaignId } = body;
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        try {
          // Try direct record fetch first
          let rec = null;
          const directRes = await fetch(`${API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, { headers: authHdr });
          if (directRes.ok) {
            rec = await directRes.json();
          } else {
            // Fallback: list all campaigns and find by ID
            console.log("[GET_CAMPAIGN] Direct fetch failed, falling back to list. Status:", directRes.status);
            const allCamps = await listCampaigns();
            rec = allCamps.find(r => r.id === campaignId);
          }
          if (!rec) return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
          const { "Client Password": pw, "HubSpot API Key": hk, ...safeFields } = rec.fields || {};
          return NextResponse.json({ id: rec.id, fields: safeFields, hasPassword: !!pw, hasHubSpot: !!hk });
        } catch (e) {
          console.error("[GET_CAMPAIGN] Error:", e.message);
          return NextResponse.json({ error: e.message }, { status: 500 });
        }
      }
      case "validate_client": {
        if (!MASTER_BASE_ID) return NextResponse.json({ error: "No master base" }, { status: 500 });
        const { campaignId: cid, password } = body;
        if (!cid) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        try {
          let rec = null;
          const directRes = await fetch(`${API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${cid}`, { headers: authHdr });
          if (directRes.ok) { rec = await directRes.json(); }
          else { const all = await listCampaigns(); rec = all.find(r => r.id === cid); }
          if (!rec) return NextResponse.json({ valid: false, error: "Campaign not found" });
          const storedPw = rec.fields?.["Client Password"] || "";
          if (!storedPw) return NextResponse.json({ valid: true });
          return NextResponse.json({ valid: password === storedPw });
        } catch (e) { return NextResponse.json({ valid: false, error: e.message }); }
      }
      case "create_campaign": {
        if (!MASTER_BASE_ID) return NextResponse.json({ error: "No master base configured" }, { status: 500 });
        const data = await createCampaign(body.fields);
        return NextResponse.json({ records: data });
      }
      case "delete_campaign": {
        if (!MASTER_BASE_ID) return NextResponse.json({ error: "No master base configured" }, { status: 500 });
        const data = await deleteCampaign(body.campaignRecordId);
        return NextResponse.json({ records: data });
      }
      case "update_campaign": {
        if (!MASTER_BASE_ID) return NextResponse.json({ error: "No master base configured" }, { status: 500 });
        const data = await updateCampaign(body.campaignRecords);
        return NextResponse.json({ records: data });
      }

      // ─── Discover a new base ────────────────────────────────
      case "discover": {
        const bid = extractBaseId(body.baseUrl);
        if (!bid) return NextResponse.json({ error: "Could not extract base ID from URL. Paste a URL like https://airtable.com/appXXXXXXXXXXX or just the base ID." }, { status: 400 });
        const info = await discoverBase(bid);
        return NextResponse.json(info);
      }

      // ─── Data operations (use campaign's baseId) ────────────
      case "setup": {
        const results = await setupSchema(baseId);
        return NextResponse.json(results);
      }

      case "generate_custom_codes": {
        // Backfill missing Custom Code on leads — generates 8-char alphanumeric like Y0RYQSGI
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        try {
          const leads = await listRecords(baseId, "Leads");
          const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
          const genCode = () => {
            let s = "";
            for (let i = 0; i < 8; i++) s += CHARS[Math.floor(Math.random() * CHARS.length)];
            return s;
          };
          // Collect existing codes to avoid collisions
          const existing = new Set(leads.map(l => l.fields?.["Custom Code"]).filter(Boolean));
          const toUpdate = [];
          for (const l of leads) {
            if (l.fields?.["Custom Code"]) continue;
            let code;
            do { code = genCode(); } while (existing.has(code));
            existing.add(code);
            toUpdate.push({ id: l.id, fields: { "Custom Code": code } });
          }
          if (toUpdate.length === 0) {
            return NextResponse.json({ ok: true, generated: 0, total: leads.length, message: "All leads already have Custom Codes" });
          }
          // Batch update 10 at a time
          for (let i = 0; i < toUpdate.length; i += 10) {
            await fetch(`${baseUrl(baseId)}/${encodeURIComponent("Leads")}`, {
              method: "PATCH", headers: { ...authHdr, "Content-Type": "application/json" },
              body: JSON.stringify({ records: toUpdate.slice(i, i + 10) }),
            });
          }
          return NextResponse.json({ ok: true, generated: toUpdate.length, total: leads.length });
        } catch (e) {
          return NextResponse.json({ error: e.message }, { status: 500 });
        }
      }
      case "diagnose": {
        // Verbose diagnostic: probe every step and return detailed status
        const diag = { baseId, steps: [], ok: true };

        // Step 1: Can we fetch tables at all?
        try {
          const res = await fetch(`${metaUrl(baseId)}/tables`, { headers: authHdr });
          const bodyText = await res.text();
          diag.steps.push({
            step: "fetchTables",
            status: res.status,
            ok: res.ok,
            bodyPreview: bodyText.slice(0, 400),
          });
          if (!res.ok) { diag.ok = false; diag.conclusion = `Can't even list tables. Status ${res.status}. Token likely lacks schema.bases:read OR doesn't have access to base ${baseId}.`; return NextResponse.json(diag); }
          const { tables } = JSON.parse(bodyText);
          diag.existingTables = (tables || []).map(t => ({ name: t.name, id: t.id, fieldCount: t.fields?.length || 0 }));
          diag.hasOutreachTable = diag.existingTables.some(t => t.name === "Outreach");

          // Step 2: If Outreach table doesn't exist, try to create it
          if (!diag.hasOutreachTable) {
            const OUTREACH_FIELDS = SCHEMA["Outreach"].map(f => ({ name: f.name, type: f.type, options: f.options }));
            try {
              const createRes = await fetch(`${metaUrl(baseId)}/tables`, {
                method: "POST",
                headers: { ...authHdr, "Content-Type": "application/json" },
                body: JSON.stringify({ name: "Outreach", fields: OUTREACH_FIELDS }),
              });
              const createBody = await createRes.text();
              diag.steps.push({
                step: "createOutreachTable",
                status: createRes.status,
                ok: createRes.ok,
                bodyPreview: createBody.slice(0, 400),
              });
              if (!createRes.ok) {
                diag.ok = false;
                if (createRes.status === 403) diag.conclusion = `Creating the Outreach table was blocked with 403. Your token likely lacks schema.bases:write. Even if the Airtable UI says it's enabled, double-check by regenerating the token from scratch with all 4 scopes.`;
                else if (createRes.status === 422) diag.conclusion = `Airtable rejected the Outreach table schema (422). Raw: ${createBody.slice(0, 300)}`;
                else diag.conclusion = `Create failed with ${createRes.status}: ${createBody.slice(0, 300)}`;
                return NextResponse.json(diag);
              }
              diag.createdOutreachTable = true;
            } catch (e) {
              diag.steps.push({ step: "createOutreachTable", error: e.message });
              diag.ok = false;
              diag.conclusion = `Create request threw: ${e.message}`;
              return NextResponse.json(diag);
            }
          }

          // Step 3: Try a test write to Outreach
          try {
            const testRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}`, {
              method: "POST",
              headers: authHdr,
              body: JSON.stringify({ records: [{ fields: { "Lead Name": "_diagnostic_test_", Status: "test" } }] }),
            });
            const testBody = await testRes.text();
            diag.steps.push({
              step: "testWrite",
              status: testRes.status,
              ok: testRes.ok,
              bodyPreview: testBody.slice(0, 400),
            });
            if (testRes.ok) {
              // Clean up the test record
              const parsed = JSON.parse(testBody);
              const recId = parsed.records?.[0]?.id;
              if (recId) {
                await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}/${recId}`, { method: "DELETE", headers: authHdr });
                diag.steps.push({ step: "cleanupTest", ok: true });
              }
              diag.conclusion = `✅ Everything works. Base can be written to, Outreach table exists and accepts records. If you're still seeing errors in the UI, it's a caching issue — hard-reload the page (Cmd+Shift+R).`;
            } else {
              diag.ok = false;
              if (testRes.status === 403) diag.conclusion = `Can list/create tables but can't write records (403). Token is missing data.records:write scope for this base.`;
              else if (testRes.status === 422) diag.conclusion = `Airtable rejected the test write with 422 — a field name doesn't match. Raw: ${testBody.slice(0, 300)}`;
              else diag.conclusion = `Write failed with ${testRes.status}: ${testBody.slice(0, 300)}`;
            }
          } catch (e) {
            diag.steps.push({ step: "testWrite", error: e.message });
            diag.ok = false;
            diag.conclusion = `Test write threw: ${e.message}`;
          }

          return NextResponse.json(diag);
        } catch (e) {
          return NextResponse.json({ ...diag, error: e.message, ok: false, conclusion: `Diagnostic crashed: ${e.message}` });
        }
      }
      case "test": {
        const results = await testConnection(baseId);
        return NextResponse.json(results);
      }
      case "list": {
        const data = await listRecords(baseId, table, params || {});
        return NextResponse.json({ records: data });
      }
      case "create": {
        const data = await createRecords(baseId, table, records);
        return NextResponse.json({ records: data });
      }
      case "update": {
        const data = await updateRecords(baseId, table, records);
        return NextResponse.json({ records: data });
      }
      case "delete": {
        const data = await deleteRecords(baseId, table, recordIds);
        return NextResponse.json({ records: data });
      }
      case "ensure_fields": {
        if (!table || !fieldNames?.length) return NextResponse.json({ error: "table and fieldNames required" }, { status: 400 });
        const results = await ensureCustomFields(baseId, table, fieldNames);
        return NextResponse.json(results);
      }
      case "get_fields": {
        if (!table) return NextResponse.json({ error: "table required" }, { status: 400 });
        const fields = await getTableFields(baseId, table);
        return NextResponse.json({ fields });
      }
      case "run_topx": {
        if (!rule) return NextResponse.json({ error: "rule required" }, { status: 400 });
        // If rule has Smart Compile enabled and a fresh compiled JSON, use that path.
        // Otherwise fall through to the legacy per-record AI scoring.
        if (rule.useSmartCompile && rule.compiledRules) {
          const result = await runTopXSmartCompile(baseId, rule, rule.compiledRules, campaignId);
          return NextResponse.json(result);
        }
        const result = await runTopXScoring(baseId, rule, campaignId);
        return NextResponse.json(result);
      }
      case "compile_topx_rules": {
        // Body shape: { prompt, scanTarget }
        if (!body.prompt) return NextResponse.json({ error: "prompt required" }, { status: 400 });
        const result = await compileTopXRules(baseId, { prompt: body.prompt, scanTarget: body.scanTarget || "leads" }, campaignId);
        return NextResponse.json(result);
      }
      case "run_topx_smart": {
        // Body shape: { rule, compiledRules } — caller passes the (possibly user-edited) compiled JSON
        if (!rule) return NextResponse.json({ error: "rule required" }, { status: 400 });
        if (!body.compiledRules) return NextResponse.json({ error: "compiledRules required" }, { status: 400 });
        const result = await runTopXSmartCompile(baseId, rule, body.compiledRules, campaignId);
        return NextResponse.json(result);
      }
      case "reset_ai_usage": {
        // Reset the campaign's accumulated AI usage counters back to zero.
        // Used for monthly billing cycles — reset after invoicing the client.
        // Stamps "AI Usage Reset At" so we know when the new accumulation period started.
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const result = await resetCampaignAIUsage(campaignId);
        return NextResponse.json(result);
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Airtable API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
