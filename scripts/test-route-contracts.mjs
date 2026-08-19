// ═══════════════════════════════════════════════════════════════════
// ROUTE CONTRACTS — invariants that live in the route files themselves and
// that no build, lint or type check can see.
//
// Run: node scripts/test-route-contracts.mjs
//
// These are SOURCE-LEVEL assertions on purpose. The three things asserted here
// are each documented in a comment somewhere in the code as something that
// "must" hold, and each of them has already been broken once while the app
// compiled, deployed and served traffic without a single error:
//
//   1. /api/sidekick/feed and /api/sidekick/count must build the SAME filter,
//      or the badge and the card stack disagree about what is pending.
//   2. A function called with an object literal must be called with the keys it
//      actually destructures. A misspelled key is not an error in JavaScript,
//      it is silence — see the scorePost case below, which shipped for 11 days.
//   3. Every route the chatbot and the feed app poll must opt out of Vercel's
//      cache, or they serve stale Airtable data.
//
// Reading source as text is crude, and it is the only thing that catches this
// class. A test that imported the routes would drag Next's server runtime in
// and still not see a shorthand-property typo.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}\n     got      ${a}`);
  console.log(`${a === e ? "  ok  " : "  FAIL"} ${name}`);
}

// ═══════════════════════════════════════════════════════════════════
// 1. FEED / COUNT FILTER PARITY
//
// Both routes say it in their own comments: "MUST stay byte-identical or the
// badge and the card stack disagree". The post-age gate was extracted into
// lib/feed-post-age.js precisely because two inline copies of a constant is
// how that drifts — but the REST of the formula is still written out twice,
// once in each file, so the drift risk simply moved rather than disappeared.
// ═══════════════════════════════════════════════════════════════════

const feedSrc = read("app/api/sidekick/feed/route.js");
const countSrc = read("app/api/sidekick/count/route.js");

// Pull a backtick template literal that starts right after `marker`.
function templateAfter(src, marker) {
  const at = src.indexOf(marker);
  if (at === -1) return null;
  const open = src.indexOf("`", at);
  if (open === -1) return null;
  const close = src.indexOf("`", open + 1);
  if (close === -1) return null;
  return src.slice(open + 1, close);
}

// The two files name the gate differently (a call vs a const holding the call's
// result). Both denote the same value, so normalise them to one token before
// comparing — that is what "the same filter" means here.
const normalise = (s) =>
  s === null
    ? null
    : s
        .replace(/\$\{postDateGate\(baseId\)\}/g, "<GATE>")
        .replace(/\$\{POST_DATE_GATE\}/g, "<GATE>")
        .replace(/\s+/g, " ")
        .trim();

const feedPending = normalise(templateAfter(feedSrc, "buildPendingFilter = (baseId) =>"));
const countPending = normalise(templateAfter(countSrc, "let PENDING_FILTER ="));
const feedLegacy = normalise(templateAfter(feedSrc, "const LEGACY_PENDING_FILTER ="));
const countLegacy = normalise(templateAfter(countSrc, "let LEGACY_PENDING_FILTER ="));

check("the feed's pending filter was found in source", typeof feedPending === "string" && feedPending.length > 40, true);
check("the count's pending filter was found in source", typeof countPending === "string" && countPending.length > 40, true);
check("the feed's legacy filter was found in source", typeof feedLegacy === "string" && feedLegacy.length > 40, true);
check("the count's legacy filter was found in source", typeof countLegacy === "string" && countLegacy.length > 40, true);

// The assertions the comments promise.
check("feed and count build the SAME pending filter", countPending, feedPending);
check("feed and count build the SAME legacy fallback filter", countLegacy, feedLegacy);

// And the clauses that make the filter mean what the docs say it means. If any
// of these is dropped, the feed silently starts serving tasks it should not.
for (const [label, clause] of [
  ["only unhandled tasks", "{Handled At} = BLANK()"],
  ["never archived tasks", "{Archived At} = BLANK()"],
  ["only leads with a LinkedIn URL", "{LinkedIn URL} != BLANK()"],
  ["the per-campaign post-age gate", "<GATE>"],
]) {
  check(`the pending filter still enforces ${label}`, feedPending.includes(clause), true);
}
check(
  "the legacy fallback drops the two fields un-migrated bases lack",
  feedLegacy.includes("Archived At") || feedLegacy.includes("Post Date"),
  false
);
check("the legacy fallback still enforces Handled At", feedLegacy.includes("{Handled At} = BLANK()"), true);

