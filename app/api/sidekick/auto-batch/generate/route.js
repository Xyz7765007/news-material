import { NextResponse } from "next/server";
import OpenAI from "openai";
import { rankLeadsForBatch } from "@/lib/composite-score.js";
import { pickLeadField } from "@/lib/lead-fields.js";
import {
  sanitizeAndValidate,
  deterministicFallback,
  deriveNames,
} from "@/lib/message-merge.js";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK AUTO-BATCH GENERATE
// POST /api/sidekick/auto-batch/generate
//   body: { baseId, campaignId, size=5, force=false }
//
// What it does:
//   1. Loads Leads + Tasks for the campaign
//   2. Loads Outreach (to exclude leads already in any active outreach state)
//   3. Picks top N leads using composite scoring (movement preempt → GA + LI)
//      Phone availability is NOT a hard filter — can be enriched after approval.
//   4. Auto-creates or reuses the "Sidekick Auto-Batch v1" rule in Task Rules
//   5. For each picked lead, generates 4 messages (connection + DM 1/2/3)
//      EVERY message is run through sanitizeAndValidate which:
//        - Strips markdown, quotes, code fences
//        - Detects AI refusals
//        - Runs fillMergeFields as SAFETY PASS (catches AI leaving {first_name})
//        - Enforces hard character limits with word-boundary truncation
//   6. Creates Outreach records with Status=pending_approval, batch_id linking
//   7. Updates rule's "Last Batch Generated At" for idempotency
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const AT_API = "https://api.airtable.com/v0";

const AUTO_BATCH_RULE_NAME = "Sidekick Auto-Batch v1";
const DEFAULT_BATCH_SIZE = 5;
const DEFAULT_DM_CADENCE = { daysAfterConnect: 2, dm2Gap: 3, dm3Gap: 4 };
const MODEL = "gpt-5.4-mini";

const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Day rollover at 6am IST = 00:30 UTC
function todayIST6amRollover() {
  const nowUtc = new Date();
  const adjusted = new Date(nowUtc.getTime() - 30 * 60 * 1000);
  const ist = new Date(adjusted.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

async function atList(baseId, table, filterByFormula = "") {
  const all = [];
  let offset = null;
  do {
    const qs = new URLSearchParams();
    if (filterByFormula) qs.set("filterByFormula", filterByFormula);
    qs.set("pageSize", "100");
    if (offset) qs.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}`, {
      headers: atHdr, cache: "no-store",
    });
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 403 && /INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/.test(t)) return all;
      throw new Error(`AT list ${table} ${r.status}: ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

async function atCreate(baseId, table, records) {
  const all = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ fields: r }));
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST", headers: atHdr,
      body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (!r.ok) {
      const t = await r.text();
      console.error(`[AUTO-BATCH] atCreate ${table} ${r.status}:`, t.slice(0, 300));
      throw new Error(`Failed to create ${table}: ${t.slice(0, 200)}`);
    }
    const d = await r.json();
    all.push(...(d.records || []));
  }
  return all;
}

async function atUpdate(baseId, table, records) {
  const all = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: atHdr, body: JSON.stringify({ records: batch }),
    });
    if (!r.ok) console.error(`[AUTO-BATCH] atUpdate ${table}:`, (await r.text()).slice(0, 300));
    else { const d = await r.json(); all.push(...(d.records || [])); }
  }
  return all;
}

