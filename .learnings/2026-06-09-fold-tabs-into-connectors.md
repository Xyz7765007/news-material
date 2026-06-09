# 2026-06-09 — Fold 4 standalone tabs into Connectors (Kunal #11-full)

## What
Move the ENTRY POINTS of 4 standalone nav tabs into the Connectors page as
fixed instance cards. Non-destructive: panels keep 100% functionality.
Frontend-only (components/SignalScope.jsx).

## Fix
- Nav array (~1900): removed `outreach`/`linkedin_posts`/`email_campaign`/
  `hubspot` entries. LEFT google_analytics, post_demo, dashboard, accounts,
  leads, rules, prompts, threshold, tasks, signal_review, coming_soon. Kept the
  divider. The 4 ids stay in `ADMIN_ONLY_TABS` (harmless — that set only filters
  navs that exist).
- Kept all 4 `tab==="..."` panel blocks + every `setTab(...)` deep-link intact
  (dashboard StatTiles, setup checklist, outreach card still navigate fine).
- Connectors page: new "Channels & integrations" subsection (divider + header)
  rendered OUTSIDE the `configured &&` gate so it shows with zero signal-source
  connectors. 4 uniform cards (emoji + name + 1-line descriptor + "Open →")
  calling setTab(c.tab). Preserved the nav's `loadOutreachStats()` side-effect
  for the outreach card.
- Back-link "← Connectors" (setTab("rules")) added atop each of the 4 panels.
  email_campaign + linkedin_posts render components, so wrapped each in a <div>.
- NIT: added `deliveryBadge(f)` chip to `linkedin_outreach` connector cards
  (signal/top_x cards already had it).

## Prevention
No Airtable field renames, no "signal" wording, no panel behavior change.
Build: `npm install` then `./node_modules/.bin/next build` → exit 0.
