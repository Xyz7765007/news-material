import { NextResponse } from "next/server";
import { JWT } from "google-auth-library";

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const AT_API = "https://api.airtable.com/v0";
const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

// Helper to get the deployment's base URL for building OAuth redirect URIs
function getBaseUrl(request) {
  const host = request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

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

// Auto-create missing fields on any table (handles upgrades without re-running Setup)
async function ensureTableFields(baseId, tableName, missingFieldNames) {
  const GA_TYPES = {
    "Custom Code": "singleLineText",
    "GA Sessions": { type: "number", options: { precision: 0 } },
    "GA Engaged Sessions": { type: "number", options: { precision: 0 } },
    "GA Views": { type: "number", options: { precision: 0 } },
    "GA Views Per Session": { type: "number", options: { precision: 2 } },
    "GA Engagement Time": { type: "number", options: { precision: 0 } },
    "GA Avg Session Duration": { type: "number", options: { precision: 1 } },
    "GA Last Visit": "singleLineText",
    "GA Engagement Score": { type: "number", options: { precision: 0 } },
    "GA Last Synced At": "singleLineText",
  };
  try {
    const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: atHdr });
    if (!tablesRes.ok) return false;
    const { tables } = await tablesRes.json();
    const targetTable = (tables || []).find(t => t.name === tableName);
    if (!targetTable) return false;
    for (const fname of missingFieldNames) {
      const spec = GA_TYPES[fname];
      const body = typeof spec === "string"
        ? { name: fname, type: spec }
        : { name: fname, type: spec?.type || "singleLineText", ...(spec?.options ? { options: spec.options } : {}) };
      const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${targetTable.id}/fields`, {
        method: "POST", headers: atHdr,
        body: JSON.stringify(body),
      });
      if (!r.ok) console.error(`[GA] Failed to create field ${fname}:`, await r.text());
    }
    return true;
  } catch (e) {
    console.error("[ga] ensureTableFields failed:", e);
    return false;
  }
}

async function atUpdate(baseId, table, records) {
  let successCount = 0;
  let failCount = 0;
  const errors = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    let res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: atHdr,
      body: JSON.stringify({ records: batch }),
    });

    // Auto-create missing fields if 422 — loop up to 5 times as Airtable reports one at a time
    let attempts = 0;
    while (res.status === 422 && attempts < 5) {
      attempts++;
      const errText = await res.text();
      const unknownFields = [];
      const matches = errText.matchAll(/[Uu]nknown field name:?\s*\\?["']([^"'\\]+)\\?["']/g);
      for (const m of matches) unknownFields.push(m[1]);
      if (unknownFields.length === 0) {
        // Fallback — detect any field name from the batch mentioned in error
        const allFieldNames = new Set(batch.flatMap(r => Object.keys(r.fields || {})));
        for (const f of allFieldNames) if (errText.includes(f)) unknownFields.push(f);
      }
      if (unknownFields.length === 0) break;
      await ensureTableFields(baseId, table, unknownFields);
      res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
        method: "PATCH", headers: atHdr,
        body: JSON.stringify({ records: batch }),
      });
    }

    if (res.ok) {
      successCount += batch.length;
    } else {
      failCount += batch.length;
      const errText = await res.text();
      errors.push(`Batch ${i}-${i+batch.length}: HTTP ${res.status} — ${errText.slice(0, 200)}`);
    }
  }
  return { successCount, failCount, errors };
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
    "GA OAuth Refresh Token": "multilineText",
    "GA OAuth Email": "singleLineText",
    "GA Last Sync": "singleLineText",
    "GA Score Config": "multilineText",
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

// ═══════════════════════════════════════════════════════════════
// OAUTH — Google Sign-In flow
// ═══════════════════════════════════════════════════════════════
const OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

function buildOAuthAuthUrl(redirectUri, campaignId) {
  const params = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: OAUTH_SCOPES,
    access_type: "offline", // MUST be "offline" to get refresh_token
    prompt: "consent", // force consent so we ALWAYS get a refresh_token (Google only returns it on first consent otherwise)
    state: campaignId, // so the callback knows which campaign to associate the token with
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

// Exchange authorization code for access + refresh tokens
async function exchangeCodeForTokens(code, redirectUri) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
  });
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json(); // { access_token, refresh_token, expires_in, id_token, ... }
}

// Swap refresh_token for a fresh access_token
async function refreshAccessToken(refreshToken) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (!res.ok) throw new Error(`OAuth refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json(); // { access_token, expires_in, ... }
}

async function getUserEmail(accessToken) {
  const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return "";
  const d = await res.json();
  return d.email || "";
}

// Make an authenticated GA Data API call using raw access token
async function gaApiCall(accessToken, propertyId, requestBody) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`GA API ${res.status}: ${errText.slice(0, 400)}`);
    err.status = res.status;
    err.responseText = errText;
    throw err;
  }
  return res.json();
}

