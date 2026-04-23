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
    // Ensure field exists
    const tables = await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE}/tables`, { headers: atHdr });
    if (tables.ok) {
      const { tables: tbls } = await tables.json();
      const campTable = tbls?.find(t => t.name === "Campaigns");
      if (campTable && !campTable.fields?.some(f => f.name === "HubSpot API Key")) {
        await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE}/tables/${campTable.id}/fields`, {
          method: "POST", headers: atHdr,
          body: JSON.stringify({ name: "HubSpot API Key", type: "singleLineText" }),
        });
      }
    }
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
  const { ownerId, taskType, priority, status, mode } = config;
  // mode: "smart" (default — update existing, create new), "skip_existing" (only create new), "force_create" (always create)
  const pushMode = mode || "smart";
  const results = {
    created: 0,
    updated: 0,
    skipped: 0,
    associated: 0,
    notAssociated: 0,
    errors: [],
    // Map of task.airtableId → hubspotTaskId so frontend can save back to Airtable
    airtableToHubspotMap: {},
  };

  // Split into create vs update based on HubSpot Task ID presence
  const toCreate = [];
  const toUpdate = [];
  for (const t of tasks) {
    if (t.hubspotTaskId && pushMode !== "force_create") {
      if (pushMode === "skip_existing") {
        results.skipped++;
      } else {
        toUpdate.push(t);
      }
    } else {
      toCreate.push(t);
    }
  }
  console.log(`[HUBSPOT createTasks] mode=${pushMode}: ${toCreate.length} to create, ${toUpdate.length} to update, ${results.skipped} skipped`);

  // Step 1: For CREATE path — lookup contacts by email
  const uniqueEmails = [...new Set(toCreate.map(t => (t.Email || "").trim().toLowerCase()).filter(Boolean))];
  const emailToContactId = {};
  if (uniqueEmails.length > 0) {
    for (let i = 0; i < uniqueEmails.length; i += 100) {
      const emailBatch = uniqueEmails.slice(i, i + 100);
      try {
        const searchRes = await fetch(`${HS_API}/crm/v3/objects/contacts/search`, {
          method: "POST", headers: hsHdr(apiKey),
          body: JSON.stringify({
            filterGroups: [{
              filters: [{ propertyName: "email", operator: "IN", values: emailBatch }]
            }],
            properties: ["email"],
            limit: 100,
          }),
        });
        if (searchRes.ok) {
          const data = await searchRes.json();
          (data.results || []).forEach(c => {
            const em = (c.properties?.email || "").toLowerCase().trim();
            if (em) emailToContactId[em] = c.id;
          });
        }
      } catch (e) {
        console.error("[HUBSPOT] Contact search exception:", e.message);
      }
    }
    console.log(`[HUBSPOT createTasks] Found ${Object.keys(emailToContactId).length} of ${uniqueEmails.length} emails in HubSpot`);
  }

  // Step 2: BATCH CREATE new tasks (100 per batch, with associations inline)
  for (let i = 0; i < toCreate.length; i += 100) {
    const batch = toCreate.slice(i, i + 100);
    const inputs = batch.map(t => {
      const props = {
        hs_task_subject: t.subject || `${t.Company || ""} — ${t["Task Rule"] || "Task"}`,
        hs_task_body: t.body || buildTaskBody(t),
        hs_task_status: status || "NOT_STARTED",
        hs_task_priority: priority || "MEDIUM",
        hs_task_type: taskType || "TODO",
      };
      if (t.dueDate) props.hs_timestamp = new Date(t.dueDate).getTime();
      else props.hs_timestamp = Date.now() + 7 * 86400000;
      if (ownerId) props.hubspot_owner_id = ownerId;
      if (t.customProps) Object.assign(props, t.customProps);

      const associations = [];
      const email = (t.Email || "").toLowerCase().trim();
      const contactId = email ? emailToContactId[email] : null;
      if (contactId) {
        associations.push({
          to: { id: contactId },
          types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
        });
      }

      const input = { properties: props };
      if (associations.length > 0) input.associations = associations;
      return input;
    });

    const res = await fetch(`${HS_API}/crm/v3/objects/tasks/batch/create`, {
      method: "POST", headers: hsHdr(apiKey),
      body: JSON.stringify({ inputs }),
    });

    if (res.ok) {
      const data = await res.json();
      const created = data.results || [];
      results.created += created.length;
      // Map back: HubSpot returns results in same order as inputs
      created.forEach((hsTask, idx) => {
        const airtableTask = batch[idx];
        if (airtableTask.airtableId) {
          results.airtableToHubspotMap[airtableTask.airtableId] = hsTask.id;
        }
      });
      const associatedInBatch = inputs.filter(inp => (inp.associations || []).length > 0).length;
      results.associated += associatedInBatch;
      results.notAssociated += (created.length - associatedInBatch);
    } else {
      const err = await res.text();
      console.error("[HUBSPOT] Batch create error:", err.slice(0, 400));
      results.errors.push(`Create batch: ${err.slice(0, 200)}`);
    }
  }

  // Step 3: BATCH UPDATE existing tasks (100 per batch)
  // Note: HubSpot batch update does NOT modify associations — only properties.
  // If a task existed with wrong association, that won't be fixed here (rare edge case).
  for (let i = 0; i < toUpdate.length; i += 100) {
    const batch = toUpdate.slice(i, i + 100);
    const inputs = batch.map(t => {
      const props = {
        hs_task_subject: t.subject || `${t.Company || ""} — ${t["Task Rule"] || "Task"}`,
        hs_task_body: t.body || buildTaskBody(t),
        hs_task_priority: priority || "MEDIUM",
      };
      // Only update status if explicitly provided (don't accidentally reopen completed tasks)
      if (status && status !== "NOT_STARTED") props.hs_task_status = status;
      if (t.dueDate) props.hs_timestamp = new Date(t.dueDate).getTime();
      // Don't touch ownerId on updates — respects manual reassignments SDRs may have done
      if (t.customProps) Object.assign(props, t.customProps);
      return { id: t.hubspotTaskId, properties: props };
    });

    const res = await fetch(`${HS_API}/crm/v3/objects/tasks/batch/update`, {
      method: "POST", headers: hsHdr(apiKey),
      body: JSON.stringify({ inputs }),
    });

    if (res.ok) {
      const data = await res.json();
      const updated = data.results || [];
      results.updated += updated.length;
      // Map back (keep existing ID)
      batch.forEach(t => {
        if (t.airtableId) results.airtableToHubspotMap[t.airtableId] = t.hubspotTaskId;
      });
    } else {
      const err = await res.text();
      console.error("[HUBSPOT] Batch update error:", err.slice(0, 400));
      results.errors.push(`Update batch: ${err.slice(0, 200)}`);

      // If update failed because task was deleted in HubSpot, fall back to creating new
      if (err.includes("not found") || err.includes("NOT_FOUND")) {
        console.log("[HUBSPOT] Update target(s) deleted — will need re-push in create mode");
        results.errors.push("Some tasks were deleted in HubSpot. Push again with 'force create' to recreate.");
      }
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

// ─── HubSpot: Create contacts — skip existing (no duplicates) ─
async function pushLeads(apiKey, leads, config) {
  const { ownerId, lifecycleStage, leadStatus } = config;
  const results = { created: 0, skipped: 0, alreadyExist: 0, errors: [] };

  // Step 1: Collect all emails and check which already exist in HubSpot
  const emails = leads.map(l => (l.email || "").toLowerCase().trim()).filter(Boolean);
  const existingEmails = new Set();

  // Batch read by email — 100 at a time
  for (let i = 0; i < emails.length; i += 100) {
    const batch = emails.slice(i, i + 100);
    try {
      const res = await fetch(`${HS_API}/crm/v3/objects/contacts/batch/read`, {
        method: "POST", headers: hsHdr(apiKey),
        body: JSON.stringify({
          properties: ["email"],
          idProperty: "email",
          inputs: batch.map(email => ({ id: email })),
        }),
      });
      if (res.ok) {
        const data = await res.json();
        for (const r of (data.results || [])) {
          const em = (r.properties?.email || "").toLowerCase().trim();
          if (em) existingEmails.add(em);
        }
      }
    } catch (e) {
      console.error("[HUBSPOT] Batch read error:", e.message);
    }
  }

  console.log(`[HUBSPOT] ${existingEmails.size} contacts already exist in HubSpot out of ${emails.length} emails`);

  // Step 2: Filter out existing contacts
  const newLeads = leads.filter(l => {
    const em = (l.email || "").toLowerCase().trim();
    if (em && existingEmails.has(em)) { results.alreadyExist++; return false; }
    return true;
  });

  if (!newLeads.length) {
    return results;
  }

  // Step 3: Create only new contacts
  for (let i = 0; i < newLeads.length; i += 100) {
    const batch = newLeads.slice(i, i + 100);
    const inputs = batch.map(l => {
      const props = {};
      if (l.email) props.email = l.email;
      if (l.firstName || l.name) {
        const parts = (l.name || "").split(" ");
        props.firstname = l.firstName || parts[0] || "";
        props.lastname = l.lastName || parts.slice(1).join(" ") || "";
      }
      if (l.phone) props.phone = l.phone;
      if (l.company) props.company = l.company;
      if (l.title) props.jobtitle = l.title;
      if (l.website || l.domain) props.website = l.website || l.domain;
      if (l.linkedinUrl) props.hs_linkedinid = l.linkedinUrl;
      if (l.city) props.city = l.city;
      if (l.state) props.state = l.state;
      if (l.country) props.country = l.country;
      if (ownerId) props.hubspot_owner_id = ownerId;
      if (lifecycleStage) props.lifecyclestage = lifecycleStage;
      if (leadStatus) props.hs_lead_status = leadStatus;
      return { properties: props };
    }).filter(x => x.properties.email || x.properties.firstname);

    if (!inputs.length) { results.skipped += batch.length; continue; }

    const res = await fetch(`${HS_API}/crm/v3/objects/contacts/batch/create`, {
      method: "POST", headers: hsHdr(apiKey),
      body: JSON.stringify({ inputs }),
    });

    if (res.ok) {
      const data = await res.json();
      results.created += (data.results || []).length;
    } else {
      const errText = await res.text();
      // If some in batch conflict, fall back to one-by-one — only create, never update
      if (errText.includes("CONFLICT") || errText.includes("already exists")) {
        for (const input of inputs) {
          try {
            const single = await fetch(`${HS_API}/crm/v3/objects/contacts`, {
              method: "POST", headers: hsHdr(apiKey), body: JSON.stringify(input),
            });
            if (single.ok) results.created++;
            else {
              const sErr = await single.text();
              if (sErr.includes("CONFLICT") || sErr.includes("already exists")) results.alreadyExist++;
              else results.errors.push(sErr.slice(0, 100));
            }
          } catch (e) { results.errors.push(e.message); }
        }
      } else {
        console.error("[HUBSPOT] Batch create error:", errText.slice(0, 300));
        results.errors.push(errText.slice(0, 150));
      }
    }
  }
  return results;
}

// ─── ORPHAN REPAIR: find + fix tasks without contact associations ────
// DESIGN: Precision over recall. We'd rather leave an orphan unlinked than
// link it to the WRONG contact. Every decision is logged with its reasoning.
async function findOrphanedTasks(apiKey, baseId, opts = {}) {
  const { dateFrom, dateTo, subjectContains } = opts;
  const runId = Math.random().toString(36).slice(2, 10); // short ID for correlating logs
  const log = (msg, ...args) => console.log(`[orphan:${runId}] ${msg}`, ...args);
  const logErr = (msg, ...args) => console.error(`[orphan:${runId}] ${msg}`, ...args);

  const result = {
    runId,
    totalHubspotTasks: 0,
    orphanedTasks: 0,
    matchable: 0,
    unmatchable: 0,
    ambiguous: 0, // tasks that matched MULTIPLE leads — we skip these for safety
    pairs: [],
    unmatched: [],
    diagnostics: {
      airtableLeadsLoaded: 0,
      airtableTasksLoaded: 0,
      leadsWithEmail: 0,
      airtableTaskEmailMap: 0,
      hubspotTasksFetched: 0,
      hubspotTasksAlreadyLinked: 0,
      hubspotSearchPages: 0,
      emailLookupBatches: 0,
      contactsFoundInHubspot: 0,
    },
  };

  log(`Starting orphan scan. dateFrom=${dateFrom}, dateTo=${dateTo}, subjectContains=${subjectContains || "(any)"}`);

  // ─── Step 1: Load Airtable leads + tasks ───
  let leads = [];
  let airtableTasks = [];
  try {
    const fetchAllPages = async (table) => {
      const out = [];
      let offset;
      do {
        const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ""}`;
        const r = await fetch(url, { headers: atHdr });
        if (!r.ok) throw new Error(`Airtable ${table} fetch: ${r.status} ${await r.text().then(t => t.slice(0, 100))}`);
        const data = await r.json();
        out.push(...(data.records || []));
        offset = data.offset;
      } while (offset);
      return out;
    };
    [leads, airtableTasks] = await Promise.all([fetchAllPages("Leads"), fetchAllPages("Tasks")]);
  } catch (e) {
    logErr("Airtable fetch failed:", e.message);
    return { error: `Airtable fetch failed: ${e.message}`, runId };
  }
  result.diagnostics.airtableLeadsLoaded = leads.length;
  result.diagnostics.airtableTasksLoaded = airtableTasks.length;
  log(`Loaded ${leads.length} Airtable leads, ${airtableTasks.length} Airtable tasks`);

  // ─── Step 2: Build precise lookup structures ───
  // Key insight: to match an orphan safely, we need a UNIQUE identifier.
  // Use Airtable Task ID as the join key IF we already tracked HubSpot IDs (new tasks).
  // Otherwise, fall back to (Company + Full Lead Name) composite key.
  // Never use company alone or first name alone.

  // Build: leadName(lower) -> { email, leadId, company }
  const leadLookup = {}; // full name → lead data
  let leadsWithEmail = 0;
  leads.forEach(l => {
    const f = l.fields || {};
    const fullName = (f.Name || "").trim().toLowerCase();
    if (!fullName) return;
    const email = (f.Email || "").toLowerCase().trim();
    if (email) leadsWithEmail++;
    // If duplicate names exist across leads with DIFFERENT emails, track them as ambiguous
    if (leadLookup[fullName] && leadLookup[fullName].email !== email) {
      leadLookup[fullName].ambiguous = true;
    } else if (!leadLookup[fullName]) {
      leadLookup[fullName] = { email, leadId: l.id, company: (f.Company || "").trim() };
    }
  });
  result.diagnostics.leadsWithEmail = leadsWithEmail;

  // Build: airtableTaskKey -> { email, leadName, company, airtableTaskId, hubspotTaskId? }
  // Key = composite of company + scan target (lead name) — unique per (lead, task)
  const airtableTaskMap = {}; // compositeKey → task info
  const hubspotIdToAirtable = {}; // For tasks already tracked with HubSpot Task ID
  let mappedCount = 0;
  airtableTasks.forEach(t => {
    const f = t.fields || {};
    const company = (f.Company || "").trim();
    const scanTarget = (f["Scan Target"] || f["Lead Name"] || "").trim();
    const scanTargetLower = scanTarget.toLowerCase();
    if (!scanTargetLower) return;
    const leadInfo = leadLookup[scanTargetLower];
    if (!leadInfo || !leadInfo.email) return;
    if (leadInfo.ambiguous) return; // Skip — lead name appears on multiple leads with different emails

    const compositeKey = `${company.toLowerCase()}|${scanTargetLower}`;
    const existingHsId = (f["HubSpot Task ID"] || "").trim();

    // Track if we've already mapped this key — if multiple Airtable tasks share it, mark ambiguous
    if (airtableTaskMap[compositeKey]) {
      airtableTaskMap[compositeKey].ambiguous = true;
    } else {
      airtableTaskMap[compositeKey] = {
        email: leadInfo.email,
        leadName: scanTarget,
        company,
        airtableTaskId: t.id,
        taskRule: f["Task Rule"] || "",
        hubspotTaskId: existingHsId || null,
      };
      mappedCount++;
    }
    if (existingHsId) {
      hubspotIdToAirtable[existingHsId] = compositeKey;
    }
  });
  result.diagnostics.airtableTaskEmailMap = mappedCount;
  log(`Built ${mappedCount} (company|name) → email mappings. ${Object.keys(hubspotIdToAirtable).length} already-tracked HubSpot IDs.`);

  // ─── Step 3: Fetch HubSpot tasks in date range ───
  // Use ISO 8601 timestamps (HubSpot spec)
  const fromIso = dateFrom || new Date(Date.now() - 30 * 86400000).toISOString();
  const toIso = dateTo || new Date().toISOString();
  log(`Querying HubSpot tasks from ${fromIso} to ${toIso}${subjectContains ? `, subject contains "${subjectContains}"` : ""}`);

  const hubspotTasks = [];
  let after = undefined;
  let pageCount = 0;
  const MAX_PAGES = 50; // 5000 tasks — enough for reasonable clients

  while (pageCount < MAX_PAGES) {
    const searchBody = {
      filterGroups: [{
        filters: [
          { propertyName: "hs_createdate", operator: "GTE", value: fromIso },
          { propertyName: "hs_createdate", operator: "LTE", value: toIso },
        ],
      }],
      properties: ["hs_task_subject", "hs_task_body", "hs_createdate", "hubspot_owner_id"],
      limit: 100,
      sorts: [{ propertyName: "hs_createdate", direction: "DESCENDING" }],
    };
    if (after) searchBody.after = after;
    if (subjectContains) {
      searchBody.filterGroups[0].filters.push({
        propertyName: "hs_task_subject", operator: "CONTAINS_TOKEN", value: subjectContains,
      });
    }

    const res = await fetch(`${HS_API}/crm/v3/objects/tasks/search`, {
      method: "POST", headers: hsHdr(apiKey),
      body: JSON.stringify(searchBody),
    });

    if (res.status === 429) {
      // Rate limit — wait and retry same page (don't advance after/pageCount)
      log(`Rate limit hit on page ${pageCount + 1}, waiting 11s...`);
      await new Promise(r => setTimeout(r, 11000));
      continue; // after is unchanged, pageCount unchanged — we'll retry same page
    }
    if (!res.ok) {
      const err = await res.text();
      logErr("Task search failed:", res.status, err.slice(0, 300));
      return { error: `HubSpot task search failed (${res.status}): ${err.slice(0, 200)}`, runId, diagnostics: result.diagnostics };
    }
    const data = await res.json();
    const results = data.results || [];
    hubspotTasks.push(...results);
    pageCount++;
    after = data.paging?.next?.after;
    if (!after || results.length === 0) break;
    // Brief pause between pages to respect rate limits
    await new Promise(r => setTimeout(r, 150));
  }
  result.totalHubspotTasks = hubspotTasks.length;
  result.diagnostics.hubspotTasksFetched = hubspotTasks.length;
  result.diagnostics.hubspotSearchPages = pageCount;
  log(`Fetched ${hubspotTasks.length} HubSpot tasks across ${pageCount} pages`);

  if (hubspotTasks.length === 0) {
    log("No HubSpot tasks in date range — nothing to do");
    return result;
  }

  // ─── Step 4: Check associations for each HubSpot task ───
  const orphans = [];
  const alreadyLinkedSet = new Set();
  for (let i = 0; i < hubspotTasks.length; i += 100) {
    const batch = hubspotTasks.slice(i, i + 100);
    const inputs = batch.map(t => ({ id: t.id }));
    const assocRes = await fetch(`${HS_API}/crm/v4/associations/tasks/contacts/batch/read`, {
      method: "POST", headers: hsHdr(apiKey),
      body: JSON.stringify({ inputs }),
    });

    if (assocRes.status === 429) {
      log(`Rate limit on association read batch ${i / 100 + 1}, waiting 11s...`);
      await new Promise(r => setTimeout(r, 11000));
      i -= 100; // retry this batch
      continue;
    }

    if (!assocRes.ok) {
      const err = await assocRes.text();
      logErr(`Association batch read ${i / 100} failed:`, assocRes.status, err.slice(0, 200));
      // Don't fail hard — treat these as orphans (we just don't know)
      // Actually, SAFER to treat as linked so we don't over-associate on ambiguity
      batch.forEach(t => alreadyLinkedSet.add(String(t.id)));
      continue;
    }

    const assocData = await assocRes.json();
    // Response shape: { results: [{ from: { id }, to: [{ toObjectId, ... }] }, ...] }
    // Tasks with to: [] or missing from results → no contacts linked
    const linkedIds = new Set();
    (assocData.results || []).forEach(r => {
      const taskId = String(r.from?.id || "");
      const toCount = (r.to || []).length;
      if (taskId && toCount > 0) linkedIds.add(taskId);
    });
    batch.forEach(t => {
      const id = String(t.id);
      if (linkedIds.has(id)) {
        alreadyLinkedSet.add(id);
      } else {
        orphans.push(t);
      }
    });

    await new Promise(r => setTimeout(r, 150)); // respect rate limits
  }
  result.orphanedTasks = orphans.length;
  result.diagnostics.hubspotTasksAlreadyLinked = alreadyLinkedSet.size;
  log(`${orphans.length} orphans, ${alreadyLinkedSet.size} already have contact links`);

  if (orphans.length === 0) return result;

  // ─── Step 5: Match orphans precisely ───
  // Priority order:
  //   A) Exact HubSpot Task ID match (if we already tracked it in Airtable) → 100% confident
  //   B) Exact subject match to (Company — Task Rule) pattern → high confidence
  //   C) Fuzzy match using both Company AND Full Lead Name present in subject+body → medium
  //   D) Otherwise: unmatchable
  //
  // We SKIP (don't match) anything ambiguous (multiple candidates) to avoid wrong associations.

  // Pre-compute per-orphan matching
  const MATCH_METHOD = { TRACKED: "tracked_hubspot_id", EXACT_SUBJECT: "exact_subject", FUZZY: "fuzzy_company_name", NONE: "no_match", AMBIGUOUS: "ambiguous" };
  const orphanToMatch = {}; // hubspotId → { method, airtableTaskKey, email, reason }

  for (const orphan of orphans) {
    const orphanId = String(orphan.id);
    const subject = (orphan.properties?.hs_task_subject || "").trim();
    const body = (orphan.properties?.hs_task_body || "").trim();
    const combinedLower = (subject + " " + body).toLowerCase();

    // A) Tracked HubSpot Task ID?
    if (hubspotIdToAirtable[orphanId]) {
      const key = hubspotIdToAirtable[orphanId];
      const airtableInfo = airtableTaskMap[key];
      if (airtableInfo && !airtableInfo.ambiguous) {
        orphanToMatch[orphanId] = { method: MATCH_METHOD.TRACKED, airtableTaskKey: key, email: airtableInfo.email };
        continue;
      }
    }

    // B/C) Find all matching airtableTaskMap entries
    // EXACT: `${company} — ${taskRule}` (case-insensitive)
    // FUZZY: subject contains company AND combined contains full lead name (case-insensitive, word-boundary safe)
    const exactMatches = [];
    const fuzzyMatches = [];
    const subjectLower = subject.toLowerCase();

    for (const [key, info] of Object.entries(airtableTaskMap)) {
      if (info.ambiguous) continue; // skip multiple airtable tasks with same company|lead
      const company = info.company.toLowerCase();
      const leadName = info.leadName.toLowerCase();
      // Guard against dangerously short lead names (< 4 chars) — don't fuzzy-match those
      if (leadName.length < 4) continue;

      const taskRuleForMatch = (info.taskRule || "Task").toLowerCase();
      const expectedSubject = `${company} — ${taskRuleForMatch}`.trim();
      if (subjectLower === expectedSubject) {
        exactMatches.push({ key, info });
      } else {
        // Word-boundary match to avoid "Sam" matching "Sample"
        const leadNameRegex = new RegExp(`\\b${leadName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
        const companyInSubject = company.length >= 3 && subjectLower.includes(company);
        const leadInCombined = leadNameRegex.test(combinedLower);
        if (companyInSubject && leadInCombined) {
          fuzzyMatches.push({ key, info });
        }
      }
    }

    if (exactMatches.length === 1) {
      orphanToMatch[orphanId] = { method: MATCH_METHOD.EXACT_SUBJECT, airtableTaskKey: exactMatches[0].key, email: exactMatches[0].info.email };
    } else if (exactMatches.length > 1) {
      // Ambiguous exact match — check if they all resolve to SAME email (e.g. same person, two tasks)
      const uniqueEmails = [...new Set(exactMatches.map(m => m.info.email))];
      if (uniqueEmails.length === 1) {
        orphanToMatch[orphanId] = { method: MATCH_METHOD.EXACT_SUBJECT, airtableTaskKey: exactMatches[0].key, email: uniqueEmails[0] };
      } else {
        orphanToMatch[orphanId] = { method: MATCH_METHOD.AMBIGUOUS, reason: `Subject "${subject}" matches ${exactMatches.length} Airtable tasks with different emails` };
      }
    } else if (fuzzyMatches.length === 1) {
      orphanToMatch[orphanId] = { method: MATCH_METHOD.FUZZY, airtableTaskKey: fuzzyMatches[0].key, email: fuzzyMatches[0].info.email };
    } else if (fuzzyMatches.length > 1) {
      const uniqueEmails = [...new Set(fuzzyMatches.map(m => m.info.email))];
      if (uniqueEmails.length === 1) {
        orphanToMatch[orphanId] = { method: MATCH_METHOD.FUZZY, airtableTaskKey: fuzzyMatches[0].key, email: uniqueEmails[0] };
      } else {
        orphanToMatch[orphanId] = { method: MATCH_METHOD.AMBIGUOUS, reason: `Fuzzy match hit ${fuzzyMatches.length} leads with different emails — skipping for safety` };
      }
    } else {
      orphanToMatch[orphanId] = { method: MATCH_METHOD.NONE };
    }
  }

  // Log match method distribution
  const byMethod = { tracked: 0, exact: 0, fuzzy: 0, ambiguous: 0, none: 0 };
  Object.values(orphanToMatch).forEach(m => {
    if (m.method === MATCH_METHOD.TRACKED) byMethod.tracked++;
    else if (m.method === MATCH_METHOD.EXACT_SUBJECT) byMethod.exact++;
    else if (m.method === MATCH_METHOD.FUZZY) byMethod.fuzzy++;
    else if (m.method === MATCH_METHOD.AMBIGUOUS) byMethod.ambiguous++;
    else byMethod.none++;
  });
  log(`Match methods: ${byMethod.tracked} tracked, ${byMethod.exact} exact-subject, ${byMethod.fuzzy} fuzzy, ${byMethod.ambiguous} ambiguous (skipped), ${byMethod.none} no match`);
  result.ambiguous = byMethod.ambiguous;

  // ─── Step 6: Batch-search HubSpot contacts by matched emails ───
  const uniqueEmails = [...new Set(Object.values(orphanToMatch).filter(m => m.email).map(m => m.email))];
  log(`${uniqueEmails.length} unique emails to search in HubSpot contacts`);

  const emailToContactId = {};
  const emailSearchErrors = [];
  for (let i = 0; i < uniqueEmails.length; i += 100) {
    const emailBatch = uniqueEmails.slice(i, i + 100);
    result.diagnostics.emailLookupBatches++;

    const searchRes = await fetch(`${HS_API}/crm/v3/objects/contacts/search`, {
      method: "POST", headers: hsHdr(apiKey),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "email", operator: "IN", values: emailBatch }] }],
        properties: ["email"],
        limit: 100,
      }),
    });

    if (searchRes.status === 429) {
      log(`Rate limit on contact search batch ${i / 100 + 1}, waiting 11s...`);
      await new Promise(r => setTimeout(r, 11000));
      i -= 100;
      continue;
    }
    if (!searchRes.ok) {
      const err = await searchRes.text();
      logErr(`Contact search batch failed:`, searchRes.status, err.slice(0, 200));
      emailSearchErrors.push(err.slice(0, 100));
      continue;
    }
    const data = await searchRes.json();
    (data.results || []).forEach(c => {
      const em = (c.properties?.email || "").toLowerCase().trim();
      if (em) emailToContactId[em] = c.id;
    });
    await new Promise(r => setTimeout(r, 150));
  }
  result.diagnostics.contactsFoundInHubspot = Object.keys(emailToContactId).length;
  log(`Found ${Object.keys(emailToContactId).length} of ${uniqueEmails.length} emails as HubSpot contacts`);

  // ─── Step 7: Build final pairs, with full diagnostics ───
  for (const orphan of orphans) {
    const orphanId = String(orphan.id);
    const subject = orphan.properties?.hs_task_subject || "(no subject)";
    const match = orphanToMatch[orphanId];

    if (match.method === MATCH_METHOD.AMBIGUOUS) {
      result.unmatched.push({ taskId: orphanId, taskSubject: subject, reason: `⚠️ Ambiguous: ${match.reason}` });
      result.unmatchable++;
      continue;
    }
    if (match.method === MATCH_METHOD.NONE) {
      result.unmatched.push({ taskId: orphanId, taskSubject: subject, reason: "Couldn't match to any Airtable lead (no lead with matching company + name found)" });
      result.unmatchable++;
      continue;
    }

    const contactId = emailToContactId[match.email];
    if (!contactId) {
      result.unmatched.push({
        taskId: orphanId,
        taskSubject: subject,
        reason: `Matched to lead (${match.email}) via ${match.method}, but contact not in HubSpot — upload leads first`,
      });
      result.unmatchable++;
      continue;
    }

    const airtableInfo = airtableTaskMap[match.airtableTaskKey];
    result.pairs.push({
      taskId: orphanId,
      taskSubject: subject,
      contactId,
      contactEmail: match.email,
      leadName: airtableInfo?.leadName || "",
      company: airtableInfo?.company || "",
      matchMethod: match.method,
      airtableTaskId: airtableInfo?.airtableTaskId || null,
    });
    result.matchable++;
  }

  log(`FINAL: ${result.matchable} matchable, ${result.unmatchable} unmatchable (incl. ${result.ambiguous} ambiguous skipped for safety)`);
  if (emailSearchErrors.length > 0) {
    result.warnings = [`${emailSearchErrors.length} email search batches had errors — some contacts may have been missed`];
  }

  return result;
}

