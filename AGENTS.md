# AGENTS.md — SignalScope

This file defines the workflow rules for any agent (Claude Code, Codex, or similar) working in this repo. These rules are non-negotiable — they exist because each one prevents a class of bug that has actually happened in production.

Read this file at the start of every session. Read `CLAUDE.md` next.

---

## A. CORE WORKFLOW RULES (NON-NEGOTIABLE)

### A1. Always use the Kanban board to track tasks

- Every task — bug, feature, refactor, or investigation — gets a card on the Kanban board before any code is written.
- Move the card through columns as work progresses: `Backlog → In Progress → Review → Deployed → Done`.
- If a task is too big for one card, break it into subcards before starting. A card that sits "In Progress" for more than 2 days needs to be broken down or escalated.
- Link any PR / zip artifact to the card.
- If you discover unrelated bugs while working on a card, **create a new card** — do not silently fix them in the same change. Scope discipline.

### A2. Ask for user approval before making code changes

- For any change that touches more than one file, OR touches a route handler, OR touches `SignalScope.jsx` outside a clearly-bounded section: **present the plan first**, get explicit "yes, do it" before editing.
- For typo fixes, comment cleanups, single-line bug fixes in a single file: proceed without asking, but tell the user immediately after.
- "Approval" means an explicit affirmative from the user. Silence is not approval. A previous "go ahead and fix things" from earlier in the conversation is not a blanket approval for new changes.

### A3. Ask for approval before deploying

- Never push to GitHub / re-zip the deployment artifact without explicit deployment approval.
- Approval is given per-deployment, not per-session. Each deployment needs its own ack.
- Before asking for deployment approval, you must have run `npx next build` and confirmed clean compile.
- Bhuvesh reviews code before any production push — flag this in your approval request so the operator can hand off.

### A4. Use browser tools for testing

- After any UI change, open the affected page in the browser via the browser tools and verify the change renders correctly.
- After any API route change, hit the endpoint via the browser tools or curl and verify the response shape matches what the calling code expects.
- "Compiled successfully" is necessary but not sufficient. A successful build with a UI bug is still a regression.
- For changes affecting the chatbot's `/api/sidekick/*` endpoints, also verify the chatbot still renders the response correctly — those endpoints are a contract.

### A5. Log important learnings in the `.learnings` folder

- Create `.learnings/` at the repo root if it doesn't exist.
- After every non-trivial bug fix, write a single markdown file: `.learnings/YYYY-MM-DD-short-slug.md`.
- Each learning file has four sections:
  - **What broke** — 1-2 sentence symptom description
  - **Root cause** — the actual technical reason, with file + line references
  - **Fix** — what changed and why
  - **Prevention** — what convention / lint / test would catch this next time
- Keep them short. A learning file longer than 30 lines is doing too much.
- Reference older learnings when working on similar issues — `grep -r 'similar keyword' .learnings/` before debugging.

### A6. Maintain context using memory

- At the start of every session, read `CLAUDE.md` (the authoritative context) and the most recent 5 files in `.learnings/`.
- When you discover a fact about the system that contradicts `CLAUDE.md`, update `CLAUDE.md` in the same change. Stale context kills future agents.
- When you discover a fact about the system that's a new pattern (not contradicting existing context), add it to `CLAUDE.md` or `.learnings/` as appropriate.
- Long-running facts (architecture, conventions, integrations) live in `CLAUDE.md`. Episodic bug fixes live in `.learnings/`.

---

## B. CODE CHANGE PROTOCOL

### B1. Before any change

1. State which file(s) you're about to edit and why.
2. If touching `SignalScope.jsx`, name the line range you'll work in.
3. If touching `/api/airtable/route.js` or `/api/outreach/route.js`, name the `action` case.
4. If touching a `lib/` helper, name the function and what callers will be affected.

### B2. Read before you write

- Use `grep -n` to locate the section. `SignalScope.jsx` is 8977 lines; `airtable/route.js` is 2287; `outreach/route.js` is 2460. Never load these whole files unless absolutely necessary.
- Read the function in full before editing. Don't edit blind from a partial view.
- Read the immediate callers — what assumptions do they make about your function's behavior?

### B3. Surgical edits only

- Use `str_replace` for targeted edits. Never use bulk rewrites of large sections unless the user explicitly asks for a refactor.
- Each `str_replace` should be one logical change. If you're making 5 unrelated edits, that's 5 separate operations.
- When you change a function's signature or return shape, grep for every caller and verify each one still works.

