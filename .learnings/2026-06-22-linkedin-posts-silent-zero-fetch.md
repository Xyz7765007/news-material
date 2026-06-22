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

## Recommended fix (needs Samarth ship-it — not yet built)
Mirror the AI-outage guard pattern already in `scan-run`:
- Track consecutive leads with `rawReturnedCount === 0`. If it crosses a threshold
  (e.g. 8–10 in a row), treat as **provider degradation**: set `status:"error"` +
  message and PAUSE (do not mark the streak's leads done), so Resume retries them
  when the provider recovers — instead of blazing through all 4973 recording zeros.
- Optionally: in `rapidCall`, detect soft-failure 200 bodies (`success===false`,
  `data==null`, message contains "denied"/"rate") and return `{ok:false}` so the
  existing retry/backoff kicks in and the lead logs a real error rather than a zero.
- Do NOT permanently mark a lead done on a 0-raw-posts result during a degraded
  streak.

## Operational note
- Verified via `test_profile` action (route.js ~1812) — accepts `{username}`,
  `{urn}`, or `{baseId, leadId}`. The `{baseId, leadId}` form replicates the scan's
  exact URN path; the `{username}` form uses the profile endpoint directly and
  failed for hashed slugs (e.g. `mayur-sankhe-22b91414`) even when the lead has a
  valid cached URN — so test by leadId, not username, to mirror the scan.
- URNs got cached onto the lead records during this run (good — a re-run skips the
  profile-fetch step). `clear_progress` before re-running so the 100 false-zeroed
  leads are re-attempted.
