import { NextResponse } from "next/server";

const API_KEY = process.env.AIRTABLE_API_KEY;
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
    { name: "Status", type: "singleLineText" },
    { name: "Description", type: "multilineText" },
    { name: "Emoji", type: "singleLineText" },
    { name: "Tables", type: "multilineText" },
  ],
};

// Ensure custom fields exist (fieldDefs: string[] | {name,type,options}[])
async function ensureCustomFields(baseId, tableName, fieldDefs) {
  const results = { created: [], skipped: [], errors: [] };
  let res;
  try {
    res = await fetch(`${metaUrl(baseId)}/tables`, { headers: authHdr });
  } catch (e) {
    results.errors.push(`Cannot reach Airtable API: ${e.message}`);
    return results;
  }
  if (!res.ok) {
    results.errors.push(`Failed to fetch schema: ${res.status}`);
    return results;
  }
  const { tables } = await res.json();
  const table = tables.find(t => t.name === tableName);
  if (!table) {
    results.errors.push(`Table "${tableName}" not found`);
    return results;
  }
  const existingNames = new Set((table.fields || []).map(f => f.name));
  for (const fd of fieldDefs) {
    const fieldName = typeof fd === "string" ? fd : fd.name;
    const fieldType = typeof fd === "string" ? "singleLineText" : (fd.type || "singleLineText");
    const fieldOptions = typeof fd === "object" ? fd.options : undefined;
    if (existingNames.has(fieldName)) {
      results.skipped.push(fieldName);
      continue;
    }
    try {
      const body = { name: fieldName, type: fieldType };
      if (fieldOptions) body.options = fieldOptions;
      const createRes = await fetch(`${metaUrl(baseId)}/tables/${table.id}/fields`, {
        method: "POST", headers: hdrs, body: JSON.stringify(body),
      });
      if (!createRes.ok) {
        const err = await createRes.text();
        if (err.includes("DUPLICATE_FIELD_NAME")) results.skipped.push(fieldName);
        else results.errors.push(`${fieldName}: ${err.slice(0, 120)}`);
      } else {
        results.created.push(fieldName);
      }
    } catch (e) {
      results.errors.push(`${fieldName}: ${e.message}`);
    }
  }
  return results;
}

// Setup schema on a given base
async function setupSchema(baseId) {
  let res;
  try {
    res = await fetch(`${metaUrl(baseId)}/tables`, { headers: authHdr });
  } catch (e) {
    throw new Error(`Cannot reach Airtable API: ${e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    const err = await res.text();
    throw new Error(`Auth failed (${res.status}). Token needs scopes: data.records:read/write, schema.bases:read/write. ${err.slice(0, 150)}`);
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to fetch schema: ${res.status} — ${err.slice(0, 200)}`);
  }
  const { tables } = await res.json();
  if (!tables?.length) {
    throw new Error("No tables found in this base.");
  }
  const results = { created: [], skipped: [], errors: [], tables_found: tables.map(t => t.name) };
  for (const [tableName, requiredFields] of Object.entries(SCHEMA)) {
    const table = tables.find(t => t.name === tableName);
    if (!table) continue; // skip tables that don't exist in this base
    const existingNames = new Set((table.fields || []).map(f => f.name));
    for (const field of requiredFields) {
      if (existingNames.has(field.name)) {
        results.skipped.push(`${tableName}.${field.name}`);
        continue;
      }
      try {
        const body = { name: field.name, type: field.type };
        if (field.options) body.options = field.options;
        const createRes = await fetch(`${metaUrl(baseId)}/tables/${table.id}/fields`, {
          method: "POST", headers: hdrs, body: JSON.stringify(body),
        });
        if (createRes.status === 422) {
          const err = await createRes.text();
          if (err.includes("DUPLICATE_FIELD_NAME")) results.skipped.push(`${tableName}.${field.name}`);
          else results.errors.push(`${tableName}.${field.name}: ${err.slice(0, 120)}`);
        } else if (!createRes.ok) {
          const err = await createRes.text();
          results.errors.push(`${tableName}.${field.name}: HTTP ${createRes.status} — ${err.slice(0, 120)}`);
        } else {
          results.created.push(`${tableName}.${field.name}`);
        }
      } catch (e) {
        results.errors.push(`${tableName}.${field.name}: ${e.message}`);
      }
    }
  }
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

async function createCampaign(fields) {
  return await createRecords(MASTER_BASE_ID, "Campaigns", [fields]);
}

async function deleteCampaign(recordId) {
  return await deleteRecords(MASTER_BASE_ID, "Campaigns", [recordId]);
}

async function updateCampaign(records) {
  return await updateRecords(MASTER_BASE_ID, "Campaigns", records);
}

// ═══════════════════════════════════════════════════════════════
// TOP X SCORING ENGINE
// ═══════════════════════════════════════════════════════════════

async function runTopXScoring(baseId, rule) {
  const scanTarget = rule.scanTarget || "leads";
  const topN = rule.topN || 10;
  const scoringFields = rule.scoringFields || [];
  if (!scoringFields.length) return { error: "No scoring fields defined", tasks: [] };
  const table = scanTarget === "accounts" ? "Accounts" : "Leads";
  const records = await listRecords(baseId, table);
  if (!records.length) return { error: `No ${table.toLowerCase()} found`, tasks: [] };
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
    return { record: r, compositeScore: Math.round(cs), name: fields.Name || fields.Company || "Unknown" };
  });
  scored.sort((a, b) => b.compositeScore - a.compositeScore);
  const tasks = scored.slice(0, topN).map(item => ({
    Company: item.name,
    "Task Rule": rule.name || "Top X",
    Score: item.compositeScore,
    "Scan Target": scanTarget,
    Signal: `Top ${topN} by weighted score (${scoringFields.map(sf => sf.field).join(", ")})`,
    Source: "Top X Scoring",
    URL: "",
    "Task Type": "top_x",
    Date: new Date().toISOString().slice(0, 10),
    Created: new Date().toISOString(),
  }));
  return { tasks, totalRecords: records.length, topN };
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
