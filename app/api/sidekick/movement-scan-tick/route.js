import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK MOVEMENT-SCAN-TICK
// POST /api/sidekick/movement-scan-tick
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Called by GitHub Actions cron every 5 minutes. Behaviour:
//   1. Find the oldest row in Movement Scan Runs where State = 'running'
//   2. If none: return { ok: true, idle: true } — cron has nothing to do
//   3. If one found: call /api/scan-leads with its baseId + campaignId
//      to run ONE batch (~200 leads, ~270s budgeted internally)
//   4. Update the run row with cumulative stats
//   5. If batch returns done=true → State='done', Completed At=now
//      If batch fatalError → State='error'
//      Else → keep running, cron picks up again next tick
//   6. Write a row to Cron Run Log (master) for operator visibility
//
// Only processes ONE active scan per tick. Multiple concurrent campaigns
// would serialize across ticks (one per 5 min).
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Append a row to Cron Run Log — operator visibility
async function logTick({ status, details, durationMs, errorsCount = 0 }) {
  try {
    await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Cron Run Log")}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        fields: {
          "Cron Name": "Movement Scan Tick",
          "Run At": new Date().toISOString(),
          "Trigger": "GitHub Cron",
          "Status": status,
          "Duration ms": durationMs,
          "Errors Count": errorsCount,
          "Details": details,
        },
        typecast: true,
      }),
    });
  } catch (e) {
    console.warn("[movement-scan-tick] failed to write Cron Run Log:", e.message);
  }
}

