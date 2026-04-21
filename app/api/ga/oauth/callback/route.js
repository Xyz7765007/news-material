import { NextResponse } from "next/server";

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const AT_API = "https://api.airtable.com/v0";
const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

function getBaseUrl(request) {
  const host = request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") || "https";
  return `${proto}://${host}`;
}

// Simple HTML response that closes the popup and notifies parent window
function htmlPopupResponse({ ok, message, email }) {
  const status = ok ? "success" : "error";
  const color = ok ? "#5da87a" : "#c45c5c";
  const bg = ok ? "#1a2a1a" : "#2a1a1a";
  return new NextResponse(
    `<!DOCTYPE html>
<html>
<head><title>GA OAuth ${status}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;background:#0a0a0a;color:#e5e5e5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;box-sizing:border-box}
.card{max-width:420px;padding:32px;background:${bg};border:1px solid ${color};border-radius:12px;text-align:center}
.icon{font-size:48px;margin-bottom:16px}
.msg{font-size:14px;color:${color};margin-bottom:12px;font-weight:600}
.sub{font-size:12px;color:#888;line-height:1.5}
.email{font-family:'JetBrains Mono',monospace;font-size:11px;color:#d4a559;margin-top:8px;word-break:break-all}
</style></head>
<body>
<div class="card">
  <div class="icon">${ok ? "✅" : "❌"}</div>
  <div class="msg">${ok ? "Google Analytics Connected!" : "Connection Failed"}</div>
  <div class="sub">${message}</div>
  ${email ? `<div class="email">Signed in as: ${email}</div>` : ""}
  <div class="sub" style="margin-top:16px">This window will close automatically...</div>
</div>
<script>
  if (window.opener) {
    try { window.opener.postMessage({ type: 'ga_oauth_${status}', message: ${JSON.stringify(message)}, email: ${JSON.stringify(email || "")} }, '*'); } catch(e) {}
  }
  setTimeout(() => window.close(), ${ok ? 1500 : 4000});
</script>
</body></html>`,
    { status: 200, headers: { "Content-Type": "text/html" } }
  );
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const stateRaw = searchParams.get("state");
  const error = searchParams.get("error");

  if (error) return htmlPopupResponse({ ok: false, message: `Google returned error: ${error}. ${searchParams.get("error_description") || ""}` });
  if (!code || !stateRaw) return htmlPopupResponse({ ok: false, message: "Missing code or state in callback URL." });

  let campaignId;
  try {
    const state = JSON.parse(decodeURIComponent(stateRaw));
    campaignId = state.campaignId;
  } catch (e) { return htmlPopupResponse({ ok: false, message: "Invalid state parameter." }); }
  if (!campaignId) return htmlPopupResponse({ ok: false, message: "No campaignId in state." });

  const redirectUri = `${getBaseUrl(request)}/api/ga/oauth/callback`;

  // Exchange code for tokens
  let tokens;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET,
        redirect_uri: redirectUri, grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) {
      const errText = await res.text();
      return htmlPopupResponse({ ok: false, message: `Token exchange failed (${res.status}): ${errText.slice(0, 200)}` });
    }
    tokens = await res.json();
  } catch (e) { return htmlPopupResponse({ ok: false, message: `Token exchange error: ${e.message}` }); }

  if (!tokens.refresh_token) {
    return htmlPopupResponse({ ok: false, message: "Google didn't return a refresh token. Go to https://myaccount.google.com/permissions, revoke access to this app, then try connecting again." });
  }

  // Get user email
  let userEmail = "";
  try {
    const ur = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (ur.ok) userEmail = (await ur.json()).email || "";
  } catch {}

  // Save to Campaigns table — auto-create fields if missing (self-heal)
  const fields = { "GA OAuth Refresh Token": tokens.refresh_token, "GA OAuth Email": userEmail };

  async function patchWithRetry() {
    let res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
      method: "PATCH", headers: atHdr, body: JSON.stringify({ fields }),
    });
    let attempts = 0;
    while (res.status === 422 && attempts < 5) {
      attempts++;
      const errText = await res.text();
      const unknownFields = [];
      const matches = errText.matchAll(/[Uu]nknown field name:?\s*\\?["']([^"'\\]+)\\?["']/g);
      for (const m of matches) unknownFields.push(m[1]);
      if (unknownFields.length === 0) {
        for (const f of Object.keys(fields)) if (errText.includes(f)) unknownFields.push(f);
      }
      if (unknownFields.length === 0) break;

      // Create the missing fields
      const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
      if (!tablesRes.ok) break;
      const { tables } = await tablesRes.json();
      const campaignsTable = (tables || []).find(t => t.name === "Campaigns");
      if (!campaignsTable) break;
      for (const fname of unknownFields) {
        await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE_ID}/tables/${campaignsTable.id}/fields`, {
          method: "POST", headers: atHdr,
          body: JSON.stringify({ name: fname, type: "multilineText" }),
        });
      }
      res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
        method: "PATCH", headers: atHdr, body: JSON.stringify({ fields }),
      });
    }
    return res;
  }

  try {
    const res = await patchWithRetry();
    if (!res.ok) {
      const errText = await res.text();
      return htmlPopupResponse({ ok: false, message: `Couldn't save OAuth token: HTTP ${res.status} — ${errText.slice(0, 200)}` });
    }
  } catch (e) { return htmlPopupResponse({ ok: false, message: `Save error: ${e.message}` }); }

  return htmlPopupResponse({
    ok: true,
    message: "You can now sync Google Analytics data for this campaign.",
    email: userEmail,
  });
}
