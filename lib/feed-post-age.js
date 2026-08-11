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
export const FEED_POST_AGE_DAYS_BY_BASE = {
  // ─── sidekick-posts alpha testers, 2026-08-11 ───────────────────
  // All five run a 90-day harvest window because their queues are built by
  // HAND-SCORING posts pulled through `test_profile` rather than by the
  // 7-day scan, and a hand-built queue is worth nothing if the feed hides it.
  //
  // THIS EXACT MISTAKE WAS MADE TWICE IN ONE DAY. First on Roopam: his scan
  // window was widened to 30 days and this gate silently ate the result —
  // 5 tasks written, 4 visible. Then again on Sammy: 10 hand-scored tasks
  // written, feed showed ZERO, because his base was not listed here. The
  // fetch window and this gate are two separate limits and they MUST be
  // changed together.
  //
  // Roopam Mishra / Phionike — design studio; his own comments sit on posts
  // a month old, several at two to five months. See the header above.
  apppThWqVVB9PvZgE: 90,
  appVQ7oxmSZ2Q0B7z: 90, // Sammy Abdullah / Blossom Street Ventures
  app4yPsHELEL3B88L: 90, // Rahul Wadhwa / School of SDR
  app2dS8otxaHx346y: 90, // Nirav Chatterji / CreatorDB
  appefxdXz1pvF9L9i: 90, // Rishabh Bhandari / Content Beta
};

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
