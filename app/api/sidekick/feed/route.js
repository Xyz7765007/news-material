import { NextResponse } from "next/server";

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
    score: typeof f.Score === "number" ? f.Score : 0,
    task_type: f["Task Type"] || "",
    task_rule: f["Task Rule"] || "",
    source: f.Source || "",
    signal: f.Signal || "",
    score_reason: f["Score Reason"] || "",
    url: f.URL || f["Post URL"] || f["Signal URL"] || "",
    account_id: f["Account ID"] || "",
    event_id: f["Event ID"] || "",
    created_at: f.Created || f.Date || "",
  };
}

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

  // Filter: tasks where Handled At is empty (i.e. still pending).
  // Sort: highest Score first, then most recent Created.
  const params = new URLSearchParams({
    filterByFormula: `{Handled At} = BLANK()`,
    "sort[0][field]": "Score",
    "sort[0][direction]": "desc",
    "sort[1][field]": "Created",
    "sort[1][direction]": "desc",
    pageSize: String(Math.min(limit, 100)),
  });

  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      // 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND when the Tasks table doesn't exist yet
      if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, count: 0, cards: [], note: "Tasks table not found in this base" });
      }
      // 422 UNKNOWN_FIELD when Handled At doesn't exist yet (campaign hasn't run setup-fix)
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: false, error: "Handled At field missing in Tasks table. Run POST /api/setup-fix to add it.", needsSetup: true }, { status: 412 });
      }
      return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }
    const data = await r.json();
    const records = (data.records || []).slice(0, limit);
    const cards = records.map(formatCard);

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
