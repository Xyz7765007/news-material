// ═══════════════════════════════════════════════════════════════════
// LEAD INTELLIGENCE BRIEF
// Parses raw task Signal text into structured intel that AI can cite.
// Used by auto-batch/generate to enforce deep personalization.
//
// Task Signal fields contain rich data dumped as prose with emojis:
//   "→ 🔗 https://linkedin.com/feed/update/urn:li:activity:1234
//    📝 Devi Biswas posted about healthy snacks growth, brand shifts...
//    💬 Suggested comment: Highlight the 4x rise in healthy chips...
//    🔍 Evidence from post: "Healthy Snacks grew 112% on Qcom..."
//    💡 Why this matters: Uses concrete category data...
//    📊 Final score: 82/100 • Post type: thought_leadership (2d ago)"
//
// This lib extracts each section so AI can be told exactly what to cite.
// ═══════════════════════════════════════════════════════════════════

import { pickLeadField } from "./lead-fields.js";

const DAY_MS = 86400000;

function ageDays(record) {
  const f = record?.fields || {};
  const ts = f.Created || f.Date || f["Created At"];
  if (!ts) return Infinity;
  const t = new Date(ts).getTime();
  if (isNaN(t)) return Infinity;
  return Math.max(0, (Date.now() - t) / DAY_MS);
}

