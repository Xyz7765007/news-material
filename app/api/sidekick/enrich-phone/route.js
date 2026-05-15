import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK ENRICH-PHONE ENDPOINT
// POST /api/sidekick/enrich-phone
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Body:
//   { baseId: "appXYZ...", taskId: "recXYZ..." }
//
// Workflow:
//   1. Read the Task row to get the lead's identifying info (name, company,
//      linkedin URL, email).
//   2. Self-fetch /api/enrich with action=enrich_single → calls Apollo.
//   3. If Apollo returns a phone, PATCH the Task row with Phone field.
//   4. Return the phone (or empty if not found) so the chatbot can update.
//
// Costs Apollo credits each call — only invoke on user click.
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

  const { baseId, taskId } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  if (!taskId) return NextResponse.json({ ok: false, error: "taskId required" }, { status: 400 });

  try {
    // ─── 1. Read the task to get the lead's identity ─────────────
    const taskRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}/${taskId}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!taskRes.ok) {
      return NextResponse.json({ ok: false, error: `Task not found (HTTP ${taskRes.status})` }, { status: 404 });
    }
    const taskData = await taskRes.json();
    const f = taskData.fields || {};
    const name = f.Name || "";
    const company = f.Company || "";
    const linkedinUrl = f["LinkedIn URL"] || f["Linkedin URL"] || "";
    const email = f.Email || "";

    if (!name && !email && !linkedinUrl) {
      return NextResponse.json({ ok: false, error: "Task has no identifying info to enrich (no name, email, or LinkedIn URL)" }, { status: 400 });
    }

    // ─── 2. Self-fetch /api/enrich for Apollo lookup ─────────────
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const enrichRes = await fetch(`${origin}/api/enrich`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "enrich_single",
        name,
        company,
        linkedinUrl,
        email,
      }),
      cache: "no-store",
    });
    if (!enrichRes.ok) {
      const errText = await enrichRes.text();
      return NextResponse.json({ ok: false, error: `Apollo enrich failed: HTTP ${enrichRes.status}`, detail: errText.slice(0, 300) }, { status: 502 });
    }
    const enrichData = await enrichRes.json();

    // Apollo response shape: { found, phone, mobile, directDial, email, title, ... }
    if (!enrichData.found) {
      return NextResponse.json({ ok: true, found: false, phone: "", note: "No match found in Apollo" });
    }

    // Pick best phone — mobile > direct dial > phone
    const bestPhone = enrichData.mobile || enrichData.directDial || enrichData.phone || "";
    if (!bestPhone) {
      return NextResponse.json({ ok: true, found: true, phone: "", note: "Apollo found the person but no phone number on record" });
    }

    // ─── 3. PATCH the task with the new phone ────────────────────
    const patchRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}/${taskId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { Phone: bestPhone }, typecast: true }),
      cache: "no-store",
    });
    if (!patchRes.ok) {
      // Phone was found but couldn't be saved — still return it so UI can use
      return NextResponse.json({ ok: true, found: true, phone: bestPhone, note: "Phone found but not saved to Airtable" });
    }

    return NextResponse.json({
      ok: true,
      found: true,
      phone: bestPhone,
      details: {
        mobile: enrichData.mobile || "",
        directDial: enrichData.directDial || "",
        landline: enrichData.phone || "",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
