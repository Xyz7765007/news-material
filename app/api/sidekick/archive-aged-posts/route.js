import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK — ARCHIVE AGED-OUT LINKEDIN POST TASKS
// POST /api/sidekick/archive-aged-posts
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>   (or ?key=<CRON_SECRET>)
//
// Body: { baseId: "appXYZ...", dryRun?: boolean, maxBatch?: number }
//
// PURPOSE (2026-06-09 post-freshness gate):
//   A linkedin_engagement task is keyed off the UNDERLYING POST's publish date
//   ({Post Date}), not the scan time. A post is 1-6 days old when fetched and
//   ages daily, so a task fetched at 6 days becomes 8 days two days later and
//   must NOT show in the chatbot feed. The feed/count filters already EXCLUDE
//   such tasks at read time (read-side guard — zero leak window). This endpoint
//   is the WRITE-side complement: it ARCHIVES those aged-out tasks so they
//   surface in SignalScope's in-app "Signal Review" tab.
//
//   Archiving = stamp a DISTINCT {Archived At} marker (NOT {Handled At}, which
//   means operator-handled — keeping them separate keeps analytics clean) +
//   copy the task into the "Signal Archive" table with Signal Status="aged_out".
//   The Signal Review tab unions Tasks + Signal Archive, so aged-out posts show
//   there. Tasks are NEVER deleted.
//
//   FAIL-SAFE: the read-side feed filter is the source of truth for "does it
//   show". This sweep is best-effort housekeeping; if it never runs, no stale
//   post ever leaks (the filter already hides them) — they just won't appear in
//   Signal Review until a sweep runs.
//
// Returns: { ok, baseId, scanned, archived, archivedIds[], dryRun }
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const AT_API = "https://api.airtable.com/v0";

function authOk(request, url) {
  const h = request.headers.get("authorization") || "";
  if (SIDEKICK_API_KEY && h === `Bearer ${SIDEKICK_API_KEY}`) return true;
  // Allow cron-secret auth too (so this can be chained from a scheduler).
  const key = url.searchParams.get("key");
  if (CRON_SECRET && (key === CRON_SECRET || h === `Bearer ${CRON_SECRET}`)) return true;
  return false;
}

// linkedin_engagement, not yet handled, not yet archived, with a Post Date that
// is >7 days old. Mirrors the negated POST_DATE_GATE used in the feed filter.
const AGED_FILTER = `AND(FIND("linkedin_engagement", {Task Type}), {Handled At} = BLANK(), {Archived At} = BLANK(), {Post Date} != BLANK(), NOT(IS_AFTER({Post Date}, DATEADD(NOW(), -7, 'days'))))`;

async function atCreateArchive(baseId, records) {
  // Airtable caps creates at 10/request. typecast lets the new "aged_out"
  // singleSelect option be created on the fly. Best-effort: a missing Signal
  // Archive table (or field) just means the copy is skipped — the task is still
  // archived via patchArchivedAt, and the read-side feed filter already hides it.
  for (let i = 0; i < records.length; i += 10) {
    let payload = records.slice(i, i + 10);
    // Auto-heal: drop one UNKNOWN_FIELD_NAME per retry; loop bounded by field count.
    for (let guard = 0; guard < 8; guard++) {
      const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Signal Archive")}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ records: payload, typecast: true }),
        cache: "no-store",
      });
      if (r.ok) break;
      const errText = await r.text();
      const m = errText.match(/Unknown field name:\s*"([^"]+)"/i);
      if (r.status === 422 && m) {
        const bad = m[1];
        payload = payload.map(rec => {
          const f = { ...rec.fields };
          delete f[bad];
          return { fields: f };
        });
        continue; // retry without the bad field
      }
      break; // table missing / other error — give up on the copy
    }
  }
}

async function patchArchivedAt(baseId, ids, stampISO) {
  // PATCH caps at 10/request. typecast keeps a stale schema from hard-erroring.
  for (let i = 0; i < ids.length; i += 10) {
    const batch = ids.slice(i, i + 10).map(id => ({ id, fields: { "Archived At": stampISO } }));
    await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ records: batch, typecast: true }),
      cache: "no-store",
    });
  }
}

export async function POST(request) {
  const url = new URL(request.url);
  if (!authOk(request, url)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY env var" }, { status: 500 });
  }

  let body = {};
  try { body = await request.json(); } catch { /* body optional */ }
  const baseId = body.baseId || url.searchParams.get("baseId");
  const dryRun = !!body.dryRun;
  const maxBatch = Math.min(Math.max(parseInt(body.maxBatch, 10) || 100, 1), 200);
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  try {
    // 1. Find aged-out linkedin_engagement tasks.
    const params = new URLSearchParams({ filterByFormula: AGED_FILTER, pageSize: String(maxBatch) });
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
        return NextResponse.json({ ok: true, baseId, scanned: 0, archived: 0, note: "Tasks table not found" });
      }
      // Post Date / Archived At not migrated yet → nothing to do (read-side filter
      // also can't gate, but un-migrated bases predate the linkedin_engagement
      // post-date write, so there are no aged-out-by-post-date tasks to archive).
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: true, baseId, scanned: 0, archived: 0, needsSetup: true, note: "Post Date / Archived At fields missing. Run POST /api/setup-fix." });
      }
      return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }
    const data = await r.json();
    const records = data.records || [];
    if (records.length === 0) {
      return NextResponse.json({ ok: true, baseId, scanned: 0, archived: 0, archivedIds: [], dryRun });
    }
    if (dryRun) {
      return NextResponse.json({ ok: true, baseId, scanned: records.length, archived: 0, archivedIds: records.map(r => r.id), dryRun: true });
    }

    // 2. Copy each into Signal Archive (status aged_out). Best-effort.
    const archiveRecords = records.map(rec => {
      const f = rec.fields || {};
      return {
        fields: {
          Company: f.Company || f.Name || "",
          "Signal Status": "aged_out",
          Score: typeof f.Score === "number" ? f.Score : undefined,
          "Score Reason": f["Score Reason"] || "",
          Signal: f.Signal || "",
          "Task Rule": f["Task Rule"] || "",
          "Task Type": f["Task Type"] || "linkedin_engagement",
          Source: f.Source || "",
          URL: f.URL || f["Post URL"] || f["Signal URL"] || "",
          "Scan Target": f["Scan Target"] || "",
          "Account ID": f["Account ID"] || "",
          "Lead Title": f["Lead Title"] || "",
          Date: f["Post Date"] || f.Date || "",   // surface the post's own date
          Created: new Date().toISOString(),       // archived-at time
        },
      };
    });
    await atCreateArchive(baseId, archiveRecords);

    // 3. Stamp Archived At on the source tasks (distinct from Handled At).
    const stampISO = new Date().toISOString();
    const ids = records.map(rec => rec.id);
    await patchArchivedAt(baseId, ids, stampISO);

    return NextResponse.json({ ok: true, baseId, scanned: records.length, archived: ids.length, archivedIds: ids, archivedAt: stampISO, dryRun: false });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
