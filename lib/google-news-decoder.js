/**
 * Google News URL Decoder — v2 (per-article fetch)
 *
 * Background:
 * -----------
 * Google News RSS returns URLs in the form:
 *   https://news.google.com/rss/articles/CBMi{base64-blob}?oc=5
 *
 * The base64 blob is a protobuf payload that USED to contain the publisher URL
 * directly (decodable with a simple base64 + substring scan). Around Aug 2024,
 * Google switched to an opaque blob — the real URL lives in their backend and
 * you have to ask their batchexecute RPC to resolve it.
 *
 * v1 (May 2026, deprecated):
 *   Fetched news.google.com homepage once per scan, scraped a session-level
 *   `SNlM0e` token, sent it as the `at` parameter to batchexecute.
 *   STOPPED WORKING because Google removed `SNlM0e` from the homepage HTML
 *   in early 2026. Diagnostic confirmed: hasToken=false for 100% of fetches.
 *
 * v2 (this file):
 *   For each article URL:
 *     Step 1: GET https://news.google.com/articles/{encodedPart}
 *             (fallback to /rss/articles/{encodedPart} if 4xx)
 *             Parse `data-n-a-sg` (signature) and `data-n-a-ts` (timestamp)
 *             from the page HTML.
 *     Step 2: POST https://news.google.com/_/DotsSplashUi/data/batchexecute
 *             with per-article signature, timestamp, and the encodedPart as
 *             gn_art_id. NO `at` URL parameter.
 *     Step 3: Parse the response — the publisher URL is at inner[1].
 *
 * Reference implementations:
 *   - https://github.com/SSujitX/google-news-url-decoder (Python, v0.1.7)
 *   - https://gist.github.com/huksley/bc3cb046157a99cd9d1517b32f91a99e
 *
 * Cost notes:
 *   Per URL: 2 HTTP calls to news.google.com (article page + batchexecute).
 *   For a 50-URL account, that's 100 calls. Be aware of rate limits — if
 *   429s start appearing, add a sleep between requests.
 *
 *   Failure mode is silent (returns null) — the scan route falls back to the
 *   legacy in-place redirector handling, which fails for new-format URLs but
 *   doesn't break the scan.
 */

const NEWS_BASE = "https://news.google.com";
const ARTICLE_PATH = "/articles";
const RSS_ARTICLE_PATH = "/rss/articles";
const BATCHEXECUTE_PATH = "/_/DotsSplashUi/data/batchexecute";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 10000;

// Cache decoded URLs by encodedPart to avoid redundant work within a scan.
const decodeCache = new Map();
const DECODE_CACHE_MAX = 500;

// Negative cache for URLs that hit 429. Prevents the scan route's second-pass
// retry from re-hammering Google with URLs we KNOW are rate-limited. Short TTL
// so a different scan run a few minutes later gets a fresh chance.
const negativeCache = new Map(); // encodedPart → expiresAt (ms)
const NEGATIVE_CACHE_MAX = 1000;
const NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function isInNegativeCache(encodedPart) {
  const expiresAt = negativeCache.get(encodedPart);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    negativeCache.delete(encodedPart);
    return false;
  }
  return true;
}

function addToNegativeCache(encodedPart) {
  if (negativeCache.size >= NEGATIVE_CACHE_MAX) {
    // Evict oldest 100 entries when cache is full
    const keys = Array.from(negativeCache.keys()).slice(0, 100);
    for (const k of keys) negativeCache.delete(k);
  }
  negativeCache.set(encodedPart, Date.now() + NEGATIVE_CACHE_TTL_MS);
}

// Sleep helper for backoff
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Global adaptive pacing ────────────────────────────────────
// A full-fleet scan fires ~9,000 decode HTTP calls at news.google.com in
// ~90 minutes. Without pacing, Google starts 429ing/serving paramless pages
// partway through and the BACK HALF of the fleet loses ~80% of decodes
// (measured 2026-06-10: first-half failure 7%, second-half 82%). Per-URL
// backoff alone can't fix that — the aggregate rate is the problem.
//
// All decode HTTP calls (article page + batchexecute) flow through paced(),
// which serializes them with a minimum interval. The interval doubles when
// Google pushes back (429) and decays on success, so a healthy run stays
// fast (~150ms) and a throttled run slows down instead of burning URLs.
let paceChain = Promise.resolve();
let paceLastCallAt = 0;
let paceIntervalMs = 150;
const PACE_MIN_MS = 150;
const PACE_MAX_MS = 2000;

function paced() {
  const p = paceChain.then(async () => {
    const wait = paceLastCallAt + paceIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    paceLastCallAt = Date.now();
  });
  paceChain = p.catch(() => {});
  return p;
}

function notePaceResult(got429) {
  paceIntervalMs = got429
    ? Math.min(PACE_MAX_MS, Math.round(paceIntervalMs * 2))
    : Math.max(PACE_MIN_MS, Math.round(paceIntervalMs * 0.92));
}

