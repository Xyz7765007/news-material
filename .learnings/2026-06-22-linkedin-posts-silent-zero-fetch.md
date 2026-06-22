# 2026-06-22 — LinkedIn posts scan: silent false-zero fetches (Veloka)

## Symptom
Fresh Veloka LinkedIn-posts scan (`recV0RlBHUmrhtVq2` / base `appPcAzAyMmtNNEmT`)
processed 100 leads and recorded **posts_fetched: 0, tasks_created: 0**, with only
1 logged error (a no-URN profile). Looked like "no one posted" — but wasn't.

## Diagnosis (confirmed, not inferred)
Tested 8 of the already-"completed" leads individually via the `test_profile`
debug action (`{action:"test_profile", baseId, leadId}` — same path the scan uses:
`getUrnForLead` → `fetchPostsForUrn`). **Every one returned 5 datable posts in the
last 7 days.** All 8 were confirmed present in `completed_lead_ids` (the scan had
marked them done with 0 posts). Bill Gates control + 4-way concurrent burst also
returned posts. So:
- The `fresh-linkedin-scraper-api` provider is healthy for individual/low-volume calls.
- During the sustained bulk scan window it returned **HTTP 200 with empty/soft
  post bodies** for leads that genuinely have posts — a transient degradation /
  rate-state, recovered minutes later.
- Leads processed by the *solo* single-threaded POST-resume tick (no concurrent
  drivers, indices 64–100) also false-zeroed → **not caused by overlapping drivers**;
  it's the provider under sustained pace.

## Root cause (code)
1. `rapidCall` (route.js ~262) returns `{ok:true}` for **any** HTTP 200 + valid
   JSON. It does NOT inspect the body's `success` flag or null data. A
   rate-limited/soft-error 200 is treated as success.
2. `fetchPostsForUrn` (~388-393): when the posts array is empty it `break`s and
   returns `{ok:true, posts:[]}` — indistinguishable from a genuine "no recent posts."
3. Scan loop (~1229): `fetchedPosts.length === 0` → logs to `last_log` only (NOT
   `errors`), marks the lead in `completed_lead_ids`, advances. **Permanent skip,
   no retry, no error surfaced.** Contrast the 429 path, which backs off + grows
   the throttle; the soft-empty path has zero protection.

Net: any transient provider hiccup during a multi-hour scan silently zeroes a chunk
of leads and marks them done forever. Same null outcome as a stall, harder to detect
(it "completes").

## What was shipped (FINAL — supersedes the pause idea below)
First attempt (commits `b9edc91`/`714e262`/`8408587`) PAUSED the whole scan on a
zero-raw streak (roll back + resumable). **That was a throughput regression** — the
original scan, on an empty stretch, marks those leads done and KEEPS FLOWING to the
next leads (that's how it pulled 1031 leads / 2388 posts on 2026-06-15). Pausing
stalled it at ~20 leads, re-trying the same rate-limited leads forever. Samarth
flagged it ("you broke a working system, make it work like before WITH the
improvements, no extra cost"). Reverted.

**FINAL (`acaf33a`): restore the original flow-through verbatim; add ONLY non-blocking
visibility.** Net diff vs pre-session `7d8568c` is purely additive:
- Mark zero-post leads done and keep flowing — identical throughput + cost to before.
- When a zero-RAW-post streak (`>= RATE_LIMIT_STREAK_HINT`, env `LINKEDIN_EMPTY_STREAK_LIMIT`,
  default 3) indicates soft-rate-limiting, RECORD the lead ids in `rate_limited_lead_ids`
  on progress. NO pause, NO slow-down, NO re-fetch.
- Completion log surfaces the count + how to recover: targeted re-scan via
  `{action:"scan", leadIds: rate_limited_lead_ids}` — paid only if/when desired.
- Verified: fresh run flowed 77 leads/tick (time-budget pause, not a stall), 1022 raw
  posts, no flags — matches original behaviour.

**Lesson:** for a scan whose provider intermittently rate-limits, NEVER pause the whole
scan on a transient empty stretch — flow through it (the provider serves the next leads
/ refills as you go). Make data-loss VISIBLE/recoverable, don't trade it for a stall.
Also: heavy diagnostic test_profile calls + repeated restarts drain the shared RapidAPI
rate budget — that made throughput look far worse mid-debug than a clean run does.

## Operational note
- Verified via `test_profile` action (route.js ~1812) — accepts `{username}`,
  `{urn}`, or `{baseId, leadId}`. The `{baseId, leadId}` form replicates the scan's
  exact URN path; the `{username}` form uses the profile endpoint directly and
  failed for hashed slugs (e.g. `mayur-sankhe-22b91414`) even when the lead has a
  valid cached URN — so test by leadId, not username, to mirror the scan.
- URNs got cached onto the lead records during this run (good — a re-run skips the
  profile-fetch step). `clear_progress` before re-running so the 100 false-zeroed
  leads are re-attempted.
