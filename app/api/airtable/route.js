import { NextResponse } from "next/server";
import OpenAI from "openai";

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
    const res = await fetch(url, { headers: authHdr });
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
  "Top N": { type: "number", options: { precision: 0 } },
  "DM Step": { type: "number", options: { precision: 0 } },
  "Description": { type: "multilineText" },
  "Scoring Prompt": { type: "multilineText" },
  "Scoring Fields": { type: "multilineText" },
  "Outreach Config": { type: "multilineText" },
  "Keywords": { type: "multilineText" },
  "Job Title Keywords": { type: "multilineText" },
  "Signal": { type: "multilineText" },
  "Tables": { type: "multilineText" },
  "Notes": { type: "multilineText" },
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
    { name: "Scan Target", type: "singleLineText" },
    { name: "Signal", type: "singleLineText" },
    { name: "Source", type: "singleLineText" },
    { name: "URL", type: "url" },
    { name: "Task Type", type: "singleLineText" },
    { name: "Date", type: "singleLineText" },
    { name: "Created", type: "singleLineText" },
    { name: "Phone", type: "singleLineText" },
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
    { name: "Sender Profile", type: "multilineText" },
    { name: "Email Reference", type: "multilineText" },
    { name: "Email Purpose", type: "multilineText" },
    { name: "Email CTA Link", type: "singleLineText" },
    { name: "Email CTA Purpose", type: "multilineText" },
    { name: "Client Password", type: "singleLineText" },
    { name: "Client Access", type: "singleLineText" },
  ],
  "Email Offers": [
    { name: "Name", type: "singleLineText" },
    { name: "Offer Description", type: "multilineText" },
    { name: "CTA Link", type: "singleLineText" },
    { name: "CTA Purpose", type: "multilineText" },
    { name: "Last Used At", type: "singleLineText" },
    { name: "Use Count", type: "number", options: { precision: 0 } },
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
  const MASTER_ONLY_TABLES = ["Campaigns"];

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

async function runTopXScoring(baseId, rule) {
  const scanTarget = rule.scanTarget || "leads";
  const topN = rule.topN || 10;
  const scoringFields = rule.scoringFields || [];
  const scoringPrompt = (rule.scoringPrompt || "").trim();
  if (!scoringFields.length && !scoringPrompt) return { error: "No scoring fields or AI prompt defined", tasks: [] };
  const table = scanTarget === "accounts" ? "Accounts" : "Leads";
  const records = await listRecords(baseId, table);
  if (!records.length) return { error: `No ${table.toLowerCase()} found`, tasks: [] };

  // ─── Step 1: Weighted numeric scoring (skipped if no fields) ──
  // Precompute field stats ONCE (not per-record — was O(n²) before)
  const totalWeight = scoringFields.reduce((sum, sf) => sum + (sf.weight || 0), 0);
  const fieldStats = {};
  for (const sf of scoringFields) {
    const values = records.map(r => parseFloat(r.fields?.[sf.field]) || 0);
    fieldStats[sf.field] = { min: Math.min(...values, 0), max: Math.max(...values, 1) };
  }
  const scored = records.map(r => {
    const fields = r.fields || {};
    let cs = 0;
    if (scoringFields.length > 0) {
      for (const sf of scoringFields) {
        const w = totalWeight > 0 ? (sf.weight || 0) / totalWeight : 1 / scoringFields.length;
        const raw = parseFloat(fields[sf.field]) || 0;
        const st = fieldStats[sf.field];
        const range = st.max - st.min;
        cs += (range > 0 ? ((raw - st.min) / range) * 100 : 0) * w;
      }
    }
    return { record: r, numericScore: Math.round(cs), name: fields.Name || fields.Company || "Unknown" };
  });

  // ─── Step 2: AI scoring (only if prompt provided + OpenAI key) ──
  const hasNumeric = scoringFields.length > 0;
  let useAI = scoringPrompt && OPENAI_KEY;
  if (useAI) {
    scored.sort((a, b) => b.numericScore - a.numericScore);

    // Score ALL records — use larger batches (15) for pure AI to keep cost reasonable
    // 1000 leads / 15 per batch = ~67 API calls × ~$0.001 = ~$0.07
    // When blended (has numeric fields), only AI-score the top 3x since numeric pre-filters
    const candidateCount = hasNumeric
      ? Math.min(scored.length, topN * 3)
      : scored.length; // ← pure AI: score EVERYTHING
    const candidates = scored.slice(0, candidateCount);
    const rest = scored.slice(candidateCount);

    const BATCH = hasNumeric ? 5 : 15; // larger batches for pure AI (cheaper, faster)

    try {
      const openai = new OpenAI({ apiKey: OPENAI_KEY });
      console.log(`[TOP-X] AI scoring ${candidates.length} records in batches of ${BATCH}`);
      for (let i = 0; i < candidates.length; i += BATCH) {
        const batch = candidates.slice(i, i + BATCH);
        if (i % (BATCH * 10) === 0 || i === 0) console.log(`[TOP-X] Progress: ${i}/${candidates.length} scored...`);
        const recordSummaries = batch.map((item, idx) => {
          const f = item.record.fields || {};
          // Show ALL fields including zeros — AI needs to see "Engagement: 0" not just omit it
          const maxFieldLen = BATCH > 10 ? 80 : 150;
          const dataStr = Object.entries(f)
            .filter(([_, v]) => v !== null && v !== undefined)
            .map(([k, v]) => {
              const val = v === "" ? "(empty)" : String(v).slice(0, maxFieldLen);
              return `${k}: ${val}`;
            })
            .join(" | ");
          return `[${idx}] ${item.name} — ${dataStr}`;
        }).join("\n");

        const completion = await openai.chat.completions.create({
          model: "gpt-5.4-mini",
          temperature: 0.2,
          max_tokens: BATCH > 10 ? 4000 : 2048,
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

        const text = completion.choices[0]?.message?.content || "[]";
        const cleaned = text.replace(/```json\n?|```/g, "").trim();
        try {
          const aiScores = JSON.parse(cleaned);
          for (const as of aiScores) {
            if (as.idx !== undefined && as.score !== undefined && batch[as.idx]) {
              batch[as.idx].aiScore = Math.max(0, Math.min(100, Math.round(as.score)));
              batch[as.idx].aiReason = (as.reason || as.tier || "").slice(0, 100);
            }
          }
        } catch (parseErr) {
          // Attempt to recover truncated JSON — extract what we can
          console.warn("AI scoring parse error, attempting recovery:", parseErr.message);
          try {
            // Find all complete objects in truncated JSON
            const objMatches = cleaned.matchAll(/\{"idx"\s*:\s*(\d+)\s*,\s*"score"\s*:\s*(\d+)/g);
            for (const m of objMatches) {
              const idx = parseInt(m[1]);
              const score = parseInt(m[2]);
              if (batch[idx]) {
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
            const f = item.record.fields || {};
            const dataStr = Object.entries(f)
              .filter(([_, v]) => v !== null && v !== undefined)
              .map(([k, v]) => `${k}: ${v === "" ? "(empty)" : String(v).slice(0, 200)}`)
              .join(" | ");
            const retry = await openai.chat.completions.create({
              model: "gpt-5.4-mini", temperature: 0.2, max_tokens: 200,
              messages: [
                { role: "system", content: `Score this record 0-100 based STRICTLY on its data values. If key metric fields are zero/empty, score below 30. Return ONLY: {"score":85,"reason":"max 15 words citing actual data values"}` },
                { role: "user", content: `Criteria:\n${scoringPrompt}\n\nRecord: ${item.name} — ${dataStr}` }
              ],
            });
            const rt = (retry.choices[0]?.message?.content || "").replace(/```json\n?|```/g, "").trim();
            const rd = JSON.parse(rt);
            if (rd.score !== undefined) {
              item.aiScore = Math.max(0, Math.min(100, Math.round(rd.score)));
              item.aiReason = (rd.reason || rd.tier || "").slice(0, 100);
            }
          } catch (e) { /* individual retry failed, keep unscored */ }
        }
      }

      // Final score: if numeric fields exist, blend 40% numeric + 60% AI. Otherwise pure AI.
      const aiScoredCount = candidates.filter(item => item.aiScore !== undefined).length;
      console.log(`[TOP-X] AI scored ${aiScoredCount}/${candidates.length} records successfully`);
      for (const item of candidates) {
        if (item.aiScore !== undefined) {
          item.compositeScore = hasNumeric
            ? Math.round(item.numericScore * 0.4 + item.aiScore * 0.6)
            : item.aiScore;
        } else {
          item.compositeScore = item.numericScore;
        }
      }
      // Non-candidates keep numeric score (won't make top N anyway)
      rest.forEach(item => { item.compositeScore = item.numericScore; });
      // Recombine and re-sort
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

  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  const fieldList = scoringFields.map(sf => sf.field).join(", ");
  const tasks = scored.slice(0, topN).map(item => {
    const score = parseInt(item.compositeScore) || 0;
    const aiScore = parseInt(item.aiScore) || 0;
    const numScore = parseInt(item.numericScore) || 0;
    return {
      Company: item.name,
      "Task Rule": rule.name || "Top X",
      Score: Math.max(0, Math.min(100, score)),
      "Scan Target": scanTarget,
      Signal: item.aiReason
        ? `AI: ${item.aiReason} (${hasNumeric ? "numeric: " + numScore + ", " : ""}AI: ${aiScore})`
        : hasNumeric
          ? `Ranked by weighted score${fieldList ? " (" + fieldList + ")" : ""}: ${numScore}/100`
          : `AI score pending — record included by position`,
      Source: useAI ? "Top X + AI Scoring" : "Top X Scoring",
      URL: "",
      "Task Type": "top_x",
      Date: new Date().toISOString().slice(0, 10),
      Created: new Date().toISOString(),
    };
  });
  return { tasks, totalRecords: records.length, topN, aiScored: !!useAI };
}

// ═══════════════════════════════════════════════════════════════
// GET TABLE FIELDS
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

    if (!baseId) {
      return NextResponse.json({ error: "No baseId provided and no AIRTABLE_BASE_ID configured" }, { status: 500 });
    }

    switch (action) {
      // ─── Campaign Registry (always uses master base) ────────
      case "list_campaigns": {
        if (!MASTER_BASE_ID) return NextResponse.json({ records: [] });
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
        const result = await runTopXScoring(baseId, rule);
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
