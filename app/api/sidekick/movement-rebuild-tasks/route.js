import { NextResponse } from "next/server";
import { buildTaskFromMovement } from "@/lib/movement-detection";

// ═══════════════════════════════════════════════════════════════════
// POST /api/sidekick/movement-rebuild-tasks
//
// Rebuilds Movement Tasks from existing Lead data WITHOUT re-running
// the RapidAPI scan. Use when:
//   - A previous scan detected movements (Lead records have
//     "Movement Detected" = Hired/Promoted/Exited and the "Current
//     Job Title" / "Previous Job Title" / etc. fields populated)
//     but the Task creation half failed (silent 422, mid-scan stop,
//     Vercel timeout)
//   - You want to backfill tasks for movements detected weeks ago
//     before this rebuild path existed
//
// Request body:
//   { baseId: "appXXX", dryRun: false }
//
// Response:
//   { ok, leadsScanned, movementsFound, alreadyHadTasks,
//     tasksCreated, errors }
//
// Idempotent: dedupes against existing "Lead Movement" tasks by
// matching (Name + Company + Movement Type). Safe to re-run.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;

function atHdr() {
  return {
    Authorization: `Bearer ${AIRTABLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function listAll(baseId, table, filterFormula = "") {
  const all = [];
  let offset = "";
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (offset) params.set("offset", offset);
    if (filterFormula) params.set("filterByFormula", filterFormula);
    const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}?${params}`;
    const r = await fetch(url, { headers: atHdr() });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      throw new Error(`list ${table} ${r.status}: ${errText.slice(0, 200)}`);
    }
    const data = await r.json();
    all.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return all;
}

async function createTasksBatch(baseId, taskFieldsArray) {
  if (!taskFieldsArray.length) return { created: 0, errors: [], droppedFields: [] };
  const errors = [];
  let created = 0;
  // Track fields we've already discovered are missing from this base's
  // Tasks schema. Once we know "Movement Type" doesn't exist, every
  // subsequent batch in this call skips it without retrying.
  const knownMissingFields = new Set();

  // Airtable: max 10 records per create call.
  // Self-heal: on 422 UNKNOWN_FIELD_NAME, parse the missing field name
  // from the error message, strip it from every record in the batch,
  // retry. Loop up to 8 iterations (the task has 17 fields total — 8
  // is more than enough headroom). This prevents the silent "0 tasks
  // created" outcome the operator just hit: their Tasks table is
  // missing one or more of the new fields (Movement Type / Lead Title /
  // Phone / etc.) and the entire batch dies on the first unknown
  // field rather than writing what it can.
  for (let i = 0; i < taskFieldsArray.length; i += 10) {
    const baseSlice = taskFieldsArray.slice(i, i + 10);

    // Drop any fields we already know are missing for this base
    let slice = baseSlice.map(f => {
      const filtered = { ...f };
      for (const k of knownMissingFields) delete filtered[k];
      return filtered;
    });

    let attempts = 0;
    let succeeded = false;
    while (attempts < 8 && !succeeded) {
      attempts++;
      try {
        const r = await fetch(`${AT_API}/${baseId}/Tasks`, {
          method: "POST",
          headers: atHdr(),
          body: JSON.stringify({
            records: slice.map(f => ({ fields: f })),
            typecast: true,
          }),
        });
        if (r.ok) {
          const data = await r.json();
          created += (data.records || []).length;
          succeeded = true;
          break;
        }
        // Capture more of the error (was 200, now 600) so the field
        // name is always visible to the operator even without retry.
        const errText = await r.text().catch(() => "");
        if (r.status === 422) {
          // Try to extract the missing field from the Airtable response.
          // Two known shapes:
          //   { "error": { "type": "UNKNOWN_FIELD_NAME", "message": "Unknown field name: \"Movement Type\"" } }
          //   { "error": "UNKNOWN_FIELD_NAME", "message": "..." }
          let missingField = null;
          try {
            const parsed = JSON.parse(errText);
            const message = parsed?.error?.message || parsed?.message || "";
            const match = message.match(/Unknown field name:?\s*["']([^"']+)["']/i);
            if (match) missingField = match[1];
          } catch { /* fall through */ }

          if (missingField && !knownMissingFields.has(missingField)) {
            knownMissingFields.add(missingField);
            slice = slice.map(f => {
              const filtered = { ...f };
              delete filtered[missingField];
              return filtered;
            });
            continue; // retry without that field
          }
          // 422 we can't parse → log and give up on this batch
          errors.push(`createTasks 422 (unparseable): ${errText.slice(0, 600)}`);
          break;
        }
        // Non-422 error → don't retry, log
        errors.push(`createTasks ${r.status}: ${errText.slice(0, 600)}`);
        break;
      } catch (e) {
        errors.push(`createTasks threw: ${e.message}`);
        break;
      }
    }
  }
  return { created, errors, droppedFields: Array.from(knownMissingFields) };
}

// Mirror the lib pickLeadField helper for common field-name variants.
function pickField(f, ...names) {
  for (const n of names) {
    if (f[n] !== undefined && f[n] !== null && f[n] !== "") return f[n];
  }
  return "";
}

