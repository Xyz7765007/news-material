export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// ─── COST LOG API ───────────────────────────────────────────────────────────
//
// The queryable surface over the per-call rows written by lib/llm-cost-log.js.
// Lives in the backend on purpose — one place holds every campaign's LLM spend,
// across both providers, so "what did this actually cost" is one request away.
//
//   POST /api/cost-log            ingest one call
//     Authorization: Bearer <SIDEKICK_API_KEY>
//     { route, model, usage, campaignId?, postKey?, meta? }
//     `usage` accepts either provider shape (OpenAI prompt_/completion_tokens
//     or Anthropic input_/output_tokens + cache fields).
//
//   GET /api/cost-log?key=<CRON_SECRET>&days=7[&campaign=veloka][&route=...]
//     Aggregated readback: totals, per-day, per-route, per-model, per-campaign,
//     plus the derived per-post unit cost.
//
// Read auth is CRON_SECRET (admin/operator), write auth is SIDEKICK_API_KEY
// (the app reporting its own usage) — deliberately different scopes.

import { logLLMCall, COST_LOG_TABLE, MASTER_BASE_ID } from "@/lib/llm-cost-log";

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// ─── POST: ingest ───────────────────────────────────────────────────────────
export async function POST(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!SIDEKICK_KEY || token !== SIDEKICK_KEY) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { route, model, usage, campaignId, postKey, meta } = body || {};
  if (!route || !model || !usage) {
    return Response.json({ ok: false, error: "route, model and usage are required" }, { status: 400 });
  }

  // Awaited here (unlike the hot-path helper) so the caller gets a definite
  // answer about whether the row landed.
  const result = await logLLMCall({ route, model, usage, campaignId, postKey, meta });
  return Response.json({ ok: result.ok !== false, ...result });
}

// ─── GET: aggregate ─────────────────────────────────────────────────────────
async function listRows(sinceISO) {
  const rows = [];
  let offset = null;
  const formula = `IS_AFTER({Called At}, "${sinceISO}")`;
  do {
    const qs = new URLSearchParams({ filterByFormula: formula, pageSize: "100" });
    if (offset) qs.set("offset", offset);
    const res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent(COST_LOG_TABLE)}?${qs}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      // A missing table just means nothing has been logged yet — that is an
      // empty result, not an error the operator needs to debug.
      if (res.status === 404 || txt.includes("TABLE_NOT_FOUND")) return [];
      throw new Error(`Airtable ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    rows.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return rows;
}

function bump(map, key, f) {
  if (!key) key = "unknown";
  if (!map[key]) map[key] = { calls: 0, inTok: 0, outTok: 0, cost: 0 };
  const t = map[key];
  t.calls += 1;
  t.inTok += Number(f["Input Tokens"]) || 0;
  t.outTok += Number(f["Output Tokens"]) || 0;
  t.cost += Number(f["Cost USD"]) || 0;
}

const sortByCost = (o) =>
  Object.fromEntries(
    Object.entries(o)
      .map(([k, v]) => [k, { ...v, cost: Number(v.cost.toFixed(6)) }])
      .sort((a, b) => b[1].cost - a[1].cost)
  );

export async function GET(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (!CRON_SECRET || key !== CRON_SECRET) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return Response.json({ ok: false, error: "Airtable not configured" }, { status: 500 });
  }

  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10) || 7, 1), 90);
  const campaignFilter = (url.searchParams.get("campaign") || "").toLowerCase();
  const routeFilter = (url.searchParams.get("route") || "").toLowerCase();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  try {
    let records = await listRows(since);
    if (campaignFilter) {
      records = records.filter((r) => String(r.fields?.Campaign || "").toLowerCase() === campaignFilter);
    }
    if (routeFilter) {
      records = records.filter((r) => String(r.fields?.Route || "").toLowerCase() === routeFilter);
    }

    const byDay = {}, byRoute = {}, byModel = {}, byCampaign = {};
    const posts = new Set();
    let totalCost = 0, totalIn = 0, totalOut = 0;

    for (const rec of records) {
      const f = rec.fields || {};
      bump(byDay, f.Day, f);
      bump(byRoute, f.Route, f);
      bump(byModel, f.Model, f);
      bump(byCampaign, f.Campaign || "(unattributed)", f);
      totalCost += Number(f["Cost USD"]) || 0;
      totalIn += Number(f["Input Tokens"]) || 0;
      totalOut += Number(f["Output Tokens"]) || 0;
      if (f["Post Key"]) posts.add(String(f["Post Key"]));
    }

    const dayCount = Object.keys(byDay).length || 1;

    return Response.json({
      ok: true,
      window: { days, since, daysWithActivity: dayCount },
      totals: {
        calls: records.length,
        inputTokens: totalIn,
        outputTokens: totalOut,
        costUSD: Number(totalCost.toFixed(6)),
        distinctPosts: posts.size,
        // The number that matters for pricing a client: real spend divided by
        // real posts worked, not an assumed per-post figure.
        costPerPostUSD: posts.size ? Number((totalCost / posts.size).toFixed(6)) : null,
        avgCostPerDayUSD: Number((totalCost / dayCount).toFixed(6)),
        projectedMonthlyUSD: Number(((totalCost / dayCount) * 30.44).toFixed(2)),
      },
      byDay: sortByCost(byDay),
      byRoute: sortByCost(byRoute),
      byModel: sortByCost(byModel),
      byCampaign: sortByCost(byCampaign),
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
