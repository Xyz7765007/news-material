import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK MOVEMENT-SCAN-STOP
// POST /api/sidekick/movement-scan-stop
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Body: { baseId: "appXYZ..." }
//
// Marks the active running scan for this baseId as State=cancelled.
// Next cron tick will skip this row (no more processing). Already-scanned
// leads keep their Last LinkedIn Check stamp, so re-starting later will
// pick up where the cancel happened (freshness-skip).
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

export async function POST(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID" }, { status: 500 });
  }

  let body = {};
  try { body = await request.json(); } catch { /* empty ok */ }
  const { baseId } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  try {
    // Find the running run for this baseId
    const r = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}?filterByFormula=${encodeURIComponent(`AND({Base ID} = '${baseId}', {State} = 'running')`)}&pageSize=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
    );
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}` }, { status: 502 });
    }
    const data = await r.json();
    const run = data.records?.[0];
    if (!run) {
      return NextResponse.json({ ok: true, message: "No running scan to stop", stopped: 0 });
    }

    const patchRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}/${run.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          State: "cancelled",
          "Completed At": new Date().toISOString(),
        },
        typecast: true,
      }),
    });
    if (!patchRes.ok) {
      return NextResponse.json({ ok: false, error: `Failed to stop run: HTTP ${patchRes.status}` }, { status: 502 });
    }
    return NextResponse.json({
      ok: true,
      runId: run.id,
      stopped: 1,
      message: "Scan cancelled. Already-scanned leads retain their freshness stamp — restarting later picks up where this left off.",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
