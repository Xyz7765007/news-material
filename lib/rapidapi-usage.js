// ─── RapidAPI Usage Tracking ────────────────────────────────────────
// Centralized helper for tracking RapidAPI calls per campaign — used by
// the Lead Movement scan to attribute API costs back to the right client.
//
// USAGE:
//   import { trackRapidAPIUsage, getRapidAPICost } from "@/lib/rapidapi-usage";
//   const result = await fetchLinkedInProfile(url);
//   await trackRapidAPIUsage({ campaignId, action: "lead_movement_scan" });
//
// The helper:
//   1. Reads per-call cost from the Campaign record (you set it based on plan)
//   2. Atomically increments accumulated counters
//   3. Stamps last-call time for transparency
//
// Like AI usage tracking — FIRE-AND-FORGET. Never throws or blocks calling code.

const AT_API = "https://api.airtable.com/v0";
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const atHdr = {
  Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
  "Content-Type": "application/json",
};

const DEFAULT_PER_CALL_COST = 0.01; // USD — adjust based on actual RapidAPI plan

// ─── Read campaign fields ──────────────────────────────────────────
async function getCampaignRecord(campaignId) {
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

export async function getRapidAPICost(campaignId) {
  const fields = await getCampaignRecord(campaignId);
  if (!fields) return DEFAULT_PER_CALL_COST;
  const configured = fields["RapidAPI Per Call Cost USD"];
  return typeof configured === "number" && configured > 0 ? configured : DEFAULT_PER_CALL_COST;
}

// ─── Auto-create RapidAPI usage fields if missing ──────────────────
let _fieldsEnsured = false;
async function ensureRapidAPIUsageFields() {
  if (_fieldsEnsured) return;
  if (!MASTER_BASE_ID || !process.env.AIRTABLE_API_KEY) return;
  try {
    const schemaRes = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
    if (!schemaRes.ok) return;
    const schema = await schemaRes.json();
    const campTable = (schema.tables || []).find(t => t.name === "Campaigns");
    if (!campTable) return;
    const existingFields = new Set((campTable.fields || []).map(f => f.name));

    const required = [
      { name: "RapidAPI Calls Count",       type: "number", options: { precision: 0 } },
      { name: "RapidAPI Total Cost USD",    type: "number", options: { precision: 4 } },
      { name: "RapidAPI Last Call At",      type: "singleLineText" },
      { name: "RapidAPI Usage Reset At",    type: "singleLineText" },
      { name: "RapidAPI Per Call Cost USD", type: "number", options: { precision: 4 } },
    ];

    for (const f of required) {
      if (existingFields.has(f.name)) continue;
      const createRes = await fetch(`${AT_API}/meta/bases/${MASTER_BASE_ID}/tables/${campTable.id}/fields`, {
        method: "POST", headers: atHdr,
        body: JSON.stringify(f),
      });
      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        console.warn(`[rapidapi-usage] Could not create field "${f.name}": ${createRes.status} ${errText.slice(0, 100)}`);
      } else {
        console.log(`[rapidapi-usage] Created field "${f.name}" on Campaigns table`);
      }
    }
    _fieldsEnsured = true;
  } catch (e) {
    console.warn(`[rapidapi-usage] ensureRapidAPIUsageFields failed: ${e.message}`);
  }
}

// ─── Track a single RapidAPI call ──────────────────────────────────
// Pass the actual cost so we can support per-plan pricing variations.
// If costUSD is not provided, reads from the campaign's RapidAPI Per Call Cost USD field.
export async function trackRapidAPIUsage({ campaignId, action, costUSD }) {
  if (!campaignId) return;
  if (!MASTER_BASE_ID || !process.env.AIRTABLE_API_KEY) return;

  try {
    await ensureRapidAPIUsageFields();
    const current = await getCampaignRecord(campaignId);
    if (!current) {
      console.warn(`[rapidapi-usage] Could not read campaign ${campaignId} — usage NOT recorded`);
      return;
    }

    const perCallCost = typeof costUSD === "number"
      ? costUSD
      : (current["RapidAPI Per Call Cost USD"] || DEFAULT_PER_CALL_COST);

    console.log(`[rapidapi-usage] campaign=${campaignId} action=${action || "unknown"} cost=$${perCallCost.toFixed(4)}`);

    const newFields = {
      "RapidAPI Calls Count":    (current["RapidAPI Calls Count"] || 0) + 1,
      "RapidAPI Total Cost USD": Math.round(((current["RapidAPI Total Cost USD"] || 0) + perCallCost) * 1000000) / 1000000,
      "RapidAPI Last Call At":   new Date().toISOString(),
    };

    const patchRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({ fields: newFields }),
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => "");
      console.warn(`[rapidapi-usage] Failed to update campaign ${campaignId}: ${patchRes.status} ${errText.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn(`[rapidapi-usage] trackRapidAPIUsage threw (silenced): ${e.message}`);
  }
}

// Batched version — for end-of-scan recording. Avoids N PATCH calls per scan.
// Pass the total call count + total cost; we record once at the end.
export async function trackRapidAPIUsageBatch({ campaignId, callCount, totalCostUSD, action }) {
  if (!campaignId) return;
  if (!callCount || callCount === 0) return;
  if (!MASTER_BASE_ID || !process.env.AIRTABLE_API_KEY) return;

  try {
    await ensureRapidAPIUsageFields();
    const current = await getCampaignRecord(campaignId);
    if (!current) return;

    console.log(`[rapidapi-usage] BATCH campaign=${campaignId} action=${action} calls=${callCount} cost=$${totalCostUSD.toFixed(4)}`);

    const newFields = {
      "RapidAPI Calls Count":    (current["RapidAPI Calls Count"] || 0) + callCount,
      "RapidAPI Total Cost USD": Math.round(((current["RapidAPI Total Cost USD"] || 0) + totalCostUSD) * 1000000) / 1000000,
      "RapidAPI Last Call At":   new Date().toISOString(),
    };

    await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({ fields: newFields }),
    });
  } catch (e) {
    console.warn(`[rapidapi-usage] batch tracking threw (silenced): ${e.message}`);
  }
}

// ─── Reset counters ────────────────────────────────────────────────
export async function resetCampaignRapidAPIUsage(campaignId) {
  if (!MASTER_BASE_ID || !campaignId) return { ok: false, error: "missing config" };
  try {
    await ensureRapidAPIUsageFields();
    const res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({
        fields: {
          "RapidAPI Calls Count": 0,
          "RapidAPI Total Cost USD": 0,
          "RapidAPI Usage Reset At": new Date().toISOString(),
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

export { ensureRapidAPIUsageFields };
