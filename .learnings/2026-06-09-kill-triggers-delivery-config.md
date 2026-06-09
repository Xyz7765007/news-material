# 2026-06-09 — Kill Triggers tab + per-connector Delivery config

## What
Kunal #4: fold "Triggers" into signal/delivery, stop exposing it as its own nav
concept. Kunal #17: each connector gets a Delivery config (destination + frequency)
to realize Connectors → events → Delivery → Tasks. Frontend-only (SignalScope.jsx).

## Root / context
The Triggers tab was a separate named surface (`TriggersTab`) showing the unified
Unipile/GA/LinkedIn-posts event feed + master-base account routing. Connectors had
no per-connector delivery target — everything implicitly landed as Tasks.

## Fix (components/SignalScope.jsx — LABELS/NAV/CONFIG only, non-breaking)
- #4: removed `{id:"triggers",...}` nav entry, the `tab==="triggers"` render block,
  `"triggers"` from `ADMIN_ONLY_TABS`, and the whole `TriggersTab` function
  (~507 lines). Default tab is "dashboard" so nothing is stranded. The underlying
  `/api/unipile-triggers` + `/api/unipile-setup-webhooks` routes are UNTOUCHED — only
  the UI tab is gone. (What the block held: a read-only event feed + per-account
  campaign routing UI; the routing data is reachable via the API if ever re-exposed.)
- #17: RuleEditor — new shared "📬 DELIVERY" section (all connector types) with
  Destination select (Sidekick app/Slack/Email/Teams/Google Sheet/Salesforce task)
  + Frequency select (Real-time/Daily digest/Weekly digest). Persisted on the Task
  Rule as `Delivery Destination` / `Delivery Frequency` (plain singleLineText, written
  via existing typecast save path — no schema mutation). Defaults "Sidekick app" /
  "Real-time" applied in saveRule for ALL branches + on every Configure entry point.
  New `deliveryBadge(f)` renders a `📬 Slack · weekly`-style chip on both uniform
  connector card types next to type/target/count.

## Prevention / deferred
- DEFERRED (follow-on): actual destination ROUTING/sending to Slack/Email/Teams/
  Sheet/Salesforce is NOT wired. Config capture only — events still land as Tasks in
  the Sidekick app regardless of selection. A non-default destination shows an inline
  "not wired yet" note in the editor.
- No "signal" wording introduced (used "events"/"connector"). No Airtable field
  renames. Build: `npm install` then `./node_modules/.bin/next build` → ✓ Compiled.
