// ─── End-to-end trace of campaign discovery ────────────────────
// Dumps EXACTLY what /api/cron/outreach sees when it queries master Campaigns.
// No filtering, no interpretation — raw records straight from Airtable so we
// can see precisely which 4 campaigns it found and what's different about
// the test campaign that makes it invisible.
//
// USAGE: GET /api/debug-campaigns?key=<CRON_SECRET>

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const report = {
    envVars: {
      AIRTABLE_BASE_ID_value: MASTER_BASE_ID || "(NOT SET)",
      AIRTABLE_BASE_ID_length: MASTER_BASE_ID?.length || 0,
      AIRTABLE_BASE_ID_first8: MASTER_BASE_ID?.slice(0, 8) || "(empty)",
      AIRTABLE_BASE_ID_last8: MASTER_BASE_ID?.slice(-8) || "(empty)",
      AIRTABLE_API_KEY_set: !!AIRTABLE_KEY,
      AIRTABLE_API_KEY_prefix: AIRTABLE_KEY?.slice(0, 12) || "(empty)",
    },
    rawCampaignsApiCall: { url: null, status: null, recordCount: 0 },
    campaigns: [],
    schemaApiCall: { url: null, status: null, tables: [] },
    diagnosis: [],
  };

  if (!MASTER_BASE_ID || !AIRTABLE_KEY) {
    report.diagnosis.push("AIRTABLE_BASE_ID or AIRTABLE_API_KEY not set in Vercel env");
    return NextResponse.json(report, { status: 500 });
  }

  // ─── Call 1: Same call the cron makes ────────────────────────
  // Plain GET on /v0/{baseId}/Campaigns — no view, no filter, no pagination params
  const apiUrl = `https://api.airtable.com/v0/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}`;
  report.rawCampaignsApiCall.url = apiUrl;
  try {
    const r = await fetch(apiUrl, { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` } });
    report.rawCampaignsApiCall.status = r.status;
    if (!r.ok) {
      const t = await r.text();
      report.rawCampaignsApiCall.errorBody = t.slice(0, 500);
      report.diagnosis.push(`Campaigns API returned HTTP ${r.status}. This is the same error the cron would see.`);
      return NextResponse.json(report);
    }
    const d = await r.json();
    const records = d.records || [];
    report.rawCampaignsApiCall.recordCount = records.length;
    report.rawCampaignsApiCall.offset = d.offset || null;

    // Dump each campaign with its raw Features field exactly as Airtable returns it
    for (const camp of records) {
      const cf = camp.fields || {};
      const rawFeatures = cf.Features;
      const features = Array.isArray(rawFeatures)
        ? rawFeatures.map(s => String(s).trim())
        : String(rawFeatures || "").split(",").map(s => s.trim());
      report.campaigns.push({
        recordId: camp.id,
        name: cf.Name || "(no Name field)",
        baseId: cf["Base ID"] || "(no Base ID field)",
        Features_raw_value: rawFeatures,
        Features_raw_type: Array.isArray(rawFeatures) ? "array" : typeof rawFeatures,
        Features_parsed: features,
        Features_includes_linkedin_outreach: features.includes("linkedin_outreach"),
        all_field_names: Object.keys(cf),
      });
    }
  } catch (e) {
    report.rawCampaignsApiCall.error = e.message;
    report.diagnosis.push(`Campaigns API threw: ${e.message}`);
    return NextResponse.json(report);
  }

  // ─── Call 2: Schema meta API — lists tables in this base ─────
  // Useful to confirm we're pointed at the right base AND that Campaigns
  // table exists with the expected primary field
  const schemaUrl = `https://api.airtable.com/v0/meta/bases/${MASTER_BASE_ID}/tables`;
  report.schemaApiCall.url = schemaUrl;
  try {
    const r = await fetch(schemaUrl, { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` } });
    report.schemaApiCall.status = r.status;
    if (r.ok) {
      const d = await r.json();
      report.schemaApiCall.tables = (d.tables || []).map(t => ({
        name: t.name, id: t.id, fieldCount: t.fields?.length || 0,
      }));
      const campaignsTable = (d.tables || []).find(t => t.name === "Campaigns");
      if (campaignsTable) {
        report.schemaApiCall.campaignsFields = campaignsTable.fields.map(f => ({
          name: f.name, type: f.type,
          options: f.type === "singleSelect" || f.type === "multipleSelects"
            ? (f.options?.choices || []).map(c => c.name)
            : undefined,
        }));
      }
    } else {
      report.schemaApiCall.errorBody = (await r.text()).slice(0, 300);
    }
  } catch (e) {
    report.schemaApiCall.error = e.message;
  }

  // ─── Diagnosis ───────────────────────────────────────────────
  const outreachCampaigns = report.campaigns.filter(c => c.Features_includes_linkedin_outreach);
  report.diagnosis.push(`Campaigns API returned ${report.rawCampaignsApiCall.recordCount} record(s).`);
  report.diagnosis.push(`Of those, ${outreachCampaigns.length} have "linkedin_outreach" in Features.`);

  if (outreachCampaigns.length === 0) {
    report.diagnosis.push("⚠ ZERO campaigns matched linkedin_outreach. Common causes:");
    report.diagnosis.push("  1. The base in Vercel env (AIRTABLE_BASE_ID) is different from the base you're editing in Airtable UI");
    report.diagnosis.push("  2. The Features field on the test campaign row hasn't been saved");
    report.diagnosis.push("  3. The Features field value is 'linkedin-outreach' (hyphen) or has trailing whitespace");
    report.diagnosis.push("  4. The Features field is a different field type than expected (lookup, formula)");
  }

  // Look for typo-like mismatches
  for (const c of report.campaigns) {
    if (!c.Features_includes_linkedin_outreach) {
      const looksLike = c.Features_parsed.find(f => /linkedin/i.test(f) || /outreach/i.test(f));
      if (looksLike) {
        report.diagnosis.push(`⚠ Campaign "${c.name}" has Features value "${looksLike}" — close but not exact match for "linkedin_outreach"`);
      }
    }
  }

  // Detect pagination cutoff
  if (report.rawCampaignsApiCall.offset) {
    report.diagnosis.push(`⚠ Airtable returned an offset — your Campaigns table has more records than fit in one page. The cron currently doesn't paginate, so additional pages are not seen.`);
  }

  return NextResponse.json(report, { status: 200 });
}
