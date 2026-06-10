# CLAUDE.md — SignalScope

This file is read by Claude Code when working in this repo. It is authoritative — if anything here contradicts the actual code, the code is right and this file is stale (fix this file).

---

## 1. What this is

SignalScope is the operating system for **Side Kick** — a Mumbai-based B2B outbound infrastructure company. SignalScope is where:

- Each client gets a **campaign** (their own Airtable base, their own Task Rules, their own outreach config)
- Signals are detected (news, LinkedIn job posts, LinkedIn engagement, Google Analytics, lead movement, HubSpot post-demo deal stages)
- Signals are scored against per-campaign AI prompts
- High-scoring signals become **Tasks** (one signal × one lead = one task)
- Tasks become outreach (LinkedIn via Unipile, email via Smartlead)

Owner: Samarth. Samarth owns and manages everything — all code, review, approval, and deployment go through Samarth alone. No other people are involved.

## 2. Tech stack (verified from `package.json`)

| Layer | Choice |
|---|---|
| Framework | **Next.js 14.2.15** (App Router) |
| Language | **JavaScript** — no TypeScript anywhere |
| UI | **React 18.3.1** + **Tailwind 3.4.13** + inline styles in the big component |
| AI SDKs | `openai ^4.68.0`, `@anthropic-ai/sdk ^0.32.1` |
| Auth helpers | `google-auth-library ^9.15.1` (GA OAuth) |
| Data | **Airtable** — every table. No Postgres, no Redis, no Supabase. |
| Hosting | **Vercel** (Hobby plan + Fluid Compute → 300s function max) |

There is no Prisma, no ORM, no migration tooling. All Airtable access goes through `lib/`-level helpers + direct REST calls in route handlers. Schema changes happen via `/api/setup-fix` (auto-creates missing tables/fields).

## 3. Repo layout

```
signalscope/
├── app/
│   ├── api/                       # 50 route handlers (see §6)
│   ├── client/[id]/page.js        # Per-campaign read-only client portal
│   ├── page.js                    # Admin gate → mounts SignalScope
│   ├── layout.js                  # Minimal root layout
│   └── globals.css
├── components/
│   ├── SignalScope.jsx            # 8977 lines — the whole SPA in one file
│   └── LeadMovementScanModal.jsx  # ~20K, movement scan UI
├── lib/                           # 11 pure-helper modules (see §7)
├── scripts/run-overnight.sh
├── outreach-cron.github-actions.yml  # Master copy of the GH Actions workflow
├── OVERNIGHT_SCAN_SETUP.md           # LinkedIn posts scan cron setup, Apr 2026
├── README.md                          # OUT OF DATE — references gpt-4o + earlier app
├── vercel.json                        # Vercel cron config — MISLEADING, see §10
├── next.config.js
└── package.json
```

Do not trust `README.md` — it describes a much earlier single-CSV tool. This file is authoritative.

## 4. Multi-campaign architecture (the mental model)

Two layers of Airtable bases:

**Master base** (env: `AIRTABLE_BASE_ID`). Holds the `Campaigns` table — one row per client. Each row's fields:
- Campaign name, emoji, description
- `Features` — comma-separated flags: `news`, `job_posts`, `top_x`, `linkedin_outreach`
- `Airtable Base ID` — the per-client base
- `HubSpot API Key` — per-campaign HubSpot key stored HERE (not in env)
- AI usage counters, scan progress fields, last-scan-status
- Also contains `Movement Scan Runs`, `Sidekick Chat`, `Cron Run Log`, `AI Reviews` master tables

