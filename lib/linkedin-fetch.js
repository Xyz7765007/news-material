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
export async function fetchLinkedInProfile(linkedinUrl) {
  if (!linkedinUrl) {
    return { ok: false, error: "no_url", statusCode: 0 };
  }
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return { ok: false, error: "missing_key", statusCode: 0 };
  }

  // Build request URL
  const url = `${PROFILE_ENDPOINT}?linkedin_url=${encodeURIComponent(linkedinUrl)}&include_skills=false&include_certifications=false&include_publications=false&include_honors=false&include_volunteers=false&include_projects=false&include_patents=false&include_courses=false&include_organizations=false&include_profile_status=false&include_company_public_url=false`;

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
    return { ok: false, error: "network", statusCode: 0, message: lastError };
  }

  if (resp.status === 404) {
    return { ok: false, error: "http_404", statusCode: 404 };
  }
  if (resp.status === 429) {
    return { ok: false, error: "http_429", statusCode: 429 };
  }
  if (resp.status >= 500) {
    return { ok: false, error: "http_5xx", statusCode: resp.status };
  }
  if (!resp.ok) {
    return { ok: false, error: `http_${resp.status}`, statusCode: resp.status };
  }

  let payload;
  try {
    payload = await resp.json();
  } catch (e) {
    return { ok: false, error: "parse_error", statusCode: resp.status, message: e.message };
  }

  const profile = normalizeProfile(payload);
  if (!profile || !profile.experiences || profile.experiences.length === 0) {
    return { ok: false, error: "no_profile_data", statusCode: resp.status };
  }

  return { ok: true, profile, statusCode: resp.status };
}
