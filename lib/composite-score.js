// ═══════════════════════════════════════════════════════════════════
// COMPOSITE SCORING
// Pure functions for ranking leads using:
//   1. Movement override — any lead with a recent hired/promoted task
//      gets forced to top placement (per Samarth's call, May 16).
//   2. Top X ICP match — counted as a strong signal (per Samarth, May 16:
//      "the topx are completely skipped, this makes the system useless").
//      Uses the task's own Score field directly.
//   3. Composite score from GA visits (Task Type=engagement) + LinkedIn
//      engagement (Task Type=linkedin_engagement) within recency windows.
//   4. Base lead score (from the Leads table's Score field) as floor.
//
// Used by:
//   - /api/sidekick/top-leads-to-call (picks N callable leads)
//   - /api/sidekick/auto-batch/generate (picks N LinkedIn-actionable leads)
//
// Task matching: tasks are matched to leads by LinkedIn URL primarily,
// with Name+Company as a fallback. This catches older top_x tasks that
// may have been created before the LinkedIn URL inheritance fix landed.
// ═══════════════════════════════════════════════════════════════════

import { pickLeadField } from "./lead-fields.js";

// Recency windows — leads with signals older than these get no bonus
const GA_RECENCY_DAYS = 7;          // GA engagement decays in 7d
const LI_ENGAGEMENT_DAYS = 14;       // LinkedIn engagement decays in 14d
const MOVEMENT_DAYS = 30;            // Movements relevant for 30d
const TOP_X_RECENCY_DAYS = 30;       // ICP match relevant for 30d

// Score-weight constants (linear decay within window)
const GA_MAX_BONUS = 20;
const LI_MAX_BONUS = 15;
const TOP_X_MAX_BONUS = 30;          // ICP fit is a strong signal — heaviest weight

const DAY_MS = 86400000;

function ageInDays(record) {
  const f = record.fields || {};
  const ts = f.Created || f.Date || f["Created At"] || null;
  if (!ts) return Infinity;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / DAY_MS);
}

function normalizeUrl(url) {
  if (!url) return "";
  return String(url).toLowerCase().trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/$/, "")
    .split("?")[0]
    .split("#")[0];
}

