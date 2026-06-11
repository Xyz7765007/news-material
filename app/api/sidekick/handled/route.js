import { NextResponse } from "next/server";
import { fetchActiveRelevanceRules, withSuppression } from "@/lib/relevance-rules.js";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK HANDLED-HISTORY ENDPOINT
// GET /api/sidekick/handled?baseId={airtable_base_id}&limit=20
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Returns recently HANDLED tasks (Handled At set), newest-handled first,
// so the chatbot can show a "Handled" panel and let the operator REOPEN
// a task he marked done/skip (Samarth 2026-06-11: "revisit tasks even if
// the action is marked once"). Reopen itself is /api/sidekick/action
// with action:"reopen".
//
// Filter intentionally mirrors the FEED gates (Archived At blank,
// LinkedIn URL present, post-date freshness, 7-day window for
// time-sensitive types, relevance suppression) with the Handled At
// clause flipped — so every task this returns is guaranteed to come
// BACK into the feed when reopened. A reopen that lands in a gated-out
// void would look broken.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Same card shape as the feed (formatCard there), plus handled_at/handled_as
// so the panel can show what happened and when.
function formatHandledCard(record) {
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
    post_text: f["Post Text"] || "",
    score_reason: f["Score Reason"] || "",
    movement_type: f["Movement Type"] || "",
    url: f.URL || f["Post URL"] || f["Signal URL"] || "",
    account_id: f["Account ID"] || "",
    event_id: f["Event ID"] || "",
    created_at: f.Created || f.Date || "",
    handled_at: f["Handled At"] || "",
    handled_as: f["Handled As"] || "",
  };
}

// Feed gates with Handled At FLIPPED (see header). Keep these in sync with
// /api/sidekick/feed — if the feed gains a gate, add it here too.
const POST_DATE_GATE = `NOT(AND(FIND("linkedin_engagement", {Task Type}), NOT({Post Date} = BLANK()), NOT(IS_AFTER({Post Date}, DATEADD(NOW(), -7, 'days')))))`;
const HANDLED_FILTER = `AND({Handled At} != BLANK(), {Archived At} = BLANK(), {LinkedIn URL} != BLANK(), ${POST_DATE_GATE}, OR(AND(NOT(FIND("engagement", {Task Type})), NOT(FIND("lead_movement", {Task Type}))), IS_AFTER({Created}, DATEADD(NOW(), -7, 'days'))))`;
// Legacy fallback for bases without Post Date / Archived At (pre setup-fix).
const LEGACY_HANDLED_FILTER = `AND({Handled At} != BLANK(), {LinkedIn URL} != BLANK(), OR(AND(NOT(FIND("engagement", {Task Type})), NOT(FIND("lead_movement", {Task Type}))), IS_AFTER({Created}, DATEADD(NOW(), -7, 'days'))))`;

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
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 50);

  // Relevance suppression folded in, same as the feed — a suppressed lead
  // must not be reopenable into a feed that filters it right back out.
  const relevanceRules = await fetchActiveRelevanceRules(baseId);
  const FILTER = withSuppression(HANDLED_FILTER, relevanceRules);
  const LEGACY_FILTER = withSuppression(LEGACY_HANDLED_FILTER, relevanceRules);

  const buildParams = (filter) => new URLSearchParams({
    filterByFormula: filter,
    "sort[0][field]": "Handled At",
    "sort[0][direction]": "desc",
    pageSize: String(limit),
  });
  const fetchTasks = (filter) => fetch(
    `${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${buildParams(filter).toString()}`,
    { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
  );

  try {
    let r = await fetchTasks(FILTER);
    if (!r.ok) {
      const errText = await r.text();
      if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, count: 0, items: [], note: "Tasks table not found in this base" });
      }
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME") &&
          (errText.includes("Post Date") || errText.includes("Archived At"))) {
        r = await fetchTasks(LEGACY_FILTER);
        if (!r.ok) {
          const e2 = await r.text();
          return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}`, detail: e2.slice(0, 500) }, { status: 502 });
        }
      } else if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: false, error: "Handled At field missing in Tasks table. Run POST /api/setup-fix to add it.", needsSetup: true }, { status: 412 });
      } else {
        return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
      }
    }
    const data = await r.json();
    const items = (data.records || []).map(formatHandledCard).slice(0, limit);

    return NextResponse.json({
      ok: true,
      baseId,
      count: items.length,
      items,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
