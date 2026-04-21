import { NextResponse } from "next/server";
import { JWT } from "google-auth-library";

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AT_API = "https://api.airtable.com/v0";
const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

// ═══════════════════════════════════════════════════════════════
// AIRTABLE HELPERS
// ═══════════════════════════════════════════════════════════════
async function atList(baseId, table) {
  let all = [], offset = null;
  do {
    const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}${offset ? "?offset=" + offset : ""}`;
    const res = await fetch(url, { headers: atHdr });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const d = await res.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

async function atUpdate(baseId, table, records) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) console.error("[GA] Airtable update failed:", await res.text());
  }
}

async function getCampaign(campaignId) {
  const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, { headers: atHdr });
  if (!r.ok) throw new Error(`Campaign not found: ${r.status}`);
  return r.json();
}

async function patchCampaign(campaignId, fields) {
  return fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
    method: "PATCH", headers: atHdr,
    body: JSON.stringify({ fields }),
  });
}

// Auto-create missing fields on the Campaigns table (handles upgrades without re-running Setup)
async function ensureCampaignFields(missingFieldNames) {
  // Map field name → type
  const TYPE_MAP = {
    "GA4 Property ID": "singleLineText",
    "GA Service Account JSON": "multilineText",
    "GA Last Sync": "singleLineText",
  };
  try {
    const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
    if (!tablesRes.ok) return false;
    const { tables } = await tablesRes.json();
    const campaignsTable = (tables || []).find(t => t.name === "Campaigns");
    if (!campaignsTable) return false;
    for (const fname of missingFieldNames) {
      const type = TYPE_MAP[fname] || "singleLineText";
      await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE_ID}/tables/${campaignsTable.id}/fields`, {
        method: "POST", headers: atHdr,
        body: JSON.stringify({ name: fname, type }),
      });
    }
    return true;
  } catch (e) {
    console.error("[ga] ensureCampaignFields failed:", e);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// GA4 DATA API
// ═══════════════════════════════════════════════════════════════
function parseServiceAccount(jsonStr) {
  try {
    const parsed = typeof jsonStr === "string" ? JSON.parse(jsonStr) : jsonStr;
    if (!parsed.client_email || !parsed.private_key) {
      throw new Error("JSON missing required fields (client_email, private_key)");
    }
    return parsed;
  } catch (e) {
    throw new Error("Invalid service account JSON: " + e.message);
  }
}

async function getGAClient(serviceAccountJson) {
  const sa = parseServiceAccount(serviceAccountJson);
  const client = new JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  });
  await client.authorize();
  return client;
}

