// ═══════════════════════════════════════════════════════════════════
// MESSAGE MERGE + SANITIZE
// Centralized helpers for LinkedIn outreach message safety.
//
// Used by:
//   - /api/outreach (cron-side personalization + send)
//   - /api/sidekick/auto-batch/generate (pre-generates approved drafts)
//   - /api/sidekick/auto-batch/action (validates user edits before save)
//
// Guarantees nothing reaches LinkedIn that has:
//   - Unresolved {placeholder} merge fields
//   - Bracket [PLACEHOLDER] left over from templates
//   - Markdown formatting (asterisks, backticks, leading quotes)
//   - AI refusal strings ("I'm sorry, I can't...")
//   - Excessive length (connection 300 cap, DM ~8000 cap)
// ═══════════════════════════════════════════════════════════════════

// LinkedIn hard limits — these are LinkedIn's enforced ceilings.
// We use slightly under to leave headroom for any trailing whitespace/punctuation.
export const CONNECTION_NOTE_HARD_LIMIT = 300;
export const CONNECTION_NOTE_SAFE_LIMIT = 280;  // target length
export const DM_HARD_LIMIT = 8000;
export const DM_SAFE_LIMIT = 7900;              // target length

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// ─── Name derivation ─────────────────────────────────────────────
// Extracts first/last/full from any naming variant we see in the wild.
// Outreach records use "Lead Name". Leads table uses "Name" or "Full Name".
// Snake_case + camelCase variants for safety.
export function deriveNames(fields = {}) {
  const f = fields.fields || fields;
  const fullName = safeStr(
    f.Name || f["Full Name"] || f["Lead Name"] ||
    f.full_name || f.fullName || f.lead_name || ""
  );
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    first: safeStr(f["First Name"] || f.first_name || f.firstName || parts[0] || ""),
    last: safeStr(f["Last Name"] || f.last_name || f.lastName || parts.slice(1).join(" ") || ""),
    full: fullName,
  };
}

// ─── Smart truncation ────────────────────────────────────────────
// Cuts at the nearest word boundary BEFORE maxLen, never mid-word.
// Doesn't append "..." (which costs 3 chars + looks AI-y on LinkedIn).
// If truncation removes more than 25% of content, this is a sign the
// message is way too long — caller should regenerate, not truncate.
export function smartTruncate(text, maxLen) {
  const t = safeStr(text);
  if (t.length <= maxLen) return t;

  // Cut at the last space before maxLen so we don't break a word
  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.7) {
    // Word-boundary found in the last 30% — clean cut
    return cut.slice(0, lastSpace).replace(/[,.;:—–-]\s*$/, "").trim();
  }
  // Last resort: hard cut at maxLen
  return cut.trim();
}

