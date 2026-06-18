// ─── Role-freshness — shared truth ────────────────────────────────
// One implementation of "does this person still hold the role we think they
// do?", used by BOTH:
//   • /api/role-check  — on-demand verification from the Signal Review tab
//   • /api/linkedin-posts — inline gate BEFORE a lead-level engagement task is
//     created (so we never surface "engage with this CMO" to an SDR after the
//     person has left — the exact failure Kunal flagged on 2026-06-04).
// Keeping it in one place means the two paths can never drift.

import { fetchLinkedInProfile } from "@/lib/linkedin-fetch";

const norm = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");
export function companyMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

// Distinctive title tokens — drop filler + generic seniority words so
// "VP, Marketing" matches "Vice President Marketing" but not "VP Sales".
const TITLE_FILLER = new Set(["the", "and", "for", "of", "global", "senior", "snr", "sr", "junior", "jr", "lead", "head", "vp", "svp", "evp", "vice", "president", "chief", "officer", "director", "manager", "interim", "acting", "group", "regional", "international", "co"]);
function titleTokens(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !TITLE_FILLER.has(w));
}
export function titleStillMatches(stored, current) {
  const s = titleTokens(stored);
  if (!s.length) return true; // nothing distinctive to compare → don't flag
  const c = (current || "").toLowerCase();
  const hits = s.filter(tok => c.includes(tok)).length;
  return hits >= Math.ceil(s.length / 2);
}

// Pure assessment from a normalized profile (no network). Returns
// { status, currentTitle, reason }. status ∈ verified | changed | stale | unverified
export function assessRole(storedTitle, storedCompany, profile) {
  if (!profile) return { status: "unverified", currentTitle: "", reason: "profile fetch returned no data" };
  const exps = profile.experiences || [];
  const current = exps.filter(e => e.isCurrent);
  const atCompany = storedCompany ? current.find(e => companyMatch(e.company, storedCompany)) : null;
  if (storedCompany && current.length && !atCompany) {
    const where = current[0];
    return {
      status: "stale",
      currentTitle: where ? `${where.title} @ ${where.company}` : "",
      currentCompany: where ? where.company || "" : "",
      startedAt: where ? where.startedAt || "" : "",
      reason: `No current role at "${storedCompany}"${where ? ` — now ${where.title} @ ${where.company}` : ""}.`,
    };
  }
  const ref = atCompany || current[0] || exps[0];
  if (!ref) return { status: "unverified", currentTitle: "", reason: "no experience data on profile" };
  const curTitle = ref.title || profile.headline || "";
  if (storedTitle && !titleStillMatches(storedTitle, curTitle)) {
    return { status: "changed", currentTitle: `${curTitle}${ref.company ? ` @ ${ref.company}` : ""}`, currentCompany: ref.company || "", startedAt: ref.startedAt || "", reason: `Title changed: was "${storedTitle}", now "${curTitle}".` };
  }
  return { status: "verified", currentTitle: `${curTitle}${ref.company ? ` @ ${ref.company}` : ""}`, currentCompany: ref.company || "", startedAt: ref.startedAt || "", reason: "Still in role." };
}

// Network wrapper: fetch the live profile then assess. Best-effort — never throws.
// status ∈ verified | changed | stale | unverified | unknown
export async function checkRoleFreshness({ linkedinUrl, storedTitle, storedCompany }) {
  const url = (linkedinUrl || "").trim();
  if (!url) return { status: "unknown", currentTitle: "", reason: "no LinkedIn URL on lead" };
  try {
    const res = await fetchLinkedInProfile(url);
    if (!res.ok) return { status: "unverified", currentTitle: "", reason: `profile fetch failed (${res.error || res.statusCode || "unknown"})` };
    return { ...assessRole(storedTitle, storedCompany, res.profile), fullName: res.profile?.fullName || "" };
  } catch (e) {
    return { status: "unverified", currentTitle: "", reason: e.message };
  }
}
