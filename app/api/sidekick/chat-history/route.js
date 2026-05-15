import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK CHAT HISTORY ENDPOINT
// GET /api/sidekick/chat-history?baseId=X&limit=20
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Returns the N most recent chat messages in chronological order
// (oldest first) for the chatbot to:
//   1. Restore the chat thread on page reload
//   2. Pass to Claude as context for multi-session continuity
//
// Sorted by Created At desc internally, then reversed before return.
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
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "20", 10) || 20, 100);

  const params = new URLSearchParams({
    "sort[0][field]": "Created At",
    "sort[0][direction]": "desc",
    pageSize: String(limit),
  });

  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Sidekick Chat")}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      // Table doesn't exist yet — return empty (fresh deploy)
      if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, messages: [], note: "Sidekick Chat table not found — first run" });
      }
      if (r.status === 404) {
        return NextResponse.json({ ok: true, messages: [], note: "Sidekick Chat table not found" });
      }
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: false, error: "Sidekick Chat fields missing. Run POST /api/setup-fix.", needsSetup: true }, { status: 412 });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}` }, { status: 502 });
    }
    const data = await r.json();
    // Sort desc gave us newest-first; reverse for chronological (oldest first)
    const messages = (data.records || [])
      .map(rec => {
        const f = rec.fields || {};
        let parsedResult = null;
        if (f["Action Result"]) {
          try { parsedResult = JSON.parse(f["Action Result"]); }
          catch { parsedResult = f["Action Result"]; }
        }
        return {
          id: rec.id,
          role: f.Role || "bot",
          text: f.Text || "",
          intent: f.Intent || null,
          action_type: f["Action Type"] || null,
          action_result: parsedResult,
          created_at: f["Created At"] || null,
        };
      })
      .reverse(); // oldest first

    return NextResponse.json({ ok: true, count: messages.length, messages });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
