import { NextResponse } from "next/server";
import OpenAI from "openai";

// 5-minute Vercel function timeout. News scan per company:
//   - 1 RSS fetch (~1-2s)
//   - Up to 50 article fetches in parallel (~6s)
//   - N OpenAI classify calls (now parallelized, ~3-5s total instead of N*3s)
// Jobs-batch: ~30-60s for Apify per batch of 5 companies.
// Default Fluid Compute timeout is already 300s on Hobby+, but set explicitly for safety
// in case Fluid Compute is disabled or migration happens.
export const maxDuration = 300;

let _openai;
function getOpenAI() { if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }

// ─── Apify Token Fallback ─────────────────────────────────────────
// Supports 3 Apify accounts. If one is exhausted, falls back to the next.
// Env vars: APIFY_TOKEN, APIFY_TOKEN_2, APIFY_TOKEN_3

function getApifyTokens() {
  const tokens = [];
  if (process.env.APIFY_TOKEN) tokens.push({ key: "APIFY_TOKEN", token: process.env.APIFY_TOKEN });
  if (process.env.APIFY_TOKEN_2) tokens.push({ key: "APIFY_TOKEN_2", token: process.env.APIFY_TOKEN_2 });
  if (process.env.APIFY_TOKEN_3) tokens.push({ key: "APIFY_TOKEN_3", token: process.env.APIFY_TOKEN_3 });
  return tokens;
}

function isCreditExhausted(status, body) {
  // Apify returns various signals when credits run out
  if (status === 402 || status === 403) return true;
  if (status === 429) return true;
  const text = (body || "").toLowerCase();
  return text.includes("maximum usage") || text.includes("billing") || text.includes("exceeded") || text.includes("insufficient") || text.includes("platform-feature-disabled") || text.includes("hard limit");
}

/**
 * Makes an Apify API call with automatic token fallback.
 * Tries each token in order. If one is exhausted, tries the next.
 * Returns { data, usedToken } or { error }.
 */
