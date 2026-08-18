// ═══════════════════════════════════════════════════════════════════
// RELEVANCE RULES — the suppression clause that goes into the LIVE read
// filter for /api/sidekick/feed AND /api/sidekick/count.
//
// Run: node scripts/test-relevance-rules.mjs
//
// WHY THIS FILE IS THE FIRST TEST IN THE REPO. Every other input to those two
// routes is code we control. This one is OPERATOR FREE TEXT — a job title or a
// company name typed into an Airtable cell — interpolated straight into an
// Airtable filterByFormula string literal. If a value can break out of that
// literal, Airtable does not reject the rule, it 422s the whole request, and
// neither route recognises a parse error (both 422 handlers look for
// UNKNOWN_FIELD_NAME specifically). One bad character in one cell = that
// base's entire card feed returns an error, reported as a missing field.
//
// So the assertions below are mostly about what CANNOT end up in the string.
// ═══════════════════════════════════════════════════════════════════

import {
  buildSuppressionClause,
  withSuppression,
  roleFitScoreFor,
  RELEVANCE_KINDS,
} from "../lib/relevance-rules.js";

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}, got ${a}`);
  console.log(`${a === e ? "  ok  " : "  FAIL"} ${name}`);
}

const BASE = `AND({Handled At} = BLANK())`;

// ─── the pass-through guarantee ──────────────────────────────────
// The routes' comments promise that a base with no rules produces a filter
// BYTE-IDENTICAL to the pre-suppression one. That is what makes this feature
// safe to have shipped to every tenant at once, so it is asserted, not assumed.

check("no rules → clause is empty", buildSuppressionClause([]), "");
check("null rules → clause is empty", buildSuppressionClause(null), "");
check("undefined rules → clause is empty", buildSuppressionClause(undefined), "");
check("no rules → base filter returned unchanged", withSuppression(BASE, []), BASE);
check("null rules → base filter returned unchanged", withSuppression(BASE, null), BASE);
check(
  "rules that are all role_fit → base filter unchanged (role_fit never suppresses)",
  withSuppression(BASE, [{ kind: "role_fit", value: "intern", targetScore: 10 }]),
  BASE
);
check(
  "a rule with an empty value contributes nothing",
  buildSuppressionClause([{ kind: "title_irrelevant", value: "" }]),
  ""
);
check(
  "a rule with a whitespace-only value contributes nothing",
  buildSuppressionClause([{ kind: "company_irrelevant", value: "   " }]),
  ""
);

// ─── formula-literal safety: nothing may escape the quotes ───────
// A double-quote ends the literal. A BACKSLASH is the escape character, so a
// value ending in one escapes the closing quote and swallows the rest of the
// formula — `FIND("acme\", LOWER({Company} & ""))` is a parse error, not a
// filter. Both are stripped. These two assertions are the whole reason the
// sanitizer exists; if either regresses, a single Airtable cell can take a
// tenant's feed down.

const quoted = buildSuppressionClause([{ kind: "company_irrelevant", value: 'ac"me' }]);
check("a double quote is stripped from the value", quoted.includes('ac"me'), false);
check("the sanitized value is still matched on", quoted.includes("acme"), true);

const backslashed = buildSuppressionClause([{ kind: "company_irrelevant", value: "acme\\" }]);
check("a trailing backslash is stripped", backslashed.includes("\\"), false);
check(
  "a trailing backslash cannot orphan the closing quote",
  backslashed,
  `NOT(FIND("acme", LOWER({Company} & "")))`
);
check(
  "an interior backslash is stripped too",
  buildSuppressionClause([{ kind: "title_irrelevant", value: "vp\\head" }]),
  `NOT(FIND("vphead", LOWER({Lead Title} & "")))`
);

// Every produced clause must have balanced quotes — the cheap structural proof
// that nothing broke out, whatever the input was.
const NASTY = ['a"b', "c\\", 'd"\\e', '""', "\\\\", 'x") OR (1=1'];
for (const value of NASTY) {
  for (const kind of ["title_irrelevant", "company_irrelevant", "signal_irrelevant"]) {
    const clause = buildSuppressionClause([{ kind, value }]);
    const quoteCount = (clause.match(/"/g) || []).length;
    check(
      `${kind} + ${JSON.stringify(value)} → even number of quotes`,
      quoteCount % 2,
      0
    );
    check(
      `${kind} + ${JSON.stringify(value)} → no backslash survives`,
      clause.includes("\\"),
      false
    );
  }
}

// ─── the clauses themselves ──────────────────────────────────────
// Field names matter: these are the columns setup-fix guarantees on Tasks.
// {Title} is deliberately NOT referenced (an absent field 422s the whole
// formula), so a change to {Lead Title} here is a change with consequences.

check(
  "title_irrelevant matches {Lead Title}, lowercased on both sides",
  buildSuppressionClause([{ kind: "title_irrelevant", value: "Intern" }]),
  `NOT(FIND("intern", LOWER({Lead Title} & "")))`
);
check(
  "company_irrelevant matches {Company}",
  buildSuppressionClause([{ kind: "company_irrelevant", value: "Acme" }]),
  `NOT(FIND("acme", LOWER({Company} & "")))`
);
check(
  "signal_irrelevant matches Task Type OR Movement Type",
  buildSuppressionClause([{ kind: "signal_irrelevant", value: "Exited" }]),
  `NOT(OR(FIND("exited", LOWER({Task Type} & "")), FIND("exited", LOWER({Movement Type} & ""))))`
);
check(
  "an unknown kind is ignored rather than interpolated",
  buildSuppressionClause([{ kind: "not_a_real_kind", value: "boom" }]),
  ""
);
check(
  "two rules are ANDed so a task must match NEITHER to survive",
  buildSuppressionClause([
    { kind: "title_irrelevant", value: "intern" },
    { kind: "company_irrelevant", value: "acme" },
  ]),
  `AND(NOT(FIND("intern", LOWER({Lead Title} & ""))), NOT(FIND("acme", LOWER({Company} & ""))))`
);
check(
  "withSuppression wraps rather than replaces the base filter",
  withSuppression(BASE, [{ kind: "title_irrelevant", value: "intern" }]),
  `AND(${BASE}, NOT(FIND("intern", LOWER({Lead Title} & ""))))`
);
check("the documented kinds are the four the builder handles", RELEVANCE_KINDS, [
  "title_irrelevant",
  "company_irrelevant",
  "signal_irrelevant",
  "role_fit",
]);

// ─── role_fit: score override, and which one wins ────────────────
// Documented rule: when several match, the LOWEST target wins, because the
// operator is downgrading fit and the conservative reading is the safe one.

check("no rules → score untouched", roleFitScoreFor("VP Marketing", 90, []), 90);
check("no title → score untouched", roleFitScoreFor("", 90, [{ kind: "role_fit", value: "vp", targetScore: 10 }]), 90);
check(
  "a matching role_fit overrides the served score",
  roleFitScoreFor("VP Marketing", 90, [{ kind: "role_fit", value: "vp", targetScore: 30 }]),
  30
);
check(
  "matching is case-insensitive and substring-based",
  roleFitScoreFor("Senior INTERN, Growth", 88, [{ kind: "role_fit", value: "intern", targetScore: 5 }]),
  5
);
check(
  "a non-matching role_fit leaves the score alone",
  roleFitScoreFor("VP Marketing", 90, [{ kind: "role_fit", value: "intern", targetScore: 5 }]),
  90
);
check(
  "when two role_fit rules match, the LOWEST target wins",
  roleFitScoreFor("VP of Marketing Intern", 90, [
    { kind: "role_fit", value: "vp", targetScore: 40 },
    { kind: "role_fit", value: "intern", targetScore: 5 },
  ]),
  5
);
check(
  "order does not change which target wins",
  roleFitScoreFor("VP of Marketing Intern", 90, [
    { kind: "role_fit", value: "intern", targetScore: 5 },
    { kind: "role_fit", value: "vp", targetScore: 40 },
  ]),
  5
);
check(
  "a role_fit with no numeric target is ignored, not treated as zero",
  roleFitScoreFor("VP Marketing", 90, [{ kind: "role_fit", value: "vp", targetScore: null }]),
  90
);
check(
  "an override to 0 is honoured (0 is a real score, not 'absent')",
  roleFitScoreFor("VP Marketing", 90, [{ kind: "role_fit", value: "vp", targetScore: 0 }]),
  0
);
check(
  "a suppression-kind rule never overrides a score",
  roleFitScoreFor("VP Marketing", 90, [{ kind: "title_irrelevant", value: "vp", targetScore: 5 }]),
  90
);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
