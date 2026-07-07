import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK CONNECTIONS-SENT ENDPOINT  (Kunal — "connection requests sent" card)
// GET  /api/sidekick/connections-sent?baseId={veloka_base}&campaignId={master_rec}
// POST /api/sidekick/connections-sent   { action, ... }
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// The chatbot surfaces a single "N connection requests have gone out" card.
// Data source: the Veloka per-campaign base `Outreach` table — our sends carry
// Campaign="Veloka Connect", Status="connection_sent", with Connection Sent At.
//
// "since last marked done" is persisted as `Connections Card Marked Done At`
// (ISO) on the MASTER Campaigns row (base AIRTABLE_BASE_ID, record campaignId —
// same row the AI-usage counters live on, per lib/ai-usage.js). Marking the card
// done stamps that field to now → the count resets.
//
// GET returns:
//   { ok, count, past24h, leads:[{name,title,company,linkedin}] (<=10, newest
//     first), lastMarkedDone }
//   count    = Outreach rows (Veloka Connect / connection_sent) with
//              Connection Sent At > lastMarkedDone.
//   past24h  = the VISIBILITY-GATE input — the subset of `count` also sent within
//              the last 24h (so after Mark-as-done the gate falls to 0 and the
//              card only returns once 5+ NEW requests have gone out, matching the
//              approved mockup's copy).
//   leads    = the 10 most-recent of the `count` set (public facts only).
//
// POST:
//   { action:"mark_done", campaignId?, at? }   → set marked-done timestamp
//        (to `at` if given, else now — `at` lets the UI's Undo restore the
//        previous value). Resets the count.
//   { action:"exclude_lead", leadName?, linkedin? } → set the Lead's
//        `Outreach Status = "excluded"` on the Leads table (best-effort,
//        non-blocking — already honoured by the "Veloka Outreach Top 8" rule
//        to drop the lead from future outreach).
//
// Airtable notes (repo conventions): FLAT create shape, update = {id,fields},
// and the date comparison is done in JS — Airtable's IS_AFTER has known quirks
// on this data (see .learnings/2026-06-09-airtable-date-blank-quirk.md).
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AT_API = "https://api.airtable.com/v0";
const AT_META = "https://api.airtable.com/v0/meta";

// Veloka's row in the master Campaigns table (the same record the scan driver
// and ai-usage counters target). Overridable via the campaignId param.
const DEFAULT_CAMPAIGN_RECORD = "recV0RlBHUmrhtVq2";
const CONNECT_CAMPAIGN = "Veloka Connect";
const CONNECT_STATUS = "connection_sent";
const MARKED_DONE_FIELD = "Connections Card Marked Done At";
const DAY_MS = 24 * 60 * 60 * 1000;

const atHdr = {
  Authorization: `Bearer ${AIRTABLE_KEY}`,
  "Content-Type": "application/json",
};

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// ─── Airtable helpers (local, mirror the repo's outreach/route.js pattern) ──
async function atList(baseId, table, filterByFormula, sortField) {
  const qs = new URLSearchParams();
  if (filterByFormula) qs.set("filterByFormula", filterByFormula);
  // Server-side newest-first sort so the "10 most recent" (and the count) stay
  // correct even if the connection_sent set ever exceeds the pagination cap.
  if (sortField) {
    qs.set("sort[0][field]", sortField);
    qs.set("sort[0][direction]", "desc");
  }
  qs.set("pageSize", "100");
  let all = [], offset = null, pages = 0;
  do {
    const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}${offset ? "&offset=" + offset : ""}`;
    const res = await fetch(url, { headers: atHdr, cache: "no-store" });
    if (!res.ok) {
      const errTxt = await res.text().catch(() => "");
      // Missing table (fresh base) → treat as empty rather than throwing.
      if (res.status === 403 && /INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/i.test(errTxt)) break;
      throw new Error(`Airtable list ${table} HTTP ${res.status}: ${errTxt.slice(0, 200)}`);
    }
    const d = await res.json();
    all.push(...(d.records || []));
    offset = d.offset;
    pages++;
  } while (offset && pages < 20);
  return all;
}

async function atGet(baseId, table, recordId) {
  const res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${recordId}`, {
    headers: atHdr,
    cache: "no-store",
  });
  if (!res.ok) return null;
  const d = await res.json().catch(() => null);
  return d && d.fields ? d.fields : null;
}

async function atUpdate(baseId, table, recordId, fields) {
  const res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${recordId}`, {
    method: "PATCH",
    headers: atHdr,
    body: JSON.stringify({ fields, typecast: true }),
    cache: "no-store",
  });
  if (!res.ok) {
    const errTxt = await res.text().catch(() => "");
    throw new Error(`Airtable update ${table} HTTP ${res.status}: ${errTxt.slice(0, 200)}`);
  }
  return res.json();
}

// Best-effort: auto-create the marked-done field on the master Campaigns table
// if it's missing (setup-fix/meta pattern, memoized per cold start). Never fatal.
let _fieldEnsured = false;
async function ensureMarkedDoneField() {
  if (_fieldEnsured || !MASTER_BASE_ID || !AIRTABLE_KEY) return;
  try {
    const schemaRes = await fetch(`${AT_META}/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr, cache: "no-store" });
    if (!schemaRes.ok) return;
    const schema = await schemaRes.json();
    const camp = (schema.tables || []).find((t) => t.name === "Campaigns");
    if (!camp) return;
    const has = new Set((camp.fields || []).map((f) => f.name));
    if (!has.has(MARKED_DONE_FIELD)) {
      await fetch(`${AT_META}/bases/${MASTER_BASE_ID}/tables/${camp.id}/fields`, {
        method: "POST",
        headers: atHdr,
        body: JSON.stringify({ name: MARKED_DONE_FIELD, type: "singleLineText" }),
      });
    }
    _fieldEnsured = true;
  } catch {
    /* best-effort — the read still works with the field absent (lastMarkedDone null) */
  }
}