// Both routes must fold suppression into BOTH filters, or a retry silently
// drops the operator's suppression rules.
for (const [name, src] of [["feed", feedSrc], ["count", countSrc]]) {
  check(`${name} applies withSuppression to both filters`, (src.match(/withSuppression\(/g) || []).length >= 2, true);
}

// ═══════════════════════════════════════════════════════════════════
// 2. CALL-SITE KEYS MATCH DESTRUCTURED PARAMS
//
// THE BUG THIS EXISTS FOR (live 2026-08-07 → 2026-08-18, commit a264247):
//
//     const scored = await scorePost({
//       post, lead, campaignContext, effectivePrompt,   // <- shorthand
//       ...
//     });
//
// scorePost destructures `systemPromptOverride`, not `effectivePrompt`. So the
// object carried a key nothing read, the parameter that IS read arrived
// undefined, and every scan fell back to the built-in default prompt. The admin
// UI's Custom Prompt was accepted and ignored. The per-tenant bar set through
// {action:"set_scoring_config"} was ignored. `Scoring Isolated` — a flag whose
// entire job is to REFUSE to score a tenant against another tenant's criteria —
// checked that a prompt existed, passed, and then scored them against exactly
// that. Progress even recorded system_prompt_override as though it had been
// used, so the audit trail agreed with the bug.
//
// Nothing could have caught it: it compiles, it lints, it deploys, it returns
// 200, and the output is plausible. Only comparing the two lists finds it.
// ═══════════════════════════════════════════════════════════════════

const scanSrc = read("app/api/linkedin-posts/route.js");

// Both of these files comment their parameter lists and their call sites
// heavily, and a comment sitting between two commas parses as a parameter
// unless it is removed first. Block comments go entirely; line comments go to
// end of line, but `://` is spared so a URL inside a string survives.
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function destructuredParams(src, fnName) {
  const m = src.match(new RegExp(`function ${fnName}\\(\\{([^}]*)\\}`));
  if (!m) return null;
  return stripComments(m[1])
    .split(",")
    .map((s) => s.split(/[=:]/)[0].trim())
    .filter(Boolean);
}

// Keys of the object literal passed at a `fnName({ ... })` call site.
function callSiteKeys(src, fnName) {
  const at = src.indexOf(`${fnName}({`);
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) return null;
  const body = stripComments(src.slice(open + 1, end));
  const keys = [];
  let depthB = 0, current = "";
  for (const ch of body) {
    if (ch === "{" || ch === "(" || ch === "[") depthB++;
    if (ch === "}" || ch === ")" || ch === "]") depthB--;
    if (ch === "," && depthB === 0) { keys.push(current); current = ""; }
    else current += ch;
  }
  keys.push(current);
  return keys
    .map((k) => k.split(":")[0].trim())
    .filter((k) => k && !k.startsWith("..."))
    .filter(Boolean);
}

const scoreParams = destructuredParams(scanSrc, "scorePost");
const scoreKeys = callSiteKeys(scanSrc, "await scorePost");

check("scorePost's parameter list was found", Array.isArray(scoreParams) && scoreParams.length > 3, true);
check("scorePost's call site was found", Array.isArray(scoreKeys) && scoreKeys.length > 3, true);

const unknownKeys = (scoreKeys || []).filter((k) => !(scoreParams || []).includes(k));
check("every key passed to scorePost is a parameter it destructures", unknownKeys, []);

// The specific one, named, so a regression reads as itself rather than as a
// generic list mismatch.
check("scorePost is passed systemPromptOverride", (scoreKeys || []).includes("systemPromptOverride"), true);
check("scorePost is NOT passed the local name effectivePrompt", (scoreKeys || []).includes("effectivePrompt"), false);

// Same check for the scan entry point, which the POST handler and the cron GET
// both call with object literals.
const runParams = destructuredParams(scanSrc, "runLinkedInPostScan");
check("runLinkedInPostScan's parameter list was found", Array.isArray(runParams) && runParams.length > 5, true);
for (const site of ["await runLinkedInPostScan"]) {
  const keys = callSiteKeys(scanSrc, site);
  check(`${site} call site was found`, Array.isArray(keys) && keys.length > 3, true);
  check(
    `every key passed at ${site} is a real parameter`,
    (keys || []).filter((k) => !(runParams || []).includes(k)),
    []
  );
}

