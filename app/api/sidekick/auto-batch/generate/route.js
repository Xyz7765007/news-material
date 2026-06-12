import { NextResponse } from "next/server";
import OpenAI from "openai";
import { rankLeadsForBatch } from "@/lib/composite-score.js";
import { pickLeadField } from "@/lib/lead-fields.js";
import {
  sanitizeAndValidate,
  deterministicFallback,
  deriveNames,
} from "@/lib/message-merge.js";
import { buildLeadBrief, briefToPromptBlock, briefToUiBullets } from "@/lib/lead-brief.js";
import { LINKEDIN_DMS_ENABLED, connectorDisabledResponse } from "@/lib/connector-flags.js";
import { fetchPreferences } from "@/app/api/sidekick/preferences/route.js";

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

// ─── Feedback-loop prompt block (bounded) ───────────────────────────
// Turns recent operator feedback rows into a compact "learned
// preferences" block injected into the generation system prompt.
// Capped at ~1500 chars total so it can't balloon the prompt or push
// out the personalization rules. Most-recent-first (prefs already come
// sorted that way). These are STYLE guidance only — the prompt's
// internal-vs-public rules still bind, so prefs can never reintroduce
// scores / rule names into public copy.
const FEEDBACK_BLOCK_CHAR_CAP = 1500;
function buildFeedbackBlock(label, prefs) {
  if (!prefs || !prefs.length) return "";
  const lines = [];
  let used = 0;
  for (const p of prefs) {
    const note = (p.feedback_text || "").replace(/\s+/g, " ").trim();
    if (!note) continue;
    const span = (p.quoted_span || "").replace(/\s+/g, " ").trim();
    const line = span
      ? `- on "${span.slice(0, 120)}": ${note.slice(0, 240)}`
      : `- ${note.slice(0, 240)}`;
    if (used + line.length + 1 > FEEDBACK_BLOCK_CHAR_CAP) break;
    lines.push(line);
    used += line.length + 1;
  }
  if (!lines.length) return "";
  return `OPERATOR FEEDBACK — ${label} (apply these learned preferences, most recent first):\n${lines.join("\n")}`;
}

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
  // missing fields before we try to create the rule. Also ensures Outreach
  // has Post URL for the chatbot to render a clickable LinkedIn link.
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
      await fetch(new URL("/api/airtable", requestOrigin).toString(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "ensure_fields",
          baseId,
          table: "Outreach",
          fieldNames: [
            { name: "Post URL", type: "url" },
            { name: "AI Debug", type: "multilineText" },
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

// ─── detectInternalLeak ──────────────────────────────────────────
// Returns true if the generated message contains internal scoring data
// or qualification language that should never reach the prospect. Used
// as a final guard after AI generation — if leak detected, message is
// thrown out and replaced with deterministic fallback.
function detectInternalLeak(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.toLowerCase();
  const leaks = [
    /\b\d{1,3}\/100\b/,                          // "67/100"
    /\bicp fit\b/,
    /\bicp score\b/,
    /\bqualification score\b/,
    /\bscore:\s*\d/,                              // "score: 67"
    /\bdeterministic[:\s]/,
    /\blead-side rules\b/,
    /\bacv score\b/,
    /\btam (small|large|big)\b/,
    /\btop \d+ leads?\b/,
    /\bcombo stood out\b/,
    /\blooks like a strong fit\b/,
    /\b\d{1,3}-\d{1,3}\s+(sales|marketing) team\b/,  // "11-30 sales team"
    /\brules matched\b/,
    /\bicp profile\b/,
  ];
  return leaks.some(re => re.test(t));
}

// ─── AI generation with deep personalization ─────────────────────
// Builds a structured Lead Intelligence Brief from all relevant tasks,
// passes it to AI with forced-citation rules + anti-generic examples.
// Every output runs through sanitizeAndValidate (merge-field safety pass,
// char limits, refusal detection) AND detectInternalLeak (catches AI
// citing internal scoring data back to the prospect). On failure →
// deterministic fallback.
async function generateLeadDrafts(lead, scoring, campaignContext, feedbackBlocks = {}) {
  const f = lead?.fields || {};
  const names = deriveNames(f);
  const firstName = names.first || "there";
  const company = (f.Company || "your team");

  // Build structured brief from the lead's relevant tasks
  const brief = buildLeadBrief(lead, scoring.relevantTasks || []);
  const contextBlock = briefToPromptBlock(brief);
  const uiBullets = briefToUiBullets(brief);

  const buildFallback = () => ({
    connectionNote: deterministicFallback(lead, "connection_note"),
    dm1: deterministicFallback(lead, "dm_1"),
    dm2: deterministicFallback(lead, "dm_2"),
    dm3: deterministicFallback(lead, "dm_3"),
    costUsd: 0,
    uiBullets,
    validation: {
      connection: { fallback: true, reason: "no_ai_or_failed" },
      dm1: { fallback: true }, dm2: { fallback: true }, dm3: { fallback: true },
    },
  });

  if (!OPENAI_KEY) return buildFallback();

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  const leadName = brief.identity.fullName;
  const title = brief.identity.title || "your role";

  // ═══════════════════════════════════════════════════════════════
  // DEEP-PERSONALIZATION PROMPT
  // The core change: every message MUST cite specific data from
  // RECENT LEAD ACTIVITY. Generic templates banned by explicit rule
  // + worked examples. The brief block surfaces named facts AI can
  // quote directly (direct quotes, suggested angles, AI rationale).
  // ═══════════════════════════════════════════════════════════════
  const system = `You write hyper-personalized LinkedIn outreach for Side Kick (B2B outbound infrastructure).

═════════════════════════════════════════════════════════════
ABSOLUTE OUTPUT RULES (violations = rejected output):
═════════════════════════════════════════════════════════════
1. Output ONLY valid JSON. No preamble, no markdown, no code fences.
2. Inline "${firstName}" as plain text. NEVER write {first_name}, {name}, or any {placeholder}.
3. Inline "${company}" as plain text. NEVER write {company}.
4. No emojis. No markdown (**, _, \`). No quotes around messages.

═════════════════════════════════════════════════════════════
PERSONALIZATION RULES (THE CORE OF THIS JOB):
═════════════════════════════════════════════════════════════
Each of the 4 messages MUST cite ≥1 SPECIFIC fact from PUBLIC FACTS:
  - A number (e.g. "112% growth", "$50M raise")
  - A direct quote from their post (kept in quotes)
  - A named observation they made (e.g. "your D2C / Qcom split")
  - A specific topic they wrote about

═════════════════════════════════════════════════════════════
WHAT YOU NEVER DO (instant fail — output rejected):
═════════════════════════════════════════════════════════════

A. INTERNAL-LEAK PHRASES — these expose our internal tooling to the lead.
   NEVER use these or anything resembling them:
   ✗ "your 67/100 fit"   ✗ "67/100"   ✗ "X/100" of any kind
   ✗ "ICP fit"   ✗ "ICP score"   ✗ "qualification score"
   ✗ "score:" anything   ✗ "the score"   ✗ "deterministic"
   ✗ "Lead-side rules matched"   ✗ "rules matched"
   ✗ "ACV Score 7-10" (translate to "high revenue tier" or omit entirely)
   ✗ "TAM Small" / "TAM Large" (translate or omit)
   ✗ "top 10 leads" / "top X leads"
   ✗ "combo stood out"   ✗ "looks like a strong fit"
   ✗ Any numeric team-size in "X-Y range" format (e.g. "11-30 sales team")

B. GENERIC PHRASES — instant fail:
   ✗ "noticed your work at [company]"
   ✗ "saw your recent activity"
   ✗ "your latest post"
   ✗ "great post about [topic]"
   ✗ "curious how you're thinking about [generic thing] this year"
   ✗ "happy to share a teardown"
   ✗ "if [generic thing] is on the roadmap"
   ✗ Any compliment without a specific data point attached

═════════════════════════════════════════════════════════════
WHEN NO PUBLIC FACTS EXIST:
═════════════════════════════════════════════════════════════
If PUBLIC FACTS says "(none)", do NOT invent activity. Instead:
  - Use general knowledge of the lead's company + role to write
    something credible. Reference the COMPANY's actual business
    (what they do, the market they're in), not internal scoring.
  - Example for a founder at an Indian travel-tech company:
    "Amar — building outbound for B2B travel platforms in India is
    a specific motion. Curious how TraviYo is thinking about that
    layer right now." (industry-aware, NOT internal-scoring-aware)
  - Keep it short and honest. Don't fake specificity you don't have.

═════════════════════════════════════════════════════════════
WORKED EXAMPLES — bad vs good:
═════════════════════════════════════════════════════════════
Bad (cites internal scoring — instant reject):
"Amar, your 67/100 ICP fit and the 11-30 sales team / 9-20 marketing
team combo stood out. TraviYo looks like a strong fit for structured
outbound."

Bad (generic, no specifics):
"Hi Devi — noticed your work at 1digitalstack.ai. Would like to connect."

Good (cites a real quote the lead actually wrote):
"Hi Devi — your 112% Qcom number in healthy snacks caught my eye,
especially the Bangalore-led adoption. We help D2C brands set up outbound
around exactly this kind of category shift. Worth a chat?"

Good (no public facts, leans on company + role):
"Amar — building outbound for B2B travel platforms is a specific
challenge. Curious how TraviYo is approaching that motion right now.
Open to connecting?"

═════════════════════════════════════════════════════════════
PLAIN-LANGUAGE RULES (read at a 10-year-old's level):
═════════════════════════════════════════════════════════════
Write so a sharp 10-year-old could follow it. Assume they know the
technical/industry terms (keep "ACV", "Qcom", "outbound", "D2C" etc.) —
but keep the SENTENCES simple:
  - Short sentences. One idea per sentence. Aim ≤ 15 words each.
  - Plain everyday verbs: "saw", "build", "help", "set up" — not
    "leverage", "facilitate", "utilize", "spearhead", "orchestrate".
  - No stacked jargon or buzzword chains (✗ "best-in-class scalable
    synergy"). Say the thing plainly.
  - No long wind-up clauses. Get to the point in the first sentence.
  - Prefer active voice ("we help D2C brands…") over passive
    ("D2C brands are helped by…").
  - If a sentence needs to be re-read to be understood, rewrite it.
A simple message that a busy person grasps in 2 seconds beats a clever
one. Specificity (the cited fact) stays; complexity goes.

═════════════════════════════════════════════════════════════
PER-MESSAGE REQUIREMENTS:
═════════════════════════════════════════════════════════════
- connectionNote (max 260 chars): open with a specific reference to their
  PUBLIC activity if available; else lean on company/role. Soft connect ask.
- dm1 (max 600 chars, sent 2d post-connect): thank briefly, go deeper on the
  PUBLIC signal or company context. Add YOUR observation. One specific question.
- dm2 (max 550 chars, sent 3d post-dm1): bring a NEW angle, parallel, or data
  point you didn't mention before. Soft ask.
- dm3 (max 500 chars, sent 4d post-dm2): soft close. No guilt-trip. Offer a
  SPECIFIC takeaway/resource (e.g. "if useful, here's how [Similar Company]
  handled their [X]") even if they don't reply.

═════════════════════════════════════════════════════════════
SELF-CHECK BEFORE OUTPUT:
═════════════════════════════════════════════════════════════
For each of the 4 messages, verify:
  (a) Does it contain at least ONE specific noun/quote from PUBLIC FACTS,
      OR (if no public facts) a credible company/role-based observation?
  (b) Is it free of internal-leak phrases (no scores, no ratings, no rule names)?
  (c) Is it free of generic phrases (no "noticed your work")?
  (d) Would the lead read it and think "this is from someone who actually
      knows my work" — not "this is from a database that scored me"?
If any check fails, rewrite before outputting.

Output JSON shape:
{ "connectionNote": "...", "dm1": "...", "dm2": "...", "dm3": "..." }`;

  // ─── Inject learned operator preferences (feedback loop) ──────────
  // connectionNote applies the connection_note feedback; the 3 DMs apply
  // the dm feedback. Style guidance only — the internal-vs-public rules
  // above still bind, so prefs can never reintroduce scores/rule names
  // into public copy. Bounded per buildFeedbackBlock (~1500 chars each).
  const cnBlock = feedbackBlocks.connection_note || "";
  const dmBlock = feedbackBlocks.dm || "";
  const feedbackSection = [
    cnBlock ? `For the connectionNote field:\n${cnBlock}` : "",
    dmBlock ? `For the dm1/dm2/dm3 fields:\n${dmBlock}` : "",
  ].filter(Boolean).join("\n\n");

  const user = `LEAD:
  Name: ${leadName}
  Role: ${title} at ${company}
  LinkedIn: ${brief.identity.linkedinUrl || "(unknown)"}

${contextBlock}

CAMPAIGN CONTEXT:
${campaignContext || "B2B outbound infrastructure — Side Kick builds AI-driven SDR systems for B2B companies that have outgrown traditional SDR agencies. Customers include companies running cold outbound at scale who want personalization without manual SDR overhead."}
${feedbackSection ? `\n${feedbackSection}\n` : ""}
Generate the 4 messages following ALL rules above. Cite ONLY from PUBLIC FACTS. NEVER cite anything from INTERNAL CONTEXT. If PUBLIC FACTS is empty, lean on company/role inference — do not invent activity.`;

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
      // CRITICAL: gpt-5.4-mini requires max_completion_tokens, not max_tokens.
      // Using max_tokens silently caps the response → AI returns empty fields
      // → every message falls back to deterministic template (the bug Samarth
      // hit on 2026-05-16). All other working OpenAI calls in this codebase
      // use max_completion_tokens.
      max_completion_tokens: 1400,
    });
  } catch (e) {
    console.error(`[AUTO-BATCH] AI failed for ${leadName}:`, e.message);
    return { ...buildFallback(), aiFailed: true, aiError: e.message };
  }

  const rawContent = resp.choices?.[0]?.message?.content || "";
  let parsed;
  try {
    parsed = JSON.parse(rawContent || "{}");
  } catch (e) {
    console.warn(`[AUTO-BATCH] JSON parse failed for ${leadName}. Raw:`, rawContent.slice(0, 400));
    parsed = {};
  }

  // Log when the AI response is effectively empty so we can debug
  if (!parsed.connectionNote && !parsed.dm1) {
    console.warn(`[AUTO-BATCH] AI returned empty fields for ${leadName}. Raw response:`, rawContent.slice(0, 500), "Usage:", JSON.stringify(resp.usage));
  }

  // Validate each message — merge field safety pass, char limits, refusal check
  const validateOne = (raw, kind) => {
    const res = sanitizeAndValidate(raw, {
      lead,
      signal: f.Signal || contextBlock,
      company,
      kind,
    });
    // Extra guard: detect internal scoring/qualification language leaking
    // into the message body. If AI cites our internal scoring data, throw
    // it out — better a generic deterministic fallback than a message that
    // mentions "67/100 ICP fit" to the prospect.
    if (res.ok && detectInternalLeak(res.text)) {
      return { ok: false, reason: "internal_leak_detected", snippet: res.text.slice(0, 120) };
    }
    return res;
  };

  const connRes = validateOne(parsed.connectionNote, "connection_note");
  const dm1Res = validateOne(parsed.dm1, "dm");
  const dm2Res = validateOne(parsed.dm2, "dm");
  const dm3Res = validateOne(parsed.dm3, "dm");

  // Log validation failures for debugging
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
    uiBullets,
    rawAiResponse: rawContent.slice(0, 8000),  // for debugging — saved on Outreach record
    aiUsage: resp.usage || null,
    validation: { connection: connRes, dm1: dm1Res, dm2: dm2Res, dm3: dm3Res },
  };
}

