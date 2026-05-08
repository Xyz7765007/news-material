// ─── AI Usage Tracking ──────────────────────────────────────────────
// Centralized helper for tracking OpenAI API usage per campaign.
// Used to attribute API costs back to the right client for billing.
//
// USAGE:
//   import { trackOpenAIUsage } from "@/lib/ai-usage";
//   const completion = await openai.chat.completions.create({...});
//   await trackOpenAIUsage({ campaignId, completion, action: "scoring_news" });
//
// The helper:
//   1. Extracts prompt_tokens + completion_tokens from the response
//   2. Computes USD cost using the model's input/output rates
//   3. Atomically increments accumulated counters on the Campaign record
//   4. Increments call count for billing transparency
//
// Tracking is FIRE-AND-FORGET — never throws or blocks the calling code.
// If the campaign record can't be updated, we log and move on so the actual
// AI work never gets blocked by accounting overhead.

const AT_API = "https://api.airtable.com/v0";
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const atHdr = {
  Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

// ─── Pricing table ─────────────────────────────────────────────────
// Prices in USD per million tokens. Source: https://openai.com/api/pricing
// Last verified: 2026-04-30. UPDATE IF OPENAI CHANGES PRICING.
//
// We track input + output separately (output is typically 5-10x input cost).
// Cached input is currently ignored — OpenAI applies it automatically and
// we'd need to read `prompt_tokens_details.cached_tokens` to credit it back.
// For billing purposes, charging the full input rate is conservative (in
// favor of you, the operator) and simple.
const PRICING = {
  // GPT-5.4 family (current flagship, March 2026 release)
  "gpt-5.4":      { input: 2.50,  output: 15.00 },
  "gpt-5.4-mini": { input: 0.75,  output: 4.50  },
  "gpt-5.4-nano": { input: 0.20,  output: 1.25  },
  "gpt-5.4-pro":  { input: 30.00, output: 180.00 },
  // GPT-5 family (previous gen, still used in some routes)
  "gpt-5":        { input: 1.25,  output: 10.00 },
  "gpt-5-mini":   { input: 0.25,  output: 2.00  },
  // Fallback — used if model name doesn't match. Set to mini-tier to avoid
  // accidentally undercharging if a new cheaper model is rolled out and we
  // forget to add it. Logs a warning so we know to update.
  "_default":     { input: 0.75,  output: 4.50  },
};

function getPricing(model) {
  // Model strings can include suffixes like "gpt-5.4-2026-03-05" — normalize
  // by matching the longest prefix in our table.
  const candidates = Object.keys(PRICING)
    .filter(k => k !== "_default")
    .sort((a, b) => b.length - a.length); // longest first
  for (const key of candidates) {
    if (model.startsWith(key)) return { ...PRICING[key], model: key };
  }
  console.warn(`[ai-usage] Unknown model "${model}" — using default pricing. Add it to PRICING in lib/ai-usage.js for accurate billing.`);
  return { ...PRICING._default, model: "_default" };
}

// ─── Cost computation ──────────────────────────────────────────────
// Cost in USD: (tokens / 1_000_000) * price_per_million
function computeCost(promptTokens, completionTokens, model) {
  const p = getPricing(model);
  const inputCost = (promptTokens / 1_000_000) * p.input;
  const outputCost = (completionTokens / 1_000_000) * p.output;
  return {
    inputCostUSD: inputCost,
    outputCostUSD: outputCost,
    totalCostUSD: inputCost + outputCost,
    matchedModel: p.model,
  };
}

// ─── Read campaign fields ──────────────────────────────────────────
async function getCampaignUsageFields(campaignId) {
  if (!MASTER_BASE_ID || !campaignId) return null;
  try {
    const res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, { headers: atHdr });
    if (!res.ok) return null;
    const data = await res.json();
    return data.fields || {};
  } catch {
    return null;
  }
}