export async function POST(request) {
  const tickStartedAt = Date.now();

  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID" }, { status: 500 });
  }

  try {
    // ─── 1. Find oldest running scan ─────────────────────────────
    const runRes = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}?filterByFormula=${encodeURIComponent(`{State} = 'running'`)}&sort[0][field]=Started%20At&sort[0][direction]=asc&pageSize=1`,
      { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
    );
    if (!runRes.ok) {
      const errText = await runRes.text();
      // Table doesn't exist → idle (nothing has been started yet)
      if (runRes.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, idle: true, note: "Movement Scan Runs table doesn't exist yet — no scans have been started" });
      }
      if (runRes.status === 404) {
        return NextResponse.json({ ok: true, idle: true, note: "Movement Scan Runs table not found" });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${runRes.status}`, detail: errText.slice(0, 300) }, { status: 502 });
    }
    const runData = await runRes.json();
    const activeRun = runData.records?.[0];
    if (!activeRun) {
      // Idle — no logging, no work, just return. Keeps Cron Run Log clean.
      return NextResponse.json({ ok: true, idle: true, message: "No active scans" });
    }

    const runId = activeRun.id;
    const rf = activeRun.fields || {};
    const baseId = rf["Base ID"];
    const campaignId = rf["Campaign ID"];
    const batchesRunSoFar = rf["Batches Run"] || 0;
    const totalProcessedSoFar = rf["Total Processed"] || 0;
    const totalTasksCreatedSoFar = rf["Total Tasks Created"] || 0;
    const totalCostSoFar = rf["Total Cost USD"] || 0;
    const hiredSoFar = rf["Hired Count"] || 0;
    const promotedSoFar = rf["Promoted Count"] || 0;
    const exitedSoFar = rf["Exited Count"] || 0;

    if (!baseId || !campaignId) {
      // Malformed run row — mark as error
      await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}/${runId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: { State: "error", Error: "Run row missing Base ID or Campaign ID", "Completed At": new Date().toISOString() },
          typecast: true,
        }),
      });
      await logTick({
        status: "error",
        details: `Run ${runId} malformed (missing Base ID or Campaign ID)`,
        durationMs: Date.now() - tickStartedAt,
        errorsCount: 1,
      });
      return NextResponse.json({ ok: false, error: "Active run is malformed; marked as error" }, { status: 500 });
    }

    // ─── 2. Run one batch via /api/scan-leads ────────────────────
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const scanRes = await fetch(`${origin}/api/scan-leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "scan",
        baseId,
        campaignId,
        batchSize: 200,
        freshnessSkipDays: 7,
        movementWindowDays: 90,
      }),
      cache: "no-store",
    });
    if (!scanRes.ok) {
      const errText = await scanRes.text();
      // Mark run as error
      await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}/${runId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          fields: {
            State: "error",
            Error: `scan-leads HTTP ${scanRes.status}: ${errText.slice(0, 500)}`,
            "Last Tick At": new Date().toISOString(),
            "Completed At": new Date().toISOString(),
          },
          typecast: true,
        }),
      });
      await logTick({
        status: "error",
        details: `Run ${runId} → scan-leads HTTP ${scanRes.status}`,
        durationMs: Date.now() - tickStartedAt,
        errorsCount: 1,
      });
      return NextResponse.json({ ok: false, error: `scan-leads HTTP ${scanRes.status}`, runId }, { status: 502 });
    }
    const batch = await scanRes.json();

    // ─── 3. Update run row ───────────────────────────────────────
    const newBatchesRun = batchesRunSoFar + 1;
    const newTotalProcessed = totalProcessedSoFar + (batch.processedCount || batch.processed?.total || 0);
    const newTotalTasksCreated = totalTasksCreatedSoFar + (batch.tasksCreated || 0);
    const newTotalCost = Math.round((totalCostSoFar + (batch.costUSD || 0)) * 10000) / 10000;
    const newHired = hiredSoFar + (batch.processed?.hired || 0);
    const newPromoted = promotedSoFar + (batch.processed?.promoted || 0);
    const newExited = exitedSoFar + (batch.processed?.exited || 0);

    const isDone = !!batch.done;
    const isFatal = !!batch.fatalError;
    const newState = isFatal ? "error" : (isDone ? "done" : "running");

    // Non-fatal errors (Airtable 422 on Tasks create, schema setup hiccups,
    // pagination retries) used to be swallowed at this layer — the operator
    // saw a green tick reading "2 promoted · 0 tasks created" with no way
    // to know WHY. Now we surface up to 3 of them inline in the batch
    // summary and write the most recent error to the Movement Scan Runs
    // row's Error field so it's visible without code-diving.
    const batchErrors = Array.isArray(batch.errors) ? batch.errors.filter(Boolean) : [];
    const tasksDetected = (batch.processed?.hired || 0) + (batch.processed?.promoted || 0) + (batch.processed?.exited || 0);
    const tasksLost = tasksDetected - (batch.tasksCreated || 0);
    const writeFailureDetected = tasksLost > 0;

    const batchSummary = [
      `Batch ${newBatchesRun}: ${batch.processedCount || 0}/${batch.batchSize || 0} leads`,
      batch.processed?.hired ? `${batch.processed.hired} hired` : null,
      batch.processed?.promoted ? `${batch.processed.promoted} promoted` : null,
      batch.processed?.exited ? `${batch.processed.exited} exited` : null,
      `${batch.tasksCreated || 0} task(s) created`,
      writeFailureDetected ? `⚠️ ${tasksLost} task(s) DETECTED BUT NOT WRITTEN — check Error field` : null,
      `$${(batch.costUSD || 0).toFixed(4)}`,
      batch.timedOut ? "TIMED OUT (re-running next tick)" : null,
      isDone ? "DONE — all leads scanned" : null,
      batchErrors.length > 0 ? `Errors: ${batchErrors.slice(0, 3).join(" | ")}` : null,
    ].filter(Boolean).join(" · ");

    const patchFields = {
      State: newState,
      "Last Tick At": new Date().toISOString(),
      "Batches Run": newBatchesRun,
      "Total Processed": newTotalProcessed,
      "Total Tasks Created": newTotalTasksCreated,
      "Total Cost USD": newTotalCost,
      "Hired Count": newHired,
      "Promoted Count": newPromoted,
      "Exited Count": newExited,
      "Latest Batch Summary": batchSummary,
    };
    if (isDone || isFatal) patchFields["Completed At"] = new Date().toISOString();
    if (isFatal) {
      patchFields["Error"] = batch.fatalError;
    } else if (writeFailureDetected || batchErrors.length > 0) {
      // Non-fatal but worth surfacing — populate Error field without
      // changing State (scan continues). First Airtable error usually
      // reveals the schema issue (e.g., "createTasks 422: UNKNOWN_FIELD_NAME").
      patchFields["Error"] = batchErrors.length > 0
        ? `${tasksLost > 0 ? `${tasksLost} task(s) lost. ` : ""}First error: ${batchErrors[0]}`
        : `${tasksLost} movement(s) detected but task(s) not written. Check Tasks table schema in this base (likely missing Movement Type, Lead Title, Email, or Phone field).`;
    }

    await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}/${runId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: patchFields, typecast: true }),
    });

    // ─── 4. Cron Run Log entry ──────────────────────────────────
    await logTick({
      status: isFatal ? "error" : (isDone ? "complete" : "in_progress"),
      details: [
        `Run: ${runId} (campaign: ${campaignId.slice(0, 12)}...)`,
        batchSummary,
        `Cumulative: ${newTotalProcessed} leads, ${newTotalTasksCreated} tasks, $${newTotalCost.toFixed(4)}`,
        `Movements so far: ${newHired}H / ${newPromoted}P / ${newExited}E`,
      ].join("\n"),
      durationMs: Date.now() - tickStartedAt,
      errorsCount: (batch.errors?.length || 0) + (isFatal ? 1 : 0),
    });

    return NextResponse.json({
      ok: true,
      runId,
      state: newState,
      batchesRun: newBatchesRun,
      totalProcessed: newTotalProcessed,
      totalTasksCreated: newTotalTasksCreated,
      latestBatch: {
        processedCount: batch.processedCount || 0,
        tasksCreated: batch.tasksCreated || 0,
        timedOut: !!batch.timedOut,
        done: isDone,
        costUSD: batch.costUSD || 0,
      },
      durationMs: Date.now() - tickStartedAt,
    });
  } catch (e) {
    await logTick({
      status: "error",
      details: `Tick threw: ${e.message}`,
      durationMs: Date.now() - tickStartedAt,
      errorsCount: 1,
    });
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
