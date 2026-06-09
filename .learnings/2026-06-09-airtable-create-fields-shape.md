# 2026-06-09 — /api/airtable create silently failed on `{fields:{...}}` payloads

## What broke
`POST /api/airtable {action:"create", records:[{fields:{...}}]}` — the documented
Airtable record shape — silently created NOTHING and returned `{records:[]}` with
HTTP 200. Surfaced during QA of the relevance feature (had to use bare field-maps
to create test tasks).

## Root cause
`createRecords` (app/api/airtable/route.js:162) wrapped each record as
`{ fields: sanitizeFields(r) }`. When `r` was already `{fields:{...}}`, that produced
a record with ONE field literally named "fields" → Airtable 422 UNKNOWN_FIELD_NAME
→ batch fails → the one-at-a-time fallback re-wrapped the SAME broken shape
(`stringifyFields(rec.fields)` where `rec.fields` was the nested object) → also 422
→ record skipped. Net: empty result, but the handler still returns 200, so callers
saw success. The sibling `updateRecords` (line 203) already did it right:
`sanitizeFields(r.fields || r)`.

## Fix
Line 162 → `sanitizeFields(r.fields || r)`, mirroring updateRecords. Now accepts
BOTH `{fields:{...}}` (documented) and bare field-maps (what callers were forced to
use). Bare maps are unaffected (`r.fields` undefined → falls back to `r`). One-line,
no behavior change for existing callers.

## Prevention
When create + update share a record-normalization step, keep them symmetric. A
create path that returns 200 on an all-skipped batch hides failures — but widening
the input handling is the right fix here, not changing the status code (callers rely
on 200 + the records array; check `records.length`, not the status, to detect a
no-op create).
