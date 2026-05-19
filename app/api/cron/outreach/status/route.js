import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// CRON HEALTH DIAGNOSTIC
// Reads the last N entries from "Cron Run Log" in the master base.
// Public read endpoint — no secret required since logs contain only
// operational metadata (no lead PII or message bodies).
//
// Use this to answer "is the cron actually running?" without having to
// open Airtable. Returns:
//   - last 10 cron runs (or N if ?limit= param)
//   - per-run status, timestamp, trigger (scheduled/manual), counts
//   - human-readable summary at the top
//
// Endpoint: GET /api/cron/outreach/status?limit=10
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;

export async function GET(request) {
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return NextResponse.json({
      ok: false,
      error: "AIRTABLE_API_KEY or AIRTABLE_BASE_ID env var missing",
    }, { status: 500 });
  }

  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "10", 10), 50);

  try {
    // Sort by Run At descending, return top N
    const params = new URLSearchParams();
    params.set("sort[0][field]", "Run At");
    params.set("sort[0][direction]", "desc");
    params.set("pageSize", String(limit));
    params.set("filterByFormula", `{Cron Name} = 'outreach'`);

    const r = await fetch(
      `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Cron Run Log")}?${params}`,
      { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
    );

    if (!r.ok) {
      const t = await r.text();
      if (r.status === 404 || t.includes("NOT_FOUND")) {
        return NextResponse.json({
          ok: false,
          error: "Cron Run Log table doesn't exist yet — no cron runs have happened.",
          hint: "The table is auto-created on first cron run. If it's missing, the cron hasn't fired even once.",
        }, { status: 404 });
      }
      return NextResponse.json({
        ok: false,
        error: `Airtable read failed: HTTP ${r.status}`,
        details: t.slice(0, 300),
      }, { status: 500 });
    }

    const { records = [] } = await r.json();

    if (!records.length) {
      return NextResponse.json({
        ok: true,
        summary: {
          totalRuns: 0,
          lastRun: null,
          message: "No cron runs logged yet. If the cron has been deployed for >24h, it may be misconfigured.",
        },
        runs: [],
      });
    }

    const runs = records.map(r => {
      const f = r.fields || {};
      let details = null;
      try { details = JSON.parse(f.Details || "{}"); } catch {}
      return {
        runAt: f["Run At"],
        trigger: f.Trigger || "unknown",
        status: f.Status || "unknown",
        durationMs: f["Duration ms"] || 0,
        campaignsChecked: f["Campaigns Checked"] || 0,
        outreachRulesFound: f["Outreach Rules Found"] || 0,
        activeRules: f["Active Rules"] || 0,
        connectionsSent: f["Connections Sent"] || 0,
        dmsSent: f["DMs Sent"] || 0,
        errorsCount: f["Errors Count"] || 0,
        errors: details?.errors || [],
        skipReasons: details?.skipReasons || [],
        perCampaign: details?.perCampaign || [],
      };
    });

    // Build a human summary
    const last = runs[0];
    const lastScheduled = runs.find(r => r.trigger === "scheduled");
    const recentSuccesses = runs.filter(r => r.status === "success").length;
    const recentErrors = runs.filter(r => r.status === "completed_with_errors" || r.status === "fatal_error").length;
    const totalConn24h = runs
      .filter(r => r.runAt && Date.now() - new Date(r.runAt).getTime() < 24 * 3600 * 1000)
      .reduce((s, r) => s + r.connectionsSent, 0);
    const totalDms24h = runs
      .filter(r => r.runAt && Date.now() - new Date(r.runAt).getTime() < 24 * 3600 * 1000)
      .reduce((s, r) => s + r.dmsSent, 0);

    // Detect cron health.
    // Cron actually runs ~every 4 hours via GitHub Actions workflow
    // "Outreach Cron (4-hour)" (was previously documented as daily 11:30 IST
    // which is wrong). Thresholds are 1.5× / 3× the interval.
    const now = Date.now();
    const lastScheduledAge = lastScheduled
      ? Math.floor((now - new Date(lastScheduled.runAt).getTime()) / 1000 / 60)  // minutes
      : null;
    const CRON_INTERVAL_MIN = 4 * 60;        // expected: 240 min between runs
    const HEALTHY_MAX_MIN   = 6 * 60;        // 1.5× — 6h
    const WARNING_MAX_MIN   = 12 * 60;       // 3× — 12h
    let health;
    if (!lastScheduled) {
      health = { state: "no_scheduled_runs", message: "No scheduled cron runs found yet. Only manual triggers detected. GitHub Actions workflow may be misconfigured." };
    } else if (lastScheduledAge < HEALTHY_MAX_MIN) {
      health = { state: "healthy", message: `Last scheduled run ${lastScheduledAge < 60 ? lastScheduledAge + 'm' : Math.floor(lastScheduledAge/60) + 'h ' + (lastScheduledAge % 60) + 'm'} ago. Status: ${lastScheduled.status}.` };
    } else if (lastScheduledAge < WARNING_MAX_MIN) {
      health = { state: "warning", message: `Last scheduled run was ${Math.floor(lastScheduledAge/60)}h ago. Cron should run every ~4h — may be delayed.` };
    } else {
      health = { state: "stale", message: `Last scheduled run was ${Math.floor(lastScheduledAge/60)}h ago — cron appears stuck.` };
    }

    return NextResponse.json({
      ok: true,
      summary: {
        health,
        totalRuns: runs.length,
        lastRunAt: last.runAt,
        lastRunStatus: last.status,
        lastRunTrigger: last.trigger,
        recentSuccesses,
        recentErrors,
        connectionsLast24h: totalConn24h,
        dmsLast24h: totalDms24h,
        cronSchedule: "every ~4h via GitHub Actions workflow",
        cronIntervalMin: CRON_INTERVAL_MIN,
      },
      runs,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e.message,
    }, { status: 500 });
  }
}