async function apifyCallWithFallback(actorId, input, timeoutMs = 480000) {
  const tokens = getApifyTokens();
  if (tokens.length === 0) {
    console.log("  [APIFY] No tokens configured");
    return { error: "No APIFY_TOKEN configured", data: null };
  }

  const apiActorId = actorId.replace("/", "~");

  for (let t = 0; t < tokens.length; t++) {
    const { key, token } = tokens[t];
    console.log(`  [APIFY] Trying ${key} (${t + 1}/${tokens.length})...`);

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

        const res = await fetch(
          `https://api.apify.com/v2/acts/${apiActorId}/run-sync-get-dataset-items?token=${token}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(input),
            signal: ctrl.signal,
          }
        );
        clearTimeout(timeout);

        // Read body once
        if (!res.ok) {
          const errBody = await res.text();
          
          // Credit exhausted — try next token
          if (isCreditExhausted(res.status, errBody)) {
            console.error(`  [APIFY] ${key} exhausted (HTTP ${res.status}). ${t < tokens.length - 1 ? "Trying next token..." : "No more tokens."}`);
            break; // break retry loop, go to next token
          }

          // 502/503 gateway timeout — retry same token
          if (res.status === 502 || res.status === 503) {
            console.error(`  [APIFY] HTTP ${res.status} — ${attempt < 2 ? "retrying..." : "moving on"}`);
            if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
            break; // try next token
          }

          // Other error
          console.error(`  [APIFY] HTTP ${res.status}: ${errBody.slice(0, 200)}`);
          return { error: `HTTP ${res.status}`, data: null };
        }

        // Success
        const data = await res.json();
        console.log(`  [APIFY] Success via ${key}`);
        return { data, error: null, usedToken: key };
      } catch (e) {
        if (e.name === "AbortError") {
          console.error(`  [APIFY] Timed out (${Math.round(timeoutMs / 1000)}s) — ${attempt < 2 ? "retrying..." : "moving on"}`);
          if (attempt < 2) { await new Promise(r => setTimeout(r, 2000)); continue; }
          break; // try next token
        }
        console.error(`  [APIFY] Error: ${e.message}`);
        return { error: e.message, data: null };
      }
    }
  }

  console.error("  [APIFY] All tokens exhausted or failed");
  return { error: "All Apify tokens exhausted", data: null };
}

// ─── Company Name Cleaner ─────────────────────────────────────────
// Strip trailing parenthetical notes/clarifications. These are common in account
// lists ("American Standard (finishes)", "Ashley Furniture (furniture retail/finance)")
// and break Google News search (parens are boolean operators) and harm Apify name
// matching against real LinkedIn company names.
function cleanCompanyName(name) {
  if (!name) return "";
  return name
    .replace(/\s*\([^)]*\)\s*$/, "")   // trailing (...)
    .replace(/\s*\[[^\]]*\]\s*$/, "")  // trailing [...]
    .trim();
}

// ─── RSS Parser (for news only) ──────────────────────────────────

function parseRSSItems(xml, defaultSource) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const x = m[1];
    const title = tag(x, "title");
    const link = tag(x, "link") || tagAttr(x, "link", "href");
    const pub = tag(x, "pubDate") || tag(x, "published");
    const desc = tag(x, "description") || tag(x, "summary");
    const src = tag(x, "source") || srcFrom(title) || defaultSource || "News";
    if (title?.length > 10) items.push({ headline: cl(title), description: cl(desc || "").slice(0, 300), url: cl(link || ""), source: cl(src), date: pub ? sd(pub) : new Date().toISOString() });
  }
  return items;
}
function tag(x, t) { const c = x.match(new RegExp(`<${t}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${t}>`, "i")); if (c) return c[1].trim(); const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`, "i")); return m ? m[1].trim() : ""; }
function tagAttr(x, t, a) { const m = x.match(new RegExp(`<${t}[^>]*${a}="([^"]*)"`, "i")); return m ? m[1] : ""; }
function srcFrom(t) { const m = t?.match(/\s[-–—]\s([^-–—]+)$/); return m ? m[1].trim() : ""; }
function cl(t) { return (t || "").replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim(); }
function sd(s) { try { const d = new Date(s); return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString(); } catch { return new Date().toISOString(); } }

async function fetchRSS(url, label, src) {
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 10000);
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "application/rss+xml, application/xml, text/xml, */*" }, signal: c.signal });
    clearTimeout(t);
    if (!r.ok) { console.error(`${label}: HTTP ${r.status}`); return []; }
    const xml = await r.text();
    if (!xml.includes("<item>")) { console.error(`${label}: no items`); return []; }
    const items = parseRSSItems(xml, src);
    console.log(`${label}: ${items.length} items`);
    return items;
  } catch (e) { console.error(`${label}: ${e.message}`); return []; }
}

// ─── Article Content Fetcher ──────────────────────────────────────

