// ─── Lead Movement Endpoint Discovery Probe ─────────────────────────
// One-shot diagnostic to find the CURRENT working endpoint path for
// Fresh LinkedIn Profile Data — RapidAPI renamed it and the old
// /get-linkedin-profile now returns 404.
//
// USAGE:
//   GET /api/scan-leads-probe?url=https://www.linkedin.com/in/some-username
//
// Returns a summary of which candidate endpoints returned 200 (and a
// snippet of their response) so we can pick the right one to use.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Candidate paths to try — most likely current endpoint names for the
// "fresh-linkedin-profile-data" host. The probe sends a GET to each with
// the linkedin_url query param. Common parameter name variants are tried
// when the first attempt returns 4xx.
const RAPIDAPI_HOST = "fresh-linkedin-profile-data.p.rapidapi.com";
const PATH_CANDIDATES = [
  // Old name (will probably 404, included as baseline)
  { path: "/get-linkedin-profile", param: "linkedin_url" },
  // Common new variants
  { path: "/get-linkedin-profile-by-salesnaviurl", param: "linkedin_url" },
  { path: "/get-linkedin-profile-by-salesnavurl", param: "linkedin_url" },
  { path: "/get-profile-data", param: "linkedin_url" },
  { path: "/get-profile", param: "linkedin_url" },
  { path: "/profile-data", param: "linkedin_url" },
  { path: "/profile", param: "linkedin_url" },
  { path: "/v1/profile", param: "linkedin_url" },
  { path: "/v1/get-profile", param: "linkedin_url" },
  { path: "/get-linkedin-data", param: "linkedin_url" },
  { path: "/api/v1/profile", param: "linkedin_url" },
  // Param-name variants (some APIs renamed to "url" or "profile_url")
  { path: "/get-profile", param: "url" },
  { path: "/get-profile", param: "profile_url" },
];

export async function GET(req) {
  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return NextResponse.json({ ok: false, error: "RAPIDAPI_KEY not configured" }, { status: 500 });
  }

  const { searchParams } = new URL(req.url);
  const linkedinUrl = searchParams.get("url") || "https://www.linkedin.com/in/williamhgates/";

  const results = [];
  for (const candidate of PATH_CANDIDATES) {
    const target = `https://${RAPIDAPI_HOST}${candidate.path}?${candidate.param}=${encodeURIComponent(linkedinUrl)}`;
    let summary = {
      path: candidate.path,
      param: candidate.param,
      status: null,
      ok: false,
      bodySnippet: "",
      hasExperiences: false,
      hasDataKey: false,
      hasMessageKey: false,
      topLevelKeys: [],
    };
    try {
      const res = await fetch(target, {
        method: "GET",
        headers: {
          "x-rapidapi-key": apiKey,
          "x-rapidapi-host": RAPIDAPI_HOST,
        },
        signal: AbortSignal.timeout(10000),
      });
      summary.status = res.status;
      summary.ok = res.ok;
      const text = await res.text();
      summary.bodySnippet = text.slice(0, 300);
      try {
        const json = JSON.parse(text);
        summary.topLevelKeys = Object.keys(json || {});
        summary.hasDataKey = Object.prototype.hasOwnProperty.call(json, "data");
        summary.hasMessageKey = Object.prototype.hasOwnProperty.call(json, "message");
        const dataOrRoot = json?.data || json;
        summary.hasExperiences = !!(dataOrRoot?.experiences || dataOrRoot?.positions || dataOrRoot?.experience);
      } catch {
        // Body is not JSON — leave parsed flags as defaults
      }
    } catch (e) {
      summary.error = e.message;
    }
    results.push(summary);

    // If we found a working endpoint with profile data, no need to keep
    // probing — we'd just burn quota. Return early with the working one.
    if (summary.ok && summary.hasExperiences) {
      return NextResponse.json({
        ok: true,
        recommended: candidate,
        winningResult: summary,
        triedSoFar: results,
        message: `✅ Found working endpoint: ${candidate.path} with param "${candidate.param}". Update PROFILE_ENDPOINT and param name in lib/linkedin-fetch.js to use this.`,
      });
    }

    // Brief delay between probes to avoid rate-limit cascading
    await new Promise(r => setTimeout(r, 400));
  }

  return NextResponse.json({
    ok: false,
    recommended: null,
    message: "No candidate endpoint returned profile data with experiences. Inspect the bodies of any 200-status results to manually identify the right one.",
    triedSoFar: results,
  });
}
