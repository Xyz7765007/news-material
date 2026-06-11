import { NextResponse } from "next/server";
import { fetchActiveRelevanceRules, withSuppression, roleFitScoreFor } from "@/lib/relevance-rules.js";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK FEED ENDPOINT
// GET /api/sidekick/feed?baseId={airtable_base_id}&limit=20
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Returns pending tasks (Handled At is empty) from the Tasks table in
// the given campaign base, formatted as chatbot-ready card payloads,
// sorted by Score desc.
//
// This is the primary endpoint the Side Kick chatbot polls every 30s
// to render its card feed. Tasks remain in Airtable after being
// actioned (for history); they just disappear from the feed once
// Handled At is set via /api/sidekick/action.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false; // fail closed if env not set
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Format an Airtable Tasks row into a chatbot-ready card payload.
// Stable shape — the chatbot can rely on these field names.
//
// SignalScope's Tasks schema (from app/api/airtable/route.js line 998):
//   - `Name` (primary) = the lead's name for lead-level tasks,
//      or the account's name for account-level tasks.
//   - `Company` = the lead's employer (lead tasks) or = Name (account tasks).
//   - `Lead Title`, `Email`, `LinkedIn URL` = lead contact details, may be empty.
//   - `Task Type` = "top_x" | "linkedin_engagement" | etc.
//   - `Task Rule` = the rule name (e.g. "Top 50 leads", "VP marketing earnings").
//
// The chatbot can decide how to render — typically display `lead_name` as the
// big subject + `company` as smaller context underneath.
function formatCard(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    lead_name: f.Name || "",
    company: f.Company || "",
    lead_title: f["Lead Title"] || f.Title || "",
    lead_email: f.Email || "",
    lead_linkedin: f["LinkedIn URL"] || f["Linkedin URL"] || "",
    lead_phone: f.Phone || "",
    score: typeof f.Score === "number" ? f.Score : 0,
    task_type: f["Task Type"] || "",
    task_rule: f["Task Rule"] || "",
    source: f.Source || "",
    signal: f.Signal || "",
    // Full raw post text (linkedin_engagement only; written by /api/linkedin-posts,
    // capped 3000). The chatbot's "Read full post here" prefers this over the
    // Signal-derived summary. Empty for legacy tasks created before 2026-06-11.
    post_text: f["Post Text"] || "",
    score_reason: f["Score Reason"] || "",
    movement_type: f["Movement Type"] || "",
    url: f.URL || f["Post URL"] || f["Signal URL"] || "",
    account_id: f["Account ID"] || "",
    event_id: f["Event ID"] || "",
    created_at: f.Created || f.Date || "",
  };
}

// Filter formula:
//   1. Handled At must be empty (pending)
//   2. LinkedIn URL must NOT be empty — per Samarth, the chatbot only shows
//      tasks where the lead has a LinkedIn URL, so the operator always has
//      a path to action. Tasks for leads missing this field stay in Airtable
//      (for re-enrichment / manual fix) but don't appear in the chatbot.
//   3. AND: either the task is NOT one of the time-sensitive types
//      (engagement = GA, linkedin_engagement = LinkedIn Posts, lead_movement = RapidAPI movement),
//      OR Created within last 7 days.
//   Per Samarth: GA, LinkedIn engagement, and movement-detected signals all
//   go stale after a week. Top X and Unipile triggers stay regardless.
//
//   FIND("engagement", {Task Type}) matches BOTH "engagement" (GA) and
//   "linkedin_engagement" (LinkedIn Posts) in one check.
//
//   Assumes Created is a dateTime field — setup-fix ensures this. Older
//   text-type Created columns will fail DATETIME comparisons silently and
//   tasks fall through unfiltered (acceptable degraded behaviour).
//
//   4. NEW (2026-06-09 post-freshness gate): a linkedin_engagement task is
//      gated by the UNDERLYING POST's publish date ({Post Date}), not the scan
//      time. A post is 1-6 days old when fetched and ages daily, so a task
//      fetched at 6 days becomes 8 days two days later — it must drop out of the
//      feed. If {Post Date} is set AND older than 7 days, the task is excluded.
//      Tasks with a blank {Post Date} (legacy rows, undatable posts) fall back
//      to the Created-window above so behaviour never regresses.
//   5. {Archived At} must be BLANK. Distinct from {Handled At} (operator-
//      handled) — aged-out post tasks get an Archived At stamp + a Signal
//      Archive copy (surfaced in the in-app Signal Review tab) so they leave the
//      feed but stay queryable and analytics-clean.
const POST_DATE_GATE = `NOT(AND(FIND("linkedin_engagement", {Task Type}), NOT({Post Date} = BLANK()), NOT(IS_AFTER({Post Date}, DATEADD(NOW(), -7, 'days')))))`;
const PENDING_FILTER = `AND({Handled At} = BLANK(), {Archived At} = BLANK(), {LinkedIn URL} != BLANK(), ${POST_DATE_GATE}, OR(AND(NOT(FIND("engagement", {Task Type})), NOT(FIND("lead_movement", {Task Type}))), IS_AFTER({Created}, DATEADD(NOW(), -7, 'days'))))`;
// Legacy filter (pre-2026-06-09): used as a graceful fallback for campaign bases
// that haven't run setup-fix yet, so the new {Post Date}/{Archived At} fields
// don't exist. Without this fallback, the new formula would 422 and take the
// feed down for un-migrated campaigns. Once setup-fix runs, PENDING_FILTER wins.
const LEGACY_PENDING_FILTER = `AND({Handled At} = BLANK(), {LinkedIn URL} != BLANK(), OR(AND(NOT(FIND("engagement", {Task Type})), NOT(FIND("lead_movement", {Task Type}))), IS_AFTER({Created}, DATEADD(NOW(), -7, 'days'))))`;

