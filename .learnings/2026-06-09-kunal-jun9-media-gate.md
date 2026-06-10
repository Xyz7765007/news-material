# 2026-06-09 — Kunal #15: don't reason over media on text-less LI posts

## What
Kunal: "the video and image has no text with it... No, don't fetch it." Concern:
linkedin_engagement scan might fetch/score image/video content when a post has no
text. Asked to gate so scoring stays text-based (like Material).

## Root
Investigated — there is NO media path. `app/api/linkedin-posts/route.js` never
extracts or passes image_url/video_url/media anywhere (grep: zero hits). The
fetched post object carries only text/date/url/urn/engagement counts. scorePost's
userPayload is full_name/title/company/post_text/pre_filter_category — text only.
The provider response is never fetched for media. The assumed media leak does not
exist; the path was already text-based. So this is hardening, not a bug fix.

## Fix (surgical, fetch-time gate — 2 edits, no media change invented)
- Dated path (~line 414): `if (!text) continue;` → `if (!text || text.length < 30)
  continue;` — drops image/video-only posts (provider returns empty/trivial text)
  before any gpt-5.4-mini call. Matches Kunal's "no text → don't fetch it".
- Undatable idx<3 fallback (~line 382): `idx < 3 && text` → `idx < 3 &&
  text.length >= 30` for the same gate. Text-present behavior UNCHANGED.
- Model + max_completion_tokens convention untouched.

## Prevention
Media reasoning was never wired; if anyone adds image/video enrichment later, gate
it on this same ~30-char text floor. Build: `npm install` then
`./node_modules/.bin/next build` → exit 0, ✓ Compiled successfully.
