import { NextResponse } from "next/server";
import { RELEVANCE_KINDS, RELEVANCE_TABLE, fetchActiveRelevanceRules } from "@/lib/relevance-rules.js";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK RELEVANCE RULES ENDPOINT  (universal relevance feedback)
// POST /api/sidekick/relevance   — create OR deactivate a rule
// GET  /api/sidekick/relevance   — list active rules
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Lets the operator give feedback on ANYTHING (a bad title, an unwanted
// company, an irrelevant signal type, or a fit-score correction) and have
// it ENFORCED on the chatbot feed + count — RETROACTIVE + forward +
// REVERSIBLE. Rules live in the per-campaign `Sidekick Relevance Rules`
// table. Enforcement happens in /api/sidekick/feed + /count (read filter
// is the source of truth). See lib/relevance-rules.js.
//
// ─── POST create ───────────────────────────────────────────────────
//   { baseId, kind, value, targetScore?, note? }
//   kind ∈ title_irrelevant | company_irrelevant | signal_irrelevant | role_fit
//   - value: the title string / company name / signal-or-movement type;
//            for role_fit it's the title fragment to match.
//   - targetScore: required for role_fit (the served-score override 0-100).
//   → { ok:true, id, kind, value }
//
// ─── POST deactivate (reversibility) ───────────────────────────────
//   { baseId, ruleId, active:false }   (action discriminator = presence of ruleId)
//   Toggles a rule's Active checkbox off so it stops suppressing/overriding.
//   Pass active:true to re-enable.
//   → { ok:true, id, active }
//
// ─── GET list ──────────────────────────────────────────────────────
//   /api/sidekick/relevance?baseId=...&limit=200
//   → { ok:true, count, rules:[ { id, kind, value, targetScore, note, active,
//                                 created, createdBy } ] }  most-recent-first
//
// Degrades GRACEFULLY: if the table/fields are missing, POST returns
// { ok:false, needsSetup:true } (412) — never 500. GET returns
// { ok:true, rules:[] } so the UI shows "no rules yet".
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

// Map an Airtable error to the graceful "needs setup" shape (412) when the
// table or a field is missing — mirrors the feedback route pattern.
function needsSetupResponse(status, errText) {
  if (status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
    return NextResponse.json({ ok: false, error: `${RELEVANCE_TABLE} fields missing. Run POST /api/setup-fix.`, needsSetup: true }, { status: 412 });
  }
  if (status === 404 || (status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"))) {
    return NextResponse.json({ ok: false, error: `${RELEVANCE_TABLE} table not found. Run POST /api/setup-fix.`, needsSetup: true }, { status: 412 });
  }
  return null;
}

export async function POST(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

  const { baseId, kind, value, targetScore, note, ruleId, active } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  // ─── Deactivate / re-activate path (action discriminator: ruleId present) ──
  if (ruleId) {
    const nextActive = active !== false; // default true unless explicitly false
    try {
      const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(RELEVANCE_TABLE)}/${ruleId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { Active: nextActive }, typecast: true }),
        cache: "no-store",
      });
      if (!r.ok) {
        const errText = await r.text();
        const ns = needsSetupResponse(r.status, errText);
        if (ns) return ns;
        if (r.status === 404) return NextResponse.json({ ok: false, error: `Rule ${ruleId} not found` }, { status: 404 });
        return NextResponse.json({ ok: false, error: `Airtable ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
      }
      const data = await r.json();
      return NextResponse.json({ ok: true, id: data.id, active: nextActive });
    } catch (e) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
    }
  }

  // ─── Create path ──────────────────────────────────────────────────
  const k = String(kind || "").toLowerCase().trim();
  if (!RELEVANCE_KINDS.includes(k)) {
    return NextResponse.json({ ok: false, error: `kind must be one of: ${RELEVANCE_KINDS.join(", ")}` }, { status: 400 });
  }
  const val = typeof value === "string" ? value.trim() : "";
  if (!val) return NextResponse.json({ ok: false, error: "value required" }, { status: 400 });

  let target = null;
  if (k === "role_fit") {
    const n = Number(targetScore);
    if (!Number.isFinite(n)) {
      return NextResponse.json({ ok: false, error: "targetScore (number) required for role_fit" }, { status: 400 });
    }
    target = Math.max(0, Math.min(100, Math.round(n)));
  }

  const nowISO = new Date().toISOString();
  const fields = {
    Name: `${k}: ${val.slice(0, 60)}`.slice(0, 100),
    Kind: k,
    Value: val.slice(0, 500),
    Active: true,
    Created: nowISO,
    "Created By": "sidekick-chatbot",
  };
  if (target != null) fields["Target Score"] = target;
  if (note && typeof note === "string" && note.trim()) fields.Note = note.slice(0, 2000);

  try {
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(RELEVANCE_TABLE)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      const ns = needsSetupResponse(r.status, errText);
      if (ns) return ns;
      return NextResponse.json({ ok: false, error: `Airtable ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }
    const data = await r.json();
    return NextResponse.json({ ok: true, id: data.id, kind: k, value: val });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function GET(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!AIRTABLE_KEY) return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  const limit = url.searchParams.get("limit") || "200";

  // fetchActiveRelevanceRules never throws → [] on missing table, so GET
  // degrades to an empty list rather than erroring.
  const rules = await fetchActiveRelevanceRules(baseId, limit);
  return NextResponse.json({ ok: true, count: rules.length, rules });
}
