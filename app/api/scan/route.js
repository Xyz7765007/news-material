import { NextResponse } from "next/server";
import OpenAI from "openai";
import { trackOpenAIUsage } from "@/lib/ai-usage";
import { decodeGoogleNewsUrl } from "@/lib/google-news-decoder";

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

// ─── Neutral System Prompt Feature Flag ──────────────────────────────
// The default system prompt prepends a 5-band calibration scale (90-100 exact
// match, 70-89 strong match, etc.) and instructs the AI to "drop everything
// below threshold." That fights user prompts with hard caps (e.g. V4 marketing
// signal: "no marketing entity → score ≤25") because the AI resolves the
// conflict by anchoring at the threshold floor (clusters at 70-72) and
// silently overriding the user's gating logic.
//
// Setting NEUTRAL_PROMPT_ENABLED=true OR adding the campaign's Airtable record
// ID to NEUTRAL_PROMPT_CAMPAIGN_IDS (comma-separated) switches that campaign
// to a neutral system prompt that:
//   1. Drops the calibration bands (user prompt is sole authority)
//   2. Stops telling the AI to drop below threshold (server filters post-hoc)
//   3. Explicitly asks the AI to apply user-defined caps mechanically
//
// Roll out per-campaign first via NEUTRAL_PROMPT_CAMPAIGN_IDS to validate
// before flipping NEUTRAL_PROMPT_ENABLED globally.
function isNeutralPromptEnabled(campaignId) {
  if (process.env.NEUTRAL_PROMPT_ENABLED === "true") return true;
  const list = (process.env.NEUTRAL_PROMPT_CAMPAIGN_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  return campaignId && list.includes(campaignId);
}

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
  // Match <item> OR <item type="..."> — some feeds add attributes/namespaces.
  // Old regex /<item>/ silently dropped any item with attributes.
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
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

// User-Agent rotation. Single UA from one IP gets fingerprinted and blocked
// faster than rotating. We pick one per request based on attempt number.
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];
const pickUA = (i = 0) => USER_AGENTS[i % USER_AGENTS.length];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchRSS(url, label, src) {
  // Retry up to 3 attempts. RSS is cheap and reliability is critical — a single
  // 429/503/timeout from Google News should NOT result in 0 signals for a company.
  // Backoff: 0ms, 1s, 3s. Total worst-case: 3 attempts × 12s + 4s sleep = 40s.
  const maxAttempts = 3;
  let lastErr = "unknown";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await sleep(1000 * attempt * attempt); // 0, 1s, 4s
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 12000);
      const r = await fetch(url, {
        headers: {
          "User-Agent": pickUA(attempt),
          "Accept": "application/rss+xml, application/xml, text/xml, */*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: c.signal,
      });
      clearTimeout(t);
      if (!r.ok) {
        lastErr = `HTTP ${r.status}`;
        // Retry on transient errors (rate limit, server issue). Don't retry on 4xx other than 429.
        if (r.status === 429 || r.status >= 500) {
          console.warn(`  [RSS] ${label}: ${lastErr} on attempt ${attempt + 1}/${maxAttempts}, retrying...`);
          continue;
        }
        console.error(`  [RSS] ${label}: ${lastErr} (no retry — non-transient)`);
        return [];
      }
      const xml = await r.text();
      if (!xml.includes("<item>")) {
        // Empty results — could be legitimate (no recent news) OR Google News served a non-RSS response (rare, but happens)
        const looksLikeRSS = xml.includes("<rss") || xml.includes("<feed");
        if (!looksLikeRSS && attempt < maxAttempts - 1) {
          console.warn(`  [RSS] ${label}: response doesn't look like RSS (got ${xml.length} chars), retrying...`);
          lastErr = "non-RSS response";
          continue;
        }
        console.log(`  [RSS] ${label}: 0 items (legitimately empty or filtered)`);
        return [];
      }
      const items = parseRSSItems(xml, src);
      console.log(`  [RSS] ${label}: ${items.length} items${attempt > 0 ? ` (succeeded on attempt ${attempt + 1})` : ""}`);
      return items;
    } catch (e) {
      lastErr = e.name === "AbortError" ? "timeout" : e.message;
      console.warn(`  [RSS] ${label}: ${lastErr} on attempt ${attempt + 1}/${maxAttempts}`);
    }
  }
  console.error(`  [RSS] ${label}: FAILED after ${maxAttempts} attempts — last error: ${lastErr}`);
  return [];
}

// ─── Article Content Fetcher ──────────────────────────────────────
//
// Returns { content: string, error: string|null }
// - content: cleaned article body (up to 800 chars)
// - error: null on success, otherwise: "no_url" | "http_<code>" | "timeout" | "thin_body" | "fetch_error" | ...
//
// The error indicator lets the caller track success rates per scan and surface
// them in logs so we can debug "why did so few signals match" without guessing.