**Per-campaign base** (each row's `Airtable Base ID`). Holds:
- `Accounts` — target companies
- `Leads` — contacts (LinkedIn URL, email, phone, GA scores)
- `Task Rules` — signal definitions per campaign
- `Prompts` — scoring prompts
- `Tasks` — the output: scored signals waiting to be actioned (chatbot's feed reads this)
- `Outreach` — LinkedIn outreach queue (mutated by sends + replies)

The `DEFAULT_CAMPAIGNS` constant in `SignalScope.jsx` ships two preset campaigns:
```js
{ id:"material", features:["news","job_posts"] }
{ id:"veloka",   features:["top_x"] }
```

Active features expand dynamically based on actual Task Rules in the campaign's base — see `SignalScope.jsx` line 211-215. So Veloka shows the LinkedIn Automation tab once a `linkedin_outreach` Task Rule is created in its base, even though the preset only enables `top_x`.

**Client portal:** `/client/[campaignId]` mounts `SignalScope.jsx` with `clientMode={true}` + `fixedCampaignId={id}`. Read-only, separate per-campaign password.

## 5. UI tabs — connector-first sidebar (revamped 2026-06-10)

The sidebar is **named, grouped sections** (no longer a flat tab list). Order:

- **(top)** Dashboard
- **DATA** — Accounts, Leads
- **CONNECTORS** *(+ button → connector picker)* — one item per connector **TYPE**
  present (`📰 News`, `📋 Job Posts`, `📣 Company Posts`, `🎯 Top X`, `💬 Outreach`),
  plus scanner connectors once they have tasks (`📝 LinkedIn Posts`, `🔁 Lead
  Movement`), then `⚙️ All connectors`. Clicking a type opens a uniform per-type
  page (`tab==="connector_detail"`, keyed on `selectedConnectorType`): that type's
  rules (Configure/Run/Dup/Delete) + their combined tasks with date/score/search
  filters, capped to a 60-task preview with a "View all in Tasks" jump.
- **TASKS** — Tasks, 🔎 Signal Review
- **INTEGRATIONS** — LinkedIn Posts Scanner, LinkedIn Automation, Email Campaign,
  HubSpot, Google Analytics, Post-Demo Auto
- **SETTINGS** — Prompts, Scoring threshold, Coming Soon

Mental model = Kunal's **Connectors → Tasks → Actions** (Jun-8 call). Connectors
are grouped by TYPE, never per individual rule (Material has 20 rules → that was
the clutter). Scanner-driven types (`linkedin_engagement`, `lead_movement`) have no
Task Rule; their per-type page shows a run/info card instead of rule cards. The
word `signal` was dropped from labels per Kunal, but **Signal Review keeps its
name** (Samarth's call). All admin-only items are filtered out in `clientMode`;
the client portal still shows only Dashboard / Accounts / Leads / Tasks.

Sidebar also shows the campaign's Airtable base ID and a "Change" button (campaign
switcher). `Test` / `Setup` buttons at the bottom hit setup-diagnostic / setup-fix.
See `.learnings/2026-06-10-connector-first-revamp.md` for the full revamp record.

## 6. API routes (all 50, grouped)

### Auth & setup
- `POST /api/admin-auth` — Login + token verify (HMAC-signed token in sessionStorage). Only `/` is gated.
- `POST /api/setup-fix` — Auto-creates missing tables/fields. Run via `?key=<CRON_SECRET>`. CANNOT change existing field types.
- `POST /api/setup-diagnostic` — Reports schema gaps; precursor to setup-fix.

### Core scan + classify
- `POST /api/scan` — News scanning (Google News RSS → AI classify). Has `NEUTRAL_PROMPT_ENABLED` + `NEUTRAL_PROMPT_CAMPAIGN_IDS` feature flag for campaigns that want clean user prompts without the default 5-band calibration prefix.
- `POST /api/scan-leads` — Lead Movement scan (RapidAPI Fresh LinkedIn Profile Data). Modes: `preview` (cost estimate) / `scan` (chunked, 200/batch). Writes Tasks with `Task Type: "lead_movement"` and `Movement Type: Hired|Promoted|Exited`. Has auto-heal: drops missing schema fields from Tasks payload and retries (loop cap 8).
- `POST /api/scan-leads-probe` — Diagnostic for scan endpoint
- `POST /api/classify` — AI classification helper (used by /scan, also exposes `generate_scoring_prompt` action)
- `POST /api/linkedin-posts` — LinkedIn engagement scan. RapidAPI provider. Designed for resume (each invocation processes ~22 leads in 5min; cron-job.org chains them every minute).

### Airtable (the kitchen sink — **2287 lines**)
- `POST /api/airtable` — Big switch on `action`. Handles list/create/update/delete + `run_topx`, `run_topx_smart`, `setup`, `diagnose`, `get_campaign`, `save_assigned_account`, `validate_client` (client portal password), `reset_ai_usage`, etc. Has `applyExcludeKeys()` helper for pre-scoring dedup in Top X flows.

### Outreach (Unipile / LinkedIn) — **2460 lines**
- `POST /api/outreach` — Big switch on `action`. `enqueue_leads`, `send_manual_connections`, `mark_connected`, `trigger_manual_dms`, `check_replies`, `list_queue`, `preview_connection_note`, `preview_batch`. Talks to Unipile for actual sends. **Has retry on Airtable read-after-write staleness** (May 29 fix).
- `GET /api/cron/outreach` — 4-hourly cron processor. Iterates campaigns, loads Task Rules, runs `process_queue` per `linkedin_outreach` rule. Logs to `Cron Run Log` in master base. Auth: `Authorization: Bearer <CRON_SECRET>`.
- `GET /api/cron/outreach/status` — Last-run summary (powers UI's "Cron: healthy" pill)
- `POST /api/export/outreach` — CSV export. Auth: `?key=<EXPORT_API_KEY>`.
- `POST /api/unipile-triggers` — CRUD for Unipile triggers
- `POST /api/unipile-setup-webhooks` — One-shot admin webhook bootstrap (`?key=<CRON_SECRET>`)
- `GET /api/unipile-health` — Unipile account health check
- `POST /api/resolve-linkedin` — Resolves LinkedIn company slugs → numeric IDs via Apify

### Email
- `POST /api/email-campaign` — Smartlead-driven email sequence generation. **Only place that uses Anthropic** (`claude-sonnet-4-6` — line 189). Per-campaign Smartlead API keys stored in `Campaigns` table.

### HubSpot
- `POST /api/hubspot` — API key store/retrieve in master `Campaigns` table. CRM sync.
- `POST /api/post-demo` — **Half-built post-demo automation.** HubSpot deal stages → contact timeline → conversion patterns from won deals → AI generates 1-3 SDR Tasks per contact. Currently outputs *task recommendations*, not autonomous emails.

### Google Analytics
- `POST /api/ga` — GA Data API queries (per-lead engagement scoring)
- `GET /api/ga/oauth/callback` — OAuth handshake

### Lead enrichment
- `POST /api/enrich` — Apollo people enrichment (phone + match)
- `POST /api/sidekick/enrich-phone` — Apollo phone enrichment for a single lead

### Debug
- `POST /api/debug-campaigns`, `/api/debug/article-fetch`, `/api/debug/jobs`, `/api/debug/jobs-prefilter`

### Sidekick chatbot backend (chatbot is a separate repo; these are the endpoints it calls)
All authenticated with `Authorization: Bearer <SIDEKICK_API_KEY>`.

- `GET  /api/sidekick/feed` — Pending Tasks for chatbot card stack. Filter: `Handled At = BLANK()` AND `LinkedIn URL != BLANK()` AND (not a time-sensitive type OR `Created` within last 7 days)
- `GET  /api/sidekick/count` — Pending count (badge)
- `POST /api/sidekick/action` — Stamps Task as handled (`done` or `skip`)
- `POST /api/sidekick/scan` — Triggers scan from chatbot
- `POST /api/sidekick/auto-batch/generate` — Generates 5-lead batch with AI-personalized connection + 3 DMs. Movement-priority via `composite-score`. Writes Outreach records with `Status: pending_approval`. Auto-creates rule `"Sidekick Auto-Batch v1"` if absent. Uses `gpt-5.4-mini`. **Critical:** uses `max_completion_tokens` (NOT `max_tokens`) — `gpt-5.4-mini` silently fails otherwise.
- `GET  /api/sidekick/auto-batch/pending` — Returns pending-approval items
- `POST /api/sidekick/auto-batch/action` — Approve / reject / edit batch item
- `POST /api/sidekick/auto-batch/reset` — Nukes pending-approval items only (does NOT touch Manual Outreach)
- `POST /api/sidekick/chat-log`, `GET /api/sidekick/chat-history` — Conversation history in `Sidekick Chat` table
- `POST /api/sidekick/diagnose-ai`, `GET /api/sidekick/messages-feed`, `POST /api/sidekick/message-action`
- `POST /api/sidekick/top-leads-to-call` — Top-priority leads for cold-call queue
- `POST /api/sidekick/movement-scan-start` / `-stop` / `-status` / `-tick` — Background movement scan (chunked, cron-tickable)
- `POST /api/sidekick/movement-rebuild-tasks` — Rebuilds movement Tasks from existing scan results
- `GET  /api/sidekick/movement-task-health?baseId=...&key=<CRON_SECRET>` — Diagnostic: schema gaps, visibility-to-chatbot, filter-out reasons, sample tasks (added May 29)

## 7. `lib/` helpers (11 pure modules)

- **`ai-usage.js`** — Per-campaign OpenAI/Anthropic spend tracking. Pricing table for `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.4-pro`, `gpt-5`, etc.
- **`company-match.js`** — Pure string normalization for company names. **No AI** (explicitly avoided — prevents hallucinated matches).
- **`composite-score.js`** — Lead ranking for chatbot auto-batch. Movement signals forced to top (Samarth's call May 16).
- **`constants.js`** — Scoring constants (`EASE_SCORE`, `STRENGTH_SCORE`), Task Rule source options
- **`google-news-decoder.js`** — Decodes obfuscated `news.google.com` URLs (v2 per-article fetch)
- **`lead-brief.js`** — Builds a structured `brief` from a Lead + relevant Tasks. **`briefToPromptBlock` is the key function** — splits data into PUBLIC FACTS (citable) and INTERNAL CONTEXT (DO NOT CITE), used by auto-batch and personalization
- **`lead-fields.js`** — Cross-campaign field lookup. Different campaigns use different field names ("Title" vs "Job Title" vs "Position")
- **`linkedin-fetch.js`** — Wraps "Fresh LinkedIn Profile Data" RapidAPI with stable normalized response
- **`message-merge.js`** — Centralized merge + sanitize. Strips markdown/quotes/code fences, detects AI refusals, runs merge-field safety pass. **Belt-and-suspenders layer for outreach output.**
- **`movement-detection.js`** — Classifies movement as Hired/Promoted/Exited
- **`rapidapi-usage.js`** — Mirror of `ai-usage.js` for RapidAPI calls

## 8. AI models (verified by grep across `app/api/` + `lib/`)

- **`gpt-5.4`** — `/api/classify` (5 call sites: classify, refine, insights, generate scoring prompt), `/api/airtable` Top X scoring, **`/api/scan` news+jobs scoring and `/api/linkedin-posts` post scoring (upgraded from mini 2026-06-10 — mini was handing 95s to board appointments and earnings recaps)**.
- **`gpt-5.4-mini`** — Default for the rest: `/api/sidekick/diagnose-ai`, `/api/sidekick/auto-batch/generate`, `/api/post-demo`, `/api/outreach` (3 sites — AI lead select + personalize message), `/api/airtable` (auto-create rule, lead enrichment), `/api/classify` dedup, `/api/company-posts`
- **`claude-sonnet-4-6`** — **Only** in `/api/email-campaign` (line 189). All email sequence drafting goes through Claude; everything else is OpenAI.

Costs tracked via `trackOpenAIUsage(campaignId, model, usage)` scattered across routes.

## 9. Authentication (5 layers)

1. **Admin gate** — `app/page.js` prompts for password → `/api/admin-auth` action `login` → HMAC-signed token (using `ADMIN_PASSWORD` as seed) → stored in `sessionStorage` under `ss_admin_token`. Password never reaches browser as known string.
2. **Client portal password** — Per-campaign, stored in Campaigns row. Validated via `/api/airtable` action `validate_client`.
3. **Sidekick API key** — `SIDEKICK_API_KEY` env var. Every `/api/sidekick/*` validates `Authorization: Bearer <key>`.
4. **Cron secret** — `CRON_SECRET` env var. Used for admin + cron endpoints (`setup-fix`, `cron/outreach`, `unipile-setup-webhooks`, `movement-task-health`) via `?key=` or `Authorization: Bearer`.
5. **Export key** — Separate `EXPORT_API_KEY` for CSV downloads.

## 10. Cron schedulers (THREE of them — operator confusion point)

1. **Vercel built-in cron** in `vercel.json`: `path: /api/cron/outreach, schedule: 0 6 * * *` (daily 06:00 UTC). **This is misleading.** The header comment in `app/api/cron/outreach/route.js` says the actual outreach cron is GitHub Actions. The Vercel entry was kept but its inaccuracy was a known confusion source. **TODO:** remove or correct.

2. **GitHub Actions workflow** — `outreach-cron.github-actions.yml` is the master copy in this repo; deployed to `.github/workflows/outreach-cron.yml`. Schedule: `0 */4 * * *` (every 4 hours UTC). Hits `https://news-material-eta.vercel.app/api/cron/outreach`. **NOTE the URL drift:** operator-facing URL is `news-material-two.vercel.app`, workflow hits `-eta`. Verify these alias the same Vercel project; if not, update workflow.

3. **External cron-job.org** — Manually configured for the LinkedIn Posts long-scan (`/api/linkedin-posts?mode=resume&key=<CRON_SECRET>`, every minute, ~50min wall time for 1055 leads). See `OVERNIGHT_SCAN_SETUP.md`.

## 11. External integrations

| Service | How auth | Notes |
|---|---|---|
| Airtable | `AIRTABLE_API_KEY` PAT | Master base ID in env; per-campaign in Airtable. PAT needs `schema.bases:write`. |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.4`, `gpt-5.4-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | Only `/api/email-campaign` |
| Unipile | `UNIPILE_API_KEY`, `UNIPILE_DSN` | Empty connection note → `message: undefined` → Unipile omits field (verified outreach/route.js:247) |
| HubSpot | Per-campaign keys IN AIRTABLE | Not env vars |
| Smartlead | Per-campaign keys IN AIRTABLE | Same pattern as HubSpot |
| Google Analytics | `GOOGLE_OAUTH_CLIENT_ID`/`_SECRET` | OAuth — per-campaign tokens stored in Airtable after handshake |
| RapidAPI | `RAPIDAPI_KEY` | Fresh LinkedIn Profile Data (movement); fresh-linkedin-scraper-api (posts) |
| Apify | `APIFY_TOKEN` (+ `_2`, `_3` rotation) | Two actors: `APIFY_ACTOR_ID` (jobs), `APIFY_COMPANY_ACTOR_ID` (slug resolver) |
| Apollo | `APOLLO_API_KEY` | People match + phone |

## 12. Environment variables (full list)

```
ADMIN_PASSWORD                 # Admin gate HMAC seed
AIRTABLE_API_KEY               # PAT with schema.bases:write + data scopes
AIRTABLE_BASE_ID               # Master base ID
ANTHROPIC_API_KEY              # email-campaign only
APIFY_ACTOR_ID                 # Job posts actor
APIFY_COMPANY_ACTOR_ID         # Company slug resolver actor
APIFY_JOBS_TPR                 # Job posts time-period-range
APIFY_TOKEN                    # Primary
APIFY_TOKEN_2                  # Rotation slot 2 (optional)
APIFY_TOKEN_3                  # Rotation slot 3 (optional)
APOLLO_API_KEY
CRON_SECRET                    # signalscope_7765007 in current deployment
EXPORT_API_KEY                 # CSV export auth
GOOGLE_OAUTH_CLIENT_ID         # GA OAuth
GOOGLE_OAUTH_CLIENT_SECRET
MAX_JOB_AGE_DAYS               # Job-post freshness cap
NEUTRAL_PROMPT_CAMPAIGN_IDS    # Campaigns opting out of default calibration prefix
NEUTRAL_PROMPT_ENABLED         # Feature flag
OPENAI_API_KEY
RAPIDAPI_KEY
SIDEKICK_API_KEY               # Chatbot → SignalScope auth
UNIPILE_API_KEY
UNIPILE_DSN                    # Regional endpoint
VERCEL_*                       # Auto-set by Vercel
```

## 13. Where we are right now (state, end of May 29 2026)

**Live in production at `https://news-material-two.vercel.app`:**

- All scan paths working: news (`/api/scan`), lead movement (`/api/scan-leads`), LinkedIn posts (`/api/linkedin-posts`)
- Top X Smart Compile with pre-scoring excludeKeys dedup
- LinkedIn Automation with Manual Mode (Manual Outreach modal)
- Post-Demo Auto (HubSpot stage triggered, outputs SDR tasks not autonomous emails)
- HubSpot + GA + Smartlead + Unipile + Apify integrations wired
- GitHub Actions cron driving outreach every 4h UTC
- Chatbot backend endpoints serving the separate chatbot repo

**Fixed in this session (May 26-29):**

- Top X Smart Compile client-side dedup — Layer 3 fuzzy match was killing Volopay's fresh top-N. Added `{ strict: true }` option to `isDuplicate`; Top X caller passes it.
- Manual Outreach "Send without a note" toggle (`skipConnectionNote` state). Server already handled empty notes correctly via `sendInvitation` line 247.
- Manual connection-request immediate send — was leaving records queued for cron pickup hours later instead of firing immediately. Root cause: Airtable read-after-write staleness between `enqueue_leads` → `list_queue`. Fix: `enqueueLeads` now returns `createdIds` + `createdRecords` directly; client skips the `list_queue` round-trip. Server `sendManualConnections` retries `atList` once after 1.5s if any requested IDs aren't visible. Diagnostic logging added to each per-record skip.
- `scan-leads` auto-heal propagated from rebuild endpoint to regular scan path. Both drop missing schema fields and retry; loop caps at 8.
- `/api/sidekick/movement-task-health` — new diagnostic endpoint.

**Pending / known issues:**

- `vercel.json` cron is misleading vs reality (GitHub Actions does the work). Remove or correct.
- URL drift: `news-material-two` (user) vs `news-material-eta` (workflow). Verify in Vercel project settings.
- Wire `classify site` at SignalScope.jsx line 7376 (in RuleEditor modal). Needs `campaignAirtableId` prop.
- Post-Demo Auto extension to autonomous email (~1-1.5 weeks incremental on top of existing module).
- README.md is stale — describes single-CSV `gpt-4o` tool. Should be deleted or rewritten.
- Scoring prompt drift — AI's own reasoning often contains hedges ("not earnings narrative", "gate failure noted", "no comparative data") while still scoring 70+. Reasonable fix: cap score when reasoning contains hedges.

## 14. Active clients (May 2026)

- **Material** — News + job-post signals against ~50 Forbes 2000 target accounts, ~10 senior marketing contacts/account (~500 leads). Target: senior marketing + creative leadership. Sweet spot: new CMO / CGO / VP Marketing. Job posts route to Ritesh. Jonathan's bar: signals must report the account's *own* marketing/brand/creative action — not product/data/governance roles even if senior; not inferred-from-sales-numbers marketing intensity.
- **Veloka** — Side Kick's internal AI-SDR brand. Multi-track: PM, TA, AI-SDR. Locked book May 12: 3,029 unique accounts, 4,413 leads.
- **Volopay** — Top X Smart Compile is primary use. 5000+ leads, 588 Top X tasks created late May.
- **Shipturtle** — 2,319 / 2,747 accounts crawl-classified. Manual Outreach active workflow.
- **Nutriventia** — Ashwanova microsite (separate repo), EDGE email campaign in Smartlead, ABM campaign planned (153 personalized landing pages for TurmXTRA).
- **Firebolt** — Cloud Next + SaaStr event sequences built (separate, not in SignalScope yet).
- **Tazapay**, **e6data** — long-standing clients.
- **Osome** — newest (May 22). Singapore. Two campaigns: C1 high-intent visitor recovery via de-anonymization; C2 Reddit social listening ($100/mo cap, 1-week post age, single Slack channel).
- **Cactus** — pending legal clearance.

## 15. Coding rules (surgical precision required)

These are conventions enforced across this codebase. Violating them produces bugs that have actually happened in production.

### File patterns
- **`SignalScope.jsx` is 8977 lines.** Use `grep -n` aggressively. Never try to load the whole file. The component contains every UI panel, modal, and state machine in one place.
- **`/api/airtable/route.js` is 2287 lines, `/api/outreach/route.js` is 2460 lines** — both use a single `action` switch with ~30 cases. Same pattern.
- **Every API route starts with `export const dynamic = "force-dynamic"; export const fetchCache = "force-no-store";`** — Vercel caches by default, this disables it. Required for cron + chatbot endpoints to see fresh Airtable data.

### Airtable patterns
- **Read-after-write is eventually consistent.** Code that creates records then reads them in the same request will sometimes see stale data. Either trust `atCreate`'s response records directly, or retry the list after a short delay (see `sendManualConnections` in `outreach/route.js` for the canonical retry pattern).
- **`typecast: true` on `atCreate` calls** — Airtable coerces field types instead of erroring (e.g. accepts a string for a number field). Belt-and-suspenders with the auto-heal.
- **Auto-heal pattern for `UNKNOWN_FIELD_NAME` 422s:** parse the missing field from Airtable's error message, drop it from the payload, retry. Loop cap 8. Used in `scan-leads`, `outreach`, `movement-rebuild-tasks`.
- **Don't add fields to existing tables programmatically.** Schema changes go through `setup-fix`. Manual field additions in Airtable UI are also fine.

### OpenAI patterns
- **`gpt-5.4-mini` requires `max_completion_tokens`, NOT `max_tokens`.** Using `max_tokens` silently caps the response → AI returns empty fields → every message falls back to deterministic template. This was the May 16 outage. All working calls use `max_completion_tokens`.
- **`response_format: { type: "json_object" }` for any JSON-returning prompt.** Combined with `Output ONLY valid JSON` in the system prompt.
- **Always pass `campaignId` to `trackOpenAIUsage`.** Per-campaign attribution requires it.

### Outreach patterns
- **`isDuplicate` in `SignalScope.jsx` has THREE layers:** exact fingerprint (Layer 1), URL+Company exact (Layer 2), fuzzy Company+Rule+60%-Signal-overlap (Layer 3). Layer 3 is correct for news scans but WRONG for Top X (multiple leads at one account legitimately share the same compiled match-reason). Top X callers pass `{ strict: true }` to skip Layer 3.
- **Empty connection notes are valid.** `sendInvitation` line 247 sends `message: message || undefined` → Unipile omits the field → invite sent with no note. Don't add empty-string validation.
- **`Mode` field on Outreach records:** chatbot's Auto-Batch = `"auto"`; Manual Outreach = `"manual"`. The `Sidekick Auto-Batch v1` rule is hardcoded by name in auto-batch generate — blocking manual enqueue against it is intentional.

### Prompt patterns (auto-batch generate, line 279-396)
- **PUBLIC FACTS vs INTERNAL CONTEXT split is load-bearing.** PUBLIC = citable. INTERNAL = "for your understanding only, never quote." Built by `briefToPromptBlock` in `lib/lead-brief.js`.
- **Hard-banned phrases list in the system prompt.** Real failure cases codified (the AI was actually quoting "67/100 ICP fit" back to leads before this list).
- **`sanitizeAndValidate` from `lib/message-merge.js` runs on every output.** Catches stray `{first_name}` leaks, markdown, AI refusals. Belt-and-suspenders.

### Tasks table schema
- Required fields: `Name`, `Company`, `Task Rule`, `Movement Type`, `Score`, `Score Reason`, `Scan Target`, `Signal`, `Source`, `Lead Title`, `LinkedIn URL`, `Email`, `Phone`, `URL`, `Task Type`, `Date`, `Created`, `Handled At`.
- Some campaigns historically missed `Movement Type`, `Lead Title`, `URL`, `Task Type`. Auto-heal handles new tasks; existing rows need `setup-fix` to add the columns.

### Sidekick endpoints
- **`Handled At` blank means pending.** Stamping with the current timestamp removes the task from the chatbot feed.
- **Movement tasks must be ≤7 days old to show in feed.** The feed filter forces this. Older movements are stale by design.

## 16. Dev workflow

```bash
# Unzip the latest zip into the working dir
cd /home/claude
unzip /mnt/user-data/outputs/signalscope-vercel.zip -d signalscope
cd signalscope

# Install once
npm install

# Verify build before any change ships
npx next build

# After edits — rezip excluding bulky/transient dirs
cd /home/claude
rm -f /mnt/user-data/outputs/signalscope-vercel.zip
cd signalscope
zip -rq /mnt/user-data/outputs/signalscope-vercel.zip . \
  -x "node_modules/*" ".next/*" ".git/*" "package-lock.json"
```

Deploy path: push to main (or zip → upload via "Add files via upload") → Vercel auto-deploys. Samarth owns and approves every deploy.

## 17. Operator conventions

- Terse Hinglish in chat. Wants decisions and execution, not options.
- Pushes back on over-engineering.
- Slack messages: single asterisks for bold, no em dashes, plain English.
- "Top funnel" / jargon should be plain English (e.g. "cold outreach").
- "Think harder" means search past chats + ground in actual data, not argue from priors.
- Don't soften criticism. Don't add caveats that water down the substantive answer.

## 18. Quick orientation checklist

1. Read this file end to end
2. Run `npm install` if `node_modules/` isn't present
3. `npx next build` to confirm clean compile BEFORE making changes
4. For UI changes → `components/SignalScope.jsx`. Find the section with `grep -n 'tab name|action name|modal name'`
5. For API changes → `app/api/<route>/route.js`. Headers at the top describe the contract
6. For data-shape questions → `lib/` helper that owns it (`lead-fields.js` for naming, `composite-score.js` for ranking, `movement-detection.js` for classification, `lead-brief.js` for prompt context)
7. After any change → `npx next build` again before rezipping
8. Don't trust `README.md`. Trust this file, the code, and the operator.
