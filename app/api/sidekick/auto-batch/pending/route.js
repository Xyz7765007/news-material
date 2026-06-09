import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK AUTO-BATCH PENDING
// GET /api/sidekick/auto-batch/pending?baseId=X
//
// Returns active batches (records in "Outreach" with Status=pending_approval),
// grouped by Batch ID, with all pre-generated drafts inline so the chatbot
// can render them without a second roundtrip.
//
// ALSO returns `outreach_queue` (added 2026-06-09, Kunal Batch-2 #18/#19): the
// IN-FLIGHT Outreach records that need a MANUAL action by the exec on LinkedIn,
// each annotated with a computed `nextAction` so the frontend knows what to
// render (send connection / mark accepted / send DM N / waiting). This drives
// the manual-with-assist outreach card. The existing `batches` shape is
// unchanged — `outreach_queue` is purely additive.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

export async function GET(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  }

  try {
    // Pull pending_approval (for `batches`) AND the in-flight manual-assist
    // statuses (for `outreach_queue`) in one paged list. We filter client-side
    // by Status so we never depend on a sort field existing.
    const records = await atListAll(baseId, "Outreach");
    const pending = records.filter(r => (r.fields?.Status || "") === "pending_approval");
    return NextResponse.json({
      ok: true,
      batches: groupBatches(pending),
      outreach_queue: buildOutreachQueue(records),
    });
  } catch (e) {
    if (/INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/.test(String(e.message))) {
      // Outreach table doesn't exist yet in this base — degrade gracefully.
      return NextResponse.json({ ok: true, batches: [], outreach_queue: [] });
    }
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// Paged list of all records in a table (no sort dependency).
async function atListAll(baseId, table) {
  const all = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: "100" });
    if (offset) qs.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`Airtable ${r.status}: ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

// ── Manual-with-assist queue ───────────────────────────────────────
// For each in-flight Outreach record, compute the single next manual action
// the exec must perform on LinkedIn. NO automation — the exec sends by hand.
//
// nextAction.type:
//   "connection" — send the connection request (queued / pending_approval / connection_sent-not-yet pre)
//   "accept"     — connection request sent, mark when accepted
//   "dm"         — a DM step is DUE (step 1/2/3)
//   "waiting"    — a DM step is scheduled but not yet due (show countdown)
//
// Due check: Next Action Date empty OR <= today (YYYY-MM-DD lexical compare,
// both ISO dates, is correct).
function buildOutreachQueue(records) {
  const today = new Date().toISOString().slice(0, 10);
  const isDue = (dateVal) => {
    const d = String(dateVal || "").slice(0, 10);
    return !d || d <= today;
  };

  const out = [];
  for (const rec of records) {
    const f = rec.fields || {};
    const status = f.Status || "";
    const mode = f.Mode || "";
    const linkedinUrl = f["LinkedIn URL"] || "";
    const nextDate = f["Next Action Date"] || "";

    // Manual-assist queue ONLY surfaces records the cron will NOT touch
    // (Mode === "manual"). Auto/auto_batch records are cron-driven and must
    // never appear as manual cards — that would double-send. pending_approval
    // records are not approved yet and belong only in `batches` (DailyBatchCard).
    if (mode !== "manual") continue;

    let nextAction = null;

    if (status === "queued") {
      // Approved + flipped to manual — the next manual move is to send the
      // connection request. messageToCopy comes from the GENERATED note ONLY
      // (never summary/signal/score_reason).
      nextAction = {
        type: "connection",
        label: "Send connection request",
        messageToCopy: f["Generated Connection Note"] || "",
        linkedinUrl,
      };
    } else if (status === "connection_sent") {
      nextAction = {
        type: "accept",
        label: "Mark when accepted",
        messageToCopy: null,
        linkedinUrl,
      };
    } else if (status === "connected") {
      if (isDue(nextDate)) {
        nextAction = { type: "dm", step: 1, label: "Send DM 1", messageToCopy: f["Generated DM 1"] || "", linkedinUrl };
      } else {
        nextAction = { type: "waiting", step: 1, label: "DM 1 scheduled", dueDate: nextDate, linkedinUrl };
      }
    } else if (status === "dm_1") {
      if (isDue(nextDate)) {
        nextAction = { type: "dm", step: 2, label: "Send DM 2", messageToCopy: f["Generated DM 2"] || "", linkedinUrl };
      } else {
        nextAction = { type: "waiting", step: 2, label: "DM 2 scheduled", dueDate: nextDate, linkedinUrl };
      }
    } else if (status === "dm_2") {
      if (isDue(nextDate)) {
        nextAction = { type: "dm", step: 3, label: "Send DM 3", messageToCopy: f["Generated DM 3"] || "", linkedinUrl };
      } else {
        nextAction = { type: "waiting", step: 3, label: "DM 3 scheduled", dueDate: nextDate, linkedinUrl };
      }
    }

    // Skip terminal/irrelevant statuses (completed, replied, skipped, error, etc.)
    if (!nextAction) continue;

    out.push({
      id: rec.id,
      lead_name: f["Lead Name"] || "Unknown",
      company: f.Company || "",
      title: f.Title || "",
      signal: f.Signal || "",
      message: nextAction.messageToCopy || "",
      linkedin_url: linkedinUrl,
      status,
      dueDate: nextDate,
      nextAction,
    });
  }

  // Due items first (connection / accept / dm), then waiting items.
  const order = { connection: 0, accept: 1, dm: 2, waiting: 3 };
  out.sort((a, b) => (order[a.nextAction.type] ?? 9) - (order[b.nextAction.type] ?? 9));
  return out;
}

function groupBatches(records) {
  // The connection note generated by deterministicFallback when AI fails
  // is a fixed-shape sentence. If a lead's note matches this pattern,
  // their personalization fell back — flag it so the chatbot can show
  // a warning and the operator can review the AI Debug field on the
  // Outreach record to find the root cause.
  //
  // Pattern: "Hi {firstName} — noticed your work at {company}. Would like to connect."
  const FALLBACK_CONNECTION_NOTE = /^Hi .+ — noticed your work at .+\. Would like to connect\.$/;
  const FALLBACK_DM1 = /^Thanks for connecting .+\. Curious how you're thinking about outbound at .+ this year\?$/;
  const FALLBACK_DM2 = /^Following up .+ — happy to share a quick teardown of how similar teams at .+'s scale are running outbound\. Would that be useful\?$/;
  const FALLBACK_DM3 = /^Last one .+ — no pressure\. If outbound is on the roadmap this year, I'd be glad to share what's working\. Either way, all the best\.$/;

  // Group by Batch ID
  const byBatch = new Map();
  for (const rec of records) {
    const f = rec.fields || {};
    const batchId = f["Batch ID"] || "no_batch";
    if (!byBatch.has(batchId)) byBatch.set(batchId, []);

    const connectionNote = f["Generated Connection Note"] || "";
    const dm1 = f["Generated DM 1"] || "";
    const dm2 = f["Generated DM 2"] || "";
    const dm3 = f["Generated DM 3"] || "";

    // Per-message fallback detection
    const fallbackFlags = {
      connection_note: FALLBACK_CONNECTION_NOTE.test(connectionNote),
      dm1: FALLBACK_DM1.test(dm1),
      dm2: FALLBACK_DM2.test(dm2),
      dm3: FALLBACK_DM3.test(dm3),
    };
    const allFallback = fallbackFlags.connection_note && fallbackFlags.dm1 && fallbackFlags.dm2 && fallbackFlags.dm3;
    const anyFallback = fallbackFlags.connection_note || fallbackFlags.dm1 || fallbackFlags.dm2 || fallbackFlags.dm3;

    byBatch.get(batchId).push({
      id: rec.id,
      lead_name: f["Lead Name"] || "Unknown",
      company: f.Company || "",
      title: f.Title || "",
      email: f.Email || "",
      linkedin_url: f["LinkedIn URL"] || "",
      post_url: f["Post URL"] || "",
      composite_score: f["Composite Score"] || 0,
      why_reasons: f["Why Reasons"] || "",
      connection_note: connectionNote,
      dm1,
      dm2,
      dm3,
      created_at: f["Created At"] || "",
      // AI personalization status — surface to chatbot so the operator
      // sees which leads were templated rather than personalized.
      ai_fallback_flags: fallbackFlags,
      ai_all_fallback: allFallback,
      ai_any_fallback: anyFallback,
      // Truncated AI Debug field so the chatbot can show why it fell back.
      // Full debug is on the Outreach record in Airtable.
      ai_debug: String(f["AI Debug"] || "").slice(0, 600),
    });
  }

  const batches = [];
  for (const [batchId, leads] of byBatch.entries()) {
    // Sort within batch by composite score desc
    leads.sort((a, b) => (b.composite_score || 0) - (a.composite_score || 0));
    batches.push({
      batch_id: batchId,
      count: leads.length,
      leads,
    });
  }

  // Sort batches by ID desc (most recent first)
  batches.sort((a, b) => (b.batch_id || "").localeCompare(a.batch_id || ""));
  return batches;
}
