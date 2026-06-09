import { NextResponse } from "next/server";
import {
  smartTruncate,
  fillMergeFields,
  CONNECTION_NOTE_SAFE_LIMIT,
  CONNECTION_NOTE_HARD_LIMIT,
  DM_SAFE_LIMIT,
  DM_HARD_LIMIT,
} from "@/lib/message-merge.js";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK AUTO-BATCH ACTION
// POST /api/sidekick/auto-batch/action
//   body: { baseId, batchId, action, recordId?, field?, newText?, sendMode? }
//
// sendMode ∈ {"manual","auto"} (DEFAULT "manual" — used by send_all/send_one):
//   "manual" → Mode="manual"     → manual-assist queue; cron SKIPS (exec sends by hand)
//   "auto"   → Mode="auto_batch" → cron auto-sends via Unipile (existing behavior)
//
// Actions:
//   "send_all"     → flip ALL pending_approval records in batch to queued
//   "send_one"     → flip ONE record (by recordId) to queued
//   "skip_all"     → mark all pending_approval in batch as skipped
//   "skip_one"     → mark one record as skipped
//   "edit"         → update one record's draft field. User edits are run
//                    through fillMergeFields (so {first_name} typed by user
//                    is resolved to real name) + smartTruncate (word-boundary
//                    truncation at LinkedIn's char limits).
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

const EDITABLE_FIELDS = new Set([
  "Generated Connection Note",
  "Generated DM 1",
  "Generated DM 2",
  "Generated DM 3",
]);

async function atList(baseId, table, filterByFormula = "") {
  const all = [];
  let offset = null;
  do {
    const qs = new URLSearchParams();
    if (filterByFormula) qs.set("filterByFormula", filterByFormula);
    qs.set("pageSize", "100");
    if (offset) qs.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}`, {
      headers: atHdr, cache: "no-store",
    });
    if (!r.ok) throw new Error(`AT list ${table} ${r.status}`);
    const d = await r.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

async function atGet(baseId, table, recordId) {
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${recordId}`, {
    headers: atHdr, cache: "no-store",
  });
  if (!r.ok) throw new Error(`AT get ${table}/${recordId} ${r.status}`);
  return r.json();
}

async function atUpdate(baseId, table, records) {
  const all = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: atHdr, body: JSON.stringify({ records: batch }),
    });
    if (!r.ok) console.error(`AT update ${table}:`, (await r.text()).slice(0, 300));
    else { const d = await r.json(); all.push(...(d.records || [])); }
  }
  return all;
}