// The tenancy guard itself: the prompt the scan resolved must be the prompt the
// scorer is handed. Both halves are asserted so neither can be quietly dropped.
check("the scan resolves an effectivePrompt", scanSrc.includes("const effectivePrompt ="), true);
check(
  "the resolved prompt is what gets handed to the scorer",
  /systemPromptOverride:\s*effectivePrompt/.test(scanSrc),
  true
);
check(
  "Scoring Isolated still fails closed rather than falling back",
  /campScoring\.isolated\s*&&\s*!String\(/.test(scanSrc),
  true
);

// ═══════════════════════════════════════════════════════════════════
// 2b. THE CARD SHAPE IS A CROSS-REPO CONTRACT
//
// formatCard() in /api/sidekick/feed decides the field names on every card.
// sidekick-feed's lib/signalscope.js cardToFeedItem() reads those names, in
// ANOTHER REPO, with no shared type and no import between them. Renaming a key
// here does not break a build anywhere; it makes the reader's card render with
// a blank name, or a missing post body, or a score of 60 where a real one
// existed — silently, for every tester at once.
//
// The route's own header already calls this a "stable shape — the chatbot can
// rely on these field names". This is that sentence, enforced.
// ═══════════════════════════════════════════════════════════════════

const formatCardBlock = (() => {
  const at = feedSrc.indexOf("function formatCard(");
  if (at === -1) return "";
  return feedSrc.slice(at, feedSrc.indexOf("\n}", at));
})();

check("formatCard was found in the feed route", formatCardBlock.length > 100, true);

// Every field sidekick-feed/lib/signalscope.js reads off a card. Keep this list
// in step with cardToFeedItem() if that function starts reading a new one.
const CONSUMED_BY_FEED_APP = [
  "id",          // becomes the item id (`li_<recId>`) and half the dedup key
  "url",         // the link the card opens
  "lead_name",   // the card's headline
  "lead_title",  // the role line under it
  "company",     // the source chip
  "task_type",   // switches the lead_movement wording
  "post_text",   // the post body, and whether the card IS a post at all
  "signal",      // the fallback body for a non-post card
  "score",       // ranking
  "post_date",   // the only honest timestamp the card has
  "lead_linkedin", // the fallback link when there is no post URL
  "created_at",  // tie-break ordering
];
for (const field of CONSUMED_BY_FEED_APP) {
  check(`formatCard still emits "${field}" (read by sidekick-feed)`, new RegExp(`^\\s*${field}:`, "m").test(formatCardBlock), true);
}

// The two engagement counts go through a coercion helper rather than a typeof
// check, because the pilot bases store them as TEXT and a strict number test
// hid the metric on every card (2026-08-07). Null must stay reachable so a card
// can distinguish "no data" from a real zero.
check("engagement counts go through the coercion helper", /post_likes: toCount\(/.test(formatCardBlock), true);
check("post_comments too", /post_comments: toCount\(/.test(formatCardBlock), true);
check(
  "toCount returns null rather than 0 for unusable input",
  /function toCount[\s\S]*?return null;\s*\n\}/.test(feedSrc),
  true
);

// ═══════════════════════════════════════════════════════════════════
// 3. NO ROUTE THE FEED POLLS MAY BE CACHED
//
// CLAUDE.md §15: "Every API route starts with export const dynamic =
// 'force-dynamic'; export const fetchCache = 'force-no-store'". Without it
// Vercel caches the response and the feed app reads a stale Airtable snapshot —
// which looks exactly like "no new cards", not like a bug.
// ═══════════════════════════════════════════════════════════════════

const sidekickDir = join(ROOT, "app/api/sidekick");
function routeFiles(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, acc);
    else if (entry === "route.js") acc.push(full);
  }
  return acc;
}
const sidekickRoutes = routeFiles(sidekickDir);
check("the sidekick route folder was found and is non-empty", sidekickRoutes.length > 5, true);

