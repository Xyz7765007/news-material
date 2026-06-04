import { NextResponse } from "next/server";
import { checkRoleFreshness } from "@/lib/role-freshness";

// ─── Role-freshness check ─────────────────────────────────────────
// Isolated, on-demand verification that a tracked lead STILL holds the role
// we think they do — so we never surface "engage with this CMO" after they've
// left the role (the exact failure Kunal flagged in the 2026-06-04 Material
// review: "this person is no longer CMO... that created a lot of issue").
//
// Deliberately a STANDALONE endpoint, NOT a gate inside the LinkedIn-posts scan:
// that scan is resumable, 300s-budgeted, and shared by every campaign, so an
// inline fetch there is high blast radius. Here it runs only on the handful of
// lead-level signals an operator is actually reviewing (Kunal: "you have 2000
// people but only 10-20 signals go out — it's not that expensive to check"),
// and is trivially cron-able later by POSTing the open linkedin_engagement tasks.
//
// POST body:
//   {
//     baseId,                       // campaign base
//     items: [{ taskId?, linkedinUrl, storedTitle, storedCompany }],
//     stamp?: boolean (default true) // write Role Status back onto the Task
//     maxChecks?: number (default 15) // RapidAPI cost guard per call
//   }
// Returns { ok, checked, summary, results:[{...item, status, currentTitle, reason}] }
//   status ∈ verified | changed | stale | unverified | unknown

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;

async function stampTasks(baseId, updates) {
  // Airtable PATCH caps at 10 records/call. Best-effort — a missing Role Status
  // field (typecast can't create fields) just no-ops the write; the caller still
  // gets the live result in the response.
  for (let i = 0; i < updates.length; i += 10) {
    const batch = updates.slice(i, i + 10);
    await fetch(`${AT_API}/${baseId}/Tasks`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch, typecast: true }),
    });
  }
}

export async function POST(request) {
  try {
    // Costs RapidAPI credits — block client-portal callers, same as /api/scan.
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) {
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }
    const body = await request.json();
    const { baseId, items = [], stamp = true, maxChecks = 15 } = body;
    if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
    if (!Array.isArray(items) || items.length === 0) return NextResponse.json({ error: "items[] required" }, { status: 400 });

    const toCheck = items.slice(0, Math.max(1, Math.min(50, maxChecks)));
    const nowISO = new Date().toISOString();
    const CONC = 4; // polite concurrency against RapidAPI
    const results = [];
    for (let i = 0; i < toCheck.length; i += CONC) {
      const batch = toCheck.slice(i, i + CONC);
      const r = await Promise.all(batch.map(async (it) => {
        const f = await checkRoleFreshness({ linkedinUrl: it.linkedinUrl, storedTitle: it.storedTitle, storedCompany: it.storedCompany });
        return { ...it, ...f };
      }));
      results.push(...r);
    }

    if (stamp && AIRTABLE_KEY) {
      const updates = results
        .filter(r => r.taskId && r.status !== "unknown")
        .map(r => ({ id: r.taskId, fields: { "Role Status": r.status, "Role Checked At": nowISO, "Role Check Note": (r.reason || "").slice(0, 200) } }));
      if (updates.length) { try { await stampTasks(baseId, updates); } catch (_) { /* best-effort */ } }
    }

    const summary = results.reduce((m, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {});
    return NextResponse.json({ ok: true, checked: results.length, requested: items.length, summary, results, checkedAt: nowISO });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
