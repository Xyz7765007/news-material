import { NextResponse } from "next/server";

// POST /api/sidekick/message-action
// Body: { baseId, messageId, action: "approve" | "flag", notes? }
// Patches Sent Messages Review row → Status="approved"|"flagged".

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

  let body = {};
  try { body = await request.json(); } catch { /* empty ok */ }
  const { baseId, messageId, action, notes } = body || {};

  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  if (!messageId) return NextResponse.json({ ok: false, error: "messageId required" }, { status: 400 });
  if (!["approve", "flag"].includes(action)) return NextResponse.json({ ok: false, error: "action must be 'approve' or 'flag'" }, { status: 400 });

  const patch = {
    Status: action === "approve" ? "approved" : "flagged",
    "Reviewed At": new Date().toISOString(),
  };
  if (notes && typeof notes === "string") patch["Reviewer Notes"] = notes.slice(0, 2000);

  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Sent Messages Review")}/${messageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: patch, typecast: true }),
      cache: "no-store",
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: `Airtable ${r.status}` }, { status: 502 });
    return NextResponse.json({ ok: true, messageId, status: patch.Status });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
