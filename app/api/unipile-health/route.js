// ─── Unipile health check ──────────────────────────────────────
// One-shot verification that the LinkedIn automation infrastructure is
// fully wired up. Checks:
//   1. Env vars (UNIPILE_DSN, UNIPILE_API_KEY) are set
//   2. Unipile API is reachable + auth works
//   3. Connected accounts and their statuses
//   4. Webhooks registered + pointing at this deployment
//   5. Account Routing mappings exist for each connected account
//   6. Sample relations + chats fetch works (so DM sends will work)
//
// USAGE: GET /api/unipile-health?key=<CRON_SECRET>
// Returns a JSON report with pass/fail per check + actionable hints.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const UNIPILE_DSN = process.env.UNIPILE_DSN;
const UNIPILE_KEY = process.env.UNIPILE_API_KEY;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// Unipile's DSN may be passed in two shapes:
//   1. host:port (e.g. "api1.unipile.com:13371")  ← preferred per docs
//   2. https://host:port  ← we strip the protocol
// We construct the API base URL ourselves to avoid any DSN parsing edge cases.
function unipileBase() {
  if (!UNIPILE_DSN) return null;
  const cleaned = UNIPILE_DSN.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return `https://${cleaned}/api/v1`;
}

async function unipileGet(path) {
  const base = unipileBase();
  if (!base || !UNIPILE_KEY) return { ok: false, error: "Missing UNIPILE_DSN or UNIPILE_API_KEY env" };
  try {
    const r = await fetch(`${base}${path}`, {
      headers: { "X-API-KEY": UNIPILE_KEY, "Accept": "application/json" },
      cache: "no-store",
    });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized — pass ?key=<CRON_SECRET>" }, { status: 401 });
  }

  const deploymentHost = request.headers.get("host") || (process.env.VERCEL_URL || "");
  const expectedWebhookHost = deploymentHost.replace(/^https?:\/\//, "");

  const report = {
    deploymentHost,
    expectedWebhookHost,
    checks: {},
    accounts: [],
    webhooks: [],
    routingMappings: [],
    summary: { passed: 0, failed: 0, warnings: 0 },
    actionableSteps: [],
  };

  // ─── Check 1: env vars ───────────────────────────────────────
  const env = {
    UNIPILE_DSN_set: !!UNIPILE_DSN,
    UNIPILE_DSN_value: UNIPILE_DSN || "(NOT SET)",
    UNIPILE_API_KEY_set: !!UNIPILE_KEY,
    UNIPILE_API_KEY_prefix: UNIPILE_KEY?.slice(0, 12) || "(NOT SET)",
    computedApiBase: unipileBase() || "(cannot compute — DSN missing)",
  };
  report.checks.envVars = {
    pass: env.UNIPILE_DSN_set && env.UNIPILE_API_KEY_set,
    details: env,
  };
  if (!report.checks.envVars.pass) {
    report.summary.failed++;
    report.actionableSteps.push("Set UNIPILE_DSN and UNIPILE_API_KEY env vars in Vercel project settings, then redeploy.");
    return NextResponse.json(report);
  }
  report.summary.passed++;

  // ─── Check 2: list accounts ──────────────────────────────────
  const accountsResp = await unipileGet("/accounts");
  report.checks.accountsApi = {
    pass: accountsResp.ok,
    httpStatus: accountsResp.status,
    error: accountsResp.error || null,
    rawHint: accountsResp.body && !Array.isArray(accountsResp.body.items) ? JSON.stringify(accountsResp.body).slice(0, 300) : null,
  };
  if (!accountsResp.ok) {
    report.summary.failed++;
    if (accountsResp.status === 401 || accountsResp.status === 403) {
      report.actionableSteps.push("UNIPILE_API_KEY is invalid or expired. Generate a new one at https://app.unipile.com → Settings → API Keys, update Vercel env, redeploy.");
    } else if (!accountsResp.status) {
      report.actionableSteps.push(`Could not reach Unipile API. Check UNIPILE_DSN value — should be "api1.unipile.com:XXXXX" (host:port from your Unipile dashboard).`);
    } else {
      report.actionableSteps.push(`Unipile /accounts API returned HTTP ${accountsResp.status}. Check Unipile dashboard for service status.`);
    }
    return NextResponse.json(report);
  }
  report.summary.passed++;

  // ─── Check 3: per-account status ─────────────────────────────
  const items = accountsResp.body?.items || [];
  if (items.length === 0) {
    report.checks.accountsConnected = { pass: false, count: 0 };
    report.summary.failed++;
    report.actionableSteps.push("No LinkedIn accounts are connected to Unipile. Go to SignalScope → LinkedIn Automation tab → connect an account via the hosted auth link.");
  } else {
    for (const acc of items) {
      const accReport = {
        id: acc.id,
        name: acc.name || acc.username || "(unnamed)",
        provider: acc.type || acc.provider || "(unknown)",
        status: acc.connection_params?.connection_status || acc.status || acc.sources?.[0]?.status || "(unknown)",
        accountStatusOk: false,
      };
      const statusUpper = String(accReport.status).toUpperCase();
      accReport.accountStatusOk = statusUpper === "OK" || statusUpper === "CONNECTED" || statusUpper === "ACTIVE";
      if (!accReport.accountStatusOk) {
        report.actionableSteps.push(`Account "${accReport.name}" is in status "${accReport.status}". Reconnect via Unipile dashboard.`);
        report.summary.warnings++;
      }
      report.accounts.push(accReport);
    }
    report.checks.accountsConnected = {
      pass: items.length > 0 && report.accounts.every(a => a.accountStatusOk),
      count: items.length,
      healthyCount: report.accounts.filter(a => a.accountStatusOk).length,
    };
    if (report.checks.accountsConnected.pass) report.summary.passed++;
    else report.summary.failed++;
  }

  // ─── Check 4: webhooks ───────────────────────────────────────
  const webhooksResp = await unipileGet("/webhooks");
  report.checks.webhooksApi = { pass: webhooksResp.ok, httpStatus: webhooksResp.status };
  if (webhooksResp.ok) {
    report.summary.passed++;
    const hooks = webhooksResp.body?.items || webhooksResp.body || [];
    const hooksArr = Array.isArray(hooks) ? hooks : [];
    for (const w of hooksArr) {
      const wUrl = w.request_url || w.url || w.target_url || "";
      const pointsHere = wUrl.includes(expectedWebhookHost);
      report.webhooks.push({
        id: w.id || w._id || w.uuid,
        name: w.name || "(unnamed)",
        source: w.source || w.type || "(unknown)",
        events: w.events || [],
        url: wUrl,
        pointsAtThisDeployment: pointsHere,
      });
    }

    // What we expect: messaging, users, account_status, all pointing at this deployment
    const expectedSources = ["messaging", "users", "account_status"];
    const sourcesHere = new Set(report.webhooks.filter(w => w.pointsAtThisDeployment).map(w => w.source));
    const missing = expectedSources.filter(s => !sourcesHere.has(s));
    report.checks.webhooksConfigured = {
      pass: missing.length === 0,
      missingSources: missing,
      totalWebhooks: report.webhooks.length,
      webhooksPointingHere: report.webhooks.filter(w => w.pointsAtThisDeployment).length,
    };
    if (missing.length === 0) {
      report.summary.passed++;
    } else {
      report.summary.failed++;
      report.actionableSteps.push(`Missing webhooks for: ${missing.join(", ")}. Run POST /api/unipile-setup-webhooks?key=${CRON_SECRET} to auto-create them.`);
    }

    // Warn about webhooks pointing elsewhere (other devs / stale deployments)
    const elsewhere = report.webhooks.filter(w => !w.pointsAtThisDeployment);
    if (elsewhere.length > 0) {
      report.summary.warnings++;
      report.actionableSteps.push(`${elsewhere.length} webhook(s) point at other URLs — likely other devs or old deployments. Review report.webhooks for full list; safe to delete via Unipile dashboard if unwanted.`);
    }
  } else {
    report.summary.failed++;
    report.actionableSteps.push(`Webhooks API failed (HTTP ${webhooksResp.status}). Same auth as /accounts — if accounts worked but this didn't, contact Unipile support.`);
  }

  // ─── Check 5: Account Routing mappings ───────────────────────
  if (AIRTABLE_KEY && MASTER_BASE_ID && items.length > 0) {
    try {
      const r = await fetch(`https://api.airtable.com/v0/${MASTER_BASE_ID}/${encodeURIComponent("Account Routing")}?filterByFormula=${encodeURIComponent("{Active}=1")}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
        cache: "no-store",
      });
      if (r.ok) {
        const d = await r.json();
        const routes = d.records || [];
        const routedAccountIds = new Set(routes.map(rec => (rec.fields?.["Account ID"] || "").trim()));
        for (const acc of report.accounts) {
          const routed = routedAccountIds.has(acc.id);
          report.routingMappings.push({ accountId: acc.id, name: acc.name, routed });
          if (!routed) {
            report.summary.warnings++;
            report.actionableSteps.push(`Account "${acc.name}" (${acc.id}) has no active Account Routing entry. Webhooks for this account will land in "Unrouted Triggers" instead of creating tasks. Add it via SignalScope → Triggers tab → 🔀 Account Routing.`);
          }
        }
        const allRouted = report.accounts.length > 0 && report.routingMappings.every(r => r.routed);
        report.checks.routingMappings = { pass: allRouted, totalAccounts: report.accounts.length, routedCount: report.routingMappings.filter(r => r.routed).length };
        if (allRouted) report.summary.passed++;
      } else {
        report.checks.routingMappings = { pass: false, error: `Could not load Account Routing table: HTTP ${r.status}` };
      }
    } catch (e) {
      report.checks.routingMappings = { pass: false, error: e.message };
    }
  }

  // ─── Check 6: sample relations fetch ─────────────────────────
  // Picks the first healthy account and confirms we can fetch its relations.
  // This is what the cron uses to detect connection acceptance — if it works,
  // the acceptance-detection pipeline is intact.
  const firstHealthy = report.accounts.find(a => a.accountStatusOk);
  if (firstHealthy) {
    const relRes = await unipileGet(`/users/relations?account_id=${firstHealthy.id}&limit=1`);
    report.checks.relationsFetch = {
      pass: relRes.ok,
      httpStatus: relRes.status,
      testedAccount: firstHealthy.name,
      sampleSize: Array.isArray(relRes.body?.items) ? relRes.body.items.length : null,
    };
    if (relRes.ok) report.summary.passed++;
    else {
      report.summary.failed++;
      report.actionableSteps.push(`Relations API failed for ${firstHealthy.name}. Connection acceptance detection (and DM sequencing) won't work until this is resolved.`);
    }
  }

  report.healthy = report.summary.failed === 0;
  return NextResponse.json(report);
}
