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
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ── Scope classifier ───────────────────────────────────────────────
// "generic"      -> a standing rule about how comments should read. Applies to
//                   any future post. THIS is what gets fed back into the prompt.
// "specific"     -> about this one post/comment: a fact, a figure, this lead,
//                   this angle. Retained for audit, never injected.
// "unclassified" -> the model could not be reached. Treated as generic by
//                   preferences so behaviour never regresses on an outage.
const SCOPE_SYSTEM = `You label one piece of operator feedback about an AI-drafted LinkedIn comment.

Decide whether the feedback is a STANDING rule or a ONE-OFF steer.

"generic" = a rule about how comments should be written that would still make sense
applied to a completely different post. Voice, tone, length, structure, formatting,
things to always do or never do. Examples: "stop using em dashes", "too long, keep it
under 25 words", "never open with praise", "always end on a question", "stop sounding
salesy", "don't summarise the post back to them".

"specific" = tied to THIS post, THIS lead or THIS draft, and would be wrong or
meaningless applied to another post. Examples: "mention the 1m figure", "he already
said that in the post", "this is the wrong angle for a CFO", "the number is 84 not 48",
"ask about their Q3 launch instead".

If the feedback contains BOTH a standing rule and a post-specific correction, label it
"generic" only if the standing rule is the main point; otherwise "specific".
When genuinely torn, choose "specific" - a missed standing rule costs one repeat of a
correction, whereas a wrongly promoted one-off contaminates every future comment.

Return ONLY JSON: {"scope":"generic"|"specific","why":"max 12 words"}`;

async function classifyScope(note, span) {
  if (!OPENAI_KEY) return "unclassified";
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        temperature: 0,
        // gpt-5.4-mini silently returns empty on max_tokens — this MUST be
        // max_completion_tokens (the May-16 outage).
        max_completion_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SCOPE_SYSTEM },
          { role: "user", content: `Highlighted text the operator reacted to:\n"""${(span || "(none)").slice(0, 600)}"""\n\nTheir feedback:\n"""${note.slice(0, 1200)}"""` },
        ],
      }),
      cache: "no-store",
    });
    if (!r.ok) return "unclassified";
    const d = await r.json();
    const parsed = JSON.parse(d.choices?.[0]?.message?.content || "{}");
    return parsed.scope === "generic" || parsed.scope === "specific" ? parsed.scope : "unclassified";
  } catch {
    // Never let classification failure lose the operator's feedback.
    return "unclassified";
  }
}

const FEEDBACK_TABLE = "Sidekick Feedback";
// comment / connection_note / dm are STYLE feedback read back as generation
// prefs (see /api/sidekick/preferences). task_feedback is the operator telling
// the per-post chatbot something about the TASK/feed ("not relevant", "too
// junior"). It is captured durably but deliberately NOT in the style-pref
// taxonomy — the preferences reader whitelists the three style types, so
// task_feedback can never leak into comment/DM generation.
const VALID_ITEM_TYPES = ["comment", "connection_note", "dm", "task_feedback", "skip_reason"];

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
  // skip_reason was REJECTED with a 400 until 2026-08-07 while the card UI was
  // still sending it (SideKick.jsx sends skip_reason when the operator gives a
  // reason for skipping a lead). The browser does not surface that 400, so the
  // operator typed a reason, saw it accepted, and it was thrown away. Why the
  // reason someone skipped a lead matters: it is the clearest statement of what
  // should NOT have scored, which is exactly what the scan needs to learn from.
  if (t === "skip_reason" || t === "skip reason") return "skip_reason";
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

  // ═══════════════════════════════════════════════════════════════════
  // SCOPE CLASSIFICATION — generic standing rule vs one-off steer.
  //
  // Why this exists: /api/sidekick/preferences hands the last N notes to the
  // comment generator, which applies them to EVERY future draft and lets them
  // override the voice rules. Without a scope, "mention the 1m figure" (about
  // one post) is applied with exactly the same force as "never use em dashes"
  // (a standing rule), so a single steer quietly contaminates every later
  // comment. Samarth 2026-08-07: generic content feedback should feed the
  // prompt for new comments - which means something has to decide what is
  // generic, and that is this.
  //
  // FAILS OPEN TO TODAY'S BEHAVIOUR. If the model is unavailable (the
  // insufficient_quota outage earlier today is the live example) the note is
  // stored "unclassified", and preferences INCLUDES unclassified. So an AI
  // outage degrades to exactly the current behaviour rather than silently
  // switching the learning loop off.
  const scope = await classifyScope(note, span);

  const fields = {
    Name: nameSnippet.slice(0, 100),
    "Item Type": itemType,
    "Quoted Span": span,
    "Feedback Text": note,
    "Created At": nowISO,
    Scope: scope,
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
