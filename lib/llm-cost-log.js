// ─── PER-CALL LLM COST LOG ──────────────────────────────────────────────────
//
// `lib/ai-usage.js` keeps CUMULATIVE counters on the Campaign record — the
// billing rollup. This module is the layer underneath it: one dated row per
// LLM call, so we can answer "what did a week of real activity cost, broken
// down by route and model" instead of estimating from prompt sizes.
//
// The two are complementary and both stay. Nothing here mutates the Campaign
// counters or the Google Sheet ledger.
//
// Covers BOTH providers on purpose: post scoring runs on OpenAI inside this
// repo, while the sidekick-posts app calls Anthropic. A per-post cost that
// only counts one of them is wrong, so they share one table.
//
// STORAGE: `Cost Log` table in the MASTER base (AIRTABLE_BASE_ID) — one
// queryable place across every campaign. Auto-created on first write.

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const TABLE = process.env.COST_LOG_TABLE || "Cost Log";

const atHdr = {
  Authorization: `Bearer ${AIRTABLE_KEY}`,
  "Content-Type": "application/json",
};

// ─── Pricing, USD per million tokens ────────────────────────────────────────
// OpenAI rows mirror lib/ai-usage.js — keep them in sync when either moves.
// Anthropic rows are the published rates. A stale entry silently mis-bills
// every row written after it, so the verified date matters.
// Last verified: 2026-07-28.
const PRICING = {
  // ── OpenAI (post scoring, news/jobs classification) ──
  "gpt-5.4-pro":  { in: 30.0, out: 180.0 },
  "gpt-5.4-mini": { in: 0.75, out: 4.50 },
  "gpt-5.4-nano": { in: 0.20, out: 1.25 },
  "gpt-5.4":      { in: 2.50, out: 15.00 },
  "gpt-5-mini":   { in: 0.25, out: 2.00 },
  "gpt-5":        { in: 1.25, out: 10.00 },

  // ── Anthropic (sidekick-posts app: comments, angles, summaries) ──
  "claude-fable-5":    { in: 10.0, out: 50.0 },
  "claude-mythos-5":   { in: 10.0, out: 50.0 },
  "claude-opus-5":     { in: 5.0,  out: 25.0 },
  "claude-opus-4-8":   { in: 5.0,  out: 25.0 },
  "claude-opus-4-7":   { in: 5.0,  out: 25.0 },
  "claude-opus-4-6":   { in: 5.0,  out: 25.0 },
  // Sonnet 5 carries a promotional rate that expires — priced by row date so
  // historical rows keep the rate that actually applied when they were made.
  "claude-sonnet-5":   { in: 3.0, out: 15.0, introIn: 2.0, introOut: 10.0, introUntil: "2026-08-31" },
  "claude-sonnet-4-6": { in: 3.0,  out: 15.0 },
  "claude-haiku-4-5":  { in: 1.0,  out: 5.0 },
};

// Anthropic cache multipliers, applied to the input rate.
const CACHE_WRITE_MULT = 1.25; // 5-minute TTL
const CACHE_READ_MULT = 0.1;

// Model ids carry suffixes (`claude-haiku-4-5-20251001`, `gpt-5.4-2026-03-05`).
// Match the LONGEST configured prefix so `gpt-5.4-mini` never prices as
// `gpt-5.4` — that ordering bug would overcharge scoring by 3x.
export function resolvePricing(model, onDate) {
  const id = String(model || "");
  let best = null;
  for (const key of Object.keys(PRICING)) {
    if (id.startsWith(key) && (!best || key.length > best.length)) best = key;
  }
  if (!best) return null;
  const p = PRICING[best];
  if (p.introUntil && onDate && onDate <= p.introUntil) {
    return { key: best, in: p.introIn, out: p.introOut, intro: true };
  }
  return { key: best, in: p.in, out: p.out, intro: false };
}

// ─── Cost math ──────────────────────────────────────────────────────────────
// Accepts either provider's usage shape:
//   OpenAI    → { prompt_tokens, completion_tokens }
//   Anthropic → { input_tokens, output_tokens, cache_creation_input_tokens,
//                 cache_read_input_tokens }
// Anthropic's cached tokens are billed at different rates and are NOT included
// in input_tokens, so they are priced separately or the row under-reports.
export function computeCallCost(model, usage, onDate) {
  const u = usage || {};
  const inTok = Number(u.input_tokens ?? u.prompt_tokens) || 0;
  const outTok = Number(u.output_tokens ?? u.completion_tokens) || 0;
  const cacheWrite = Number(u.cache_creation_input_tokens) || 0;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;

  const p = resolvePricing(model, onDate);
  if (!p) {
    console.warn(`[cost-log] Unpriced model "${model}" — row recorded at $0. Add it to PRICING in lib/llm-cost-log.js.`);
    return { ok: false, inTok, outTok, cacheWrite, cacheRead, cost: 0, pricedAs: "", intro: false };
  }

  const cost =
    (inTok * p.in +
      cacheWrite * p.in * CACHE_WRITE_MULT +
      cacheRead * p.in * CACHE_READ_MULT +
      outTok * p.out) / 1e6;

  return { ok: true, inTok, outTok, cacheWrite, cacheRead, cost, pricedAs: p.key, intro: p.intro };
}

