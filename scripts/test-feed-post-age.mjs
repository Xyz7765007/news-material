// ═══════════════════════════════════════════════════════════════════
// FEED POST-AGE GATE — the per-campaign freshness window.
//
// Run: node scripts/test-feed-post-age.mjs
//
// This helper exists because the gate was once written inline, twice, as a
// literal 7 in BOTH /api/sidekick/feed and /api/sidekick/count, and those two
// filters must stay byte-identical or the badge count and the card stack
// disagree. The helper removed the duplication; these tests hold the contract
// it replaced it with.
//
// The other half of the contract is NOT testable from here and is stated so
// nobody has to rediscover it: the FETCH window (run-scan.py / harvest-posts.py
// days_back) and this READ gate are two separate limits. Widening only one
// produces tasks that are paid for, scored, written, and invisible from the
// moment they exist. It has happened once already.
// ═══════════════════════════════════════════════════════════════════

import {
  DEFAULT_FEED_POST_AGE_DAYS,
  FEED_POST_AGE_DAYS_BY_BASE,
  feedPostAgeDays,
  postDateGate,
} from "../lib/feed-post-age.js";

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}, got ${a}`);
  console.log(`${a === e ? "  ok  " : "  FAIL"} ${name}`);
}

// ─── the default, which is the rule for every base right now ─────
// Samarth, 2026-08-12: "dont go beyond 7 days please, restrict to 7 days
// only". The override map was emptied to honour that. If a future change
// repopulates it, that is a product decision and these first assertions are
// where it becomes visible rather than silent.

check("the default window is 7 days", DEFAULT_FEED_POST_AGE_DAYS, 7);
check("the override map is empty — 7 days is the rule for everyone", FEED_POST_AGE_DAYS_BY_BASE, {});
check("an unlisted base gets the default", feedPostAgeDays("appPcAzAyMmtNNEmT"), 7);
check("an empty baseId gets the default rather than throwing", feedPostAgeDays(""), 7);
check("a null baseId gets the default", feedPostAgeDays(null), 7);
check("an undefined baseId gets the default", feedPostAgeDays(undefined), 7);

// Every base the feed app actually serves must resolve to 7 while the map is
// empty. Listed explicitly so that adding an override for one tester cannot
// quietly change the window for the others.
const LIVE_BASES = [
  "appPcAzAyMmtNNEmT", // kunal
  "appuA1AFKaEKgpb7f", // tester
  "app2dS8otxaHx346y", // nirav
  "appefxdXz1pvF9L9i", // rishabh
  "appVQ7oxmSZ2Q0B7z", // sammy
  "app4yPsHELEL3B88L", // rahul
  "apppThWqVVB9PvZgE", // roopam
];
for (const b of LIVE_BASES) {
  check(`live base ${b} resolves to 7 days`, feedPostAgeDays(b), 7);
}

// ─── the produced formula ────────────────────────────────────────
// The exact string matters: it is concatenated into the live read filter, and
// it must keep its "only gate linkedin_engagement, only when Post Date is
// actually set" shape. A blank Post Date (legacy rows, undatable posts) must
// fall through to the Created window instead of being excluded — otherwise
// every pre-2026-06-09 task silently vanishes from the feed.

const gate = postDateGate("appPcAzAyMmtNNEmT");
check(
  "the default gate string is the one that was inline before the helper existed",
  gate,
  `NOT(AND(FIND("linkedin_engagement", {Task Type}), NOT({Post Date} = BLANK()), NOT(IS_AFTER({Post Date}, DATEADD(NOW(), -7, 'days')))))`
);
check("the gate scopes itself to linkedin_engagement", gate.includes(`FIND("linkedin_engagement", {Task Type})`), true);
check("a blank Post Date is explicitly excused", gate.includes(`NOT({Post Date} = BLANK())`), true);
check("the gate has balanced parentheses", (gate.match(/\(/g) || []).length, (gate.match(/\)/g) || []).length);
check("the gate has an even number of quotes", (gate.match(/"/g) || []).length % 2, 0);
check("every base produces the identical gate while the map is empty",
  new Set(LIVE_BASES.map(postDateGate)).size, 1);

// A defensive read of feedPostAgeDays: a nonsense override must not produce a
// nonsense formula. The helper guards with Number.isFinite && > 0.
check("a zero override falls back to the default", (() => {
  FEED_POST_AGE_DAYS_BY_BASE.appZeroTest = 0;
  const d = feedPostAgeDays("appZeroTest");
  delete FEED_POST_AGE_DAYS_BY_BASE.appZeroTest;
  return d;
})(), 7);
check("a negative override falls back to the default", (() => {
  FEED_POST_AGE_DAYS_BY_BASE.appNegTest = -3;
  const d = feedPostAgeDays("appNegTest");
  delete FEED_POST_AGE_DAYS_BY_BASE.appNegTest;
  return d;
})(), 7);
check("a non-numeric override falls back to the default", (() => {
  FEED_POST_AGE_DAYS_BY_BASE.appStrTest = "thirty";
  const d = feedPostAgeDays("appStrTest");
  delete FEED_POST_AGE_DAYS_BY_BASE.appStrTest;
  return d;
})(), 7);
check("a real override is honoured and reaches the formula", (() => {
  FEED_POST_AGE_DAYS_BY_BASE.appRealTest = 30;
  const g = postDateGate("appRealTest");
  delete FEED_POST_AGE_DAYS_BY_BASE.appRealTest;
  return g.includes("-30, 'days'");
})(), true);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
