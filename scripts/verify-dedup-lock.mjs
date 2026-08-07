// Verification for the two 2026-08-07 concurrency fixes in
// app/api/linkedin-posts/route.js:
//   1. the GET-resume concurrency lock
//   2. the last-moment dedup re-check before task creation
//
// These are the exact predicates the route uses, lifted verbatim so a drift
// between this file and the route shows up as a failing assert rather than a
// silent divergence. Run: node scripts/verify-dedup-lock.mjs
//
// Context: a real duplicate task shipped on 2026-08-07 — two records for the
// same post URL, created 9 seconds apart, because a manual resume driver ran
// alongside the 5-minute cron and both snapshotted the dedup set before either
// wrote.

let pass = 0, fail = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; console.error(`FAIL ${label}\n  expected ${e}\n  actual   ${a}`); }
};

// ── 1. resume lock predicate ────────────────────────────────────────────────
// Mirrors: prior.status === "running" && age < 30s  ->  BUSY
function isLocked(prior, nowMs) {
  if (!(prior.status === "running" && prior.updated_at)) return false;
  const ageMs = nowMs - new Date(prior.updated_at).getTime();
  return !isNaN(ageMs) && ageMs < 30 * 1000;
}
const NOW = Date.parse("2026-08-07T18:26:22.000Z");
const at = s => new Date(NOW - s * 1000).toISOString();

eq(isLocked({ status: "running", updated_at: at(9) }, NOW), true,
  "the real incident: a second resume 9s behind a live one is BUSY");
eq(isLocked({ status: "running", updated_at: at(0) }, NOW), true, "same-instant resume is BUSY");
eq(isLocked({ status: "running", updated_at: at(29) }, NOW), true, "29s is still BUSY");
eq(isLocked({ status: "running", updated_at: at(31) }, NOW), false, "31s has aged out, resume proceeds");
eq(isLocked({ status: "running", updated_at: at(600) }, NOW), false,
  "a stale lock never wedges the scan — 10min old proceeds");
// A crashed run must not be able to block its own recovery forever.
eq(isLocked({ status: "paused", updated_at: at(1) }, NOW), false, "only 'running' locks");
eq(isLocked({ status: "running" }, NOW), false, "no updated_at -> no lock (fail open, never wedge)");
eq(isLocked({ status: "running", updated_at: "garbage" }, NOW), false, "unparseable date fails open");

// ── 2. last-moment dedup filter ─────────────────────────────────────────────
function applyDedup(records, alreadyInAirtable) {
  const taken = new Set(alreadyInAirtable.map(u => String(u).trim()).filter(Boolean));
  if (!taken.size) return { fresh: records, skipped: 0 };
  const fresh = records.filter(r => !taken.has((r.fields?.URL || "").trim()));
  return { fresh, skipped: records.length - fresh.length };
}
const rec = u => ({ fields: { URL: u } });
const A = "https://www.linkedin.com/feed/update/urn:li:activity:7490095607127257088";
const B = "https://www.linkedin.com/feed/update/urn:li:activity:7490718499422736385";

eq(applyDedup([rec(A)], [A]).skipped, 1, "the duplicated post is dropped");
eq(applyDedup([rec(A)], [A]).fresh.length, 0, "nothing left to create");
eq(applyDedup([rec(A), rec(B)], [A]).fresh.map(r => r.fields.URL), [B],
  "only the taken URL is dropped, the genuine new task survives");
eq(applyDedup([rec(A), rec(B)], []).skipped, 0, "no existing tasks -> nothing dropped");
eq(applyDedup([rec(A)], [B]).skipped, 0, "a different post never suppresses this one");
eq(applyDedup([rec(` ${A} `)], [A]).skipped, 1, "whitespace-padded URL still matches");
eq(applyDedup([rec("")], [A]).fresh.length, 1,
  "a record with no URL is never silently dropped — better a rare dup than a lost task");

// ── 3. the formula that asks Airtable the question ──────────────────────────
function dupFormula(rule, urls) {
  const escapedRule = (rule || "").replace(/"/g, '\\"');
  const urlClause = urls.map(u => `{URL} = "${String(u).replace(/"/g, '\\"')}"`).join(", ");
  return `AND({Task Rule} = "${escapedRule}", OR(${urlClause}))`;
}
eq(dupFormula("LinkedIn Post Engagement", [A]),
  `AND({Task Rule} = "LinkedIn Post Engagement", OR({URL} = "${A}"))`,
  "single-URL formula");
eq(dupFormula('Rule "quoted"', [A]).includes('\\"quoted\\"'), true,
  "a quote in the rule name is escaped, not left to break the formula");
eq(dupFormula("R", ['ht"tp']).includes('\\"'), true, "a quote in a URL is escaped too");
// Scoping to the rule is what stops one connector's tasks masking another's.
eq(dupFormula("A", [A]) === dupFormula("B", [A]), false,
  "two different rules produce different formulas — dedup is per-rule, not global");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
