// ─── LinkedIn Profile Fetch via RapidAPI ────────────────────────────
// Wraps "Fresh LinkedIn Profile Data" API. Returns a normalized profile
// shape regardless of upstream changes, so callers don't break when the
// provider tweaks their response format.
//
// USAGE:
//   import { fetchLinkedInProfile } from "@/lib/linkedin-fetch";
//   const result = await fetchLinkedInProfile("https://linkedin.com/in/foo/");
//   if (result.ok) { /* result.profile */ } else { /* result.error */ }
//
// Returns { ok, profile, error, statusCode }
// profile shape:
//   {
//     fullName: string,
//     headline: string,
//     experiences: [
//       { company, title, startedAt (ISO date), endedAt (ISO date | null), isCurrent: bool }
//     ]
//   }

const RAPIDAPI_HOST = "fresh-linkedin-profile-data.p.rapidapi.com";
const PROFILE_ENDPOINT = `https://${RAPIDAPI_HOST}/get-linkedin-profile`;
const REQUEST_TIMEOUT_MS = 15000;
const BACKOFF_DELAYS_MS = [0, 1000, 3000]; // up to 3 attempts with growing delays

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Defensive parsing — Fresh LinkedIn API has been known to vary the shape
// (sometimes "experiences", sometimes "positions"; sometimes "company_name",
// sometimes "companyName"). Normalize everything here.
function normalizeProfile(raw) {
  if (!raw || typeof raw !== "object") return null;

  // Top-level: API typically wraps in { data: {...} }
  const d = raw.data || raw;

  const fullName = d.full_name || d.fullName || `${d.first_name || ""} ${d.last_name || ""}`.trim() || "";
  const headline = d.headline || d.title || "";

  // Experiences array
  const expRaw = d.experiences || d.experience || d.positions || [];
  const experiences = expRaw.map((e) => {
    const company = e.company || e.company_name || e.companyName || "";
    const title = e.title || e.position || e.job_title || "";
    // Date fields vary across versions
    const startedAt =
      e.starts_at || e.start_date || e.startDate || e.start ||
      buildIsoDate(e.starts_at_year, e.starts_at_month);
    const endedAt =
      e.ends_at || e.end_date || e.endDate || e.end ||
      buildIsoDate(e.ends_at_year, e.ends_at_month);

    const isCurrent = !endedAt || endedAt === "" || endedAt === null;

    return {
      company: String(company || "").trim(),
      title: String(title || "").trim(),
      startedAt: normalizeDate(startedAt),
      endedAt: endedAt ? normalizeDate(endedAt) : null,
      isCurrent,
    };
  }).filter(e => e.company || e.title); // drop completely empty entries

  // Sort so current/most-recent is first
  experiences.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (!a.isCurrent && b.isCurrent) return 1;
    return (b.startedAt || "").localeCompare(a.startedAt || "");
  });

  return {
    fullName,
    headline,
    experiences,
  };
}

// Build ISO date from year/month fields when API returns separate components
function buildIsoDate(year, month) {
  if (!year) return null;
  const y = String(year).padStart(4, "0");
  const m = month ? String(month).padStart(2, "0") : "01";
  return `${y}-${m}-01`;
}

