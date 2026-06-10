# 2026-06-10 — Connector-first UI revamp (Kunal Jun-8 architecture) + browser QA

## What
Reworked the SignalScope admin sidebar from a flat tab list into Kunal's
**Connectors → Tasks → Actions** model (from the Jun-8 "Feedback Standup"
transcript). Shipped in 3 deploys, each live-QA'd against prod with a real browser.

## Changes (components/SignalScope.jsx — frontend only)
- **Named, grouped sidebar** replacing bare-line dividers. Sections:
  Dashboard · DATA · CONNECTORS · TASKS · INTEGRATIONS · SETTINGS.
- **Connectors grouped by TYPE, not per rule.** The first cut listed every Task
  Rule as its own nav item — Material has 14 news + 6 job = 20 rules → 20 nav
  items (the clutter Samarth flagged). Now one item per *type* present
  (`📰 News`, `📋 Job Posts`, `🎯 Top X`, `💬 Outreach`), built from
  `[...new Set(rules.map(Task Type))]`, sorted by a fixed `order` array.
- **`+` on the CONNECTORS section header** → opens the existing connector picker
  (`setTab("rules");setShowConnectorPicker(true)`).
- **Uniform per-type page** (`tab==="connector_detail"`, keyed on
  `selectedConnectorType`): header + Run/Add + settings chips (type, #connectors,
  scoring threshold, task count) + that type's rules (Configure/Run/Dup/Delete) +
  their **combined tasks** with search/min-score/date filters.
- **`signal` word dropped** from the section header ("TASKS", not "SIGNALS &
  TASKS"); **`Signal Review` kept by name** (Samarth's explicit call, overriding
  the earlier "Connector Review" rename — reverted).
- **All integrations consolidated** into one INTEGRATIONS sidebar section
  (LinkedIn Posts Scanner, LinkedIn Automation, Email, HubSpot, GA, Post-Demo).
  Removed the duplicate "Channels & integrations" block from the Connectors page —
  that split (some on the page, some in the sidebar) was the confusion.
- **SETTINGS** groups Prompts / Scoring threshold / Coming Soon as advanced config.

## Perf bug found via live QA (and fixed)
The per-type page rendered EVERY task inline — Material's News page was **51,605px
tall** (637 cards). Capped to a 60-task preview (sorted by score; filters narrow in
place) with a "View all N in Tasks →" jump that opens the Tasks tab pre-filtered by
`filter.src = <type>`. News page → 6,053px.

## Scanner connectors (LinkedIn Posts + Lead Movement)
`linkedin_engagement` (LinkedIn Posts scanner) and `lead_movement` (movement scan)
produce tasks but have **no editable Task Rule**. Surfaced them as connectors:
- Appear in CONNECTORS once they've produced ≥1 task of that type
  (`SCANNER_TYPES.filter(st => tasks.some(t => Task Type === st))`).
- Their per-type page shows a **scanner info/run card** instead of rule cards;
  the button opens the scanner page (`setTab("linkedin_posts")`) or the movement
  modal (`setShowLeadMovementModal(true)`).
- Task filter for scanner types keys off `Task Type === tt` (not rule names).
- Renamed the INTEGRATIONS "LinkedIn Posts" → "LinkedIn Posts Scanner" to
  distinguish the run-control from the results connector.

## Browser QA in this env (reusable)
The harness Playwright MCP is hardwired to the `chrome` channel at
`/opt/google/chrome/chrome` (absent; `/opt` is root-owned, no sudo, can't symlink).
A working Chromium ships at `/ms-playwright/chromium-1224/chrome-linux64/chrome`.
Bypass the MCP: drive that binary headless via the globally-installed Playwright
(`require('/usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright')`,
`launch({executablePath, headless:true, args:['--no-sandbox']})`). Logged in with
`SIGNALSCOPE_ADMIN_PASSWORD` from `.env`, toured every nav item, DOM-probed
headings/scrollHeight/console errors, screenshotted. **Deploy-poll gotcha:** poll
the live JS bundle for a string UNIQUE to the new code ("scanner-driven"), not one
that already exists ("Lead Movement" was a false positive against the old bundle).

## Commits (all on main, live-verified, 0 console errors on nav)
`63d30a0` revamp → `e4e6028` per-type task cap → `6ba5cb4` scanner connectors.

## Prevention
- Group connectors by TYPE in the nav, never per rule (rule count is unbounded).
- Any inline list that can hold the full Tasks set must cap + link to Tasks.
- Frontend-only; no Airtable schema / field renames; client portal untouched
  (connector items + integrations are admin-only; `connector_detail` is `!clientMode`).
