import { NextResponse } from "next/server";
import { rankLeadsForCall } from "@/lib/composite-score.js";
import { pickLeadField } from "@/lib/lead-fields.js";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK TOP-LEADS-TO-CALL
// GET /api/sidekick/top-leads-to-call?baseId=X&n=2
//
// Returns the N most-qualified leads with phones, where:
//   1. Movement-detected leads (hired/promoted in last 30d) preempt
//   2. Composite score (base + GA visit + LinkedIn engagement bonuses)
//      ranks the rest
//   3. Phone is a hard filter — leads without one are excluded
//
// Response includes "Why now" reasons array per lead so the chatbot can
// render full justification text (not just a phone number).
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

async function atListAll(baseId, table, filterByFormula = "") {
  const all = [];
  let offset = null;
  do {
    const qs = new URLSearchParams();
    if (filterByFormula) qs.set("filterByFormula", filterByFormula);
    qs.set("pageSize", "100");
    if (offset) qs.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) {
      const t = await r.text();
      // Missing table = empty (chatbot keeps working)
      if (r.status === 403 && /INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/.test(t)) return all;
      throw new Error(`Airtable ${table} ${r.status}: ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

export async function GET(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "AIRTABLE_API_KEY missing" }, { status: 500 });
  }

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  const n = Math.min(parseInt(url.searchParams.get("n") || "2", 10) || 2, 10);

  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  }

  try {
    // Load Leads + Tasks in parallel
    const [leads, tasks] = await Promise.all([
      atListAll(baseId, "Leads"),
      atListAll(baseId, "Tasks"),
    ]);

    const ranked = rankLeadsForCall({ leads, tasks, maxResults: n });

    const cards = ranked.map(({ lead, scoring, linkedinUrl, phone, needsPhoneEnrich, title, email }) => {
      const f = lead.fields || {};
      const movementTaskFields = scoring.movementTask?.fields || {};
      return {
        id: lead.id,
        lead_name: f.Name || f["Full Name"] || "Unknown",
        company: f.Company || "",
        lead_title: title || "",
        lead_email: email || "",
        lead_linkedin: linkedinUrl || "",
        lead_phone: phone || "",                 // empty when needs enrichment
        needs_phone_enrich: !!needsPhoneEnrich,  // chatbot renders Enrich CTA instead of Call
        score: scoring.score,
        base_score: scoring.baseScore,
        bonus: scoring.bonus,
        has_movement: scoring.hasMovement,
        movement_type: movementTaskFields["Movement Type"] || "",
        reasons: scoring.reasons,                  // "why now" array — full justifications
        why_summary: scoring.reasons.join(" · "),  // joined for compact display
      };
    });

    return NextResponse.json({
      ok: true,
      baseId,
      count: cards.length,
      cards,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