async function getOrCreateAutoBatchRule(baseId, campaignAccountId, requestOrigin) {
  // ─── Self-heal Task Rules schema first ───────────────────────
  // Veloka's Task Rules table may not have "Outreach Config" if the campaign
  // was created without linkedin_outreach setup. Call ensure_fields to add
  // missing fields before we try to create the rule.
  if (requestOrigin) {
    try {
      await fetch(new URL("/api/airtable", requestOrigin).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ensure_fields",
          baseId,
          table: "Task Rules",
          fieldNames: [
            { name: "Name", type: "singleLineText" },
            { name: "Task Type", type: "singleLineText" },
            { name: "Outreach Config", type: "multilineText" },
          ],
        }),
      });
    } catch (e) {
      console.warn("[AUTO-BATCH] ensure_fields call failed (non-fatal):", e.message);
    }
  }

  const rules = await atList(baseId, "Task Rules");
  let rule = rules.find(r => (r.fields?.Name || "") === AUTO_BATCH_RULE_NAME);

  if (rule) {
    let config;
    try { config = JSON.parse(rule.fields?.["Outreach Config"] || "{}"); }
    catch { config = {}; }
    return { rule, ruleId: rule.id, config };
  }

  const defaultConfig = {
    active: true,
    accountId: campaignAccountId || "",
    autoBatchEnabled: true,
    autoBatchSize: DEFAULT_BATCH_SIZE,
    autoBatchSchedule: "daily_morning",
    lastBatchGeneratedAt: null,
    connectionMessage: "Hi {first_name} — saw your recent activity at {company}. Worth a quick chat?",
    daysAfterConnect: DEFAULT_DM_CADENCE.daysAfterConnect,
    dmSequence: [
      {
        message: "Thanks for connecting {first_name}. Given {company}'s recent moves, curious how you're thinking about pipeline this quarter?",
        aiGenerate: true,
        daysAfterPrev: 0,
      },
      {
        message: "Following up {first_name} — I shared a quick teardown of a similar team's outbound setup recently. Want me to send it across?",
        aiGenerate: true,
        daysAfterPrev: DEFAULT_DM_CADENCE.dm2Gap,
      },
      {
        message: "Last one {first_name} — happy to share the playbook either way. No strings. Worth 15 min?",
        aiGenerate: true,
        daysAfterPrev: DEFAULT_DM_CADENCE.dm3Gap,
      },
    ],
    leadPrompt: "(unused — auto-batch picks via composite scoring)",
  };

  const created = await atCreate(baseId, "Task Rules", [{
    Name: AUTO_BATCH_RULE_NAME,
    "Task Type": "linkedin_outreach",
    "Outreach Config": JSON.stringify(defaultConfig),
  }]);

  if (!created.length) throw new Error("Failed to create auto-batch rule");
  return { rule: created[0], ruleId: created[0].id, config: defaultConfig };
}

