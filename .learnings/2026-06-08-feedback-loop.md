# 2026-06-08 — Closed feedback loop (backend: storage + injection)

## What
Made operator feedback actually improve future AI drafts. The old chatbot
"feedback" button only prefilled the chat box; nothing read it at draft time.
New: durable feedback storage + injection of recent feedback into generation.

## Changes (news-material / SignalScope)
- **NEW `POST /api/sidekick/feedback`** — Bearer SIDEKICK_API_KEY (authOk copied
  from chat-log). Body `{ baseId, item_type, quoted_span, feedback_text,
  lead_name?, lead_company? }`. Normalizes dm1/dm2/dm3 → `dm`; valid types are
  `comment | connection_note | dm`. Writes one row to a DEDICATED
  `Sidekick Feedback` table. Returns `{ ok, id, createdAt }`.
- **NEW `GET /api/sidekick/preferences?baseId=&item_type=&limit=15`** — Bearer.
  Returns `{ ok, count, prefs:[{quoted_span, feedback_text, lead_name?,
  created_at}] }`, most-recent-first (Airtable sort on Created At desc). Exports
  a reusable `fetchPreferences(baseId, itemType, limit)` that NEVER throws
  (returns [] on any failure) so generation degrades gracefully.
- **setup-fix:** added `Sidekick Feedback` to `CAMPAIGN_TABLES` (Name primary +
  Item Type singleSelect + Quoted Span + Feedback Text + Lead Name + Lead
  Company + Created At dateTime).
- **auto-batch/generate injection:** before generating, fetches recent
  `connection_note` + `dm` prefs and injects bounded OPERATOR FEEDBACK blocks
  (~1500 chars each) into the per-lead user prompt — connection_note prefs steer
  the connectionNote field, dm prefs steer dm1/2/3.

## Storage decision + degrade behavior
DEDICATED `Sidekick Feedback` table, NOT the `Sidekick Chat` table. The chat
orchestrator's history read (/api/sidekick/chat-history) reads ONLY Sidekick
Chat, so feedback rows can NEVER pollute chat context — structural, not filtered.
If the table/fields are missing, POST degrades to `{ ok:false, needsSetup:true }`
(412), never a hard 500; GET / fetchPreferences return empty prefs so generation
still works.

## Internal-vs-public
Feedback notes are STYLE guidance only. The auto-batch prompt's PUBLIC FACTS vs
INTERNAL CONTEXT split + banned-phrase list still bind, so prefs can never
reintroduce scores / rule names into public copy.

## Build
`./node_modules/.bin/next build` → ✓ Compiled successfully, 19/19 static pages
(after `npm install`; NOT `npx next build` — that pulls Next 16 and fails).
First run hit a transient `.nft.json` ENOENT in trace collection; `rm -rf .next`
+ rebuild = clean.

## Prevention
- Feedback MUST stay in its own table. If a future agent "consolidates" it into
  Sidekick Chat, chat context gets polluted with feedback rows.
- New AI prompt that injects prefs: keep the bounded char cap + keep the
  internal-vs-public split above the injected block.