### B4. Preserve patterns

- New API routes follow the existing pattern: `export const dynamic = "force-dynamic"; export const fetchCache = "force-no-store";` at the top. Don't omit these or Vercel caching will silently corrupt the data layer.
- New OpenAI calls use `max_completion_tokens` (not `max_tokens`) for `gpt-5.4-mini`. Verified failure mode: response silently empty.
- New AI prompts that handle lead data must preserve the PUBLIC FACTS / INTERNAL CONTEXT split from `lib/lead-brief.js`. Never let the AI quote internal scoring back to a lead.
- New Airtable writes that may hit unfixed schemas need the auto-heal pattern (parse 422 UNKNOWN_FIELD_NAME, drop field, retry, loop cap 8). Copy from `/api/scan-leads/route.js`.

### B5. Document while you change

- Add a header comment to any new route file describing: purpose, auth method, request body shape, response shape, side effects.
- Add inline comments above non-obvious logic — anything that took you more than 30 seconds to understand should have a comment explaining it.
- Don't bother commenting obvious code. The goal is preventing future-you from having to re-derive the reasoning.

---

## C. TESTING PROTOCOL

### C1. Always build before declaring done

```bash
npx next build
```

A change is not done until this passes cleanly. "Compiled successfully" is the bar.

### C2. Manually verify in the browser

- For UI changes: open the affected screen, perform the action, verify the result.
- For API changes: use the browser dev tools network tab or curl to verify the response.
- For chatbot-facing endpoints (`/api/sidekick/*`): open the chatbot in another tab and verify it still works.

### C3. Test against actual data, not mocks

- Don't write tests that mock Airtable. Use a sandbox campaign in the master `Campaigns` table for verification.
- For new scan logic, run it against Volopay or Shipturtle (high-volume campaigns) to verify performance and correctness at scale.
- For new outreach logic, run it on a single test lead first. Never run new outreach code on a real campaign without operator approval.

### C4. Edge cases you must check

