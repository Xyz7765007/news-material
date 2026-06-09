# 2026-06-09 — Universal relevance feedback (backend)

## What
Kunal's ask: operator can give feedback on ANY data point and have it ENFORCED
(hard-suppress + score-adjust), retroactive + forward + reversible, Veloka-only.

## Changes (SignalScope)
- NEW table `Sidekick Relevance Rules` (per-campaign base) via setup-fix
  CAMPAIGN_TABLES: Kind (singleSelect: title_irrelevant | company_irrelevant |
  signal_irrelevant | role_fit), Value, Target Score, Active (checkbox), Note,
  Created, Created By, Name(primary).
- NEW `lib/relevance-rules.js`: `fetchActiveRelevanceRules(baseId)` (NEVER throws
  → [] on any failure), `buildSuppressionClause`, `withSuppression`,
  `roleFitScoreFor`. INTERNAL only.
- NEW `POST/GET /api/sidekick/relevance` (Bearer). POST create
  `{baseId,kind,value,targetScore?,note?}`; POST deactivate `{baseId,ruleId,
  active:false}` (one route, ruleId discriminator). Missing table → 412
  needsSetup, never 500.
- ENFORCEMENT in feed + count: fold the SAME suppression clause into BOTH the
  PENDING and LEGACY filterByFormula (byte-identical so badge never desyncs).
  Read filter = source of truth → retroactive + forward + reversible (toggle
  Active off). role_fit does NOT suppress; feed overrides SERVED score on read +
  re-sorts (stored Airtable Score untouched). No rules / missing table = exact
  legacy behaviour.
- linkedin-posts writer: best-effort pre-skip of leads matching title/company
  rules or a linkedin_engagement signal suppression (token/RapidAPI saver, try-
  wrapped, never blocks).

## Field mapping (Veloka Tasks)
title → {Lead Title} (NOT {Title}: absent field 422s the whole formula);
company → {Company}; signal → {Task Type}/{Movement Type}. All FIND+LOWER, ci.

## Skipped (deliberate)
Hardcoded movement scoring (movement-detection.js) NOT touched — read-side
suppression is the correctness guarantee; movement role-fit stays in
IRRELEVANT_ROLE_PATTERNS. `not_needed` = existing /action skip + notes (no change).

## Build / migration
`npm install` then `./node_modules/.bin/next build` → ✓ Compiled, 19/19.
POST-DEPLOY: surgical create on Veloka's base (params are QUERY, table name
URL-encoded):
`POST /api/setup-fix?key=<CRON_SECRET>&baseId=appPcAzAyMmtNNEmT&table=Sidekick%20Relevance%20Rules`
(omit baseId+table for a full sweep across all campaign bases).
