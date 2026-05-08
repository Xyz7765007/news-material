import { NextResponse } from "next/server";

// ═════════════════════════════════════════════════════════════════════════
// /api/debug/jobs — verbose diagnostic endpoint for jobs scan failures
//
// Why: the production jobs flow has 3 retry layers and good console.log
// instrumentation, but you can only see those logs in Vercel runtime logs
// after the fact. When jobs return 0 across a whole week, you need to
// diagnose live without re-running the full overnight scan.
//
// What it does: replicates the relevant parts of scanJobsBatch but captures
// every step into a `diagnostics` array that's returned in the response.
// You see exactly where the pipeline drops to 0 — token issue, URL issue,
// match issue, age filter, or empty Apify response.
//
// How to use:
//   POST /api/debug/jobs
//   Body: {
//     accounts: [{ name, linkedinCompanyId?, domain?, linkedinSlug? }],
//     campaignId?: string,
//     ageDays?: number  // override MAX_JOB_AGE_DAYS, default 30
//   }
//
// Auth: blocks /client/[id] referer like the main scan endpoint.
// Cost: 1 Apify call (worst case 3 retries). No OpenAI calls — does NOT
//   classify. Only diagnoses the fetch+match pipeline.
// ═════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

// ─── Helpers (duplicated minimally from scan/route.js to avoid coupling) ───
function getApifyTokens() {
  const tokens = [];
  if (process.env.APIFY_TOKEN) tokens.push({ key: "APIFY_TOKEN", token: process.env.APIFY_TOKEN });
  if (process.env.APIFY_TOKEN_2) tokens.push({ key: "APIFY_TOKEN_2", token: process.env.APIFY_TOKEN_2 });
  if (process.env.APIFY_TOKEN_3) tokens.push({ key: "APIFY_TOKEN_3", token: process.env.APIFY_TOKEN_3 });
  return tokens;
}

function isCreditExhausted(status, body) {
  if (status === 402 || status === 403 || status === 429) return true;
  const text = (body || "").toLowerCase();
  return text.includes("maximum usage") || text.includes("billing") || text.includes("exceeded") || text.includes("insufficient") || text.includes("platform-feature-disabled") || text.includes("hard limit");
}

function cleanCompanyName(name) {
  if (!name) return "";
  return name.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}

// ─── Apify call with diagnostics capture ─────────────────────────────
async function apifyCallVerbose(actorId, input, diag, label) {
  const tokens = getApifyTokens();
  if (tokens.length === 0) {
    diag.push({ stage: label, error: "No APIFY_TOKEN env vars configured" });
    return { error: "no-token", data: null };
  }
  const apiActorId = actorId.replace("/", "~");

  for (let t = 0; t < tokens.length; t++) {
    const { key, token } = tokens[t];
    diag.push({ stage: label, attempt: `${key} (${t + 1}/${tokens.length})` });
    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 480000);
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
      if (!res.ok) {
        const errBody = await res.text();
        if (isCreditExhausted(res.status, errBody)) {
          diag.push({ stage: label, tokenExhausted: key, status: res.status, errBody: errBody.slice(0, 200) });
          continue; // try next token
        }
        diag.push({ stage: label, httpError: res.status, errBody: errBody.slice(0, 200) });
        return { error: `HTTP ${res.status}`, data: null };
      }
      const data = await res.json();
      diag.push({ stage: label, success: true, tokenUsed: key, recordCount: Array.isArray(data) ? data.length : 0 });
      return { data, usedToken: key };
    } catch (e) {
      diag.push({ stage: label, exception: e.message, name: e.name });
    }
  }
  return { error: "all-tokens-failed", data: null };
}

