import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK DMS-SENT ENDPOINT  ("DMs sent" review card — sibling of connections-sent)
// GET  /api/sidekick/dms-sent?baseId={veloka_base}&campaignId={master_rec}
// POST /api/sidekick/dms-sent   { action, ... }
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Mirrors /api/sidekick/connections-sent exactly, but counts DMs that have gone
// out (Outreach rows with a "Last DM Sent At") for Campaign "Veloka Connect"
// instead of connection requests. "since last marked done" persists as
// `DMs Card Marked Done At` on the MASTER Campaigns row.
//
// GET returns:
//   { ok, count, past24h, leads:[{name,title,company,linkedin,website,employees,
//     employee_range,dm_step,last_dm_at}] (<=10, newest first), lastMarkedDone }
//   count   = Veloka Connect Outreach rows with Last DM Sent At > lastMarkedDone.
//   past24h = subset within the recent window (72h) — the frontend visibility gate.
//
// POST: { action:"mark_done", at? } | { action:"exclude_lead", leadName?, linkedin? }
// Airtable conventions: FLAT create, update={id,fields}, JS date compare.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AT_API = "https://api.airtable.com/v0";
const AT_META = "https://api.airtable.com/v0/meta";

const DEFAULT_CAMPAIGN_RECORD = "recV0RlBHUmrhtVq2";
const CONNECT_CAMPAIGN = "Veloka Connect";
const MARKED_DONE_FIELD = "DMs Card Marked Done At";
// Recent-window for the visibility gate (matches connections-sent: 72h).
const DAY_MS = 72 * 60 * 60 * 1000;

const atHdr = {
  Authorization: `Bearer ${AIRTABLE_KEY}`,
  "Content-Type": "application/json",
};

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

async function atList(baseId, table, filterByFormula, sortField) {
  const qs = new URLSearchParams();
  if (filterByFormula) qs.set("filterByFormula", filterByFormula);
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
    /* best-effort */
  }
}

const num = (s) => {
  const t = Date.parse(s || "");
  return Number.isFinite(t) ? t : 0;
};

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

    let lastMarkedDone = null;
    if (MASTER_BASE_ID) {
      const campFields = await atGet(MASTER_BASE_ID, "Campaigns", campaignId);
      const v = campFields ? campFields[MARKED_DONE_FIELD] : null;
      if (v && Date.parse(v)) lastMarkedDone = v;
    }
    const lastMs = num(lastMarkedDone);
    const dayAgoMs = Date.now() - DAY_MS;

    // Every DM that ACTUALLY WENT OUT — keyed on the presence of "Last DM Sent At"
    // for the Veloka Connect campaign. (JS date compare — Airtable IS_AFTER is buggy.)
    const filter = `AND({Campaign} = "${CONNECT_CAMPAIGN}", {Last DM Sent At})`;
    const rows = await atList(baseId, "Outreach", filter, "Last DM Sent At");

    const sinceDone = rows
      .map((r) => ({ f: r.fields || {}, ms: num((r.fields || {})["Last DM Sent At"]) }))
      .filter((x) => x.ms > 0 && x.ms > lastMs)
      .sort((a, b) => b.ms - a.ms);

    const count = sinceDone.length;
    const past24h = sinceDone.filter((x) => x.ms > dayAgoMs).length;

    const leads = sinceDone.slice(0, 10).map((x) => ({
      name: x.f["Lead Name"] || "",
      title: x.f.Title || "",
      company: x.f.Company || "",
      linkedin: x.f["LinkedIn URL"] || "",
      dm_step: typeof x.f["DM Step"] === "number" ? x.f["DM Step"] : parseInt(x.f["DM Step"] || "0", 10) || 0,
      last_dm_at: x.f["Last DM Sent At"] || "",
    }));

    // Enrich the <=10 shown leads with company website + employee size from Leads.
    try {
      const names = [...new Set(leads.map((l) => l.name).filter(Boolean))];
      if (names.length) {
        const esc = (s) => String(s).replace(/"/g, '\\"');
        const formula = `OR(${names.map((n) => `{Name}="${esc(n)}"`).join(",")})`;
        const leadRows = await atList(baseId, "Leads", formula, null);
        const byName = new Map();
        for (const r of leadRows) {
          const lf = r.fields || {};
          const key = (lf.Name || "").trim().toLowerCase();
          if (key && !byName.has(key)) byName.set(key, lf);
        }
        const withScheme = (u) => {
          const s = (u || "").trim();
          if (!s) return "";
          return /^https?:\/\//i.test(s) ? s : `https://${s}`;
        };
        for (const l of leads) {
          const lf = byName.get((l.name || "").trim().toLowerCase());
          if (!lf) continue;
          l.website = withScheme(lf["Company Website"]);
          l.company_linkedin = lf["Company Linkedin"] || "";
          const cnt = lf["Employee count"];
          l.employees = cnt != null && cnt !== "" ? String(cnt) : "";
          l.employee_range = lf["Employee Range"] || "";
        }
      }
    } catch { /* best-effort enrichment */ }

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

  if (action === "mark_done") {
    if (!MASTER_BASE_ID) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_BASE_ID env var" }, { status: 500 });
    try {
      await ensureMarkedDoneField();
      const at = body.at && Date.parse(body.at) ? new Date(body.at).toISOString() : new Date().toISOString();
      await atUpdate(MASTER_BASE_ID, "Campaigns", campaignId, { [MARKED_DONE_FIELD]: at });
      return NextResponse.json({ ok: true, markedDoneAt: at });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  if (action === "exclude_lead") {
    if (!baseId) return NextResponse.json({ ok: true, excluded: false, note: "baseId required to exclude" });
    const leadName = String(body.leadName || "").trim();
    const linkedin = String(body.linkedin || "").trim();
    if (!leadName && !linkedin) return NextResponse.json({ ok: true, excluded: false, note: "no lead identified" });
    try {
      let match = null;
      if (leadName) {
        const safe = leadName.replace(/"/g, '\\"');
        const rows = await atList(baseId, "Leads", `LOWER({Name}) = "${safe.toLowerCase()}"`);
        match = rows[0] || null;
      }
      if (!match && linkedin) {
        const wanted = normLi(linkedin);
        const slug = wanted.split("linkedin.com/").pop();
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
      return NextResponse.json({ ok: true, excluded: false, note: e.message });
    }
  }

  return NextResponse.json({ ok: false, error: "unknown action" }, { status: 400 });
}
