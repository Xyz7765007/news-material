# 2026-06-04 — Feedback batch (backend: pt1, pt5)

## What was addressed
Operator feedback batch — SignalScope share (DM simplification + role relevance).

## Changes
- **pt1 (simplify DM content to 10-yr-old level):** added a PLAIN-LANGUAGE
  RULES block to the auto-batch generation prompt
  (`app/api/sidekick/auto-batch/generate/route.js`, the `system` string that
  produces connectionNote + dm1/2/3 shown in-app). Rules: short sentences
  (≤15 words), one idea per sentence, plain verbs (no leverage/facilitate/
  spearhead), no jargon chains, active voice. Technical terms still allowed
  per operator. Personalization/specificity rules untouched.
- **pt5 (Product Marketing not relevant):** added `IRRELEVANT_ROLE_PATTERNS`
  + `isIrrelevantRole()` to `lib/movement-detection.js`. In
  `buildTaskFromMovement` the movement score (Hired/Promoted 90, Exited 75) is
  floored to 15 when the relevant title matches an irrelevant pattern, and the
  score reason is annotated. Feed sorts by Score desc, so PM leads drop out.

## Root cause note (why pt5 was code, not Airtable config)
Signal-lead scoring is driven by the per-campaign Airtable scoring prompt
("single source of truth", scan/route.js). BUT movement tasks
(Hired/Promoted/Exited) are scored by HARDCODED logic in movement-detection.js
with NO role awareness — so a Product Marketing Manager who moved got 90
regardless. That's exactly the Jeevithan case in the feedback. Hence the fix
belongs in movement-detection.js, not the prompt.

## Verification
- `./node_modules/.bin/next build` → "✓ Compiled successfully" (Next 14.2.15,
  the repo's pinned version; `npx next build` wrongly pulls Next 16 — use the
  local binary).
- No schema change, no new env var, no new dependency.

## Prevention
- Movement scoring is hardcoded and bypasses the Airtable scoring prompt. Any
  future "role X isn't relevant" request for movement leads goes in
  IRRELEVANT_ROLE_PATTERNS, not the campaign prompt.
- To build this repo locally you must `npm install` first (no node_modules
  committed) and run `./node_modules/.bin/next build` — NOT `npx next build`.
