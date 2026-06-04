import { NextResponse } from "next/server";
import OpenAI from "openai";
import { trackOpenAIUsage } from "@/lib/ai-usage";

// ═══════════════════════════════════════════════════════════════════════════
// COMPANY (ACCOUNT-LEVEL) LINKEDIN POSTS — fetch + qualify
// ═══════════════════════════════════════════════════════════════════════════
// The lead-level LinkedIn scan (/api/linkedin-posts) watches individual people.
// This watches the COMPANY PAGE — the account's own LinkedIn posts — so an
// account-level signal (product launch, exec announcement, campaign) becomes a
// task too (Kunal, 2026-06-04: the Qualcomm event should have been a task).
//
// Isolated on purpose: the proven news/jobs scan in /api/scan is untouched.
// Returns the SAME signal shape /api/scan returns, so the client orchestrator
// (runScan → bufferSignals) feeds qualified → Tasks and the retain band →
// Signal Archive with zero new write logic.
//
// POST { companies:[{name, linkedinId?, linkedinSlug?, domain?}], taskDefs, threshold, campaignId }
//   → { results:[{ company, signals:[ <signal with matchedTaskIds + subThreshold*> ] }] }
//
// ⚠ ENDPOINT NOTE: the fresh-linkedin-scraper-api company endpoints below are
// inferred from its documented user endpoints (/api/v1/user/profile, /user/posts).
// Confirm against the live plan with one test run; override via env without a
// redeploy: COMPANY_PROFILE_PATH, COMPANY_POSTS_PATH. The parser is shape-
// tolerant, so minor response differences are handled; a wrong PATH returns 404
// and is surfaced in fetchStats.error (no silent empty result).
// ═══════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = process.env.LINKEDIN_SCRAPER_HOST || "fresh-linkedin-scraper-api.p.rapidapi.com";
// Candidate company endpoints. Env override pins an exact one (fastest); otherwise
// we probe these in order. PARAM names are tried per path. Discovered via the QA
// diagnostic below — once the working combo is known, set the env vars to pin it.
const COMPANY_PROFILE_PATHS = process.env.COMPANY_PROFILE_PATH ? [process.env.COMPANY_PROFILE_PATH] : ["/api/v1/company/profile", "/api/v1/company/details", "/api/v1/company"];
const COMPANY_POSTS_PATHS = process.env.COMPANY_POSTS_PATH ? [process.env.COMPANY_POSTS_PATH] : ["/api/v1/company/posts", "/api/v1/company/updates"];
// "company" / "company_id" first — the fresh-linkedin-scraper-api company/profile
// endpoint Zod-validates for exactly these (QA 2026-06-04: "Either company or
// company_id must be provided").
const COMPANY_PARAMS = ["company", "company_id", "username", "public_id", "slug", "universal_name"];
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS) || 7;
const SIGNAL_RETAIN_FLOOR = (() => { const v = parseInt(process.env.SIGNAL_RETAIN_FLOOR); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 40; })();
const MAX_POSTS_PER_COMPANY = parseInt(process.env.MAX_COMPANY_POSTS) || 10;

let _openai;
const getOpenAI = () => (_openai = _openai || new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

// ─── Throttled RapidAPI GET (same pacing discipline as /api/linkedin-posts) ──
let rapidLastCallMs = 0, rapidMinIntervalMs = 1200;
async function rapidCall(path, params, { retries = 3, timeoutMs = 45000 } = {}) {
  if (!RAPIDAPI_KEY) return { ok: false, status: 0, error: "RAPIDAPI_KEY not set in Vercel env" };
  const url = `https://${RAPIDAPI_HOST}${path}?${new URLSearchParams(params)}`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const sinceLast = Date.now() - rapidLastCallMs;
    if (sinceLast < rapidMinIntervalMs) await new Promise(r => setTimeout(r, rapidMinIntervalMs - sinceLast));
    rapidLastCallMs = Date.now();
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": RAPIDAPI_HOST }, signal: ctrl.signal });
      clearTimeout(t);
      const text = await r.text();
      if (!r.ok) {
        if (r.status === 429 && attempt < retries) { rapidMinIntervalMs = Math.min(rapidMinIntervalMs * 1.5, 5000); await new Promise(res => setTimeout(res, 3000 * Math.pow(2, attempt))); continue; }
        if (r.status === 503 && attempt < retries) { await new Promise(res => setTimeout(res, 1500 * (attempt + 1))); continue; }
        return { ok: false, status: r.status, error: text.slice(0, 300) };
      }
      try { return { ok: true, data: JSON.parse(text) }; } catch { return { ok: false, status: 200, error: "Invalid JSON: " + text.slice(0, 200) }; }
    } catch (e) { clearTimeout(t); if (attempt < retries) { await new Promise(res => setTimeout(res, 1000)); continue; } return { ok: false, status: 0, error: e.message }; }
  }
  return { ok: false, status: 0, error: "Exhausted retries" };
}

