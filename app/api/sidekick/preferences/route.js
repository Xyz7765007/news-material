import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK PREFERENCES ENDPOINT
// GET /api/sidekick/preferences?baseId=X&item_type=comment&limit=15
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Returns the N most-recent operator-feedback records for a given
// item_type from the dedicated `Sidekick Feedback` table. These are
// injected into AI prompts as learned style preferences to close the
// feedback loop.
//
// item_type taxonomy: "comment" | "connection_note" | "dm".
// (dm1/dm2/dm3 are stored normalized to "dm".)
//
// Query:
//   baseId     required
//   item_type  required — one of comment | connection_note | dm
//   limit      optional, default 15, capped 50
//
// Returns:
//   { ok, count, prefs: [{ quoted_span, feedback_text, lead_name?, created_at }] }
//   most-recent-first.
//
// Degrades GRACEFULLY: if the table doesn't exist yet, returns
// { ok:true, prefs:[], count:0 } so generation still works (no feedback
// yet just means no learned prefs).
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

const FEEDBACK_TABLE = "Sidekick Feedback";
// task_feedback and skip_reason were MISSING here until 2026-08-07, and the
// consequence was silent: the write path has accepted task_feedback for weeks,
// so Veloka had 22 stored task_feedback notes that this reader returned
// count:0 for — indistinguishable from passing a nonsense item_type. Operator
// feedback on a LEAD was being captured and then read by nothing.
//
// Adding them here does NOT mix them into comment drafting. Every query filters
// on an exact Item Type match, so `?item_type=comment` still returns only
// comment notes. This only makes the other two retrievable at all.
const VALID_ITEM_TYPES = ["comment", "connection_note", "dm", "task_feedback", "skip_reason"];

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Mirror of feedback/route.js normalizeItemType: dm1/dm2/dm3 → dm; pass
// through canonical types; null if not a recognized type. Used to validate
// the user-supplied item_type BEFORE it reaches the Airtable filterByFormula.
function normalizeItemType(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (t === "dm" || /^dm\s*[123]$/.test(t) || /^dm[123]$/.test(t)) return "dm";
  if (t === "connection_note" || t === "connection note") return "connection_note";
  if (t === "comment") return "comment";
  if (t === "task_feedback" || t === "task feedback") return "task_feedback";
  if (t === "skip_reason" || t === "skip reason") return "skip_reason";
  return null;
}

// Reusable fetch helper — imported directly by auto-batch/generate so it
// reads prefs in-process instead of making an HTTP round-trip to itself.
// Returns an array of { quoted_span, feedback_text, lead_name, created_at }
// most-recent-first. Never throws; returns [] on any failure (missing
// table, transient error) so generation degrades gracefully.
export async function fetchPreferences(baseId, itemType, limit = 15) {
  if (!AIRTABLE_KEY || !baseId || !itemType) return [];
  // Validate against the whitelist (dm1/2/3 → dm). An unrecognized type would
  // otherwise be interpolated raw into filterByFormula — return [] so
  // generation degrades gracefully instead of breaking on a bad query.
  const safeType = normalizeItemType(itemType);
  if (!safeType || !VALID_ITEM_TYPES.includes(safeType)) return [];
  // Defensive: strip any double-quotes so they can't break out of the
  // formula string literal (whitelist already guarantees no quotes, belt-and-suspenders).
  const formulaType = safeType.replace(/"/g, "");
  const cap = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);

  const params = new URLSearchParams({
    // Only STANDING feedback is injected into future prompts.
    //
    // These notes are handed to the comment generator and override the voice
    // rules, so a one-off steer ("mention the 1m figure", "wrong angle for a
    // CFO") applied to every later draft is contamination, not learning. The
    // capture route labels each note generic | specific | unclassified.
    //
    // Excluding only "specific" is deliberate rather than requiring
    // "generic": legacy rows written before Scope existed have a BLANK value,
    // and rows written while the classifier was unreachable are
    // "unclassified". Both must keep flowing exactly as they do today, so the
    // filter is a denylist of one value, not an allowlist. Nothing regresses;
    // the only change is that post-specific steers stop leaking forward.
    filterByFormula: `AND({Item Type} = "${formulaType}", {Scope} != "specific")`,
    "sort[0][field]": "Created At",
    "sort[0][direction]": "desc",
    pageSize: String(cap),
  });

  try {
    let r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(FEEDBACK_TABLE)}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    // ── FALLBACK: the Scope column may not exist on this base ──────────
    // Scope was added to the schema after these tables were created, and
    // setup-fix reports an existing table as "already_complete" without
    // backfilling the new field. Airtable 422s on an unknown field in
    // filterByFormula, and the old `if (!r.ok) return []` turned that into
    // an empty list — silently switching the ENTIRE feedback loop off for
    // every item type on that base, which is exactly what happened in
    // production on 2026-08-07: comment prefs went from 5 notes to 0 and
    // nothing reported an error.
    //
    // Retry without the Scope clause. The cost is that one-off steers are
    // not filtered out on a base missing the column — the pre-Scope
    // behaviour, which is strictly better than losing every note.
    if (!r.ok && String(formulaType)) {
      const fallback = new URLSearchParams(params);
      fallback.set("filterByFormula", `{Item Type} = "${formulaType}"`);
      const r2 = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(FEEDBACK_TABLE)}?${fallback.toString()}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
        cache: "no-store",
      });
      if (r2.ok) {
        console.warn(`[preferences] Scope filter failed on ${baseId} (likely missing column) — falling back to unfiltered read. Run setup-fix to add Scope.`);
        r = r2;
      }
    }
    if (!r.ok) return [];
    const data = await r.json();
    return (data.records || []).map(rec => {
      const f = rec.fields || {};
      return {
        quoted_span: f["Quoted Span"] || "",
        feedback_text: f["Feedback Text"] || "",
        lead_name: f["Lead Name"] || null,
        created_at: f["Created At"] || null,
      };
    }).filter(p => p.feedback_text);
  } catch {
    return [];
  }
}

export async function GET(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  const itemType = url.searchParams.get("item_type");
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  if (!itemType) return NextResponse.json({ ok: false, error: "item_type required" }, { status: 400 });

  // Validate the user-supplied item_type against the whitelist before it reaches
  // the Airtable formula. Invalid → empty (NOT an error) so generation never breaks.
  if (!normalizeItemType(itemType)) {
    return NextResponse.json({ ok: true, count: 0, prefs: [] });
  }

  const limit = url.searchParams.get("limit") || "15";
  const prefs = await fetchPreferences(baseId, itemType, limit);
  return NextResponse.json({ ok: true, count: prefs.length, prefs });
}
