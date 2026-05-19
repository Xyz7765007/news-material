import { NextResponse } from "next/server";

// Force dynamic so Next.js doesn't cache the response. Without this,
// Vercel's cron logs view may not show invocations because cached responses
// are not logged as fresh invocations.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store"; // Critical: disable Next.js fetch cache so Airtable data is always fresh
export const maxDuration = 300; // Vercel Hobby plan max is 300s; upgrade to Pro for higher

// Outreach cron endpoint — hit on a schedule by the GitHub Actions workflow
// "Outreach Cron (4-hour)" in the repo at .github/workflows/outreach-cron.yml,
// which fires roughly every 4 hours (GitHub Actions cron has some delay; real
// observed cadence is ~3-5h). Each invocation iterates every campaign in the
// master Campaigns table, loads its Task Rules, and runs process_queue for
// each active linkedin_outreach rule.
//
// HISTORICAL NOTE: was previously documented as Vercel cron daily at 6am UTC
// (= 11:30 AM IST). That was inaccurate after the migration to GitHub Actions;
// kept causing operator confusion ("UI says next send at 11:30 IST but cron
// never runs at 11:30").
//
// MANUAL TRIGGER: hit GET /api/cron/outreach?manual=1&key=<CRON_SECRET>
// in your browser to force-run the cron logic immediately (useful for
// debugging "is the cron actually working?" without waiting for the next run).

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
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA?.slice(0,8) || "(unknown)",
    masterBaseId: MASTER_BASE_ID,
    campaignsChecked: 0,
    rawCampaignRecords: [], // names + features of ALL records returned by Airtable
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
    // cache: "no-store" is CRITICAL — Next.js App Router caches fetch() by
    // default. Without this, the cron sees a stale snapshot of the Campaigns
    // table from whenever this code path was first hit, missing any campaigns
    // added since then.
    const campRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}`, { headers: atHdr, cache: "no-store" });
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

    // Dump raw record summary so we can see what Airtable actually returned
    summary.rawCampaignRecords = (campaigns || []).map(c => ({
      id: c.id,
      name: c.fields?.Name || "(no name)",
      baseId: c.fields?.["Base ID"] || "(no base id)",
      Features: c.fields?.Features,
      Features_type: Array.isArray(c.fields?.Features) ? "array" : typeof c.fields?.Features,
    }));

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
      const rawFeatures = cf.Features;
      const features = Array.isArray(rawFeatures)
        ? rawFeatures.map(s => String(s).trim())
        : String(rawFeatures || "").split(",").map(s => s.trim());

      if (!baseId) {
        summary.skipReasons.push(`Campaign "${cf.Name || camp.id}" has no Base ID — skipped`);
        continue;
      }
      // NOTE: previously we silently skipped campaigns whose master `Features`
      // field didn't include "linkedin_outreach" — that caused production silent
      // failures (e.g. Veloka's Features = "top_x" but its Task Rules table had
      // an active linkedin_outreach rule with 5 queued items; cron skipped it,
      // queue stayed forever). Source of truth for "should we run outreach?" is
      // the Task Rules table itself, NOT the Features hint. We now check rules
      // for every campaign with a baseId. The Features hint is informational
      // only and surfaces as a warning when it disagrees with the rule data.
      const featuresHasOutreach = features.includes("linkedin_outreach");

      const campRecord = { name: cf.Name || camp.id, baseId, rulesActive: 0, rulesTotal: 0, errors: [] };

      let rulesData;
      try {
        const rulesRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Task Rules")}`, { headers: atHdr, cache: "no-store" });
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

      // Diagnostic: surface campaigns we touched but found nothing for. Without
      // this, the operator-visible response showed `campaignsChecked: 5` but
      // `perCampaign: [test campaign]` only — no way to tell whether the other
      // 4 had no rules or had been silently skipped by an upstream filter.
      if (outreachRules.length === 0) {
        summary.skipReasons.push(`Campaign "${cf.Name || camp.id}" — no linkedin_outreach rule in Task Rules table`);
        summary.perCampaign.push(campRecord);
        continue;
      }

      // Diagnostic: warn if the rule exists but Features hint disagrees. Helps
      // catch the misconfiguration that caused the original bug (Features=top_x
      // while Task Rules had an active linkedin_outreach rule).
      if (!featuresHasOutreach) {
        campRecord.featuresHintMismatch = `Features="${rawFeatures}" does not include "linkedin_outreach" but Task Rules has ${outreachRules.length} rule(s) — consider updating Features to reflect reality.`;
      }

      for (const rule of outreachRules) {
        const rf = rule.fields || {};
        let config;
        try { config = JSON.parse(rf["Outreach Config"] || "{}"); }
        catch (e) {
          campRecord.errors.push(`Rule "${rf.Name}": Outreach Config is malformed JSON — ${e.message}`);
          continue;
        }
        if (!config.accountId) {
          // Fallback: campaign-level "LinkedIn Account ID" field. This handles
          // rules saved before per-rule accountId was auto-attached, or rules
          // where the operator wants all rules to inherit the campaign's account.
          const campaignAccountId = (cf["LinkedIn Account ID"] || "").trim();
          if (campaignAccountId) {
            config.accountId = campaignAccountId;
            console.log(`[CRON] Rule "${rf.Name}": using campaign-level LinkedIn Account ID ${campaignAccountId} (rule had none)`);
          } else {
            campRecord.errors.push(`Rule "${rf.Name}": missing accountId — neither in Outreach Config nor on the Campaigns row's "LinkedIn Account ID" field`);
            continue;
          }
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