// Coerce various date string formats to ISO YYYY-MM-DD
function normalizeDate(value) {
  if (!value) return null;
  if (typeof value === "object") {
    // Some APIs return { year, month } object
    if (value.year) return buildIsoDate(value.year, value.month);
    return null;
  }
  const s = String(value);
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Year only?
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;
  // YYYY-MM
  if (/^\d{4}-\d{2}$/.test(s)) return `${s}-01`;
  // Try Date parsing as last resort
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

// Compute days between an ISO date and today
export function daysSince(isoDate) {
  if (!isoDate) return null;
  const start = new Date(isoDate);
  if (isNaN(start.getTime())) return null;
  const now = new Date();
  const ms = now.getTime() - start.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

// ─── Main fetch function ───────────────────────────────────────────
// Returns { ok, profile, error, statusCode }
// `error` codes: "no_url", "missing_key", "http_404", "http_429", "http_5xx",
//                "network", "parse_error", "no_profile_data"
let _diagnosticLogsRemaining = 3; // first 3 calls per cold start get verbose logs

export async function fetchLinkedInProfile(linkedinUrl) {
  if (!linkedinUrl) {
    return { ok: false, error: "no_url", statusCode: 0 };
  }
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    console.error("[linkedin-fetch] RAPIDAPI_KEY env var is not set — all calls will fail with missing_key");
    return { ok: false, error: "missing_key", statusCode: 0 };
  }

  const wantDiagLog = _diagnosticLogsRemaining > 0;
  if (wantDiagLog) _diagnosticLogsRemaining--;

  // Build request URL
  const url = `${PROFILE_ENDPOINT}?linkedin_url=${encodeURIComponent(linkedinUrl)}&include_skills=false&include_certifications=false&include_publications=false&include_honors=false&include_volunteers=false&include_projects=false&include_patents=false&include_courses=false&include_organizations=false&include_profile_status=false&include_company_public_url=false`;

  if (wantDiagLog) {
    console.log(`[linkedin-fetch] DIAG: GET ${url.slice(0, 200)}${url.length > 200 ? "…" : ""}`);
    console.log(`[linkedin-fetch] DIAG: key present (length=${apiKey.length}, prefix=${apiKey.slice(0, 6)}…)`);
  }

  let resp;
  let lastError;

  for (let attempt = 0; attempt < BACKOFF_DELAYS_MS.length; attempt++) {
    if (attempt > 0) await sleep(BACKOFF_DELAYS_MS[attempt]);
    try {
      resp = await fetch(url, {
        method: "GET",
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": RAPIDAPI_HOST,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (e) {
      lastError = e.message;
      resp = null;
      break; // network errors don't benefit from retry without backoff
    }

    if (resp.status === 429 && attempt < BACKOFF_DELAYS_MS.length - 1) {
      continue;
    }
    if (resp.status >= 500 && resp.status < 600 && attempt < BACKOFF_DELAYS_MS.length - 1) {
      continue;
    }
    break;
  }

  if (!resp) {
    if (wantDiagLog) console.warn(`[linkedin-fetch] DIAG: network error — ${lastError}`);
    return { ok: false, error: "network", statusCode: 0, message: lastError };
  }

  if (wantDiagLog) {
    console.log(`[linkedin-fetch] DIAG: HTTP ${resp.status} ${resp.statusText}`);
  }

  if (resp.status === 404) {
    if (wantDiagLog) {
      const body = await resp.text().catch(() => "(could not read body)");
      console.warn(`[linkedin-fetch] DIAG: 404 body (first 500 chars): ${body.slice(0, 500)}`);
    }
    return { ok: false, error: "http_404", statusCode: 404 };
  }
  if (resp.status === 429) {
    if (wantDiagLog) {
      const body = await resp.text().catch(() => "");
      console.warn(`[linkedin-fetch] DIAG: 429 body (first 500 chars): ${body.slice(0, 500)}`);
    }
    return { ok: false, error: "http_429", statusCode: 429 };
  }
  if (resp.status >= 500) {
    return { ok: false, error: "http_5xx", statusCode: resp.status };
  }
  if (!resp.ok) {
    if (wantDiagLog) {
      const body = await resp.text().catch(() => "");
      console.warn(`[linkedin-fetch] DIAG: HTTP ${resp.status} body (first 500 chars): ${body.slice(0, 500)}`);
    }
    return { ok: false, error: `http_${resp.status}`, statusCode: resp.status };
  }

  let payload;
  let rawText;
  try {
    rawText = await resp.text();
    if (wantDiagLog) {
      console.log(`[linkedin-fetch] DIAG: response length ${rawText.length} chars, first 800: ${rawText.slice(0, 800)}`);
    }
    payload = JSON.parse(rawText);
  } catch (e) {
    if (wantDiagLog) console.warn(`[linkedin-fetch] DIAG: parse_error — ${e.message}, raw: ${(rawText || "").slice(0, 200)}`);
    return { ok: false, error: "parse_error", statusCode: resp.status, message: e.message };
  }

  if (wantDiagLog) {
    console.log(`[linkedin-fetch] DIAG: parsed JSON keys: ${Object.keys(payload || {}).join(", ")}`);
    if (payload?.data) {
      console.log(`[linkedin-fetch] DIAG: data keys: ${Object.keys(payload.data).join(", ")}`);
    }
  }

  const profile = normalizeProfile(payload);
  if (!profile || !profile.experiences || profile.experiences.length === 0) {
    if (wantDiagLog) {
      console.warn(`[linkedin-fetch] DIAG: no_profile_data — profile=${JSON.stringify(profile)?.slice(0, 200)}, raw payload sample: ${JSON.stringify(payload)?.slice(0, 500)}`);
    }
    return { ok: false, error: "no_profile_data", statusCode: resp.status };
  }

  if (wantDiagLog) {
    console.log(`[linkedin-fetch] DIAG: SUCCESS — ${profile.experiences.length} experiences extracted; current: ${profile.experiences[0]?.company} / ${profile.experiences[0]?.title} / startedAt=${profile.experiences[0]?.startedAt}`);
  }

  return { ok: true, profile, statusCode: resp.status };
}
