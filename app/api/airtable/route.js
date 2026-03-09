import { NextResponse } from "next/server";

const BASE_ID = process.env.AIRTABLE_BASE_ID;
const API_KEY = process.env.AIRTABLE_API_KEY;
const BASE_URL = `https://api.airtable.com/v0/${BASE_ID}`;

const headers = {
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

// ─── List records ───────────────────────────────────────────────
async function listRecords(table, params = {}) {
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
      ? `${BASE_URL}/${encodeURIComponent(table)}?${qs.toString()}&offset=${offset}`
      : `${BASE_URL}/${encodeURIComponent(table)}?${qs.toString()}`;

    const res = await fetch(url, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Airtable LIST ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset;
  } while (offset);

  return allRecords;
}

// ─── Create records (batch up to 10) ────────────────────────────
async function createRecords(table, records) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ fields: r }));
    const res = await fetch(`${BASE_URL}/${encodeURIComponent(table)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Airtable CREATE ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    results.push(...(data.records || []));
  }
  return results;
}

// ─── Update records (batch up to 10) ────────────────────────────
async function updateRecords(table, records) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ id: r.id, fields: r.fields }));
    const res = await fetch(`${BASE_URL}/${encodeURIComponent(table)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Airtable UPDATE ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    results.push(...(data.records || []));
  }
  return results;
}

// ─── Delete records (batch up to 10) ────────────────────────────
async function deleteRecords(table, recordIds) {
  const results = [];
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    const qs = batch.map(id => `records[]=${id}`).join("&");
    const res = await fetch(`${BASE_URL}/${encodeURIComponent(table)}?${qs}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Airtable DELETE ${table} error:`, err);
      throw new Error(`Airtable error: ${res.status}`);
    }
    const data = await res.json();
    results.push(...(data.records || []));
  }
  return results;
}

// ─── Schema: Required fields per table ──────────────────────────
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
    { name: "Signal Source", type: "singleLineText" },
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
    { name: "Signal Type", type: "singleLineText" },
    { name: "Date", type: "singleLineText" },
    { name: "Created", type: "singleLineText" },
  ],
  "Campaigns": [
    { name: "Name", type: "singleLineText" },
    { name: "Status", type: "singleLineText" },
    { name: "Description", type: "multilineText" },
  ],
};

const META_URL = `https://api.airtable.com/v0/meta/bases/${BASE_ID}`;

