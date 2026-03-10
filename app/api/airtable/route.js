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

async function createRecords(baseId, table, records) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ fields: r }));
    const res = await fetch(`${baseUrl(baseId)}/${encodeURIComponent(table)}`, {
      method: "POST", headers: hdrs,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`CREATE ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    results.push(...(data.records || []));
  }
  return results;
}

async function updateRecords(baseId, table, records) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ id: r.id, fields: r.fields }));
    const res = await fetch(`${baseUrl(baseId)}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: hdrs,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`UPDATE ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    results.push(...(data.records || []));
  }
  return results;
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
  ],
  "Campaigns": [
    { name: "Name", type: "singleLineText" },
    { name: "Base ID", type: "singleLineText" },
    { name: "Features", type: "singleLineText" },
    { name: "Description", type: "multilineText" },
    { name: "Emoji", type: "singleLineText" },
    { name: "Tables", type: "multilineText" },
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

  for (const [tableName, requiredFields] of Object.entries(SCHEMA)) {
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
  if (!scoringFields.length) return { error: "No scoring fields defined", tasks: [] };
  const table = scanTarget === "accounts" ? "Accounts" : "Leads";
  const records = await listRecords(baseId, table);
  if (!records.length) return { error: `No ${table.toLowerCase()} found`, tasks: [] };

  // ─── Step 1: Weighted numeric scoring (always runs) ──────
  const totalWeight = scoringFields.reduce((sum, sf) => sum + (sf.weight || 0), 0);
  const nf = scoringFields.map(sf => ({
    field: sf.field,
    weight: totalWeight > 0 ? (sf.weight || 0) / totalWeight : 1 / scoringFields.length,
  }));
  const fieldStats = {};
  for (const sf of nf) {
    const values = records.map(r => parseFloat(r.fields?.[sf.field]) || 0);
    fieldStats[sf.field] = { min: Math.min(...values, 0), max: Math.max(...values, 1) };
  }
  const scored = records.map(r => {
    const fields = r.fields || {};
    let cs = 0;
    for (const sf of nf) {
      const raw = parseFloat(fields[sf.field]) || 0;
      const st = fieldStats[sf.field];
      const range = st.max - st.min;
      cs += (range > 0 ? ((raw - st.min) / range) * 100 : 0) * sf.weight;
    }
    return { record: r, numericScore: Math.round(cs), name: fields.Name || fields.Company || "Unknown" };
  });

  // ─── Step 2: AI scoring (only if prompt provided + OpenAI key) ──
  let useAI = scoringPrompt && OPENAI_KEY;
  if (useAI) {
    try {
      const openai = new OpenAI({ apiKey: OPENAI_KEY });
      // Process in batches of 10 to stay within token limits
      const BATCH = 10;
      for (let i = 0; i < scored.length; i += BATCH) {
        const batch = scored.slice(i, i + BATCH);
        const recordSummaries = batch.map((item, idx) => {
          const f = item.record.fields || {};
          // Include all fields, not just scoring ones
          const dataStr = Object.entries(f)
            .filter(([_, v]) => v !== null && v !== undefined && v !== "")
            .map(([k, v]) => `${k}: ${v}`)
            .join(" | ");
          return `[${idx}] ${item.name} — ${dataStr} — Numeric Score: ${item.numericScore}/100`;
        }).join("\n");

        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          temperature: 0.2,
          max_tokens: 800,
          messages: [
            { role: "system", content: `You are a B2B lead/account scoring engine. Score each record from 0-100 based on the user's criteria. Consider ALL the data provided for each record, including the numeric fields and any other context. Return ONLY a JSON array of objects: [{"idx": 0, "score": 85, "reason": "brief 1-line reason"}, ...]. One entry per record, same order as input. No markdown, no backticks.` },
            { role: "user", content: `Scoring Criteria:\n${scoringPrompt}\n\nScoring Fields (weighted): ${scoringFields.map(sf => `${sf.field} (${sf.weight}%)`).join(", ")}\n\nRecords:\n${recordSummaries}` }
          ],
        });

        const text = completion.choices[0]?.message?.content || "[]";
        const cleaned = text.replace(/```json\n?|```/g, "").trim();
        try {
          const aiScores = JSON.parse(cleaned);
          for (const as of aiScores) {
            if (as.idx !== undefined && as.score !== undefined && batch[as.idx]) {
              batch[as.idx].aiScore = Math.max(0, Math.min(100, Math.round(as.score)));
              batch[as.idx].aiReason = as.reason || "";
            }
          }
        } catch (e) {
          console.error("AI scoring parse error:", e.message);
        }
      }

      // Final score: 40% numeric + 60% AI (AI is the primary when prompt is set)
      for (const item of scored) {
        if (item.aiScore !== undefined) {
          item.compositeScore = Math.round(item.numericScore * 0.4 + item.aiScore * 0.6);
        } else {
          item.compositeScore = item.numericScore;
        }
      }
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
  const tasks = scored.slice(0, topN).map(item => ({
    Company: item.name,
    "Task Rule": rule.name || "Top X",
    Score: item.compositeScore,
    "Scan Target": scanTarget,
    Signal: useAI && item.aiReason
      ? `AI: ${item.aiReason} (numeric: ${item.numericScore}, AI: ${item.aiScore})`
      : `Top ${topN} by weighted score (${fieldList})`,
    Source: useAI ? "Top X + AI Scoring" : "Top X Scoring",
    URL: "",
    "Task Type": "top_x",
    Date: new Date().toISOString().slice(0, 10),
    Created: new Date().toISOString(),
  }));
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
