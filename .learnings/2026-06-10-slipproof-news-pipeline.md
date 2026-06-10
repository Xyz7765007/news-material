# 2026-06-10 — Slip-proof news pipeline (commits 3e9ebd6, 7eadfac)

## Why

Full-fleet slippage audit (92 Material accounts, raw RSS vs live /api/scan vs
Apify ground truth) quantified where real events die and why most tasks were
irrelevant:

- **Decode collapse under fleet load**: news.google.com URL decoder failure went
  7% (first half of fleet) → 82% (second half) in one run — Google rate-limits
  the decode endpoints. 60% of articles reached the scorer with no body.
- **Hard 50-article cap** silently dropped articles 51+ (16 multi-source events
  in one week, incl. Salesforce×FIFA fan engagement).
- **Precision ~1%**: 1,327 matches at threshold 70, ~10 genuine own-brand
  marketing actions. "Earnings Season" rule alone = 30% of matches; the
  "Agency review or consolidation" rule scored a 3M **board appointment** 95
  eight times (model read "agency" as governance).
- Same article matched up to 3 rules (duplicate tasks); 8 sibling articles of
  one event each matched separately.

## What changed

`lib/google-news-decoder.js`
- Global adaptive pacing: every decode HTTP call flows through `paced()` —
  150ms min interval, ×2 on 429 (cap 2s), ×0.92 decay on success.

`app/api/scan/route.js`
- 75s/account decode time budget (`DECODE_TIME_BUDGET_MS`) — past it, remaining
  URLs score headline-only instead of eating the 300s POST budget.
- Articles 51+ scored on headline+excerpt (`fetchError:"overflow_headline_only"`)
  instead of dropped.
- Headline-only marker rewritten: no benefit-of-the-doubt (old "do not penalize"
  text made the model assume the missing body would qualify).
- POST-SCORING GUARDS in `classify()` (results carry `results.guardStats`):
  1. **Hedge cap** (news): finance/governance-noise matches (no marketing-action
     language) demoted to retain band → Signal Review, never a Task, never lost.
     Bare "agency" deliberately NOT a marketing term (board-appointment trap).
  2. **Single-rule arbitration** (news+jobs): one signal = one rule (top score).
  3. **In-run event dedup** (news): per-rule headline Jaccard ≥0.6 → keep best.
- "STAY IN YOUR LANE" instruction in the scorer system prompt (default branch
  only, not the neutral-prompt branch).
- `fetchStats.funnel` = {feed, recent, deduped, bodyFetched,
  overflowScoredHeadlineOnly, decode, guards} — slippage now observable per call.
- Scoring model `gpt-5.4-mini` → `gpt-5.4` here and in `/api/linkedin-posts`.

Airtable rule-prompt edits (data, Material base):
- "Earnings Season Marketing Signal Task": HEADLINE-ONLY PROTOCOL (bare earnings
  headline with no M1-M6 entity visible scores ≤20).
- "Agency review or consolidation": agency = ad/creative/media agency; board /
  governance / government-agency stories score ≤15.

## Verified live (post-deploy)

- Decode 50/50 on four concurrent scans (CrowdStrike, 3M, Salesforce, Coty).
- Salesforce×FIFA (the audit's poster-child cap loss) now tasks at 70; m3ter
  acquisition articles ranked 51+ matched via overflow.
- 3M board story: 8 matches @95 → 0.
- CrowdStrike: 29 earnings recaps auto-demoted to retain band.
- True positives intact: Coty×Zenith 98/100, Coty exec interview 95.

## Residual / watch

- Stock-analysis phrasings ("Stock a Buy on the Dip", "Lifts PT") needed a
  second regex pass (7eadfac). Watch the retain band for new junk phrasings —
  extend FINANCE_NOISE_RE, never loosen MARKETING_ACTION_RE without checking
  the 3M board case.
- Feed gaps remain (Google's RSS never served 2 real Chime signals this week).
  Apify-as-second-source rejected on cost (~$0.58/account/run, easyapi actor).
- M&A language deliberately NOT in the noise regex — "New non-traditional
  entrants" legitimately tasks acquisition stories.
