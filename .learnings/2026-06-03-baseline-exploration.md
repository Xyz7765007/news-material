# 2026-06-03 — Baseline exploration of SignalScope (news-material)

## What was checked
Full repo map + CLAUDE.md/AGENTS.md read, live backend health, GitHub state, doc-vs-reality verification. Read-only (no scans/outreach triggered, per AGENTS.md C3).

## Architecture (confirmed from code)
- **The OS behind Side Kick.** Multi-campaign. Next.js 14 App Router, JS only, Tailwind, Airtable as the only datastore. 50 API routes, `components/SignalScope.jsx` = 8973 lines (whole SPA), 11 `lib/` helpers.
- **Two Airtable layers:** master base (`Campaigns` table + Movement Scan Runs, Sidekick Chat, Cron Run Log) and per-campaign bases (Accounts, Leads, Task Rules, Prompts, Tasks, Outreach).
- **Frontend contract:** the chatbot's `/api/sidekick/*` endpoints (24 of them) ARE this repo. `/api/sidekick/feed` returns full per-lead detail (name, company, title, email, linkedin, score, signal). Auth = Bearer SIDEKICK_API_KEY (verified: 401 without).
- **AI:** OpenAI gpt-5.4 / gpt-5.4-mini everywhere; Anthropic claude-sonnet-4-6 only in `/api/email-campaign`. gpt-5.4-mini MUST use `max_completion_tokens` not `max_tokens` (silent-empty failure mode).

## Live health (verified)
- Root `news-material-two.vercel.app` → 200 (admin gate). `/api/sidekick/feed` → 401 (auth working). `unipile-health` → needs CRON_SECRET.
- `cron/outreach/status` → healthy, last scheduled run 1h45m ago, status success, 8/10 recent successes.

## Findings (doc drift + security)
1. **CLAUDE.md §10 is INCOMPLETE on cron.** It documents 3 schedulers but there are actually 4 — a `.github/workflows/movement-scan-tick.yml` (every 5 min, hits `/api/sidekick/movement-scan-tick`) exists on disk and is NOT mentioned in §10.
2. **The §10 "URL drift" concern is stale.** §10 warns the workflow hits `-eta` while operator URL is `-two`. The actually-deployed `outreach-cron.yml` hits `news-material-two.vercel.app` — drift already resolved. Update the doc.
3. **🔴 SECURITY: both main repos (`Xyz7765007/news-material` + `/sidekick-chat`) are PUBLIC.** CLAUDE.md line 224 literally states `CRON_SECRET = signalscope_7765007`. A live secret is exposed in a public repo. Recommend: make both repos private + rotate CRON_SECRET. (Backend repo-settings + env change = user's call.)
4. **No single-lead-detail endpoint** in sidekick routes — confirms the chat-context fix (frontend #1 finding) can source per-lead data from the existing `/api/sidekick/feed` payload; no new backend endpoint strictly required for that.

## State of repo
- No `.learnings/` folder existed (created with this file). Latest commits: agent-context files, LinkedIn scan scope-hijack fix, job_post per-company Apify fix.
