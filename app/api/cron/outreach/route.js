import { NextResponse } from "next/server";

// Force dynamic so Next.js doesn't cache the response. Without this,
// Vercel's cron logs view may not show invocations because cached responses
// are not logged as fresh invocations.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Vercel Cron — runs daily at 6am UTC (11:30am IST) to process outreach queues.
// Hobby plan limit: 1 invocation per day. Pro plan can change schedule to
// "0 */4 * * *" (every 4 hours) or finer.
//
// MANUAL TRIGGER: hit GET /api/cron/outreach?manual=1&key=<CRON_SECRET>
// in your browser to force-run the cron logic immediately (useful for
// debugging "is the cron actually working?" without waiting until 11:30 IST).

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;
const AT_API = "https://api.airtable.com/v0";
const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

// Every cron invocation is logged to "Cron Run Log" in the master base.
// This gives a persistent history visible in the UI alongside Vercel's own
// cron logs (which expire on Hobby plan).
async function logRun(summary) {
  if (!MASTER_BASE_ID || !AIRTABLE_KEY) return;
  try {
    const fields = {
      "Cron Name": "outreach",
      "Run At": new Date().toISOString(),
      "Trigger": summary.trigger || "scheduled",
      "Status": summary.status || "unknown",
      "Duration ms": summary.durationMs || 0,
      "Campaigns Checked": summary.campaignsChecked || 0,
      "Outreach Rules Found": summary.outreachRulesFound || 0,
      "Active Rules": summary.activeRules || 0,
      "Connections Sent": summary.connectionsSent || 0,
      "DMs Sent": summary.dmsSent || 0,
      "Errors Count": (summary.errors || []).length,
      "Details": JSON.stringify({
        perCampaign: summary.perCampaign,
        errors: summary.errors,
        skipReasons: summary.skipReasons,
      }).slice(0, 50000),
    };
    const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Cron Run Log")}`, {
      method: "POST", headers: atHdr,
      body: JSON.stringify({ fields, typecast: true }),
    });
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 404 || t.includes("NOT_FOUND") || t.includes("Could not find")) {
        try {
          await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000"}/api/airtable`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "ensure_fields", table: "Cron Run Log", baseId: MASTER_BASE_ID,
              fieldNames: Object.keys(fields),
            }),
          });
          await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Cron Run Log")}`, {
            method: "POST", headers: atHdr,
            body: JSON.stringify({ fields, typecast: true }),
          });
        } catch {}
      } else {
        console.warn(`[CRON] Failed to log run: ${t.slice(0, 200)}`);
      }
    }
  } catch (e) {
    console.warn(`[CRON] Run log failed (non-fatal): ${e.message}`);
  }
}

