import { NextResponse } from "next/server";
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
async function apifyCallWithFallback(actorId, input, timeoutMs = 150000) {
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

        // Credit exhausted — try next token
        if (isCreditExhausted(res.status, "")) {
          const err = await res.text();
          if (isCreditExhausted(res.status, err)) {
            console.error(`  [APIFY] ${key} exhausted (HTTP ${res.status}). ${t < tokens.length - 1 ? "Trying next token..." : "No more tokens."}`);
            break; // break retry loop, go to next token
          }
        }

        // 502/503 gateway timeout — retry same token
        if (res.status === 502 || res.status === 503) {
          console.error(`  [APIFY] HTTP ${res.status} — ${attempt < 2 ? "retrying..." : "moving on"}`);
          if (attempt < 2) { await new Promise(r => setTimeout(r, 3000)); continue; }
          break; // try next token
        }

        // Other error
        if (!res.ok) {
          const err = await res.text();
          console.error(`  [APIFY] HTTP ${res.status}: ${err.slice(0, 200)}`);
          // Check if the error body indicates credit exhaustion
          if (isCreditExhausted(res.status, err)) {
            console.error(`  [APIFY] ${key} exhausted. ${t < tokens.length - 1 ? "Trying next token..." : "No more tokens."}`);
            break;
          }
          return { error: `HTTP ${res.status}`, data: null };
        }

        // Success
        const data = await res.json();
        console.log(`  [APIFY] Success via ${key}`);
        return { data, error: null, usedToken: key };
      } catch (e) {
        if (e.name === "AbortError") {
          console.error(`  [APIFY] Timed out (${timeoutMs / 1000}s) — ${attempt < 2 ? "retrying..." : "moving on"}`);
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

function filterRecent(items) {
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  return items.filter(item => {
    if (!item.date) return true; // keep items with no date (let AI handle)
    const d = new Date(item.date).getTime();
    return !isNaN(d) && d >= cutoff;
  });
}

// ═══════════════════════════════════════════════════════════════════
// MODE: NEWS — Google News RSS → article fetch → classify
// ═══════════════════════════════════════════════════════════════════

async function scanNews(company, taskDefs) {
  console.log(`  [NEWS] Fetching for ${company.name}...`);
  const q = encodeURIComponent(`"${company.name}"`);
  const items = await fetchRSS(`https://news.google.com/rss/search?q=${q}+when:7d&hl=en&gl=US&ceid=US:en`, `Google News [${company.name}]`, "Google News");

  const recent = filterRecent(items);
  console.log(`  [NEWS] ${items.length} total → ${recent.length} within ${MAX_AGE_DAYS} days`);

  if (recent.length === 0) {
    console.log(`  [NEWS] No recent articles found — skipping (real signals only)`);
    return [];
  }

  const enriched = await Promise.all(recent.slice(0, 10).map(async n => ({ ...n, signalType: "news", articleContent: await fetchArticle(n.url) })));
  return classify(enriched, taskDefs, company.name, "news");
}

// ═══════════════════════════════════════════════════════════════════
// MODE: JOBS-BATCH — Apify LinkedIn Scraper with f_C company filter
//
// Accepts up to 10 companies at once → builds all f_C URLs → ONE Apify call
// Returns results grouped by company for the frontend to process
// ═══════════════════════════════════════════════════════════════════

async function scanJobsBatch(companies, taskDefs) {
  const tokens = getApifyTokens();
  if (tokens.length === 0) {
    console.log("  [JOBS-BATCH] No Apify tokens configured — skipping");
    return companies.map(c => ({ company: c.name, signals: [] }));
  }

  // Build one URL per company
  const urlMap = [];
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    let url;
    if (c.linkedinCompanyId) {
      url = `https://www.linkedin.com/jobs/search/?f_C=${c.linkedinCompanyId}&f_TPR=r604800&sortBy=DD`;
    } else {
      const topKw = taskDefs.flatMap(t => t.jobTitleKeywords || t.keywords || [])[0] || "marketing";
      url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${c.name}" ${topKw}`)}&sortBy=DD`;
    }
    urlMap.push({ url, companyIndex: i, companyName: c.name, companyId: c.linkedinCompanyId, hasId: !!c.linkedinCompanyId });
    console.log(`  [JOBS-BATCH] ${c.name}: ${c.linkedinCompanyId ? `f_C=${c.linkedinCompanyId}` : "keyword fallback"}`);
  }

  const allUrls = urlMap.map(u => u.url);
  console.log(`  [JOBS-BATCH] Sending ${allUrls.length} URLs in ONE Apify call`);

  const actorId = process.env.APIFY_ACTOR_ID || "curious_coder/linkedin-jobs-scraper";
  const input = { urls: allUrls, maxItems: 15 * companies.length };

  // Use fallback helper — tries all 3 tokens automatically
  const { data, error } = await apifyCallWithFallback(actorId, input, 150000);
  const allJobs = Array.isArray(data) ? data : [];

  if (error) console.error(`  [JOBS-BATCH] ${error}`);
  console.log(`  [JOBS-BATCH] Got ${allJobs.length} total job listings`);

  if (allJobs.length === 0) {
    return companies.map(c => ({ company: c.name, signals: [] }));
  }

  // Group jobs by company — match using companyName from Apify results
  const results = [];
  for (let i = 0; i < companies.length; i++) {
    const c = companies[i];
    const hasId = !!c.linkedinCompanyId;
    const companyLower = c.name.toLowerCase().trim();
    const domainBase = (c.domain || "").replace(/\.(com|io|co|org|net|ai)$/i, "").toLowerCase();
    const companySlug = (c.linkedinSlug || "").toLowerCase();

    // Match jobs to this company
    const companyJobs = allJobs.filter(job => {
      const jobCoName = (job.companyName || "").toLowerCase().trim();
      const jobLinkedinUrl = (job.companyLinkedinUrl || job.companyUrl || "").toLowerCase();
      const jobSlug = jobLinkedinUrl.match(/linkedin\.com\/company\/([^\/?\s]+)/)?.[1] || "";

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
      signalType: "job_post",
      jobTitle: job.title || "",
      jobLocation: job.location || "",
      jobCompany: job.companyName || c.name,
      jobSalary: Array.isArray(job.salaryInfo) ? job.salaryInfo.join(" - ") : (job.salaryInfo || ""),
      articleContent: cl(job.descriptionText || job.descriptionHtml || "").slice(0, 800),
    })).filter(j => j.jobTitle.length > 2);

    // Date filter for keyword fallback only (f_C already has f_TPR=r604800)
    const recent = hasId ? signals : filterRecent(signals);

    console.log(`  [JOBS-BATCH] ${c.name}: ${companyJobs.length} matched → ${recent.length} recent`);

    if (recent.length > 0) {
      const classified = await classify(recent, taskDefs, c.name, "jobs");
      results.push({ company: c.name, signals: classified });
    } else {
      results.push({ company: c.name, signals: [] });
    }
  }

  return results;
}

