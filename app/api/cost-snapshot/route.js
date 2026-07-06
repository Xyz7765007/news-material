// ─── Cost Snapshot → billing ledger ─────────────────────────────────
// Reads every campaign's cumulative usage counters from the master Campaigns table
// (maintained by lib/ai-usage.js + lib/rapidapi-usage.js) and pushes the DELTA since
// the last push as dated rows into the Google Sheet cost tracker (one OpenAI row + one
// RapidAPI row per client). This is the automated OpenAI/RapidAPI feed for billing.
//
// WHY a snapshot and not a per-call POST: a single news scan makes hundreds of OpenAI
// scoring calls. Posting each would flood the ledger with thousands of rows and add
// network latency to the scoring hot path. The counters are already accumulated per
// campaign, so a periodic delta push gives clean dated billing at ~2 rows/client/run,
// with zero risk to the scan path.
//
// USAGE (auth: ?key=<CRON_SECRET>):
//   GET /api/cost-snapshot            → compute deltas, post rows, advance the watermark
//   GET /api/cost-snapshot?mode=preview → compute + return rows, post NOTHING, no watermark change
//   GET /api/cost-snapshot?baseline=1 → set the watermark = current cumulative WITHOUT posting
//                                        (run once if you do NOT want existing pre-sheet spend
//                                         backfilled as one big first-delta row)
//
// Idempotency: each row's Entry ID includes a minute timestamp, so multiple runs/day add
// rows that sum correctly; the per-campaign watermark fields guarantee no double counting.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const atHdr = {
  Authorization: `Bearer ${AIRTABLE_KEY}`,
  "Content-Type": "application/json",
};

// Watermark fields on the Campaigns table (what we last pushed to the sheet).
const WATERMARK_FIELDS = [
  { name: "Cost Sheet AI Cost Pushed",      type: "number", options: { precision: 6 } },
  { name: "Cost Sheet AI In Pushed",        type: "number", options: { precision: 0 } },
  { name: "Cost Sheet AI Out Pushed",       type: "number", options: { precision: 0 } },
  { name: "Cost Sheet AI Calls Pushed",     type: "number", options: { precision: 0 } },
  { name: "Cost Sheet RapidAPI Cost Pushed", type: "number", options: { precision: 6 } },
  { name: "Cost Sheet RapidAPI Calls Pushed", type: "number", options: { precision: 0 } },
  { name: "Cost Sheet Last Push At",        type: "singleLineText" },
];

function num(v) { return typeof v === "number" && !isNaN(v) ? v : 0; }
function round6(n) { return Math.round(n * 1e6) / 1e6; }
function slug(s) { return String(s || "client").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40); }

async function ensureWatermarkFields() {
  try {
    const schemaRes = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
    if (!schemaRes.ok) return;
    const schema = await schemaRes.json();
    const camp = (schema.tables || []).find(t => t.name === "Campaigns");
    if (!camp) return;
    const have = new Set((camp.fields || []).map(f => f.name));
    for (const f of WATERMARK_FIELDS) {
      if (have.has(f.name)) continue;
      const r = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables/${camp.id}/fields`, {
        method: "POST", headers: atHdr, body: JSON.stringify(f),
      });
      if (!r.ok) console.warn(`[cost-snapshot] could not create field "${f.name}": ${r.status}`);
    }
  } catch (e) {
    console.warn(`[cost-snapshot] ensureWatermarkFields failed: ${e.message}`);
  }
}

// List every campaign (paginated).
async function listCampaigns() {
  const out = [];
  let offset = null;
  do {
    const u = new URL(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}`);
    if (offset) u.searchParams.set("offset", offset);
    const r = await fetch(u.toString(), { headers: atHdr });
    if (!r.ok) throw new Error(`Campaigns list HTTP ${r.status}`);
    const d = await r.json();
    (d.records || []).forEach(rec => out.push(rec));
    offset = d.offset || null;
  } while (offset);
  return out;
}

