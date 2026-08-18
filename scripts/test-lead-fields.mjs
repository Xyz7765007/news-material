// ═══════════════════════════════════════════════════════════════════
// LEAD FIELD LOOKUP — the reason a task has a LinkedIn URL on it.
//
// Run: node scripts/test-lead-fields.mjs
//
// WHY THIS IS FEED-CRITICAL AND NOT A UTILITY DETAIL. The scan writes
// `"LinkedIn URL": pickLeadField(f, "linkedinUrl")` onto every task it
// creates. The feed's read filter then requires `{LinkedIn URL} != BLANK()`.
// So if this lookup returns "" for a lead whose base happens to spell the
// column "Linkedin Url" or "Profile URL", the task is still created, still
// scored, still paid for — and is invisible in the feed for ever. The failure
// is a silently shorter queue, which is indistinguishable from a quiet week.
//
// Every campaign base spells these columns differently (Apollo exports say
// "Title", Sales Nav says "Job Title", hand-built sheets say "Designation"),
// which is the whole reason the candidate chain exists.
// ═══════════════════════════════════════════════════════════════════

import { pickLeadField, LEAD_FIELD_CANDIDATES } from "../lib/lead-fields.js";

let pass = 0;
const failures = [];
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else failures.push(`${name}\n     expected ${e}, got ${a}`);
  console.log(`${a === e ? "  ok  " : "  FAIL"} ${name}`);
}

// ─── the four kinds resolve, and in priority order ───────────────
check("the four documented kinds all have candidate chains", Object.keys(LEAD_FIELD_CANDIDATES).sort(), [
  "email", "linkedinUrl", "phone", "title",
]);

check("title: the canonical name wins", pickLeadField({ Title: "CMO" }, "title"), "CMO");
check("title: falls through to Job Title", pickLeadField({ "Job Title": "CMO" }, "title"), "CMO");
check("title: falls through to Designation", pickLeadField({ Designation: "CMO" }, "title"), "CMO");
check(
  "title: the earlier candidate wins when several are present",
  pickLeadField({ Title: "first", "Job Title": "second", Designation: "third" }, "title"),
  "first"
);

// The lowercase-d spelling is the one that has actually bitten — Airtable
// column names are case-sensitive and "Linkedin URL" is a real spelling in the
// wild, which is why the feed route ALSO reads both on the way out.
for (const spelling of ["LinkedIn URL", "Linkedin URL", "LinkedIn Url", "Linkedin Url", "Profile URL", "LinkedIn"]) {
  check(
    `linkedinUrl: "${spelling}" is recognised`,
    pickLeadField({ [spelling]: "https://linkedin.com/in/x" }, "linkedinUrl"),
    "https://linkedin.com/in/x"
  );
}
check("email: Work Email is recognised", pickLeadField({ "Work Email": "a@b.com" }, "email"), "a@b.com");
check("phone: Mobile Number is recognised", pickLeadField({ "Mobile Number": "+91 99" }, "phone"), "+91 99");

// ─── the empty cases, which must be "" and never undefined ───────
// The scan writes the return value straight into an Airtable field. `undefined`
// and `""` behave differently there, and a task whose LinkedIn URL is the
// STRING "undefined" would pass the feed's != BLANK() filter and render a dead
// link on the card.
check("a missing field yields an empty string", pickLeadField({}, "title"), "");
check("an unknown kind yields an empty string", pickLeadField({ Title: "CMO" }, "nonsense"), "");
check("an empty-string value is skipped, not returned", pickLeadField({ Title: "", "Job Title": "CMO" }, "title"), "CMO");
check("a null value is skipped", pickLeadField({ Title: null, "Job Title": "CMO" }, "title"), "CMO");
check("an undefined value is skipped", pickLeadField({ Title: undefined, "Job Title": "CMO" }, "title"), "CMO");
check("all-empty candidates yield an empty string, never undefined", pickLeadField({ Title: "", "Job Title": "" }, "title"), "");
check("the return is never the literal undefined", typeof pickLeadField({}, "linkedinUrl"), "string");

// A 0 or false is a legitimate value for none of these kinds, but the guard is
// value-based rather than truthiness-based, so assert it stays that way — a
// switch to `if (v)` would start dropping real data on the next field added.
check("a zero-ish value is still returned rather than skipped", pickLeadField({ Phone: 0 }, "phone"), 0);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  " + f);
  process.exit(1);
}