// Resolve auth for a campaign → returns a function (propertyId, body) => data
// Prefers OAuth refresh token; falls back to service account JSON if configured
async function resolveAuth(campaignFields) {
  const refreshToken = campaignFields["GA OAuth Refresh Token"];
  const saJson = campaignFields["GA Service Account JSON"];

  if (refreshToken) {
    // OAuth path
    const { access_token } = await refreshAccessToken(refreshToken);
    return { mode: "oauth", callApi: (propertyId, body) => gaApiCall(access_token, propertyId, body) };
  }
  if (saJson) {
    // Service account fallback
    const client = await getGAClient(saJson);
    return {
      mode: "service_account",
      callApi: async (propertyId, body) => {
        const r = await client.request({
          url: `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
          method: "POST",
          data: body,
        });
        return r.data;
      },
    };
  }
  throw new Error("No auth configured. Sign in with Google to connect GA.");
}

// Pull last N days of GA data, broken down by Session campaign ID
async function fetchGADataByCustomCode(propertyId, auth, daysBack = 7) {
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

  const data = await auth.callApi(propertyId, requestBody);

  // Also fetch last visit date per Custom Code
  const lastVisitBody = {
    dateRanges: [{ startDate: fmt(startDate), endDate: fmt(today) }],
    dimensions: [{ name: "sessionCampaignId" }, { name: "date" }],
    metrics: [{ name: "sessions" }],
    dimensionFilter: requestBody.dimensionFilter,
    limit: 50000,
  };
  const lvData = await auth.callApi(propertyId, lastVisitBody);

  // Parse response
  const rows = data.rows || [];
  const lvRows = lvData.rows || [];

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
const DEFAULT_SCORE_CONFIG = {
  weights: { time: 50, engaged: 30, views: 20 },
  tiers: { warmMax: 20, interestedMax: 50 },
};

function parseScoreConfig(raw) {
  if (!raw) return DEFAULT_SCORE_CONFIG;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      weights: {
        time: Number(parsed?.weights?.time ?? DEFAULT_SCORE_CONFIG.weights.time),
        engaged: Number(parsed?.weights?.engaged ?? DEFAULT_SCORE_CONFIG.weights.engaged),
        views: Number(parsed?.weights?.views ?? DEFAULT_SCORE_CONFIG.weights.views),
      },
      tiers: {
        warmMax: Number(parsed?.tiers?.warmMax ?? DEFAULT_SCORE_CONFIG.tiers.warmMax),
        interestedMax: Number(parsed?.tiers?.interestedMax ?? DEFAULT_SCORE_CONFIG.tiers.interestedMax),
      },
    };
  } catch { return DEFAULT_SCORE_CONFIG; }
}

function calculateEngagementScore(m, config) {
  if (!m || m.sessions === 0) return 0;
  const cfg = config || DEFAULT_SCORE_CONFIG;
  const w = cfg.weights;
  // Normalize each metric to 0-100
  const timeScore = Math.min(100, (m.engagementTime / 120) * 100);
  const engagedScore = Math.min(100, (m.engagedSessions / 3) * 100);
  const viewsScore = Math.min(100, ((m.viewsPerSession - 1) / 4) * 100);
  const total = (w.time / 100) + (w.engaged / 100) + (w.views / 100);
  if (total === 0) return 0;
  const raw = (timeScore * (w.time / 100) + engagedScore * (w.engaged / 100) + Math.max(0, viewsScore) * (w.views / 100)) / total;
  return Math.round(raw);
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, campaignId, baseId } = body;

    switch (action) {
      // ─── OAUTH: generate sign-in URL ─────────────────────────
      case "oauth_start": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        if (!OAUTH_CLIENT_ID) return NextResponse.json({ error: "GOOGLE_OAUTH_CLIENT_ID not set in Vercel env vars" }, { status: 500 });
        const redirectUri = `${getBaseUrl(request)}/api/ga/oauth/callback`;
        const state = encodeURIComponent(JSON.stringify({ campaignId, t: Date.now() }));
        const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
          client_id: OAUTH_CLIENT_ID,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/userinfo.email",
          access_type: "offline",
          prompt: "consent", // force refresh_token to be issued even on re-auth
          state,
        }).toString();
        return NextResponse.json({ url, redirectUri });
      }

      case "oauth_disconnect": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        // Clear ALL auth — both OAuth and service account fallback
        // Use null to properly clear Airtable fields (empty string doesn't always clear multilineText)
        const fieldsToClear = {
          "GA OAuth Refresh Token": null,
          "GA OAuth Email": null,
          "GA Service Account JSON": null,
        };

        let clearRes = await patchCampaign(campaignId, fieldsToClear);

        // If 422 (field doesn't exist), create missing fields then retry — loop for multiple missing
        let attempts = 0;
        while (clearRes.status === 422 && attempts < 5) {
          attempts++;
          const errText = await clearRes.text();
          const unknownFields = [];
          const matches = errText.matchAll(/[Uu]nknown field name:?\s*\\?["']([^"'\\]+)\\?["']/g);
          for (const m of matches) unknownFields.push(m[1]);
          if (unknownFields.length === 0) {
            for (const fname of Object.keys(fieldsToClear)) if (errText.includes(fname)) unknownFields.push(fname);
          }
          if (unknownFields.length === 0) break;
          await ensureCampaignFields(unknownFields);
          clearRes = await patchCampaign(campaignId, fieldsToClear);
        }

        if (!clearRes.ok) {
          const err = await clearRes.text();
          return NextResponse.json({ error: `Disconnect failed: ${clearRes.status} — ${err.slice(0, 300)}` }, { status: 500 });
        }

        // Verify by re-reading
        const verified = await getCampaign(campaignId);
        const vf = verified.fields || {};
        const stillHasAuth = !!(vf["GA OAuth Refresh Token"] || vf["GA Service Account JSON"]);
        return NextResponse.json({
          ok: true,
          cleared: !stillHasAuth,
          remaining: stillHasAuth ? {
            hasOAuth: !!vf["GA OAuth Refresh Token"],
            hasSA: !!vf["GA Service Account JSON"],
          } : null,
        });
      }

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
        const refreshToken = f["GA OAuth Refresh Token"] || "";
        const oauthEmail = f["GA OAuth Email"] || "";
        let serviceAccountEmail = "";
        if (json) {
          try { serviceAccountEmail = parseServiceAccount(json).client_email; } catch {}
        }
        return NextResponse.json({
          propertyId: f["GA4 Property ID"] || "",
          // OAuth state
          hasOAuth: !!refreshToken,
          oauthEmail,
          // Service account fallback state
          hasServiceAccount: !!json,
          serviceAccountEmail,
          lastSync: f["GA Last Sync"] || "",
          // Which mode is primary (OAuth > SA)
          authMode: refreshToken ? "oauth" : (json ? "service_account" : "none"),
        });
      }

      case "test_ga_connection": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const camp = await getCampaign(campaignId);
        const f = camp.fields || {};
        const propertyId = f["GA4 Property ID"];
        if (!propertyId) return NextResponse.json({ error: "GA4 Property ID not set" }, { status: 400 });

        try {
          const auth = await resolveAuth(f);
          const data = await auth.callApi(propertyId, {
            dateRanges: [{ startDate: "1daysAgo", endDate: "today" }],
            metrics: [{ name: "sessions" }],
            limit: 1,
          });
          const sessionCount = data.rows?.[0]?.metricValues?.[0]?.value || "0";
          return NextResponse.json({
            ok: true,
            message: `✅ Connected to GA4 property ${propertyId} via ${auth.mode === "oauth" ? "Google Sign-In" : "service account"}. Last 1 day had ${sessionCount} sessions.`,
            mode: auth.mode,
          });
        } catch (e) {
          let hint = "";
          const msg = e.message || String(e);
          if (msg.includes("403") || msg.includes("Permission")) {
            hint = "\n\n👉 Fix: The signed-in Google account doesn't have access to this GA4 property. Either sign in with an account that has access, or get added as a Viewer in GA4 Admin → Property Access Management.";
          } else if (msg.includes("404") || msg.includes("not found")) {
            hint = "\n\n👉 Fix: GA4 Property ID is wrong. Check Admin → Property Settings.";
          } else if (msg.includes("API has not been used") || msg.includes("has not been enabled")) {
            hint = "\n\n👉 Fix: Enable the Google Analytics Data API in the Cloud project that owns the OAuth client.";
          } else if (msg.includes("invalid_grant") || msg.includes("refresh")) {
            hint = "\n\n👉 Fix: OAuth token expired or revoked. Click 'Sign in with Google' again.";
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
        const hasOAuth = !!f["GA OAuth Refresh Token"];
        const hasSA = !!f["GA Service Account JSON"];
        const scoreConfig = parseScoreConfig(f["GA Score Config"]);
        if (!propertyId) return NextResponse.json({ error: "GA4 Property ID not set. Enter it on the Google Analytics tab." }, { status: 400 });
        if (!hasOAuth && !hasSA) return NextResponse.json({ error: "Not signed in. Click 'Sign in with Google' first." }, { status: 400 });

        // 1. Resolve auth (OAuth preferred, service account fallback)
        let auth;
        try {
          auth = await resolveAuth(f);
        } catch (e) {
          return NextResponse.json({ error: `Auth failed: ${e.message}` }, { status: 400 });
        }

        // 2. Fetch GA data for last 7 days
        let metricsMap;
        try {
          metricsMap = await fetchGADataByCustomCode(propertyId, auth, 7);
        } catch (e) {
          let hint = "";
          const msg = e.message || String(e);
          if (msg.includes("403") || msg.includes("Permission")) hint = " — The signed-in Google account doesn't have access to this GA4 property.";
          else if (msg.includes("404")) hint = " — Property ID is wrong.";
          else if (msg.includes("invalid_grant")) hint = " — OAuth token expired. Click 'Sign in with Google' again.";
          return NextResponse.json({ error: `GA fetch failed: ${msg}${hint}` }, { status: 400 });
        }

        // 3. Fetch leads with Custom Codes
        let leads;
        try {
          leads = await atList(baseId, "Leads");
        } catch (e) {
          return NextResponse.json({ error: `Leads fetch failed: ${e.message}` }, { status: 400 });
        }

        // 3b. Pre-create all GA fields on Leads table so the batch updates don't race
        // This avoids the issue where parallel batches each try to create the same missing field
        try {
          const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: atHdr });
          if (tablesRes.ok) {
            const { tables } = await tablesRes.json();
            const leadsTable = (tables || []).find(t => t.name === "Leads");
            if (leadsTable) {
              const existingFieldNames = new Set((leadsTable.fields || []).map(f => f.name));
              const requiredFields = [
                "GA Sessions", "GA Engaged Sessions", "GA Views", "GA Views Per Session",
                "GA Engagement Time", "GA Avg Session Duration", "GA Last Visit",
                "GA Engagement Score", "GA Last Synced At",
              ];
              const missing = requiredFields.filter(f => !existingFieldNames.has(f));
              if (missing.length > 0) {
                await ensureTableFields(baseId, "Leads", missing);
                // Wait a bit for Airtable Meta API to propagate new fields to PATCH endpoint
                await new Promise(r => setTimeout(r, 2000));
              }
            }
          }
        } catch (e) {
          console.error("[GA] Pre-flight field creation failed:", e);
          // Continue anyway — per-batch retry will catch missing fields
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

          // Skip leads with no GA activity — don't waste writes on them
          // Their existing GA fields (if any from a past sync) stay untouched
          if (!m) continue;

          // Lead has GA activity in last 7 days
          const score = calculateEngagementScore(m, scoreConfig);
          const lastVisit = m.lastVisit ? `${m.lastVisit.slice(0,4)}-${m.lastVisit.slice(4,6)}-${m.lastVisit.slice(6,8)}` : "";
          const fields = {
            "GA Last Synced At": nowISO,
            "GA Sessions": m.sessions,
            "GA Engaged Sessions": m.engagedSessions,
            "GA Views": m.views,
            "GA Views Per Session": Math.round(m.viewsPerSession * 100) / 100,
            "GA Engagement Time": m.engagementTime,
            "GA Avg Session Duration": Math.round(m.avgSessionDuration * 10) / 10,
            "GA Last Visit": lastVisit,
            "GA Engagement Score": score,
          };
          matched++;
          updates.push({ id: lead.id, fields });
        }
        // Count inactive as "leads we know exist but aren't in GA's active set this week"
        cleared = leadsWithCodes.length - matched;

        // 4. Push updates to Airtable
        let updateResult;
        try {
          updateResult = await atUpdate(baseId, "Leads", updates);
        } catch (e) {
          return NextResponse.json({ error: `Airtable update failed: ${e.message}` }, { status: 500 });
        }

        // 5. Update campaign's last sync timestamp
        try { await patchCampaign(campaignId, { "GA Last Sync": nowISO }); } catch {}

        // If ALL updates failed, return as error so UI shows it clearly
        if (updateResult.failCount > 0 && updateResult.successCount === 0) {
          return NextResponse.json({
            error: `All ${updateResult.failCount} Airtable updates failed. First error: ${updateResult.errors[0] || "unknown"}`,
            totalLeads, leadsTracked, activeThisWeek: matched, inactive: cleared,
          }, { status: 500 });
        }

        return NextResponse.json({
          ok: true,
          totalLeads,
          leadsTracked,
          activeThisWeek: matched,
          inactive: cleared,
          unmatchedCodes: Object.keys(metricsMap).filter(code => !leadsWithCodes.find(l => l.fields?.["Custom Code"] === code)).length,
          syncedAt: nowISO,
          updatesSucceeded: updateResult.successCount,
          updatesFailed: updateResult.failCount,
          updateErrors: updateResult.errors.length > 0 ? updateResult.errors.slice(0, 3) : undefined,
        });
      }

      // ─── LIST ENGAGED LEADS — for display on GA tab ─────────────
      case "list_engaged_leads": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const minScore = typeof body.minScore === "number" ? body.minScore : 1;

        let leads, outreach;
        try {
          [leads, outreach] = await Promise.all([
            atList(baseId, "Leads"),
            atList(baseId, "Outreach").catch(() => []),
          ]);
        } catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }

        // Build outreach lookup: LinkedIn URL (lowercased) → status
        const outreachByUrl = {};
        for (const o of outreach) {
          const url = (o.fields?.["LinkedIn URL"] || "").toLowerCase().trim();
          if (!url) continue;
          // If multiple records exist for same lead, keep the most recent one
          const existing = outreachByUrl[url];
          const thisCreated = o.fields?.["Created At"] || "";
          if (!existing || (thisCreated && thisCreated > (existing.created || ""))) {
            outreachByUrl[url] = {
              status: o.fields?.Status || "",
              mode: o.fields?.Mode || "",
              created: thisCreated,
              recordId: o.id,
            };
          }
        }

        const engaged = leads
          .filter(l => (l.fields?.["GA Engagement Score"] || 0) >= minScore)
          .map(l => {
            const f = l.fields || {};
            const liUrl = (f["LinkedIn URL"] || "").toLowerCase().trim();
            const outreachState = liUrl ? outreachByUrl[liUrl] : null;
            return {
              id: l.id,
              name: f.Name || "",
              title: f.Title || "",
              company: f.Company || "",
              email: f.Email || "",
              linkedinUrl: f["LinkedIn URL"] || "",
              customCode: f["Custom Code"] || "",
              score: f["GA Engagement Score"] || 0,
              lastVisit: f["GA Last Visit"] || "",
              sessions: f["GA Sessions"] || 0,
              engagedSessions: f["GA Engaged Sessions"] || 0,
              views: f["GA Views"] || 0,
              viewsPerSession: f["GA Views Per Session"] || 0,
              engagementTime: f["GA Engagement Time"] || 0,
              avgSessionDuration: f["GA Avg Session Duration"] || 0,
              // Outreach state — drives UI button visibility
              outreachStatus: outreachState?.status || null,
              outreachRecordId: outreachState?.recordId || null,
              hasLinkedinOutreach: !!outreachState,
              canSendConnection: !outreachState || outreachState.status === "error",
              canSendEmail: !!(f.Email),
            };
          })
          .sort((a, b) => b.score - a.score);
        return NextResponse.json({ ok: true, engaged, count: engaged.length });
      }

      // ─── CONVERT ENGAGED LEADS TO TASKS ─────────────────────────
      case "convert_to_tasks": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const leadIds = body.leadIds || []; // optional — if empty, convert ALL engaged
        const minScore = typeof body.minScore === "number" ? body.minScore : 1;

        let leads;
        try { leads = await atList(baseId, "Leads"); }
        catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }

        const targetLeads = leads.filter(l => {
          const score = l.fields?.["GA Engagement Score"] || 0;
          if (score < minScore) return false;
          if (leadIds.length > 0 && !leadIds.includes(l.id)) return false;
          return true;
        });

        if (targetLeads.length === 0) {
          return NextResponse.json({ error: "No engaged leads match the criteria" }, { status: 400 });
        }

        // Check existing tasks to avoid duplicates — match by lead name + engagement signal
        let existingTasks = [];
        try { existingTasks = await atList(baseId, "Tasks"); } catch {}
        const existingEngagementTasks = new Set(
          existingTasks
            .filter(t => t.fields?.["Task Type"] === "engagement")
            .map(t => (t.fields?.Company || "") + "::" + (t.fields?.Signal || "").slice(0, 40))
        );

        const fmtTime = (sec) => {
          const s = Math.round(Number(sec) || 0);
          if (s < 60) return s + "s";
          const m = Math.floor(s / 60); const r = s % 60;
          return m + "m" + (r > 0 ? " " + r + "s" : "");
        };

        const nowISO = new Date().toISOString();
        const todayStr = nowISO.slice(0, 10);
        const newTasks = [];
        let skipped = 0;

        for (const lead of targetLeads) {
          const f = lead.fields || {};
          const name = f.Name || "Unknown";
          const title = f.Title || "";
          const company = f.Company || "";
          const engagementScore = f["GA Engagement Score"] || 0;
          const sessions = f["GA Sessions"] || 0;
          const engagedSessions = f["GA Engaged Sessions"] || 0;
          const views = f["GA Views"] || 0;
          const engTime = f["GA Engagement Time"] || 0;
          const lastVisit = f["GA Last Visit"] || "";

          // Boost task Score: website engagement = strong buying signal (intent from their side),
          // should always rank above typical news/job-signal tasks. Floor at 90, scale up to 100.
          // Formula: 90 + (engagementScore / 100 * 10), clamped to [90, 100]
          const boostedScore = Math.min(100, Math.round(90 + engagementScore / 10));

          // Build rich signal text — no "(score X)" since Score column shows it
          const tier = engagementScore >= 51 ? "🔥 Hot Lead" : engagementScore >= 21 ? "⚡ Interested" : "👀 Warm";
          const signal = `${tier} — ${name}${title ? " · " + title : ""}${company ? " @ " + company : ""}. Visited website on ${lastVisit || "recently"}: ${sessions} session${sessions!==1?"s":""} (${engagedSessions} engaged), ${views} pageview${views!==1?"s":""}, ${fmtTime(engTime)} total engagement time.`;

          const dedupKey = company + "::" + signal.slice(0, 40);
          if (existingEngagementTasks.has(dedupKey)) { skipped++; continue; }

          newTasks.push({
            fields: {
              Company: company,
              "Task Rule": "Website Engagement (GA)",
              Score: boostedScore,
              "Scan Target": name,
              Signal: signal,
              Source: "Google Analytics",
              "Task Type": "engagement",
              Date: todayStr,
              Created: nowISO,
              Phone: f.Phone || "",
            },
          });
        }

        if (newTasks.length === 0) {
          console.log("[convert_to_tasks] All tasks already exist. Skipped:", skipped, "Total targeted:", targetLeads.length);
          return NextResponse.json({
            ok: true,
            created: 0,
            skipped,
            total: targetLeads.length,
            message: `All ${skipped} engaged lead${skipped!==1?"s":""} already have tasks (deduplicated). To re-create, delete the existing tasks from the Tasks tab first.`,
          });
        }

        // Batch-create tasks with auto-retry on field rejection
        // If Airtable rejects a specific field (e.g. existing Score column has different type),
        // strip that field from all records and retry — up to 3 times for different bad fields
        let created = 0;
        const createErrors = [];
        const strippedFields = new Set(); // track fields we had to remove

        const tryBatch = async (batch, attempt = 0) => {
          const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}`, {
            method: "POST", headers: atHdr,
            body: JSON.stringify({ records: batch }),
          });
          if (r.ok) return { ok: true, count: batch.length };

          const errText = await r.text();
          console.error(`[convert_to_tasks] Batch attempt ${attempt} FAILED:`, r.status, errText);

          // Try to parse various Airtable field errors and handle the bad field
          if (attempt < 10 && (errText.includes("INVALID_VALUE_FOR_COLUMN") || errText.includes("UNKNOWN_FIELD_NAME"))) {
            // Match either:
            //   Field "FieldName" cannot accept...    (INVALID_VALUE_FOR_COLUMN)
            //   Unknown field name: "FieldName"       (UNKNOWN_FIELD_NAME)
            let badField = null;
            const m1 = errText.match(/Field\s+\\?"([^"\\]+)\\?"/);
            const m2 = errText.match(/[Uu]nknown field name:?\s+\\?"([^"\\]+)\\?"/);
            if (m1 && m1[1]) badField = m1[1];
            else if (m2 && m2[1]) badField = m2[1];

            if (badField) {
              // Special handling for Score: try as string first before stripping entirely
              if (badField === "Score" && !strippedFields.has("_score_string_tried")) {
                console.log(`[convert_to_tasks] Score rejected as number, retrying as string`);
                strippedFields.add("_score_string_tried"); // marker so we don't loop
                const stringScoreBatch = batch.map(rec => ({
                  fields: { ...rec.fields, Score: String(rec.fields.Score || 0) },
                }));
                return tryBatch(stringScoreBatch, attempt + 1);
              }

              console.log(`[convert_to_tasks] Stripping bad field: ${badField} and retrying`);
              strippedFields.add(badField);
              const strippedBatch = batch.map(rec => {
                const newFields = { ...rec.fields };
                delete newFields[badField];
                return { fields: newFields };
              });
              return tryBatch(strippedBatch, attempt + 1);
            } else {
              console.error(`[convert_to_tasks] Couldn't parse bad field from error: ${errText.slice(0, 300)}`);
            }
          }
          return { ok: false, error: `${r.status} — ${errText.slice(0, 250)}` };
        };

        for (let i = 0; i < newTasks.length; i += 10) {
          const batch = newTasks.slice(i, i + 10);
          const result = await tryBatch(batch);
          if (result.ok) {
            created += result.count;
          } else {
            createErrors.push(`Batch ${i}: ${result.error}`);
          }
        }

        // If ALL batches failed, return as error
        if (created === 0 && createErrors.length > 0) {
          return NextResponse.json({
            ok: false,
            error: `Task creation failed for all ${newTasks.length} leads. First error: ${createErrors[0]}`,
            errors: createErrors.slice(0, 3),
          }, { status: 500 });
        }

        console.log("[convert_to_tasks] Success:", created, "created,", skipped, "skipped,", createErrors.length, "errors");
        return NextResponse.json({
          ok: true,
          created,
          skipped,
          total: targetLeads.length,
          strippedFields: strippedFields.size > 0 ? [...strippedFields] : undefined,
          errors: createErrors.length > 0 ? createErrors.slice(0, 3) : undefined,
        });
      }

      // ─── SCORE CONFIG — per-campaign weights & tier boundaries ───
      case "get_score_config": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const camp = await getCampaign(campaignId);
        const cfg = parseScoreConfig(camp.fields?.["GA Score Config"]);
        return NextResponse.json({ ok: true, config: cfg, defaults: DEFAULT_SCORE_CONFIG });
      }

      case "save_score_config": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const { weights, tiers } = body;
        if (!weights || !tiers) return NextResponse.json({ error: "weights and tiers required" }, { status: 400 });

        // Validate weights sum to 100 (±0.1 tolerance for rounding)
        const sum = Number(weights.time || 0) + Number(weights.engaged || 0) + Number(weights.views || 0);
        if (Math.abs(sum - 100) > 0.1) {
          return NextResponse.json({ error: `Weights must sum to 100. Current: ${sum.toFixed(1)}` }, { status: 400 });
        }
        // Validate tiers: warmMax < interestedMax, both 0-100
        const w = Number(tiers.warmMax), i = Number(tiers.interestedMax);
        if (!(w >= 0 && w < i && i <= 100)) {
          return NextResponse.json({ error: "Tier boundaries invalid. Need: 0 ≤ Warm Max < Interested Max ≤ 100" }, { status: 400 });
        }

        const config = {
          weights: { time: Number(weights.time), engaged: Number(weights.engaged), views: Number(weights.views) },
          tiers: { warmMax: w, interestedMax: i },
        };

        let res = await patchCampaign(campaignId, { "GA Score Config": JSON.stringify(config) });
        // Auto-create field if missing
        let attempts = 0;
        while (res.status === 422 && attempts < 3) {
          attempts++;
          const errText = await res.text();
          if (errText.includes("GA Score Config")) {
            await ensureCampaignFields(["GA Score Config"]);
            res = await patchCampaign(campaignId, { "GA Score Config": JSON.stringify(config) });
          } else break;
        }
        if (!res.ok) {
          const err = await res.text();
          return NextResponse.json({ error: `Save failed: ${res.status} — ${err.slice(0, 300)}` }, { status: 400 });
        }
        return NextResponse.json({ ok: true, config });
      }

      case "recalculate_scores": {
        // Re-score all leads using stored GA data + current config
        // No GA API call needed — just math on data we already have
        if (!campaignId || !baseId) return NextResponse.json({ error: "campaignId and baseId required" }, { status: 400 });
        const camp = await getCampaign(campaignId);
        const scoreConfig = parseScoreConfig(camp.fields?.["GA Score Config"]);

        let leads;
        try { leads = await atList(baseId, "Leads"); }
        catch (e) { return NextResponse.json({ error: e.message }, { status: 500 }); }

        // Only recalc leads that have GA data (engaged sessions > 0 or engagement time > 0)
        const leadsWithGAData = leads.filter(l => {
          const f = l.fields || {};
          return (f["GA Engaged Sessions"] || 0) > 0 || (f["GA Engagement Time"] || 0) > 0 || (f["GA Sessions"] || 0) > 0;
        });

        const updates = [];
        for (const lead of leadsWithGAData) {
          const f = lead.fields || {};
          const m = {
            sessions: f["GA Sessions"] || 0,
            engagedSessions: f["GA Engaged Sessions"] || 0,
            views: f["GA Views"] || 0,
            viewsPerSession: f["GA Views Per Session"] || 0,
            engagementTime: f["GA Engagement Time"] || 0,
            avgSessionDuration: f["GA Avg Session Duration"] || 0,
          };
          const newScore = calculateEngagementScore(m, scoreConfig);
          const oldScore = f["GA Engagement Score"] || 0;
          if (newScore !== oldScore) {
            updates.push({ id: lead.id, fields: { "GA Engagement Score": newScore } });
          }
        }

        if (updates.length === 0) {
          return NextResponse.json({ ok: true, recalculated: 0, leadsWithData: leadsWithGAData.length, message: "No score changes needed (formula produced same results)" });
        }

        const result = await atUpdate(baseId, "Leads", updates);
        return NextResponse.json({
          ok: true,
          recalculated: result.successCount,
          failed: result.failCount,
          leadsWithData: leadsWithGAData.length,
          errors: result.errors.length > 0 ? result.errors.slice(0, 3) : undefined,
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
