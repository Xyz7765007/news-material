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
      // The Score Reason field contains the internal qualification data
      // (e.g. "Score: 67/100 (deterministic: 67) Lead-side rules matched:
      // ✓ ACV Score 7-10 (high revenue potential)"). We extract just the
      // human-readable part for both UI display and AI context — the AI
      // must NOT cite the internal scoring numbers.
      const rawReason = tf["Score Reason"] || tf.Signal || "";
      brief.icpFit.push({
        when: aLabel,
        whenDays: Math.floor(age),
        icpScore: tf.Score || 0,           // kept for sorting, never shown to prospect
        scoreReason: rawReason,             // raw — internal only
        humanReason: humanizeIcpReason(rawReason),  // sanitized, AI-safe to read
        taskRule: tf["Task Rule"] || "",
        signal: tf.Signal || "",
      });
    }
  }

  return brief;
}

// ─── humanizeIcpReason ────────────────────────────────────────────
// Strips internal scoring artifacts ("Score: X/100", "deterministic: X",
// "Lead-side rules matched") from a Top X scoreReason, leaving only the
// human-meaningful business signals (ACV tier, team sizes, hiring signal,
// etc.). Output is what AI sees and what the chatbot UI displays.
//
// Example:
//   IN:  "Score: 67/100 (deterministic: 67) Lead-side rules matched:
//         ✓ ACV Score 7-10 (high revenue potential)"
//   OUT: "ACV Score 7-10 (high revenue potential)"
function humanizeIcpReason(raw) {
  if (!raw) return "";
  let t = String(raw);

  // Strip "Score: X/100" patterns
  t = t.replace(/Score:\s*\d+\/100/gi, "");
  t = t.replace(/\(deterministic:\s*\d+\)/gi, "");
  t = t.replace(/\bdeterministic:\s*\d+\b/gi, "");
  t = t.replace(/Lead-side rules matched:?/gi, "");
  t = t.replace(/Account-side rules matched:?/gi, "");
  t = t.replace(/Final score:\s*\d+\/100/gi, "");
  t = t.replace(/AI raw score:\s*\d+/gi, "");

  // Strip leading checkmarks, arrows, bullets
  t = t.replace(/^[\s✓✔➔→•-]+/g, "");
  t = t.replace(/\s+✓\s+/g, " ").replace(/\s+✔\s+/g, " ");
  // Collapse whitespace + punctuation
  t = t.replace(/\s{2,}/g, " ").replace(/\s*\|\s*/g, " · ").replace(/\s*,\s*/g, ", ").trim();
  t = t.replace(/^[:\s]+|[:\s]+$/g, "").trim();

  // Take the first 200 chars worth of human content
  return t.slice(0, 200);
}

// ─── Convert brief to AI-prompt block ───────────────────────────
// Output has TWO zones to prevent the AI from leaking internal scoring
// data into the message body:
//
//   PUBLIC FACTS  — citable, things the lead has actually said/done in
//                   public (LinkedIn posts, web visits, movements/news)
//
//   INTERNAL CONTEXT — for AI understanding only. NEVER citable. ICP
//                      qualification reasoning sits here so AI knows WHY
//                      this lead is on the list, but won't quote
//                      "67/100 ICP fit" back at the prospect.
export function briefToPromptBlock(brief) {
  const publicLines = [];
  const internalLines = [];

  // PUBLIC — Movement signals (e.g. "just promoted to CMO")
  for (const m of brief.movements) {
    publicLines.push(`- MOVEMENT (${m.when}): ${brief.identity.firstName} was ${m.kind.toLowerCase()} ${m.when}`);
    if (m.detail) publicLines.push(`  Detail: ${m.detail.slice(0, 300)}`);
  }

  // PUBLIC — LinkedIn posts (richest source — direct quotes available)
  for (const s of brief.signals) {
    publicLines.push(`- LINKEDIN POST (${s.when}, type: ${s.postType || "general"}):`);
    if (s.postSummary) publicLines.push(`  TOPIC: ${s.postSummary}`);
    if (s.directQuote) publicLines.push(`  DIRECT QUOTE FROM ${brief.identity.firstName}: "${s.directQuote}"`);
    if (s.suggestedAngle) publicLines.push(`  ANGLE TO TAKE: ${s.suggestedAngle}`);
    if (s.aiRationale) publicLines.push(`  WHY THIS POST MATTERS: ${s.aiRationale}`);
    if (s.postUrl) publicLines.push(`  URL: ${s.postUrl}`);
  }

  // PUBLIC — GA web engagement (pages visited, time on site)
  for (const ga of brief.gaActivity) {
    publicLines.push(`- WEBSITE VISIT (${ga.when}):`);
    if (ga.rawSignal) publicLines.push(`  ${ga.rawSignal.slice(0, 400)}`);
  }

  // INTERNAL — ICP qualification reasoning. Strip score numbers; only
  // surface the human-meaningful business traits.
  for (const icp of brief.icpFit) {
    const human = icp.humanReason || icp.scoreReason || "matches our ICP rules";
    internalLines.push(`- BUSINESS PROFILE (${icp.when}): ${human}`);
  }

  const blocks = [];
  if (publicLines.length) {
    blocks.push(
      `PUBLIC FACTS (cite these — the lead actually said/did these in public):\n` +
      publicLines.join("\n")
    );
  } else {
    blocks.push(
      `PUBLIC FACTS: (none — no recent posts, web visits, or movements in our data)\n` +
      `In this case, do NOT pretend to reference a specific recent activity. Instead, lean on\n` +
      `general knowledge of the lead's company + role to write a credible warm intro.`
    );
  }
  if (internalLines.length) {
    blocks.push(
      `INTERNAL CONTEXT (DO NOT CITE — this is for your understanding only):\n` +
      internalLines.join("\n") +
      `\n\nThese are internal qualification notes. NEVER write things like "your 65/100 fit" or\n` +
      `"the rules matched" or "ICP score" to the lead. Translate any signal into natural language\n` +
      `if relevant (e.g. "high-revenue tier" → just write about why outbound matters for their\n` +
      `kind of company), or omit entirely. Internal scoring NEVER appears in the output.`
    );
  }

  return blocks.join("\n\n");
}

// ─── Extract clean UI bullets from a brief ──────────────────────
// For the chatbot card — instead of dumping raw Signal text, show
// 2-3 punchy bullets that summarize the lead's recent activity.
// Internal-only data (ICP scores) is shown to operator in human form
// since the operator IS internal — but stripped of "Score: X/100" noise.
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
    // Show humanized reason to the operator, not the raw "Score: 67/100" dump
    const human = icp.humanReason || "matches ICP rules";
    bullets.push(`Business profile: ${human}`);
  }

  for (const ga of brief.gaActivity) {
    bullets.push(`Visited site ${ga.when}`);
  }

  return bullets.slice(0, 3);
}