// ─── Merge field substitution ────────────────────────────────────
// Replaces {first_name}, {company}, etc. with actual lead data.
// Handles case/format variations: {first_name}, {firstName}, {FirstName}, {FIRST_NAME}.
// SAFETY NET: any unresolved {placeholder} gets replaced with "there"
// rather than leaked to LinkedIn as literal text.
export function fillMergeFields(template, lead, signal = "", companyName = "") {
  const f = lead?.fields || lead || {};
  const names = deriveNames(f);
  const title = safeStr(f.Title || f.title);
  const company = safeStr(f.Company || f.company || companyName);
  const linkedin = safeStr(f["LinkedIn URL"] || f.linkedin_url);
  const sig = safeStr(signal);

  const firstOrFallback = names.first || "there";
  const nameOrFallback = names.full || firstOrFallback;

  const REPLACERS = [
    [/\{\s*first[_\s]?name\s*\}/gi, firstOrFallback],
    [/\{\s*last[_\s]?name\s*\}/gi, names.last],
    [/\{\s*full[_\s]?name\s*\}/gi, nameOrFallback],
    [/\{\s*name\s*\}/gi, nameOrFallback],
    [/\{\s*title\s*\}/gi, title],
    [/\{\s*role\s*\}/gi, title],
    [/\{\s*company\s*\}/gi, company],
    [/\{\s*signal\s*\}/gi, sig],
    [/\{\s*linkedin(_url)?\s*\}/gi, linkedin],
  ];

  let out = String(template || "");
  for (const [re, val] of REPLACERS) out = out.replace(re, val);

  // Clean up artifacts from empty replacements
  out = out
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\(\s*\)/g, "")
    .replace(/\[\s*\]/g, "")
    .replace(/ {2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // SAFETY NET: any remaining {placeholder} → "there"
  const remaining = out.match(/\{[a-zA-Z_][a-zA-Z0-9_\s]*\}/g);
  if (remaining) {
    console.warn(`[MERGE] Unresolved placeholders after replacement: ${remaining.join(", ")} — replacing with "there". Template was: ${String(template).slice(0, 200)}`);
    out = out.replace(/\{[a-zA-Z_][a-zA-Z0-9_\s]*\}/g, "there");
  }

  return out;
}

// ─── Strip markdown / quotes / code fences from AI output ─────────
// AI sometimes wraps messages in **bold**, leading quotes, or ```code```
// blocks despite instructions otherwise. This strips all that.
function stripFormatting(text) {
  let t = safeStr(text);

  // Strip code-block fences ```...```
  t = t.replace(/^```[\w]*\s*\n?/m, "").replace(/\n?```\s*$/m, "").trim();

  // Strip leading/trailing quotes (regular, smart, backtick)
  t = t.replace(/^["'`""'']+|["'`""'']+$/g, "").trim();

  // Strip markdown emphasis
  t = t
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<![*])\*([^*\n]+)\*(?![*])/g, "$1")
    .replace(/(?<![_])_([^_\n]+)_(?![_])/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1");

  return t;
}

// ─── Detect AI refusals ──────────────────────────────────────────
// Returns true if text appears to be an LLM refusal/apology rather than
// an actual message. These should never go to a lead.
function isRefusal(text) {
  const patterns = [
    /^(I'?m sorry|I apologize|I can'?t|I cannot|I'?m unable|Sorry,?|Unfortunately,?)\b/i,
    /^As an AI/i,
    /\bI don'?t have (the |enough )?(context|information|details)\b/i,
    /\bI need more information\b/i,
    /\b(unable|not able) to (help|provide|generate|create)\b/i,
  ];
  return patterns.some(p => p.test(text));
}

// ─── The main entry point ─────────────────────────────────────────
// Takes raw AI output + lead context → returns safe-to-send text.
//
// kind: "connection_note" | "dm"
//   - connection_note: hard limit 300, target 280
//   - dm: hard limit 8000, target 7900
//
// On success: { ok: true, text }
// On failure: { ok: false, reason, fallback? }
//   - "empty"           — AI returned nothing
//   - "refusal"         — AI said "sorry I can't"
//   - "too_short"       — < 10 chars after sanitization
//   - "bracket_left"    — [PLACEHOLDER] survived (template bug)
//   - "merge_failed"    — {placeholder} couldn't be resolved
//
// If lead is provided, fillMergeFields runs as a safety pass even on
// AI output — catches the case where AI ignored personalization
// instructions and left {first_name} in the text.
export function sanitizeAndValidate(rawText, { lead, signal = "", company = "", kind = "dm" } = {}) {
  if (!rawText || typeof rawText !== "string") {
    return { ok: false, reason: "empty" };
  }

  // Step 1: strip formatting + quotes + markdown
  let t = stripFormatting(rawText);
  if (!t) return { ok: false, reason: "empty" };

  // Step 2: refusal check
  if (isRefusal(t)) {
    return { ok: false, reason: "refusal", refusalSnippet: t.slice(0, 100) };
  }

  // Step 3: if AI left {merge_fields} in the output, resolve them
  // using the lead's actual data. This is the merge-field safety net.
  if (lead && /\{[a-zA-Z_][a-zA-Z0-9_\s]*\}/.test(t)) {
    t = fillMergeFields(t, lead, signal, company);
  }

  // Step 4: check for bracket placeholders [NAME], [YOUR COMPANY], etc.
  // These usually mean a template wasn't filled properly.
  if (/\[[A-Z_ ]{3,}\]/.test(t)) {
    return { ok: false, reason: "bracket_left" };
  }

  // Step 5: residual merge-field check (after fillMergeFields safety net)
  // fillMergeFields already replaces unresolved with "there", but if no
  // lead was provided, raw {placeholder} could remain — caller's fault.
  if (/\{[a-zA-Z_][a-zA-Z0-9_\s]*\}/.test(t)) {
    return { ok: false, reason: "merge_failed", placeholder: t.match(/\{[^}]+\}/)?.[0] };
  }

  // Step 6: length enforcement
  const hardLimit = kind === "connection_note" ? CONNECTION_NOTE_HARD_LIMIT : DM_HARD_LIMIT;
  const safeLimit = kind === "connection_note" ? CONNECTION_NOTE_SAFE_LIMIT : DM_SAFE_LIMIT;

  if (t.length > hardLimit) {
    // Hard truncate at word boundary
    t = smartTruncate(t, safeLimit);
  }

  // Step 7: minimum length sanity
  if (t.length < 10) {
    return { ok: false, reason: "too_short", text: t };
  }

  return { ok: true, text: t, length: t.length };
}

// ─── Deterministic fallback for AI failures ──────────────────────
// When AI fails (refusal, parse error, network), produce a generic
// but safe message using only the lead's basic data. Never returns null.
export function deterministicFallback(lead, kind = "connection_note") {
  const f = lead?.fields || lead || {};
  const names = deriveNames(f);
  const firstName = names.first || "there";
  const company = safeStr(f.Company || f.company) || "your team";

  if (kind === "connection_note") {
    const msg = `Hi ${firstName} — noticed your work at ${company}. Would like to connect.`;
    return smartTruncate(msg, CONNECTION_NOTE_SAFE_LIMIT);
  }

  if (kind === "dm_1") {
    return `Thanks for connecting ${firstName}. Curious how you're thinking about outbound at ${company} this year?`;
  }

  if (kind === "dm_2") {
    return `Following up ${firstName} — happy to share a quick teardown of how similar teams at ${company}'s scale are running outbound. Would that be useful?`;
  }

  if (kind === "dm_3") {
    return `Last one ${firstName} — no pressure. If outbound is on the roadmap this year, I'd be glad to share what's working. Either way, all the best.`;
  }

  return `Hey ${firstName} — quick note about ${company}.`;
}
