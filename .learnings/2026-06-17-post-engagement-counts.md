# 2026-06-17 — LinkedIn post engagement counts on the chatbot card

Kunal (Jun16 OKR call) wanted likes/comments visible on each LinkedIn card so
the exec can gauge traction before engaging ("zero comments tells me something").
Investigated whether Unipile allows it → it does, BUT we don't need Unipile.

## Key finding (durable)
The LinkedIn-posts scan already fetches engagement for free. Provider is
**fresh-linkedin-scraper-api** (RapidAPI, `/api/v1/user/posts`), NOT Unipile.
Counts live in the nested **`post.activity`** object — verified live against a
known poster:
```
activity: { num_likes: 1368, num_comments: 219, num_shares: 84,
            reaction_counts: [{count,type}...] }
```
NOT at top level (the old `p.total_reactions || p.likes_count || p.likes || 0`
always returned 0 — a silent false zero). No extra API call, no extra cost.

## What shipped
- `extractCount(p, kind)` in `app/api/linkedin-posts/route.js` — null-safe pull
  from `activity.num_likes/num_comments/num_shares` (+ wide fallback names and
  nested objects). Returns NULL when absent, never 0, so a false zero never shows.
- Persist `Post Likes` / `Post Comments` on linkedin_engagement Tasks (only when
  a real number; null omitted).
- `setup-fix`: added both as `number` cols to the Tasks schema. Ran the
  single-base override on Veloka (`appPcAzAyMmtNNEmT`) → columns added.
- `sidekick/feed`: passes `post_likes` / `post_comments` (number or null).
- `test_profile` debug: now accepts `{ username }` or `{ urn }` and echoes raw
  first-post keys/`activity` — that's how the field names were verified. Reusable
  for any future provider-shape check.

## Gotchas
- **setup-fix targets a single base via QUERY param**: `?key=...&baseId=appXXX&table=Tasks`.
  Passing baseId in the JSON body is IGNORED (it then iterates only the master
  Campaigns table, which does NOT include the Veloka preset → Veloka got skipped
  the first time).
- **Counts populate only on tasks scanned from 2026-06-17 onward.** The ~5k
  existing Veloka linkedin_engagement tasks have no counts until re-scanned
  (Monday weekly auto-scan will refresh). Existing cards show no engagement line.
- The reaction count is total reactions (num_likes), not just "likes" — fine for
  the at-a-glance signal Kunal wanted.

## Verification
test_profile (prod) on `williamhgates`: parsed `likes:1368 comments:219
reposts:84` and `likes:4003 comments:485 reposts:273`. Build exit 0 (19 routes).
