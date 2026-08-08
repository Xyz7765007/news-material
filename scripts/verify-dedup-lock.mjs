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

// ── 4. progress counters survive a resume ───────────────────────────────────
// The constructor seeds every counter from `prior`. `rejection_reasons` and
// `recent_samples` were missing from that list while being assigned WHOLESALE
// later, so each resume overwrote the accumulated map with its own chunk.
function newProgress(prior) {
  return {
    leads_done: prior?.leads_done || 0,
    posts_fetched: prior?.posts_fetched || 0,
    rejection_reasons: prior?.rejection_reasons || {},
    recent_samples: prior?.recent_samples || [],
  };
}
// One chunk of work, mirroring the route: read the map, add to it, assign back.
function runChunk(progress, { fetched = 0, rejections = {}, samples = [] }) {
  const rejectionReasons = progress.rejection_reasons || {};
  for (const [k, v] of Object.entries(rejections)) {
    rejectionReasons[k] = (rejectionReasons[k] || 0) + v;
  }
  progress.posts_fetched += fetched;
  for (const s of samples) progress.recent_samples.unshift(s);
  if (progress.recent_samples.length > 20) progress.recent_samples = progress.recent_samples.slice(0, 20);
  progress.rejection_reasons = rejectionReasons;
  return progress;
}

let p = runChunk(newProgress(null), { fetched: 40, rejections: { below_threshold_58: 2 }, samples: [{ id: 1 }] });
p = runChunk(newProgress(p), { fetched: 20, rejections: { below_threshold_58: 1, below_threshold_4: 3 }, samples: [{ id: 2 }] });
p = runChunk(newProgress(p), { fetched: 14, rejections: {}, samples: [] });

eq(p.posts_fetched, 74, "posts_fetched accumulates across three resumes");
eq(p.rejection_reasons, { below_threshold_58: 3, below_threshold_4: 3 },
  "rejection counts accumulate instead of being overwritten by the last chunk");
eq(p.recent_samples.length, 2, "samples from earlier chunks survive a later empty chunk");
// The exact shape of the bug: a final chunk with no scored posts used to zero the map.
eq(Object.keys(runChunk(newProgress(p), { fetched: 0 }).rejection_reasons).length, 2,
  "a trailing empty chunk no longer wipes the audit trail");
// The impossible pair that exposed it.
const impossible = runChunk(newProgress(null), { fetched: 22, rejections: {} });
eq(impossible.posts_fetched > 0 && Object.keys(impossible.rejection_reasons).length === 0, true,
  "22 scored with 0 rejections is reproducible ONLY when the map starts empty — the symptom");
// Cap still holds, so seeding cannot grow the array without bound.
let capped = newProgress(null);
for (let i = 0; i < 30; i++) capped = runChunk(newProgress(capped), { samples: [{ id: i }] });
eq(capped.recent_samples.length, 20, "recent_samples stays capped at 20 across many resumes");
eq(capped.recent_samples[0].id, 29, "newest sample is first");

// ── 5. data-loss detection ──────────────────────────────────────────────────
// Fires only when data we HELD failed to land. Null engagement from the provider
// is legitimate (Kunal: never fake a 0), so comparing against zero would cry wolf
// on every post that genuinely has no counts.
const DATA_BEARING = new Set(["Post Text", "Post Likes", "Post Comments", "Post Date", "URL"]);
const strippedDataFields = f => f.filter(x => DATA_BEARING.has(x));

eq(strippedDataFields(["Post URL", "Signal URL"]), [],
  "stripping fields that carry no signal is not reported as data loss");
eq(strippedDataFields(["Post URL", "Post Likes"]), ["Post Likes"],
  "a stripped engagement column IS reported");
eq(strippedDataFields(["Post Text"]), ["Post Text"], "a stripped post body IS reported");

function lostFields(post, storedFields) {
  const lost = [];
  if (typeof post.likes === "number" && storedFields["Post Likes"] === undefined) lost.push("Post Likes");
  if (typeof post.comments === "number" && storedFields["Post Comments"] === undefined) lost.push("Post Comments");
  const wantedText = (post.text || "").slice(0, 3000);
  if (wantedText && !String(storedFields["Post Text"] || "").trim()) lost.push("Post Text");
  return lost;
}
// The exact 2026-08-07 case: provider gave 41/0, stored record has neither.
eq(lostFields({ likes: 41, comments: 0, text: "hello world" }, { "Post Text": "hello world" }),
  ["Post Likes", "Post Comments"], "the real incident is detected");
eq(lostFields({ likes: 41, comments: 0, text: "x" }, { "Post Likes": "41", "Post Comments": "0", "Post Text": "x" }),
  [], "a fully-persisted task reports nothing");
// comments: 0 is a REAL value and must be tracked, not treated as absent.
eq(lostFields({ likes: 41, comments: 0, text: "x" }, { "Post Likes": "41", "Post Text": "x" }),
  ["Post Comments"], "a genuine zero that failed to store is still data loss");
// The provider not returning counts is not a defect — do not cry wolf.
eq(lostFields({ likes: null, comments: null, text: "x" }, { "Post Text": "x" }), [],
  "null engagement from the provider is legitimate, never reported");
eq(lostFields({ likes: undefined, comments: undefined, text: "x" }, { "Post Text": "x" }), [],
  "undefined engagement is legitimate too");
// Losing the post body is the worst case — the card has nothing to show.
eq(lostFields({ likes: null, comments: null, text: "a real post" }, { "Post Text": "" }),
  ["Post Text"], "an empty stored body when we had text IS data loss");
eq(lostFields({ likes: null, comments: null, text: "" }, {}), [],
  "no text to begin with is not a loss");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
