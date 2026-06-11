# 2026-06-11 — "Read full post" showed the summary, not the post

## What broke
The chatbot's "Read full post here" rendered the Task `Signal` field
(scrubbed of internal markers). But Signal never CONTAINED the post —
only the structured summary sentence, suggested comment, a ≤300-char
evidence quote, and scoring. The raw post text existed at scan time
(`post.text`, capped 3000 for the AI prompt) but was never persisted.

## Fix
- `/api/linkedin-posts`: task records now write `Post Text` =
  `sp.post.text` capped 3000 (same cap as the prompt input). Not in
  CRITICAL_FIELDS, so auto-heal strips it on un-migrated bases.
- `setup-fix`: Tasks schema gains `Post Text` (multilineText).
- `/api/sidekick/feed`: formatCard serves `post_text`.
- Chatbot (`sidekick-chat`): full-post view prefers `card.post_text`,
  falls back to the scrubbed Signal for legacy tasks (they age out ≤7d).

## Prevention
When a UI affordance promises "full X", check the data path actually
carries X — the Signal field is a REPORT about the post, not the post.
