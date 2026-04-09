import { NextResponse } from "next/server";

const AT_API = "https://api.airtable.com/v0";
const AT_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE = process.env.AIRTABLE_BASE_ID;
const HS_API = "https://api.hubapi.com";
const atHdr = { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" };

// ─── Store/retrieve HubSpot API key from Airtable campaign ──
async function getStoredKey(campaignId) {
  if (!campaignId || !MASTER_BASE) return null;
  try {
    const res = await fetch(`${AT_API}/${MASTER_BASE}/Campaigns/${campaignId}`, { headers: atHdr });
    if (!res.ok) return null;
    const { fields } = await res.json();
    return fields?.["HubSpot API Key"] || null;
  } catch { return null; }
}

async function storeKey(campaignId, apiKey) {
  if (!campaignId || !MASTER_BASE) return false;
  try {
    const res = await fetch(`${AT_API}/${MASTER_BASE}/Campaigns/${campaignId}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({ fields: { "HubSpot API Key": apiKey } }),
    });
    return res.ok;
  } catch { return false; }
}

function hsHdr(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

// ─── HubSpot: Test connection ────────────────────────────────
async function testConnection(apiKey) {
  const res = await fetch(`${HS_API}/crm/v3/objects/contacts?limit=1`, { headers: hsHdr(apiKey) });
  if (!res.ok) {
    const err = await res.text();
    return { ok: false, error: `HubSpot returned ${res.status}: ${err.slice(0, 150)}` };
  }
  // Get account info
  const acctRes = await fetch(`${HS_API}/account-info/v3/details`, { headers: hsHdr(apiKey) });
  let account = {};
  if (acctRes.ok) account = await acctRes.json();
  return { ok: true, portalId: account.portalId, companyName: account.companyCurrency || "", uiDomain: account.uiDomain || "" };
}

// ─── HubSpot: Fetch owners (for assignee picker) ────────────
async function fetchOwners(apiKey) {
  const res = await fetch(`${HS_API}/crm/v3/owners?limit=100`, { headers: hsHdr(apiKey) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map(o => ({
    id: o.id,
    email: o.email,
    firstName: o.firstName || "",
    lastName: o.lastName || "",
    label: `${o.firstName || ""} ${o.lastName || ""}`.trim() || o.email,
  }));
}

// ─── HubSpot: Fetch task properties ──────────────────────────
async function fetchTaskProperties(apiKey) {
  const res = await fetch(`${HS_API}/crm/v3/properties/tasks`, { headers: hsHdr(apiKey) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).filter(p => !p.hidden && !p.calculated).map(p => ({
    name: p.name,
    label: p.label,
    type: p.type,
    fieldType: p.fieldType,
    options: (p.options || []).map(o => ({ label: o.label, value: o.value })),
  }));
}

// ─── HubSpot: Create tasks ──────────────────────────────────
async function createTasks(apiKey, tasks, config) {
  const { ownerId, taskType, priority, status } = config;
  const results = { created: 0, errors: [] };

  // Batch create (max 100 per batch in HubSpot)
  for (let i = 0; i < tasks.length; i += 100) {
    const batch = tasks.slice(i, i + 100);
    const inputs = batch.map(t => {
      const props = {
        hs_task_subject: t.subject || `${t.Company || ""} — ${t["Task Rule"] || "Task"}`,
        hs_task_body: t.body || buildTaskBody(t),
        hs_task_status: status || "NOT_STARTED",
        hs_task_priority: priority || "MEDIUM",
        hs_task_type: taskType || "TODO",
      };
      if (t.dueDate) props.hs_timestamp = new Date(t.dueDate).getTime();
      else props.hs_timestamp = Date.now() + 7 * 86400000; // default: due in 7 days
      if (ownerId) props.hubspot_owner_id = ownerId;
      // Custom properties from mapping
      if (t.customProps) Object.assign(props, t.customProps);
      return { properties: props };
    });

    const res = await fetch(`${HS_API}/crm/v3/objects/tasks/batch/create`, {
      method: "POST", headers: hsHdr(apiKey),
      body: JSON.stringify({ inputs }),
    });

    if (res.ok) {
      const data = await res.json();
      results.created += (data.results || []).length;
    } else {
      const err = await res.text();
      console.error("[HUBSPOT] Batch create error:", err.slice(0, 300));
      results.errors.push(err.slice(0, 150));
    }
  }
  return results;
}

function buildTaskBody(task) {
  const parts = [];
  if (task.Company) parts.push(`Company: ${task.Company}`);
  if (task["Task Rule"]) parts.push(`Signal: ${task["Task Rule"]}`);
  if (task.Score) parts.push(`Score: ${task.Score}/100`);
  if (task.Signal) parts.push(`Details: ${task.Signal}`);
  if (task.URL) parts.push(`Source: ${task.URL}`);
  if (task.Phone) parts.push(`Phone: ${task.Phone}`);
  if (task["Lead Name"]) parts.push(`Lead: ${task["Lead Name"]}`);
  if (task["Lead Title"]) parts.push(`Title: ${task["Lead Title"]}`);
  if (task.Date) parts.push(`Date: ${task.Date}`);
  parts.push(`\nCreated by SignalScope`);
  return parts.join("\n");
}

// ─── HubSpot: Search contacts by email or company ───────────
async function searchContacts(apiKey, query) {
  const res = await fetch(`${HS_API}/crm/v3/objects/contacts/search`, {
    method: "POST", headers: hsHdr(apiKey),
    body: JSON.stringify({
      filterGroups: [{ filters: [{ propertyName: "email", operator: "CONTAINS_TOKEN", value: query }] }],
      limit: 10,
    }),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.results || [];
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, campaignId } = body;

    switch (action) {
      case "get_stored_key": {
        const key = await getStoredKey(campaignId);
        return NextResponse.json({ hasKey: !!key, maskedKey: key ? "****" + key.slice(-4) : null });
      }

      case "save_key": {
        const { apiKey } = body;
        if (!apiKey) return NextResponse.json({ error: "No API key provided" }, { status: 400 });
        // Test first
        const test = await testConnection(apiKey);
        if (!test.ok) return NextResponse.json({ error: test.error }, { status: 400 });
        // Store in Airtable
        const stored = await storeKey(campaignId, apiKey);
        return NextResponse.json({ ok: true, stored, portalId: test.portalId });
      }

      case "test": {
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No HubSpot API key configured" }, { status: 400 });
        const result = await testConnection(apiKey);
        return NextResponse.json(result);
      }

      case "fetch_owners": {
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const owners = await fetchOwners(apiKey);
        return NextResponse.json({ owners });
      }

      case "fetch_properties": {
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const properties = await fetchTaskProperties(apiKey);
        return NextResponse.json({ properties });
      }

      case "push_tasks": {
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const { tasks, config } = body;
        if (!tasks?.length) return NextResponse.json({ error: "No tasks to push" }, { status: 400 });
        const result = await createTasks(apiKey, tasks, config || {});
        return NextResponse.json(result);
      }

      case "search_contacts": {
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const contacts = await searchContacts(apiKey, body.query);
        return NextResponse.json({ contacts });
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("[HUBSPOT] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
