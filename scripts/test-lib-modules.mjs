// ═══════════════════════════════════════════════════════════════════
// LIB MODULE HEALTH — every helper loads, and lib/ stays one module system.
//
// Run: node scripts/test-lib-modules.mjs
//
// WHY THIS EXISTS (and it is a mistake made during this very audit, 2026-08-18).
// lib/package.json was added so the test suite could import these helpers at
// all. Sixteen of the seventeen modules were already ESM; ONE
// (google-news-decoder.js) still ended in `module.exports = {...}`. Next's
// bundler had been quietly tolerating the mix, so nothing said so — until the
// folder was declared ESM, at which point `module` stopped existing there and
// app/api/scan/route.js's named imports resolved to undefined:
//
//   Attempted import error: 'decodeGoogleNewsUrl' is not exported from
//   '@/lib/google-news-decoder'
//
// That is a build WARNING, not an error. The build still exits 0 and still
// deploys. It would have surfaced as /api/scan throwing on the first Google
// News URL it tried to decode — in production, on Material's news scan.
//
// So the assertion below is not stylistic. A single CommonJS file in this
// folder now breaks a live route, and the only thing that says so is a warning
// nobody greps for.
// ═══════════════════════════════════════════════════════════════════

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIB = join(ROOT, "lib");

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}, got ${a}`);
  console.log(`${a === e ? "  ok  " : "  FAIL"} ${name}`);
}

// ─── lib/ is declared ESM, so it must BE ESM ─────────────────────
const libPkg = JSON.parse(readFileSync(join(LIB, "package.json"), "utf8"));
check("lib/ declares itself ESM", libPkg.type, "module");

const libFiles = readdirSync(LIB).filter((f) => f.endsWith(".js"));
check("lib/ has the expected number of modules", libFiles.length >= 15, true);

// THE GUARD. A `.js` file in an ESM folder that assigns module.exports exports
// nothing, and its importers silently get undefined.
const cjsOffenders = libFiles.filter((f) => {
  const src = readFileSync(join(LIB, f), "utf8");
  // Ignore the word inside comments — only a real assignment counts.
  return /^\s*module\.exports\s*=/m.test(src) || /^\s*exports\.\w+\s*=/m.test(src);
});
check("no lib module uses CommonJS exports", cjsOffenders, []);

// Every module must export SOMETHING, or an importer is silently getting
// nothing from it.
const noExport = libFiles.filter((f) => !/^export\s/m.test(readFileSync(join(LIB, f), "utf8")));
check("every lib module has at least one ESM export", noExport, []);

// ─── the pure modules actually load in plain Node ────────────────
// Listed explicitly rather than globbed, because two modules are deliberately
// webpack-only and must not be asserted here:
//
//   role-freshness.js    imports "@/lib/linkedin-fetch" — the `@/` alias is a
//                        Next/jsconfig path mapping that plain Node cannot see.
//   movement-detection.js imports "./company-match" with NO file extension,
//                        which webpack resolves and Node's ESM loader does not.
//
// Neither is broken for the app. Both are simply not loadable by a test, and
// saying so here is better than a skipped test nobody can explain later.
const NODE_LOADABLE = [
  ["ai-usage.js", null],
  ["company-match.js", null],
  ["composite-score.js", null],
  ["connector-flags.js", ["LINKEDIN_CONNECTORS_ENABLED", "LINKEDIN_DMS_ENABLED", "connectorDisabledResponse"]],
  ["constants.js", null],
  ["cost-sheet.js", null],
  ["feed-post-age.js", ["DEFAULT_FEED_POST_AGE_DAYS", "feedPostAgeDays", "postDateGate"]],
  ["google-news-decoder.js", ["decodeGoogleNewsUrl", "extractEncodedPart", "drainFailureStats"]],
  ["lead-brief.js", null],
  ["lead-fields.js", ["pickLeadField", "LEAD_FIELD_CANDIDATES"]],
  ["linkedin-fetch.js", null],
  ["llm-cost-log.js", ["trackLLMCall", "trackAPICall"]],
  ["message-merge.js", null],
  ["rapidapi-usage.js", null],
  ["relevance-rules.js", ["buildSuppressionClause", "withSuppression", "roleFitScoreFor", "fetchActiveRelevanceRules"]],
];

for (const [file, expectedExports] of NODE_LOADABLE) {
  let mod = null, err = null;
  try {
    mod = await import(new URL(`../lib/${file}`, import.meta.url).href);
  } catch (e) {
    err = String(e?.message || e).slice(0, 160);
  }
  check(`lib/${file} loads in plain Node`, err, null);
  if (!mod) continue;
  const names = Object.keys(mod).filter((k) => k !== "default");
  check(`lib/${file} exposes at least one named export`, names.length > 0, true);
  for (const want of expectedExports || []) {
    check(`lib/${file} exports ${want}`, Object.prototype.hasOwnProperty.call(mod, want), true);
  }
}

// ─── the one import site that the CJS mix actually broke ─────────
const scanSrc = readFileSync(join(ROOT, "app/api/scan/route.js"), "utf8");
const decoderImport = scanSrc.match(/import\s*\{([^}]*)\}\s*from\s*"@\/lib\/google-news-decoder"/);
check("/api/scan still imports the decoder by name", !!decoderImport, true);
if (decoderImport) {
  const wanted = decoderImport[1].split(",").map((s) => s.trim()).filter(Boolean);
  const mod = await import(new URL("../lib/google-news-decoder.js", import.meta.url).href);
  for (const name of wanted) {
    check(`/api/scan imports "${name}" and the module really exports it`, typeof mod[name], "function");
  }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