- **Empty data**: what happens when the campaign has 0 leads / 0 tasks / 0 outreach records?
- **Missing fields**: what happens when an Airtable record is missing a field your code reads? (Hint: don't crash, use `f.FieldName || defaultValue`)
- **Stale Airtable reads**: if your code creates a record then reads it back, account for read-after-write latency. See `outreach/route.js` `sendManualConnections` for the canonical retry pattern.
- **Per-campaign field naming variance**: different campaigns use different field names ("Title" vs "Job Title" vs "Position"). Use `lib/lead-fields.js` helpers.

---

## D. DEPLOYMENT PROTOCOL

### D1. Pre-deployment checklist

Before asking for deployment approval, verify all of the following:

- [ ] `npx next build` passes cleanly
- [ ] You've manually tested the change in the browser
- [ ] You've checked the change against the patterns in `CLAUDE.md` §15 (Coding Rules)
- [ ] Any new env vars are documented in `CLAUDE.md` §12
- [ ] Any new API routes are documented in `CLAUDE.md` §6
- [ ] If the change affects the chatbot, you've verified the chatbot still works
- [ ] A learning file has been written if the change resulted from a bug fix

### D2. Zip and deliver

```bash
cd /home/claude
rm -f /mnt/user-data/outputs/signalscope-vercel.zip
cd signalscope
zip -rq /mnt/user-data/outputs/signalscope-vercel.zip . \
  -x "node_modules/*" ".next/*" ".git/*" "package-lock.json"
```

Always exclude `node_modules`, `.next`, `.git`, `package-lock.json`. Always present the zip to the operator after creation.

### D3. After deployment

- Verify the deployed version by opening `https://news-material-two.vercel.app` and exercising the changed code path.
- If anything looks wrong, ask the operator for a rollback ASAP. Do not attempt to debug live in production without explicit go-ahead.
- Update the Kanban card to "Deployed".

### D4. NEVER deploy these without explicit operator approval

- Changes to master `Campaigns` table schema
- Changes to per-campaign Airtable schema (handled by `setup-fix`, but a route change that calls `setup-fix` for every campaign needs approval)
- Changes to the auth model (`admin-auth`, `SIDEKICK_API_KEY`, `CRON_SECRET` handling)
- Changes that delete or mass-update records
- Anything that touches a paid external service (Apollo, RapidAPI, Apify) at scale

---

## E. MULTI-CAMPAIGN AWARENESS

### E1. Every change must consider all campaigns

- Material, Veloka, Volopay, Shipturtle, Nutriventia, Firebolt, Tazapay, e6data, Osome, Cactus — each has its own Airtable base, its own Task Rules, its own scoring prompts.
- A change that works for Veloka may break Material if it depends on a field Veloka has and Material doesn't.
- Before declaring a change done, ask: "would this break for a campaign that doesn't have `Feature X` enabled?"

### E2. Backwards compatibility is mandatory

- Existing campaigns with existing data must keep working through any code change.
- If a change requires schema updates, either:
  - Make the new field optional (code handles its absence gracefully), OR
  - Document a `setup-fix` invocation for each campaign in the migration notes
- Never assume operators will run a migration. Code defensively.

### E3. Per-campaign secrets

- HubSpot API keys: stored per-campaign in the master `Campaigns` table, NOT in env vars.
- Smartlead API keys: same pattern.
- GA OAuth tokens: same pattern.
- Never hardcode any of these. Read them from the `Campaigns` row at runtime.

---

## F. AI USAGE RULES

### F1. Track every AI call

- Every OpenAI call must invoke `trackOpenAIUsage(campaignId, model, usage)` from `lib/ai-usage.js`.
- Every Anthropic call must invoke the equivalent (extend `ai-usage.js` if needed).
- Without per-campaign attribution, billing is broken.

### F2. Default to cheap models

- Use `gpt-5.4-mini` unless quality demands `gpt-5.4`.
- Use `claude-haiku-4-5-20251001` unless reasoning demands `claude-sonnet-4-6`.
- AI cost compounds across thousands of leads. The wrong default doubles spend.

### F3. Preserve prompt safety patterns

- Every new prompt that handles lead data:
  - Splits citable PUBLIC FACTS from non-citable INTERNAL CONTEXT
  - Has explicit banned-phrase list for internal-leak terms (scores, ratings, rule names)
  - Has explicit banned-phrase list for generic openers ("noticed your work", "saw your activity")
  - Has worked examples (bad vs good)
  - Has a self-check before output
- Don't ship "creative" prompts that skip these. Prior versions of the auto-batch prompt actually leaked "67/100 ICP fit" to leads — these patterns are remediations to real failures.

### F4. Validate AI output

- Use `lib/message-merge.js` `sanitizeAndValidate` for any AI output that becomes outreach.
- Catches stray `{first_name}` leaks, markdown artifacts, AI refusals, character overruns.
- New AI output paths: route through this helper. Don't reinvent it.

---

## G. SECURITY RULES

### G1. Never commit secrets

- No API keys in code. All keys live in Vercel env vars or per-campaign in Airtable.
- If you find a hardcoded credential in the code, flag to operator immediately and rotate the credential.
- Don't include API keys in test scripts, debug logging, or learning files.

### G2. Auth is non-negotiable

- Every `/api/sidekick/*` endpoint must validate `Authorization: Bearer <SIDEKICK_API_KEY>`. No exceptions.
- Every admin endpoint must validate `CRON_SECRET` via `?key=` or `Authorization: Bearer`.
- Client portal endpoints validate per-campaign password via `/api/airtable` action `validate_client`.
- Never add an endpoint with no auth. If you genuinely need a public endpoint, escalate.

### G3. Diagnostic logging discipline

- It's fine to add `console.log` for debugging.
- Don't log full Airtable records (may contain PII).
- Don't log lead phone numbers or emails verbatim. Log shape: `phone: <set/unset>`, not the value.
- Don't log API keys (obviously) or full request bodies that may contain them.

---

## H. COMMUNICATION PROTOCOL WITH OPERATOR

### H1. Match the operator's communication style

- Terse Hinglish in chat. Wants decisions and execution, not options.
- Don't pad responses with caveats or hedges.
- Slack messages: single asterisks for bold, no em dashes, plain English (no "top funnel" — say "cold outreach").

### H2. Be honest about uncertainty

- If you're not sure something will work, say so and explain why.
- If you're guessing about the operator's intent, ask one clarifying question. Don't guess silently.
- If a previous change had unintended consequences, say so directly and propose a fix.

### H3. Don't ask questions for the sake of asking

- Before asking a question, check: is the answer in `CLAUDE.md`? In the user memory? In the most recent learning files?
- Bundle related questions into a single message.
- Lead each question with what your current best guess is, so the operator can confirm/correct in one word.

### H4. Surface trade-offs explicitly

- When two implementations are both reasonable, name both, name the trade-off, recommend one.
- Don't choose silently. The operator may have preference signals you don't see.

---

## I. EMERGENCY PROCEDURES

### I1. Production is broken

- Read the symptom carefully from the operator's report. Don't assume.
- Check the Vercel logs first: `console.log` and `console.warn` calls from your code should be visible there.
- If the issue is recent, identify the last deployment and consider rollback (operator-approved) before debugging.
- Add diagnostic logging to narrow the failure mode. Ship the diagnostic before guessing at fixes.

### I2. Airtable schema drift

- If a campaign's Tasks table is missing required fields, the symptom is "tasks created counter ticks up, no rows land in Airtable."
- Run `/api/setup-fix?key=<CRON_SECRET>` for the affected base.
- If `setup-fix` can't add a field type (e.g. needs a singleSelect with specific options), do it manually in Airtable UI.
- Document the drift in `.learnings/` so the next agent recognizes the symptom.

### I3. AI cost spike

- Check `Campaigns` table → `AI Usage` column for any campaign exceeding its monthly budget.
- Identify which route is spending: every AI call is attributed by campaign + model.
- Most common cause: a loop that calls AI per record without batching.

### I4. Cron not firing

- The outreach cron is GitHub Actions, not Vercel. Check the Actions tab on the GitHub repo.
- The LinkedIn Posts scan is cron-job.org. Check there.
- The Vercel cron entry in `vercel.json` is misleading — see `CLAUDE.md` §10.

---

## J. PATTERN-SPECIFIC GOTCHAS

### J1. `isDuplicate` has three layers — Top X needs strict mode

Top X Smart Compile generates identical match-reason text for multiple leads at the same account. Layer 3 fuzzy dedup will wrongly kill all but one. **Always pass `{ strict: true }` for Top X callers**. See `components/SignalScope.jsx` `isDuplicate` definition + line 1494 caller.

### J2. Empty connection notes are valid

`sendInvitation` line 247 sends `message: message || undefined` → Unipile omits the field → invite sent with no note. Don't add empty-string validation; the "Send without a note" UX depends on this.

### J3. `Mode` field on Outreach records

- `Mode: "auto"` = Sidekick Auto-Batch
- `Mode: "manual"` = Manual Outreach modal
- The `Sidekick Auto-Batch v1` rule is hardcoded by name. Blocking manual enqueue against it is intentional.

### J4. Movement signals priority

In `lib/composite-score.js`, movement signals (Hired/Promoted/Exited) are forced to the top of the chatbot card stack. This is Kunal's call from May 16. Don't "fix" it.

### J5. Read-after-write staleness

Airtable `atList` immediately after `atCreate` is eventually consistent. For flows that need just-created records, use the IDs returned from `atCreate` directly (don't re-list). See `outreach/route.js` `enqueueLeads` return shape and `sendManualConnections` retry logic.

### J6. `gpt-5.4-mini` requires `max_completion_tokens`

Using `max_tokens` produces silent empty responses. Caused the May 16 outage. All working calls in this codebase use `max_completion_tokens`. Verify when copy-pasting from OpenAI docs.

### J7. URL drift

Operator-facing URL: `https://news-material-two.vercel.app`. Cron workflow URL: `https://news-material-eta.vercel.app`. Both should alias the same Vercel project — verify in project settings before changing either.

---

## K. WHAT TO DO AT THE END OF A SESSION

1. Update the Kanban board: move completed cards, leave clear notes on partial work.
2. Write any pending learning files in `.learnings/`.
3. Update `CLAUDE.md` if you discovered facts that need to be authoritative.
4. Verify the zip in `/mnt/user-data/outputs/` is the latest version.
5. Leave a one-paragraph session summary for the operator: what was done, what's still open, what needs their attention.

---

## L. WHAT NEVER TO DO

- Never deploy without explicit approval
- Never edit files outside this repo
- Never delete `.learnings/` files (they're institutional memory)
- Never make changes that bypass the multi-campaign architecture
- Never log secrets
- Never make production database changes without dry-run preview
- Never disable existing patterns (auto-heal, dedup layers, sanitize-and-validate) without operator approval
- Never assume — verify with code
- Never silently fix a bug you noticed outside your task scope (create a card instead)
- Never push a change you haven't built (`npx next build`)
