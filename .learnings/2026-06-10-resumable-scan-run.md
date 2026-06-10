# 2026-06-10 — /api/scan-run: resumable news+jobs orchestrator (commit 1b6b9fd)

## Standing rule (Samarth)

**Wherever the Vercel 300s timeout is a bottleneck, use the LinkedIn-posts
resume pattern** — progress state + time-budgeted ticks + resume (CTA or cron)
— never a bigger function. This file documents the second implementation of
that pattern; `/api/linkedin-posts` is the original.

## Shape of the pattern (copy this next time)

1. **State**: one JSON field on the master Campaigns row (here: `Signal Scan
   Status`, auto-created via the `atUpdateWithAutoCreate` helper). Holds
   status/phase/cursors/totals/failures. Cap unbounded arrays before writing
   (Airtable multilineText limit ≈100KB).
2. **Tick**: each invocation works until a budget (240s here, under
   maxDuration 300) leaves < MIN_RUNWAY for another unit of work, then saves
   the cursor and returns progress.
3. **Resume**: `{action:"resume"}` or cron `?mode=resume&key=<CRON_SECRET>`
   (keyless body optional — the cron form finds the first campaign with a
   running state). ANY driver can continue: GH Actions, cron-job.org, a UI
   button, a human with curl. Driver death loses nothing.
4. **Concurrency guard**: refuse `start` if state is running with a fresh
   `updated_at` (<60s) unless `force:true`.
5. **Loud failure**: AI outage (3 consecutive accounts where every rule's
   scoring call failed → `status:"error"` + message) instead of silently
   completing with zero tasks.

## scan-run specifics

- Phases: `news` (one self-fetched `/api/scan` call per account, sequential —
  keeps the Google decode pacing happy and gives EACH account its own fresh
  300s budget) → `jobs` (jobs-batch per 5 accounts) → `done`.
- Writes server-side: matched → Tasks, retain band → Signal Archive, both
  deduped on Company|Rule|URL fingerprints refetched each tick (state stays
  small; no fingerprint bloat).
- `/api/scan` itself UNTOUCHED — isolation by self-fetch, same convention as
  company-posts/role-check.
- `scripts/wednesday-scan.py` is now a thin driver: AI probe → start →
  resume-loop → LinkedIn phase. The GH runner is no longer a single point of
  failure for the scan itself.

## Gotchas hit

- `atCreateBatch` posts to Airtable REST directly → records need the
  `{fields:{...}}` wrapper. The `/api/airtable` action:"create" path is the
  opposite (FLAT records). Mixing these up silently writes nothing.
- Self-fetch origin comes from `new URL(request.url).origin` — correct on
  Vercel deployments.