// ─── AI generation with strict validation ────────────────────────
// Every message: AI generates → sanitizeAndValidate runs (strip formatting,
// merge-field safety pass, refusal detection, char-limit enforcement) → on
// any failure → deterministic fallback. NO unsafe text ever reaches the DB.
async function generateLeadDrafts(lead, scoring, campaignContext) {
  const f = lead?.fields || {};
  const names = deriveNames(f);
  const firstName = names.first || "there";
  const company = (f.Company || "your team");
  const reasons = scoring?.reasons?.length ? scoring.reasons.join("; ") : "high lead score";

  const buildFallback = () => ({
    connectionNote: deterministicFallback(lead, "connection_note"),
    dm1: deterministicFallback(lead, "dm_1"),
    dm2: deterministicFallback(lead, "dm_2"),
    dm3: deterministicFallback(lead, "dm_3"),
    costUsd: 0,
    validation: {
      connection: { fallback: true, reason: "no_ai_or_failed" },
      dm1: { fallback: true }, dm2: { fallback: true }, dm3: { fallback: true },
    },
  });

  if (!OPENAI_KEY) return buildFallback();

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  const leadName = f.Name || f["Full Name"] || firstName;
  const title = pickLeadField(f, "title") || "your role";

  // STRICT system prompt:
  // - Inline first name as plain text, NOT {first_name}
  // - Hard char limits per message type
  // - JSON-only output
  const system = `You write LinkedIn outreach for Side Kick (B2B outbound infrastructure).

ABSOLUTE RULES:
- Output ONLY valid JSON. No preamble, no markdown, no code fences, no quotes around messages.
- Inline "${firstName}" as plain text. NEVER write {first_name}, {name}, or any {placeholder}.
- Inline "${company}" as plain text. NEVER write {company}.
- No emojis. No markdown (**, _, \`).

CHARACTER LIMITS (hard caps, count them):
- connectionNote: 260 chars MAX (LinkedIn cap is 300, leave headroom)
- dm1: 600 chars MAX
- dm2: 550 chars MAX
- dm3: 500 chars MAX

MESSAGE PURPOSE:
- connectionNote: warm intro that names the why-now signal. Soft connect ask. No demo ask.
- dm1: sent 2 days post-accept. Thank briefly, reference signal with new insight, one low-pressure question.
- dm2: sent 3 days post-dm1. One specific observation or insight. Soft ask.
- dm3: sent 4 days post-dm2. Soft close. No guilt-trip. Optional take-away resource.

Output JSON shape:
{ "connectionNote": "...", "dm1": "...", "dm2": "...", "dm3": "..." }`;

  const user = `Lead: ${leadName}, ${title} at ${company}
Why now: ${reasons}
Campaign: ${campaignContext || "B2B outbound, AI-driven SDR"}

Generate the 4 messages following all rules.`;

  let resp;
  try {
    resp = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      temperature: 0.7,
      max_tokens: 1000,
    });
  } catch (e) {
    console.error(`[AUTO-BATCH] AI failed for ${leadName}:`, e.message);
    return { ...buildFallback(), aiFailed: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(resp.choices[0]?.message?.content || "{}");
  } catch {
    parsed = {};
  }

  // ─── Sanitize + validate each ──────────────────────────────────
  // sanitizeAndValidate runs fillMergeFields as a safety pass, so even if
  // AI ignored instructions and output "Hi {first_name}", it gets resolved
  // to the real name. If validation fails (refusal, can't merge, etc.) →
  // deterministicFallback ensures we never store garbage.
  const validateOne = (raw, kind) => sanitizeAndValidate(raw, {
    lead,
    signal: f.Signal || reasons,
    company,
    kind,
  });

  const connRes = validateOne(parsed.connectionNote, "connection_note");
  const dm1Res = validateOne(parsed.dm1, "dm");
  const dm2Res = validateOne(parsed.dm2, "dm");
  const dm3Res = validateOne(parsed.dm3, "dm");

  // Log any validation failures so we can debug
  for (const [kind, res] of [["connection", connRes], ["dm1", dm1Res], ["dm2", dm2Res], ["dm3", dm3Res]]) {
    if (!res.ok) {
      console.warn(`[AUTO-BATCH] ${leadName} ${kind} validation failed: ${res.reason}`,
        res.placeholder ? `field=${res.placeholder}` : "",
        res.refusalSnippet ? `snippet="${res.refusalSnippet}"` : "");
    }
  }

  // Cost (gpt-5.4-mini: $0.75/M input, $4.50/M output)
  const inputTokens = resp.usage?.prompt_tokens || 0;
  const outputTokens = resp.usage?.completion_tokens || 0;
  const costUsd = (inputTokens / 1e6) * 0.75 + (outputTokens / 1e6) * 4.50;

  return {
    connectionNote: connRes.ok ? connRes.text : deterministicFallback(lead, "connection_note"),
    dm1: dm1Res.ok ? dm1Res.text : deterministicFallback(lead, "dm_1"),
    dm2: dm2Res.ok ? dm2Res.text : deterministicFallback(lead, "dm_2"),
    dm3: dm3Res.ok ? dm3Res.text : deterministicFallback(lead, "dm_3"),
    costUsd,
    validation: {
      connection: connRes,
      dm1: dm1Res, dm2: dm2Res, dm3: dm3Res,
    },
  };
}