// The routes the feed app itself depends on. Scoped deliberately: these are the
// ones whose staleness the reader would actually see.
const FEED_CRITICAL = ["feed", "count"];
for (const name of FEED_CRITICAL) {
  const src = read(`app/api/sidekick/${name}/route.js`);
  check(`/api/sidekick/${name} is force-dynamic`, /export const dynamic = "force-dynamic"/.test(src), true);
  check(`/api/sidekick/${name} disables fetch caching`, /export const fetchCache = "force-no-store"/.test(src), true);
  // Fail-closed auth: an unset SIDEKICK_API_KEY must reject, never allow.
  check(`/api/sidekick/${name} fails closed when the API key is unset`, /if \(!SIDEKICK_API_KEY\) return false/.test(src), true);
  check(`/api/sidekick/${name} requires a Bearer token`, /Bearer \$\{SIDEKICK_API_KEY\}/.test(src), true);
}

// The scan route is the one the feed's cadence starts, stops and polls. Its
// 300s ceiling is what the whole chunk-and-resume design is built around.
check("the scan route declares the 300s Vercel ceiling", /export const maxDuration = 300/.test(scanSrc), true);
check("the scan route keeps its connector kill-switch on the scan action", /LINKEDIN_CONNECTORS_ENABLED/.test(scanSrc), true);
check("the cron GET is key-gated", /if \(key !== CRON_SECRET\)/.test(scanSrc), true);
check("the cron GET refuses to run when CRON_SECRET is unset", /if \(!CRON_SECRET\) return/.test(scanSrc), true);

// ═══════════════════════════════════════════════════════════════════
// 4. THE DORMANT THROTTLE IS OPT-IN, AND STAYS OPT-IN
//
// The scan engine serves BOTH the feed app and live client signal work
// (Material, Veloka, Osome) against the same bases — Kunal's feed base IS the
// Veloka client base. The feed may skip a lead that has not posted recently; a
// client signal run may not, because there a missed signal is the product
// failing.
//
// The entire boundary is that this parameter DEFAULTS TO NULL and is honoured
// only when a caller passes a positive number. If that default ever flips, the
// throttle silently starts applying to client scans, and nobody learns it from
// an error — they learn it from a signal that never arrived. So it is asserted
// directly rather than assumed.
// ═══════════════════════════════════════════════════════════════════

check("dormantSkipDays defaults to null in the scan signature", /dormantSkipDays = null/.test(scanSrc), true);
check(
  "it is honoured only as a positive finite number",
  /Number\.isFinite\(Number\(dormantSkipDays\)\) && Number\(dormantSkipDays\) > 0/.test(scanSrc),
  true
);
check("no policy means no cutoff, so the skip can never run", /const dormantCutoffMs =\s*effectiveDormantDays/.test(scanSrc), true);

// Read, stamp and clear must EACH sit behind the policy gate, or a client run
// would start reading or writing per-lead state as a side effect.
check("the skip is gated on the policy", /if \(dormantCutoffMs\) \{[\s\S]{0,500}?lastEmptyRaw/.test(scanSrc), true);
check(
  "the stamp is gated on the policy",
  /if \(dormantCutoffMs\) \{[\s\S]{0,400}?atUpdateWithAutoCreate\(baseId, "Leads"/.test(scanSrc),
  true
);
check(
  "the clear is gated on the policy AND on a marker already being present",
  /if \(dormantCutoffMs && f\[LEAD_DORMANT_FIELD\]\)/.test(scanSrc),
  true
);

check("the policy is persisted so a resume keeps it", /dormant_skip_days: effectiveDormantDays/.test(scanSrc), true);
check("the cron resume rehydrates it", /prior\.dormant_skip_days/.test(scanSrc), true);
check("the POST handler accepts it from the body", /categoryOverrides, dormantSkipDays, resume/.test(scanSrc), true);
check("skips are counted so the saving is visible in progress", /progress\.dormant_skipped/.test(scanSrc), true);

// A skipped lead must still advance the run, or a throttled scan never finishes
// and the resume tick loops on it for ever.
check(
  "a skipped lead is marked done and the run advances past it",
  /dormant_skipped[\s\S]{0,700}?completed_lead_ids\.push\(lead\.id\)[\s\S]{0,150}?leads_done\+\+/.test(scanSrc),
  true
);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
