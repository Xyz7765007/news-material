// ─── Lead Movement Scan Endpoint ────────────────────────────────────
//
// Scans leads via RapidAPI Fresh LinkedIn Profile Data, detects job
// movement (Hired / Promoted / Exited), creates Tasks, updates Lead
// records with current state.
//
// MODES (action param):
//   "preview": Returns cost estimate + lead count, no API calls made.
//   "scan":    Processes one chunk of leads (default 200). Returns
//              cumulative results so the UI can render progress.
//              Pass cursor (next-page offset) to continue paginated scan.
//
// REQUEST BODY:
//   {
//     action: "preview" | "scan",
//     baseId: string,                  // campaign base ID
//     campaignId: string,              // master Campaigns record ID
//     movementWindowDays: number,      // default 90
//     freshnessSkipDays: number,       // skip leads checked within N days, default 7
//     batchSize: number,               // chunk size, default 200
//     cursor: string,                  // continuation offset (Airtable pagination)
//     concurrency: number,             // parallel RapidAPI calls, default 8
//   }
//
// RESPONSE (scan):
//   {
//     ok: true,
//     processed: { total, hired, promoted, exited, none, stale, unavailable },
//     tasksCreated: number,
//     costUSD: number,
//     errors: string[],
//     nextCursor: string | null,       // null when done
//     done: bool,
//   }
//
// ARCHITECTURE NOTES:
//   - Chunked execution: each request processes batchSize leads, returns,
//     UI calls again with nextCursor. Fits Hobby's 300s timeout for any
//     reasonable batchSize (200 leads × ~500ms ≈ 100s).
//   - Freshness skip: leads checked within N days are skipped (saves cost
//     on repeat runs). Set freshnessSkipDays=0 to force full re-scan.
//   - Concurrency 8 inside each batch — Promise.all over slices.
//   - Cost tracking: batched at end of each batch (one PATCH per batch
//     instead of per-call).

import { NextResponse } from "next/server";
import { fetchLinkedInProfile } from "@/lib/linkedin-fetch";
import { classifyMovement, buildTaskFromMovement, buildLeadUpdateFields } from "@/lib/movement-detection";
import { trackRapidAPIUsageBatch, getRapidAPICost, ensureRapidAPIUsageFields } from "@/lib/rapidapi-usage";
import { pickLeadField } from "@/lib/lead-fields";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // give chunked scans enough budget

const AT_API = "https://api.airtable.com/v0";
const atHdr = () => ({
  Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
});

