import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK MESSAGES-FEED
// GET /api/sidekick/messages-feed?baseId=X&limit=20
//
// Returns AI-drafted LinkedIn invitations + DMs that already went out via
// Unipile and need a human approve/flag decision. Source: "Sent Messages
// Review" table in the campaign base (Status = 'needs_review').
//
// This is the chatbot side of SignalScope's outreach engine — the engine
// generates personalized connection notes + DM sequences with AI, sends
// them via Unipile, and logs each send here for human review.
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

function formatReviewCard(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    lead_name: f["Lead Name"] || "",
    company: f.Company || "",
    lead_title: f.Title || "",
    lead_linkedin: f["LinkedIn URL"] || "",
    message_type: f["Message Type"] || "",
    template_used: f["Template Used"] || "",
    ai_message: f["AI Output (Sent)"] || "",
    ai_input_context: f["AI Input Context"] || "",
    campaign: f.Campaign || "",
    unipile_chat_id: f["Unipile Chat ID"] || "",
    sent_at: f["Sent At"] || "",
    account_id: f["Account ID"] || "",
  };
}

const PENDING_REVIEW_FILTER = `{Status} = 'needs_review'`;

export async function GET(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  const limit = Math.min(50, parseInt(url.searchParams.get("limit") || "20", 10));

  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  try {
    const at = `${AT_API}/${baseId}/${encodeURIComponent("Sent Messages Review")}?filterByFormula=${encodeURIComponent(PENDING_REVIEW_FILTER)}&sort[0][field]=Sent%20At&sort[0][direction]=desc&pageSize=${limit}`;
    const r = await fetch(at, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, count: 0, messages: [], note: "Sent Messages Review table doesn't exist yet" });
      }
      if (r.status === 404) {
        return NextResponse.json({ ok: true, count: 0, messages: [] });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}`, detail: errText.slice(0, 300) }, { status: 502 });
    }
    const data = await r.json();
    const messages = (data.records || []).map(formatReviewCard);
    return NextResponse.json({ ok: true, count: messages.length, messages });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
