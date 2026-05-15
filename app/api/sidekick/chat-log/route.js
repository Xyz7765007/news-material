import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK CHAT LOG ENDPOINT
// POST /api/sidekick/chat-log
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Appends a single message to the Sidekick Chat table in the campaign
// base. Used by the chatbot to persist every user + bot exchange so
// chat history survives reloads and feeds Claude's dynamic memory
// across sessions.
//
// Body:
//   {
//     baseId: "appXYZ...",
//     role: "user" | "bot",
//     text: "...",
//     intent?: "scan",                 // what was classified (bot messages)
//     actionType?: "scan" | "refresh", // null/undefined for chat-only
//     actionResult?: { ... }            // JSON object for bot messages
//   }
//
// Returns: { ok, id, createdAt }
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

export async function POST(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

  const { baseId, role, text, intent, actionType, actionResult } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  if (!role || !["user", "bot"].includes(role)) return NextResponse.json({ ok: false, error: "role must be 'user' or 'bot'" }, { status: 400 });
  if (!text || typeof text !== "string") return NextResponse.json({ ok: false, error: "text required" }, { status: 400 });

  const nowISO = new Date().toISOString();
  // Name is the primary field — populate with a readable snippet so the
  // Airtable UI shows useful row identifiers instead of empty strings.
  const nameSnippet = text.slice(0, 60).replace(/\s+/g, " ").trim();
  const fields = {
    Name: `${role}: ${nameSnippet}`.slice(0, 100),
    Role: role,
    Text: text.slice(0, 100000),
    "Created At": nowISO,
  };
  if (intent) fields.Intent = String(intent).slice(0, 200);
  if (actionType) fields["Action Type"] = String(actionType).slice(0, 200);
  if (actionResult) {
    fields["Action Result"] = typeof actionResult === "string"
      ? actionResult.slice(0, 50000)
      : JSON.stringify(actionResult).slice(0, 50000);
  }

  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Sidekick Chat")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: false, error: "Sidekick Chat fields missing. Run POST /api/setup-fix.", needsSetup: true }, { status: 412 });
      }
      if (r.status === 404 || (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"))) {
        return NextResponse.json({ ok: false, error: "Sidekick Chat table not found. Run POST /api/setup-fix to create it.", needsSetup: true }, { status: 412 });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }
    const data = await r.json();
    return NextResponse.json({ ok: true, id: data.id, createdAt: nowISO });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
