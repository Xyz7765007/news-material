// ─── Lead Movement Detection ────────────────────────────────────────
// Classifies movement based on three categories (per Kunal's spec):
//
//   PROMOTED: Same company as stored, new role within window
//     → Action: re-engage with new context (new title, new responsibilities)
//
//   HIRED:    Different company, and new company IS one of our accounts
//     → Action: they joined a target account; reassign lead, create outreach
//
//   EXITED:   Different company, and new company is NOT one of our accounts
//     → Action: they left our account; mark stale + capture destination info
//
// PHILOSOPHY:
//   - Use experiences[0].startedAt as source of truth for "when movement happened"
//   - Don't trigger on title string diffs alone (LinkedIn re-saves are noisy)
//   - Treat the lead's CURRENTLY STORED ACCOUNT as the reference point —
//     this is the account in our Airtable that we have them assigned to.

import { matchCompanyNames } from "./company-match";
import { daysSince } from "./linkedin-fetch";

// Returns { type, reason, details, recommendedAction }
// type ∈ "Promoted" | "Hired" | "Exited" | "None" | "Unavailable" | "Stale"
export function classifyMovement({
  lead,                    // { id, name, storedCompany, storedTitle, linkedinUrl }
  storedAccount,           // The Account record this lead is currently assigned to (string)
  profile,                 // The normalized profile from linkedin-fetch
  movementWindowDays = 90, // The "newly" cutoff
  allAccountNames = [],    // List of all account names in campaign (for Hired check)
}) {
  if (!profile || !profile.experiences || profile.experiences.length === 0) {
    return {
      type: "Unavailable",
      reason: "no profile experiences returned",
      details: null,
    };
  }

  // PEOPLE CAN HOLD MULTIPLE CONCURRENT CURRENT ROLES (founder + investor +
  // advisor is very common at exec level). For Lead Movement detection,
  // we want the role at the STORED ACCOUNT if any current role matches it.
  // Otherwise fall back to the most-recently-started current role
  // (experiences[0] after sorting in normalizeProfile).
  const currentExperiences = profile.experiences.filter(e => e.isCurrent);
  let current = null;
  let matchedStoredAccount = false;

  // First pass: find a current role at the stored account (Promotion case)
  for (const exp of currentExperiences) {
    const m = matchCompanyNames(storedAccount, exp.company);
    if (m.matched) {
      current = exp;
      matchedStoredAccount = true;
      break;
    }
  }

  // Second pass: no current role at stored account — they left.
  // Use most-recently-started current role (or fallback to experiences[0]
  // if there are no current roles, meaning they're between jobs).
  if (!current) {
    current = currentExperiences[0] || profile.experiences[0];
  }

  // "Previous" = the experience that was the lead's PRIOR role at the
  // stored account, OR the most recent past experience if they've moved on.
  // For movement classification we mostly care about the immediately prior
  // role to "current".
  const currentIdx = profile.experiences.indexOf(current);
  const previous = profile.experiences[currentIdx + 1] || null;
  const currentDaysInRole = daysSince(current.startedAt);

  const baseDetails = {
    currentCompany: current.company,
    currentTitle: current.title,
    currentStartedAt: current.startedAt,
    daysInCurrentRole: currentDaysInRole,
    previousCompany: previous?.company || null,
    previousTitle: previous?.title || null,
    storedCompany: lead.storedCompany,
    storedTitle: lead.storedTitle,
    storedAccount: storedAccount,
  };

  // Step 1: We already know if a current experience matches stored account
  // (computed above in the multi-current-role lookup). Use that as the gate.

  // Step 2: Did the role start within the window?
  // If we can't determine start date, classify as None (don't trigger uncertain tasks)
  const withinWindow = currentDaysInRole !== null && currentDaysInRole <= movementWindowDays;

  // ────────────────────────────────────────────────────────────
  // CASE A: A current role matches stored account (still at our target)
  // ────────────────────────────────────────────────────────────
  if (matchedStoredAccount) {
    if (!withinWindow) {
      // Still at our account, but they've been in this role for a while.
      // Not actionable as movement, but update tracking.
      return {
        type: "None",
        reason: currentDaysInRole === null
          ? "still at stored account; role start date unknown"
          : `still at stored account; in role ${currentDaysInRole} days (outside ${movementWindowDays}-day window)`,
        details: baseDetails,
      };
    }
    // Same company, new role within window = Promotion
    return {
      type: "Promoted",
      reason: `promoted within ${storedAccount}; new role started ${currentDaysInRole}d ago`,
      details: { ...baseDetails },
      recommendedAction: "Update lead title; create outreach task on promotion.",
    };
  }

  // ────────────────────────────────────────────────────────────
  // CASE B: Current company does NOT match stored account
  // The lead has left our target. Determine where they went.
  // ────────────────────────────────────────────────────────────

  // Check if their new company is also in our account list (Hired case)
  let destinationAccount = null;
  for (const acctName of allAccountNames) {
    if (!acctName) continue;
    const m = matchCompanyNames(acctName, current.company);
    if (m.matched) {
      destinationAccount = acctName;
      break;
    }
  }

  if (!withinWindow) {
    // Lead left a long time ago — records are stale. Don't create a task,
    // but flag for cleanup. UI can show "stale" badge.
    return {
      type: "Stale",
      reason: currentDaysInRole === null
        ? `at different company (${current.company}); role start date unknown — records may be stale`
        : `at different company (${current.company}) for ${currentDaysInRole}d — outside ${movementWindowDays}-day window`,
      details: { ...baseDetails, destinationAccount },
      recommendedAction: destinationAccount
        ? `Reassign lead to ${destinationAccount} for tracking but no recent-movement task.`
        : `Mark lead as inactive at ${storedAccount}; no recent-movement task.`,
    };
  }

  // Within window + at a different company = either Hired (new company is ours) or Exited
  if (destinationAccount) {
    return {
      type: "Hired",
      reason: `lead newly at ${destinationAccount} (one of our accounts) — ${currentDaysInRole}d ago`,
      details: { ...baseDetails, destinationAccount },
      recommendedAction: `Reassign lead from ${storedAccount} to ${destinationAccount}; create Hired-task on ${destinationAccount}.`,
    };
  }

  return {
    type: "Exited",
    reason: `lead exited ${storedAccount}; now at ${current.company} (not in account list) — ${currentDaysInRole}d ago`,
    details: { ...baseDetails, destinationAccount: null },
    recommendedAction: `Create Exited-task on ${storedAccount}; mark lead as inactive.`,
  };
}

