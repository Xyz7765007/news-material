import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK AUTO-BATCH PENDING
// GET /api/sidekick/auto-batch/pending?baseId=X
//
// Returns active batches (records in "Outreach" with Status=pending_approval),
// grouped by Batch ID, with all pre-generated drafts inline so the chatbot
// can render them without a second roundtrip.
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
    const qs = new URLSearchParams({
      filterByFormula: "{Status} = 'pending_approval'",
      pageSize: "100",
      "sort[0][field]": "Composite Score",
      "sort[0][direction]": "desc",
    });
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}?${qs}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });

    if (!r.ok) {
      const t = await r.text();
      if (r.status === 403 && /INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/.test(t)) {
        return NextResponse.json({ ok: true, batches: [] });
      }
      // Sort field missing = degrade gracefully (no sort)
      if (r.status === 422) {
        const qs2 = new URLSearchParams({
          filterByFormula: "{Status} = 'pending_approval'",
          pageSize: "100",
        });
        const r2 = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}?${qs2}`, {
          headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
          cache: "no-store",
        });
        if (!r2.ok) return NextResponse.json({ ok: false, error: "Airtable error" }, { status: 502 });
        const d2 = await r2.json();
        return NextResponse.json({ ok: true, batches: groupBatches(d2.records || []) });
      }
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}` }, { status: 502 });
    }

    const d = await r.json();
    return NextResponse.json({ ok: true, batches: groupBatches(d.records || []) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

function groupBatches(records) {
  // Group by Batch ID
  const byBatch = new Map();
  for (const rec of records) {
    const f = rec.fields || {};
    const batchId = f["Batch ID"] || "no_batch";
    if (!byBatch.has(batchId)) byBatch.set(batchId, []);
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
      connection_note: f["Generated Connection Note"] || "",
      dm1: f["Generated DM 1"] || "",
      dm2: f["Generated DM 2"] || "",
      dm3: f["Generated DM 3"] || "",
      created_at: f["Created At"] || "",
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