function ageLabel(days) {
  if (days < 0.5) return "today";
  if (days < 1.5) return "yesterday";
  if (days < 30) return `${Math.floor(days)}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// Parse a Signal string into structured fields by detecting emoji markers
// each section was originally rendered with.
function parseSignalText(signalText) {
  if (!signalText || typeof signalText !== "string") return null;

  const out = {
    raw: signalText,
    postUrl: null,
    postSummary: null,
    directQuote: null,
    suggestedAngle: null,
    aiRationale: null,
    finalScore: null,
    postType: null,
  };

  // LinkedIn post URL — appears after 🔗 or as a raw URL
  const urlMatch = signalText.match(/https:\/\/(www\.)?linkedin\.com\/[^\s)\]]+/);
  if (urlMatch) out.postUrl = urlMatch[0];

  // Post summary — 📝 marker
  const summaryMatch = signalText.match(/📝\s*(.+?)(?=💬|🔍|💡|📊|$)/s);
  if (summaryMatch) out.postSummary = summaryMatch[1].trim();

  // Suggested comment — 💬 marker
  const commentMatch = signalText.match(/💬\s*Suggested comment:\s*(.+?)(?=🔍|💡|📊|$)/s);
  if (commentMatch) out.suggestedAngle = commentMatch[1].trim();

  // Direct evidence/quote — 🔍 marker
  const evidenceMatch = signalText.match(/🔍\s*Evidence from post:\s*(.+?)(?=💡|📊|$)/s);
  if (evidenceMatch) {
    // The evidence is usually wrapped in quotes — keep them stripped for clean citation
    out.directQuote = evidenceMatch[1].trim().replace(/^"|"$/g, "");
  }

  // Why this matters — 💡 marker
  const whyMatch = signalText.match(/💡\s*Why this matters:\s*(.+?)(?=📊|$)/s);
  if (whyMatch) out.aiRationale = whyMatch[1].trim();

  // Final score — 📊 marker
  const scoreMatch = signalText.match(/Final score:\s*(\d+)/);
  if (scoreMatch) out.finalScore = parseInt(scoreMatch[1], 10);

  const postTypeMatch = signalText.match(/Post type:\s*([a-z_]+)/);
  if (postTypeMatch) out.postType = postTypeMatch[1];

  return out;
}

// Build a structured intel brief from a lead + their relevant tasks.
// Returns an object with named sections the AI prompt can reference.
export function buildLeadBrief(lead, relevantTasks = []) {
  const f = lead?.fields || {};
  const fullName = f.Name || f["Full Name"] || "Unknown";
  const firstName = fullName.split(/\s+/)[0] || "there";

  const brief = {
    identity: {
      firstName,
      fullName,
      title: f.Title || pickLeadField(f, "title") || "",
      company: f.Company || "",
      linkedinUrl: f["LinkedIn URL"] || f.linkedin_url || "",
    },
    signals: [],
    movements: [],
    gaActivity: [],
    icpFit: [],        // top_x tasks — ICP qualification reasons
    postsEngaged: [],
  };

  // ─── Process each relevant task ──────────────────────────────
  for (const t of relevantTasks) {
    const tf = t.fields || {};
    const type = tf["Task Type"] || "";
    const age = ageDays(t);
    const aLabel = ageLabel(age);

    if (type === "lead_movement") {
      brief.movements.push({
        kind: tf["Movement Type"] || "Movement",
        when: aLabel,
        whenDays: Math.floor(age),
        detail: tf.Signal || "",
      });
    } else if (type === "engagement") {
      const parsed = parseSignalText(tf.Signal);
      brief.gaActivity.push({
        when: aLabel,
        whenDays: Math.floor(age),
        score: tf.Score || 0,
        rawSignal: tf.Signal || "",
        parsed,
      });
    } else if (type === "linkedin_engagement") {
      const parsed = parseSignalText(tf.Signal);
      brief.signals.push({
        type: "linkedin_post",
        when: aLabel,
        whenDays: Math.floor(age),
        score: tf.Score || 0,
        postUrl: parsed?.postUrl,
        postSummary: parsed?.postSummary,
        directQuote: parsed?.directQuote,
        suggestedAngle: parsed?.suggestedAngle,
        aiRationale: parsed?.aiRationale,
        postType: parsed?.postType,
        rawSignal: tf.Signal || "",
      });
    } else if (type === "top_x") {
      // Top X ICP match — durable qualification, not event-based.
      // The Score Reason field contains why this lead matches the ICP
      // (e.g. "Series A SaaS, 50-200 employees, hiring outbound").
      brief.icpFit.push({
        when: aLabel,
        whenDays: Math.floor(age),
        icpScore: tf.Score || 0,
        scoreReason: tf["Score Reason"] || tf.Signal || "",
        taskRule: tf["Task Rule"] || "",
        signal: tf.Signal || "",
      });
    }
  }

  return brief;
}

// ─── Convert brief to AI-prompt block ───────────────────────────
// Builds the "RECENT LEAD ACTIVITY" section of the prompt. Each fact
// is bulleted with explicit markers so AI knows what's citable.
export function briefToPromptBlock(brief) {
  const lines = [];

  // Movement signals — highest priority, lead with these
  for (const m of brief.movements) {
    lines.push(`- MOVEMENT (${m.when}): ${brief.identity.firstName} was ${m.kind.toLowerCase()} ${m.when}`);
    if (m.detail) lines.push(`  Detail: ${m.detail.slice(0, 300)}`);
  }

  // LinkedIn post signals — the richest source
  for (const s of brief.signals) {
    lines.push(`- LINKEDIN POST (${s.when}, AI quality score ${s.score}/100, type: ${s.postType || "general"}):`);
    if (s.postSummary) lines.push(`  TOPIC: ${s.postSummary}`);
    if (s.directQuote) lines.push(`  DIRECT QUOTE FROM ${brief.identity.firstName}: "${s.directQuote}"`);
    if (s.suggestedAngle) lines.push(`  ANGLE TO TAKE: ${s.suggestedAngle}`);
    if (s.aiRationale) lines.push(`  WHY THIS POST MATTERS: ${s.aiRationale}`);
    if (s.postUrl) lines.push(`  URL: ${s.postUrl}`);
  }

  // ICP fit — Top X qualification reasons. Durable, not event-based, so
  // personalization here references company traits, not "today's event".
  for (const icp of brief.icpFit) {
    lines.push(`- ICP FIT (qualification score ${icp.icpScore}/100, scanned ${icp.when}):`);
    if (icp.scoreReason) lines.push(`  WHY THEY MATCH: ${icp.scoreReason.slice(0, 500)}`);
    if (icp.taskRule) lines.push(`  PER RULE: ${icp.taskRule}`);
  }

  // GA web engagement — what they're researching
  for (const ga of brief.gaActivity) {
    lines.push(`- WEBSITE VISIT (${ga.when}, score ${ga.score}):`);
    if (ga.rawSignal) lines.push(`  ${ga.rawSignal.slice(0, 400)}`);
  }

  if (!lines.length) {
    return "(No recent specific activity. Use the lead's company name + title for general industry context only — DO NOT invent facts.)";
  }

  return lines.join("\n");
}

// ─── Extract clean UI bullets from a brief ──────────────────────
// For the chatbot card — instead of dumping raw Signal text, show
// 2-3 punchy bullets that summarize the lead's recent activity.
export function briefToUiBullets(brief) {
  const bullets = [];

  for (const m of brief.movements) {
    bullets.push(`${m.kind} ${m.when}`);
  }

  for (const s of brief.signals) {
    if (s.directQuote) {
      const quote = s.directQuote.length > 100 ? s.directQuote.slice(0, 100) + "…" : s.directQuote;
      bullets.push(`Posted ${s.when}: "${quote}"`);
    } else if (s.postSummary) {
      const summary = s.postSummary.length > 120 ? s.postSummary.slice(0, 120) + "…" : s.postSummary;
      bullets.push(`Posted ${s.when}: ${summary}`);
    }
  }

  for (const icp of brief.icpFit) {
    const reason = icp.scoreReason
      ? String(icp.scoreReason).split(/[.\n]/)[0].slice(0, 110).trim()
      : "matches ICP";
    bullets.push(`ICP fit (${icp.icpScore}/100): ${reason}`);
  }

  for (const ga of brief.gaActivity) {
    bullets.push(`Visited site ${ga.when} (score ${ga.score})`);
  }

  return bullets.slice(0, 3);
}