// ─── Shared: OpenAI Classification ───────────────────────────────

async function classify(signals, taskDefs, companyName, mode) {
  if (!signals.length || !taskDefs.length) return [];

  const taskList = taskDefs
    .map(t => `ID:"${t.id}" | "${t.name}" | Keywords:[${(t.keywords || []).join(", ")}]${t.jobTitleKeywords ? ` | JobTitles:[${t.jobTitleKeywords.join(", ")}]` : ""}`)
    .join("\n");

  const signalList = signals
    .map((n, i) => {
      let e = `[${i}] "${n.headline}"`;
      if (n.description) e += `\n    Summary: ${n.description.slice(0, 200)}`;
      if (n.articleContent?.length > 50) e += `\n    Content: ${n.articleContent.slice(0, 400)}`;
      return e;
    }).join("\n\n");

  const prompt = mode === "jobs"
    ? `You classify job postings against job signal task definitions. Match based on job title keywords, role description, and seniority. A "CMO" posting matches a "CMO / CGO opening" task. An "Analytics Manager" posting matches an "analytics backfill" task. Be generous — partial matches count. Return ONLY JSON array: [{"newsIndex":0,"matchedTaskIds":["j1"],"confidence":0.85}]. Omit non-matches. No markdown.`
    : `You classify news articles against signal task definitions. Use headlines, summaries, AND article content. Be generous — semantic matches count. Return ONLY JSON array: [{"newsIndex":0,"matchedTaskIds":["n1"],"confidence":0.85}]. Omit non-matches. No markdown.`;

  try {
    const c = await openai.chat.completions.create({
      model: "gpt-4.1-mini", temperature: 0.15, max_tokens: 2000,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: `Company: ${companyName}\n\nSignals:\n${signalList}\n\nTasks:\n${taskList}` },
      ],
    });
    const text = c.choices[0]?.message?.content || "[]";
    let cls; try { cls = JSON.parse(text.replace(/```json\n?|```/g, "").trim()); } catch { const m = text.match(/\[[\s\S]*\]/); cls = m ? JSON.parse(m[0]) : []; }
    if (!Array.isArray(cls)) return [];
    const valid = new Set(taskDefs.map(t => t.id));
    return signals.map((sig, i) => {
      const c = cls.find(x => x.newsIndex === i);
      if (!c) return { ...sig, matchedTaskIds: [], confidence: 0 };
      return { ...sig, matchedTaskIds: (c.matchedTaskIds || []).filter(id => valid.has(id)), confidence: Math.min(1, Math.max(0, c.confidence || 0.7)) };
    });
  } catch (e) {
    console.error(`Classify error (${mode}):`, e);
    return signals.map(sig => {
      const t = (sig.headline + " " + (sig.description || "")).toLowerCase();
      const matched = taskDefs.filter(td => (td.keywords || []).some(kw => t.includes(kw.toLowerCase())));
      return { ...sig, matchedTaskIds: matched.map(td => td.id), confidence: matched.length > 0 ? 0.6 : 0 };
    });
  }
}

// ─── Route Handler ────────────────────────────────────────────────

export async function POST(request) {
  try {
    const body = await request.json();
    const { mode } = body;

    if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not configured" }, { status: 500 });

    if (mode === "jobs-batch") {
      // Batch mode: multiple companies in ONE Apify call
      const { companies, taskDefs } = body;
      if (!companies?.length) return NextResponse.json({ error: "No companies provided" }, { status: 400 });
      if (!taskDefs?.length) return NextResponse.json({ error: "No task definitions provided" }, { status: 400 });

      console.log(`\n── Jobs Batch: ${companies.length} companies ──`);
      const results = await scanJobsBatch(companies, taskDefs);
      return NextResponse.json({ results });
    }

    // Single company mode (news)
    const { company, taskDefs } = body;
    if (!company?.name) return NextResponse.json({ error: "Company name required" }, { status: 400 });
    if (!taskDefs?.length) return NextResponse.json({ error: "Task definitions required" }, { status: 400 });

    console.log(`\n── Scanning: ${company.name} [${mode}] ──`);
    const signals = await scanNews(company, taskDefs);

    return NextResponse.json({
      news: signals,
      company: company.name,
      mode,
      matchedCount: signals.filter(n => (n.matchedTaskIds || []).length > 0).length,
    });
  } catch (error) {
    console.error("Scan error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
