import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK MOVEMENT-SCAN-START
// POST /api/sidekick/movement-scan-start
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Body:
//   {
//     baseId: "appXYZ...",         // campaign base ID
//     batchSize?: 200,             // leads per tick, default 200
//     movementWindowDays?: 90,     // movement detection window
//     freshnessSkipDays?: 7        // skip leads scanned within N days
//   }
//
// Creates a new row in Movement Scan Runs (master base) with State=running.
// Does NOT run a batch directly — the GitHub Actions cron picks up running
// rows every 5 min and calls /api/sidekick/movement-scan-tick to process them.
//
// If a scan is already running for this baseId, returns 409 conflict with
// the existing run info (no duplicates).
//
// Returns: { ok, runId, startedAt, message }
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
  try { body = await request.json(); } catch { /* allow empty */ }
  const { baseId, batchSize = 200, movementWindowDays = 90, freshnessSkipDays = 7 } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  try {
    // ─── 1. Look up campaignId from master base ──────────────────
    let campaignId = null;
    let campaignName = "unknown";
    const campsRes = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}?filterByFormula=${encodeURIComponent(`{Base ID} = '${baseId}'`)}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
    );
    if (campsRes.ok) {
      const cd = await campsRes.json();
      if (cd.records?.length) {
        campaignId = cd.records[0].id;
        campaignName = cd.records[0].fields?.Name || "unknown";
      }
    }
    if (!campaignId) {
      return NextResponse.json({ ok: false, error: `No campaign found in master base for baseId ${baseId}` }, { status: 404 });
    }

    // ─── 2. Check for existing running scan ──────────────────────
    const existingRes = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}?filterByFormula=${encodeURIComponent(`AND({Base ID} = '${baseId}', {State} = 'running')`)}&pageSize=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
    );
    if (existingRes.ok) {
      const ed = await existingRes.json();
      if (ed.records?.length > 0) {
        const existing = ed.records[0];
        return NextResponse.json({
          ok: false,
          error: "A movement scan is already running for this campaign",
          existingRunId: existing.id,
          existingStartedAt: existing.fields?.["Started At"],
          batchesRun: existing.fields?.["Batches Run"] || 0,
          totalProcessed: existing.fields?.["Total Processed"] || 0,
        }, { status: 409 });
      }
    }

    // ─── 3. Create the run row ───────────────────────────────────
    const nowISO = new Date().toISOString();
    const fields = {
      Name: `Movement Scan — ${campaignName} — ${nowISO.slice(0, 16).replace("T", " ")}`,
      "Campaign ID": campaignId,
      "Base ID": baseId,
      State: "running",
      "Started At": nowISO,
      "Batches Run": 0,
      "Total Processed": 0,
      "Total Tasks Created": 0,
      "Total Cost USD": 0,
      "Hired Count": 0,
      "Promoted Count": 0,
      "Exited Count": 0,
    };

    const createRes = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields, typecast: true }),
      }
    );
    if (!createRes.ok) {
      const errText = await createRes.text();
      if (errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND") || createRes.status === 404) {
        return NextResponse.json({
          ok: false,
          error: "Movement Scan Runs table not found in master base. Run POST /api/setup-fix to create it.",
          needsSetup: true,
        }, { status: 412 });
      }
      if (errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({
          ok: false,
          error: "Movement Scan Runs schema missing fields. Run POST /api/setup-fix.",
          needsSetup: true,
        }, { status: 412 });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${createRes.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }
    const created = await createRes.json();

    return NextResponse.json({
      ok: true,
      runId: created.id,
      campaignId,
      campaignName,
      startedAt: nowISO,
      config: { batchSize, movementWindowDays, freshnessSkipDays },
      message: "Movement scan queued. First batch will run on the next cron tick (within 5 min). Poll /api/sidekick/movement-scan-status to track progress.",
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