// Score a single lead given its related task records.
// Tasks should already be filtered to this lead (by LinkedIn URL, email, or name).
export function scoreLeadFromTasks(lead, tasks = []) {
  const baseScore = typeof lead.fields?.Score === "number" ? lead.fields.Score : 50;
  const reasons = [];
  const relevantTasks = [];
  const bonusBreakdown = { ga: 0, li: 0, topx: 0 };
  let bonus = 0;
  let hasMovement = false;
  let movementTask = null;
  let topXTask = null;
  let topXBestScore = 0;
  let mostRecentMovementAge = Infinity;

  for (const t of tasks) {
    const f = t.fields || {};
    const type = f["Task Type"] || "";
    const age = ageInDays(t);

    if (type === "lead_movement" && age <= MOVEMENT_DAYS) {
      relevantTasks.push(t);
      if (age < mostRecentMovementAge) {
        hasMovement = true;
        movementTask = t;
        mostRecentMovementAge = age;
      }
      const movementType = f["Movement Type"] || "Movement";
      const ageLabel = age < 1 ? "today" : `${Math.floor(age)}d ago`;
      const movementReason = `${movementType} ${ageLabel}`;
      if (!reasons.includes(movementReason)) reasons.unshift(movementReason);
    }

    // ─── Top X ICP match ──────────────────────────────────────
    // The task's Score field IS the ICP qualification score (0-100).
    // We use it directly with a 0.3 multiplier (max 30 bonus contribution).
    // This is heavier than GA/LI because ICP fit is durable, not event-based.
    if (type === "top_x" && age <= TOP_X_RECENCY_DAYS) {
      relevantTasks.push(t);
      const taskScore = typeof f.Score === "number" ? f.Score : 0;
      if (taskScore > topXBestScore) {
        topXBestScore = taskScore;
        topXTask = t;
      }
      const ageLabel = age < 1 ? "today" : `${Math.floor(age)}d ago`;
      const scoreReason = f["Score Reason"] || f.Signal || "ICP match";
      // Use the full score reason (was truncated to 100 chars — caused
      // mid-word cutoffs like "(high revenue p" on the chatbot card).
      // The client now shows a short AI-generated summary by default and
      // reveals the full text via the "View more data" toggle.
      const summary = String(scoreReason).trim();
      const reasonStr = `ICP fit (${taskScore}/100) ${ageLabel}${summary ? ` — ${summary}` : ""}`;
      if (!reasons.some(r => r.startsWith("ICP fit"))) {
        reasons.push(reasonStr);
      }
      const decayedBonus = Math.max(0, taskScore * (TOP_X_MAX_BONUS / 100) * (1 - age / TOP_X_RECENCY_DAYS));
      bonus += decayedBonus;
      bonusBreakdown.topx = Math.max(bonusBreakdown.topx, decayedBonus);
    }

    if (type === "engagement" && age <= GA_RECENCY_DAYS) {
      relevantTasks.push(t);
      const signal = f.Signal || "Visited site";
      const ageLabel = age < 1 ? "today" : `${Math.floor(age)}d ago`;
      reasons.push(`${signal} (${ageLabel})`);
      const decayedBonus = Math.max(0, GA_MAX_BONUS * (1 - age / GA_RECENCY_DAYS));
      bonus += decayedBonus;
      bonusBreakdown.ga += decayedBonus;
    }

    if (type === "linkedin_engagement" && age <= LI_ENGAGEMENT_DAYS) {
      relevantTasks.push(t);
      const signal = f.Signal || "LinkedIn engagement";
      const ageLabel = age < 1 ? "today" : `${Math.floor(age)}d ago`;
      reasons.push(`${signal} (${ageLabel})`);
      const decayedBonus = Math.max(0, LI_MAX_BONUS * (1 - age / LI_ENGAGEMENT_DAYS));
      bonus += decayedBonus;
      bonusBreakdown.li += decayedBonus;
    }
  }

  // Sort relevantTasks by recency (newest first) so AI sees freshest context
  relevantTasks.sort((a, b) => ageInDays(a) - ageInDays(b));

  let composite = Math.min(100, Math.round(baseScore + bonus));
  if (hasMovement) composite = Math.max(composite, 90);

  return {
    score: composite,
    baseScore,
    bonus: Math.round(bonus),
    bonusBreakdown: {
      ga: Math.round(bonusBreakdown.ga),
      li: Math.round(bonusBreakdown.li),
      topx: Math.round(bonusBreakdown.topx),
    },
    hasMovement,
    movementTask,
    topXTask,
    topXScore: topXBestScore,
    reasons: reasons.slice(0, 3),
    relevantTasks: relevantTasks.slice(0, 5),
  };
}

// ─── Robust task indexing ───────────────────────────────────────
// Returns lookup maps: tasks by normalized LinkedIn URL, AND by
// normalized name+company. Used to match tasks to leads even when the
// task is missing LinkedIn URL (older account-level Top X tasks).
function indexTasks(tasks) {
  const byLi = new Map();
  const byNameCompany = new Map();
  for (const t of tasks) {
    const f = t.fields || {};
    const li = normalizeUrl(f["LinkedIn URL"] || f["Linkedin URL"] || "");
    if (li) {
      if (!byLi.has(li)) byLi.set(li, []);
      byLi.get(li).push(t);
    }
    const name = String(f.Name || "").toLowerCase().trim();
    const company = String(f.Company || "").toLowerCase().trim();
    if (name && company) {
      const key = `${name}|${company}`;
      if (!byNameCompany.has(key)) byNameCompany.set(key, []);
      byNameCompany.get(key).push(t);
    }
  }
  return { byLi, byNameCompany };
}

// Collect all tasks matching a given lead — tries LinkedIn URL first,
// falls back to name+company. Dedups by task id.
function tasksForLead(lead, indexed) {
  const f = lead.fields || {};
  const li = normalizeUrl(pickLeadField(f, "linkedinUrl") || "");
  const name = String(f.Name || f["Full Name"] || "").toLowerCase().trim();
  const company = String(f.Company || "").toLowerCase().trim();

  const fromLi = li ? (indexed.byLi.get(li) || []) : [];
  const fromNc = name && company ? (indexed.byNameCompany.get(`${name}|${company}`) || []) : [];

  if (!fromLi.length) return fromNc;
  if (!fromNc.length) return fromLi;

  const seen = new Set(fromLi.map(t => t.id));
  return [...fromLi, ...fromNc.filter(t => !seen.has(t.id))];
}

