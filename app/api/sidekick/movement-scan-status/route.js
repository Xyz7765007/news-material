import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK MOVEMENT-SCAN-STATUS
//
// GET /api/sidekick/movement-scan-status            ← multi-tenant mode
// GET /api/sidekick/movement-scan-status?baseId=X   ← single-base mode (legacy)
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Behavior:
//   - With baseId: returns the latest run for that base (original behavior)
//   - Without baseId: returns the latest RUNNING run across ALL bases.
//     If no scans are currently running, falls back to the most recently
//     started run regardless of state — so the banner can briefly show
//     "done" after completion. If no runs exist at all, returns null.
//
//   When a run is returned, the response is enriched with campaign
//   metadata (campaignName, baseId) so the chatbot's banner can show
//   which client the scan is for — "Veloka scan: 50/200", "Material
//   scan: 50/200", etc. — without the chatbot needing its own copy of
//   the campaign list.
//
//   If multiple scans are running concurrently across different bases,
//   only the most recently started one is returned, but the response
//   includes concurrentRunsCount so the UI can render "+N more" or
//   stack banners as needed.
//
// Response shape:
//   {
//     ok: true,
//     run: {
//       id, baseId, campaignName, state, startedAt, lastTickAt,
//       completedAt, batchesRun, totalProcessed, totalTasksCreated,
//       totalCostUSD, hired, promoted, exited,
//       latestBatchSummary, error,
//     } | null,
//     concurrentRunsCount: number  // total running scans (incl. the returned one)
//   }
//
// Multi-tenant rollout path:
//   1. Today: Veloka is the only base scanning → endpoint returns Veloka
//   2. Tomorrow: scan starts on Material's base → endpoint returns whichever
//      started most recently
//   3. Future: chatbot can optionally pass baseId to lock the banner to a
//      specific client's scan (e.g. operator focused on Material wants to
//      ignore Veloka's background scan)
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

function atHdr() {
  return { Authorization: `Bearer ${AIRTABLE_KEY}` };
}

// ─── Campaign name resolver ─────────────────────────────────────────
// Looks up Campaigns table by Base ID and returns the campaign name.
// In-memory cache keyed by baseId, 5-minute TTL — the campaign list
// rarely changes during a single chatbot session, so caching keeps
// this endpoint fast under the chatbot's 20-60s polling cadence.
const campaignNameCache = new Map(); // baseId -> { name, expiresAt }
const CAMPAIGN_CACHE_TTL_MS = 5 * 60 * 1000;

async function resolveCampaignName(baseId) {
  if (!baseId) return null;
  const now = Date.now();
  const cached = campaignNameCache.get(baseId);
  if (cached && cached.expiresAt > now) return cached.name;
  try {
    const r = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}?filterByFormula=${encodeURIComponent(`{Base ID} = '${baseId}'`)}&pageSize=1`,
      { headers: atHdr(), cache: "no-store" }
    );
    if (!r.ok) return null;
    const data = await r.json();
    const f = data.records?.[0]?.fields || {};
    // Try common name fields — different setups use different conventions
    const name = f.Name || f["Campaign Name"] || f["Client Name"] || null;
    if (name) {
      campaignNameCache.set(baseId, { name, expiresAt: now + CAMPAIGN_CACHE_TTL_MS });
    }
    return name;
  } catch {
    return null;
  }
}

// ─── Run record → response shape ────────────────────────────────────
function recordToRun(rec, campaignName) {
  const f = rec.fields || {};
  return {
    id: rec.id,
    baseId: f["Base ID"] || null,
    campaignName: campaignName || null,
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
  };
}

// Helper: list Movement Scan Runs with a custom filter formula
async function listRuns(filterFormula, pageSize = 10) {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    "sort[0][field]": "Started At",
    "sort[0][direction]": "desc",
  });
  if (filterFormula) params.set("filterByFormula", filterFormula);
  const r = await fetch(
    `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Movement Scan Runs")}?${params}`,
    { headers: atHdr(), cache: "no-store" }
  );
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
      return { tableMissing: true, records: [] };
    }
    if (r.status === 404) return { records: [] };
    throw new Error(`Airtable ${r.status}: ${errText.slice(0, 200)}`);
  }
  const data = await r.json();
  return { records: data.records || [] };
}

export async function GET(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return NextResponse.json(
      { ok: false, error: "Server missing AIRTABLE_API_KEY or AIRTABLE_BASE_ID" },
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");

  try {
    // ─── Single-base mode (legacy/explicit) ────────────────────────
    if (baseId) {
      const result = await listRuns(`{Base ID} = '${baseId}'`, 1);
      if (result.tableMissing) {
        return NextResponse.json({
          ok: true,
          run: null,
          concurrentRunsCount: 0,
          note: "Movement Scan Runs table doesn't exist yet",
        });
      }
      const rec = result.records[0];
      if (!rec) {
        return NextResponse.json({ ok: true, run: null, concurrentRunsCount: 0 });
      }
      const campaignName = await resolveCampaignName(rec.fields?.["Base ID"]);
      return NextResponse.json({
        ok: true,
        run: recordToRun(rec, campaignName),
        concurrentRunsCount: rec.fields?.State === "running" ? 1 : 0,
      });
    }

    // ─── Multi-tenant mode ─────────────────────────────────────────
    // Priority 1: any run currently in `running` state, newest first
    const running = await listRuns(`{State} = 'running'`, 10);
    if (running.tableMissing) {
      return NextResponse.json({
        ok: true,
        run: null,
        concurrentRunsCount: 0,
        note: "Movement Scan Runs table doesn't exist yet",
      });
    }
    if (running.records.length > 0) {
      const rec = running.records[0];
      const campaignName = await resolveCampaignName(rec.fields?.["Base ID"]);
      return NextResponse.json({
        ok: true,
        run: recordToRun(rec, campaignName),
        concurrentRunsCount: running.records.length,
      });
    }

    // Priority 2: no active scan — return the most recent run regardless
    // of state, so the banner can briefly surface "done" after completion
    // (chatbot already has logic to fade the banner ~10s after state=done).
    const recent = await listRuns("", 1);
    const rec = recent.records[0];
    if (!rec) {
      return NextResponse.json({ ok: true, run: null, concurrentRunsCount: 0 });
    }
    const campaignName = await resolveCampaignName(rec.fields?.["Base ID"]);
    return NextResponse.json({
      ok: true,
      run: recordToRun(rec, campaignName),
      concurrentRunsCount: 0,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e.message || "Unknown error" },
      { status: 500 }
    );
  }
}
