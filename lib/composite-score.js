// ═══════════════════════════════════════════════════════════════════
// COMPOSITE SCORING
// Pure functions for ranking leads using:
//   1. Movement override — any lead with a recent hired/promoted task
//      gets forced to top placement (per Kunal's call, May 16).
//   2. Composite score from GA visits (Task Type=engagement) + LinkedIn
//      engagement (Task Type=linkedin_engagement) within recency windows.
//   3. Base lead score (from the Leads table's Score field) as floor.
//
// Used by:
//   - /api/sidekick/top-leads-to-call (picks N callable leads)
//   - /api/sidekick/auto-batch/generate (picks N LinkedIn-actionable leads)
//
// Inputs are raw Airtable records; output includes:
//   - score: number 0-100
//   - reasons: array of "why now" justifications, most-recent-first
//   - hasMovement: true if a movement task in last 30d exists
//   - movementTask: the actual task record if hasMovement
// ═══════════════════════════════════════════════════════════════════

import { pickLeadField } from "./lead-fields.js";

// Recency windows — leads with signals older than these get no bonus
const GA_RECENCY_DAYS = 7;       // GA engagement decays in 7d
const LI_ENGAGEMENT_DAYS = 14;   // LinkedIn engagement decays in 14d
const MOVEMENT_DAYS = 30;        // Movements relevant for 30d

// Score-weight constants (linear decay within window)
const GA_MAX_BONUS = 20;
const LI_MAX_BONUS = 15;

const DAY_MS = 86400000;

function ageInDays(record) {
  const f = record.fields || {};
  const ts = f.Created || f.Date || f["Created At"] || null;
  if (!ts) return Infinity;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / DAY_MS);
}

// Score a single lead given its related task records.
// Tasks should already be filtered to this lead (by LinkedIn URL, email, or name).
export function scoreLeadFromTasks(lead, tasks = []) {
  const baseScore = typeof lead.fields?.Score === "number" ? lead.fields.Score : 50;
  const reasons = [];
  let bonus = 0;
  let hasMovement = false;
  let movementTask = null;
  let mostRecentMovementAge = Infinity;

  for (const t of tasks) {
    const f = t.fields || {};
    const type = f["Task Type"] || "";
    const age = ageInDays(t);

    if (type === "lead_movement" && age <= MOVEMENT_DAYS) {
      // Movement leads always preempt. Multiple movements = use most recent.
      if (age < mostRecentMovementAge) {
        hasMovement = true;
        movementTask = t;
        mostRecentMovementAge = age;
      }
      const movementType = f["Movement Type"] || "Movement";
      const ageLabel = age < 1 ? "today" : `${Math.floor(age)}d ago`;
      const movementReason = `${movementType} ${ageLabel}`;
      // Movement reasons go to the front
      if (!reasons.includes(movementReason)) reasons.unshift(movementReason);
    }

    if (type === "engagement" && age <= GA_RECENCY_DAYS) {
      const signal = f.Signal || "Visited site";
      const ageLabel = age < 1 ? "today" : `${Math.floor(age)}d ago`;
      reasons.push(`${signal} (${ageLabel})`);
      // Linear decay: full bonus at age 0, zero at GA_RECENCY_DAYS
      bonus += Math.max(0, GA_MAX_BONUS * (1 - age / GA_RECENCY_DAYS));
    }

    if (type === "linkedin_engagement" && age <= LI_ENGAGEMENT_DAYS) {
      const signal = f.Signal || "LinkedIn engagement";
      const ageLabel = age < 1 ? "today" : `${Math.floor(age)}d ago`;
      reasons.push(`${signal} (${ageLabel})`);
      bonus += Math.max(0, LI_MAX_BONUS * (1 - age / LI_ENGAGEMENT_DAYS));
    }
  }

  // Composite: base + bonus, capped at 100
  // Movement leads get score 90+ regardless of other signals (so they sort to top
  // even when composite scoring is also applied)
  let composite = Math.min(100, Math.round(baseScore + bonus));
  if (hasMovement) composite = Math.max(composite, 90);

  return {
    score: composite,
    baseScore,
    bonus: Math.round(bonus),
    hasMovement,
    movementTask,
    reasons: reasons.slice(0, 3),  // top 3 reasons for UI
  };
}

