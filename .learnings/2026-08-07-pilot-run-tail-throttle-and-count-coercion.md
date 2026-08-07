# 2026-08-07 — Rishabh's first pilot run: tail-throttle recovery + feed count coercion

Two reusable findings from running the first full sweep for pilot tester Rishabh
(base `appefxdXz1pvF9L9i`, 530 leads, operator-scored at threshold 70, 20 tasks).

## 1. The posts provider soft-rate-limits the TAIL of long test_profile runs

After ~350-400 sequential `test_profile` calls (3 workers, ~1.2s pace), the provider
mass-fails with **"No URN in profile response"** plus 429s — errors went 15 → 124 in
the last 150 leads. This is THROTTLING, not bad URLs, even though it wears the same
costume as the known truncated-URL list defect (which runs ~2-3% and is spread evenly,
not clustered at the end).

**Recovery that worked:** back up the raw JSONL, strip the error records (the resume
logic treats any written line as done, so error lines block re-fetch), cool down 3-5
minutes, re-run. Two rounds recovered **120 of 124** leads — and the retried leads were
disproportionately qualified-rich (5 of the final 20 tasks, including the run's best
post). Accepting tail errors as list defects would have silently cost a quarter of the
queue. Genuinely bad URLs after retries: 4/530.

The fetch scripts store per-lead `raw` (rawReturnedCount) so a stored zero stays
diagnosable after the fact (provider empty body vs genuinely no recent posts).

## 2. `/api/sidekick/feed` now coerces engagement-count strings (commit e9803cb)

Pilot-tester bases (Nirav, Rishabh) carry `Post Likes` / `Post Comments` as **TEXT**
fields, so `typecast: true` stored `'27'` and the feed's strict
`typeof === "number"` check nulled the metric on every card — engagement counts were
fetched, stored, and invisible. The fix is `toCount()` in the feed route: finite
numbers pass through, clean integer strings parse, everything else stays null so the
card hides the metric rather than showing a misleading 0. Number-field bases
(Veloka, Material) are byte-identical in behavior.

Rule this encodes: **when tenant bases are hand-created, never trust field types to
match the canonical schema — coerce at the read boundary.** `setup-fix` cannot change
an existing field's type and the Airtable API cannot either, so the read boundary is
the only place this can be fixed once for all bases.

QA record (all live): Rishabh 19/19 cards numeric, Nirav 4/4, Veloka unchanged;
logged-in-as-rishabh end-to-end confirmed feed proxy + comment angles + comment voice.
