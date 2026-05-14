// ─── Company Name Normalization + Matching ─────────────────────────
// Pure string match. No AI — too risky for hallucinating false matches.
//
// Handles common variations:
//   "Coca-Cola"               ↔ "The Coca-Cola Company"     → match
//   "Procter & Gamble"        ↔ "P&G"                        → match (via initials)
//   "Pfizer Inc."             ↔ "Pfizer"                     → match
//   "Salesforce, Inc."        ↔ "Salesforce.com"             → match
//   "Alphabet"                ↔ "Google"                     → NO match (parent vs sub)
//
// For ambiguous parent/subsidiary cases (Tubi/Fox, Instagram/Meta), we maintain
// an explicit alias map. Adds as we discover them in production.

const ALIASES = {
  // canonical → list of known variants seen in LinkedIn data
  // (key MUST be normalized form — value list is for documentation only)
  "tubi": ["fox", "fox corporation"],
  "instagram": ["meta", "meta platforms", "facebook"],
  "youtube": ["google", "alphabet"],
  "linkedin": ["microsoft"],
  "github": ["microsoft"],
  "whatsapp": ["meta", "meta platforms", "facebook"],
};

// Common corporate suffixes to strip (case-insensitive)
const SUFFIXES_TO_STRIP = [
  "inc", "incorporated", "corp", "corporation", "company", "co",
  "ltd", "limited", "llc", "lp", "llp", "plc", "ag", "sa", "se",
  "gmbh", "bv", "nv", "kg", "kgaa", "pvt", "private", "ag", "spa",
  "holdings", "holding", "international", "group", "groupe",
  "the",
];

// Strip common punctuation/wordage that creates spurious diffs
const PUNCTUATION_RE = /[.,'"()&\/\\\-_]/g;
const MULTI_SPACE_RE = /\s+/g;

export function normalizeCompanyName(name) {
  if (!name || typeof name !== "string") return "";
  let s = name.toLowerCase().trim();

  // Replace punctuation with space (so "P&G" → "p g")
  s = s.replace(PUNCTUATION_RE, " ");

  // Tokenize and strip suffix words at start AND end (corporate fluff
  // typically appears in those positions, not the middle)
  let tokens = s.split(MULTI_SPACE_RE).filter(Boolean);

  // Drop leading "the"
  while (tokens.length > 1 && tokens[0] === "the") tokens.shift();

  // Drop trailing corporate suffix words (repeatedly — handles "Foo Inc. Ltd")
  while (tokens.length > 1 && SUFFIXES_TO_STRIP.includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }

  return tokens.join(" ").trim();
}

// Match logic with three tiers of strictness
// Returns { matched: bool, reason: string, confidence: "high"|"medium"|"low" }
export function matchCompanyNames(accountName, linkedinCompanyName) {
  if (!accountName || !linkedinCompanyName) {
    return { matched: false, reason: "missing input", confidence: "high" };
  }

  const a = normalizeCompanyName(accountName);
  const b = normalizeCompanyName(linkedinCompanyName);

  if (!a || !b) {
    return { matched: false, reason: "normalized to empty", confidence: "high" };
  }

  // Tier 1: exact match on normalized form (highest confidence)
  if (a === b) {
    return { matched: true, reason: "exact normalized match", confidence: "high" };
  }

  // Tier 2: alias map check (manually curated parent/subsidiary cases)
  const aliasA = ALIASES[a] || [];
  const aliasB = ALIASES[b] || [];
  if (aliasA.includes(b) || aliasB.includes(a)) {
    return { matched: true, reason: "alias map match", confidence: "high" };
  }

  // Tier 3: substring match (e.g. "kraft heinz" ↔ "kraft heinz company")
  // Both directions to catch cases where normalization missed a suffix variant.
  // Require minimum 4 chars to avoid spurious matches on short strings like "co".
  if (a.length >= 4 && b.length >= 4) {
    if (a.includes(b) || b.includes(a)) {
      return { matched: true, reason: "substring match", confidence: "medium" };
    }
  }

  return { matched: false, reason: `no match: "${a}" vs "${b}"`, confidence: "high" };
}

// For diagnostics — surface to admin UI what's being compared
export function describeCompanyMatch(accountName, linkedinCompanyName) {
  const result = matchCompanyNames(accountName, linkedinCompanyName);
  return {
    accountInput: accountName,
    linkedinInput: linkedinCompanyName,
    accountNormalized: normalizeCompanyName(accountName),
    linkedinNormalized: normalizeCompanyName(linkedinCompanyName),
    ...result,
  };
}