export async function GET(request) {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const isManual = url.searchParams.get("manual") === "1";
  const manualKey = url.searchParams.get("key");

  // Auth: support both Vercel cron header AND manual key query param
  const authHeader = request.headers.get("authorization");
  const vercelAuthed = authHeader === `Bearer ${CRON_SECRET}`;
  const manualAuthed = isManual && manualKey === CRON_SECRET;

  if (!vercelAuthed && !manualAuthed) {
    return NextResponse.json({
      error: "Unauthorized",
      hint: "Scheduled cron uses Authorization header (set by Vercel). For manual testing, use ?manual=1&key=<CRON_SECRET>",
    }, { status: 401 });
  }

  const trigger = manualAuthed ? "manual" : "scheduled";
  console.log(`[CRON] Outreach processing started (${trigger})`);

  if (!MASTER_BASE_ID || !AIRTABLE_KEY) {
    const summary = {
      trigger, status: "config_error",
      errors: ["AIRTABLE_BASE_ID or AIRTABLE_API_KEY env var missing"],
      durationMs: Date.now() - startedAt,
    };
    await logRun(summary);
    return NextResponse.json({ ok: false, ...summary }, { status: 500 });
  }

  const summary = {
    trigger,
    campaignsChecked: 0,
    outreachRulesFound: 0,
    activeRules: 0,
    connectionsSent: 0,
    dmsSent: 0,
    perCampaign: [],
    errors: [],
    skipReasons: [],
  };

  try {
    // ─── Load campaigns from master base ─────────────────────────
    const campRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}`, { headers: atHdr });
    if (!campRes.ok) {
      const t = await campRes.text();
      summary.status = "campaigns_load_failed";
      summary.errors.push(`Could not load Campaigns table from master base: HTTP ${campRes.status} — ${t.slice(0, 200)}`);
      summary.durationMs = Date.now() - startedAt;
      await logRun(summary);
      return NextResponse.json({ ok: false, ...summary }, { status: 500 });
    }
    const { records: campaigns } = await campRes.json();
    summary.campaignsChecked = (campaigns || []).length;

    if (summary.campaignsChecked === 0) {
      summary.status = "no_campaigns";
      summary.skipReasons.push("Campaigns table is empty in master base. Add at least one campaign with linkedin_outreach in its Features field.");
      summary.durationMs = Date.now() - startedAt;
      await logRun(summary);
      return NextResponse.json({ ok: true, ...summary });
    }

    // ─── For each outreach campaign, process active rules ────────
    for (const camp of campaigns) {
      const cf = camp.fields || {};
      const baseId = cf["Base ID"];
      const features = (cf.Features || "").split(",").map(s => s.trim());

      if (!baseId) {
        summary.skipReasons.push(`Campaign "${cf.Name || camp.id}" has no Base ID — skipped`);
        continue;
      }
      if (!features.includes("linkedin_outreach")) {
        continue; // silently skip non-outreach campaigns
      }

      const campRecord = { name: cf.Name || camp.id, baseId, rulesActive: 0, rulesTotal: 0, errors: [] };

      let rulesData;
      try {
        const rulesRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Task Rules")}`, { headers: atHdr });
        if (!rulesRes.ok) {
          const t = await rulesRes.text();
          campRecord.errors.push(`Task Rules table load failed: HTTP ${rulesRes.status} — ${t.slice(0, 150)}`);
          summary.perCampaign.push(campRecord);
          continue;
        }
        rulesData = await rulesRes.json();
      } catch (e) {
        campRecord.errors.push(`Network error loading Task Rules: ${e.message}`);
        summary.perCampaign.push(campRecord);
        continue;
      }

      const rules = rulesData.records || [];
      const outreachRules = rules.filter(r => (r.fields || {})["Task Type"] === "linkedin_outreach");
      campRecord.rulesTotal = outreachRules.length;
      summary.outreachRulesFound += outreachRules.length;

      for (const rule of outreachRules) {
        const rf = rule.fields || {};
        let config;
        try { config = JSON.parse(rf["Outreach Config"] || "{}"); }
        catch (e) {
          campRecord.errors.push(`Rule "${rf.Name}": Outreach Config is malformed JSON — ${e.message}`);
          continue;
        }
        if (!config.accountId) {
          campRecord.errors.push(`Rule "${rf.Name}": missing accountId (LinkedIn account not selected)`);
          continue;
        }
        if (!config.active) continue;

        campRecord.rulesActive++;
        summary.activeRules++;
        console.log(`[CRON] Processing rule "${rf.Name}" in campaign "${cf.Name}"`);

        try {
          const processRes = await fetch(new URL("/api/outreach", request.url).toString(), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "process_queue",
              baseId,
              campaignId: camp.id,
              accountId: config.accountId,
              ruleConfig: { ...config, name: rf.Name },
            }),
          });
          const result = await processRes.json().catch(() => ({}));
          if (!processRes.ok) {
            campRecord.errors.push(`Rule "${rf.Name}": process_queue HTTP ${processRes.status} — ${(result.error || "unknown").toString().slice(0, 200)}`);
            continue;
          }
          summary.connectionsSent += (result.connectionsSent || 0);
          summary.dmsSent += (result.dmsSent || 0);
          campRecord[`rule_${rf.Name}`] = {
            connectionsSent: result.connectionsSent || 0,
            dmsSent: result.dmsSent || 0,
            errors: result.errors || 0,
            log: (result.log || []).slice(0, 20),
          };
          console.log(`[CRON] "${rf.Name}" done: ${result.connectionsSent || 0} conn, ${result.dmsSent || 0} DMs, ${result.errors || 0} err`);
        } catch (e) {
          campRecord.errors.push(`Rule "${rf.Name}": ${e.message}`);
        }
      }

      summary.perCampaign.push(campRecord);
    }

    if (summary.activeRules === 0) {
      summary.status = "no_active_rules";
      summary.skipReasons.push("No active outreach rules found across any campaign. Create a rule with active=true in its Outreach Config.");
    } else if (summary.errors.length > 0 || summary.perCampaign.some(c => c.errors.length > 0)) {
      summary.status = "completed_with_errors";
    } else {
      summary.status = "success";
    }
    summary.durationMs = Date.now() - startedAt;

    console.log(`[CRON] Done in ${summary.durationMs}ms. Status: ${summary.status}. ${summary.connectionsSent} conn, ${summary.dmsSent} DMs across ${summary.activeRules} rules.`);
    await logRun(summary);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    summary.status = "fatal_error";
    summary.errors.push(`Fatal: ${error.message}`);
    summary.durationMs = Date.now() - startedAt;
    console.error("[CRON] Fatal error:", error);
    await logRun(summary);
    return NextResponse.json({ ok: false, ...summary }, { status: 500 });
  }
}
