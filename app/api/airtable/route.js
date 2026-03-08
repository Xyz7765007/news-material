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
  const res = await fetch(`${META_URL}/tables`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to fetch schema: ${res.status} — ${err.slice(0, 200)}`);
  }
  const { tables } = await res.json();
  const results = { created: [], skipped: [], errors: [] };

  // 2. For each required table, check fields
  for (const [tableName, requiredFields] of Object.entries(SCHEMA)) {
    const table = tables.find(t => t.name === tableName);
    if (!table) {
      results.errors.push(`Table "${tableName}" not found — please create it in Airtable first`);
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
        if (!createRes.ok) {
          const err = await createRes.text();
          results.errors.push(`${tableName}.${field.name}: ${err.slice(0, 100)}`);
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