export async function POST(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "AIRTABLE_API_KEY missing" }, { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

  const { baseId, campaignId, size = DEFAULT_BATCH_SIZE, force = false, accountId, campaignContext } = body;
  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  }

  try {
    const requestOrigin = new URL(request.url).origin;
    const { rule, ruleId, config } = await getOrCreateAutoBatchRule(baseId, accountId, requestOrigin);

    // Idempotency
    const todayKey = todayIST6amRollover();
    if (!force && config.lastBatchGeneratedAt === todayKey) {
      const existing = await atList(baseId, "Outreach",
        `AND({Status} = 'pending_approval', {Batch ID} = '${todayKey}')`);
      return NextResponse.json({
        ok: true, alreadyGeneratedToday: true, batchId: todayKey, ruleId,
        existingCount: existing.length,
        message: "Batch already generated today. Use force=true to regenerate.",
      });
    }

    // Load data
    const [leads, tasks, existingOutreach] = await Promise.all([
      atList(baseId, "Leads"),
      atList(baseId, "Tasks"),
      atList(baseId, "Outreach"),
    ]);

    // Exclude leads already in active outreach
    const STALE_STATUSES = new Set(["skipped", "completed", "replied"]);
    const excludeLinkedIns = new Set(
      existingOutreach
        .filter(r => !STALE_STATUSES.has((r.fields?.Status || "").toLowerCase()))
        .map(r => (r.fields?.["LinkedIn URL"] || "").toLowerCase().trim())
        .filter(Boolean)
    );

    const ranked = rankLeadsForBatch({
      leads, tasks, excludeLinkedIns,
      maxResults: Math.min(size, 20),
    });

    if (!ranked.length) {
      return NextResponse.json({
        ok: true, batchId: todayKey, ruleId, count: 0,
        message: "No eligible leads found (all excluded or no signals).",
      });
    }

    // Generate drafts (parallelism capped to avoid rate limits)
    const drafts = [];
    const PARALLEL = 3;
    for (let i = 0; i < ranked.length; i += PARALLEL) {
      const slice = ranked.slice(i, i + PARALLEL);
      const results = await Promise.all(slice.map(r =>
        generateLeadDrafts(r.lead, r.scoring, campaignContext)
      ));
      drafts.push(...results);
    }

    // Create Outreach records
    const records = ranked.map(({ lead, scoring, linkedinUrl }, i) => {
      const f = lead.fields || {};
      const d = drafts[i];
      return {
        "Lead Name": f.Name || f["Full Name"] || "Unknown",
        "LinkedIn URL": linkedinUrl,
        Campaign: AUTO_BATCH_RULE_NAME,
        Mode: "auto_batch",
        Status: "pending_approval",
        Company: f.Company || "",
        Title: pickLeadField(f, "title") || "",
        Email: pickLeadField(f, "email") || "",
        Signal: scoring.reasons.join(" · "),
        "DM Step": 0,
        "Created At": new Date().toISOString(),
        "Generated Connection Note": d.connectionNote,
        "Generated DM 1": d.dm1,
        "Generated DM 2": d.dm2,
        "Generated DM 3": d.dm3,
        "Batch ID": todayKey,
        "Why Reasons": scoring.reasons.join(" · "),
        "Composite Score": scoring.score,
      };
    });

    const created = await atCreate(baseId, "Outreach", records);

    // Update rule's lastBatchGeneratedAt
    const updatedConfig = { ...config, lastBatchGeneratedAt: todayKey };
    await atUpdate(baseId, "Task Rules", [{
      id: ruleId,
      fields: { "Outreach Config": JSON.stringify(updatedConfig) },
    }]);

    const validationStats = {
      connectionFallbacks: drafts.filter(d => d.validation?.connection?.fallback || !d.validation?.connection?.ok).length,
      dm1Fallbacks: drafts.filter(d => d.validation?.dm1?.fallback || !d.validation?.dm1?.ok).length,
      dm2Fallbacks: drafts.filter(d => d.validation?.dm2?.fallback || !d.validation?.dm2?.ok).length,
      dm3Fallbacks: drafts.filter(d => d.validation?.dm3?.fallback || !d.validation?.dm3?.ok).length,
    };

    const totalCost = drafts.reduce((s, d) => s + (d.costUsd || 0), 0);
    const aiFailed = drafts.filter(d => d.aiFailed).length;

    return NextResponse.json({
      ok: true,
      batchId: todayKey,
      ruleId,
      count: created.length,
      ranked: ranked.length,
      costUsd: Math.round(totalCost * 10000) / 10000,
      aiFailedCount: aiFailed,
      validationStats,
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[AUTO-BATCH GENERATE]", e);
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
