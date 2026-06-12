# 2026-06-12 — LinkedIn connectors + DMs OFF, env-flag kill-switch (Kunal Jun-12 #10)

## What changed
Kunal: turn LinkedIn connectors + LinkedIn DMs OFF until he supplies the proper
prompt space — and make on/off an easy lever, not a code change each time.

## Root / context
No global kill-switch existed. The existing env-flag convention
(`ROLE_GATE_ENABLED`, `NEUTRAL_PROMPT_ENABLED`) was the lowest-friction pattern,
so I reused it instead of inventing an admin UI / Airtable field.

## Fix
New `lib/connector-flags.js` — two flags, DEFAULT OFF (enabled only when the env
var === "true"), plus a shared `connectorDisabledResponse(family)` 403 payload:
- `LINKEDIN_CONNECTORS_ENABLED` → gates `/api/linkedin-posts` `scan` (POST) +
  the cron-resume `GET`. Read-only/`stop_scan`/cleanup stay live.
- `LINKEDIN_DMS_ENABLED` → gates the SEND/QUEUE actions in `/api/outreach`
  (`enqueue_leads`, `send_invitation`, `send_message`, `send_connection_with_note`,
  `quick_send_connection`, `send_manual_connections`, `trigger_manual_dms`,
  `process_queue`). The 4-hourly outreach cron routes its sends back through
  `process_queue`, so this one gate also stops the cron. Also gates
  `/api/sidekick/auto-batch/generate` (chatbot DM generator). Read-only/diagnostic
  /reply-tracking outreach actions stay live.

## How Kunal flips it (per family)
Vercel (news-material) → Settings → Env Vars → set `LINKEDIN_DMS_ENABLED=true`
and/or `LINKEDIN_CONNECTORS_ENABLED=true` → redeploy (env applies next deploy
only). Delete/anything-not-"true" = OFF. Both are currently UNSET = OFF.

## Prevention
- Gate the SEND path, not the UI — the cron re-enters `/api/outreach`, so one
  server gate covers manual + cron without touching the scheduler.
- New connector families: add a flag here, not a bespoke gate per route.
- Chatbot (sidekick-chat, separate repo) gets a 403 `{disabled:true}` from
  auto-batch generate while OFF — verify it surfaces this gracefully post-deploy.
