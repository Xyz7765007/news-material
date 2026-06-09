# 2026-06-09 — Connectors restructure (Batch 1, frontend-only)

## What broke
Nothing broke — this is Kunal's Batch-1 UX feedback: the "signal" vocabulary
and the dump-every-option-upfront Task Rules screen confused operators.

## Root cause
The Task Rules tab rendered all possible connector types (news/jobs/topx guides)
on first load even with zero configured, mixing setup affordances with the
configured-rules tables. "Signal" leaked across nav, headings, tooltips, empty
states. Tasks had no per-connector filter; Scan Target had no account-agnostic
option.

## Fix (components/SignalScope.jsx — LABELS/NAV/STRUCTURE only, non-breaking)
- Nav: "Task Rules"→"Connectors", "Signal Review"→"🔎 Connector Review";
  added a divider before Tasks to separate it as its own section. Dashboard
  StatTile + setup checklist re-labelled.
- Connectors home: blank empty-state w/ one prominent "+ Add Connector" CTA →
  opens a connector-type picker (new `showConnectorPicker` state) that routes the
  chosen preset into the EXISTING RuleEditor. Configured connectors now render as
  UNIFORM cards (name, type badge, scan-target, task count) — only what's set up.
  Dropped the upfront all-types guide grid.
- Tasks tab: added per-connector `<select>` (new `filter.connector` key) + a
  grouped-by-connector table view (divider header per connector) when "All
  Connectors" is selected. No "Action today" section existed — confirmed; the
  Signal column header → "Event".
- RuleEditor: "Task Type"→"Connector Type", "Signal Sources"→"Connector Sources",
  modal title "New/Edit Rule"→"New/Configure Connector", save→"Add Connector".
  Optional Ease/Strength collapsed into a `<details>` "⚙️ Settings".
- Scan Target: added 4th option "🌐 Agnostic / neither". DEGRADE NOTE: the Task
  Rule `Scan Target` field is Airtable singleLineText (route.js:332/350), so
  "agnostic" stores cleanly — no 422. Scan still iterates `accounts`; "agnostic"
  is a pass-through label on the Task, not a new scan path.

## Prevention
NO Airtable field / state-key / API-key renames touched — `Scan Target`, `Signal`,
`Task Rule`, `taskType`, `scanTarget` all unchanged in code. CSV export column
"Signal" left intact (it's the field name). Out-of-scope surfaces (Triggers tab
"Buying signals", AI scoring-prompt example text) deliberately untouched. Build:
`npm install` then `./node_modules/.bin/next build` (NOT npx) → ✓ Compiled.