export async function POST(request) {
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "AIRTABLE_API_KEY not set" }, { status: 500 });
  }

  let body;
  try { body = await request.json(); } catch { body = {}; }
  const { baseId, dryRun = false } = body || {};
  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  }

  const startedAt = Date.now();
  const errors = [];

  // ─── 1. Read all Leads where Movement Detected is actionable ────
  // Airtable's filterByFormula is faster than client-side filtering
  // for large bases. Match exact Hired/Promoted/Exited so "Profile
  // Unavailable" rows are excluded.
  const filter = `OR({Movement Detected}="Hired",{Movement Detected}="Promoted",{Movement Detected}="Exited")`;
  let leads;
  try {
    leads = await listAll(baseId, "Leads", filter);
  } catch (e) {
    return NextResponse.json({ ok: false, error: `list Leads failed: ${e.message}` }, { status: 500 });
  }

  if (leads.length === 0) {
    return NextResponse.json({
      ok: true,
      leadsScanned: 0,
      movementsFound: 0,
      alreadyHadTasks: 0,
      tasksCreated: 0,
      message: "No Leads have Movement Detected = Hired/Promoted/Exited in this base. Either no movements were ever detected, or the Lead records weren't updated either.",
    });
  }

  // ─── 2. Read existing Lead Movement Tasks for dedup ─────────────
  let existingTasks;
  try {
    existingTasks = await listAll(baseId, "Tasks", `{Task Rule}="Lead Movement"`);
  } catch (e) {
    // Tasks table might be empty / not yet have the field — non-fatal
    existingTasks = [];
    errors.push(`list existing Tasks failed (continuing): ${e.message}`);
  }

  // Dedup key: "<name>|<company>|<movement>" lowercased + trimmed
  const dedupKey = (name, company, movement) =>
    `${String(name || "").toLowerCase().trim()}|${String(company || "").toLowerCase().trim()}|${String(movement || "").toLowerCase().trim()}`;

  const existingKeys = new Set(
    existingTasks.map(t => {
      const f = t.fields || {};
      return dedupKey(f.Name, f.Company, f["Movement Type"]);
    })
  );

  // ─── 3. Synthesize classification + build task for each lead ────
  const tasksToCreate = [];
  let alreadyHadTasks = 0;
  let missingDataSkipped = 0;

  for (const leadRec of leads) {
    const f = leadRec.fields || {};
    const movementType = f["Movement Detected"];
    if (!["Hired", "Promoted", "Exited"].includes(movementType)) continue;

    const name = f.Name || "";
    const currentCompany = f["Current Company"] || "";
    const previousCompany = f["Previous Company"] || f.Company || "";
    const currentTitle = f["Current Job Title"] || "";
    const previousTitle = f["Previous Job Title"] || pickField(f, "Title", "Job Title");
    const currentStartedAt = f["Current Role Started At"] || "";
    const daysInCurrentRole = typeof f["Days In Current Role"] === "number" ? f["Days In Current Role"] : null;

    // Decide which company this task is "for" — same logic as buildTaskFromMovement
    let companyForTask;
    if (movementType === "Hired") {
      companyForTask = currentCompany;
    } else if (movementType === "Promoted") {
      companyForTask = previousCompany || currentCompany;
    } else { // Exited
      companyForTask = previousCompany;
    }

    // Skip if we don't have enough to build a meaningful task
    if (!name || !companyForTask) {
      missingDataSkipped++;
      continue;
    }

    // Dedup
    const key = dedupKey(name, companyForTask, movementType);
    if (existingKeys.has(key)) {
      alreadyHadTasks++;
      continue;
    }

    // Synthesize classification + lead objects in the shape
    // buildTaskFromMovement expects.
    const classification = {
      type: movementType,
      details: {
        currentCompany,
        currentTitle,
        currentStartedAt,
        daysInCurrentRole,
        previousCompany,
        previousTitle,
        // These are the synthetic fields buildTaskFromMovement reads
        storedAccount: previousCompany,
        storedTitle: previousTitle,
        storedCompany: previousCompany,
        destinationAccount: currentCompany,
      },
    };
    const lead = {
      name,
      storedTitle: previousTitle || currentTitle,
      linkedinUrl: pickField(f, "LinkedIn URL", "Linkedin URL", "LinkedIn", "linkedin_url"),
      email: pickField(f, "Email", "Lead Email", "email"),
      phone: pickField(f, "Phone", "Lead Phone", "Mobile", "phone"),
    };

    const taskFields = buildTaskFromMovement(classification, lead);
    if (taskFields) {
      tasksToCreate.push(taskFields);
      existingKeys.add(key); // protect against double-add within this run
    }
  }

  // ─── 4. Bulk create (unless dry run) ────────────────────────────
  let tasksCreated = 0;
  let droppedFields = [];
  if (!dryRun && tasksToCreate.length > 0) {
    const result = await createTasksBatch(baseId, tasksToCreate);
    tasksCreated = result.created;
    droppedFields = result.droppedFields || [];
    errors.push(...result.errors);
  }

  return NextResponse.json({
    ok: true,
    dryRun,
    durationMs: Date.now() - startedAt,
    leadsScanned: leads.length,
    movementsFound: leads.length,
    alreadyHadTasks,
    missingDataSkipped,
    tasksWouldCreate: dryRun ? tasksToCreate.length : undefined,
    tasksCreated,
    droppedFields,
    errors: errors.slice(0, 20),
    summary: dryRun
      ? `DRY RUN: would create ${tasksToCreate.length} tasks (${alreadyHadTasks} already exist, ${missingDataSkipped} skipped for missing data)`
      : `Created ${tasksCreated} tasks (${alreadyHadTasks} already existed, ${missingDataSkipped} skipped for missing data)${droppedFields.length ? `. Tasks table missing fields auto-skipped: ${droppedFields.join(", ")} — run /api/setup-fix?baseId=${baseId} to add them.` : ""}${errors.length ? ` — ${errors.length} unresolved error(s)` : ""}`,
  });
}