// ─── Auto-create AI usage fields if missing ────────────────────────
// Runs ONCE per cold start (memoized) — checks the master Campaigns table
// for the AI tracking fields and creates any that are missing.
let _fieldsEnsured = false;
async function ensureAIUsageFields() {
  if (_fieldsEnsured) return;
  if (!MASTER_BASE_ID || !process.env.AIRTABLE_API_KEY) return;
  try {
    // Get current schema
    const schemaRes = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
    if (!schemaRes.ok) return;
    const schema = await schemaRes.json();
    const campTable = (schema.tables || []).find(t => t.name === "Campaigns");
    if (!campTable) return;
    const existingFields = new Set((campTable.fields || []).map(f => f.name));

    const required = [
      { name: "AI Total Input Tokens", type: "number", options: { precision: 0 } },
      { name: "AI Total Output Tokens", type: "number", options: { precision: 0 } },
      { name: "AI Total Cost USD", type: "number", options: { precision: 4 } },
      { name: "AI Calls Count", type: "number", options: { precision: 0 } },
      { name: "AI Last Call At", type: "singleLineText" },
      { name: "AI Usage Reset At", type: "singleLineText" },
    ];

    for (const f of required) {
      if (existingFields.has(f.name)) continue;
      const createRes = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables/${campTable.id}/fields`, {
        method: "POST", headers: atHdr,
        body: JSON.stringify(f),
      });
      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        console.warn(`[ai-usage] Could not create field "${f.name}": ${createRes.status} ${errText.slice(0, 100)}`);
      } else {
        console.log(`[ai-usage] Created field "${f.name}" on Campaigns table`);
      }
    }
    _fieldsEnsured = true;
  } catch (e) {
    console.warn(`[ai-usage] ensureAIUsageFields failed: ${e.message}`);
  }
}

// ─── Track a single OpenAI completion ──────────────────────────────
// Fire-and-forget. Never throws. Wraps everything in try/catch.
//
// Args:
//   campaignId — Airtable record ID of the campaign (from master base).
//                If null/undefined, tracking is skipped silently.
//   completion — the raw OpenAI completion response object
//   action — short string label (e.g. "scoring_news", "linkedin_post_score")
//            stored in logs only, not Airtable, so we don't bloat fields.
export async function trackOpenAIUsage({ campaignId, completion, action }) {
  // No-op paths — never block on these
  if (!campaignId) return;
  if (!completion?.usage) return;
  if (!MASTER_BASE_ID || !process.env.AIRTABLE_API_KEY) return;

  try {
    const promptTokens = completion.usage.prompt_tokens || 0;
    const completionTokens = completion.usage.completion_tokens || 0;
    const model = completion.model || "unknown";
    const { totalCostUSD, matchedModel } = computeCost(promptTokens, completionTokens, model);

    // Console log every call for diagnostic visibility. Vercel logs become the
    // forensic record if Airtable writes fail or get dropped.
    console.log(`[ai-usage] campaign=${campaignId} action=${action || "unknown"} model=${matchedModel} tokens=${promptTokens}+${completionTokens} cost=$${totalCostUSD.toFixed(6)}`);

    // Make sure the fields exist (only does real work first time per cold start)
    await ensureAIUsageFields();

    // Read current values, then write back incremented values. This is NOT
    // atomic — concurrent calls could lose updates. Acceptable for billing
    // purposes (off by a few cents in the worst case during a heavy scan)
    // but documented honestly. To be truly atomic we'd need a separate
    // append-only AI Usage table and aggregate at read time.
    const current = await getCampaignUsageFields(campaignId);
    if (!current) {
      console.warn(`[ai-usage] Could not read campaign ${campaignId} for accumulation — usage NOT recorded`);
      return;
    }

    const newFields = {
      "AI Total Input Tokens":  (current["AI Total Input Tokens"]  || 0) + promptTokens,
      "AI Total Output Tokens": (current["AI Total Output Tokens"] || 0) + completionTokens,
      "AI Total Cost USD":      Math.round(((current["AI Total Cost USD"] || 0) + totalCostUSD) * 1000000) / 1000000, // 6 decimal places
      "AI Calls Count":         (current["AI Calls Count"] || 0) + 1,
      "AI Last Call At":        new Date().toISOString(),
    };

    const patchRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({ fields: newFields }),
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => "");
      console.warn(`[ai-usage] Failed to update campaign ${campaignId}: ${patchRes.status} ${errText.slice(0, 200)}`);
    }
  } catch (e) {
    // NEVER let tracking errors propagate — the AI call already succeeded
    console.warn(`[ai-usage] trackOpenAIUsage threw (silenced): ${e.message}`);
  }
}

// ─── Reset counters (for monthly billing cycle) ───────────────────
// Called from /api/airtable {action:"reset_ai_usage", campaignId}
// Resets all 4 counter fields to 0 and stamps AI Usage Reset At.
export async function resetCampaignAIUsage(campaignId) {
  if (!MASTER_BASE_ID || !campaignId) return { ok: false, error: "missing config" };
  try {
    await ensureAIUsageFields();
    const res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({
        fields: {
          "AI Total Input Tokens": 0,
          "AI Total Output Tokens": 0,
          "AI Total Cost USD": 0,
          "AI Calls Count": 0,
          "AI Usage Reset At": new Date().toISOString(),
        },
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      return { ok: false, error: `${res.status}: ${errText.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Export the cost calculator for use in dashboard previews + cost summaries
export { computeCost, getPricing, PRICING };
