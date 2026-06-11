// ═══════════════════════════════════════════════════════════════════════════
// SCAN-RUN — resumable news + jobs scan orchestrator (LinkedIn-posts pattern)
//
// WHY: Vercel's 300s function cap means a full-fleet news scan (92 accounts ×
// 60-150s each) can NEVER run in one server invocation — historically the scan
// was browser-driven only, and when the browser closed the scan died. This
// route ports the proven /api/linkedin-posts resume pattern: progress state
// lives in a JSON field on the master Campaigns row, each invocation processes
// as many accounts as fit in its time budget, and `resume` continues from the
// cursor until complete. STANDING RULE (Samarth, 2026-06-10): wherever the
// Vercel 300s timeout is a bottleneck, use THIS pattern — chunked work + state
// + resume CTA/cron — not bigger functions.
//
// Actions (POST JSON):
//   { action:"start",  baseId, campaignAirtableId, threshold?, force? }
//   { action:"resume", campaignAirtableId }
//   { action:"get_progress", campaignAirtableId }
//   { action:"stop",   campaignAirtableId }
// Cron driver (no body needed): POST /api/scan-run?mode=resume&key=<CRON_SECRET>
//   — finds the first campaign with a running Signal Scan Status and ticks it.
//
// Phases: news (one /api/scan call per account, sequential — keeps the Google
// decode pacing happy) → jobs (one jobs-batch call per 5 accounts) → done.
// Matched signals → Tasks; retain band → Signal Archive (both deduped on
// Company|Rule|URL). The /api/scan route itself is UNTOUCHED — this route
// self-fetches it, so each account gets a fresh 300s budget of its own.
// ═══════════════════════════════════════════════════════════════════════════

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 300;

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;
const STATUS_FIELD = "Signal Scan Status"; // auto-created on first write

// Tick budget: leave headroom under maxDuration for state writes + response.
const TICK_BUDGET_MS = 240_000;
// Minimum runway needed to start another account scan inside this tick.
const MIN_RUNWAY_MS = 100_000;

const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

// ─── Airtable helpers (copied from linkedin-posts — isolation by design) ───
async function atList(baseId, table, params = {}) {
  const qs = new URLSearchParams();
  if (params.filterByFormula) qs.set("filterByFormula", params.filterByFormula);
  if (params.fields) params.fields.forEach(f => qs.append("fields[]", f));
  let all = [], offset = null;
  do {
    const u = new URLSearchParams(qs);
    if (offset) u.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${u}`, { headers: atHdr });
    if (!r.ok) throw new Error(`Airtable list ${table}: ${r.status} ${await r.text().then(t => t.slice(0, 200))}`);
    const d = await r.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

async function atGet(baseId, table, id) {
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${id}`, { headers: atHdr });
  if (!r.ok) return null;
  return r.json();
}

async function atCreateBatch(baseId, table, records) {
  let written = 0; const errors = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST", headers: atHdr, body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (r.ok) written += batch.length;
    else errors.push(await r.text().then(t => t.slice(0, 200)));
  }
  return { written, errors };
}

async function atUpdateWithAutoCreate(baseId, table, id, fields, attempt = 0) {
  if (attempt > 4) return false;
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${id}`, {
    method: "PATCH", headers: atHdr, body: JSON.stringify({ fields, typecast: true }),
  });
  if (r.ok) return true;
  const errText = await r.text();
  if (errText.includes("UNKNOWN_FIELD_NAME")) {
    try {
      const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: atHdr });
      if (tablesRes.ok) {
        const { tables } = await tablesRes.json();
        const t = tables.find(t => t.name === table);
        if (t) {
          const cr = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${t.id}/fields`, {
            method: "POST", headers: atHdr, body: JSON.stringify({ name: STATUS_FIELD, type: "multilineText" }),
          });
          if (cr.ok) {
            await new Promise(res => setTimeout(res, 1200));
            return atUpdateWithAutoCreate(baseId, table, id, fields, attempt + 1);
          }
        }
      }
    } catch (_) { /* fall through */ }
  }
  console.error(`[scan-run] state write failed: ${errText.slice(0, 200)}`);
  return false;
}