// Index tasks by lead LinkedIn URL (lowercase, trimmed)
function indexTasksByLinkedIn(tasks) {
  const byLi = new Map();
  for (const t of tasks) {
    const f = t.fields || {};
    const li = (f["LinkedIn URL"] || f["Linkedin URL"] || "").toLowerCase().trim();
    if (!li) continue;
    if (!byLi.has(li)) byLi.set(li, []);
    byLi.get(li).push(t);
  }
  return byLi;
}

// Rank leads for LinkedIn outreach batch (no phone requirement).
// Excludes leads whose LinkedIn URL already appears in `excludeLinkedIns` set.
export function rankLeadsForBatch({ leads, tasks, excludeLinkedIns, maxResults = 5 }) {
  const tasksByLi = indexTasksByLinkedIn(tasks);
  const exclude = excludeLinkedIns instanceof Set ? excludeLinkedIns : new Set();
  const scored = [];

  for (const lead of leads) {
    const f = lead.fields || {};
    const li = (pickLeadField(f, "linkedinUrl") || "").toLowerCase().trim();
    if (!li) continue;             // no LinkedIn URL = can't send connection
    if (exclude.has(li)) continue; // already in active outreach

    const leadTasks = tasksByLi.get(li) || [];
    const s = scoreLeadFromTasks(lead, leadTasks);

    // Inclusion criteria:
    //   - Movement leads always included (preempt)
    //   - Otherwise: must have at least one GA/LI signal OR baseScore >= 60
    if (!s.hasMovement && s.reasons.length === 0 && s.baseScore < 60) continue;

    scored.push({ lead, scoring: s, linkedinUrl: li });
  }

  // Sort: movement first (most-recent), then composite score desc
  scored.sort((a, b) => {
    if (a.scoring.hasMovement && !b.scoring.hasMovement) return -1;
    if (!a.scoring.hasMovement && b.scoring.hasMovement) return 1;
    return b.scoring.score - a.scoring.score;
  });

  return scored.slice(0, maxResults);
}

// Rank leads for "Top N to Call" — composite score across ALL signals.
// IMPORTANT (per Kunal, May 16): phone availability is NOT a hard filter.
// A super-qualified lead without a phone still surfaces; UI shows
// "Enrich Phone" CTA instead of "Call" — phone is enriched on-demand.
//
// Inclusion criteria (must satisfy at least ONE):
//   - Movement signal (preempt)
//   - GA / LinkedIn engagement signal in recency window
//   - Base lead score >= 70 (already a high-priority lead)
export function rankLeadsForCall({ leads, tasks, maxResults = 2 }) {
  const tasksByLi = indexTasksByLinkedIn(tasks);
  const scored = [];

  for (const lead of leads) {
    const f = lead.fields || {};
    const phone = pickLeadField(f, "phone");

    const li = (pickLeadField(f, "linkedinUrl") || "").toLowerCase().trim();
    const leadTasks = li ? (tasksByLi.get(li) || []) : [];
    const s = scoreLeadFromTasks(lead, leadTasks);

    // Inclusion: must be qualified by signal OR baseline score
    if (!s.hasMovement && s.reasons.length === 0 && s.baseScore < 70) continue;

    scored.push({
      lead, scoring: s, linkedinUrl: li,
      phone: phone || "",                // empty string = needs enrichment
      needsPhoneEnrich: !phone,          // flag for chatbot to render correct CTA
      title: pickLeadField(f, "title"),
      email: pickLeadField(f, "email"),
    });
  }

  scored.sort((a, b) => {
    // Movement leads always first
    if (a.scoring.hasMovement && !b.scoring.hasMovement) return -1;
    if (!a.scoring.hasMovement && b.scoring.hasMovement) return 1;
    // Then by composite score
    if (b.scoring.score !== a.scoring.score) return b.scoring.score - a.scoring.score;
    // Tiebreak: leads with phone slightly preferred (one less step for operator)
    if (a.phone && !b.phone) return -1;
    if (!a.phone && b.phone) return 1;
    return 0;
  });

  return scored.slice(0, maxResults);
}