async function fetchArticle(url) {
  if (!url || url.length < 10) return { content: "", error: "no_url" };
  // 3 attempts with different UAs + escalating backoff. Total worst-case:
  // 3 × 7s + 2s+4s sleeps = 27s per article. Combined with concurrency cap
  // of 8 (see scanNews), wall-clock for 50 articles is bounded to ~3-4 min.
  // We trade speed for reliability — the user's #1 complaint was inconsistent
  // signal counts run-to-run, which traces to article fetch failures dropping
  // body context → AI scores low → signals dropped below threshold.
  const maxAttempts = 3;
  let lastErr = "unknown";
  // Track whether we've already followed a meta-refresh/JS redirect to avoid loops
  let currentUrl = url;
  let followedRedirect = false;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Backoff: 0ms, 1.5s, 4s. Random jitter ±400ms to avoid thundering herd
      // when many fetches retry simultaneously after a rate-limit burst.
      const base = attempt === 1 ? 1500 : 4000;
      const jitter = Math.random() * 800 - 400;
      await sleep(Math.max(100, base + jitter));
    }
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 7000); // 7s per attempt
      const r = await fetch(currentUrl, {
        headers: {
          "User-Agent": pickUA(attempt),
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
        },
        signal: c.signal,
        redirect: "follow",
      });
      clearTimeout(t);
      if (!r.ok) {
        lastErr = `http_${r.status}`;
        // Retry on transient errors (rate limit, server issues). 4xx other than 429 are permanent.
        if ((r.status === 429 || r.status >= 500) && attempt < maxAttempts - 1) {
          continue;
        }
        return { content: "", error: lastErr };
      }
      const html = await r.text();
      // ── Detect meta-refresh / JS redirect (Google News redirector pattern) ──
      // Google News RSS links often go to news.google.com/rss/articles/... which
      // returns an HTML page that meta-refreshes or JS-redirects to the actual
      // publisher URL. fetch() doesn't follow these by default. We extract the
      // destination URL and re-fetch ONCE (avoid loops with followedRedirect flag).
      //
      // 2026-05-08: Bumped threshold from 8000 → 30000. Google News interstitial
      // pages have grown over time (now include inline JS bundles for analytics +
      // consent management). At 8KB cap we were skipping redirect detection on
      // pages that genuinely WERE redirectors, falling through to extraction
      // which produced thin_body. 30KB still excludes real article pages.
      if (!followedRedirect && html.length < 30000) {
        // Try multiple redirect patterns publishers/Google News use
        const metaRefresh = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*?url=([^"'\s>]+)/i);
        const jsLocation = html.match(/(?:window\.location|location\.href|location\.replace)\s*=?\s*\(?\s*["']([^"']+)["']/i);
        const dataUrl = html.match(/data-n-au=["']([^"']+)["']/); // Google News' own tracker
        const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i);
        let redirectUrl = (metaRefresh?.[1] || jsLocation?.[1] || dataUrl?.[1] || canonical?.[1] || "").replace(/&amp;/g, "&");

        // ── 2026-05-08: firstExternalLink fallback ──
        // After 4 production scans showed 100% thin_extraction (which under the
        // corrected error logic means "never escaped redirector"), it's clear the
        // 4 patterns above don't match Google News' current redirect mechanism.
        // Modern Google News interstitial pages are 8-30KB and use JS-driven
        // navigation that doesn't appear in static HTML as meta-refresh or
        // location.href. But they DO contain the publisher URL as an <a href>
        // somewhere in the page (for fallback no-JS rendering, share UI, etc.).
        //
        // We look for the FIRST external anchor whose host is not Google itself
        // and not a known social/share/ad destination. Strict filtering required
        // because Google News pages also contain footer links to other Google
        // properties and Twitter/Facebook share buttons.
        if (!redirectUrl) {
          const SKIP_HOSTS = /(?:^|\/\/)(?:[a-z0-9-]+\.)?(?:google|gstatic|youtube|googleusercontent|googleapis|googletagmanager|doubleclick|twitter|x\.com|facebook|linkedin|instagram|pinterest|reddit|whatsapp|t\.me|telegram|tiktok|threads|truthsocial|bsky|mastodon|sharethis|addthis|email-share)\./i;
          // Match all external anchors. Only consider href values that look like full URLs.
          const anchors = html.matchAll(/<a[^>]+href=["'](https?:\/\/[^"']+)["']/gi);
          for (const m of anchors) {
            const candidate = m[1];
            if (SKIP_HOSTS.test(candidate)) continue;
            // Avoid obvious share/utm endpoints
            if (/[?&](share|utm_source=share|via=)/i.test(candidate)) continue;
            redirectUrl = candidate.replace(/&amp;/g, "&");
            break;
          }
        }

        if (redirectUrl && /^https?:\/\//i.test(redirectUrl) && !redirectUrl.includes("news.google.com") && redirectUrl !== currentUrl) {
          // Found a redirect target — follow it ONCE
          currentUrl = redirectUrl;
          followedRedirect = true;
          continue; // retry loop with new URL, doesn't count against maxAttempts intent (but does count as attempt)
        }
      }
      // ── Article body extraction ──
      // Try multiple container patterns in order of specificity:
      //   1. <article> tag (most semantically correct, used by most publishers)
      //   2. <main> tag (HTML5 main content landmark)
      //   3. <div role="article"> or [itemtype*="Article"] (ARIA / schema.org)
      //   4. Common article-body class names (wp/medium/substack/cms patterns)
      //   5. Fallback: all <p> tags joined (catches sites with non-standard markup)
      //
      // 2026-05-08: was only #1 + #5. Sites using Next.js / React article shells
      // often render the body inside a <div class="article-body"> with no
      // <article> tag and <p> tags scattered across nav/footer/related-articles
      // — the all-<p>-tags fallback then pulled in nav text and produced thin
      // off-topic bodies. The intermediate selectors recover those cases.
      const tryExtract = (pattern) => {
        const m = html.match(pattern);
        return m ? m[1] : null;
      };
      let text =
        tryExtract(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
        tryExtract(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
        tryExtract(/<div[^>]+role=["']article["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<footer|<aside)/i) ||
        tryExtract(/<[^>]+itemtype=["'][^"']*Article[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|article|section)>/i) ||
        tryExtract(/<div[^>]+class=["'][^"']*(?:article-body|article-content|story-body|story-content|post-content|entry-content|article__body|c-article-body)[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*(?:<\/div>|<footer|<aside)/i) ||
        (html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || []).join(" ");
      const cleaned = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&[a-z]+;/gi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 800);
      if (cleaned.length < 50) {
        // Too thin to be useful — don't retry (the page genuinely has no extractable text).
        // Split into 3 codes so the scan summary tells us WHICH stage failed:
        //   - thin_redirect: we never escaped the redirector (Google News interstitial,
        //     etc.) — followedRedirect is false. Means our redirect detection patterns
        //     didn't match whatever mechanism the redirector uses.
        //   - thin_extraction: we DID escape the redirector and reached the publisher,
        //     but no article container matched on the publisher page. Likely a JS-rendered
        //     SPA where the body is in React state, not static HTML.
        //   - thin_body: very short HTML (< 2KB), too small to even attempt extraction.
        //     Likely a 200-OK error page or a tracking pixel response.
        let errCode = "thin_body";
        if (!followedRedirect) errCode = "thin_redirect";
        else if (html.length >= 2000) errCode = "thin_extraction";
        return { content: cleaned, error: errCode };
      }
      return { content: cleaned, error: null };
    } catch (e) {
      lastErr = e.name === "AbortError" ? "timeout" : "fetch_error";
      // Retry on timeout/network errors (often transient)
      if ((lastErr === "timeout" || lastErr === "fetch_error") && attempt < maxAttempts - 1) continue;
      return { content: "", error: lastErr };
    }
  }
  return { content: "", error: lastErr };
}

// ─── Date Filter ──────────────────────────────────────────────────

const MAX_AGE_DAYS = 7;
// Jobs are kept longer because non-tech companies post less frequently. A "VP Marketing
// role open" 3 weeks ago is still actionable. News at 7 days makes sense (old news isn't
// actionable), but jobs we keep for 30 days. Override via env if needed.
const MAX_JOB_AGE_DAYS = parseInt(process.env.MAX_JOB_AGE_DAYS) || 7;

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

async function scanNews(company, taskDefs, threshold = 50, campaignId = null) {
  const cleanName = cleanCompanyName(company.name);
  if (!cleanName) {
    console.log(`  [NEWS] Skipping ${company.name} — empty name after cleaning`);
    return [];
  }
  console.log(`  [NEWS] Fetching for ${cleanName}${cleanName !== company.name ? ` (was: "${company.name}")` : ""}...`);
  const q = encodeURIComponent(`"${cleanName}"`);
  const items = await fetchRSS(`https://news.google.com/rss/search?q=${q}+when:7d&hl=en&gl=US&ceid=US:en`, `Google News [${cleanName}]`, "Google News");

  const recent = filterRecent(items);
  console.log(`  [NEWS] ${cleanName}: ${items.length} total → ${recent.length} within ${MAX_AGE_DAYS} days`);

  if (recent.length === 0) {
    console.log(`  [NEWS] ${cleanName}: No recent articles found`);
    return [];
  }

  // Fetch full article body — used in classify for higher accuracy. Headlines alone
  // are misleading and produce conservative scores that drop below threshold.
  //
  // CRITICAL: Limited to 8 parallel fetches. Was Promise.all of 50 simultaneous,
  // which routinely triggered rate limits at CloudFront/Akamai/etc. when 50 fetches
  // hit different publisher domains from one Vercel egress IP. Result: 30-40% of
  // article bodies were silently empty → AI saw only headlines → scores clustered
  // low → dropped below user threshold → "no relevant signals." This is exactly
  // the symptom the user reported (different success rate per run = different
  // signal count).
  //
  // Also: a SECOND PASS retries articles that failed on first round. By the time
  // we re-attempt, the rate-limit window has passed and many succeed. Doubles
  // wall-clock for failed articles only (typically 5-10) but recovers signals
  // that would otherwise be lost.
  // ── Headline-based dedup BEFORE fetch ──
  // Google News during earnings season returns 30+ outlets republishing the same
  // press release. Dedupe by normalized headline first (cheap, no AI). Saves fetch
  // calls AND token spend on AI. We keep the FIRST occurrence (which Google News
  // sorts by relevance/date — usually the original source).
  const seenHeadlines = new Set();
  const dedupedRecent = [];
  for (const item of recent) {
    // Normalize: lowercase, strip punctuation, strip common publication suffixes,
    // collapse whitespace. "Apple Q3 Earnings - Reuters" → "apple q3 earnings"
    const norm = (item.headline || "")
      .toLowerCase()
      .replace(/\s*[-–—|·•]\s*[^-–—|·•]+$/, "") // strip trailing " - Source Name"
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!norm || norm.length < 10) {
      dedupedRecent.push(item); // can't reliably dedupe ultra-short or empty
      continue;
    }
    if (seenHeadlines.has(norm)) continue;
    seenHeadlines.add(norm);
    dedupedRecent.push(item);
  }
  const dedupCount = recent.length - dedupedRecent.length;
  if (dedupCount > 0) {
    console.log(`  [NEWS] ${cleanName}: deduped ${dedupCount} near-identical headlines (${recent.length} → ${dedupedRecent.length})`);
  }

  // Diagnostic: count how many URLs are Google News redirectors. These often fail
  // to fetch because they require following JS redirects, not HTTP 30x. Knowing
  // this helps explain low fetch rates without guessing.
  const googleNewsRedirectorCount = dedupedRecent.filter(item =>
    (item.url || "").includes("news.google.com/rss/articles/")
  ).length;
  if (googleNewsRedirectorCount > 0) {
    const pct = Math.round((googleNewsRedirectorCount / dedupedRecent.length) * 100);
    console.log(`  [NEWS] ${cleanName}: ${googleNewsRedirectorCount}/${dedupedRecent.length} URLs (${pct}%) are Google News redirectors — decoding to publisher URLs...`);
  }

  // ── DECODE Google News redirector URLs to publisher URLs ──
  // Google News RSS returns links of the form:
  //   https://news.google.com/rss/articles/CBM...?oc=5
  // The page at that URL is a JS-driven redirect (no HTTP 30x), so server-side
  // fetch never reaches the publisher. The decoder unpacks the protobuf payload
  // embedded in the URL (or falls back to a batchexecute RPC for newer URLs)
  // to recover the real publisher URL. Once we have that, the existing
  // fetchArticle pipeline works normally.
  //
  // We decode IN-PLACE (replace item.url) so the rest of the scan is unchanged.
  // Concurrency is moderate (4) because the batchexecute RPC hits Google's
  // own infra and we want to be polite. Simple base64 decode is local-only.
  const DECODE_CONCURRENCY = 4;
  let decodeStats = { attempted: 0, decoded: 0, failed: 0 };
  for (let i = 0; i < dedupedRecent.length; i += DECODE_CONCURRENCY) {
    const batch = dedupedRecent.slice(i, i + DECODE_CONCURRENCY);
    await Promise.all(batch.map(async item => {
      if (!item.url || !item.url.includes("news.google.com/rss/articles/")) return;
      decodeStats.attempted++;
      try {
        const decoded = await decodeGoogleNewsUrl(item.url);
        if (decoded) {
          item.url = decoded;
          decodeStats.decoded++;
        } else {
          decodeStats.failed++;
        }
      } catch (_) {
        decodeStats.failed++;
      }
    }));
  }
  if (decodeStats.attempted > 0) {
    const pct = Math.round((decodeStats.decoded / decodeStats.attempted) * 100);
    console.log(`  [NEWS] ${cleanName}: Google News URL decode ${decodeStats.decoded}/${decodeStats.attempted} (${pct}%) — failures will fall back to legacy redirector handling`);
  }

  // Slice to 50. With 3-attempt fetcher (worst case ~26s per article) and
  // concurrency 8, 50 articles take ~7 batches × ~10-15s wall = 70-100s typical,
  // up to ~180s worst case during a publisher outage. Leaves room for the
  // second-pass retry and classify within the 300s POST budget.
  const recentSlice = dedupedRecent.slice(0, 50);
  const stats = { total: recentSlice.length, succeeded: 0, errors: {}, secondPassRecovered: 0 };
  const enriched = [];
  // Concurrency 8: was 12, lowered for better publisher-side acceptance.
  // 50 articles ÷ 8 concurrency = 7 batches × ~10s wall = ~70s. Within 300s budget.
  const CONCURRENCY = 8;
  for (let i = 0; i < recentSlice.length; i += CONCURRENCY) {
    const batch = recentSlice.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async n => {
      const { content, error } = await fetchArticle(n.url);
      if (error) {
        stats.errors[error] = (stats.errors[error] || 0) + 1;
      } else {
        stats.succeeded++;
      }
      return { ...n, taskType: "news", articleContent: content, fetchError: error };
    }));
    enriched.push(...results);
  }

  // ── SECOND PASS: retry failed transient errors ──
  // Permanent errors (http_404, no_url, thin_body) are not retried.
  // Transient errors (timeout, fetch_error, http_429, http_5xx) get one more
  // shot. By now any rate-limit windows have rolled over.
  const retryable = enriched
    .map((s, idx) => ({ s, idx }))
    .filter(({ s }) => {
      const e = s.fetchError;
      return e === "timeout" || e === "fetch_error" || e === "http_429" || (e && e.startsWith("http_5"));
    });
  if (retryable.length > 0 && retryable.length < recentSlice.length) {
    console.log(`  [NEWS] ${cleanName}: second-pass retry on ${retryable.length} transient failures...`);
    await sleep(2000); // settle interval before retrying
    for (let i = 0; i < retryable.length; i += CONCURRENCY) {
      const batch = retryable.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async ({ s, idx }) => {
        const { content, error } = await fetchArticle(s.url);
        if (!error) {
          // Recovered — update enriched in place
          enriched[idx] = { ...s, articleContent: content, fetchError: null };
          stats.succeeded++;
          stats.secondPassRecovered++;
          stats.errors[s.fetchError] = (stats.errors[s.fetchError] || 1) - 1;
          if (stats.errors[s.fetchError] <= 0) delete stats.errors[s.fetchError];
        }
      }));
    }
  }

  const successRate = Math.round((stats.succeeded / stats.total) * 100);
  const errorSummary = Object.entries(stats.errors).filter(([, v]) => v > 0).map(([k, v]) => `${k}:${v}`).join(", ") || "none";
  const recoveryNote = stats.secondPassRecovered > 0 ? ` (${stats.secondPassRecovered} recovered on retry)` : "";
  console.log(`  [NEWS] ${cleanName}: article body fetch ${stats.succeeded}/${stats.total} (${successRate}%)${recoveryNote} — errors: ${errorSummary}`);
  if (successRate < 50 && stats.total >= 5) {
    console.warn(`  [NEWS] ${cleanName}: ⚠ LOW FETCH SUCCESS RATE (${successRate}%). Some signals will be scored on headline alone — accuracy may be lower than usual.`);
  }

  const classified = await classify(enriched, taskDefs, cleanName, "news", threshold, campaignId);
  return { signals: classified, fetchStats: { succeeded: stats.succeeded, total: stats.total, successRate, errors: stats.errors, secondPassRecovered: stats.secondPassRecovered } };
}