// ─── Failure tracking ──────────────────────────────────────────
// Decode failures are SILENT (return null → fall back to legacy redirector
// handling). To enable diagnosis, failure reasons are recorded here and the
// scan route reads + clears them after each account.
const _failures = new Map();
const _samples = new Map();
function recordFailure(reason, sample) {
  _failures.set(reason, (_failures.get(reason) || 0) + 1);
  if (sample && !_samples.has(reason)) {
    _samples.set(reason, String(sample).slice(0, 200));
  }
}
function drainFailureStats() {
  if (_failures.size === 0) return null;
  const stats = {};
  for (const [k, v] of _failures) {
    const sample = _samples.get(k);
    stats[k] = sample ? `${v}x [${sample}]` : `${v}x`;
  }
  _failures.clear();
  _samples.clear();
  return stats;
}

// ─── URL parsing ───────────────────────────────────────────────
function extractEncodedPart(googleNewsUrl) {
  try {
    const url = new URL(googleNewsUrl);
    if (!url.hostname.includes("news.google.com")) return null;
    // Paths in the wild: /articles/CBM..., /rss/articles/CBM..., /read/CBM...
    const m = url.pathname.match(/\/(?:articles|rss\/articles|read)\/([^/?]+)/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}

// ─── Step 1: fetch article page, parse signature + timestamp ───
async function fetchArticleParams(encodedPart) {
  // Try /articles/ first (the format Google's frontend uses), fallback to
  // /rss/articles/ (the format the RSS feed itself uses). They serve slightly
  // different HTML in some cases — the rss path is more cacheable.
  //
  // Each path attempt has up to 3 tries with exponential backoff if Google
  // returns 429. Backoff schedule: 0ms, 500ms, 1500ms.
  const BACKOFF_DELAYS_MS = [0, 500, 1500];

  for (const basePath of [ARTICLE_PATH, RSS_ARTICLE_PATH]) {
    const url = `${NEWS_BASE}${basePath}/${encodedPart}?hl=en-US&gl=US&ceid=US:en`;
    const pathKey = basePath === ARTICLE_PATH ? "art" : "rss";

    let resp;
    let attemptError;

    for (let attempt = 0; attempt < BACKOFF_DELAYS_MS.length; attempt++) {
      if (attempt > 0) await sleep(BACKOFF_DELAYS_MS[attempt]);
      await paced();
      try {
        resp = await fetch(url, {
          headers: {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (e) {
        attemptError = e;
        resp = null;
        break; // network errors don't benefit from retry
      }
      notePaceResult(resp.status === 429);

      // 429 → retry with backoff. Other errors → break out of retry loop.
      if (resp.status === 429 && attempt < BACKOFF_DELAYS_MS.length - 1) {
        continue;
      }
      break;
    }

    if (!resp) {
      recordFailure(`article_fetch_network_${pathKey}`, attemptError?.message);
      continue;
    }
    if (!resp.ok) {
      recordFailure(`article_fetch_http_${pathKey}_${resp.status}`);
      continue;
    }

    const html = await resp.text();

    // Extract the two attributes we need from the c-wiz element. We match on
    // the attributes directly rather than parsing the full DOM because:
    //   (a) no DOM parser available in Node without an extra dep
    //   (b) these attributes are distinctive — `data-n-a-sg` and `data-n-a-ts`
    //       don't appear elsewhere in the page in any version we've seen.
    const sigMatch = html.match(/data-n-a-sg="([^"]+)"/);
    const tsMatch = html.match(/data-n-a-ts="([^"]+)"/);

    if (sigMatch && tsMatch) {
      return {
        gn_art_id: encodedPart,
        signature: sigMatch[1],
        timestamp: tsMatch[1],
      };
    }

    // Capture diagnostic info. We try both paths, so record both kinds of
    // failure separately so the scan log shows which path the params were
    // missing from.
    if (basePath === ARTICLE_PATH) {
      recordFailure("article_params_not_found_art", `len=${html.length} hasSg=${html.includes("data-n-a-sg")} hasTs=${html.includes("data-n-a-ts")} hasCWiz=${html.includes("c-wiz")} hasGartner=${html.includes("garturl")}`);
    } else {
      recordFailure("article_params_not_found_rss", `len=${html.length} hasSg=${html.includes("data-n-a-sg")} hasTs=${html.includes("data-n-a-ts")}`);
    }
  }
  throw new Error("Could not extract article params (signature/timestamp) from either /articles/ or /rss/articles/");
}

// ─── Step 2: POST to batchexecute with per-article params ──────
async function decodeBatchexecute(params) {
  const { gn_art_id, signature, timestamp } = params;

  // The RPC payload Google expects. Note: timestamp is a number, gn_art_id and
  // signature are strings. The "garturlreq" wrapper and the array of zeros are
  // boilerplate that has stayed stable across versions of this RPC.
  const innerJson = `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${gn_art_id}",${timestamp},"${signature}"]`;
  const articleReq = ["Fbv4je", innerJson];
  const fReq = JSON.stringify([[articleReq]]);
  const body = `f.req=${encodeURIComponent(fReq)}`;

  // Random _reqid is just a per-request token; Google doesn't validate it
  // strictly but it expects something present in this form.
  const reqid = 100000 + Math.floor(Math.random() * 900000);
  const url = `${NEWS_BASE}${BATCHEXECUTE_PATH}?rpcids=Fbv4je&source-path=%2Fread&f.sid=-1&hl=en-US&gl=US&_reqid=${reqid}&rt=c`;

  // Same backoff pattern as fetchArticleParams. Batchexecute is the more
  // commonly rate-limited endpoint.
  const BACKOFF_DELAYS_MS = [0, 500, 1500];
  let resp;
  let attemptError;

  for (let attempt = 0; attempt < BACKOFF_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_DELAYS_MS[attempt]);
    await paced();
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          "User-Agent": UA,
        },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      attemptError = e;
      resp = null;
      break;
    }
    notePaceResult(resp.status === 429);

    if (resp.status === 429 && attempt < BACKOFF_DELAYS_MS.length - 1) {
      continue;
    }
    break;
  }

  if (!resp) {
    recordFailure("batchexec_network", attemptError?.message);
    throw attemptError || new Error("batchexecute network error");
  }

  if (!resp.ok) {
    let errSample = "";
    try { errSample = (await resp.text()).slice(0, 200); } catch (_) {}
    recordFailure(`batchexec_http_${resp.status}`, errSample);
    throw new Error(`batchexecute HTTP ${resp.status}`);
  }

  const text = await resp.text();
  // Strip the )]}'  anti-JSON-hijacking prefix
  const stripped = text.replace(/^\)\]\}'\n?/, "");

  // Response is newline-delimited JSON chunks. Find the one containing the
  // Fbv4je RPC result.
  let parsed;
  for (const chunk of stripped.split("\n").filter(Boolean)) {
    try {
      const candidate = JSON.parse(chunk);
      if (Array.isArray(candidate) && Array.isArray(candidate[0]) && candidate[0][1] === "Fbv4je") {
        parsed = candidate;
        break;
      }
    } catch (_) { /* try next chunk */ }
  }

  if (!parsed) {
    recordFailure("batchexec_parse_no_fbv4je", stripped.slice(0, 200));
    throw new Error("Could not find Fbv4je RPC in batchexecute response");
  }

  // parsed[0][2] is a JSON-encoded string. Decode it.
  let inner;
  try {
    inner = JSON.parse(parsed[0][2]);
  } catch (e) {
    recordFailure("batchexec_inner_parse_failed", String(parsed[0][2]).slice(0, 100));
    throw e;
  }

  // inner shape: ["garturlres", "https://publisher.com/...", 1, 1, null, null, 1]
  const publisherUrl = inner && inner[1];
  if (!publisherUrl || typeof publisherUrl !== "string" || !publisherUrl.startsWith("http")) {
    recordFailure("batchexec_no_publisher_url", JSON.stringify(inner).slice(0, 150));
    throw new Error("No publisher URL in batchexecute response");
  }

  return publisherUrl;
}

