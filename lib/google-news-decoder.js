/**
 * Google News URL Decoder
 *
 * Google News RSS returns URLs in the form:
 *   https://news.google.com/rss/articles/CBMir{base64-encoded-blob}?oc=5
 *
 * The {base64} portion is a protobuf-encoded payload containing the real
 * publisher URL. Two formats exist in the wild:
 *
 *   OLD format (pre-2024): simple base64 decode of the protobuf bytes reveals
 *   the URL as a printable substring inside the bytes. ~30% of current feeds.
 *
 *   NEW format (mid-2024+): the base64 is opaque and requires a round trip
 *   through Google's internal batchexecute RPC to resolve. Needs a session
 *   signature scraped from news.google.com first.
 *
 * Strategy: try the cheap path first, fall back to batchexecute.
 *
 * Background: prior to this decoder, SignalScope tried to follow Google News
 * URLs via HTTP redirect — but Google serves a client-side JS page that does
 * the redirect in-browser, so server-side fetch never sees the publisher URL.
 * Body-fetch success rate was 0% which dropped all rules except headline-only
 * ones (Earnings Season vacuum) — and even those scored 0 matches because the
 * V4 prompt requires marketing-entity quotes from article body.
 */

const NEWS_HOME = "https://news.google.com";
const BATCHEXECUTE = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// Cache the signature for 30 min — fetching news.google.com to extract it
// costs ~500ms and a successful signature works for many minutes.
let cachedSig = null;
let cachedSigAt = 0;
const SIG_CACHE_MS = 30 * 60 * 1000;

// Process-wide cache of decoded URLs to avoid redundant work within a scan.
const decodeCache = new Map();
const DECODE_CACHE_MAX = 500;

// ─── Failure tracking ──────────────────────────────────────────
// Decode failures are SILENT by design (fall through to legacy redirector
// handling so a broken decoder can't break the scan). But silent failures
// also make diagnosis impossible. This collects failure reasons during a
// scan so the scan route can log aggregated stats per account.
//
// Usage:
//   recordFailure('sig_fetch_404');
//   const stats = drainFailureStats();  // returns + clears
const _failures = new Map();
const _samples = new Map();  // first sample of each failure type for inspection
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

/**
 * Extract the encoded blob from a Google News URL.
 * @param {string} url
 * @returns {string|null}
 */