// ─── Setup: ensure all tables have required fields ──────────────
async function setupSchema() {
  // 1. Fetch current schema
  let res;
  try {
    res = await fetch(`${META_URL}/tables`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
  } catch (e) {
    throw new Error(`Cannot reach Airtable API: ${e.message}`);
  }

  if (res.status === 401 || res.status === 403) {
    const err = await res.text();
    throw new Error(`Airtable auth failed (${res.status}). Check your AIRTABLE_API_KEY env var. Make sure your token has scopes: data.records:read, data.records:write, schema.bases:read, schema.bases:write. Error: ${err.slice(0, 150)}`);
  }

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to fetch schema: ${res.status} — ${err.slice(0, 200)}`);
  }

  const { tables } = await res.json();
  if (!tables || !tables.length) {
    throw new Error("No tables found in the Airtable base. Create the tables first: Accounts, Leads, Task Rules, Prompts, Tasks, Campaigns");
  }

  const results = { created: [], skipped: [], errors: [], tables_found: tables.map(t => t.name) };

  // 2. For each required table, check fields
  for (const [tableName, requiredFields] of Object.entries(SCHEMA)) {
    const table = tables.find(t => t.name === tableName);
    if (!table) {
      results.errors.push(`Table "${tableName}" not found — please create it in Airtable`);
      continue;
    }

    const existingNames = new Set((table.fields || []).map(f => f.name));

    for (const field of requiredFields) {
      if (existingNames.has(field.name)) {
        results.skipped.push(`${tableName}.${field.name}`);
        continue;
      }

      // Create the missing field
      try {
        const body = { name: field.name, type: field.type };
        if (field.options) body.options = field.options;

        const createRes = await fetch(`${META_URL}/tables/${table.id}/fields`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        });

        if (createRes.status === 401 || createRes.status === 403 || createRes.status === 422) {
          const err = await createRes.text();
          if (err.includes("NOT_AUTHORIZED") || err.includes("FORBIDDEN")) {
            results.errors.push(`Permission denied creating ${tableName}.${field.name}. Your Airtable token needs the "schema.bases:write" scope. Go to airtable.com/create/tokens and add it.`);
          } else if (err.includes("DUPLICATE_FIELD_NAME")) {
            results.skipped.push(`${tableName}.${field.name}`);
          } else {
            results.errors.push(`${tableName}.${field.name}: ${err.slice(0, 120)}`);
          }
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

// ─── Test: create a test field, verify, then delete ─────────────
async function testAirtableConnection() {
  const result = { steps: [] };

  // Step 1: Fetch tables
  try {
    const res = await fetch(`${META_URL}/tables`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (!res.ok) {
      const err = await res.text();
      result.steps.push({ step: "Read schema", ok: false, msg: `HTTP ${res.status}: ${err.slice(0, 150)}` });
      return result;
    }
    const { tables } = await res.json();
    result.steps.push({ step: "Read schema", ok: true, msg: `Found ${tables.length} tables: ${tables.map(t => t.name).join(", ")}` });

    // Step 2: Try creating a test field in the first table
    const testTable = tables[0];
    if (!testTable) {
      result.steps.push({ step: "Create test column", ok: false, msg: "No tables found" });
      return result;
    }

    const testFieldName = `_test_signalscope_${Date.now()}`;
    const createRes = await fetch(`${META_URL}/tables/${testTable.id}/fields`, {
      method: "POST", headers,
      body: JSON.stringify({ name: testFieldName, type: "singleLineText" }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      if (err.includes("NOT_AUTHORIZED") || err.includes("FORBIDDEN") || createRes.status === 403) {
        result.steps.push({ step: "Create test column", ok: false, msg: `Permission denied. Your token needs "schema.bases:write" scope. Go to airtable.com/create/tokens to add it.` });
      } else {
        result.steps.push({ step: "Create test column", ok: false, msg: `HTTP ${createRes.status}: ${err.slice(0, 150)}` });
      }
      return result;
    }

    result.steps.push({ step: "Create test column", ok: true, msg: `Created "${testFieldName}" in ${testTable.name}` });

    // Step 3: Verify by reading schema again
    const verifyRes = await fetch(`${META_URL}/tables`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    if (verifyRes.ok) {
      const { tables: updated } = await verifyRes.json();
      const updatedTable = updated.find(t => t.id === testTable.id);
      const found = (updatedTable?.fields || []).find(f => f.name === testFieldName);
      result.steps.push({ step: "Verify column exists", ok: !!found, msg: found ? "Column verified in Airtable" : "Column not found after creation" });
    }

    // Step 4: Note about cleanup
    result.steps.push({ step: "Cleanup", ok: true, msg: `Delete "${testFieldName}" from "${testTable.name}" manually in Airtable (API can't delete fields)` });

    return result;
  } catch (e) {
    result.steps.push({ step: "Connection", ok: false, msg: e.message });
    return result;
  }
}

// ─── Route Handler ──────────────────────────────────────────────
export async function POST(request) {
  try {
    if (!BASE_ID || !API_KEY) {
      return NextResponse.json({ error: "Airtable not configured" }, { status: 500 });
    }

    const { action, table, records, recordIds, params } = await request.json();

    switch (action) {
      case "setup": {
        const results = await setupSchema();
        return NextResponse.json(results);
      }
      case "test": {
        const results = await testAirtableConnection();
        return NextResponse.json(results);
      }
      case "list": {
        const data = await listRecords(table, params || {});
        return NextResponse.json({ records: data });
      }
      case "create": {
        const data = await createRecords(table, records);
        return NextResponse.json({ records: data });
      }
      case "update": {
        const data = await updateRecords(table, records);
        return NextResponse.json({ records: data });
      }
      case "delete": {
        const data = await deleteRecords(table, recordIds);
        return NextResponse.json({ records: data });
      }
      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Airtable API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