// ═══════════════════════════════════════════════════════════════════
// MODE: JOBS-BATCH — Apify LinkedIn Scraper with f_C company filter
//
// Accepts up to 10 companies at once → builds all f_C URLs → ONE Apify call
// Returns results grouped by company for the frontend to process
// ═══════════════════════════════════════════════════════════════════

async function scanJobsBatch(companies, taskDefs, threshold = 50, campaignId = null) {
  const tokens = getApifyTokens();
  if (tokens.length === 0) {
    console.log("  [JOBS-BATCH] No Apify tokens configured — skipping");
    return companies.map(c => ({ company: c.name, signals: [] }));
  }

  // Build URLs — keyword-based per-company URLs (no batching).
  // Drop the prior withIds/withoutIds split since both paths now use the
  // same shape of URL. f_C as a filter has been retired (see comment below).
  const urls = [];

  // f_TPR window (in seconds): r604800 = 7 days, r2592000 = 30 days, r7776000 = 90 days
  // Override via APIFY_JOBS_TPR env var if you need a different window.
  const TPR = process.env.APIFY_JOBS_TPR || "r604800"; // 604800s = 7 days, matches MAX_JOB_AGE_DAYS=7

  // 2026-05-08: Empirical evidence (Mastercard debug runs) showed that
  // f_C=<id>&keywords=marketing returns the ALL-JOBS feed for a company,
  // not marketing-only jobs. LinkedIn ignores `keywords` when `f_C` is
  // present. The all-jobs feed contains ~2 marketing roles out of every 25
  // (most are product/sales/ops/finance), and our keyword prefilter then
  // drops everything → 0 tasks.
  //
  // Fix: drop f_C entirely. Use keyword-based URLs for every company,
  // pattern: keywords="${name}" marketing — the same shape that the
  // existing `withoutIds` fallback has been using (and getting marketing-
  // focused results from). Downstream company-name matching filters out
  // any cross-pollution from companies that mention "Mastercard" in JDs.
  //
  // Trade-off: lose batching (was 5 companies → 1 URL, now 5 → 5 URLs).
  // Apify cost increases ~5×, but each company gets its own 100-result
  // ceiling instead of sharing 100 across the batch, so per-company
  // recall improves. Net cost vs accuracy is favorable.

  for (const c of companies) {
    const cleanName = cleanCompanyName(c.name);
    if (!cleanName) continue;
    const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" marketing`)}&f_TPR=${TPR}&sortBy=DD`;
    urls.push(url);
    console.log(`  [JOBS-BATCH] ${cleanName}: keyword URL ${url}`);
  }

  console.log(`  [JOBS-BATCH] Total URLs: ${urls.length} (was ${companies.length} before combining)`);

  const actorId = process.env.APIFY_ACTOR_ID || "curious_coder/linkedin-jobs-scraper";
  const baseInput = { count: 100, scrapeCompany: false, includeJobDescription: true };

  // Use fallback helper — tries all 3 tokens automatically
  let { data, error } = await apifyCallWithFallback(actorId, { urls, ...baseInput }, 480000);
  let allJobs = Array.isArray(data) ? data : [];

  if (error) console.error(`  [JOBS-BATCH] ${error}`);
  console.log(`  [JOBS-BATCH] Got ${allJobs.length} total job listings`);

  // ── Retry: Drop f_TPR entirely (no time filter) if first attempt returned 0 ──
  // Reason: even 30-day windows fail for some companies. Without f_TPR, LinkedIn
  // returns ALL jobs ever posted by the company, sorted by date — newest first via
  // sortBy=DD. We then filter by date in JS using filterRecentJobs().
  //
  // (Old retry-2 "individual URLs per company" is no longer needed — we're already
  // per-company since dropping f_C batching, so the retry just removes the time filter.)
  if (allJobs.length === 0 && urls.length > 0 && !error) {
    console.log(`  [JOBS-BATCH] 0 results — retrying without time filter (f_TPR)...`);
    const retryUrls = [];
    for (const c of companies) {
      const cleanName = cleanCompanyName(c.name);
      if (!cleanName) continue;
      retryUrls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" marketing`)}&sortBy=DD`);
    }
    const retry1 = await apifyCallWithFallback(actorId, { urls: retryUrls, ...baseInput }, 480000);
    allJobs = Array.isArray(retry1.data) ? retry1.data : [];
    console.log(`  [JOBS-BATCH] After retry (no time filter): ${allJobs.length} jobs`);
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
      const classified = await classify(recent, taskDefs, c.name, "jobs", threshold, campaignId);
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
// in the headline, description, OR ARTICLE BODY. For news, an article that
// doesn't mention any of the task's keywords ANYWHERE is almost certainly noise.
// For jobs, the f_C filter already scoped to right companies, but the JOB TITLE
// or description still needs to match the task's role.
//
// CRITICAL: We MUST include articleContent in the haystack. If we don't, an
// earnings report titled "Merck Q3 2026 Results" gets dropped by the prefilter
// even though the article body mentions a CMO transition that perfectly matches
// the user's keyword "CMO". We just spent ~8s fetching that body — using it
// for prefilter costs nothing and recovers ALL these false negatives.
//
// CRITICAL 2: We normalize punctuation. LinkedIn job titles often have commas
// like "VP, Marketing" — without normalization, keyword "VP Marketing" doesn't
// match. Stripping non-word chars to spaces and collapsing whitespace fixes this.
//
// IMPORTANT: only used when the task has a non-empty keyword list. If the user
// has NO keywords (relying purely on the prompt), we send everything to AI.
function normalizeForMatch(s) {
  return (s || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}
function prefilterSignals(signals, task, mode) {
  const kws = mode === "jobs"
    ? [...(task.jobTitleKeywords || []), ...(task.keywords || [])]
    : (task.keywords || []);
  const cleanKws = kws
    .filter(k => k && k.length >= 2)
    .map(k => normalizeForMatch(k))
    .filter(k => k.length >= 2); // re-filter after normalization in case it stripped to empty
  if (cleanKws.length === 0) return signals.map((_, i) => i); // no keywords = send all
  const matchingIndices = [];
  signals.forEach((sig, i) => {
    // For news: include the article body. For jobs: the description IS the body.
    const body = mode === "jobs" ? "" : (sig.articleContent || "");
    const haystack = normalizeForMatch(`${sig.headline || ""} ${sig.description || ""} ${sig.jobTitle || ""} ${body}`);
    if (cleanKws.some(kw => haystack.includes(kw))) {
      matchingIndices.push(i);
    }
  });
  return matchingIndices;
}

// Build the per-signal block sent to OpenAI. For news, includes article content if
// available (was being fetched but ignored before — wasted ~6s per company).
// When body is unavailable (fetch failed), we EXPLICITLY mark it so the AI knows
// not to over-penalize for thin context.
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
    } else if (sig.fetchError) {
      // Explicit marker so the AI doesn't silently penalize this signal for thin context.
      // Without this marker, the AI sees "headline + excerpt only" and tends to score
      // conservatively (~50-60), even when the headline is a strong match.
      lines.push(`  [Article body unavailable — fetch error: ${sig.fetchError}. Score based on headline + excerpt only; do not penalize for missing body.]`);
    }
  }
  return lines.join("\n");
}