export async function POST(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  // LinkedIn DMs kill-switch (Kunal's lever — see lib/connector-flags.js).
  // This route AI-generates the connection note + DM sequence for the chatbot
  // auto-batch, so it is part of the "LinkedIn DMs" family and is paused with it.
  if (!LINKEDIN_DMS_ENABLED) {
    console.warn("[CONNECTOR-FLAG] LinkedIn DMs OFF — blocked auto-batch generate");
    return NextResponse.json(connectorDisabledResponse("dms"), { status: 403 });
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
    const todayKey = todayIST6amRollover();

    // ─── Always clean stale pending_approval FIRST ────────────
    // Runs on EVERY generate call BEFORE the idempotency check.
    //  - Old Batch ID pending records (yesterday's leftover): ALWAYS
    //    clean. They're stale regardless of whether user passed force.
    //  - Today's Batch ID pending records: only clean on force=true.
    //  - Orphan queued records (from legacy manual Enqueue, no AI text):
    //    ALWAYS clean — they would send generic messages otherwise.
    //
    // CRITICAL: this runs BEFORE the idempotency early-return so that even
    // benign poll-on-mount calls (force=false) clean yesterday's stragglers.
    // Previously cleanup was inside `if (force)` AFTER the idempotency
    // return, which meant stale records survived forever when today's batch
    // already existed → multiple batch cards in the chatbot UI.
    //
    // Also: verify cleanup succeeded. atUpdate batches PATCH calls in 10s
    // and logs-and-continues on individual batch failure. Now we re-check
    // after cleanup and retry once; if it still fails, abort with 500
    // rather than create new records that would duplicate the survivors.
    try {
      const allPending = await atList(baseId, "Outreach",
        `{Status} = 'pending_approval'`);
      const toClean = allPending.filter(r => {
        const batchId = r.fields?.["Batch ID"] || "";
        return batchId !== todayKey || force;
      });

      if (toClean.length) {
        const updates = toClean.map(r => ({
          id: r.id,
          fields: {
            Status: "skipped",
            Notes: `${r.fields?.Notes || ""}\n[${new Date().toISOString()}] Stale cleanup (force=${force})`.trim(),
          },
        }));
        await atUpdate(baseId, "Outreach", updates);

        // Verify cleanup actually landed
        const recheck = await atList(baseId, "Outreach",
          `{Status} = 'pending_approval'`);
        const stillStale = recheck.filter(r => {
          const batchId = r.fields?.["Batch ID"] || "";
          return batchId !== todayKey || force;
        });
        if (stillStale.length) {
          console.error(`[AUTO-BATCH] cleanup verification failed: ${stillStale.length} stale records survive PATCH — retrying once`);
          const retry = stillStale.map(r => ({
            id: r.id,
            fields: { Status: "skipped", Notes: `${r.fields?.Notes || ""}\n[${new Date().toISOString()}] Retry cleanup`.trim() },
          }));
          await atUpdate(baseId, "Outreach", retry);
          const finalCheck = await atList(baseId, "Outreach",
            `{Status} = 'pending_approval'`);
          const survivors = finalCheck.filter(r => (r.fields?.["Batch ID"] || "") !== todayKey || force);
          if (survivors.length) {
            return NextResponse.json({
              error: `Cleanup failed: ${survivors.length} stale pending_approval records could not be marked as skipped. Refusing to create new batch to avoid duplicates. Manual cleanup required (open Veloka Outreach in Airtable and mark them as skipped).`,
              survivors: survivors.map(r => ({ id: r.id, lead: r.fields?.["Lead Name"], batchId: r.fields?.["Batch ID"] })),
            }, { status: 500 });
          }
        }
        console.log(`[AUTO-BATCH] cleaned ${toClean.length} stale pending_approval records (force=${force})`);
      }

      // Orphan queued records (legacy Enqueue Leads path)
      const allQueued = await atList(baseId, "Outreach",
        `AND({Status} = 'queued', {Campaign} = '${AUTO_BATCH_RULE_NAME}')`);
      const orphans = allQueued.filter(r => !r.fields?.["Generated Connection Note"]);
      if (orphans.length) {
        const updates = orphans.map(r => ({
          id: r.id,
          fields: {
            Status: "skipped",
            Notes: `${r.fields?.Notes || ""}\n[${new Date().toISOString()}] Orphan cleanup — no AI personalization. Re-enqueue via chatbot if intended.`.trim(),
          },
        }));
        await atUpdate(baseId, "Outreach", updates);
        console.log(`[AUTO-BATCH] cleaned ${orphans.length} orphan queued records`);
      }
    } catch (e) {
      console.warn("[AUTO-BATCH] Failed to clean stale records:", e.message);
    }

    // ─── Idempotency check (records-based, not flag-based) ──────
    // We previously checked config.lastBatchGeneratedAt — a cached flag
    // updated AFTER atCreate. If that update silently failed (Airtable
    // rate limit, network blip), records existed but the flag didn't
    // reflect it → next mount → flag check fails → creates ANOTHER batch
    // on top of existing → user sees 10 pending instead of 5.
    //
    // Now we check the records themselves. If any pending_approval
    // records exist with today's Batch ID, today's batch is "generated"
    // — regardless of what the flag says.
    if (!force) {
      const existing = await atList(baseId, "Outreach",
        `AND({Status} = 'pending_approval', {Batch ID} = '${todayKey}')`);
      if (existing.length > 0) {
        return NextResponse.json({
          ok: true, alreadyGeneratedToday: true, batchId: todayKey, ruleId,
          existingCount: existing.length,
          message: `Batch already generated today (${existing.length} pending records exist). Use force=true to regenerate.`,
        });
      }
    }

    // Load data
    const [leads, tasks, existingOutreach] = await Promise.all([
      atList(baseId, "Leads"),
      atList(baseId, "Tasks"),
      atList(baseId, "Outreach"),
    ]);

    // Exclude leads already in active outreach. NOTE: pending_approval just
    // got cleared above on force=true, so this only catches truly-active
    // outreach (queued / connection_sent / connected / dm_N).
    const STALE_STATUSES = new Set(["skipped", "completed", "replied", "pending_approval"]);
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

    // ─── Feedback loop: fetch recent operator prefs ONCE for the base ──
    // connection_note prefs drive the connection note; dm prefs drive the
    // 3 DMs. Fetched once and reused for every lead in the batch. Degrades
    // gracefully — fetchPreferences returns [] if the table is absent, so
    // generation still runs with no learned prefs.
    const [cnPrefs, dmPrefs] = await Promise.all([
      fetchPreferences(baseId, "connection_note", 15),
      fetchPreferences(baseId, "dm", 15),
    ]);
    const feedbackBlocks = {
      connection_note: buildFeedbackBlock("connection notes", cnPrefs),
      dm: buildFeedbackBlock("DMs", dmPrefs),
    };

    // Generate drafts (parallelism capped to avoid rate limits)
    const drafts = [];
    const PARALLEL = 3;
    for (let i = 0; i < ranked.length; i += PARALLEL) {
      const slice = ranked.slice(i, i + PARALLEL);
      const results = await Promise.all(slice.map(r =>
        generateLeadDrafts(r.lead, r.scoring, campaignContext, feedbackBlocks)
      ));
      drafts.push(...results);
    }

    // Create Outreach records
    const records = ranked.map(({ lead, scoring, linkedinUrl }, i) => {
      const f = lead.fields || {};
      const d = drafts[i];
      // uiBullets = clean 1-3 line summary for chatbot (replaces raw Signal blob)
      const cleanReasons = (d.uiBullets && d.uiBullets.length)
        ? d.uiBullets.join("\n")
        : scoring.reasons.join(" · ");
      // Find the most recent linkedin post URL from relevant tasks (if any)
      let postUrl = "";
      for (const t of (scoring.relevantTasks || [])) {
        const sig = t.fields?.Signal || "";
        const m = sig.match(/https:\/\/(www\.)?linkedin\.com\/feed\/update\/[^\s)\]]+/);
        if (m) { postUrl = m[0]; break; }
      }
      // Per-message validation status — visible in Airtable for debugging
      const valSummary = [
        `conn: ${d.validation?.connection?.ok ? "ok" : d.validation?.connection?.reason || "fallback"}`,
        `dm1: ${d.validation?.dm1?.ok ? "ok" : d.validation?.dm1?.reason || "fallback"}`,
        `dm2: ${d.validation?.dm2?.ok ? "ok" : d.validation?.dm2?.reason || "fallback"}`,
        `dm3: ${d.validation?.dm3?.ok ? "ok" : d.validation?.dm3?.reason || "fallback"}`,
      ].join(" | ");
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
        "Why Reasons": cleanReasons,
        "Post URL": postUrl,
        "Composite Score": scoring.score,
        // Debug fields — visible in Airtable for inspecting AI failures
        "AI Debug": [
          `Validation: ${valSummary}`,
          `Cost: $${(d.costUsd || 0).toFixed(5)}`,
          d.aiError ? `Error: ${d.aiError}` : "",
          `Raw AI response (truncated):\n${(d.rawAiResponse || "").slice(0, 3000)}`,
        ].filter(Boolean).join("\n\n"),
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