// ─── Build Airtable Task record from classification ────────────────
// Returns the `fields` object for Tasks table insert, or null if no task
// should be created (e.g., for None / Unavailable / Stale).
export function buildTaskFromMovement(classification, lead) {
  const movementType = classification.type;
  if (!["Hired", "Promoted", "Exited"].includes(movementType)) {
    return null; // None / Unavailable / Stale don't produce tasks
  }

  const today = new Date().toISOString().slice(0, 10);
  const d = classification.details || {};

  let signal = "";
  let scoreReason = "";
  let companyForTask = ""; // which account the task is attributed to

  if (movementType === "Hired") {
    // Task gets attributed to the DESTINATION account (where they joined)
    companyForTask = d.destinationAccount || d.currentCompany;
    signal = `${lead.name} joined ${companyForTask} as ${d.currentTitle} (${d.daysInCurrentRole}d ago)`;
    scoreReason = `Hired at ${d.currentCompany}; role started ${d.currentStartedAt}; previously ${d.storedTitle || "—"} at ${d.storedAccount}.`;
  } else if (movementType === "Promoted") {
    companyForTask = d.storedAccount || d.currentCompany;
    signal = `${lead.name} promoted to ${d.currentTitle} at ${companyForTask} (${d.daysInCurrentRole}d ago)`;
    scoreReason = `Promoted within ${companyForTask}; new role started ${d.currentStartedAt}; previous title: ${d.storedTitle || "—"}.`;
  } else if (movementType === "Exited") {
    // Task gets attributed to the SOURCE account (where they left from)
    companyForTask = d.storedAccount || d.storedCompany;
    signal = `${lead.name} left ${companyForTask} → now ${d.currentTitle} at ${d.currentCompany} (${d.daysInCurrentRole}d ago)`;
    scoreReason = `Exited ${companyForTask}; now ${d.currentTitle} at ${d.currentCompany} as of ${d.currentStartedAt}.`;
  }

  // Scoring: Hired and Promoted are high-intent (90); Exited is still
  // useful but lower priority (75).
  const score = movementType === "Exited" ? 75 : 90;

  return {
    "Name": lead.name,
    "Company": companyForTask,
    "Task Rule": "Lead Movement",
    "Movement Type": movementType,
    "Score": score,
    "Score Reason": scoreReason,
    "Scan Target": "leads",
    "Signal": signal,
    "Source": "linkedin_rapidapi",
    // Lead contact details — propagate from the Lead record so chatbot cards
    // can offer "in LinkedIn" / "Call" / etc. CTAs. Missing values are empty
    // strings (Airtable treats them as no-ops).
    "Lead Title": lead.storedTitle || "",
    "LinkedIn URL": lead.linkedinUrl || "",
    "Email": lead.email || "",
    "Phone": lead.phone || "",
    "URL": lead.linkedinUrl || "",
    "Task Type": "lead_movement",
    "Date": today,
    "Created": new Date().toISOString(),
  };
}

// ─── Build Lead-update fields ──────────────────────────────────────
// Applied to Lead record regardless of classification — we always want
// to track the latest known state.
export function buildLeadUpdateFields(classification) {
  const today = new Date().toISOString().slice(0, 10);
  const movementType = classification.type;
  const d = classification.details;

  if (!d) {
    return {
      "Last LinkedIn Check": today,
      "Movement Detected": "Profile Unavailable",
    };
  }

  return {
    "Current Company":       d.currentCompany || "",
    "Current Job Title":     d.currentTitle || "",
    "Current Role Started At": d.currentStartedAt || "",
    "Days In Current Role":  typeof d.daysInCurrentRole === "number" ? d.daysInCurrentRole : null,
    "Previous Company":      d.previousCompany || "",
    "Previous Job Title":    d.previousTitle || "",
    "Last LinkedIn Check":   today,
    "Movement Detected":     movementType,
  };
}