// Pull last N days of GA data, broken down by Session campaign ID
async function fetchGADataByCustomCode(propertyId, serviceAccountJson, daysBack = 7) {
  const client = await getGAClient(serviceAccountJson);
  const url = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - daysBack);
  const fmt = (d) => d.toISOString().slice(0, 10);

  const requestBody = {
    dateRanges: [{ startDate: fmt(startDate), endDate: fmt(today) }],
    dimensions: [{ name: "sessionCampaignId" }],
    metrics: [
      { name: "sessions" },
      { name: "engagedSessions" },
      { name: "screenPageViews" },
      { name: "screenPageViewsPerSession" },
      { name: "userEngagementDuration" },
      { name: "averageSessionDuration" },
    ],
    dimensionFilter: {
      filter: {
        fieldName: "sessionCampaignId",
        stringFilter: { matchType: "FULL_REGEXP", value: ".+" }, // exclude empty
      },
    },
    limit: 10000,
  };

  const res = await client.request({
    url,
    method: "POST",
    data: requestBody,
  });

  // Also fetch last visit date per Custom Code
  const lastVisitBody = {
    dateRanges: [{ startDate: fmt(startDate), endDate: fmt(today) }],
    dimensions: [{ name: "sessionCampaignId" }, { name: "date" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: requestBody.dimensionFilter,
    limit: 50000,
  };
  const lvRes = await client.request({
    url,
    method: "POST",
    data: lastVisitBody,
  });

  // Parse response
  const rows = res.data.rows || [];
  const lvRows = lvRes.data.rows || [];

  // Build last-visit map: code -> latest date
  const lastVisitMap = {};
  for (const row of lvRows) {
    const code = row.dimensionValues?.[0]?.value || "";
    const date = row.dimensionValues?.[1]?.value || ""; // YYYYMMDD
    if (!code || !date) continue;
    if (!lastVisitMap[code] || date > lastVisitMap[code]) lastVisitMap[code] = date;
  }

  // Build per-code metrics map
  const metricsMap = {};
  for (const row of rows) {
    const code = row.dimensionValues?.[0]?.value || "";
    if (!code) continue;
    const m = row.metricValues || [];
    metricsMap[code] = {
      sessions: parseInt(m[0]?.value || 0),
      engagedSessions: parseInt(m[1]?.value || 0),
      views: parseInt(m[2]?.value || 0),
      viewsPerSession: parseFloat(m[3]?.value || 0),
      engagementTime: parseInt(m[4]?.value || 0), // seconds
      avgSessionDuration: parseFloat(m[5]?.value || 0), // seconds
      lastVisit: lastVisitMap[code] || null, // YYYYMMDD
    };
  }

  return metricsMap;
}

// Engagement Score formula: 0-100
// Weighted: Engagement Time (50%) + Engaged Sessions (30%) + Views/Session (20%)
function calculateEngagementScore(m) {
  if (!m || m.sessions === 0) return 0;
  // Normalize each metric to 0-100, then weight
  // Engagement time: 0s=0, 30s=50, 120s+=100
  const timeScore = Math.min(100, (m.engagementTime / 120) * 100);
  // Engaged sessions: 0=0, 1=50, 3+=100
  const engagedScore = Math.min(100, (m.engagedSessions / 3) * 100);
  // Views per session: 1=20, 3=60, 5+=100
  const viewsScore = Math.min(100, ((m.viewsPerSession - 1) / 4) * 100);
  return Math.round(timeScore * 0.5 + engagedScore * 0.3 + Math.max(0, viewsScore) * 0.2);
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, campaignId, baseId } = body;

    switch (action) {
      // ─── CONFIG: save/get/test GA4 setup ─────────────────────
      case "save_ga_config": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const fields = {};
        if (body.propertyId !== undefined) fields["GA4 Property ID"] = String(body.propertyId).trim();
        if (body.serviceAccountJson !== undefined) {
          if (body.serviceAccountJson.trim()) {
            try { parseServiceAccount(body.serviceAccountJson); } 
            catch (e) { return NextResponse.json({ error: e.message }, { status: 400 }); }
          }
          fields["GA Service Account JSON"] = body.serviceAccountJson.trim();
        }
        let res = await patchCampaign(campaignId, fields);

        // Auto-create missing fields if 422 — self-heals so user doesn't need to run Setup
        // Loop up to 5 times in case multiple fields are missing (Airtable reports them one at a time)
        let attempts = 0;
        while (res.status === 422 && attempts < 5) {
          attempts++;
          const errText = await res.text();
          const unknownFields = [];
          // Match: Unknown field name: "X" OR \"X\" OR 'X' — handles raw and escaped quotes
          const matches = errText.matchAll(/[Uu]nknown field name:?\s*\\?["']([^"'\\]+)\\?["']/g);
          for (const m of matches) unknownFields.push(m[1]);
          // Fallback: check if any of our target fields appear in the error text
          if (unknownFields.length === 0) {
            for (const fname of Object.keys(fields)) {
              if (errText.includes(fname)) unknownFields.push(fname);
            }
          }
          if (unknownFields.length === 0) break; // can't extract field name, give up
          const created = await ensureCampaignFields(unknownFields);
          if (!created) break;
          // Retry save
          res = await patchCampaign(campaignId, fields);
        }

        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Save failed (${res.status}): ${err.slice(0, 300)}` }, { status: 400 });
        }
        return NextResponse.json({ ok: true });
      }

      case "get_ga_config": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const camp = await getCampaign(campaignId);
        const f = camp.fields || {};
        const json = f["GA Service Account JSON"] || "";
        let serviceAccountEmail = "";
        if (json) {
          try { serviceAccountEmail = parseServiceAccount(json).client_email; } catch {}
        }
        return NextResponse.json({
          propertyId: f["GA4 Property ID"] || "",
          hasServiceAccount: !!json,
          serviceAccountEmail,
          lastSync: f["GA Last Sync"] || "",
        });
      }

      case "test_ga_connection": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const camp = await getCampaign(campaignId);
        const f = camp.fields || {};
        const propertyId = f["GA4 Property ID"];
        const json = f["GA Service Account JSON"];
        if (!propertyId) return NextResponse.json({ error: "GA4 Property ID not set" }, { status: 400 });
        if (!json) return NextResponse.json({ error: "Service Account JSON not set" }, { status: 400 });

        try {
          // Run a tiny test query (last 1 day, top-level metric)
          const client = await getGAClient(json);
          const res = await client.request({
            url: `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
            method: "POST",
            data: {
              dateRanges: [{ startDate: "1daysAgo", endDate: "today" }],
              metrics: [{ name: "sessions" }],
              limit: 1,
            },
          });
          const sessionCount = res.data.rows?.[0]?.metricValues?.[0]?.value || "0";
          return NextResponse.json({
            ok: true,
            message: `✅ Connected to GA4 property ${propertyId}. Last 1 day had ${sessionCount} sessions.`,
            serviceAccountEmail: parseServiceAccount(json).client_email,
          });
        } catch (e) {
          let hint = "";
          const msg = e.message || String(e);
          if (msg.includes("403") || msg.includes("Permission")) {
            hint = "\n\n👉 Fix: In your GA4 Admin → Property Access Management → add the service account email as Viewer.";
          } else if (msg.includes("404") || msg.includes("not found")) {
            hint = "\n\n👉 Fix: GA4 Property ID is wrong. Check Admin → Property Settings.";
          } else if (msg.includes("API has not been used")) {
            hint = "\n\n👉 Fix: Enable the Google Analytics Data API in the Cloud project that owns the service account.";
          }
          return NextResponse.json({ error: msg + hint }, { status: 400 });
        }
      }

      // ─── SYNC: pull GA data, enrich leads ─────────────────────
      case "sync_ga_data": {
        if (!campaignId || !baseId) return NextResponse.json({ error: "campaignId and baseId required" }, { status: 400 });
        const camp = await getCampaign(campaignId);
        const f = camp.fields || {};
        const propertyId = f["GA4 Property ID"];
        const json = f["GA Service Account JSON"];
        if (!propertyId || !json) return NextResponse.json({ error: "GA not configured. Set Property ID + Service Account JSON first." }, { status: 400 });

        // 1. Fetch GA data for last 7 days
        let metricsMap;
        try {
          metricsMap = await fetchGADataByCustomCode(propertyId, json, 7);
        } catch (e) {
          return NextResponse.json({ error: `GA fetch failed: ${e.message}` }, { status: 400 });
        }

        // 2. Fetch leads with Custom Codes
        let leads;
        try {
          leads = await atList(baseId, "Leads");
        } catch (e) {
          return NextResponse.json({ error: `Leads fetch failed: ${e.message}` }, { status: 400 });
        }

        const leadsWithCodes = leads.filter(l => l.fields?.["Custom Code"]);
        const totalLeads = leads.length;
        const leadsTracked = leadsWithCodes.length;

        // 3. Build update payload
        const nowISO = new Date().toISOString();
        const updates = [];
        let matched = 0;
        let cleared = 0;

        for (const lead of leadsWithCodes) {
          const code = lead.fields?.["Custom Code"];
          const m = metricsMap[code];
          const fields = { "GA Last Synced At": nowISO };

          if (m) {
            // Lead has GA activity in last 7 days
            const score = calculateEngagementScore(m);
            // Format YYYYMMDD -> YYYY-MM-DD
            const lastVisit = m.lastVisit ? `${m.lastVisit.slice(0,4)}-${m.lastVisit.slice(4,6)}-${m.lastVisit.slice(6,8)}` : "";
            fields["GA Sessions"] = m.sessions;
            fields["GA Engaged Sessions"] = m.engagedSessions;
            fields["GA Views"] = m.views;
            fields["GA Views Per Session"] = Math.round(m.viewsPerSession * 100) / 100;
            fields["GA Engagement Time"] = m.engagementTime;
            fields["GA Avg Session Duration"] = Math.round(m.avgSessionDuration * 10) / 10;
            fields["GA Last Visit"] = lastVisit;
            fields["GA Engagement Score"] = score;
            matched++;
          } else {
            // No activity in last 7 days — zero out (sliding window per spec)
            fields["GA Sessions"] = 0;
            fields["GA Engaged Sessions"] = 0;
            fields["GA Views"] = 0;
            fields["GA Views Per Session"] = 0;
            fields["GA Engagement Time"] = 0;
            fields["GA Avg Session Duration"] = 0;
            fields["GA Engagement Score"] = 0;
            // Note: don't clear GA Last Visit — keep historical record so user knows when they LAST saw activity
            cleared++;
          }
          updates.push({ id: lead.id, fields });
        }

        // 4. Push updates to Airtable
        try {
          await atUpdate(baseId, "Leads", updates);
        } catch (e) {
          return NextResponse.json({ error: `Airtable update failed: ${e.message}` }, { status: 500 });
        }

        // 5. Update campaign's last sync timestamp
        try { await patchCampaign(campaignId, { "GA Last Sync": nowISO }); } catch {}

        return NextResponse.json({
          ok: true,
          totalLeads,
          leadsTracked,
          activeThisWeek: matched,
          inactive: cleared,
          unmatchedCodes: Object.keys(metricsMap).filter(code => !leadsWithCodes.find(l => l.fields?.["Custom Code"] === code)).length,
          syncedAt: nowISO,
        });
      }

      default:
        return NextResponse.json({ error: "Unknown action: " + action }, { status: 400 });
    }
  } catch (e) {
    console.error("[ga] Error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
