// ─── PER-CALL COST + ACTIVITY LOG ───────────────────────────────────────────
//
// `lib/ai-usage.js` keeps CUMULATIVE counters on the Campaign record — the
// billing rollup. This module is the layer underneath it: one dated row per
// billable call, across ALL THREE providers in the posts pipeline:
//
//   rapidapi   — fresh-linkedin-scraper-api post fetches (news-material)
//   openai     — post scoring (news-material)
//   anthropic  — comments / angles / summaries / chat (sidekick-posts)
//
// A per-post cost that counts only one of them is wrong, so they share one
// table and one query surface.
//
// SHADOW PRICING: scoring currently runs on gpt-5.4-mini (and some batches were
// scored by hand). Every scoring row also records what the SAME token counts
// would have cost on claude-sonnet-5, so the dashboard can answer "what would
// this look like if we moved scoring to Sonnet 5" without re-running anything.
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

// ─── Token pricing, USD per million tokens ──────────────────────────────────
// OpenAI rows mirror lib/ai-usage.js — keep them in sync when either moves.
// Last verified: 2026-07-28.
const PRICING = {
  // OpenAI
  "gpt-5.4-pro":  { in: 30.0, out: 180.0 },
  "gpt-5.4-mini": { in: 0.75, out: 4.50 },
  "gpt-5.4-nano": { in: 0.20, out: 1.25 },
  "gpt-5.4":      { in: 2.50, out: 15.00 },
  "gpt-5-mini":   { in: 0.25, out: 2.00 },
  "gpt-5":        { in: 1.25, out: 10.00 },

  // Anthropic
  "claude-fable-5":    { in: 10.0, out: 50.0 },
  "claude-mythos-5":   { in: 10.0, out: 50.0 },
  "claude-opus-5":     { in: 5.0,  out: 25.0 },
  "claude-opus-4-8":   { in: 5.0,  out: 25.0 },
  "claude-opus-4-7":   { in: 5.0,  out: 25.0 },
  "claude-opus-4-6":   { in: 5.0,  out: 25.0 },
  // Sonnet 5 carries a promotional rate that expires. Rows are priced by their
  // own date so historical rows keep the rate that actually applied.
  "claude-sonnet-5":   { in: 3.0, out: 15.0, introIn: 2.0, introOut: 10.0, introUntil: "2026-08-31" },
  "claude-sonnet-4-6": { in: 3.0,  out: 15.0 },
  "claude-haiku-4-5":  { in: 1.0,  out: 5.0 },
};

const CACHE_WRITE_MULT = 1.25; // Anthropic 5-minute-TTL cache write
const CACHE_READ_MULT = 0.1;

// The model scoring would move to. Shadow cost is computed against this.
const SHADOW_MODEL = process.env.SHADOW_SCORING_MODEL || "claude-sonnet-5";

// ─── RapidAPI plans ─────────────────────────────────────────────────────────
// Samarth's actual plans. Per-call cost is plan price / included quota.
export const RAPIDAPI_PLANS = {
  Pro:   { price: 45,   quota: 6000 },
  Ultra: { price: 250,  quota: 40000 },
  Mega:  { price: 1000, quota: 240000 },
};
for (const k of Object.keys(RAPIDAPI_PLANS)) {
  RAPIDAPI_PLANS[k].rate = RAPIDAPI_PLANS[k].price / RAPIDAPI_PLANS[k].quota;
}
export const ACTIVE_RAPIDAPI_PLAN = process.env.RAPIDAPI_PLAN || "Pro";

// ─── Provider inference ─────────────────────────────────────────────────────
export function providerFor(model) {
  const id = String(model || "").toLowerCase();
  if (id.startsWith("claude")) return "anthropic";
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3")) return "openai";
  if (id.startsWith("rapidapi") || id.includes("linkedin-scraper") || id.includes("linkedin-profile")) return "rapidapi";
  return "other";
}

// Longest-prefix match so `gpt-5.4-mini` never prices as `gpt-5.4` — that
// ordering bug would overcharge scoring by more than 3x.
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

// ─── Token cost math ────────────────────────────────────────────────────────
// Accepts either provider's usage shape:
//   OpenAI    → { prompt_tokens, completion_tokens }
//   Anthropic → { input_tokens, output_tokens, cache_creation_input_tokens,
//                 cache_read_input_tokens }
// Anthropic cached tokens bill at different rates and are NOT included in
// input_tokens, so they are priced separately or the row under-reports.
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

