# 2026-06-11 — Reopen handled tasks (revisit after done/skip)

## What changed
Samarth: "I wanna go back — revisit tasks even if the action is marked
once." Done/skip used to be one-way (Handled At stamp → gone from feed).

- `/api/sidekick/action` now accepts `action: "reopen"` — clears
  Handled At / Handled As / Handled Notes so the task returns to the
  pending feed.
- New `GET /api/sidekick/handled?baseId&limit` — recently handled tasks,
  newest-handled first, same card shape as the feed + handled_at/handled_as.
- The handled filter MIRRORS the feed gates (Archived blank, LinkedIn URL
  present, post-date freshness, 7-day window, relevance suppression) with
  the Handled At clause flipped. Deliberate: every task the panel offers
  is GUARANTEED to reappear in the feed when reopened. Keep the two
  filters in sync if the feed gains a gate.

## Chatbot side (sidekick-chat)
Three ways back: Undo button on the done/skip toast (6s), U hotkey
(last action this session), and the "↩ Handled" header panel (any
recent task, survives reloads). Reopen pins the task as the focused
step (stickyTopIdRef) and decrements the session-done counter.

## Prevention
Any "undo" surface must only offer items whose return path actually
works — filter the offer list by the same gates as the destination view.
