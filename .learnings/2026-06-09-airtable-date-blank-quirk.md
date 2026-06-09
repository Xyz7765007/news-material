# 2026-06-09 — Airtable `{Date} != BLANK()` is TRUE for empty date cells

## What broke
The LinkedIn-post freshness gate (same-day) used `{Post Date} != BLANK()` to mean
"a post date is present". In production this matched rows whose Post Date was EMPTY.
Because `Post Date` was a brand-new field, ~100 fresh `linkedin_engagement` tasks
(created the day before, blank Post Date) got treated as "has a post date", then
`NOT(IS_AFTER(blank, now-7d))` evaluated true, so the gate EXCLUDED them from the
Sidekick feed + count. The archive sweep's dryRun likewise flagged all 100 for
archival — running it for real would have stamped `Archived At` on 100 live tasks.

## Root cause
Airtable's `{Field} != BLANK()` does NOT reliably mean "non-empty" for date fields.
An empty date cell satisfies `!= BLANK()`. Verified live via `/api/airtable` list:
- `FALSE()` → 0 rows (filters ARE applied).
- `AND(..., {Post Date} != BLANK())` → returned rows with `Post Date = null`.  ← bug
- `AND(..., NOT({Post Date} = BLANK()))` → 0 rows (correct: no real post dates yet).
- bare `AND(..., {Post Date})` → 0 rows (also correct).

## Fix
Replaced `{Post Date} != BLANK()` with `NOT({Post Date} = BLANK())` in all three
filters that gate on post age:
- `app/api/sidekick/feed/route.js` (POST_DATE_GATE)
- `app/api/sidekick/count/route.js` (POST_DATE_GATE, mirror)
- `app/api/sidekick/archive-aged-posts/route.js` (AGED_FILTER)
The `NOT(IS_AFTER(...))` age comparison was correct and unchanged.

## Prevention
For "is this date field set?" in an Airtable `filterByFormula`, use
`NOT({Field} = BLANK())` or the bare-truthy `{Field}` — NEVER `{Field} != BLANK()`.
Validate emptiness filters against REAL data (a row known to be blank) before
trusting them; a logically-correct-looking formula can still be wrong on Airtable's
type coercion. QA of a freshness gate must check that blank-keyed rows still SHOW,
not just that a seeded old/new pair behaves.