export async function GET(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized — pass Authorization: Bearer <SIDEKICK_API_KEY>" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY env var" }, { status: 500 });
  }

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId query param required" }, { status: 400 });
  }
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 100);

  // ─── Universal relevance feedback (2026-06-09) ────────────────────
  // Load active operator relevance rules and fold their suppression clause
  // into BOTH filters so they stay byte-identical to the count endpoint.
  // RETROACTIVE + forward + REVERSIBLE: the read filter is the source of
  // truth. fetchActiveRelevanceRules NEVER throws → [] on missing table, so
  // un-migrated bases behave EXACTLY as before (zero suppression). role_fit
  // rules don't suppress; they override the served score below.
  const relevanceRules = await fetchActiveRelevanceRules(baseId);
  const FILTER = withSuppression(PENDING_FILTER, relevanceRules);
  const LEGACY_FILTER = withSuppression(LEGACY_PENDING_FILTER, relevanceRules);

  // Filter (PENDING_FILTER above): pending tasks, excluding stale GA-engagement (>7d)
  // and post-date-aged linkedin_engagement (>7d). Sort: Score desc, then Created desc.
  const buildParams = (filter) => new URLSearchParams({
    filterByFormula: filter,
    "sort[0][field]": "Score",
    "sort[0][direction]": "desc",
    "sort[1][field]": "Created",
    "sort[1][direction]": "desc",
    pageSize: String(Math.min(limit, 100)),
  });
  const fetchTasks = (filter) => fetch(
    `${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${buildParams(filter).toString()}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
  );

  try {
    let r = await fetchTasks(FILTER);
    if (!r.ok) {
      const errText = await r.text();
      // 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND when the Tasks table doesn't exist yet
      if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, count: 0, cards: [], note: "Tasks table not found in this base" });
      }
      // 422 UNKNOWN_FIELD when a referenced field doesn't exist yet (campaign hasn't
      // run setup-fix). If it's one of the NEW post-freshness fields, gracefully
      // retry with the legacy filter so the feed keeps working until setup-fix runs.
      // (Suppression clause is folded into both filters, so retry preserves it.)
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME") &&
          (errText.includes("Post Date") || errText.includes("Archived At"))) {
        r = await fetchTasks(LEGACY_FILTER);
        if (!r.ok) {
          const e2 = await r.text();
          if (r.status === 422 && e2.includes("UNKNOWN_FIELD_NAME")) {
            return NextResponse.json({ ok: false, error: "Handled At field missing in Tasks table. Run POST /api/setup-fix to add it.", needsSetup: true }, { status: 412 });
          }
          return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}`, detail: e2.slice(0, 500) }, { status: 502 });
        }
      } else if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: false, error: "Handled At field missing in Tasks table. Run POST /api/setup-fix to add it.", needsSetup: true }, { status: 412 });
      } else {
        return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
      }
    }
    const data = await r.json();
    // role_fit override (read-side only): Airtable sorted by the STORED Score, so
    // re-rank in JS after overriding. Apply the override BEFORE slicing to limit so
    // a downgraded card can't bump out a legitimately higher one. Stored Score is
    // never mutated — this only changes the served `score` + ordering.
    let records = data.records || [];
    const hasRoleFit = relevanceRules.some(rl => rl.kind === "role_fit");
    let cards = records.map(formatCard);
    if (hasRoleFit) {
      cards = cards.map(c => ({ ...c, score: roleFitScoreFor(c.lead_title, c.score, relevanceRules) }));
      // Re-sort to match the original Airtable order (Score desc, then Created desc)
      // now that some served scores changed.
      cards.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const ta = new Date(a.created_at || 0).getTime();
        const tb = new Date(b.created_at || 0).getTime();
        return (isNaN(tb) ? 0 : tb) - (isNaN(ta) ? 0 : ta);
      });
    }
    cards = cards.slice(0, limit);

    return NextResponse.json({
      ok: true,
      baseId,
      count: cards.length,
      cards,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