// ─── Table bootstrap ────────────────────────────────────────────────────────
// Best-effort auto-create so the first write works without a manual setup step.
// Requires the PAT to carry schema.bases:write (it does — see CLAUDE.md §11).
let _tableEnsured = false;
async function ensureTable() {
  if (_tableEnsured) return;
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) return;
  try {
    const schemaRes = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
    if (!schemaRes.ok) return;
    const schema = await schemaRes.json();
    if ((schema.tables || []).some((t) => t.name === TABLE)) {
      _tableEnsured = true;
      return;
    }
    const create = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables`, {
      method: "POST",
      headers: atHdr,
      body: JSON.stringify({
        name: TABLE,
        description: "Per-call LLM cost rows. Written by lib/llm-cost-log.js; read by /api/cost-log.",
        fields: [
          { name: "Route", type: "singleLineText" },
          { name: "Model", type: "singleLineText" },
          { name: "Priced As", type: "singleLineText" },
          { name: "Campaign", type: "singleLineText" },
          { name: "Input Tokens", type: "number", options: { precision: 0 } },
          { name: "Output Tokens", type: "number", options: { precision: 0 } },
          { name: "Cache Write Tokens", type: "number", options: { precision: 0 } },
          { name: "Cache Read Tokens", type: "number", options: { precision: 0 } },
          { name: "Cost USD", type: "number", options: { precision: 8 } },
          { name: "Intro Rate", type: "checkbox", options: { icon: "check", color: "greenBright" } },
          { name: "Day", type: "singleLineText" },
          { name: "Called At", type: "singleLineText" },
          { name: "Post Key", type: "singleLineText" },
          { name: "Meta", type: "multilineText" },
        ],
      }),
    });
    if (create.ok) _tableEnsured = true;
    else console.warn(`[cost-log] table create failed ${create.status}: ${(await create.text()).slice(0, 200)}`);
  } catch (e) {
    console.warn(`[cost-log] ensureTable threw: ${e.message}`);
  }
}

// ─── Write ──────────────────────────────────────────────────────────────────
// Fire-and-forget by contract: a tracking failure must never fail the request
// that produced it. Every path swallows after logging. The `[COST]` console
// line is the always-on fallback, greppable in Vercel logs even if Airtable
// is unreachable.
export async function logLLMCall({ route, model, usage, campaignId = "", postKey = "", meta = {} }) {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const c = computeCallCost(model, usage, day);

    const fields = {
      Route: String(route || "unknown"),
      Model: String(model || "unknown"),
      "Priced As": c.pricedAs,
      Campaign: String(campaignId || ""),
      "Input Tokens": c.inTok,
      "Output Tokens": c.outTok,
      "Cache Write Tokens": c.cacheWrite,
      "Cache Read Tokens": c.cacheRead,
      "Cost USD": Number(c.cost.toFixed(8)),
      "Intro Rate": !!c.intro,
      Day: day,
      "Called At": now.toISOString(),
      "Post Key": String(postKey || "").slice(0, 255),
      Meta: JSON.stringify(meta).slice(0, 2000),
    };

    console.log(`[COST] ${JSON.stringify(fields)}`);

    if (!AIRTABLE_KEY || !MASTER_BASE_ID) return { ok: false, reason: "airtable not configured" };
    await ensureTable();

    const res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent(TABLE)}`, {
      method: "POST",
      headers: atHdr,
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    });
    if (!res.ok) {
      console.warn(`[cost-log] write failed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return { ok: false, reason: `airtable ${res.status}` };
    }
    return { ok: true, cost: c.cost };
  } catch (e) {
    console.warn(`[cost-log] logLLMCall threw (ignored): ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// Non-blocking convenience for hot paths — same contract, never awaited.
export function trackLLMCall(args) {
  logLLMCall(args).catch(() => {});
}

export { PRICING, TABLE as COST_LOG_TABLE, MASTER_BASE_ID };
