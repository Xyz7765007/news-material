// ─── Universal Relevance Rules ──────────────────────────────────────
// Operator "feedback on anything" → durable suppression / score-override
// rules stored in the per-campaign `Sidekick Relevance Rules` table.
//
// PHILOSOPHY (mirrors the freshness gate): the READ FILTER is the source
// of truth. Suppression is applied as an extra clause on the feed + count
// Airtable filterByFormula, so it is RETROACTIVE (old tasks vanish too),
// FORWARD (new matching tasks never show), and REVERSIBLE (flip a rule's
// `Active` checkbox off → it stops contributing to the formula).
//
// Kinds:
//   - title_irrelevant   → suppress tasks whose TITLE field CONTAINS Value
//   - company_irrelevant → suppress tasks whose Company CONTAINS Value
//   - signal_irrelevant  → suppress tasks whose Task Type OR Movement Type
//                          CONTAINS Value (e.g. "Exited", "linkedin_engagement")
//   - role_fit           → does NOT suppress; overrides the SERVED score to
//                          Target Score when the title matches Value
//
// Veloka Tasks field mapping (CLAUDE.md §15 + feed formatCard):
//   - title  → {Lead Title}  (primary; feed falls back to {Title} on read)
//   - company → {Company}
//   - signal → {Task Type} and {Movement Type}
//
// INTERNAL ONLY: rule Values/scores must never leak into lead-facing copy.

const AT_API = "https://api.airtable.com/v0";
const RELEVANCE_TABLE = "Sidekick Relevance Rules";

export const RELEVANCE_KINDS = [
  "title_irrelevant",
  "company_irrelevant",
  "signal_irrelevant",
  "role_fit",
];

// Airtable formula string-literal escaping: the only character that can break
// out of a "double-quoted" literal is a double-quote. Escape it Airtable-style
// by doubling? Airtable does NOT support "" escaping inside filterByFormula —
// the safe move is to strip double-quotes entirely (rule Values are titles /
// company names / type strings; a literal " is never meaningful here).
function sanitizeValue(v) {
  return String(v == null ? "" : v).replace(/"/g, "").trim();
}

// Build the extra suppression clause for the feed/count filterByFormula from a
// set of active rules. Returns "" when there is nothing to suppress (caller
// then uses the base filter unchanged → byte-identical to legacy behaviour).
//
// The returned clause is an AND() of per-rule NOT(...) exclusions, so a task
// passes ONLY if it matches NONE of the suppression rules. role_fit rules do
// NOT contribute here (they override score on read, they don't suppress).
//
// Matching is case-insensitive via LOWER() on both sides.
export function buildSuppressionClause(rules) {
  const clauses = [];
  for (const r of rules || []) {
    const kind = r.kind;
    const value = sanitizeValue(r.value);
    if (!value) continue;
    const needle = value.toLowerCase();
    if (kind === "title_irrelevant") {
      // Match the campaign's title field. The Tasks schema's canonical title
      // column is {Lead Title} (setup-fix guarantees it; CLAUDE.md §15). We do
      // NOT reference {Title} here: an absent field name 422s the whole
      // filterByFormula, and {Lead Title} is the Tasks field that's always
      // present, so matching on it alone is both correct and safe.
      clauses.push(`NOT(FIND("${needle}", LOWER({Lead Title} & "")))`);
    } else if (kind === "company_irrelevant") {
      clauses.push(`NOT(FIND("${needle}", LOWER({Company} & "")))`);
    } else if (kind === "signal_irrelevant") {
      clauses.push(`NOT(OR(FIND("${needle}", LOWER({Task Type} & "")), FIND("${needle}", LOWER({Movement Type} & ""))))`);
    }
    // role_fit: intentionally skipped — handled on read by applyRoleFitOverride.
  }
  if (clauses.length === 0) return "";
  return clauses.length === 1 ? clauses[0] : `AND(${clauses.join(", ")})`;
}

// Wrap a base filter with the suppression clause. If there are no suppression
// rules the base filter is returned UNCHANGED (so feed/count stay byte-identical
// to the legacy path when no rules exist or the table is missing).
export function withSuppression(baseFilter, rules) {
  const clause = buildSuppressionClause(rules);
  if (!clause) return baseFilter;
  return `AND(${baseFilter}, ${clause})`;
}

// role_fit override (read-side only). Given a card with `lead_title` + `score`,
// if any active role_fit rule's Value is contained in the title (case-insensitive),
// override the SERVED score to that rule's Target Score. Stored Airtable Score is
// untouched. If multiple role_fit rules match, the LOWEST target wins (most
// conservative — operator is downgrading fit). Returns the (possibly) new score.
export function roleFitScoreFor(title, currentScore, rules) {
  const t = String(title || "").toLowerCase();
  if (!t) return currentScore;
  let override = null;
  for (const r of rules || []) {
    if (r.kind !== "role_fit") continue;
    const v = sanitizeValue(r.value).toLowerCase();
    if (!v) continue;
    if (typeof r.targetScore !== "number") continue;
    if (t.includes(v)) {
      override = override == null ? r.targetScore : Math.min(override, r.targetScore);
    }
  }
  return override == null ? currentScore : override;
}

// Map an Airtable Relevance Rule record → plain rule object.
function mapRule(rec) {
  const f = rec.fields || {};
  const ts = f["Target Score"];
  return {
    id: rec.id,
    kind: f.Kind || "",
    value: f.Value || "",
    targetScore: typeof ts === "number" ? ts : (ts != null && ts !== "" ? Number(ts) : null),
    note: f.Note || "",
    active: f.Active === true,
    created: f.Created || null,
    createdBy: f["Created By"] || null,
  };
}

// In-process fetch of ACTIVE relevance rules for a base, most-recent-first.
// NEVER throws — returns [] on ANY failure (missing table, missing fields,
// transient error). This is the guarantee the feed/count rely on: if rules
// can't be loaded, the feed behaves EXACTLY as legacy (no suppression).
export async function fetchActiveRelevanceRules(baseId, limit = 200) {
  const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
  if (!AIRTABLE_KEY || !baseId) return [];
  const cap = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500);
  const params = new URLSearchParams({
    filterByFormula: `{Active} = TRUE()`,
    "sort[0][field]": "Created",
    "sort[0][direction]": "desc",
    pageSize: String(Math.min(cap, 100)),
  });
  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(RELEVANCE_TABLE)}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) return [];
    const data = await r.json();
    return (data.records || []).map(mapRule).filter(x => x.kind && (x.value || x.kind === "role_fit"));
  } catch {
    return [];
  }
}

export { RELEVANCE_TABLE };