async function fetchArticle(url) {
  if (!url || url.length < 10) return "";
  try {
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 6000);
    const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", Accept: "text/html,*/*" }, signal: c.signal, redirect: "follow" });
    clearTimeout(t);
    if (!r.ok) return "";
    const html = await r.text();
    const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    let text = art ? art[1] : (html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || []).join(" ");
    return text.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 800);
  } catch { return ""; }
}

// ─── Date Filter ──────────────────────────────────────────────────

const MAX_AGE_DAYS = 7;
// Jobs are kept longer because non-tech companies post less frequently. A "VP Marketing
// role open" 3 weeks ago is still actionable. News at 7 days makes sense (old news isn't
// actionable), but jobs we keep for 30 days. Override via env if needed.
const MAX_JOB_AGE_DAYS = parseInt(process.env.MAX_JOB_AGE_DAYS) || 30;

function filterRecent(items) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return items.filter(item => {
    if (!item.date) return true; // keep items with no date (let AI handle)
    const d = new Date(item.date).getTime();
    return !isNaN(d) && d >= cutoff;
  });
}

function filterRecentJobs(items) {
  const cutoff = Date.now() - MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
  return items.filter(item => {
    if (!item.date) return true;
    const d = new Date(item.date).getTime();
    return !isNaN(d) && d >= cutoff;
  });
}

// ═══════════════════════════════════════════════════════════════════
// MODE: NEWS — Google News RSS → article fetch → classify
// ═══════════════════════════════════════════════════════════════════

async function scanNews(company, taskDefs, threshold = 50) {
  const cleanName = cleanCompanyName(company.name);
  if (!cleanName) {
    console.log(`  [NEWS] Skipping ${company.name} — empty name after cleaning`);
    return [];
  }
  console.log(`  [NEWS] Fetching for ${cleanName}${cleanName !== company.name ? ` (was: "${company.name}")` : ""}...`);
  const q = encodeURIComponent(`"${cleanName}"`);
  const items = await fetchRSS(`https://news.google.com/rss/search?q=${q}+when:7d&hl=en&gl=US&ceid=US:en`, `Google News [${cleanName}]`, "Google News");

  const recent = filterRecent(items);
  console.log(`  [NEWS] ${items.length} total → ${recent.length} within ${MAX_AGE_DAYS} days`);

  if (recent.length === 0) {
    console.log(`  [NEWS] No recent articles found — skipping (real signals only)`);
    return [];
  }

  // Fetch full article body for the first 50 items in parallel — used in classify
  // for higher accuracy (headlines alone are misleading). 6s timeout per fetch,
  // wall clock max ~6s.
  const enriched = await Promise.all(recent.slice(0, 50).map(async n => ({
    ...n, taskType: "news", articleContent: await fetchArticle(n.url),
  })));
  return classify(enriched, taskDefs, cleanName, "news", threshold);
}

// ═══════════════════════════════════════════════════════════════════
// MODE: JOBS-BATCH — Apify LinkedIn Scraper with f_C company filter
//
// Accepts up to 10 companies at once → builds all f_C URLs → ONE Apify call
// Returns results grouped by company for the frontend to process
// ═══════════════════════════════════════════════════════════════════

async function scanJobsBatch(companies, taskDefs, threshold = 50) {
  const tokens = getApifyTokens();
  if (tokens.length === 0) {
    console.log("  [JOBS-BATCH] No Apify tokens configured — skipping");
    return companies.map(c => ({ company: c.name, signals: [] }));
  }

  // Split companies into those with IDs (can combine) and those without (need individual URLs)
  const withIds = companies.filter(c => c.linkedinCompanyId);
  const withoutIds = companies.filter(c => !c.linkedinCompanyId);

  // Build URLs — combine ALL f_C IDs into ONE LinkedIn URL
  const urls = [];
  const combinedIdUrls = []; // track these specifically for retry without time filter

  // f_TPR window (in seconds): r604800 = 7 days, r2592000 = 30 days, r7776000 = 90 days
  // Loosened default to 30 days because non-tech companies (consumer, retail, hospitality)
  // post jobs less frequently than tech companies. r604800 (7 days) was returning 0 for
  // companies that genuinely had postings just slightly older than a week.
  // Override via APIFY_JOBS_TPR env var if you need a different window.
  const TPR = process.env.APIFY_JOBS_TPR || "r2592000";

  if (withIds.length > 0) {
    // LinkedIn's URL filter syntax uses COMMA-SEPARATED values for repeated dimensions:
    //   f_C=123,456,789  ✓  (filters jobs from any of those companies)
    //   f_C=123&f_C=456  ✗  (LinkedIn keeps only the last value)
    // Confirmed via LinkedIn's own scraped jobSearchUrl format and the Kondo URL-hacking guide.
    const ids = withIds.map(c => c.linkedinCompanyId).join(",");
    const combinedUrl = `https://www.linkedin.com/jobs/search/?f_C=${ids}&f_TPR=${TPR}&sortBy=DD`;
    urls.push(combinedUrl);
    combinedIdUrls.push({ url: combinedUrl, companies: withIds });
    console.log(`  [JOBS-BATCH] Combined ${withIds.length} company IDs into ONE URL (comma-separated, ${TPR})`);
    withIds.forEach(c => console.log(`    f_C=${c.linkedinCompanyId} (${c.name})`));
    console.log(`  [JOBS-BATCH] URL: ${combinedUrl}`);
  }

  // Each keyword fallback company gets its own URL (can't combine these)
  for (const c of withoutIds) {
    const cleanName = cleanCompanyName(c.name);
    if (!cleanName) continue;
    const topKw = taskDefs.flatMap(t => t.jobTitleKeywords || t.keywords || [])[0] || "marketing";
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" ${topKw}`)}&sortBy=DD`;
    urls.push(url);
    console.log(`  [JOBS-BATCH] ${cleanName}: keyword fallback URL: ${url}`);
  }

  console.log(`  [JOBS-BATCH] Total URLs: ${urls.length} (was ${companies.length} before combining)`);

  const actorId = process.env.APIFY_ACTOR_ID || "curious_coder/linkedin-jobs-scraper";
  const baseInput = { count: 100, scrapeCompany: false, includeJobDescription: true };

  // Use fallback helper — tries all 3 tokens automatically
  let { data, error } = await apifyCallWithFallback(actorId, { urls, ...baseInput }, 480000);
  let allJobs = Array.isArray(data) ? data : [];

  if (error) console.error(`  [JOBS-BATCH] ${error}`);
  console.log(`  [JOBS-BATCH] Got ${allJobs.length} total job listings`);

  // ── Retry 1: Drop f_TPR entirely (no time filter) if first attempt returned 0 ──
  // Reason: even 30-day windows fail for some companies. Without f_TPR, LinkedIn
  // returns ALL jobs ever posted by the company, sorted by date — newest first via
  // sortBy=DD. We then filter by date in JS using filterRecent().
  if (allJobs.length === 0 && combinedIdUrls.length > 0 && !error) {
    console.log(`  [JOBS-BATCH] 0 results — retrying without time filter (f_TPR)...`);
    const retryUrls = [];
    if (withIds.length > 0) {
      const ids = withIds.map(c => c.linkedinCompanyId).join(",");
      const noTPRUrl = `https://www.linkedin.com/jobs/search/?f_C=${ids}&sortBy=DD`;
      retryUrls.push(noTPRUrl);
      console.log(`  [JOBS-BATCH] Retry URL: ${noTPRUrl}`);
    }
    for (const c of withoutIds) {
      const cleanName = cleanCompanyName(c.name);
      if (!cleanName) continue;
      const topKw = taskDefs.flatMap(t => t.jobTitleKeywords || t.keywords || [])[0] || "marketing";
      retryUrls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" ${topKw}`)}&sortBy=DD`);
    }
    const retry1 = await apifyCallWithFallback(actorId, { urls: retryUrls, ...baseInput }, 480000);
    allJobs = Array.isArray(retry1.data) ? retry1.data : [];
    console.log(`  [JOBS-BATCH] After retry-1 (no time filter): ${allJobs.length} jobs`);
  }

  // ── Retry 2: Try each company ID individually (rules out comma-separated f_C bug) ──
  if (allJobs.length === 0 && withIds.length > 1 && !error) {
    console.log(`  [JOBS-BATCH] Still 0 — retrying with INDIVIDUAL URLs per company (rules out comma-syntax issue)...`);
    const indivUrls = withIds.map(c => `https://www.linkedin.com/jobs/search/?f_C=${c.linkedinCompanyId}&sortBy=DD`);
    for (const c of withoutIds) {
      const cleanName = cleanCompanyName(c.name);
      if (!cleanName) continue;
      const topKw = taskDefs.flatMap(t => t.jobTitleKeywords || t.keywords || [])[0] || "marketing";
      indivUrls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" ${topKw}`)}&sortBy=DD`);
    }
    indivUrls.forEach(u => console.log(`  [JOBS-BATCH] Indiv URL: ${u}`));
    const retry2 = await apifyCallWithFallback(actorId, { urls: indivUrls, ...baseInput }, 480000);
    allJobs = Array.isArray(retry2.data) ? retry2.data : [];
    console.log(`  [JOBS-BATCH] After retry-2 (individual URLs): ${allJobs.length} jobs`);
  }

  if (allJobs.length === 0) {
    console.log(`  [JOBS-BATCH] FINAL: 0 jobs after all retries. Possible causes:`);
    console.log(`    1. Companies have no recent postings`);
    console.log(`    2. LinkedIn IDs are stale/wrong (verify by pasting one URL above into a browser)`);
    console.log(`    3. Apify actor blocked by LinkedIn (try rerunning later)`);
    return companies.map(c => ({ company: c.name, signals: [] }));
  }

  // Group jobs by company — match using companyName from Apify results
  const results = [];
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    const hasId = !!c.linkedinCompanyId;
    // Use cleaned name for matching against Apify's companyName field — Apify returns
    // LinkedIn's official name like "American Standard", not internal notes.
    const cleanName = cleanCompanyName(c.name);
    const companyLower = cleanName.toLowerCase().trim();
    // Domain base: strip protocol/www/path, then take first segment.
    // Handles all TLDs (.com, .in, .io, .tech) by ignoring everything after first dot.
    // Skip short bases (≤2 chars) — they over-match in jobCoName.includes() (e.g., "ai" matches "Air France").
    const cleanedDomain = (c.domain || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
    const rawBase = cleanedDomain.split(".")[0].toLowerCase();
    const domainBase = rawBase.length >= 3 ? rawBase : "";
    const companySlug = (c.linkedinSlug || "").toLowerCase();

    // Match jobs to this company
    const companyJobs = !companyLower ? [] : allJobs.filter(job => {
      const jobCoName = (job.companyName || "").toLowerCase().trim();
      const jobLinkedinUrl = (job.companyLinkedinUrl || job.companyUrl || "").toLowerCase();
      const jobSlug = jobLinkedinUrl.match(/linkedin\.com\/company\/([^\/?\s]+)/)?.[1] || "";
      // Skip jobs with empty or trivially short company names — would false-match.
      // Real LinkedIn companies always have names of 3+ chars.
      if (!jobCoName || jobCoName.length < 3) return false;

      if (hasId) {
        // When we used f_C, match by slug or name
        return jobSlug === companySlug || jobCoName.includes(companyLower) || companyLower.includes(jobCoName) ||
          (domainBase && jobCoName.includes(domainBase)) ||
          (companySlug && jobCoName.replace(/[^a-z0-9]/g, "").includes(companySlug.replace(/[^a-z0-9]/g, "")));
      } else {
        // Keyword fallback — strict name matching
        return jobCoName.includes(companyLower) || companyLower.includes(jobCoName) ||
          (domainBase && jobCoName.includes(domainBase));
      }
    });

    // Convert to signals
    const signals = companyJobs.slice(0, 25).map(job => ({
      headline: `${job.title || "Open Role"} — ${job.companyName || c.name}`,
      description: cl(job.descriptionText || job.descriptionHtml || "").slice(0, 500),
      source: "LinkedIn",
      url: job.link || "",
      date: job.postedAt ? sd(job.postedAt) : new Date().toISOString(),
      taskType: "job_post",
      jobTitle: job.title || "",
      jobLocation: job.location || "",
      jobCompany: job.companyName || c.name,
      jobSalary: Array.isArray(job.salaryInfo) ? job.salaryInfo.join(" - ") : (job.salaryInfo || ""),
      articleContent: cl(job.descriptionText || job.descriptionHtml || "").slice(0, 800),
    })).filter(j => j.jobTitle.length > 2);

    // Always apply 30-day filter post-fetch. The URL's f_TPR is best-effort (may have
    // been dropped in retry attempts). filterRecentJobs is the authoritative cutoff.
    const recent = filterRecentJobs(signals);

    console.log(`  [JOBS-BATCH] ${c.name}: ${companyJobs.length} matched → ${recent.length} within ${MAX_JOB_AGE_DAYS} days`);

    if (recent.length > 0) {
      const classified = await classify(recent, taskDefs, c.name, "jobs", threshold);
      results.push({ company: c.name, signals: classified });
    } else {
      results.push({ company: c.name, signals: [] });
    }
  }

  return results;
}

// ─── Shared: OpenAI Classification ───────────────────────────────
//
// THE USER'S SCORING PROMPT IS THE SINGLE SOURCE OF TRUTH FOR HOW SIGNALS ARE SCORED.
//
// We do NOT inject conflicting hardcoded "rules" into the system prompt — those would
// fight the user's custom instructions. The system prompt only explains FORMAT (output
// shape, score range, what data is available). The user's prompt explains JUDGEMENT
// (what to score 90, what to reject, what counts, what doesn't).
//
// Why this matters: the user can write a prompt like "score 95 if a senior marketer
// just left, score below 30 if it's any other role." That prompt is precise. The OLD
// system prompt added generic rules like "executive scheduled to speak = 60-69" which
// could conflict and confuse the model. Now: user's prompt wins.
//
// Output contract:
//   { matches: [{ idx: number, score: number, reason: string }] }
//
// - idx is the index of the signal in the input list (0-based)
// - score is 0-100 integer
// - reason is a 1-sentence explanation (max ~140 chars). Useful for debugging which
//   signals scored what and why.
// - Only signals scoring >= threshold are returned (saves output tokens)
//
// We use response_format: { type: "json_object" } for guaranteed valid JSON.
// We pre-filter obviously irrelevant signals (no keyword presence in headline/description)
// to reduce token usage and let AI focus on real candidates.
// ═══════════════════════════════════════════════════════════════════

// Keyword pre-filter: only send signals to AI that have at least one task-keyword
// in the headline or description. For news, an article that doesn't mention any of
// the task's keywords is almost certainly noise. For jobs, the f_C filter already
// scoped to right companies, but the JOB TITLE still needs to match the task's role.
//
// IMPORTANT: only used when the task has a non-empty keyword list. If the user has
// NO keywords (relying purely on the prompt), we send everything to AI.
function prefilterSignals(signals, task, mode) {
  const kws = mode === "jobs"
    ? [...(task.jobTitleKeywords || []), ...(task.keywords || [])]
    : (task.keywords || []);
  const cleanKws = kws.filter(k => k && k.length >= 2).map(k => k.toLowerCase());
  if (cleanKws.length === 0) return signals.map((_, i) => i); // no keywords = send all
  const matchingIndices = [];
  signals.forEach((sig, i) => {
    const haystack = `${sig.headline || ""} ${sig.description || ""} ${sig.jobTitle || ""}`.toLowerCase();
    if (cleanKws.some(kw => haystack.includes(kw))) {
      matchingIndices.push(i);
    }
  });
  return matchingIndices;
}

// Build the per-signal block sent to OpenAI. For news, includes article content if
// available (was being fetched but ignored before — wasted ~6s per company).
function formatSignalForAI(sig, idx, mode) {
  const lines = [`[${idx}] ${sig.headline || "(no headline)"}`];
  if (mode === "jobs") {
    if (sig.jobTitle) lines.push(`  Title: ${sig.jobTitle}`);
    if (sig.jobLocation) lines.push(`  Location: ${sig.jobLocation}`);
    if (sig.jobCompany) lines.push(`  Company: ${sig.jobCompany}`);
    if (sig.description) lines.push(`  Description: ${sig.description.slice(0, 600)}`);
  } else {
    if (sig.source) lines.push(`  Source: ${sig.source}`);
    if (sig.date) lines.push(`  Date: ${sig.date.slice(0, 10)}`);
    if (sig.description) lines.push(`  Excerpt: ${sig.description.slice(0, 250)}`);
    // Article content if we successfully fetched the full body. Big accuracy win:
    // headlines alone are misleading. Cap at 1000 chars to control prompt size.
    if (sig.articleContent && sig.articleContent.length > 50) {
      lines.push(`  Article body: ${sig.articleContent.slice(0, 1000)}`);
    }
  }
  return lines.join("\n");
}

async function classify(signals, taskDefs, companyName, mode, threshold = 50) {
  if (!signals.length || !taskDefs.length) return [];

  // Initialize results — each signal starts with no matches
  const results = signals.map(sig => ({
    ...sig, matchedTaskIds: [], confidence: 0, relevanceScores: {}, scoreReasons: {},
  }));

  // Run ALL tasks in parallel — was serial, made N tasks take N×3s. Now ~3s total.
  const taskPromises = taskDefs.map(async task => {
    // Pre-filter: drop signals that don't even mention task keywords. Big token savings.
    const candidateIndices = prefilterSignals(signals, task, mode);
    if (candidateIndices.length === 0) {
      console.log(`  [TASK] "${task.name}" → 0 candidates after keyword pre-filter`);
      return { task, scores: [], error: null };
    }

    // Build signal block — only candidates, with their original indices preserved.
    // The AI will refer to signals by their original idx so we can map back.
    const signalBlock = candidateIndices
      .map(i => formatSignalForAI(signals[i], i, mode))
      .join("\n\n");

    const userPrompt = (task.scoringPrompt || "").trim();
    const taskName = task.name || "(unnamed task)";

    // System prompt: format only. No judgement rules. The user's prompt is authority.
    // Score tiers are descriptive guideposts — the threshold (set by the user via the
    // slider in the UI) is the AUTHORITATIVE cutoff. We describe what each band MEANS
    // but never tell the AI to "reject" or "drop" based on tiers — only based on threshold.
    const sysPrompt = `You are scoring ${mode === "jobs" ? "job postings" : `news articles about "${companyName}"`} against ONE specific task: "${taskName}".

The user has provided their scoring criteria below. Use it AS THE PRIMARY GUIDE — it overrides any generic intuition.

Score each signal 0-100 using these descriptive bands as a calibration guide:
- 90-100: exact match, immediately actionable
- 70-89: strong match, likely actionable
- 50-69: partial / tangential
- 30-49: weak relation
- 0-29: unrelated

The user has set a threshold of ${threshold}. Return ONLY signals scoring ${threshold} or higher. Drop everything below ${threshold}.

Output format (strict JSON, no markdown):
{
  "matches": [
    { "idx": <original index from input>, "score": <0-100 integer>, "reason": "<1 sentence, max 140 chars>" }
  ]
}

If no signals score ${threshold}+, return: { "matches": [] }`;

    const userMessage = `# Task: ${taskName}
${task.description ? `\nTask description: ${task.description}\n` : ""}
${userPrompt ? `# User's scoring criteria:\n${userPrompt}\n` : "# User has not provided custom criteria. Use the task name and description above as the guide.\n"}
# Signals to score:

${signalBlock}`;

    try {
      const c = await getOpenAI().chat.completions.create({
        model: "gpt-5.4-mini",
        temperature: 0.15,
        max_completion_tokens: 2000,
        response_format: { type: "json_object" }, // GUARANTEED valid JSON
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userMessage },
        ],
      });
      const text = c.choices[0]?.message?.content || "{}";
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // Should never happen with json_object mode but defense in depth
        const m = text.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : { matches: [] };
      }
      // Accept either { matches: [...] } or a bare array (model variance)
      const scores = Array.isArray(parsed) ? parsed : (parsed.matches || parsed.scores || []);
      return { task, scores, error: null };
    } catch (e) {
      console.error(`  [TASK ERROR] "${task.name}":`, e.message);
      return { task, scores: null, error: e.message };
    }
  });

  const taskOutputs = await Promise.all(taskPromises);

  for (const { task, scores, error } of taskOutputs) {
    if (scores === null) {
      // OpenAI failed for this task — keyword fallback at score 60 (conservative,
      // since we can't AI-verify). We only emit fallbacks if 60 >= threshold so the
      // user's slider behavior stays consistent: anything below their threshold
      // never appears, regardless of whether AI succeeded or fell back.
      const FALLBACK_SCORE = 60;
      if (FALLBACK_SCORE < threshold) {
        console.log(`  [TASK] "${task.name}" → AI ERROR, fallback score ${FALLBACK_SCORE} < threshold ${threshold}, skipping`);
        continue;
      }
      let fallbackCount = 0;
      signals.forEach((sig, i) => {
        const t = `${sig.headline} ${sig.description || ""} ${sig.jobTitle || ""}`.toLowerCase();
        const kws = [...(task.keywords || []), ...(task.jobTitleKeywords || [])].filter(k => k && k.length >= 2);
        if (kws.length > 0 && kws.some(kw => t.includes(kw.toLowerCase()))) {
          results[i].matchedTaskIds.push(task.id);
          results[i].relevanceScores[task.id] = FALLBACK_SCORE;
          results[i].scoreReasons[task.id] = "AI scoring failed; keyword match fallback";
          results[i].confidence = Math.max(results[i].confidence, FALLBACK_SCORE / 100);
          fallbackCount++;
        }
      });
      console.log(`  [TASK] "${task.name}" → AI ERROR, ${fallbackCount} keyword fallbacks at score ${FALLBACK_SCORE}`);
      continue;
    }
    let matchCount = 0;
    for (const s of scores) {
      const idx = s.idx ?? s.newsIndex ?? s.index;
      // AI may return score as string ("85") even with json_object mode. Coerce defensively.
      const rawScore = s.score ?? s.relevanceScore;
      const score = typeof rawScore === "number" ? rawScore : Number(rawScore);
      const reason = s.reason ?? s.explanation ?? "";
      if (idx !== undefined && Number.isFinite(score) && score >= threshold && results[idx]) {
        results[idx].matchedTaskIds.push(task.id);
        results[idx].relevanceScores[task.id] = Math.min(100, Math.max(0, Math.round(score)));
        results[idx].scoreReasons[task.id] = String(reason).slice(0, 200);
        results[idx].confidence = Math.max(results[idx].confidence, score / 100);
        matchCount++;
      }
    }
    console.log(`  [TASK] "${task.name}" → ${matchCount} matches at threshold ${threshold}+`);
  }

  // Log summary
  const matched = results.filter(s => s.matchedTaskIds.length > 0);
  console.log(`  [SUMMARY] ${signals.length} signals × ${taskDefs.length} tasks → ${matched.length} signals matched`);

  return results;
}

// ─── Route Handler ────────────────────────────────────────────────

export async function POST(request) {
  try {
    const body = await request.json();
    const { mode } = body;
    // The frontend passes the user's configured scoring threshold (0-100, default 70).
    // We pass this to the AI so it can drop low-scoring signals at output time
    // instead of returning them and having the frontend filter post-hoc.
    // Full 0-100 range — user has a slider in the UI, no artificial floor.
    // Use ?? not || so 0 is preserved (|| would treat 0 as falsy and use default 70).
    const rawT = body.threshold;
    const parsedT = rawT == null ? 70 : Number(rawT);
    const threshold = Number.isFinite(parsedT) ? Math.max(0, Math.min(100, Math.round(parsedT))) : 70;

    if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

    if (mode === "jobs-batch") {
      // Batch mode: multiple companies in ONE Apify call
      const { companies, taskDefs } = body;
      if (!companies?.length) return NextResponse.json({ error: "No companies provided" }, { status: 400 });
      if (!taskDefs?.length) return NextResponse.json({ error: "No task definitions provided" }, { status: 400 });

      console.log(`\n── Jobs Batch: ${companies.length} companies (threshold: ${threshold}) ──`);
      const results = await scanJobsBatch(companies, taskDefs, threshold);
      return NextResponse.json({ results, threshold });
    }

    // Single company mode (news)
    const { company, taskDefs } = body;
    if (!company?.name) return NextResponse.json({ error: "Company name required" }, { status: 400 });
    if (!taskDefs?.length) return NextResponse.json({ error: "Task definitions required" }, { status: 400 });

    console.log(`\n── Scanning: ${company.name} [${mode}] (threshold: ${threshold}) ──`);
    const signals = await scanNews(company, taskDefs, threshold);

    return NextResponse.json({
      news: signals,
      company: company.name,
      mode,
      threshold,
      matchedCount: signals.filter(n => (n.matchedTaskIds || []).length > 0).length,
    });
  } catch (error) {
    console.error("Scan error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