// ─── Airtable helpers ──────────────────────────────────────────────
async function listLeads(baseId, { pageSize = 100, offset = null, filterByFormula = null } = {}) {
  const params = new URLSearchParams();
  params.set("pageSize", String(pageSize));
  if (offset) params.set("offset", offset);
  if (filterByFormula) params.set("filterByFormula", filterByFormula);
  const url = `${AT_API}/${baseId}/Leads?${params.toString()}`;
  const res = await fetch(url, { headers: atHdr() });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Airtable list Leads failed: ${res.status} ${errText.slice(0, 200)}`);
  }
  return await res.json();
}

async function listAccounts(baseId) {
  // Walk all pages
  const all = [];
  let offset = null;
  do {
    const params = new URLSearchParams();
    params.set("pageSize", "100");
    if (offset) params.set("offset", offset);
    const url = `${AT_API}/${baseId}/Accounts?${params.toString()}`;
    const res = await fetch(url, { headers: atHdr() });
    if (!res.ok) break;
    const data = await res.json();
    all.push(...(data.records || []));
    offset = data.offset || null;
  } while (offset);
  return all;
}

async function createTasksBatch(baseId, taskFieldsArray) {
  if (!taskFieldsArray.length) return { created: 0, errors: [], droppedFields: [] };
  const errors = [];
  let created = 0;
  // Self-heal against missing schema fields. If Veloka's (or any other
  // campaign's) Tasks table is missing a field that buildTaskFromMovement
  // writes — most commonly `Movement Type`, `Lead Title`, or `URL` —
  // the entire batch used to die silently with 422. Now we parse the
  // unknown field name from Airtable's error, strip it from every record,
  // and retry. Mirrors the rebuild endpoint's pattern. Loop caps at 8
  // iterations (task has ~17 fields total, so 8 is more than enough).
  const knownMissingFields = new Set();

  for (let i = 0; i < taskFieldsArray.length; i += 10) {
    const baseSlice = taskFieldsArray.slice(i, i + 10);
    let slice = baseSlice.map(f => {
      const filtered = { ...f };
      for (const k of knownMissingFields) delete filtered[k];
      return filtered;
    });

    let attempts = 0;
    let succeeded = false;
    while (attempts < 8 && !succeeded) {
      attempts++;
      const url = `${AT_API}/${baseId}/Tasks`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: atHdr(),
          // typecast: true — Airtable coerces field types instead of erroring
          // (e.g. accepts a string for a number field). Belt-and-suspenders
          // alongside the auto-heal. Doesn't help with UNKNOWN_FIELD_NAME —
          // for that the loop below handles it.
          body: JSON.stringify({ records: slice.map(f => ({ fields: f })), typecast: true }),
        });
        if (res.ok) {
          const data = await res.json();
          created += (data.records || []).length;
          succeeded = true;
          break;
        }
        const errText = await res.text().catch(() => "");
        if (res.status === 422) {
          // Parse the missing field from Airtable's response.
          //   { "error": { "type": "UNKNOWN_FIELD_NAME", "message": "Unknown field name: \"Movement Type\"" } }
          let missingField = null;
          try {
            const parsed = JSON.parse(errText);
            const message = parsed?.error?.message || parsed?.message || "";
            const match = message.match(/Unknown field name:?\s*["']([^"']+)["']/i);
            if (match) missingField = match[1];
          } catch { /* fall through */ }

          if (missingField && !knownMissingFields.has(missingField)) {
            knownMissingFields.add(missingField);
            console.warn(`[scan-leads] auto-healing: Tasks table missing "${missingField}" — dropping from payload and retrying`);
            slice = slice.map(f => {
              const filtered = { ...f };
              delete filtered[missingField];
              return filtered;
            });
            continue;
          }
          // 422 we can't parse → loud log + give up on this batch
          console.error(`[scan-leads] createTasks 422 (unparseable): ${errText.slice(0, 400)}`);
          console.error(`[scan-leads] failed payload sample:`, JSON.stringify(slice[0]).slice(0, 500));
          errors.push(`createTasks 422 (unparseable): ${errText.slice(0, 200)}`);
          break;
        }
        // Non-422 — log loudly, no retry
        console.error(`[scan-leads] createTasks FAILED (slice ${i}-${i+slice.length-1}): HTTP ${res.status}: ${errText.slice(0, 400)}`);
        errors.push(`createTasks ${res.status}: ${errText.slice(0, 200)}`);
        break;
      } catch (e) {
        console.error(`[scan-leads] createTasks THREW (slice ${i}): ${e.message}`);
        errors.push(`createTasks threw: ${e.message}`);
        break;
      }
    }
  }
  if (knownMissingFields.size > 0) {
    console.warn(`[scan-leads] dropped fields from Tasks (run setup-fix to add): ${Array.from(knownMissingFields).join(", ")}`);
  }
  return { created, errors, droppedFields: Array.from(knownMissingFields) };
}

async function updateLeadsBatch(baseId, leadUpdates) {
  // leadUpdates: [{ id, fields }, ...]
  if (!leadUpdates.length) return { updated: 0, errors: [] };
  const errors = [];
  let updated = 0;
  for (let i = 0; i < leadUpdates.length; i += 10) {
    const slice = leadUpdates.slice(i, i + 10);
    const url = `${AT_API}/${baseId}/Leads`;
    try {
      const res = await fetch(url, {
        method: "PATCH",
        headers: atHdr(),
        body: JSON.stringify({ records: slice }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        errors.push(`updateLeads ${res.status}: ${errText.slice(0, 200)}`);
        continue;
      }
      const data = await res.json();
      updated += (data.records || []).length;
    } catch (e) {
      errors.push(`updateLeads threw: ${e.message}`);
    }
  }
  return { updated, errors };
}

// ─── Pre-flight: ensure schema exists ─────────────────────────────
// CRITICAL: Airtable's filterByFormula will throw 422 if it references
// a field that doesn't exist yet. Before any filtered query, we must
// ensure all Lead Movement fields are created on the Leads table.
//
// We also create the Movement Type field on Tasks (needed before any
// task insert) and the RapidAPI cost-tracking fields on Campaigns.
async function ensureSchemaForLeadMovement(baseId) {
  const errors = [];

  // Fetch the current schema
  let schema;
  try {
    const res = await fetch(`${AT_API}/meta/bases/${baseId}/tables`, { headers: atHdr() });
    if (!res.ok) {
      errors.push(`schema fetch ${res.status}`);
      return { ok: false, errors };
    }
    schema = await res.json();
  } catch (e) {
    errors.push(`schema fetch threw: ${e.message}`);
    return { ok: false, errors };
  }

  const tables = schema.tables || [];
  const findTable = (name) => tables.find(t => t.name === name);

  // Helper to add a missing field
  async function ensureField(tableId, existing, fieldDef) {
    if (existing.has(fieldDef.name)) return { skipped: true };
    try {
      const res = await fetch(`${AT_API}/meta/bases/${baseId}/tables/${tableId}/fields`, {
        method: "POST",
        headers: atHdr(),
        body: JSON.stringify(fieldDef),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        errors.push(`create field "${fieldDef.name}" on ${tableId}: ${res.status} ${errText.slice(0, 120)}`);
        return { failed: true };
      }
      return { created: true };
    } catch (e) {
      errors.push(`create field "${fieldDef.name}" threw: ${e.message}`);
      return { failed: true };
    }
  }

  // ─── Leads table ──────────────────────────────────────────
  const leadsTable = findTable("Leads");
  if (!leadsTable) {
    errors.push("Leads table not found in base");
    return { ok: false, errors };
  }
  const leadsExisting = new Set((leadsTable.fields || []).map(f => f.name));
  const leadsRequired = [
    { name: "Current Company",          type: "singleLineText" },
    { name: "Current Job Title",        type: "singleLineText" },
    { name: "Current Role Started At",  type: "singleLineText" },
    { name: "Days In Current Role",     type: "number", options: { precision: 0 } },
    { name: "Previous Company",         type: "singleLineText" },
    { name: "Previous Job Title",       type: "singleLineText" },
    { name: "Last LinkedIn Check",      type: "singleLineText" },
    { name: "Movement Detected",        type: "singleLineText" },
  ];
  for (const f of leadsRequired) {
    await ensureField(leadsTable.id, leadsExisting, f);
  }

  // ─── Tasks table ──────────────────────────────────────────
  // CRITICAL: Every field that buildTaskFromMovement (in lib/movement-detection.js)
  // writes MUST be ensured here. If even ONE is missing, Airtable returns 422
  // UNKNOWN_FIELD_NAME and the entire batch's tasks fail silently (caught by
  // createTasksBatch, pushed to errors array, but the counter still ticks up
  // because the movement WAS detected). Symptom: chatbot's Promoted Count
  // shows 2 but Airtable's Tasks table has 0 new records.
  //
  // Updated 2026-05-21 after user reported this exact silent-fail pattern.
  // Previously only "Movement Type" was ensured.
  const tasksTable = findTable("Tasks");
  if (tasksTable) {
    const tasksExisting = new Set((tasksTable.fields || []).map(f => f.name));
    const tasksRequired = [
      { name: "Name",          type: "singleLineText" },
      { name: "Company",       type: "singleLineText" },
      { name: "Task Rule",     type: "singleLineText" },
      { name: "Movement Type", type: "singleLineText" },
      { name: "Score",         type: "number", options: { precision: 0 } },
      { name: "Score Reason",  type: "multilineText" },
      { name: "Scan Target",   type: "singleLineText" },
      { name: "Signal",        type: "multilineText" },
      { name: "Source",        type: "singleLineText" },
      { name: "Lead Title",    type: "singleLineText" },
      { name: "LinkedIn URL",  type: "url" },
      { name: "Email",         type: "email" },
      { name: "Phone",         type: "phoneNumber" },
    ];
    for (const f of tasksRequired) {
      await ensureField(tasksTable.id, tasksExisting, f);
    }
  } else {
    errors.push("Tasks table not found in base — movement scan tasks have nowhere to land. Run setup-fix to create it.");
  }

  return { ok: errors.length === 0, errors };
}


// Skip leads checked within freshnessSkipDays AND/OR filter by Campaign Tag.
// Use Airtable's filterByFormula to push these down to the server (saves
// transferring already-fresh or non-matching leads to memory).
//
// Both filters are optional and ANDed together when both present.
//   - campaignTag: string | null   (null/empty = include all tags)
//   - freshnessSkipDays: number    (0 or null = no freshness filter)
function buildLeadsFilter({ freshnessSkipDays, campaignTag }) {
  const parts = [];

  if (freshnessSkipDays && freshnessSkipDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - freshnessSkipDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    parts.push(`OR({Last LinkedIn Check} = '', {Last LinkedIn Check} < '${cutoffStr}')`);
  }

  if (campaignTag && typeof campaignTag === "string" && campaignTag.trim() !== "") {
    // Escape single quotes in tag value for safety
    const safe = campaignTag.replace(/'/g, "\\'");
    parts.push(`{Campaign Tag} = '${safe}'`);
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `AND(${parts.join(", ")})`;
}

// ─── Preview: count + cost estimate ────────────────────────────────
async function handlePreview({ baseId, campaignId, freshnessSkipDays, campaignTag }) {
  // Pre-flight: ensure schema exists before any filtered query.
  // (Airtable returns 422 if filterByFormula references a missing field.)
  const schemaResult = await ensureSchemaForLeadMovement(baseId);
  if (schemaResult.errors.length > 0) {
    console.warn("[lead-movement preview] schema setup errors:", schemaResult.errors);
    // Continue anyway — some errors are non-fatal (e.g. field already exists race)
  }

  // Walk all pages to get total count (cheap — just one field)
  // Note: Airtable does not provide a count endpoint; we paginate.
  let totalToScan = 0;
  let totalAll = 0;
  let totalInTag = 0;
  let offset = null;
  const filter = buildLeadsFilter({ freshnessSkipDays, campaignTag });

  // Count ALL leads (for "total leads in base" UI display)
  do {
    const params = new URLSearchParams();
    params.set("pageSize", "100");
    params.set("fields[]", "Name");
    if (offset) params.set("offset", offset);
    const url = `${AT_API}/${baseId}/Leads?${params.toString()}`;
    const res = await fetch(url, { headers: atHdr() });
    if (!res.ok) {
      return { ok: false, error: `Could not list leads: ${res.status}` };
    }
    const data = await res.json();
    totalAll += (data.records || []).length;
    offset = data.offset || null;
  } while (offset);

  // If a tag is selected, count leads in that tag (ignoring freshness)
  if (campaignTag) {
    const tagOnlyFilter = buildLeadsFilter({ freshnessSkipDays: 0, campaignTag });
    offset = null;
    do {
      const params = new URLSearchParams();
      params.set("pageSize", "100");
      params.set("fields[]", "Name");
      if (tagOnlyFilter) params.set("filterByFormula", tagOnlyFilter);
      if (offset) params.set("offset", offset);
      const url = `${AT_API}/${baseId}/Leads?${params.toString()}`;
      const res = await fetch(url, { headers: atHdr() });
      if (!res.ok) break;
      const data = await res.json();
      totalInTag += (data.records || []).length;
      offset = data.offset || null;
    } while (offset);
  } else {
    totalInTag = totalAll;
  }

  // Count leads to actually scan (with full filter: freshness AND tag)
  if (!filter) {
    totalToScan = totalAll;
  } else {
    offset = null;
    do {
      const params = new URLSearchParams();
      params.set("pageSize", "100");
      params.set("fields[]", "Name");
      params.set("filterByFormula", filter);
      if (offset) params.set("offset", offset);
      const url = `${AT_API}/${baseId}/Leads?${params.toString()}`;
      const res = await fetch(url, { headers: atHdr() });
      if (!res.ok) break;
      const data = await res.json();
      totalToScan += (data.records || []).length;
      offset = data.offset || null;
    } while (offset);
  }

  const perCallCost = await getRapidAPICost(campaignId);
  const estimatedCostUSD = totalToScan * perCallCost;

  return {
    ok: true,
    totalLeadsInBase: totalAll,
    leadsInSelectedTag: totalInTag,
    leadsToScan: totalToScan,
    leadsSkippedAsFresh: totalInTag - totalToScan,
    perCallCostUSD: perCallCost,
    estimatedCostUSD: Math.round(estimatedCostUSD * 100) / 100,
    campaignTag: campaignTag || null,
  };
}

// ─── Main scan: process one chunk ──────────────────────────────────
async function handleScan({
  baseId,
  campaignId,
  movementWindowDays,
  freshnessSkipDays,
  campaignTag,
  batchSize,
  cursor,
  concurrency,
}) {
  const errors = [];
  const processed = { total: 0, hired: 0, promoted: 0, exited: 0, none: 0, stale: 0, unavailable: 0 };
  const errorTallies = {}; // error code → count, surfaced in batch summary
  const tasksToCreate = [];
  const leadsToUpdate = [];

  // Pre-flight: ensure all required schema exists. CRITICAL — without this,
  // filterByFormula on Last LinkedIn Check will 422 on first-ever scan.
  const schemaResult = await ensureSchemaForLeadMovement(baseId);
  if (schemaResult.errors.length > 0) {
    console.warn("[lead-movement scan] schema setup errors:", schemaResult.errors);
    // Don't fail the scan — schema errors are usually benign races,
    // but surface them so user knows
    errors.push(...schemaResult.errors.slice(0, 5));
  }

  // Ensure RapidAPI tracking fields exist (one-time per cold start)
  await ensureRapidAPIUsageFields().catch(() => {});

  // Fetch accounts ONCE for follow-the-person matching
  let accountNames = [];
  try {
    const accounts = await listAccounts(baseId);
    accountNames = accounts.map(a => a.fields?.Name).filter(Boolean);
  } catch (e) {
    errors.push(`listAccounts failed: ${e.message}`);
  }

  // Fetch one page of leads (within freshness + tag filter)
  const filter = buildLeadsFilter({ freshnessSkipDays, campaignTag });
  let pageData;
  try {
    pageData = await listLeads(baseId, {
      pageSize: Math.min(batchSize, 100), // Airtable max 100 per page
      offset: cursor || null,
      filterByFormula: filter,
    });
  } catch (e) {
    return {
      ok: false,
      error: e.message,
      processed,
      tasksCreated: 0,
      costUSD: 0,
      errors: [e.message],
      nextCursor: null,
      done: true,
    };
  }

  let leadsToProcess = pageData.records || [];

  // If batchSize > 100, fetch additional pages until we hit batchSize
  // (Airtable caps at 100 per page; chunk multiple pages per batch)
  let nextOffset = pageData.offset || null;
  while (leadsToProcess.length < batchSize && nextOffset) {
    try {
      const more = await listLeads(baseId, {
        pageSize: 100,
        offset: nextOffset,
        filterByFormula: filter,
      });
      leadsToProcess = leadsToProcess.concat(more.records || []);
      nextOffset = more.offset || null;
    } catch (e) {
      errors.push(`pagination failed: ${e.message}`);
      break;
    }
  }

  // Slice to exact batchSize if we overshot
  const continuationCursor = leadsToProcess.length > batchSize ? null : nextOffset;
  leadsToProcess = leadsToProcess.slice(0, batchSize);

  if (leadsToProcess.length === 0) {
    return {
      ok: true,
      processed,
      tasksCreated: 0,
      costUSD: 0,
      errors,
      nextCursor: null,
      done: true,
    };
  }

  console.log(`[lead-movement] Processing ${leadsToProcess.length} leads (concurrency ${concurrency})`);

  let apiCallsMade = 0;
  // Per-slice flush running totals. These accumulate across all slice
  // flushes + the final safety-net flush, then get passed back via
  // taskResult / updateResult to keep the rest of the function's logging
  // shape unchanged.
  let tasksCreatedFlushed = 0;
  let leadsUpdatedFlushed = 0;
  let fatalQuotaError = false; // flips true on monthly_quota_exhausted; aborts remaining work
  let timedOut = false;         // flips true when we exceed time budget; lets us exit cleanly
  let processedCount = 0;       // how many leads in this batch we actually completed (for log clarity)
  const perCallCost = await getRapidAPICost(campaignId);

  // Time budget: Vercel kills serverless functions at maxDuration (300s).
  // We exit at 240s so partial work persists, the tick handler has time to
  // PATCH the run row + write Cron Run Log, and the response can transit
  // back to GitHub Actions before its curl --max-time fires.
  // Leads already processed have Last LinkedIn Check stamped, so re-running
  // the scan picks up where we left off via freshnessSkipDays.
  const SCAN_BUDGET_MS = 240 * 1000;
  const scanStartedAt = Date.now();

  // Process with concurrency control
  for (let i = 0; i < leadsToProcess.length; i += concurrency) {
    // Abort the entire batch on fatal quota error — no point firing more calls
    // that will all 429. Already-fired calls in this slice still complete.
    if (fatalQuotaError) {
      console.warn(`[lead-movement] aborting batch after ${apiCallsMade} calls — RapidAPI monthly quota exhausted`);
      break;
    }
    // Time budget check — bail out cleanly before Vercel timeout (300s) hits.
    // Leads already processed have Last LinkedIn Check stamped, so re-running
    // the scan picks up where we left off via freshnessSkipDays.
    const elapsed = Date.now() - scanStartedAt;
    if (elapsed > SCAN_BUDGET_MS) {
      console.warn(`[lead-movement] time budget exceeded (${Math.round(elapsed/1000)}s); bailing at ${processedCount}/${leadsToProcess.length} leads. Re-run to continue.`);
      timedOut = true;
      break;
    }
    const slice = leadsToProcess.slice(i, i + concurrency);
    await Promise.all(slice.map(async (leadRec) => {
      const f = leadRec.fields || {};
      const lead = {
        id: leadRec.id,
        name: f.Name || "Unknown",
        storedCompany: f.Company || "",
        storedTitle: pickLeadField(f, "title"),
        linkedinUrl: pickLeadField(f, "linkedinUrl"),
        // Carry these so buildTaskFromMovement can stamp the resulting Task
        // with the lead's contact details — otherwise the chatbot card has
        // no phone/email and the "in LinkedIn" button never appears.
        email: pickLeadField(f, "email"),
        phone: pickLeadField(f, "phone"),
      };
      // The lead's storedAccount is whatever's in their Company field.
      // The lead's "in our system, attributed to this account" is also Company.
      const storedAccount = f.Company || "";

      if (!lead.linkedinUrl) {
        // No LinkedIn URL — mark as unavailable, skip API call
        processed.total++;
        processed.unavailable++;
        leadsToUpdate.push({
          id: lead.id,
          fields: {
            "Last LinkedIn Check": new Date().toISOString().slice(0, 10),
            "Movement Detected": "Profile Unavailable",
          },
        });
        return;
      }

      // Fire RapidAPI call
      const fetchResult = await fetchLinkedInProfile(lead.linkedinUrl);
      apiCallsMade++;

      // Detect fatal API state (monthly quota exhausted) and signal the
      // outer loop to stop firing more calls — we'd just waste them
      if (fetchResult.fatal) {
        fatalQuotaError = true;
      }

      if (!fetchResult.ok) {
        processed.total++;
        processed.unavailable++;
        // Tally per-error-code so the batch summary reveals what's actually failing
        const code = fetchResult.error || "unknown";
        errorTallies[code] = (errorTallies[code] || 0) + 1;
        leadsToUpdate.push({
          id: lead.id,
          fields: {
            "Last LinkedIn Check": new Date().toISOString().slice(0, 10),
            "Movement Detected": `Profile Unavailable (${fetchResult.error})`,
          },
        });
        return;
      }

      // Classify movement
      const classification = classifyMovement({
        lead,
        storedAccount,
        profile: fetchResult.profile,
        movementWindowDays,
        allAccountNames: accountNames,
      });

      processed.total++;
      const typeKey = classification.type.toLowerCase();
      if (typeKey in processed) processed[typeKey]++;

      // Build lead update
      leadsToUpdate.push({
        id: lead.id,
        fields: buildLeadUpdateFields(classification),
      });

      // Build task if movement is actionable
      const taskFields = buildTaskFromMovement(classification, lead);
      if (taskFields) {
        tasksToCreate.push(taskFields);
      }
    }));
    // Successfully completed this slice — track progress so timeout bailout
    // log shows accurate "X/Y leads processed before timing out"
    processedCount += slice.length;

    // ─── PER-SLICE FLUSH (real-time task visibility) ─────────────
    // Previously both writes only happened after the ENTIRE batch loop
    // finished (see post-loop block below). If the operator stopped mid-
    // scan OR Vercel timed out OR a fatal error threw, the accumulated
    // arrays died in memory — the user's "2 promoted detected, 0 tasks
    // in Airtable" bug from 2026-05-21.
    //
    // Now: after each 10-lead slice we drain both arrays into Airtable.
    // Worst case adds ~20 Airtable calls per 200-lead batch — negligible
    // against the value of crash-safe partial progress + real-time
    // visibility (chatbot can pick up movement tasks within seconds
    // instead of waiting for the whole batch).
    //
    // Tasks first, then lead updates — if only one half lands, having
    // the Task is more useful than having the lead's Movement Detected
    // field stamped (the task drives the chatbot card).
    if (tasksToCreate.length > 0) {
      const drained = tasksToCreate.splice(0);
      try {
        const r = await createTasksBatch(baseId, drained);
        tasksCreatedFlushed += r.created;
        errors.push(...r.errors);
      } catch (e) {
        errors.push(`per-slice task flush failed: ${e.message}`);
      }
    }
    if (leadsToUpdate.length > 0) {
      const drained = leadsToUpdate.splice(0);
      try {
        const r = await updateLeadsBatch(baseId, drained);
        leadsUpdatedFlushed += r.updated;
        errors.push(...r.errors);
      } catch (e) {
        errors.push(`per-slice lead update flush failed: ${e.message}`);
      }
    }
  }

  // Final flush — anything that slipped through (shouldn't happen normally
  // since we drain after every slice, but safety net for edge cases like
  // arrays mutated outside the slice loop).
  if (tasksToCreate.length > 0) {
    try {
      const r = await createTasksBatch(baseId, tasksToCreate);
      tasksCreatedFlushed += r.created;
      errors.push(...r.errors);
    } catch (e) {
      errors.push(`final task flush failed: ${e.message}`);
    }
  }
  if (leadsToUpdate.length > 0) {
    try {
      const r = await updateLeadsBatch(baseId, leadsToUpdate);
      leadsUpdatedFlushed += r.updated;
      errors.push(...r.errors);
    } catch (e) {
      errors.push(`final lead update flush failed: ${e.message}`);
    }
  }

  const taskResult = { created: tasksCreatedFlushed, errors: [] };
  const updateResult = { updated: leadsUpdatedFlushed, errors: [] };

  // Track cost (one batched call instead of per-API-call)
  const batchCostUSD = apiCallsMade * perCallCost;
  if (apiCallsMade > 0) {
    await trackRapidAPIUsageBatch({
      campaignId,
      callCount: apiCallsMade,
      totalCostUSD: batchCostUSD,
      action: "lead_movement_scan",
    });
  }

  const summary = `${processed.total} leads → ${processed.hired}H / ${processed.promoted}P / ${processed.exited}E / ${processed.none}N / ${processed.stale}S / ${processed.unavailable}U; tasks created: ${taskResult.created}; cost: $${batchCostUSD.toFixed(4)}${timedOut ? ` (TIMED OUT at ${processedCount}/${leadsToProcess.length} — re-run to continue)` : ""}`;
  console.log(`[lead-movement] batch done: ${summary}`);

  // CRITICAL silent-fail detector. The 2026-05-21 bug: movements detected
  // but zero tasks landed in Airtable because the Tasks table schema was
  // missing fields buildTaskFromMovement writes. Counter ticked up, no
  // tasks visible to the operator, errors swallowed silently. This guard
  // surfaces the discrepancy LOUDLY so the operator + future debuggers
  // immediately see "wait, 2 movements but 0 tasks — something broke."
  const expectedTasks = processed.hired + processed.promoted + processed.exited;
  if (expectedTasks > 0 && taskResult.created < expectedTasks) {
    console.error(`[lead-movement] ⚠️ TASK CREATE MISMATCH: detected ${expectedTasks} actionable movements but only ${taskResult.created} tasks landed in Airtable. Likely missing fields in Tasks table schema. Check the createTasks error output above for HTTP 422 UNKNOWN_FIELD_NAME messages.`);
  }

  if (Object.keys(errorTallies).length > 0) {
    const breakdown = Object.entries(errorTallies)
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => `${code}=${count}`)
      .join(", ");
    console.log(`[lead-movement] error breakdown: ${breakdown}`);
  }

  // ─── Persist run summary to Cron Run Log (master base) ─────────
  // Gives the operator a permanent record in Airtable they can see without
  // tailing Vercel logs. Failure here is non-fatal — we still return success
  // to the caller. Uses the existing Cron Run Log schema (Cron Name, Run At,
  // Trigger, Status, Duration ms, Errors Count, Details).
  try {
    const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
    const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
    if (MASTER_BASE_ID && AIRTABLE_KEY) {
      const totalErrors = Object.values(errorTallies).reduce((a, b) => a + b, 0);
      const errorBreakdown = Object.keys(errorTallies).length
        ? Object.entries(errorTallies).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}=${n}`).join(", ")
        : "";
      const status = fatalQuotaError ? "quota_exhausted" : (timedOut ? "timeout" : "complete");
      const details = [
        `Campaign: ${campaignId || "(n/a)"}`,
        `Processed: ${processedCount}/${leadsToProcess.length} leads`,
        `Movements: ${processed.hired} hired, ${processed.promoted} promoted, ${processed.exited} exited`,
        `Tasks created: ${taskResult.created}`,
        `Cost: $${batchCostUSD.toFixed(4)}`,
        errorBreakdown ? `Errors: ${errorBreakdown}` : null,
        timedOut ? `⚠ Hit 270s budget — re-run to continue. Freshness-skip handles dedup.` : null,
        fatalQuotaError ? `✗ RapidAPI quota exhausted` : null,
      ].filter(Boolean).join("\n");

      const logFields = {
        "Cron Name": "Movement Scan",
        "Run At": new Date(scanStartedAt).toISOString(),
        "Trigger": "Manual",
        "Status": status,
        "Duration ms": Date.now() - scanStartedAt,
        "Errors Count": totalErrors,
        "Details": details,
      };
      await fetch(`https://api.airtable.com/v0/${MASTER_BASE_ID}/${encodeURIComponent("Cron Run Log")}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: logFields, typecast: true }),
      });
    }
  } catch (e) {
    // Non-fatal — keep going
    console.warn(`[lead-movement] failed to write Cron Run Log: ${e.message}`);
  }

  return {
    ok: true,
    processed,
    processedCount,             // how many leads this batch actually completed
    batchSize: leadsToProcess.length, // how many were planned
    tasksCreated: taskResult.created,
    leadsUpdated: updateResult.updated,
    costUSD: Math.round(batchCostUSD * 10000) / 10000,
    errors: errors.slice(0, 20), // cap to avoid response bloat
    nextCursor: fatalQuotaError ? null : continuationCursor,
    // done=false on timeout so the UI/cron knows to re-run. Re-runs naturally
    // skip already-stamped leads via freshnessSkipDays — no manual cursor needed.
    done: fatalQuotaError ? true : (timedOut ? false : !continuationCursor),
    timedOut,
    elapsedMs: Date.now() - scanStartedAt,
    // Surface fatal state so UI can show the right message
    fatalError: fatalQuotaError
      ? "RapidAPI monthly quota exhausted. Upgrade your plan at https://rapidapi.com/freshdata-freshdata-default/api/fresh-linkedin-profile-data or wait until your next billing cycle."
      : null,
  };
}

// ─── POST entry point ──────────────────────────────────────────────
export async function POST(req) {
  let body;
  try {
    body = await req.json();
  } catch (e) {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const {
    action = "scan",
    baseId,
    campaignId,
    movementWindowDays = 90,
    freshnessSkipDays = 7,
    campaignTag = null,
    batchSize = 200,
    cursor = null,
    concurrency = 8,
  } = body;

  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  if (action === "preview") {
    const result = await handlePreview({ baseId, campaignId, freshnessSkipDays, campaignTag });
    return NextResponse.json(result);
  }

  if (action === "scan") {
    const result = await handleScan({
      baseId,
      campaignId,
      movementWindowDays,
      freshnessSkipDays,
      campaignTag,
      batchSize,
      cursor,
      concurrency,
    });
    return NextResponse.json(result);
  }

  return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
}
