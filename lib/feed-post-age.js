// ═══════════════════════════════════════════════════════════════════
// FEED POST-AGE WINDOW — how old the underlying LinkedIn POST may be
// before a linkedin_engagement task drops out of the operator's feed.
//
// WHY THIS FILE EXISTS. The gate was written inline, twice, as a literal 7
// in BOTH /api/sidekick/feed and /api/sidekick/count. Those two filters must
// stay byte-identical or the badge count and the card stack disagree, and two
// copies of a constant is how that drifts. One helper, both callers.
//
// WHY IT IS NOW PER CAMPAIGN. Seven days is right for a signal whose value
// decays fast: a funding round, a job change, a product launch. It is wrong
// for Roopam Mishra (Phionike, base apppThWqVVB9PvZgE), who sells design
// services. Of his 21 measured comments, MOST sit on posts a MONTH old, with
// several at two, three and five months — and the thing he answers, someone
// looking for a designer, stays open for weeks because the role stays open.
//
// WHAT IT COST TO LEARN. His scan window was widened to 30 days on that
// evidence, and it silently bought nothing: the scan paid the RapidAPI call,
// paid the OpenAI scoring and wrote the task, and this gate hid it. Five
// tasks created, four visible; the fifth was a 14-day-old post that was
// invisible from the moment it was written. **The scan window and this gate
// are two separate limits, and moving only the visible one produces tasks
// nobody can act on.** Keep `days_back` in run-scan.py and the value here in
// step for any campaign that changes either.
//
// DEFAULT IS UNCHANGED AT 7. Every base not listed below gets exactly the
// filter string it got before this file existed — Material, Veloka, Nirav,
// Rishabh, Sammy and Rahul are byte-identical. This is opt-in, the same shape
// as the `categoryOverrides` payload in /api/linkedin-posts, and for the same
// reason: a shared default that is right for most clients should not be
// rewritten for all of them to serve one.
// ═══════════════════════════════════════════════════════════════════

export const DEFAULT_FEED_POST_AGE_DAYS = 7;

// baseId → days. Add a row only with a measured reason, and update
// run-scan.py's `days_back` for the same tester in the same change.
// EMPTIED 2026-08-12 on Samarth's instruction: "dont go beyond 7 days please,
// restrict to 7 days only... the posts shouldnt be older than 7 days."
//
// The 90-day entries that were here (all five alpha testers) are gone. Seven
// days is now the rule for EVERY base, testers included, and this map is kept
// only as the mechanism for a future exception.
//
// The argument for widening is recorded above and still stands on its own
// terms — Roopam's real comments sit on month-old posts. It lost to a product
// call that a stale post is a bad comment opportunity, which is a reasonable
// place to land. If it is ever revisited, remember the other half: the FETCH
// window in run-scan.py / harvest-posts.py must move WITH this map, or one of
// the two silently wins and you get tasks nobody can see.
export const FEED_POST_AGE_DAYS_BY_BASE = {};

export function feedPostAgeDays(baseId) {
  const d = FEED_POST_AGE_DAYS_BY_BASE[String(baseId || "")];
  return Number.isFinite(d) && d > 0 ? d : DEFAULT_FEED_POST_AGE_DAYS;
}

// The gate itself. Identical to the string that was inline in both routes
// when days === 7, so nothing changes for an un-listed base.
export function postDateGate(baseId) {
  const days = feedPostAgeDays(baseId);
  return `NOT(AND(FIND("linkedin_engagement", {Task Type}), NOT({Post Date} = BLANK()), NOT(IS_AFTER({Post Date}, DATEADD(NOW(), -${days}, 'days')))))`;
}
