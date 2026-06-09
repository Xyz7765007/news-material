# 2026-06-09 — Batch-2 manual-with-assist LinkedIn outreach (backend)

## What
Kunal #18/#19: exec drives LinkedIn outreach by HAND with the chatbot handing
them copy + recording state. NO Unipile auto-send. Backend-only here.

## Root / context
The existing outreach flow assumes Unipile sends connections/DMs on a cron.
Manual-assist needs Airtable-only state transitions the exec triggers, plus a
feed of "what's the next manual move per in-flight lead".

## Fix
- `app/api/outreach/route.js`:
  - NEW `record_manual_connection_sent` {baseId, outreachItemIds[]} → Status=
    connection_sent, Connection Sent At=now, append Notes. No Unipile.
  - NEW `record_manual_dm_sent` {baseId, outreachItemId, step∈1..3} → DM Step=step,
    Status=dm_1/dm_2/completed, Last DM Sent At=now, Next Action Date= step1→+4d /
    step2→+5d / step3→"". Reads existing Notes (filterByFormula RECORD_ID()) to append.
  - EXTENDED `mark_connected` to also set Next Action Date = now+2d (DM1 due 2d
    after acceptance). Existing behavior (Status=connected, Connection Accepted At)
    kept.
  - **CRITICAL (review fix):** all three actions also set `Mode: "manual"`. This is
    what actually guarantees "no auto-send": `process_queue` (the 4-hourly cron) only
    SKIPS records where `Mode === "manual"` and otherwise auto-sends via Unipile on
    exactly the statuses this flow writes (queued/connection_sent/connected/dm_*).
    Writing the status WITHOUT Mode=manual would have let the cron auto-send leads the
    exec is handling by hand. Entry point `auto-batch/action` (send_one/send_all) also
    now sets Mode=manual on approval, so an approved lead enters the manual flow and
    the cron leaves it alone.
- `app/api/sidekick/auto-batch/pending/route.js`: now lists ALL Outreach (paged,
  no sort dependency), still returns `batches` (pending_approval only — unchanged
  shape) PLUS additive `outreach_queue[]`: each in-flight record annotated with a
  computed `nextAction` (connection / accept / dm step N / waiting) so the chatbot
  renders without business logic. messageToCopy comes ONLY from Generated
  Connection Note / Generated DM N (never summary/signal/score_reason).
  **Review fix:** the queue is gated to `Mode === "manual"` records only (auto/auto_batch
  are cron-driven — surfacing them as manual cards would double-send), and
  pending_approval is excluded from the queue (belongs only in `batches`).

## Prevention
- Due check uses `!d || d.slice(0,10) <= today` (ISO lexical) — sidesteps the
  Airtable `{Date} != BLANK()` quirk (see 2026-06-09-airtable-date-blank-quirk).
- DEFERRED (Kunal #20/#22): NO Unipile webhook auto-accept, NO auto-send cron.
- Build: `npm install` then `./node_modules/.bin/next build` → exit 0.