function extractEncodedPart(url) {
  if (!url || typeof url !== "string") return null;
  const m = url.match(/news\.google\.com\/(?:rss\/)?articles\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * Attempt simple base64 decode + look for an http(s) URL inside the bytes.
 * Works for the OLD format URLs (pre-2024). Returns null otherwise.
 *
 * Heuristic: protobuf encodes the URL as a length-prefixed string, so we
 * scan for "http" or "https" in the decoded bytes and read until a
 * non-printable terminator.
 */
function tryDecodeSimple(encodedPart) {
  try {
    const padded = encodedPart.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((encodedPart.length + 3) % 4);
    const bytes = Buffer.from(padded, "base64");
    // Scan for http:// or https://
    for (let i = 0; i < bytes.length - 4; i++) {
      // 'h' 't' 't' 'p' = 0x68 0x74 0x74 0x70
      if (bytes[i] === 0x68 && bytes[i+1] === 0x74 && bytes[i+2] === 0x74 && bytes[i+3] === 0x70) {
        // Found 'http'. Extract until first non-printable byte.
        let end = i;
        while (end < bytes.length && bytes[end] >= 0x20 && bytes[end] < 0x7F) end++;
        const candidate = bytes.slice(i, end).toString("utf8");
        // Sanity check: must start with http:// or https://
        if (/^https?:\/\/[^\s]+/.test(candidate)) {
          return candidate;
        }
      }
    }
  } catch (_) { /* fall through */ }
  return null;
}

/**
 * Fetch news.google.com homepage and extract the WIZ_global_data SNlM0e token,
 * which is the session signature needed for batchexecute requests.
 */
async function getSignature() {
  const now = Date.now();
  if (cachedSig && (now - cachedSigAt) < SIG_CACHE_MS) {
    return cachedSig;
  }
  let resp;
  try {
    resp = await fetch(NEWS_HOME, {
      headers: { "User-Agent": UA, "Accept": "text/html" },
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    recordFailure("sig_fetch_network", e.message);
    throw e;
  }
  if (!resp.ok) {
    recordFailure(`sig_fetch_http_${resp.status}`);
    throw new Error(`news.google.com HTTP ${resp.status}`);
  }
  const html = await resp.text();
  const m = html.match(/"SNlM0e":"([^"]+)"/);
  if (!m) {
    // Capture diagnostic info: is the token missing entirely? renamed?
    // Server-rendered vs client-rendered page? Body might be a captcha or
    // a different HTML structure than we expect.
    const hasToken = html.includes("SNlM0e");
    const hasWiz = html.includes("WIZ_global_data");
    const hasCaptcha = /captcha|recaptcha|unusual traffic/i.test(html);
    const altMatch = hasToken ? html.match(/SNlM0e[^,}\n]{0,80}/) : null;
    const sample = `len=${html.length} hasToken=${hasToken} hasWiz=${hasWiz} captcha=${hasCaptcha} alt=${altMatch?.[0]?.slice(0, 60) || "none"}`;
    recordFailure("sig_token_not_found", sample);
    throw new Error("Could not extract SNlM0e signature from news.google.com");
  }
  cachedSig = m[1];
  cachedSigAt = now;
  return cachedSig;
}

/**
 * Decode a NEW-format Google News URL via the batchexecute RPC.
 * Returns the publisher URL or throws.
 */
async function decodeBatchexecute(encodedPart) {
  const at = await getSignature();
  const ts = Math.floor(Date.now() / 1000);

  // The RPC payload is a heavily-nested JSON structure. The inner array is
  // the request to the "Fbv4je" RPC which resolves a Google News article ID
  // to its publisher URL. Format reverse-engineered from public libraries
  // (googlenewsdecoder npm, google-news-url-decoder pypi).
  const innerReq = JSON.stringify([
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0
    ],
    encodedPart,
    ts,
    "0"
  ]);
  const fReq = JSON.stringify([[["Fbv4je", innerReq, null, "generic"]]]);

  const body = new URLSearchParams({ "f.req": fReq, "at": at }).toString();
  const url = `${BATCHEXECUTE}?rpcids=Fbv4je&source-path=%2F&f.sid=-1&bl=boq_dotssplashserver_20240101.00_p0&hl=en&soc-app=139&soc-platform=1&soc-device=1&_reqid=0&rt=c`;

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": UA,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    recordFailure("batchexec_network", e.message);
    throw e;
  }
  if (!resp.ok) {
    // Read first 200 chars of error response to give us a clue
    let errSample = "";
    try { errSample = (await resp.text()).slice(0, 200); } catch (_) {}
    recordFailure(`batchexec_http_${resp.status}`, errSample);
    throw new Error(`batchexecute HTTP ${resp.status}`);
  }
  const text = await resp.text();

  // Response is prefixed with )]}'\n to defeat JSON hijacking. Strip it.
  const stripped = text.replace(/^\)\]\}'\n?/, "");
  // The response is a stream of JSON arrays; we want the first one with our RPC.
  // Format is roughly: [["wrb.fr","Fbv4je","[<inner-json-string>]",...]],["di",N],["af.httprm",...]
  let parsed;
  try {
    // Find the first newline-delimited chunk that parses
    const chunks = stripped.split("\n").filter(Boolean);
    for (const chunk of chunks) {
      try {
        const candidate = JSON.parse(chunk);
        if (Array.isArray(candidate) && Array.isArray(candidate[0]) && candidate[0][1] === "Fbv4je") {
          parsed = candidate;
          break;
        }
      } catch (_) { /* try next */ }
    }
  } catch (_) { /* fall through */ }
  if (!parsed) {
    // First 200 chars of stripped response to see the shape
    recordFailure("batchexec_parse_no_fbv4je", stripped.slice(0, 200));
    throw new Error("Could not parse batchexecute response");
  }

  // parsed[0][2] is a JSON-encoded string containing the URL at index 1
  let inner;
  try {
    inner = JSON.parse(parsed[0][2]);
  } catch (e) {
    recordFailure("batchexec_inner_parse", String(parsed[0][2]).slice(0, 100));
    throw e;
  }
  const publisherUrl = inner && inner[1];
  if (!publisherUrl || typeof publisherUrl !== "string") {
    recordFailure("batchexec_no_url_in_response", JSON.stringify(inner).slice(0, 150));
    throw new Error("No publisher URL in batchexecute response");
  }
  return publisherUrl;
}

/**
 * Main entry point. Decode a Google News URL to its publisher URL.
 * Returns null if not a Google News URL or if decoding fails.
 *
 * @param {string} url
 * @returns {Promise<string|null>}
 */
async function decodeGoogleNewsUrl(url) {
  const encodedPart = extractEncodedPart(url);
  if (!encodedPart) return null;

  // Cache hit?
  if (decodeCache.has(encodedPart)) {
    return decodeCache.get(encodedPart);
  }

  // Try cheap path
  let decoded = tryDecodeSimple(encodedPart);

  // Fall back to batchexecute
  if (!decoded) {
    try {
      decoded = await decodeBatchexecute(encodedPart);
    } catch (e) {
      // If batchexecute fails (e.g. signature expired, rate limit), invalidate
      // signature cache so next call retries fresh.
      cachedSig = null;
      decoded = null;
    }
  }

  // Cache result (including nulls — repeated misses are noise)
  if (decodeCache.size >= DECODE_CACHE_MAX) {
    const firstKey = decodeCache.keys().next().value;
    decodeCache.delete(firstKey);
  }
  decodeCache.set(encodedPart, decoded);

  return decoded;
}

module.exports = { decodeGoogleNewsUrl, extractEncodedPart, drainFailureStats };
