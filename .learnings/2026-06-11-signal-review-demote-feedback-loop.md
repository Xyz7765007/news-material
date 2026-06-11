# 2026-06-11 — Signal Review demote + reviewer-feedback loop (commit `4664659`)

## What & why
Signal Review could only **promote** (archive → Task) or **delete** a result. A
wrongly-qualified Task could only be deleted, and the AI scorer never learned why
it was wrong — so the same mistake recurred every scan. Samarth: "give an option
to demote tasks with feedback, and on each relevance check the feedback should be
considered to not repeat the mistakes."

## What shipped
New isolated **`app/api/review-feedback/route.js`** (role-check pattern — kept off
the high-blast-radius scan routes):
- **Demote** (`action: "demote"`): qualified Task → Signal Archive with
  `Signal Status: "demoted"` (reversible via Promote), reviewer feedback REQUIRED,
  then deletes the live Task. Archive-write-first so nothing is lost if the delete
  fails.
- **Promote feedback** (`action: "promote_feedback"`): optional "this should have
  qualified" note.
- Both append a dated bullet to a **4000-char-capped digest** (oldest lines trim
  first): on the **Task Rule's `Reviewer Feedback`** field for
  news/job_post/company_post, or the **master Campaigns row's `LinkedIn Posts
  Feedback`** for linkedin_engagement (which has no Task Rule).
- Auto-creates missing fields (meta API) + strips missing optional archive fields,
  so it works pre-provisioning; `typecast:true` auto-creates the `demoted` choice.

**Injection — every scoring path now reads the digest into its prompt:**
`/api/scan` (news+jobs, via `taskDefs[].reviewerFeedback`), `/api/scan-run`
`buildDefs`, `/api/company-posts`, `/api/linkedin-posts` `scorePost`
(via `Campaigns["LinkedIn Posts Feedback"]`). Prompt frames it as DEMOTED = scored
too HIGH / PROMOTED = too LOW, "do not repeat these mistakes."

**Top X deliberately excluded** — its compiled band scoring is locked (Volopay);
feedback injection would fight the bands.

## UI (`components/SignalScope.jsx`)
- Qualified rows: **▼ Demote** (feedback required). Unqualified/demoted rows:
  **▲ Promote** (optional feedback) — now carries Name/Lead Title/LinkedIn URL
  back onto the Task so a demote→promote roundtrip keeps lead identity.
- New `demoted` status pill + summary card + red chip; reviewer note in row tooltip.

## setup-fix schema additions
- Task Rules: `Reviewer Feedback`.
- Signal Archive: `Name`, `LinkedIn URL`, `Review Feedback`, `Reviewed At`,
  + `demoted` choice on `Signal Status`.
- Provision: `POST /api/setup-fix?baseId=<BASE>&table=Task%20Rules&key=<CRON_SECRET>`
  and `&table=Signal%20Archive`. Material provisioned 2026-06-11.

## Verified
E2E on prod: synthetic Task (Handled-At stamped → never in feed) → demote → archive
row correct + Task deleted + feedback line on the rule → cleaned up.

## Related, same day (UNPUSHED, in working tree)
`/api/scan` jobs-batch gained an optional `apifyToken` body override (sole token, no
fallback to the capped shared/Kunal account) so job fetches can run on an operator's
own Apify account. Left unpushed at Samarth's request; build passes. Manual fetches
currently go through `scripts/material-jobs-apify-direct.py` (direct actor call).
