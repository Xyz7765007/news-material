import { NextResponse } from "next/server";
import { fetchLinkedInProfile } from "@/lib/linkedin-fetch";

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

const norm = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
function companyMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
// Meaningful tokens of a job title — drop filler + generic seniority words so
// "VP, Marketing" vs "Vice President Marketing" still matches, but "VP Marketing"
// vs "VP Sales" does not.
const TITLE_FILLER = new Set(["the", "and", "for", "of", "global", "senior", "snr", "sr", "junior", "jr", "lead", "head", "vp", "svp", "evp", "vice", "president", "chief", "officer", "director", "manager", "interim", "acting", "group", "regional", "international"]);
function titleTokens(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !TITLE_FILLER.has(w));
}
function titleStillMatches(stored, current) {
  const s = titleTokens(stored);
  if (!s.length) return true; // nothing distinctive to compare → don't flag
  const c = (current || "").toLowerCase();
  const hits = s.filter(tok => c.includes(tok)).length;
  return hits >= Math.ceil(s.length / 2); // at least half the distinctive tokens persist
}

function assess(storedTitle, storedCompany, profile) {
  if (!profile) return { status: "unverified", currentTitle: "", reason: "profile fetch returned no data" };
  const exps = profile.experiences || [];
  const current = exps.filter(e => e.isCurrent);
  // Among current roles, is there one at the company we have on file?
  const atCompany = storedCompany ? current.find(e => companyMatch(e.company, storedCompany)) : null;
  if (storedCompany && current.length && !atCompany) {
    // They hold current roles, but none at the stored company → they've moved on.
    const where = current[0];
    return {
      status: "stale",
      currentTitle: where ? `${where.title} @ ${where.company}` : "",
      reason: `No current role at "${storedCompany}"${where ? ` — now ${where.title} @ ${where.company}` : ""}.`,
    };
  }
  const ref = atCompany || current[0] || exps[0];
  if (!ref) return { status: "unverified", currentTitle: "", reason: "no experience data on profile" };
  const curTitle = ref.title || profile.headline || "";
  if (storedTitle && !titleStillMatches(storedTitle, curTitle)) {
    return {
      status: "changed",
      currentTitle: `${curTitle}${ref.company ? ` @ ${ref.company}` : ""}`,
      reason: `Title changed: was "${storedTitle}", now "${curTitle}".`,
    };
  }
  return { status: "verified", currentTitle: `${curTitle}${ref.company ? ` @ ${ref.company}` : ""}`, reason: "Still in role." };
}

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
        const url = (it.linkedinUrl || "").trim();
        if (!url) return { ...it, status: "unknown", currentTitle: "", reason: "no LinkedIn URL on lead" };
        try {
          const res = await fetchLinkedInProfile(url);
          if (!res.ok) return { ...it, status: "unverified", currentTitle: "", reason: `profile fetch failed (${res.error || res.statusCode || "unknown"})` };
          return { ...it, ...assess(it.storedTitle, it.storedCompany, res.profile), fullName: res.profile?.fullName || "" };
        } catch (e) {
          return { ...it, status: "unverified", currentTitle: "", reason: e.message };
        }
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
