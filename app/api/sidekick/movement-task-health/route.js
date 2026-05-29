import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// MOVEMENT TASK HEALTH CHECK
//
// GET /api/sidekick/movement-task-health?baseId=appXXX&key=<CRON_SECRET>
//
// Reports the state of movement tasks for a given campaign base so the
// operator can verify the chatbot will surface them correctly. Use this
// to verify a campaign's data after a scan run, or to debug "movement
// scan detected N but chatbot only shows M".
//
// What it checks:
//   1. Tasks table fields — does the schema include everything
//      buildTaskFromMovement writes?
//   2. Count of Movement tasks total (all-time)
//   3. Count visible to chatbot (passes the feed's PENDING_FILTER)
//   4. Count by Movement Type — Hired / Promoted / Exited
//   5. Sample of recent movement tasks with their field state, so
//      you can eyeball whether the fields the chatbot reads are
//      actually populated
//   6. Reasons tasks are filtered out (no LinkedIn URL, >7 days old,
//      already handled)
//
// Returns JSON — easy to read in browser or curl.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function authOk(request) {
  if (!CRON_SECRET) return false;
  const url = new URL(request.url);
  const queryKey = url.searchParams.get("key");
  if (queryKey === CRON_SECRET) return true;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${CRON_SECRET}`;
}

// Fields that buildTaskFromMovement writes. If the Tasks table is
// missing any of these, the chatbot won't render movement cards
// correctly even if scan-leads' auto-heal lets the task creation succeed.
const REQUIRED_TASK_FIELDS = [
  "Name", "Company", "Task Rule", "Movement Type", "Score", "Score Reason",
  "Scan Target", "Signal", "Source", "Lead Title", "LinkedIn URL",
  "Email", "Phone", "URL", "Task Type", "Date", "Created", "Handled At",
];

async function listAllTasks(baseId, filterFormula = "") {
  const all = [];
  let offset = "";
  do {
    const params = new URLSearchParams({ pageSize: "100" });
    if (offset) params.set("offset", offset);
    if (filterFormula) params.set("filterByFormula", filterFormula);
    const r = await fetch(`${AT_API}/${baseId}/Tasks?${params}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`Tasks fetch ${r.status}: ${text.slice(0, 200)}`);
    }
    const data = await r.json();
    all.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset && all.length < 1000); // cap to keep latency bounded
  return all;
}

// Mirror the feed's PENDING_FILTER, so we can predict exactly which
// tasks the chatbot will surface vs filter out.
const FEED_FILTER = `AND({Handled At} = BLANK(), {LinkedIn URL} != BLANK(), OR(AND(NOT(FIND("engagement", {Task Type})), NOT(FIND("lead_movement", {Task Type}))), IS_AFTER({Created}, DATEADD(NOW(), -7, 'days'))))`;

