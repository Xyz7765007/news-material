import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK FEEDBACK ENDPOINT
// POST /api/sidekick/feedback
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Appends ONE durable operator-feedback record to a DEDICATED
// `Sidekick Feedback` table in the campaign base. This closes the
// feedback loop: the auto-batch generator + comment generator read
// these rows back as learned style preferences (see
// /api/sidekick/preferences).
//
// STORAGE DECISION — dedicated `Sidekick Feedback` table (NOT the
// `Sidekick Chat` table):
//   The chat orchestrator's history read (/api/sidekick/chat-history)
//   reads ONLY the `Sidekick Chat` table. By storing feedback in a
//   SEPARATE table, feedback rows can NEVER leak into the chat
//   orchestrator's conversation context — pollution is structurally
//   impossible, not just filtered. This is the safe choice the design
//   asked for.
//
// Body:
//   {
//     baseId: "appXYZ...",          // required
//     item_type: "comment" | "connection_note" | "dm",  // required
//     quoted_span: "...",           // the highlighted text the operator reacted to
//     feedback_text: "...",         // required — the operator's note
//     lead_name?: "...",
//     lead_company?: "..."
//   }
//
// item_type taxonomy: dm1/dm2/dm3 all normalize to "dm".
//
// Degrades GRACEFULLY (like the setup-fix pattern): if the table or
// fields are missing it returns { ok:false, error, needsSetup:true }
// with a clear message — it does NOT hard-500. The caller (chatbot)
// surfaces a "feedback not saved" toast instead of crashing.
//
// Returns: { ok, id, createdAt }
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

const FEEDBACK_TABLE = "Sidekick Feedback";
// comment / connection_note / dm are STYLE feedback read back as generation
// prefs (see /api/sidekick/preferences). task_feedback is the operator telling
// the per-post chatbot something about the TASK/feed ("not relevant", "too
// junior"). It is captured durably but deliberately NOT in the style-pref
// taxonomy — the preferences reader whitelists the three style types, so
// task_feedback can never leak into comment/DM generation.
const VALID_ITEM_TYPES = ["comment", "connection_note", "dm", "task_feedback"];

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Normalize dm1/dm2/dm3 → dm; pass through the canonical types.
function normalizeItemType(raw) {
  const t = String(raw || "").toLowerCase().trim();
  if (t === "dm" || /^dm\s*[123]$/.test(t) || /^dm[123]$/.test(t)) return "dm";
  if (t === "connection_note" || t === "connection note") return "connection_note";
  if (t === "comment") return "comment";
  if (t === "task_feedback" || t === "task feedback") return "task_feedback";
  return null;
}

export async function POST(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

  const { baseId, item_type, quoted_span, feedback_text, lead_name, lead_company } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  const itemType = normalizeItemType(item_type);
  if (!itemType) {
    return NextResponse.json({ ok: false, error: `item_type must be one of: ${VALID_ITEM_TYPES.join(", ")} (dm1/2/3 → dm)` }, { status: 400 });
  }
  if (!feedback_text || typeof feedback_text !== "string" || !feedback_text.trim()) {
    return NextResponse.json({ ok: false, error: "feedback_text required" }, { status: 400 });
  }

  const nowISO = new Date().toISOString();
  const span = typeof quoted_span === "string" ? quoted_span.slice(0, 2000) : "";
  const note = feedback_text.slice(0, 4000);
  // Name is the primary field — make the Airtable UI row readable.
  const nameSnippet = `${itemType}: ${note.slice(0, 50).replace(/\s+/g, " ").trim()}`;

  const fields = {
    Name: nameSnippet.slice(0, 100),
    "Item Type": itemType,
    "Quoted Span": span,
    "Feedback Text": note,
    "Created At": nowISO,
  };
  if (lead_name) fields["Lead Name"] = String(lead_name).slice(0, 200);
  if (lead_company) fields["Lead Company"] = String(lead_company).slice(0, 200);

  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(FEEDBACK_TABLE)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      // Graceful degrade — never hard-500 on a missing schema. Mirror the
      // chat-log setup-fix pattern so the chatbot shows a clear message.
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: false, error: "Sidekick Feedback fields missing. Run POST /api/setup-fix.", needsSetup: true }, { status: 412 });
      }
      if (r.status === 404 || (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"))) {
        return NextResponse.json({ ok: false, error: "Sidekick Feedback table not found. Create it in Airtable (or run POST /api/setup-fix).", needsSetup: true }, { status: 412 });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }
    const data = await r.json();
    return NextResponse.json({ ok: true, id: data.id, createdAt: nowISO });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