const num = (s) => {
  const t = Date.parse(s || "");
  return Number.isFinite(t) ? t : 0;
};

// Normalize a LinkedIn URL for tolerant matching (drop scheme/host casing,
// trailing slash, query) — mirrors the outreach dedup approach loosely.
function normLi(u) {
  return String(u || "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "")
    .split("?")[0]
    .trim();
}

// ─── GET ────────────────────────────────────────────────────────────
export async function GET(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY env var" }, { status: 500 });

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  const campaignId = url.searchParams.get("campaignId") || DEFAULT_CAMPAIGN_RECORD;
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId query param required" }, { status: 400 });

  try {
    await ensureMarkedDoneField();

    // 1. lastMarkedDone from the master Campaigns row (null if unset/missing).
    let lastMarkedDone = null;
    if (MASTER_BASE_ID) {
      const campFields = await atGet(MASTER_BASE_ID, "Campaigns", campaignId);
      const v = campFields ? campFields[MARKED_DONE_FIELD] : null;
      if (v && Date.parse(v)) lastMarkedDone = v;
    }
    const lastMs = num(lastMarkedDone);
    const dayAgoMs = Date.now() - DAY_MS;

    // 2. Our sent connection requests (exact-match filter; DATE compare in JS).
    const filter = `AND({Campaign} = "${CONNECT_CAMPAIGN}", {Status} = "${CONNECT_STATUS}")`;
    const rows = await atList(baseId, "Outreach", filter, "Connection Sent At");

    // 3. Since last marked done → the headline count. past24h = the gate input.
    const sinceDone = rows
      .map((r) => ({ f: r.fields || {}, ms: num((r.fields || {})["Connection Sent At"]) }))
      .filter((x) => x.ms > lastMs)
      .sort((a, b) => b.ms - a.ms);

    const count = sinceDone.length;
    const past24h = sinceDone.filter((x) => x.ms > dayAgoMs).length;

    const leads = sinceDone.slice(0, 10).map((x) => ({
      name: x.f["Lead Name"] || "",
      title: x.f.Title || "",
      company: x.f.Company || "",
      linkedin: x.f["LinkedIn URL"] || "",
    }));

    return NextResponse.json({ ok: true, count, past24h, leads, lastMarkedDone });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// ─── POST ───────────────────────────────────────────────────────────
export async function POST(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY env var" }, { status: 500 });

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { action } = body || {};
  const baseId = body.baseId;
  const campaignId = body.campaignId || DEFAULT_CAMPAIGN_RECORD;

  // ── Mark as done → stamp the master Campaigns row → count resets ──
  if (action === "mark_done") {
    if (!MASTER_BASE_ID) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_BASE_ID env var" }, { status: 500 });
    try {
      await ensureMarkedDoneField();
      // `at` lets the UI's Undo restore the PREVIOUS timestamp; default = now.
      const at = body.at && Date.parse(body.at) ? new Date(body.at).toISOString() : new Date().toISOString();
      await atUpdate(MASTER_BASE_ID, "Campaigns", campaignId, { [MARKED_DONE_FIELD]: at });
      return NextResponse.json({ ok: true, markedDoneAt: at });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  // ── Exclude a wrong lead → Outreach Status = "excluded" on Leads ──
  // Best-effort: a failure here must never block the operator; return ok:true
  // with excluded:false so the card's feedback still confirms it was received.
  if (action === "exclude_lead") {
    if (!baseId) return NextResponse.json({ ok: true, excluded: false, note: "baseId required to exclude" });
    const leadName = String(body.leadName || "").trim();
    const linkedin = String(body.linkedin || "").trim();
    if (!leadName && !linkedin) return NextResponse.json({ ok: true, excluded: false, note: "no lead identified" });
    try {
      // Filter server-side (Veloka has thousands of Leads — never page the whole
      // table). Exact Name first (the card always supplies the name), then the
      // LinkedIn slug as a fallback.
      let match = null;
      if (leadName) {
        const safe = leadName.replace(/"/g, '\\"');
        const rows = await atList(baseId, "Leads", `LOWER({Name}) = "${safe.toLowerCase()}"`);
        match = rows[0] || null;
      }
      if (!match && linkedin) {
        const wanted = normLi(linkedin);
        const slug = wanted.split("linkedin.com/").pop(); // e.g. "in/aditi-kothari"
        if (slug && slug.length > 3) {
          const safe = slug.replace(/"/g, '\\"');
          const rows = await atList(baseId, "Leads", `FIND("${safe}", LOWER({LinkedIn URL})) > 0`);
          match = rows.find((r) => normLi((r.fields || {})["LinkedIn URL"]) === wanted) || rows[0] || null;
        }
      }
      if (!match) return NextResponse.json({ ok: true, excluded: false, note: "lead not found" });
      await atUpdate(baseId, "Leads", match.id, { "Outreach Status": "excluded" });
      return NextResponse.json({ ok: true, excluded: true, leadId: match.id });
    } catch (e) {
      // Non-blocking: acknowledge without failing the request.
      return NextResponse.json({ ok: true, excluded: false, note: e.message });
    }
  }

  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
