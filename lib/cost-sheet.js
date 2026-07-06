// ─── Cost Sheet poster ──────────────────────────────────────────────
// Thin, fire-and-forget client for the external Google Sheet "Side Kick — Client
// Cost Tracker" web app (Apps Script /exec endpoint). Posts already-computed cost
// rows so client OpenAI / RapidAPI spend lands in the billing ledger automatically.
//
// Deliberately dumb: it does NOT compute costs (ai-usage.js / rapidapi-usage.js already
// accumulate per-campaign counters in Airtable) and it is NOT called on the per-call hot
// path — the /api/cost-snapshot route batches a delta into one row per client and calls
// this once. Never throws, never blocks; a missing/failing sheet must never break a scan.
//
// Config (Vercel env — set after deploying the cost-tracker Apps Script web app):
//   COST_TRACKER_URL     the Apps Script /exec URL
//   COST_TRACKER_SECRET  the SECRET constant in that script

const COST_TRACKER_URL = process.env.COST_TRACKER_URL;
const COST_TRACKER_SECRET = process.env.COST_TRACKER_SECRET;

export function costSheetConfigured() {
  return !!(COST_TRACKER_URL && COST_TRACKER_SECRET);
}

// Post an array of row objects (keyed by the sheet's header names). Idempotent on the
// sheet side via each row's "Entry ID" (re-pushing the same id is skipped, never doubled).
export async function postCostRows(rows) {
  if (!costSheetConfigured()) return { ok: false, skipped: true, reason: "COST_TRACKER_URL/SECRET not set" };
  if (!Array.isArray(rows) || rows.length === 0) return { ok: true, appended: 0 };
  try {
    const res = await fetch(COST_TRACKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: COST_TRACKER_SECRET, rows }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) console.warn(`[cost-sheet] POST failed: HTTP ${res.status}`);
    return { ok: res.ok, status: res.status, ...data };
  } catch (e) {
    console.warn(`[cost-sheet] postCostRows threw (silenced): ${e.message}`);
    return { ok: false, error: e.message };
  }
}
