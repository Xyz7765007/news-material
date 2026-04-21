import { NextResponse } from "next/server";

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const EXPORT_API_KEY = process.env.EXPORT_API_KEY; // Set this in Vercel — used to auth the Apps Script calls
const AT_API = "https://api.airtable.com/v0";
const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

async function atList(baseId, table) {
  let all = [], offset = null;
  do {
    const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}${offset ? "?offset=" + offset : ""}`;
    const res = await fetch(url, { headers: atHdr });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Airtable error ${res.status}: ${err.slice(0, 300)}`);
    }
    const d = await res.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

// CORS headers so Apps Script can read the response
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS });
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const apiKey = searchParams.get("apiKey") || request.headers.get("x-api-key");
    const campaignId = searchParams.get("campaignId"); // master Campaigns record ID
    const campaignName = searchParams.get("campaign"); // friendly name fallback
    const since = searchParams.get("since"); // optional ISO date filter

    // Auth check
    if (!EXPORT_API_KEY) {
      return NextResponse.json({ error: "EXPORT_API_KEY not configured on server" }, { status: 500, headers: CORS });
    }
    if (apiKey !== EXPORT_API_KEY) {
      return NextResponse.json({ error: "Invalid or missing API key. Pass ?apiKey=YOUR_KEY or X-API-Key header." }, { status: 401, headers: CORS });
    }

    // Fetch campaigns to resolve baseId
    const campaigns = await atList(MASTER_BASE_ID, "Campaigns");

    // Determine which campaigns to export
    let targetCampaigns = [];
    if (campaignId) {
      const c = campaigns.find(c => c.id === campaignId);
      if (c) targetCampaigns = [c];
    } else if (campaignName) {
      const c = campaigns.find(c => (c.fields?.Name || "").toLowerCase() === campaignName.toLowerCase());
      if (c) targetCampaigns = [c];
    } else {
      targetCampaigns = campaigns;
    }

    if (targetCampaigns.length === 0) {
      return NextResponse.json({ error: "No matching campaign found", availableCampaigns: campaigns.map(c => c.fields?.Name) }, { status: 404, headers: CORS });
    }

    const allRows = [];
    const errors = [];

    for (const camp of targetCampaigns) {
      const baseId = camp.fields?.["Base ID"];
      const campName = camp.fields?.Name || "Unknown";
      if (!baseId) { errors.push(`${campName}: no Base ID configured`); continue; }

      try {
        const items = await atList(baseId, "Outreach");
        for (const item of items) {
          const f = item.fields || {};
          // Optional date filter
          if (since && f["Created At"] && f["Created At"] < since) continue;

          allRows.push({
            campaign: campName,
            leadName: f["Lead Name"] || "",
            title: f.Title || "",
            company: f.Company || "",
            linkedinUrl: f["LinkedIn URL"] || "",
            email: f.Email || "",
            mode: f.Mode || "",
            status: f.Status || "",
            connectionSentAt: f["Connection Sent At"] || "",
            connectionAcceptedAt: f["Connection Accepted At"] || "",
            dmStep: f["DM Step"] || 0,
            lastDmSentAt: f["Last DM Sent At"] || "",
            repliedAt: f["Replied At"] || "",
            nextActionDate: f["Next Action Date"] || "",
            signal: f.Signal || "",
            notes: f.Notes || "",
            unipileChatId: f["Unipile Chat ID"] || "",
            createdAt: f["Created At"] || "",
            airtableRecordId: item.id,
          });
        }
      } catch (e) {
        errors.push(`${campName}: ${e.message}`);
      }
    }

    // Sort newest first
    allRows.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

    return NextResponse.json({
      ok: true,
      count: allRows.length,
      campaigns: targetCampaigns.map(c => c.fields?.Name),
      exportedAt: new Date().toISOString(),
      rows: allRows,
      errors: errors.length > 0 ? errors : undefined,
    }, { headers: CORS });
  } catch (e) {
    console.error("[export/outreach] error:", e);
    return NextResponse.json({ error: e.message }, { status: 500, headers: CORS });
  }
}