// ─── POST handler ────────────────────────────────────────────────────
export async function POST(request) {
  try {
    // SECURITY: same as /api/scan — block from /client/[id] pages
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) {
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }

    const body = await request.json();
    const accounts = Array.isArray(body.accounts) ? body.accounts : [];
    const ageDays = Number.isFinite(body.ageDays) ? body.ageDays : (parseInt(process.env.MAX_JOB_AGE_DAYS) || 30);

    if (accounts.length === 0) {
      return NextResponse.json({ error: "Provide accounts: [{ name, linkedinCompanyId?, domain?, linkedinSlug? }]" }, { status: 400 });
    }

    const diagnostics = [];
    const tokens = getApifyTokens();
    diagnostics.push({
      stage: "init",
      apifyTokensConfigured: tokens.length,
      tokenKeys: tokens.map(t => t.key),
      ageDays,
      accountCount: accounts.length,
      accountsWithLinkedinId: accounts.filter(a => a.linkedinCompanyId).length,
      accountsWithoutLinkedinId: accounts.filter(a => !a.linkedinCompanyId).length,
    });

    if (tokens.length === 0) {
      return NextResponse.json({
        verdict: "FAIL: no Apify tokens configured. Set APIFY_TOKEN in Vercel env.",
        diagnostics,
      });
    }

    // ── Build URLs (same logic as scanJobsBatch) ──
    const withIds = accounts.filter(a => a.linkedinCompanyId);
    const withoutIds = accounts.filter(a => !a.linkedinCompanyId);
    const TPR = process.env.APIFY_JOBS_TPR || "r2592000";
    const urls = [];
    if (withIds.length > 0) {
      const ids = withIds.map(c => c.linkedinCompanyId).join(",");
      urls.push(`https://www.linkedin.com/jobs/search/?f_C=${ids}&f_TPR=${TPR}&keywords=marketing&sortBy=DD`);
    }
    for (const c of withoutIds) {
      const cleanName = cleanCompanyName(c.name);
      if (!cleanName) continue;
      urls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" marketing`)}&sortBy=DD`);
    }
    diagnostics.push({ stage: "url_construction", urls, urlCount: urls.length });

    if (urls.length === 0) {
      return NextResponse.json({
        verdict: "FAIL: no URLs could be constructed (accounts missing both linkedinCompanyId and resolvable name).",
        diagnostics,
      });
    }

    const actorId = process.env.APIFY_ACTOR_ID || "curious_coder/linkedin-jobs-scraper";
    const baseInput = { count: 100, scrapeCompany: false, includeJobDescription: true };

    // ── Attempt 1: with f_TPR ──
    const r1 = await apifyCallVerbose(actorId, { urls, ...baseInput }, diagnostics, "fetch_with_tpr");
    let allJobs = Array.isArray(r1.data) ? r1.data : [];
    diagnostics.push({ stage: "after_attempt_1", jobCount: allJobs.length });

    // ── Attempt 2: drop f_TPR ──
    if (allJobs.length === 0 && !r1.error && withIds.length > 0) {
      const retryUrls = [];
      if (withIds.length > 0) {
        const ids = withIds.map(c => c.linkedinCompanyId).join(",");
        retryUrls.push(`https://www.linkedin.com/jobs/search/?f_C=${ids}&keywords=marketing&sortBy=DD`);
      }
      for (const c of withoutIds) {
        const cleanName = cleanCompanyName(c.name);
        if (!cleanName) continue;
        retryUrls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" marketing`)}&sortBy=DD`);
      }
      const r2 = await apifyCallVerbose(actorId, { urls: retryUrls, ...baseInput }, diagnostics, "fetch_no_tpr");
      allJobs = Array.isArray(r2.data) ? r2.data : [];
      diagnostics.push({ stage: "after_attempt_2", jobCount: allJobs.length });
    }

    // ── Attempt 3: individual URLs per company ──
    if (allJobs.length === 0 && withIds.length > 1 && !r1.error) {
      const indivUrls = withIds.map(c => `https://www.linkedin.com/jobs/search/?f_C=${c.linkedinCompanyId}&keywords=marketing&sortBy=DD`);
      for (const c of withoutIds) {
        const cleanName = cleanCompanyName(c.name);
        if (!cleanName) continue;
        indivUrls.push(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" marketing`)}&sortBy=DD`);
      }
      const r3 = await apifyCallVerbose(actorId, { urls: indivUrls, ...baseInput }, diagnostics, "fetch_individual");
      allJobs = Array.isArray(r3.data) ? r3.data : [];
      diagnostics.push({ stage: "after_attempt_3", jobCount: allJobs.length });
    }

    // ── Sample of raw jobs (first 5) for manual inspection ──
    diagnostics.push({
      stage: "raw_jobs_sample",
      sample: allJobs.slice(0, 5).map(j => ({
        title: j.title,
        companyName: j.companyName,
        companyLinkedinUrl: j.companyLinkedinUrl || j.companyUrl,
        postedAt: j.postedAt,
        location: j.location,
      })),
    });

    if (allJobs.length === 0) {
      return NextResponse.json({
        verdict: "FAIL: Apify returned 0 jobs across all 3 retries. Likely causes: (1) all configured Apify tokens exhausted/invalid, (2) LinkedIn IDs are stale/wrong, (3) Apify actor blocked by LinkedIn that day. Check the diagnostics array — token-exhausted entries indicate (1); successful Apify call with 0 records indicates (2) or (3).",
        diagnostics,
        finalJobCount: 0,
      });
    }

    // ── Per-account match diagnostics ──
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const perAccount = [];
    for (const c of accounts) {
      const cleanName = cleanCompanyName(c.name);
      const companyLower = cleanName.toLowerCase().trim();
      const cleanedDomain = (c.domain || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
      const rawBase = cleanedDomain.split(".")[0].toLowerCase();
      const domainBase = rawBase.length >= 3 ? rawBase : "";
      const companySlug = (c.linkedinSlug || "").toLowerCase();
      const hasId = !!c.linkedinCompanyId;

      const matched = !companyLower ? [] : allJobs.filter(job => {
        const jobCoName = (job.companyName || "").toLowerCase().trim();
        const jobLinkedinUrl = (job.companyLinkedinUrl || job.companyUrl || "").toLowerCase();
        const jobSlug = jobLinkedinUrl.match(/linkedin\.com\/company\/([^\/?\s]+)/)?.[1] || "";
        if (!jobCoName || jobCoName.length < 3) return false;
        if (hasId) {
          return jobSlug === companySlug || jobCoName.includes(companyLower) || companyLower.includes(jobCoName) ||
            (domainBase && jobCoName.includes(domainBase)) ||
            (companySlug && jobCoName.replace(/[^a-z0-9]/g, "").includes(companySlug.replace(/[^a-z0-9]/g, "")));
        } else {
          return jobCoName.includes(companyLower) || companyLower.includes(jobCoName) || (domainBase && jobCoName.includes(domainBase));
        }
      });

      const recent = matched.filter(j => {
        if (!j.postedAt) return true;
        const d = new Date(j.postedAt).getTime();
        return !isNaN(d) && d >= cutoff;
      });

      perAccount.push({
        accountName: c.name,
        cleanName,
        linkedinCompanyId: c.linkedinCompanyId || null,
        linkedinSlug: c.linkedinSlug || null,
        domainBase: domainBase || null,
        rawJobsTotal: allJobs.length,
        matched: matched.length,
        recentWithinAgeDays: recent.length,
        sampleMatched: matched.slice(0, 3).map(j => ({ title: j.title, companyName: j.companyName, postedAt: j.postedAt })),
        sampleDroppedByAge: matched.filter(j => {
          if (!j.postedAt) return false;
          const d = new Date(j.postedAt).getTime();
          return !isNaN(d) && d < cutoff;
        }).slice(0, 3).map(j => ({ title: j.title, postedAt: j.postedAt, daysOld: j.postedAt ? Math.round((Date.now() - new Date(j.postedAt).getTime()) / 86400000) : null })),
      });
    }
    diagnostics.push({ stage: "per_account_match", perAccount });

    const totalMatched = perAccount.reduce((s, a) => s + a.matched, 0);
    const totalRecent = perAccount.reduce((s, a) => s + a.recentWithinAgeDays, 0);

    let verdict;
    if (totalMatched === 0) {
      verdict = `FAIL at MATCH stage: Apify returned ${allJobs.length} jobs but NONE matched any account. Likely causes: (1) LinkedIn renamed the companies — check raw_jobs_sample.companyName vs your account names, (2) accounts.linkedinSlug or .domain values are wrong, (3) f_C IDs returned jobs from completely different companies.`;
    } else if (totalRecent === 0) {
      verdict = `FAIL at AGE FILTER stage: ${totalMatched} jobs matched accounts but ALL are older than ${ageDays} days. Increase ageDays in this request, or set APIFY_JOBS_TPR to a longer window in env (current: ${TPR}). Check sampleDroppedByAge for actual job ages.`;
    } else {
      verdict = `OK: ${totalRecent} jobs would survive into classify(). If your overnight scan still shows 0 tasks, the failure is downstream in classify() — task rule keyword pre-filter or AI scoring below threshold.`;
    }

    return NextResponse.json({
      verdict,
      summary: {
        apifyRawJobs: allJobs.length,
        totalMatched,
        totalRecent,
        ageDays,
      },
      diagnostics,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}
