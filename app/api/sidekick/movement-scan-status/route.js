import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK MOVEMENT-SCAN-STATUS
// GET /api/sidekick/movement-scan-status?baseId=X
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Returns the latest Movement Scan Run row for this baseId (any state),
// so the chatbot UI can show a live progress banner while State=running
// and a brief "done" indicator after completion.
//
// Response shape:
//   {
//     ok: true,
//     run: {
//       id, state, startedAt, lastTickAt, completedAt,
//       batchesRun, totalProcessed, totalTasksCreated, totalCostUSD,
//       hired, promoted, exited,
//       latestBatchSummary, error
//     } | null
//   }
//
// If no run exists for this baseId, returns run: null (chatbot hides banner).
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

export async function GET(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID" }, { status: 500 });
  }

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  try {
    // Get latest run for this baseId (any state). Newest first.
    const r = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}?filterByFormula=${encodeURIComponent(`{Base ID} = '${baseId}'`)}&sort[0][field]=Started%20At&sort[0][direction]=desc&pageSize=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
    );
    if (!r.ok) {
      const errText = await r.text();
      // Table doesn't exist — never scanned. Treat as no run.
      if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, run: null, note: "Movement Scan Runs table doesn't exist yet" });
      }
      if (r.status === 404) {
        return NextResponse.json({ ok: true, run: null });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}` }, { status: 502 });
    }
    const data = await r.json();
    const rec = data.records?.[0];
    if (!rec) return NextResponse.json({ ok: true, run: null });

    const f = rec.fields || {};
    return NextResponse.json({
      ok: true,
      run: {
        id: rec.id,
        state: f.State || "unknown",
        startedAt: f["Started At"] || null,
        lastTickAt: f["Last Tick At"] || null,
        completedAt: f["Completed At"] || null,
        batchesRun: f["Batches Run"] || 0,
        totalProcessed: f["Total Processed"] || 0,
        totalTasksCreated: f["Total Tasks Created"] || 0,
        totalCostUSD: f["Total Cost USD"] || 0,
        hired: f["Hired Count"] || 0,
        promoted: f["Promoted Count"] || 0,
        exited: f["Exited Count"] || 0,
        latestBatchSummary: f["Latest Batch Summary"] || "",
        error: f["Error"] || "",
      },
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