function companySlug(c) {
  const raw = c.linkedinSlug || "";
  if (raw) return raw.toLowerCase();
  const li = (c.linkedinUrl || c.LinkedIn || "").toString();
  const m = li.match(/linkedin\.com\/company\/([^\/?\s&#]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function extractUrn(data) {
  const d = data?.data || data || {};
  return d.urn || d.company_urn || d.entity_urn || d.companyUrn || d.id || d.company_id || d.companyId || d.universal_name || d.universalName || d.public_id || "";
}
// Resolve a company's URN/id. Probes candidate paths × params until one 200s with
// a URN. On total failure returns a rich diagnostic (which path 200'd + its keys +
// a value sample) so a single QA run reveals the exact shape to pin via env.
async function resolveCompanyUrn(c) {
  if (c.linkedinId) return { urn: String(c.linkedinId) };
  const slug = companySlug(c);
  if (!slug) return { error: "no LinkedIn company slug/id" };
  let diag = "all company-profile candidates failed";
  for (const path of COMPANY_PROFILE_PATHS) {
    for (const p of COMPANY_PARAMS) {
      const r = await rapidCall(path, { [p]: slug }, { retries: 1, timeoutMs: 30000 });
      if (!r.ok) { if (r.status === 404) break; /* path missing → next path */ diag = `${path}?${p}= → ${r.status} ${String(r.error).slice(0, 60)}`; continue; }
      // A 200 with success:false is the API rejecting THIS param — keep probing
      // other params (do NOT bail; that was the QA-1 bug).
      if (r.data && r.data.success === false) { diag = `${path}?${p}= → success:false ${JSON.stringify(r.data.error || r.data.message || "").slice(0, 80)}`; continue; }
      const urn = extractUrn(r.data);
      if (urn) return { urn: String(urn), slug, via: `${path}?${p}=` };
      // Real 200 payload but URN not in the keys we know → capture shape so we can pin it.
      const d = r.data?.data || r.data || {};
      diag = `200 at ${path}?${p}= but no urn. keys:[${Object.keys(d).slice(0, 16).join(",")}] sample:${JSON.stringify(d).slice(0, 220)}`;
    }
  }
  return { error: diag, slug };
}

function parsePosts(data) {
  // Tolerate the common envelopes: {data:{posts:[]}} | {data:[]} | {posts:[]} | []
  const arr = data?.data?.posts || data?.posts || (Array.isArray(data?.data) ? data.data : null) || (Array.isArray(data) ? data : []);
  return Array.isArray(arr) ? arr : [];
}
function postText(p) {
  return (p.text || p.commentary || p.content || p.post_text || p.description || "").toString().trim();
}
function postUrl(p) {
  return (p.url || p.post_url || p.share_url || p.permalink || "").toString();
}
function postDateMs(p) {
  const raw = p.posted_at || p.created_at || p.date || p.time || p.published_at;
  if (typeof raw === "number") return raw > 1e12 ? raw : raw * 1000;
  const d = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(d) ? d : null;
}

async function fetchCompanyPosts(urn, slug) {
  // Try the param combos the company/profile endpoint taught us (company_id /
  // company), by urn and by slug. Skip 200-with-success:false (wrong param).
  const combos = [
    { company_id: urn }, { company: slug }, { urn }, { company: urn }, { company_id: slug }, { id: urn },
  ];
  let r = null, lastErr = "no posts path/param worked";
  for (const path of COMPANY_POSTS_PATHS) {
    for (const params of combos) {
      const rr = await rapidCall(path, { ...params, page: "1" }, { retries: 1, timeoutMs: 30000 });
      if (rr.ok && !(rr.data && rr.data.success === false)) { r = rr; break; }
      lastErr = `${path}?${Object.keys(params)[0]}= → ${rr.ok ? "success:false " + JSON.stringify(rr.data?.error || rr.data?.message || "").slice(0, 60) : rr.status + " " + String(rr.error).slice(0, 40)}`;
      if (rr.status === 404) break; // path missing → next path
    }
    if (r) break;
  }
  if (!r) return { ok: false, error: `company posts: ${lastErr}`, posts: [] };
  const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
  const posts = parsePosts(r.data)
    .map(p => ({ text: postText(p), url: postUrl(p), ms: postDateMs(p) }))
    .filter(p => p.text.length > 20)
    .filter(p => p.ms == null || p.ms >= cutoff) // keep undatable (assumed recent) + recent
    .slice(0, MAX_POSTS_PER_COMPANY);
  return { ok: true, posts };
}

// Score a company's posts against the company-post rules in ONE call.
// Returns the same fields bufferSignals reads, including the retain band.
async function scorePosts(companyName, posts, taskDefs, threshold, campaignId) {
  const base = posts.map(p => ({
    headline: p.text.slice(0, 140), description: p.text.slice(0, 600), articleContent: p.text.slice(0, 1200),
    source: "LinkedIn (Company)", url: p.url, taskType: "company_post",
    date: p.ms ? new Date(p.ms).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10),
    matchedTaskIds: [], relevanceScores: {}, scoreReasons: {}, subThresholdTaskIds: [], subThresholdScores: {}, subThresholdReasons: {},
  }));
  if (!base.length || !taskDefs.length) return base;

  const ruleBlock = taskDefs.map((t, i) => `RULE ${i} — "${t.name}": ${(t.scoringPrompt || t.description || t.name).slice(0, 600)}`).join("\n");
  const postBlock = base.map((b, i) => `[${i}] ${b.articleContent}`).join("\n\n");
  const sys = `You score a company's LinkedIn posts against engagement/signal rules for "${companyName}". For each post, pick the SINGLE best-matching rule and score 0-100 how strongly it matches that rule (how worthy it is of being an account-level signal/engagement task). Be honest — most posts are routine and score low. Output strict JSON: {"matches":[{"idx":<post index>,"rule":<rule index>,"score":<0-100>,"reason":"<=140 chars"}]}. One entry per post you score.`;
  try {
    const c = await getOpenAI().chat.completions.create({
      model: "gpt-5.4-mini", temperature: 0, max_completion_tokens: 3000, response_format: { type: "json_object" },
      messages: [{ role: "system", content: sys }, { role: "user", content: `RULES:\n${ruleBlock}\n\nPOSTS:\n${postBlock}` }],
    });
    trackOpenAIUsage({ campaignId, completion: c, action: "scan_company_posts" });
    let parsed = {}; try { parsed = JSON.parse(c.choices[0]?.message?.content || "{}"); } catch { parsed = {}; }
    for (const m of (parsed.matches || [])) {
      const b = base[m.idx]; const rule = taskDefs[m.rule];
      if (!b || !rule) continue;
      const score = Math.max(0, Math.min(100, Math.round(Number(m.score) || 0)));
      const reason = String(m.reason || "").slice(0, 200);
      if (score >= threshold) { b.matchedTaskIds.push(rule.id); b.relevanceScores[rule.id] = score; b.scoreReasons[rule.id] = reason; }
      else if (score >= SIGNAL_RETAIN_FLOOR) { b.subThresholdTaskIds.push(rule.id); b.subThresholdScores[rule.id] = score; b.subThresholdReasons[rule.id] = reason; }
    }
  } catch (e) { console.error("[company-posts] scoring failed:", e.message); }
  return base;
}

export async function POST(request) {
  try {
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });
    const body = await request.json();
    const { companies, taskDefs, campaignId = null } = body;
    const rawT = body.threshold; const t = rawT == null ? 70 : Number(rawT);
    const threshold = Number.isFinite(t) ? Math.max(0, Math.min(100, Math.round(t))) : 70;
    if (!companies?.length) return NextResponse.json({ error: "companies[] required" }, { status: 400 });
    if (!taskDefs?.length) return NextResponse.json({ error: "taskDefs[] required" }, { status: 400 });
    if (!RAPIDAPI_KEY) return NextResponse.json({ error: "RAPIDAPI_KEY not set (Fresh LinkedIn Scraper API)" }, { status: 400 });

    const results = [];
    for (const c of companies) {
      try {
        const ru = await resolveCompanyUrn(c);
        if (ru.error) { results.push({ company: c.name, signals: [], error: ru.error }); continue; }
        const fp = await fetchCompanyPosts(ru.urn, ru.slug);
        if (!fp.ok) { results.push({ company: c.name, signals: [], error: fp.error }); continue; }
        if (!fp.posts.length) { results.push({ company: c.name, signals: [] }); continue; }
        const scored = await scorePosts(c.name, fp.posts, taskDefs, threshold, campaignId);
        results.push({ company: c.name, signals: scored });
      } catch (e) { results.push({ company: c.name, signals: [], error: e.message }); }
    }
    return NextResponse.json({ results, threshold, mode: "company-posts" });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