// ─── Dedup ranked candidates by normalized LinkedIn URL ──────────
// AND by normalized name+company as a fallback. Same person can appear
// as multiple Lead records — Apollo and Crunchbase imports often have
// the same human but with different LinkedIn URL slugs (`/in/devi-12345/`
// vs `/in/devipbiswal/`) or even completely different profiles. Pure URL
// dedup misses these; we also collapse on (lowercase name) + (lowercase
// company) to catch them. Keep the highest-scored copy. Filling continues
// until we have maxResults unique candidates.
function dedupAndSlice(scored, maxResults) {
  const seenUrls = new Set();
  const seenNameCo = new Set();
  const unique = [];
  for (const item of scored) {
    const f = item.lead?.fields || {};
    const urlKey = normalizeUrl(item.linkedinUrl);
    const name = String(f.Name || f["Full Name"] || "").toLowerCase().trim();
    const company = String(f.Company || "").toLowerCase().trim();
    const ncKey = (name && company) ? `${name}|${company}` : "";

    // Dedup if EITHER key has been seen
    if (urlKey && seenUrls.has(urlKey)) continue;
    if (ncKey && seenNameCo.has(ncKey)) continue;
    if (!urlKey && !ncKey) continue;  // unidentifiable — skip

    if (urlKey) seenUrls.add(urlKey);
    if (ncKey) seenNameCo.add(ncKey);
    unique.push(item);
    if (unique.length >= maxResults) break;
  }
  return unique;
}

// Rank leads for LinkedIn outreach batch (no phone requirement).
// Excludes leads whose LinkedIn URL already appears in `excludeLinkedIns` set.
export function rankLeadsForBatch({ leads, tasks, excludeLinkedIns, maxResults = 5 }) {
  const indexed = indexTasks(tasks);
  const exclude = excludeLinkedIns instanceof Set ? excludeLinkedIns : new Set();
  const scored = [];

  for (const lead of leads) {
    const f = lead.fields || {};
    const li = normalizeUrl(pickLeadField(f, "linkedinUrl") || "");
    if (!li) continue;
    if (exclude.has(li)) continue;

    const leadTasks = tasksForLead(lead, indexed);
    const s = scoreLeadFromTasks(lead, leadTasks);

    // ─── Inclusion criteria (loosened) ───────────────────────
    // Include if ANY of:
    //   - Movement signal (preempt)
    //   - Top X / GA / LI signal in window (reasons present)
    //   - Lead's own baseScore is high (already qualified)
    if (!s.hasMovement && s.reasons.length === 0 && s.baseScore < 60) continue;

    scored.push({ lead, scoring: s, linkedinUrl: li });
  }

  scored.sort((a, b) => {
    // Movement first
    if (a.scoring.hasMovement && !b.scoring.hasMovement) return -1;
    if (!a.scoring.hasMovement && b.scoring.hasMovement) return 1;
    // Then composite score
    return b.scoring.score - a.scoring.score;
  });

  return dedupAndSlice(scored, maxResults);
}

// Rank leads for "Top N to Call" — composite score across ALL signals.
// IMPORTANT (per Samarth, May 16): phone availability is NOT a hard filter.
// A super-qualified lead without a phone still surfaces; UI shows
// "Enrich Phone" CTA instead of "Call" — phone is enriched on-demand.
export function rankLeadsForCall({ leads, tasks, maxResults = 2 }) {
  const indexed = indexTasks(tasks);
  const scored = [];

  for (const lead of leads) {
    const f = lead.fields || {};
    const phone = pickLeadField(f, "phone");

    const li = normalizeUrl(pickLeadField(f, "linkedinUrl") || "");
    const leadTasks = tasksForLead(lead, indexed);
    const s = scoreLeadFromTasks(lead, leadTasks);

    // Inclusion: must be qualified by signal OR baseline score
    if (!s.hasMovement && s.reasons.length === 0 && s.baseScore < 70) continue;

    scored.push({
      lead, scoring: s, linkedinUrl: li,
      phone: phone || "",
      needsPhoneEnrich: !phone,
      title: pickLeadField(f, "title"),
      email: pickLeadField(f, "email"),
    });
  }

  scored.sort((a, b) => {
    if (a.scoring.hasMovement && !b.scoring.hasMovement) return -1;
    if (!a.scoring.hasMovement && b.scoring.hasMovement) return 1;
    if (b.scoring.score !== a.scoring.score) return b.scoring.score - a.scoring.score;
    // Tiebreak: leads with phone slightly preferred
    if (a.phone && !b.phone) return -1;
    if (!a.phone && b.phone) return 1;
    return 0;
  });

  return dedupAndSlice(scored, maxResults);
}
