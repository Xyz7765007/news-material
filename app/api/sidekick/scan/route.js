import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK SCAN ENDPOINT
// POST /api/sidekick/scan
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Body:
//   {
//     baseId: "appXYZ...",   // Airtable base for the campaign
//     ruleName?: "Top 50 leads"  // optional — if omitted, uses first rule
//   }
//
// Wraps the existing /api/airtable run_topx action so the chatbot
// doesn't need to know about Task Rules schema or build the rule body.
// Internally:
//   1. Fetches Task Rules from the campaign base
//   2. Finds the rule (by name match or defaults to first)
//   3. Looks up campaignId from master base via baseId
//   4. Constructs the rule body and runs the scan
//   5. Returns task count + summary
//
// Long-running: Top X scans can take 30-60s on large lead lists.
// maxDuration is set to 300s to match the airtable route.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Fetch all records from a table (paginated)
async function fetchAll(baseId, tableName) {
  const out = [];
  let offset = "";
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ pageSize: "100" });
    if (offset) params.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(tableName)}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
      cache: "no-store",
    });
    if (!r.ok) throw new Error(`Airtable ${tableName} fetch failed: ${r.status}`);
    const data = await r.json();
    out.push(...(data.records || []));
    offset = data.offset || "";
    if (!offset) break;
  }
  return out;
}

export async function POST(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });
  }
  if (!MASTER_BASE_ID) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_BASE_ID (master base)" }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { baseId, ruleName } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });

  try {
    // ─── 1. Fetch Task Rules from the campaign base ───────────────
    const rules = await fetchAll(baseId, "Task Rules");
    if (rules.length === 0) {
      return NextResponse.json({ ok: false, error: "No Task Rules found in this base. Create one in SignalScope first." }, { status: 404 });
    }

    // ─── 2. Pick a rule ──────────────────────────────────────────
    // If ruleName given, match case-insensitively (contains). Else first.
    let rule = null;
    if (ruleName) {
      const needle = ruleName.toLowerCase().trim();
      rule = rules.find(r => (r.fields?.Name || "").toLowerCase().includes(needle));
      if (!rule) {
        const available = rules.map(r => r.fields?.Name).filter(Boolean);
        return NextResponse.json({
          ok: false,
          error: `No rule matching "${ruleName}". Available: ${available.join(", ")}`,
          availableRules: available,
        }, { status: 404 });
      }
    } else {
      rule = rules[0];
    }

    const rf = rule.fields || {};
    const actualRuleName = rf.Name || "(unnamed)";

    // ─── 3. Build rule body (mirrors SignalScope.jsx line 1385) ──
    let scoringFields = [];
    try { scoringFields = JSON.parse(rf["Scoring Fields"] || "[]"); } catch { /* ignore parse errors */ }

    const smartCompileEnabled = rf["Smart Compile"] === "true" || rf["Smart Compile"] === true;
    let compiledRules = null;
    if (smartCompileEnabled && rf["Compiled Rules JSON"]) {
      try { compiledRules = JSON.parse(rf["Compiled Rules JSON"]); } catch { /* ignore */ }
    }
    const useSmartCompile = smartCompileEnabled && compiledRules && Array.isArray(compiledRules.rules);

    const ruleBody = {
      name: actualRuleName,
      scanTarget: rf["Scan Target"] || "leads",
      topN: rf["Top N"] || 10,
      scoringFields,
      scoringPrompt: rf["Scoring Prompt"] || "",
      useSmartCompile,
      compiledRules,
    };

    // ─── 4. Find campaignId from master base ─────────────────────
    let campaignId = null;
    try {
      const campsRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}?filterByFormula=${encodeURIComponent(`{Base ID} = '${baseId}'`)}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
        cache: "no-store",
      });
      if (campsRes.ok) {
        const cd = await campsRes.json();
        if (cd.records?.length) campaignId = cd.records[0].id;
      }
    } catch { /* non-fatal */ }

    // ─── 5. Self-fetch /api/airtable to run the scan ─────────────
    // We use self-fetch so we don't have to duplicate the 700-line
    // runTopXScoring/runTopXSmartCompile logic here. The airtable
    // route blocks admin actions only when referer matches /client/[id];
    // our server-to-server call has no referer, so it passes.
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;

    const scanRes = await fetch(`${origin}/api/airtable`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "run_topx",
        baseId,
        rule: ruleBody,
        campaignId,
      }),
    });

    if (!scanRes.ok) {
      const errText = await scanRes.text();
      return NextResponse.json({
        ok: false,
        error: `Scan failed: HTTP ${scanRes.status}`,
        detail: errText.slice(0, 500),
      }, { status: 502 });
    }
    const scanData = await scanRes.json();

    return NextResponse.json({
      ok: true,
      ruleUsed: actualRuleName,
      scanTarget: ruleBody.scanTarget,
      tasksCreated: scanData.tasks?.length || scanData.tasksCreated || 0,
      totalRecords: scanData.totalRecords,
      aiScored: !!scanData.aiScored,
      smartCompile: scanData.smartCompile || null,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