// ─── Main entry point ──────────────────────────────────────────
async function decodeGoogleNewsUrl(googleNewsUrl) {
  const encodedPart = extractEncodedPart(googleNewsUrl);
  if (!encodedPart) return null;

  // Positive cache hit
  if (decodeCache.has(encodedPart)) {
    return decodeCache.get(encodedPart);
  }

  // Negative cache hit — URL was recently 429'd. Skip without hitting Google.
  // This prevents the scan route's second-pass retry from amplifying rate-limit
  // pressure by re-attempting URLs we already know are throttled.
  if (isInNegativeCache(encodedPart)) {
    recordFailure("negative_cache_skip");
    return null;
  }

  // Eviction (FIFO is fine for our purposes — we don't have hot/cold URLs)
  if (decodeCache.size >= DECODE_CACHE_MAX) {
    const firstKey = decodeCache.keys().next().value;
    decodeCache.delete(firstKey);
  }

  try {
    const params = await fetchArticleParams(encodedPart);
    const publisherUrl = await decodeBatchexecute(params);
    decodeCache.set(encodedPart, publisherUrl);
    return publisherUrl;
  } catch (e) {
    // If the failure mentions 429, add to negative cache so retries skip it.
    // Other failures (params not found, parse errors) are NOT cached — they
    // might be fixable by a code change or transient issues.
    const msg = String(e?.message || "");
    if (msg.includes("429") || msg.includes("HTTP 429")) {
      addToNegativeCache(encodedPart);
    }
    // Silent failure. Scan route falls back to legacy redirector handling.
    // Specific failure reason is recorded via recordFailure() above and
    // surfaced through drainFailureStats() per account.
    return null;
  }
}

module.exports = { decodeGoogleNewsUrl, extractEncodedPart, drainFailureStats };
