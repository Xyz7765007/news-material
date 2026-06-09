import { NextResponse } from "next/server";
import { fetchActiveRelevanceRules, withSuppression } from "@/lib/relevance-rules.js";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK COUNT ENDPOINT
// GET /api/sidekick/count?baseId={airtable_base_id}
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Returns just the count of pending tasks — for the chatbot's task
// counter badge. Lighter than /feed since it doesn't format card
// payloads or fetch full record data.
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

export async function GET(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY env var" }, { status: 500 });
  }

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId query param required" }, { status: 400 });
  }

  // Same filter as /feed (see comments there) — keeps badge consistent.
  // Time-sensitive types (engagement, linkedin_engagement, lead_movement) age
  // out after 7 days; all other types remain regardless of age. linkedin_engagement
  // ALSO ages out by the underlying post's publish date ({Post Date}); archived
  // tasks ({Archived At} set) are excluded. (2026-06-09 post-freshness gate.)
  const POST_DATE_GATE = `NOT(AND(FIND("linkedin_engagement", {Task Type}), NOT({Post Date} = BLANK()), NOT(IS_AFTER({Post Date}, DATEADD(NOW(), -7, 'days')))))`;
  const PENDING_FILTER = `AND({Handled At} = BLANK(), {Archived At} = BLANK(), {LinkedIn URL} != BLANK(), ${POST_DATE_GATE}, OR(AND(NOT(FIND("engagement", {Task Type})), NOT(FIND("lead_movement", {Task Type}))), IS_AFTER({Created}, DATEADD(NOW(), -7, 'days'))))`;
  // Legacy fallback for bases that haven't run setup-fix (no Post Date/Archived At).
  const LEGACY_PENDING_FILTER = `AND({Handled At} = BLANK(), {LinkedIn URL} != BLANK(), OR(AND(NOT(FIND("engagement", {Task Type})), NOT(FIND("lead_movement", {Task Type}))), IS_AFTER({Created}, DATEADD(NOW(), -7, 'days'))))`;

  // ─── Universal relevance feedback (2026-06-09) ────────────────────
  // Fold the SAME suppression clause the feed uses into both filters so the
  // badge stays byte-identical to the feed (drift would desync). role_fit
  // rules are score-only → they do NOT affect the count, so only the
  // suppression clause is applied here. Never throws → [] on missing table.
  const relevanceRules = await fetchActiveRelevanceRules(baseId);
  const SUPPRESSED_FILTER = withSuppression(PENDING_FILTER, relevanceRules);
  const SUPPRESSED_LEGACY_FILTER = withSuppression(LEGACY_PENDING_FILTER, relevanceRules);

  let activeFilter = SUPPRESSED_FILTER;
  let total = 0;
  let offset = "";
  let pages = 0;
  try {
    while (pages < 10) { // safety cap; 10 pages × 100 = 1000 tasks
      const params = new URLSearchParams({
        filterByFormula: activeFilter,
        "fields[]": "Name",
        pageSize: "100",
      });
      if (offset) params.set("offset", offset);

      const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const errText = await r.text();
        if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
          return NextResponse.json({ ok: true, count: 0, note: "Tasks table not found" });
        }
        // New post-freshness fields missing → retry once with the legacy filter so
        // the badge keeps working until setup-fix runs.
        if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME") &&
            activeFilter === SUPPRESSED_FILTER &&
            (errText.includes("Post Date") || errText.includes("Archived At"))) {
          activeFilter = SUPPRESSED_LEGACY_FILTER;
          total = 0; offset = ""; pages = 0;
          continue;
        }
        if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
          return NextResponse.json({ ok: false, error: "Handled At field missing. Run POST /api/setup-fix.", needsSetup: true }, { status: 412 });
        }
        return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}` }, { status: 502 });
      }
      const data = await r.json();
      total += (data.records || []).length;
      offset = data.offset || "";
      pages++;
      if (!offset) break;
    }
    return NextResponse.json({ ok: true, baseId, count: total });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