export async function GET(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "AIRTABLE_API_KEY not set" }, { status: 500 });
  }
  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId query param required" }, { status: 400 });
  }

  try {
    // 1. All Movement tasks (any state)
    const allMovementTasks = await listAllTasks(
      baseId,
      `{Task Rule} = "Lead Movement"`
    );

    // 2. Tasks visible to chatbot (pass the feed filter)
    const visibleTasks = await listAllTasks(
      baseId,
      `AND({Task Rule} = "Lead Movement", ${FEED_FILTER})`
    );

    // 3. Schema check — which required fields are present on at least one record?
    // Doesn't catch fields that exist but are always empty, but catches missing-from-schema.
    const seenFields = new Set();
    for (const rec of allMovementTasks) {
      Object.keys(rec.fields || {}).forEach(k => seenFields.add(k));
    }
    const missingFields = REQUIRED_TASK_FIELDS.filter(f => !seenFields.has(f));

    // 4. Breakdown by Movement Type
    const byType = { Hired: 0, Promoted: 0, Exited: 0, missing: 0, other: 0 };
    const visibleByType = { Hired: 0, Promoted: 0, Exited: 0, missing: 0, other: 0 };
    for (const rec of allMovementTasks) {
      const mt = rec.fields?.["Movement Type"];
      if (!mt) byType.missing++;
      else if (["Hired", "Promoted", "Exited"].includes(mt)) byType[mt]++;
      else byType.other++;
    }
    for (const rec of visibleTasks) {
      const mt = rec.fields?.["Movement Type"];
      if (!mt) visibleByType.missing++;
      else if (["Hired", "Promoted", "Exited"].includes(mt)) visibleByType[mt]++;
      else visibleByType.other++;
    }

    // 5. Filtered-out reasons — why are some movement tasks not visible?
    //    Categorize the gap to make debugging fast.
    const filteredOut = allMovementTasks.length - visibleTasks.length;
    const filteredReasons = { handled: 0, noLinkedInUrl: 0, stale: 0, missingTaskType: 0 };
    const visibleIds = new Set(visibleTasks.map(t => t.id));
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (const rec of allMovementTasks) {
      if (visibleIds.has(rec.id)) continue;
      const f = rec.fields || {};
      if (f["Handled At"]) filteredReasons.handled++;
      else if (!f["LinkedIn URL"]) filteredReasons.noLinkedInUrl++;
      else if (!f["Task Type"]) filteredReasons.missingTaskType++;
      else {
        // Likely stale — Created > 7 days ago
        const createdTs = f.Created ? new Date(f.Created).getTime() : 0;
        if (createdTs < sevenDaysAgo) filteredReasons.stale++;
      }
    }

    // 6. Sample 5 most recent movement tasks for eyeball verification
    const sample = visibleTasks.slice(0, 5).map(rec => {
      const f = rec.fields || {};
      return {
        id: rec.id,
        name: f.Name || "(missing)",
        company: f.Company || "(missing)",
        movement_type: f["Movement Type"] || "(missing)",
        task_type: f["Task Type"] || "(missing)",
        score: f.Score ?? "(missing)",
        has_linkedin_url: !!f["LinkedIn URL"],
        has_signal: !!f.Signal,
        created: f.Created || "(missing)",
        will_render_in_chatbot:
          !!f.Name &&
          !!f.Company &&
          !!f["LinkedIn URL"] &&
          f["Task Type"] === "lead_movement" &&
          ["Hired", "Promoted", "Exited"].includes(f["Movement Type"]),
      };
    });

    // 7. Healthy / Issue verdict
    const issues = [];
    if (missingFields.length > 0) {
      issues.push(`Tasks table missing fields: ${missingFields.join(", ")} — run setup-fix to add`);
    }
    if (byType.missing > 0) {
      issues.push(`${byType.missing} movement tasks have NO Movement Type set — won't show Hired/Promoted/Exited badge`);
    }
    if (filteredReasons.missingTaskType > 0) {
      issues.push(`${filteredReasons.missingTaskType} tasks missing Task Type field — won't be classified as movement cards`);
    }
    if (visibleTasks.length === 0 && allMovementTasks.length > 0) {
      issues.push(`Tasks exist but NONE visible to chatbot — check filtering reasons below`);
    }

    return NextResponse.json({
      ok: true,
      baseId,
      counts: {
        all_movement_tasks: allMovementTasks.length,
        visible_to_chatbot: visibleTasks.length,
        filtered_out: filteredOut,
      },
      by_movement_type: byType,
      visible_by_movement_type: visibleByType,
      filtered_reasons: filteredReasons,
      schema: {
        required_fields: REQUIRED_TASK_FIELDS,
        missing_fields: missingFields,
        seen_fields: Array.from(seenFields).sort(),
      },
      sample_recent_visible: sample,
      issues,
      verdict: issues.length === 0
        ? "✅ Healthy — movement tasks should render correctly in chatbot"
        : `⚠️ ${issues.length} issue(s) found — see issues array`,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e.message || "Unknown error" },
      { status: 500 }
    );
  }
}