async function patchCampaign(id, fields) {
  const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${id}`, {
    method: "PATCH", headers: atHdr, body: JSON.stringify({ fields }),
  });
  if (!r.ok) console.warn(`[cost-snapshot] watermark PATCH failed for ${id}: ${r.status}`);
  return r.ok;
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!MASTER_BASE_ID || !AIRTABLE_KEY) {
    return NextResponse.json({ error: "AIRTABLE_BASE_ID / AIRTABLE_API_KEY not set" }, { status: 500 });
  }

  const mode = url.searchParams.get("mode");         // "preview" = dry run
  const baseline = url.searchParams.get("baseline") === "1";
  const preview = mode === "preview";

  const { postCostRows, costSheetConfigured } = await import("@/lib/cost-sheet");
  if (!preview && !baseline && !costSheetConfigured()) {
    return NextResponse.json({ error: "COST_TRACKER_URL / COST_TRACKER_SECRET not set in env" }, { status: 500 });
  }

  await ensureWatermarkFields();

  let campaigns;
  try { campaigns = await listCampaigns(); }
  catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }

  const stamp = new Date();
  const dateStr = stamp.toISOString().slice(0, 10);                 // YYYY-MM-DD
  const minTag = stamp.toISOString().slice(0, 16).replace(/[-:T]/g, ""); // YYYYMMDDHHmm

  const rows = [];
  const watermarks = [];       // { id, fields } to advance after a successful post
  const perClient = [];

  for (const rec of campaigns) {
    const f = rec.fields || {};
    const name = String(f.Name || "").trim();
    if (!name) continue;

    // Cumulative counters (maintained by the tracking helpers).
    const aiCost = num(f["AI Total Cost USD"]);
    const aiIn   = num(f["AI Total Input Tokens"]);
    const aiOut  = num(f["AI Total Output Tokens"]);
    const aiCalls = num(f["AI Calls Count"]);
    const rpCost = num(f["RapidAPI Total Cost USD"]);
    const rpCalls = num(f["RapidAPI Calls Count"]);

    // Watermark = what we last pushed.
    const pAiCost = num(f["Cost Sheet AI Cost Pushed"]);
    const pAiIn   = num(f["Cost Sheet AI In Pushed"]);
    const pAiOut  = num(f["Cost Sheet AI Out Pushed"]);
    const pAiCalls = num(f["Cost Sheet AI Calls Pushed"]);
    const pRpCost = num(f["Cost Sheet RapidAPI Cost Pushed"]);
    const pRpCalls = num(f["Cost Sheet RapidAPI Calls Pushed"]);

    // Deltas (floored at 0 — counters can be reset on a billing cycle, which would make
    // cumulative < watermark; treat that as "nothing new" and let the watermark re-baseline).
    const dAiCost = Math.max(0, round6(aiCost - pAiCost));
    const dAiIn   = Math.max(0, aiIn - pAiIn);
    const dAiOut  = Math.max(0, aiOut - pAiOut);
    const dAiCalls = Math.max(0, aiCalls - pAiCalls);
    const dRpCost = Math.max(0, round6(rpCost - pRpCost));
    const dRpCalls = Math.max(0, rpCalls - pRpCalls);

    const clientSlug = slug(name);
    const summary = { client: name, aiDeltaUSD: dAiCost, aiCalls: dAiCalls, rapidDeltaUSD: dRpCost, rapidCalls: dRpCalls };
    perClient.push(summary);

    if (!baseline) {
      if (dAiCost > 0 || dAiCalls > 0) {
        rows.push({
          "Entry ID": `openai-${clientSlug}-${minTag}`,
          "Date": dateStr,
          "Client": name,
          "Category": "OpenAI",
          "Operation": "AI scoring (Δ since last push)",
          "Provider / Model": "OpenAI (gpt-5.4 family)",
          "Input Tokens": dAiIn,
          "Output Tokens": dAiOut,
          "Units": dAiCalls,
          "Cost USD": dAiCost,
          "Billable": "Yes",
          "Ref": rec.id,
          "Notes": `Cumulative to date: $${round6(aiCost)} over ${aiCalls} calls. Push window ended ${stamp.toISOString()}.`,
        });
      }
      if (dRpCost > 0 || dRpCalls > 0) {
        rows.push({
          "Entry ID": `rapidapi-${clientSlug}-${minTag}`,
          "Date": dateStr,
          "Client": name,
          "Category": "RapidAPI",
          "Operation": "RapidAPI calls (Δ since last push)",
          "Provider / Model": "RapidAPI (Fresh LinkedIn Profile Data)",
          "Input Tokens": "",
          "Output Tokens": "",
          "Units": dRpCalls,
          "Cost USD": dRpCost,
          "Billable": "Yes",
          "Ref": rec.id,
          "Notes": `Cumulative to date: $${round6(rpCost)} over ${rpCalls} calls. Push window ended ${stamp.toISOString()}.`,
        });
      }
    }

    // Advance watermark to the current cumulative (posted rows OR baseline mode).
    watermarks.push({
      id: rec.id,
      fields: {
        "Cost Sheet AI Cost Pushed": round6(aiCost),
        "Cost Sheet AI In Pushed": aiIn,
        "Cost Sheet AI Out Pushed": aiOut,
        "Cost Sheet AI Calls Pushed": aiCalls,
        "Cost Sheet RapidAPI Cost Pushed": round6(rpCost),
        "Cost Sheet RapidAPI Calls Pushed": rpCalls,
        "Cost Sheet Last Push At": stamp.toISOString(),
      },
    });
  }

  // Preview: return what WOULD be pushed, change nothing.
  if (preview) {
    return NextResponse.json({ ok: true, mode: "preview", wouldPost: rows.length, rows, perClient });
  }

  // Baseline: advance watermarks so future deltas only capture new spend; post nothing.
  if (baseline) {
    for (const w of watermarks) await patchCampaign(w.id, w.fields);
    return NextResponse.json({ ok: true, mode: "baseline", campaigns: watermarks.length, posted: 0, perClient });
  }

  // Normal: post rows, then advance watermarks ONLY if the post succeeded.
  let postResult = { ok: true, appended: 0 };
  if (rows.length) postResult = await postCostRows(rows);

  if (rows.length && !postResult.ok) {
    // Do NOT advance watermarks — next run retries the same delta (no data loss).
    return NextResponse.json({ ok: false, error: "cost sheet post failed; watermarks unchanged", postResult, rows }, { status: 502 });
  }

  for (const w of watermarks) await patchCampaign(w.id, w.fields);

  return NextResponse.json({
    ok: true, mode: "push", posted: rows.length, postResult,
    clients: perClient.filter(c => c.aiDeltaUSD > 0 || c.rapidDeltaUSD > 0 || c.aiCalls > 0 || c.rapidCalls > 0),
  });
}
