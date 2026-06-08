# 2026-06-08 — Closed feedback loop (backend)

## What
Operator feedback now improves future AI drafts. Old "feedback" only prefilled
chat; nothing read it at draft time. New: durable storage + prompt injection.

## Changes (SignalScope)
- NEW `POST /api/sidekick/feedback` (Bearer SIDEKICK_API_KEY). Body `{ baseId,
  item_type, quoted_span, feedback_text, lead_name?, lead_company? }`. dm1/2/3 →
  `dm`; valid `comment|connection_note|dm`. Writes ONE row to DEDICATED
  `Sidekick Feedback` table. Returns `{ ok, id, createdAt }`.
- NEW `GET /api/sidekick/preferences?baseId=&item_type=&limit=15` (Bearer) →
  `{ ok, count, prefs[] }` most-recent-first. Exports `fetchPreferences()`
  (imported by auto-batch/generate) that NEVER throws — [] on any failure.
- setup-fix: added `Sidekick Feedback` table schema.
- auto-batch/generate: fetches connection_note + dm prefs ONCE per batch, injects
  bounded (~1500 char) OPERATOR FEEDBACK blocks into the per-lead prompt
  (connection_note → note; dm → dm1/2/3). Best-effort; never breaks generation.

## Storage + degrade
DEDICATED table, NOT `Sidekick Chat` (which the orchestrator reads back) — so
feedback can NEVER pollute chat context (structural). Missing table/fields →
POST `{ ok:false, needsSetup:true }` (412), never 500; GET returns empty prefs.

## Internal-vs-public
Prefs are STYLE guidance only; the PUBLIC/INTERNAL split + banned-phrase list
still bind, so prefs can't reintroduce scores/rule names.

## Build / prevention
`npm install` then `./node_modules/.bin/next build` (NOT npx) → ✓ 19/19 pages.
Keep feedback in its own table forever; keep the char cap + internal/public split
above any pref-injecting block.

## Review fixes (2026-06-08)
- preferences/route.js input validation: `item_type` from the query string was
  interpolated raw into the Airtable `filterByFormula`. Added a `normalizeItemType`
  (mirrors feedback/route.js: dm1/2/3 → dm) + whitelist check in BOTH the GET
  handler and `fetchPreferences`. Invalid/unknown type → `{ ok:true, prefs:[],
  count:0 }` (empty, not an error, so generation never breaks). Also strip `"`
  from the value before the formula (belt-and-suspenders). Internal in-process
  caller (auto-batch) passes fixed literals — all normalize to themselves, unchanged.
- Build re-verified clean (`./node_modules/.bin/next build`, exit 0, 19 routes).