// What the same tokens would cost on the shadow model (default Sonnet 5).
function shadowCost(usage, onDate) {
  const c = computeCallCost(SHADOW_MODEL, usage, onDate);
  return c.ok ? c.cost : 0;
}

// ─── Table bootstrap ────────────────────────────────────────────────────────
// Best-effort auto-create so the first write works with no manual setup.
// Requires the PAT to carry schema.bases:write (it does — CLAUDE.md §11).
let _tableEnsured = false;
async function ensureTable() {
  if (_tableEnsured) return;
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) return;
  try {
    const schemaRes = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
    if (!schemaRes.ok) return;
    const schema = await schemaRes.json();
    const existing = (schema.tables || []).find((t) => t.name === TABLE);
    if (existing) {
      // The table predates later columns. Airtable rejects an unknown field
      // with a 422 rather than ignoring it, so a new dimension would silently
      // fail every write until the column exists. Add what is missing.
      const have = new Set((existing.fields || []).map((f) => f.name));
      const wanted = [
        { name: "User", type: "singleLineText" },
        { name: "User Label", type: "singleLineText" },
      ];
      for (const f of wanted) {
        if (have.has(f.name)) continue;
        try {
          const add = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables/${existing.id}/fields`, {
            method: "POST",
            headers: atHdr,
            body: JSON.stringify(f),
          });
          if (!add.ok) console.warn(`[cost-log] could not add field ${f.name}: ${add.status} ${(await add.text()).slice(0, 160)}`);
        } catch (e) {
          console.warn(`[cost-log] add field ${f.name} threw: ${e.message}`);
        }
      }
      _tableEnsured = true;
      return;
    }
    const create = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables`, {
      method: "POST",
      headers: atHdr,
      body: JSON.stringify({
        name: TABLE,
        description: "Per-call cost + activity rows. Written by lib/llm-cost-log.js; read by /api/cost-log.",
        fields: [
          { name: "Provider", type: "singleLineText" },
          { name: "Route", type: "singleLineText" },
          { name: "Model", type: "singleLineText" },
          { name: "Priced As", type: "singleLineText" },
          { name: "Campaign", type: "singleLineText" },
          { name: "User", type: "singleLineText" },
          { name: "User Label", type: "singleLineText" },
          { name: "Input Tokens", type: "number", options: { precision: 0 } },
          { name: "Output Tokens", type: "number", options: { precision: 0 } },
          { name: "Cache Write Tokens", type: "number", options: { precision: 0 } },
          { name: "Cache Read Tokens", type: "number", options: { precision: 0 } },
          { name: "Cost USD", type: "number", options: { precision: 8 } },
          { name: "Shadow Cost USD", type: "number", options: { precision: 8 } },
          { name: "Shadow Model", type: "singleLineText" },
          { name: "Intro Rate", type: "checkbox", options: { icon: "check", color: "greenBright" } },
          { name: "Units", type: "number", options: { precision: 0 } },
          { name: "Day", type: "singleLineText" },
          { name: "Hour", type: "number", options: { precision: 0 } },
          { name: "Called At", type: "singleLineText" },
          { name: "Post Key", type: "singleLineText" },
          { name: "Action", type: "singleLineText" },
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

async function writeRow(fields) {
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
  return { ok: true };
}

// ─── LLM call ───────────────────────────────────────────────────────────────
export async function logLLMCall({ route, model, usage, campaignId = "", user = "", userLabel = "", postKey = "", action = "", meta = {} }) {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const c = computeCallCost(model, usage, day);
    const isScoring = String(route || "").includes("score");

    const fields = {
      Provider: providerFor(model),
      Route: String(route || "unknown"),
      Model: String(model || "unknown"),
      "Priced As": c.pricedAs,
      Campaign: String(campaignId || ""),
      User: String(user || ""),
      "User Label": String(userLabel || ""),
      "Input Tokens": c.inTok,
      "Output Tokens": c.outTok,
      "Cache Write Tokens": c.cacheWrite,
      "Cache Read Tokens": c.cacheRead,
      "Cost USD": Number(c.cost.toFixed(8)),
      // Only scoring carries a shadow price — it is the call we are actually
      // considering moving. App calls are already on Anthropic.
      "Shadow Cost USD": isScoring ? Number(shadowCost(usage, day).toFixed(8)) : Number(c.cost.toFixed(8)),
      "Shadow Model": isScoring ? SHADOW_MODEL : String(model || ""),
      "Intro Rate": !!c.intro,
      Units: 1,
      Day: day,
      Hour: now.getUTCHours(),
      "Called At": now.toISOString(),
      "Post Key": String(postKey || "").slice(0, 255),
      Action: String(action || route || ""),
      Meta: JSON.stringify(meta).slice(0, 2000),
    };
    return await writeRow(fields);
  } catch (e) {
    console.warn(`[cost-log] logLLMCall threw (ignored): ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ─── Non-LLM API call (RapidAPI) ────────────────────────────────────────────
// Priced per request off the active plan, not per token.
export async function logAPICall({ route, host = "", campaignId = "", user = "", userLabel = "", postKey = "", units = 1, action = "", meta = {} }) {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const plan = RAPIDAPI_PLANS[ACTIVE_RAPIDAPI_PLAN] || RAPIDAPI_PLANS.Pro;
    const cost = units * plan.rate;

    const fields = {
      Provider: "rapidapi",
      Route: String(route || "rapidapi"),
      Model: host || "fresh-linkedin-scraper-api",
      "Priced As": `${ACTIVE_RAPIDAPI_PLAN} ($${plan.rate.toFixed(5)}/call)`,
      Campaign: String(campaignId || ""),
      User: String(user || ""),
      "User Label": String(userLabel || ""),
      "Input Tokens": 0,
      "Output Tokens": 0,
      "Cache Write Tokens": 0,
      "Cache Read Tokens": 0,
      "Cost USD": Number(cost.toFixed(8)),
      "Shadow Cost USD": Number(cost.toFixed(8)),
      "Shadow Model": host || "fresh-linkedin-scraper-api",
      "Intro Rate": false,
      Units: units,
      Day: day,
      Hour: now.getUTCHours(),
      "Called At": now.toISOString(),
      "Post Key": String(postKey || "").slice(0, 255),
      Action: String(action || route || ""),
      Meta: JSON.stringify(meta).slice(0, 2000),
    };
    return await writeRow(fields);
  } catch (e) {
    console.warn(`[cost-log] logAPICall threw (ignored): ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ─── Zero-cost activity event ───────────────────────────────────────────────
// Funnel milestones that cost nothing but are what the behavioural metrics are
// actually about: a comment reaching LinkedIn, a task being handled. Without
// these the funnel stops at "draft generated" and we can never compute a real
// cost-per-published-comment.
export async function logActivity({ route, action, campaignId = "", user = "", userLabel = "", postKey = "", meta = {} }) {
  try {
    const now = new Date();
    const fields = {
      Provider: "activity",
      Route: String(route || "activity"),
      Model: "",
      "Priced As": "",
      Campaign: String(campaignId || ""),
      User: String(user || ""),
      "User Label": String(userLabel || ""),
      "Input Tokens": 0,
      "Output Tokens": 0,
      "Cache Write Tokens": 0,
      "Cache Read Tokens": 0,
      "Cost USD": 0,
      "Shadow Cost USD": 0,
      "Shadow Model": "",
      "Intro Rate": false,
      Units: 1,
      Day: now.toISOString().slice(0, 10),
      Hour: now.getUTCHours(),
      "Called At": now.toISOString(),
      "Post Key": String(postKey || "").slice(0, 255),
      Action: String(action || route || ""),
      Meta: JSON.stringify(meta).slice(0, 2000),
    };
    return await writeRow(fields);
  } catch (e) {
    console.warn(`[cost-log] logActivity threw (ignored): ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// Non-blocking convenience for hot paths — never awaited.
export function trackLLMCall(args) {
  logLLMCall(args).catch(() => {});
}
export function trackAPICall(args) {
  logAPICall(args).catch(() => {});
}
export function trackActivity(args) {
  logActivity(args).catch(() => {});
}

export { PRICING, TABLE as COST_LOG_TABLE, MASTER_BASE_ID, SHADOW_MODEL };