export async function POST(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const { baseId, batchId, action, recordId, field, newText } = body;
  if (!baseId || !action) {
    return NextResponse.json({ ok: false, error: "baseId and action required" }, { status: 400 });
  }

  // sendMode controls whether the approved lead enters the manual-assist queue
  // (exec sends by hand — cron skips Mode==="manual") or the auto-send queue
  // (cron auto-sends via Unipile on Mode==="auto_batch"). DEFAULT is "manual"
  // because the team sends by hand. No Unipile calls happen here either way —
  // the auto path is handled entirely by the existing process_queue cron.
  const sendMode = body.sendMode === "auto" ? "auto" : "manual";
  const outreachMode = sendMode === "auto" ? "auto_batch" : "manual";
  const approvalNote = sendMode === "auto" ? "Approved (auto-send)" : "Approved (manual-assist)";

  const today = new Date().toISOString();

  try {
    if (action === "send_all") {
      if (!batchId) return NextResponse.json({ ok: false, error: "batchId required" }, { status: 400 });
      // Special value "all" means "all pending_approval regardless of Batch ID".
      // Used by the chatbot when multiple Batch IDs coexist in the pending pool
      // (e.g. yesterday's stragglers + today's fresh batch). The chatbot merges
      // them visually into one card; this matches that on the server.
      const filter = batchId === "all"
        ? `{Status} = 'pending_approval'`
        : `AND({Status} = 'pending_approval', {Batch ID} = '${batchId}')`;
      const records = await atList(baseId, "Outreach", filter);
      if (!records.length) return NextResponse.json({ ok: true, count: 0, message: "No pending records" });

      const updates = records.map(r => ({
        id: r.id,
        fields: {
          Status: "queued",
          Mode: outreachMode,
          "Next Action Date": new Date().toISOString().slice(0, 10),
          Notes: `${r.fields?.Notes || ""}\n[${today}] ${approvalNote} via batch send_all`.trim(),
        },
      }));
      const updated = await atUpdate(baseId, "Outreach", updates);
      return NextResponse.json({ ok: true, action: "send_all", count: updated.length, batchId });
    }

    if (action === "send_one") {
      if (!recordId) return NextResponse.json({ ok: false, error: "recordId required" }, { status: 400 });
      const rec = await atGet(baseId, "Outreach", recordId);
      if (rec.fields?.Status !== "pending_approval") {
        return NextResponse.json({ ok: false, error: `Record is not pending_approval (current: ${rec.fields?.Status})` }, { status: 400 });
      }
      const updated = await atUpdate(baseId, "Outreach", [{
        id: recordId,
        fields: {
          Status: "queued",
          Mode: outreachMode,
          "Next Action Date": new Date().toISOString().slice(0, 10),
          Notes: `${rec.fields?.Notes || ""}\n[${today}] ${approvalNote} via send_one`.trim(),
        },
      }]);
      return NextResponse.json({ ok: true, action: "send_one", recordId, count: updated.length });
    }

    if (action === "skip_all") {
      if (!batchId) return NextResponse.json({ ok: false, error: "batchId required" }, { status: 400 });
      const filter = batchId === "all"
        ? `{Status} = 'pending_approval'`
        : `AND({Status} = 'pending_approval', {Batch ID} = '${batchId}')`;
      const records = await atList(baseId, "Outreach", filter);
      const updates = records.map(r => ({
        id: r.id,
        fields: {
          Status: "skipped",
          Notes: `${r.fields?.Notes || ""}\n[${today}] Skipped via batch skip_all`.trim(),
        },
      }));
      const updated = await atUpdate(baseId, "Outreach", updates);
      return NextResponse.json({ ok: true, action: "skip_all", count: updated.length, batchId });
    }

    if (action === "skip_one") {
      if (!recordId) return NextResponse.json({ ok: false, error: "recordId required" }, { status: 400 });
      const rec = await atGet(baseId, "Outreach", recordId);
      const updated = await atUpdate(baseId, "Outreach", [{
        id: recordId,
        fields: {
          Status: "skipped",
          Notes: `${rec.fields?.Notes || ""}\n[${today}] Skipped via skip_one`.trim(),
        },
      }]);
      return NextResponse.json({ ok: true, action: "skip_one", recordId, count: updated.length });
    }

    if (action === "edit") {
      if (!recordId || !field || typeof newText !== "string") {
        return NextResponse.json({ ok: false, error: "recordId, field, newText required" }, { status: 400 });
      }
      if (!EDITABLE_FIELDS.has(field)) {
        return NextResponse.json({ ok: false, error: `field must be one of: ${[...EDITABLE_FIELDS].join(", ")}` }, { status: 400 });
      }
      const rec = await atGet(baseId, "Outreach", recordId);
      const oldText = rec.fields?.[field] || "";

      // ─── Merge-field safety pass on user edits ───────────────
      // If user types "{first_name}" thinking it'll resolve, fillMergeFields
      // catches it and substitutes the real name. Also catches any unresolved
      // bracket placeholder and replaces with "there" (vs leaking literal).
      const leadShim = {
        Name: rec.fields?.["Lead Name"] || "",
        Company: rec.fields?.Company || "",
        Title: rec.fields?.Title || "",
        "LinkedIn URL": rec.fields?.["LinkedIn URL"] || "",
      };
      const merged = fillMergeFields(newText.trim(), leadShim, rec.fields?.Signal || "", leadShim.Company);

      // ─── Length enforcement per message type ─────────────────
      // smartTruncate cuts at word boundaries instead of mid-word + "..."
      let safeText = merged;
      if (field === "Generated Connection Note") {
        if (safeText.length > CONNECTION_NOTE_HARD_LIMIT) {
          safeText = smartTruncate(safeText, CONNECTION_NOTE_SAFE_LIMIT);
        }
      }
      if (field.startsWith("Generated DM")) {
        if (safeText.length > DM_HARD_LIMIT) {
          safeText = smartTruncate(safeText, DM_SAFE_LIMIT);
        }
      }

      // Append to Edit History (capped at 100k chars total)
      const oldHistory = rec.fields?.["Edit History"] || "";
      const newHistoryEntry = `[${today}] ${field} (old): ${oldText.slice(0, 500)}`;
      const newHistory = oldHistory
        ? `${newHistoryEntry}\n${oldHistory}`.slice(0, 100000)
        : newHistoryEntry;

      const updated = await atUpdate(baseId, "Outreach", [{
        id: recordId,
        fields: {
          [field]: safeText,
          "Edit History": newHistory,
        },
      }]);
      return NextResponse.json({
        ok: true,
        action: "edit",
        recordId,
        field,
        newLength: safeText.length,
        truncated: safeText.length < merged.length,
        mergeFieldsResolved: merged !== newText.trim(),
        updated: updated.length,
      });
    }

    return NextResponse.json({ ok: false, error: `Unknown action: ${action}` }, { status: 400 });
  } catch (e) {
    console.error("[AUTO-BATCH ACTION]", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