async function repairOrphanedTasks(apiKey, pairs, baseId) {
  const runId = Math.random().toString(36).slice(2, 10);
  const log = (msg, ...args) => console.log(`[repair:${runId}] ${msg}`, ...args);
  const logErr = (msg, ...args) => console.error(`[repair:${runId}] ${msg}`, ...args);

  const result = {
    runId,
    repaired: 0,
    failed: 0,
    partialFailures: [],
    errors: [],
    auditLog: [], // [{ taskId, contactId, success, reason }]
  };

  if (!pairs || pairs.length === 0) {
    return { ...result, error: "No pairs provided" };
  }

  log(`Starting repair: ${pairs.length} task→contact associations to create`);

  // Sanity check: every pair must have both IDs as non-empty strings
  const validPairs = pairs.filter(p => {
    const ok = p.taskId && p.contactId && typeof p.taskId === "string" && typeof p.contactId === "string";
    if (!ok) {
      logErr("Invalid pair skipped:", JSON.stringify(p).slice(0, 150));
      result.auditLog.push({ taskId: p.taskId || null, contactId: p.contactId || null, success: false, reason: "Invalid pair (missing IDs)" });
      result.failed++;
    }
    return ok;
  });

  if (validPairs.length === 0) {
    return { ...result, error: "All pairs were invalid" };
  }

  // Use HubSpot v4 batch/create — CORRECT payload shape is { from: { id }, to: { id }, types: [...] }
  // (Not _from — _from is only in v4 READ responses)
  // Track whether we should use the v3 "default" association (fallback if v4 typeId 204 fails)
  // HubSpot v3 /crm/v3/objects/tasks/{taskId}/associations/contacts/{contactId}/{type} uses named types
  // which is more reliable but slower (one call per association, no batching).
  let useV4 = true;

  for (let i = 0; i < validPairs.length; i += 100) {
    const batch = validPairs.slice(i, i + 100);

    if (useV4) {
      // Fast path: v4 batch create with typeId 204 (HUBSPOT_DEFINED task→contact)
      const inputs = batch.map(p => ({
        from: { id: String(p.taskId) },
        to: { id: String(p.contactId) },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 204 }],
      }));

      const res = await fetch(`${HS_API}/crm/v4/associations/tasks/contacts/batch/create`, {
        method: "POST", headers: hsHdr(apiKey),
        body: JSON.stringify({ inputs }),
      });

      if (res.status === 429) {
        log(`Rate limit on repair batch ${i / 100 + 1}, waiting 11s...`);
        await new Promise(r => setTimeout(r, 11000));
        i -= 100;
        continue;
      }

      const respText = await res.text();
      let respJson = null;
      try { respJson = JSON.parse(respText); } catch {}

      // If first batch fails with "invalid type" or similar, fall back to v3 default associations
      if (!res.ok && i === 0 && (respText.includes("ASSOCIATION_TYPE") || respText.includes("invalid") || respText.includes("type") || res.status === 400)) {
        logErr(`v4 batch association failed (status ${res.status}), falling back to v3 default associations. Error: ${respText.slice(0, 250)}`);
        useV4 = false;
        i -= 100; // retry this batch via v3 path
        continue;
      }

      if (res.status === 207 || (res.ok && respJson?.numErrors > 0)) {
        const results = respJson?.results || [];
        const errors = respJson?.errors || [];
        result.repaired += results.length;
        batch.slice(0, results.length).forEach((p) => {
          result.auditLog.push({ taskId: p.taskId, contactId: p.contactId, success: true, method: p.matchMethod });
        });
        errors.forEach((err, idx) => {
          const p = batch[results.length + idx];
          result.partialFailures.push({ taskId: p?.taskId, contactId: p?.contactId, error: err.message || JSON.stringify(err).slice(0, 200) });
          result.auditLog.push({ taskId: p?.taskId, contactId: p?.contactId, success: false, reason: err.message || "partial failure" });
          result.failed++;
        });
        logErr(`Batch ${i / 100 + 1}: ${results.length} succeeded, ${errors.length} partial failures`);
      } else if (res.ok) {
        const results = respJson?.results || [];
        result.repaired += results.length;
        if (results.length !== batch.length) {
          logErr(`Batch ${i / 100 + 1}: submitted ${batch.length}, got ${results.length} back — unexpected`);
        }
        batch.forEach(p => {
          result.auditLog.push({ taskId: p.taskId, contactId: p.contactId, success: true, method: p.matchMethod });
        });
        log(`Batch ${i / 100 + 1}: ${results.length} associations created via v4`);
      } else {
        logErr(`Batch ${i / 100 + 1} FAILED:`, res.status, respText.slice(0, 400));
        const errMsg = respJson?.message || respText.slice(0, 250);
        result.errors.push(`Batch ${i / 100 + 1} (${res.status}): ${errMsg}`);
        result.failed += batch.length;
        batch.forEach(p => {
          result.auditLog.push({ taskId: p.taskId, contactId: p.contactId, success: false, reason: `Batch failed: ${errMsg.slice(0, 150)}` });
        });
      }
    } else {
      // Fallback path: v3 one-by-one with named "task_to_contact" type
      // Endpoint: PUT /crm/v3/objects/tasks/{taskId}/associations/contacts/{contactId}/task_to_contact
      log(`Using v3 one-by-one associations for batch ${i / 100 + 1} (${batch.length} pairs)`);
      let batchSucc = 0;
      let batchFail = 0;
      for (const p of batch) {
        try {
          const res = await fetch(
            `${HS_API}/crm/v3/objects/tasks/${encodeURIComponent(p.taskId)}/associations/contacts/${encodeURIComponent(p.contactId)}/task_to_contact`,
            { method: "PUT", headers: hsHdr(apiKey) }
          );
          if (res.ok) {
            result.repaired++;
            batchSucc++;
            result.auditLog.push({ taskId: p.taskId, contactId: p.contactId, success: true, method: p.matchMethod + " (v3)" });
          } else {
            const err = await res.text();
            result.partialFailures.push({ taskId: p.taskId, contactId: p.contactId, error: `${res.status}: ${err.slice(0, 150)}` });
            result.auditLog.push({ taskId: p.taskId, contactId: p.contactId, success: false, reason: `v3: ${res.status} ${err.slice(0, 100)}` });
            result.failed++;
            batchFail++;
          }
          // Rate limit: v3 is one-by-one, pace ourselves
          await new Promise(r => setTimeout(r, 120));
        } catch (e) {
          logErr(`v3 association exception for task ${p.taskId}:`, e.message);
          result.partialFailures.push({ taskId: p.taskId, contactId: p.contactId, error: e.message });
          result.auditLog.push({ taskId: p.taskId, contactId: p.contactId, success: false, reason: e.message });
          result.failed++;
          batchFail++;
        }
      }
      log(`v3 batch ${i / 100 + 1}: ${batchSucc} succeeded, ${batchFail} failed`);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // Optionally: write HubSpot Task IDs back to Airtable tasks (for pairs that had airtableTaskId)
  if (baseId) {
    const toSync = pairs.filter(p => p.airtableTaskId && p.taskId);
    if (toSync.length > 0) {
      log(`Syncing ${toSync.length} HubSpot IDs back to Airtable tasks...`);
      const nowISO = new Date().toISOString();
      const updates = toSync.map(p => ({
        id: p.airtableTaskId,
        fields: { "HubSpot Task ID": String(p.taskId), "HubSpot Last Synced": nowISO },
      }));
      let synced = 0;
      for (let i = 0; i < updates.length; i += 10) {
        const batch = updates.slice(i, i + 10);
        try {
          const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}`, {
            method: "PATCH", headers: atHdr,
            body: JSON.stringify({ records: batch }),
          });
          if (r.ok) synced += batch.length;
          else {
            const err = await r.text();
            logErr(`Airtable sync batch ${i / 10} failed:`, err.slice(0, 200));
          }
        } catch (e) { logErr("Airtable sync exception:", e.message); }
      }
      result.airtableSynced = synced;
      log(`Airtable sync done: ${synced}/${updates.length}`);
    }
  }

  log(`REPAIR COMPLETE: ${result.repaired} repaired, ${result.failed} failed`);
  return result;
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
        return NextResponse.json({ hasKey: !!key, maskedKey: key ? "****" + key.slice(-4) : null, rawKey: key || null });
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
        const { tasks, config, baseId } = body;
        if (!tasks?.length) return NextResponse.json({ error: "No tasks to push" }, { status: 400 });
        const result = await createTasks(apiKey, tasks, config || {});

        // Persist HubSpot Task IDs back to Airtable tasks so future pushes can UPDATE instead of CREATE
        if (baseId && Object.keys(result.airtableToHubspotMap).length > 0) {
          const nowISO = new Date().toISOString();
          const updates = Object.entries(result.airtableToHubspotMap).map(([airtableId, hsId]) => ({
            id: airtableId,
            fields: { "HubSpot Task ID": String(hsId), "HubSpot Last Synced": nowISO },
          }));

          // Batch update in groups of 10 (Airtable limit) with auto-heal for missing fields
          const attemptUpdate = async (batch, attempt = 0) => {
            const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}`, {
              method: "PATCH", headers: atHdr,
              body: JSON.stringify({ records: batch }),
            });
            if (r.ok) return true;
            const errText = await r.text();
            if (attempt < 3 && (errText.includes("INVALID_VALUE_FOR_COLUMN") || errText.includes("UNKNOWN_FIELD_NAME"))) {
              const m1 = errText.match(/Field\s+\\?"([^"\\]+)\\?"/);
              const m2 = errText.match(/[Uu]nknown field name:?\s+\\?"([^"\\]+)\\?"/);
              const badField = (m1 && m1[1]) || (m2 && m2[1]);
              if (badField) {
                console.log(`[push_tasks] Creating missing field ${badField} on Tasks`);
                try {
                  const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: atHdr });
                  if (tablesRes.ok) {
                    const { tables } = await tablesRes.json();
                    const tasksTable = tables.find(t => t.name === "Tasks");
                    if (tasksTable) {
                      await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${tasksTable.id}/fields`, {
                        method: "POST", headers: atHdr,
                        body: JSON.stringify({ name: badField, type: "singleLineText" }),
                      });
                      await new Promise(r => setTimeout(r, 1500));
                      return attemptUpdate(batch, attempt + 1);
                    }
                  }
                } catch (e) { console.error("Field create failed:", e.message); }
              }
            }
            console.error(`[push_tasks] Airtable sync failed:`, errText.slice(0, 300));
            return false;
          };

          let syncedCount = 0;
          for (let i = 0; i < updates.length; i += 10) {
            const batch = updates.slice(i, i + 10);
            if (await attemptUpdate(batch)) syncedCount += batch.length;
          }
          result.airtableSynced = syncedCount;
          console.log(`[push_tasks] Synced ${syncedCount} HubSpot IDs back to Airtable`);
        }

        // Don't send the full map back (could be huge), just summary counts
        delete result.airtableToHubspotMap;
        return NextResponse.json(result);
      }

      case "search_contacts": {
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const contacts = await searchContacts(apiKey, body.query);
        return NextResponse.json({ contacts });
      }

      case "push_leads": {
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const { leads, config } = body;
        if (!leads?.length) return NextResponse.json({ error: "No leads to push" }, { status: 400 });
        const result = await pushLeads(apiKey, leads, config || {});
        return NextResponse.json(result);
      }

      case "find_orphaned_tasks": {
        // Preview: find HubSpot tasks created by SignalScope that have no contact association
        // Filters by optional date range + subject pattern
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const { baseId, dateFrom, dateTo, subjectContains } = body;
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });

        const result = await findOrphanedTasks(apiKey, baseId, { dateFrom, dateTo, subjectContains });
        return NextResponse.json(result);
      }

      case "repair_orphaned_tasks": {
        // Execute: for each orphaned task with a matching contact in HubSpot, create association
        const apiKey = body.apiKey || await getStoredKey(campaignId);
        if (!apiKey) return NextResponse.json({ error: "No API key" }, { status: 400 });
        const { taskContactPairs, baseId } = body;
        // taskContactPairs: [{ taskId, contactId, airtableId? }]
        if (!Array.isArray(taskContactPairs) || taskContactPairs.length === 0) {
          return NextResponse.json({ error: "taskContactPairs required (non-empty array)" }, { status: 400 });
        }

        const result = await repairOrphanedTasks(apiKey, taskContactPairs, baseId);
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("[HUBSPOT] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