// ─── Progress state ────────────────────────────────────────────────────────
async function readState(campaignAirtableId) {
  const rec = await atGet(MASTER_BASE_ID, "Campaigns", campaignAirtableId);
  const raw = rec?.fields?.[STATUS_FIELD];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function writeState(campaignAirtableId, state) {
  const safe = { ...state, updated_at: new Date().toISOString() };
  if (Array.isArray(safe.failures) && safe.failures.length > 100) {
    safe.failures = [`[${safe.failures.length - 100} older failures dropped]`, ...safe.failures.slice(-99)];
  }
  await atUpdateWithAutoCreate(MASTER_BASE_ID, "Campaigns", campaignAirtableId, {
    [STATUS_FIELD]: JSON.stringify(safe),
  });
}

function publicProgress(state) {
  if (!state) return null;
  const { accounts, ...rest } = state;
  return { ...rest, accounts_total: accounts?.length ?? state.accounts_total ?? 0 };
}

// ─── Task buffering (mirrors SignalScope.jsx bufferSignals, server-side) ───
function nowIso() { return new Date().toISOString().replace(/\.\d+Z$/, ".000Z"); }

function bufferSignals(signals, company, defs, threshold, seen, archSeen) {
  const tasks = [], archive = [];
  for (const sig of signals || []) {
    const url = sig.url || "";
    for (const tid of (sig.matchedTaskIds || [])) {
      const td = defs.find(t => t.id === tid);
      if (!td) continue;
      const raw = (sig.relevanceScores || {})[tid];
      const score = Math.max(0, Math.min(100, Math.round(raw ?? (sig.confidence || 0.7) * 100)));
      if (score < threshold) continue;
      const fp = `${company.toLowerCase()}|${td.name.toLowerCase()}|${url.toLowerCase()}`;
      if (seen.has(fp)) continue;
      seen.add(fp);
      tasks.push({ fields: {
        Company: company, "Task Rule": td.name, Score: score,
        "Score Reason": (sig.scoreReasons || {})[tid] || "",
        "Scan Target": td.scanTarget || "accounts",
        Signal: sig.headline || sig.jobTitle || "", Source: sig.source || "Google News",
        URL: url, "Task Type": sig.taskType || "news",
        Date: (sig.date || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
        Created: nowIso(),
      } });
    }
    for (const tid of (sig.subThresholdTaskIds || [])) {
      const td = defs.find(t => t.id === tid);
      if (!td) continue;
      const fp = `${company.toLowerCase()}|${td.name.toLowerCase()}|${url.toLowerCase()}`;
      if (archSeen.has(fp)) continue;
      archSeen.add(fp);
      archive.push({ fields: {
        Company: company, "Signal Status": "unqualified",
        Score: (sig.subThresholdScores || {})[tid] || 0,
        "Score Reason": (sig.subThresholdReasons || {})[tid] || "",
        Signal: sig.headline || sig.jobTitle || "", "Task Rule": td.name,
        "Task Type": sig.taskType || "news", Source: sig.source || "Google News",
        URL: url, "Scan Target": td.scanTarget || "accounts",
        Date: (sig.date || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
        Created: nowIso(),
      } });
    }
  }
  return { tasks, archive };
}

// ─── Rule defs (mirrors SignalScope.jsx taskDef build) ─────────────────────
const split = s => (s || "").split(",").map(x => x.trim()).filter(Boolean);

async function buildDefs(baseId, taskType) {
  const rules = await atList(baseId, "Task Rules");
  const defs = [];
  for (const r of rules) {
    const f = r.fields || {};
    const tt = f["Task Type"] || "news";
    if (tt !== taskType && tt !== "both") continue;
    const kws = split(f.Keywords), jtk = split(f["Job Title Keywords"]);
    let sp = f["Scoring Prompt"] || "";
    if (!sp) {
      const ak = [...kws, ...jtk].slice(0, 5).join(", ");
      sp = `Rate this signal for "${f.Name || ""}". Score 90-100 for exact matches (${ak}). 70-89 strong. 50-69 partial. Below 50 unrelated.`;
    }
    defs.push({ id: r.id, name: f.Name || "", description: f.Description || "", taskType: tt,
      scanTarget: f["Scan Target"] || "accounts", ease: f.Ease || "Medium", strength: f.Strength || "Medium",
      sources: split(f.Sources), keywords: kws, jobTitleKeywords: jtk, scoringPrompt: sp,
      // Signal Review demote/promote corrections — /api/scan injects this into
      // the scoring prompt so reviewed mistakes aren't repeated.
      reviewerFeedback: f["Reviewer Feedback"] || "" });
  }
  return defs;
}

// ─── The tick: process as much as fits in the budget, save cursor ──────────
async function tick(origin, state, campaignAirtableId) {
  const t0 = Date.now();
  const remaining = () => TICK_BUDGET_MS - (Date.now() - t0);
  const { baseId, threshold } = state;

  const newsDefs = await buildDefs(baseId, "news");
  const jobDefs = await buildDefs(baseId, "job_post");

  // Dedup fingerprints (fresh each tick — cheap, and immune to state bloat)
  const seen = new Set(), archSeen = new Set();
  for (const t of await atList(baseId, "Tasks", { fields: ["Company", "Task Rule", "URL"] })) {
    const f = t.fields || {};
    seen.add(`${(f.Company || "").toLowerCase()}|${(f["Task Rule"] || "").toLowerCase()}|${(f.URL || "").toLowerCase()}`);
  }
  try {
    for (const t of await atList(baseId, "Signal Archive", { fields: ["Company", "Task Rule", "URL"] })) {
      const f = t.fields || {};
      archSeen.add(`${(f.Company || "").toLowerCase()}|${(f["Task Rule"] || "").toLowerCase()}|${(f.URL || "").toLowerCase()}`);
    }
  } catch (_) { /* archive table absent → archiving no-ops */ }

  const scanCall = async (body, timeoutMs) => {
    const r = await fetch(`${origin}/api/scan`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`scan ${r.status}`);
    return r.json();
  };

  const writeOut = async (tasks, archive) => {
    let tw = 0, aw = 0;
    if (tasks.length) tw = (await atCreateBatch(baseId, "Tasks", tasks)).written;
    if (archive.length) { try { aw = (await atCreateBatch(baseId, "Signal Archive", archive)).written; } catch (_) {} }
    return { tw, aw };
  };

  // ── NEWS phase ──
  while (state.phase === "news") {
    if (state.news_idx >= state.accounts.length) { state.phase = "jobs"; break; }
    if (remaining() < MIN_RUNWAY_MS) { await writeState(campaignAirtableId, state); return state; }
    const co = state.accounts[state.news_idx];
    try {
      const d = await scanCall({ mode: "news", company: co, taskDefs: newsDefs, threshold, campaignId: campaignAirtableId },
        Math.min(remaining() - 15_000, 285_000));
      const guards = d?.fetchStats?.funnel?.guards || {};
      if (newsDefs.length > 0 && (guards.aiErrorTasks || 0) >= newsDefs.length) {
        state.ai_outage_streak = (state.ai_outage_streak || 0) + 1;
        if (state.ai_outage_streak >= 3) {
          state.status = "error";
          state.error = `AI outage: 3 consecutive accounts with all scoring calls failed (${guards.aiErrorSample || "no sample"})`;
          await writeState(campaignAirtableId, state);
          return state;
        }
      } else state.ai_outage_streak = 0;
      const { tasks, archive } = bufferSignals(d.news, co.name, newsDefs, threshold, seen, archSeen);
      const { tw, aw } = await writeOut(tasks, archive);
      state.totals.news_tasks += tw; state.totals.news_archived += aw;
      if (state.retry_account === co.name) delete state.retry_account; // retry succeeded
    } catch (e) {
      const msg = String(e.message || e.name || "");
      // Tick-boundary protection: a scan aborted because THIS tick's remaining
      // budget was smaller than the account needed is not the account's fault.
      // Give it ONE retry at the top of the next tick (fresh 240s); a second
      // failure records it and moves on (prevents an always-slow account from
      // wedging the run).
      const isTimeout = /timeout|abort/i.test(msg) || e.name === "TimeoutError" || e.name === "AbortError";
      if (isTimeout && state.retry_account !== co.name) {
        state.retry_account = co.name;
        await writeState(campaignAirtableId, state);
        return state; // do NOT advance the cursor — next tick retries this account
      }
      state.failures.push(`news:${co.name} (${msg.slice(0, 80)})`);
      if (state.retry_account === co.name) delete state.retry_account;
    }
    state.news_idx++;
    await writeState(campaignAirtableId, state);
  }

  // ── JOBS phase ──
  while (state.phase === "jobs") {
    const batches = Math.ceil(state.accounts.length / 5);
    if (state.jobs_idx >= batches) { state.phase = "done"; break; }
    if (remaining() < MIN_RUNWAY_MS) { await writeState(campaignAirtableId, state); return state; }
    const batch = state.accounts.slice(state.jobs_idx * 5, state.jobs_idx * 5 + 5);
    try {
      const d = await scanCall({ mode: "jobs-batch", companies: batch, taskDefs: jobDefs, threshold, campaignId: campaignAirtableId },
        Math.min(remaining() - 15_000, 285_000));
      for (const grp of d.results || []) {
        const { tasks, archive } = bufferSignals(grp.signals, grp.company, jobDefs, threshold, seen, archSeen);
        const { tw, aw } = await writeOut(tasks, archive);
        state.totals.jobs_tasks += tw; state.totals.jobs_archived += aw;
      }
    } catch (e) {
      state.failures.push(`jobs:batch${state.jobs_idx + 1} (${String(e.message).slice(0, 80)})`);
    }
    state.jobs_idx++;
    await writeState(campaignAirtableId, state);
  }

  if (state.phase === "done") {
    state.status = "complete";
    state.completed_at = new Date().toISOString();
  }
  await writeState(campaignAirtableId, state);
  return state;
}

// ─── HTTP handler ──────────────────────────────────────────────────────────
export async function POST(request) {
  const url = new URL(request.url);
  const origin = url.origin;
  let body = {};
  try { body = await request.json(); } catch (_) { /* cron resume has no body */ }

  // Cron driver: ?mode=resume&key=<CRON_SECRET> — tick the first running scan.
  if (url.searchParams.get("mode") === "resume") {
    if (url.searchParams.get("key") !== CRON_SECRET) {
      return NextResponse.json({ error: "bad key" }, { status: 401 });
    }
    let campaignAirtableId = body.campaignAirtableId;
    if (!campaignAirtableId) {
      const camps = await atList(MASTER_BASE_ID, "Campaigns", { fields: [STATUS_FIELD] });
      const running = camps.find(c => {
        try { return JSON.parse(c.fields?.[STATUS_FIELD] || "{}").status === "running"; } catch { return false; }
      });
      if (!running) return NextResponse.json({ ok: true, idle: true });
      campaignAirtableId = running.id;
    }
    const state = await readState(campaignAirtableId);
    if (!state || state.status !== "running") return NextResponse.json({ ok: true, idle: true });
    const out = await tick(origin, state, campaignAirtableId);
    return NextResponse.json({ ok: true, progress: publicProgress(out) });
  }

  const { action, baseId, campaignAirtableId, threshold = 70, force } = body;
  if (!campaignAirtableId) return NextResponse.json({ error: "campaignAirtableId required" }, { status: 400 });

  if (action === "get_progress") {
    return NextResponse.json({ ok: true, progress: publicProgress(await readState(campaignAirtableId)) });
  }

  if (action === "stop") {
    const state = await readState(campaignAirtableId);
    if (state) { state.status = "stopped"; await writeState(campaignAirtableId, state); }
    return NextResponse.json({ ok: true, progress: publicProgress(state) });
  }

  if (action === "resume") {
    const state = await readState(campaignAirtableId);
    if (!state) return NextResponse.json({ error: "no scan state — start first" }, { status: 400 });
    if (state.status !== "running") return NextResponse.json({ ok: true, progress: publicProgress(state) });
    const out = await tick(origin, state, campaignAirtableId);
    return NextResponse.json({ ok: true, progress: publicProgress(out) });
  }

  if (action === "start") {
    if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
    const prior = await readState(campaignAirtableId);
    if (!force && prior?.status === "running" && prior.updated_at) {
      const ageMs = Date.now() - new Date(prior.updated_at).getTime();
      if (!isNaN(ageMs) && ageMs < 60_000) {
        return NextResponse.json({ error: "scan already running — pass force:true to restart", progress: publicProgress(prior) }, { status: 409 });
      }
    }
    const accountRecs = await atList(baseId, "Accounts", { fields: ["Name", "Domain"] });
    const accounts = accountRecs
      .map(a => ({ name: a.fields?.Name || "", domain: a.fields?.Domain || "" }))
      .filter(a => a.name);
    const state = {
      status: "running", phase: "news", baseId, threshold,
      started_at: new Date().toISOString(),
      accounts, accounts_total: accounts.length,
      news_idx: 0, jobs_idx: 0, ai_outage_streak: 0,
      totals: { news_tasks: 0, news_archived: 0, jobs_tasks: 0, jobs_archived: 0 },
      failures: [],
    };
    await writeState(campaignAirtableId, state);
    const out = await tick(origin, state, campaignAirtableId);
    return NextResponse.json({ ok: true, progress: publicProgress(out) });
  }

  return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
}