async function classify(signals, taskDefs, companyName, mode, threshold = 50, campaignId = null) {
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
    // Split into chunks of at most 40 candidates per AI call. With prefilter
    // including article body, candidate count can balloon during high-news weeks.
    // 40 × ~250 chars per signal block = ~10K chars input ≈ ~2.5K tokens.
    // Plus output ~1.5K tokens = ~4K total per call. Comfortable.
    // If a task has 60 candidates, we make 2 parallel AI calls instead of dropping
    // 20 signals or risking token-limit truncation.
    const MAX_CANDIDATES_PER_CALL = 40;
    const candidateChunks = [];
    for (let i = 0; i < candidateIndices.length; i += MAX_CANDIDATES_PER_CALL) {
      candidateChunks.push(candidateIndices.slice(i, i + MAX_CANDIDATES_PER_CALL));
    }
    if (candidateChunks.length > 1) {
      console.log(`  [TASK] "${task.name}" → ${candidateIndices.length} candidates split into ${candidateChunks.length} parallel AI calls`);
    }

    const userPrompt = (task.scoringPrompt || "").trim();
    const taskName = task.name || "(unnamed task)";

    // System prompt: format only. No judgement rules. The user's prompt is authority.
    // Score tiers are descriptive guideposts — the threshold (set by the user via the
    // slider in the UI) is the AUTHORITATIVE cutoff. We describe what each band MEANS
    // but never tell the AI to "reject" or "drop" based on tiers — only based on threshold.
    //
    // FEATURE-FLAGGED NEUTRAL PROMPT: when NEUTRAL_PROMPT_ENABLED=true or the
    // campaign is in NEUTRAL_PROMPT_CAMPAIGN_IDS, we use a neutral prompt that
    // drops the calibration bands (which fight V4-style user prompts with hard
    // caps) and stops asking the AI to filter on threshold. See isNeutralPromptEnabled
    // comment block at top of file for full reasoning.
    const useNeutralPrompt = isNeutralPromptEnabled(campaignId);
    const sysPrompt = useNeutralPrompt
      ? `You are scoring ${mode === "jobs" ? "job postings" : `news articles about "${companyName}"`} against ONE specific task: "${taskName}".

The user's scoring criteria below is the COMPLETE and AUTHORITATIVE guide to how scores are assigned. Apply it MECHANICALLY — including:
- Hard caps (e.g. "if X is missing, score must be ≤25")
- Multi-step procedures that must be applied in order
- Self-verification checks the criteria require you to perform before returning a score
- Specific score bands tied to specific evidence in the criteria

Do NOT substitute your own intuition about what counts as a "strong match" — the user has defined that. Do NOT anchor your scores at any particular value. Score each signal HONESTLY per the user's criteria — return the score the criteria actually produce, even if that means returning low scores for most signals.

The server applies the user's threshold as a post-hoc filter. Score every signal you receive; the server will drop signals below threshold. Do NOT pre-filter on threshold. Do NOT nudge scores up to meet the threshold or down to be safe.

Output format (strict JSON, no markdown):
{
  "matches": [
    { "idx": <original index from input>, "score": <0-100 integer>, "reason": "<1 sentence, max 140 chars>" }
  ]
}

Return one entry per signal you have scored (one per [N] index in the input). Use the score the user's criteria produce.`
      : `You are scoring ${mode === "jobs" ? "job postings" : `news articles about "${companyName}"`} against ONE specific task: "${taskName}".

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

    // Helper: makes ONE AI call for a chunk of candidate indices, returns parsed scores.
    // Extracted so we can call it once per chunk and merge results, instead of
    // truncating to a single 40-candidate cap.
    const scoreOneChunk = async (chunkIndices) => {
      const signalBlock = chunkIndices.map(i => formatSignalForAI(signals[i], i, mode)).join("\n\n");
      const userMessage = `# Task: ${taskName}
${task.description ? `\nTask description: ${task.description}\n` : ""}
${userPrompt ? `# User's scoring criteria:\n${userPrompt}\n` : "# User has not provided custom criteria. Use the task name and description above as the guide.\n"}
# Signals to score:

${signalBlock}`;
      const c = await getOpenAI().chat.completions.create({
        model: "gpt-5.4-mini",
        // Temperature 0 = deterministic. Was 0.15 which caused 5-10 point score
        // variance run-to-run — the difference between "above threshold" and
        // "dropped" for borderline signals. User reported 1 vs 37 signals across
        // runs; some of that variance came from this.
        temperature: 0,
        // 4000 tokens output. Each match is ~30-40 tokens (idx + score + reason).
        // With 40 candidates × 40 tokens = 1600 — plenty of headroom.
        max_completion_tokens: 4000,
        response_format: { type: "json_object" }, // GUARANTEED valid JSON
        messages: [
          { role: "system", content: sysPrompt },
          { role: "user", content: userMessage },
        ],
      });
      // Fire-and-forget cost tracking. Never throws, never blocks.
      trackOpenAIUsage({ campaignId, completion: c, action: `scan_${mode}_${task.name}` });
      const text = c.choices[0]?.message?.content || "{}";
      const finishReason = c.choices[0]?.finish_reason;
      if (finishReason === "length") {
        console.warn(`  [TASK] "${task.name}" chunk → ⚠ AI HIT TOKEN LIMIT (${chunkIndices.length} candidates produced too long output). Salvaging partial response.`);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // Fallback parse: trim back to a complete JSON object.
        console.warn(`  [TASK] "${task.name}" chunk → JSON parse failed: ${e.message}. Attempting salvage...`);
        const lastBrace = text.lastIndexOf("}");
        if (lastBrace > 0) {
          for (let cut = lastBrace; cut > 0; cut--) {
            try { parsed = JSON.parse(text.slice(0, cut + 1)); break; } catch { /* keep trying */ }
          }
        }
        if (!parsed) {
          // Last resort: salvage individual match objects via regex
          const matchRegex = /\{\s*"idx"\s*:\s*(\d+)\s*,\s*"score"\s*:\s*(\d+)\s*,\s*"reason"\s*:\s*"([^"]*)"/g;
          const salvaged = [];
          let m;
          while ((m = matchRegex.exec(text)) !== null) {
            salvaged.push({ idx: +m[1], score: +m[2], reason: m[3] });
          }
          parsed = salvaged.length > 0 ? { matches: salvaged } : { matches: [] };
          if (salvaged.length > 0) console.log(`  [TASK] "${task.name}" chunk → regex-salvaged ${salvaged.length} match objects`);
        }
      }
      return Array.isArray(parsed) ? parsed : (parsed.matches || parsed.scores || []);
    };

    try {
      // Call AI once per chunk in parallel, merge all match arrays.
      // For most tasks (1 chunk), this is identical to a single call.
      // For tasks with 40+ candidates, multiple chunks run in parallel.
      const chunkResults = await Promise.all(candidateChunks.map(scoreOneChunk));
      const scores = chunkResults.flat();
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
        // Use same normalization as prefilter so behavior is consistent.
        const body = mode === "jobs" ? "" : (sig.articleContent || "");
        const haystack = normalizeForMatch(`${sig.headline} ${sig.description || ""} ${sig.jobTitle || ""} ${body}`);
        const kws = [...(task.keywords || []), ...(task.jobTitleKeywords || [])]
          .filter(k => k && k.length >= 2)
          .map(k => normalizeForMatch(k))
          .filter(k => k.length >= 2);
        if (kws.length > 0 && kws.some(kw => haystack.includes(kw))) {
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

  // Log summary with diagnostic info
  const matched = results.filter(s => s.matchedTaskIds.length > 0);
  const withBody = signals.filter(s => s.articleContent && s.articleContent.length > 50).length;
  const bodyPct = signals.length > 0 ? Math.round((withBody / signals.length) * 100) : 0;
  console.log(`  [SUMMARY] ${signals.length} signals (${withBody} with body, ${bodyPct}%) × ${taskDefs.length} tasks → ${matched.length} signals matched at threshold`);

  return results;
}

// ─── Route Handler ────────────────────────────────────────────────

export async function POST(request) {
  try {
    // SECURITY: Block from /client/[id] pages. Scans burn OpenAI tokens and
    // Apify credits — clients shouldn't trigger them on their own.
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) {
      console.warn(`[SECURITY] scan blocked from client referer: ${referer}`);
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }
    const body = await request.json();
    const { mode } = body;
    // campaignId comes from the frontend so the AI usage helper can attribute
    // OpenAI token costs to the right Campaign record for per-client billing.
    // Optional — if missing, tracking is skipped silently (no error).
    const campaignId = body.campaignId || null;
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
      const results = await scanJobsBatch(companies, taskDefs, threshold, campaignId);
      return NextResponse.json({ results, threshold });
    }

    // Single company mode (news)
    const { company, taskDefs } = body;
    if (!company?.name) return NextResponse.json({ error: "Company name required" }, { status: 400 });
    if (!taskDefs?.length) return NextResponse.json({ error: "Task definitions required" }, { status: 400 });

    console.log(`\n── Scanning: ${company.name} [${mode}] (threshold: ${threshold}) ──`);
    const { signals, fetchStats } = await scanNews(company, taskDefs, threshold, campaignId);

    return NextResponse.json({
      news: signals,
      company: company.name,
      mode,
      threshold,
      matchedCount: signals.filter(n => (n.matchedTaskIds || []).length > 0).length,
      fetchStats, // {succeeded, total, successRate, errors, secondPassRecovered}
    });
  } catch (error) {
    console.error("Scan error:", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
