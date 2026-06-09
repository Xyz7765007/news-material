# 2026-06-09 — LinkedIn POST freshness gate (linkedin_engagement)

## What broke
linkedin_engagement tasks aged out by the wrong clock. The feed/count filter's
7-day window keyed off {Created} (scan time), but a post is 1-6 days old WHEN
fetched and ages daily — a post fetched at 6d becomes 8d two days later yet still
had a recent {Created}, so it kept showing in the chatbot feed.

## Root cause
The underlying post's TRUE publish date was never persisted on the task. The
linkedin-posts writer set Date=todayStr, Created=now — both scan timestamps. The
provider DOES return the post date (carried as `sp.post.date`), it just wasn't
written. No field to gate on = no real freshness signal.

## Fix
- setup-fix CAMPAIGN_TABLES: added Tasks `Post Date` (date) + `Archived At`
  (dateTime); added `aged_out` choice to Signal Archive `Signal Status`.
- linkedin-posts writer: persist `Post Date` from `sp.post.date` (fallback today).
- feed + count filters: exclude linkedin_engagement where {Post Date} is set AND
  >7d old, and exclude any task with {Archived At} set. Blank {Post Date} falls
  back to the legacy {Created} window (no regression). Read-side guard = ZERO leak
  window even before any sweep runs. Both routes fall back to the legacy filter on
  UNKNOWN_FIELD_NAME so un-migrated bases keep serving until setup-fix runs.
- NEW POST /api/sidekick/archive-aged-posts (Bearer SIDEKICK_API_KEY or
  ?key=CRON_SECRET): stamps {Archived At} (NOT Handled At — analytics stay clean)
  on aged-out tasks and copies each into Signal Archive (Signal Status=aged_out)
  so they surface in the in-app Signal Review tab. Tasks never deleted.

## Prevention
- POST-DATED time-sensitivity goes on {Post Date}; SCAN-time goes on {Created}.
- Archiving uses {Archived At}, never {Handled At} (operator-handled).
- SCHEMA MIGRATION: setup-fix MUST run post-deploy on each campaign base to add
  Post Date / Archived At / aged_out. Until then: legacy fallback keeps feed live;
  archive sweep no-ops with needsSetup. Build: `npm install` then
  `./node_modules/.bin/next build` (NOT npx) → ✓ Compiled successfully, 19/19.
