import { NextResponse } from "next/server";

// ═════════════════════════════════════════════════════════════════════════
// /api/debug/article-fetch — diagnose why article body fetch is failing
//
// Why: scan logs showed "article body fetch 0/30 (0%) — errors: thin_body:30"
// for Raising Canes. That means the fetcher reached every URL but extracted
// <50 chars of cleaned text. Likely causes: (1) Google News redirector
// patterns the regex list doesn't cover, (2) JS-rendered articles (empty
// static HTML), (3) paywall/bot-detection landing pages.
//
// What it does: replicates fetchArticle() from scan/route.js but exposes
// every intermediate state — which redirect pattern matched, raw HTML
// length, what the article/<p> extraction produced, what cleaned text
// looks like.
//
// How to use:
//   POST /api/debug/article-fetch
//   Body: { url: "<google news rss link or direct article url>" }
//
// Returns the same { content, error } the production fetcher would, plus
// a full diagnostics array showing what happened at each attempt.
// ═════════════════════════════════════════════════════════════════════════

export const maxDuration = 60;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export async function POST(request) {
  try {
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) {
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }

    const body = await request.json();
    const url = body.url;
    if (!url || typeof url !== "string" || url.length < 10) {
      return NextResponse.json({ error: "Provide { url: '<https://...>' }" }, { status: 400 });
    }

    const diag = [];
    let currentUrl = url;
    let followedRedirect = false;
    const maxAttempts = 3;

    diag.push({ stage: "init", inputUrl: url });

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const attemptDiag = { stage: `attempt_${attempt}`, fetchUrl: currentUrl, ua: USER_AGENTS[attempt % USER_AGENTS.length].slice(0, 60) + "..." };

      if (attempt > 0) {
        const base = attempt === 1 ? 1500 : 4000;
        await sleep(base);
      }

      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 7000);
        const r = await fetch(currentUrl, {
          headers: {
            "User-Agent": USER_AGENTS[attempt % USER_AGENTS.length],
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "Cache-Control": "no-cache",
          },
          signal: c.signal,
          redirect: "follow",
        });
        clearTimeout(t);

        attemptDiag.status = r.status;
        attemptDiag.finalUrl = r.url;
        attemptDiag.contentType = r.headers.get("content-type");

        if (!r.ok) {
          attemptDiag.outcome = `http_${r.status}`;
          diag.push(attemptDiag);
          if ((r.status === 429 || r.status >= 500) && attempt < maxAttempts - 1) continue;
          return NextResponse.json({
            verdict: `FAIL: HTTP ${r.status} from ${currentUrl}`,
            content: "",
            error: `http_${r.status}`,
            diagnostics: diag,
          });
        }

        const html = await r.text();
        attemptDiag.htmlLength = html.length;
        attemptDiag.htmlPreview = html.slice(0, 300).replace(/\s+/g, " ");

        // Redirect detection (only if not yet followed AND html is small enough to be a redirector)
        if (!followedRedirect && html.length < 8000) {
          const patterns = {
            metaRefresh: html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*?url=([^"'\s>]+)/i),
            jsLocation: html.match(/(?:window\.location|location\.href|location\.replace)\s*=?\s*\(?\s*["']([^"']+)["']/i),
            dataNAu: html.match(/data-n-au=["']([^"']+)["']/),
            canonical: html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i),
            // Additional patterns to try (not yet in production):
            anchorWithDataPing: html.match(/<a[^>]+data-ping=["']([^"']+)["']/i),
            anchorWithRedirectClass: html.match(/<a[^>]+class=["'][^"']*(?:VDXfz|JtKRv|DY5T1d)[^"']*["'][^>]+href=["']([^"']+)["']/i),
            firstExternalLink: html.match(/<a[^>]+href=["'](https?:\/\/(?!news\.google\.com|accounts\.google\.com|policies\.google\.com|support\.google\.com)[^"']+)["']/i),
          };

          attemptDiag.redirectPatternsMatched = Object.fromEntries(
            Object.entries(patterns).map(([k, v]) => [k, v?.[1] ? v[1].slice(0, 200) : null])
          );

          // Use the same logic as production
          const redirectUrl = (patterns.metaRefresh?.[1] || patterns.jsLocation?.[1] || patterns.dataNAu?.[1] || patterns.canonical?.[1] || "").replace(/&amp;/g, "&");

          if (redirectUrl && /^https?:\/\//i.test(redirectUrl) && !redirectUrl.includes("news.google.com") && redirectUrl !== currentUrl) {
            attemptDiag.outcome = `redirect_followed: ${redirectUrl.slice(0, 120)}`;
            diag.push(attemptDiag);
            currentUrl = redirectUrl;
            followedRedirect = true;
            continue;
          }

          // Production patterns didn't match — note potential alternative
          if (patterns.firstExternalLink?.[1]) {
            attemptDiag.note = `Production patterns FAILED. Could try firstExternalLink: ${patterns.firstExternalLink[1].slice(0, 120)}`;
          }
        }

        // Extraction (same logic as production)
        const art = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
        const pTags = (html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || []);
        attemptDiag.hasArticleTag = !!art;
        attemptDiag.pTagCount = pTags.length;

        let text = art ? art[1] : pTags.join(" ");
        attemptDiag.extractedRawLength = text.length;

        const cleaned = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&[a-z]+;/gi, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 800);

        attemptDiag.cleanedLength = cleaned.length;
        attemptDiag.cleanedPreview = cleaned.slice(0, 300);

        if (cleaned.length < 50) {
          attemptDiag.outcome = "thin_body";
          diag.push(attemptDiag);
          return NextResponse.json({
            verdict: `FAIL at extraction: HTML was ${html.length} chars, but <article> + <p> extraction produced only ${cleaned.length} chars after cleaning. Likely a JS-rendered page (article content is in React state, not static HTML), a paywall landing, or a bot-detection page. Check htmlPreview in diagnostics.`,
            content: cleaned,
            error: "thin_body",
            diagnostics: diag,
          });
        }

        attemptDiag.outcome = "success";
        diag.push(attemptDiag);
        return NextResponse.json({
          verdict: `OK: extracted ${cleaned.length} chars after ${followedRedirect ? "1 redirect + " : ""}${attempt + 1} attempt(s).`,
          content: cleaned,
          error: null,
          diagnostics: diag,
        });
      } catch (e) {
        attemptDiag.outcome = e.name === "AbortError" ? "timeout" : "fetch_error";
        attemptDiag.exception = e.message;
        diag.push(attemptDiag);
        if ((attemptDiag.outcome === "timeout" || attemptDiag.outcome === "fetch_error") && attempt < maxAttempts - 1) continue;
        return NextResponse.json({
          verdict: `FAIL: ${attemptDiag.outcome} on attempt ${attempt + 1}`,
          content: "",
          error: attemptDiag.outcome,
          diagnostics: diag,
        });
      }
    }

    return NextResponse.json({
      verdict: "FAIL: exhausted all attempts",
      content: "",
      error: "exhausted",
      diagnostics: diag,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}
