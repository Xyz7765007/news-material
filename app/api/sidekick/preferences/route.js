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
const VALID_ITEM_TYPES = ["comment", "connection_note", "dm"];

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
    filterByFormula: `{Item Type} = "${formulaType}"`,
    "sort[0][field]": "Created At",
    "sort[0][direction]": "desc",
    pageSize: String(cap),
  });

  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(FEEDBACK_TABLE)}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
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
