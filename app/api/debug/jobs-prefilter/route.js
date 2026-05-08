import { NextResponse } from "next/server";

// ═════════════════════════════════════════════════════════════════════════
// /api/debug/jobs-prefilter
//
// Why this exists: after fixing Apify, fixing tokens, fixing the system
// prompt, fixing body fetch, and loosening keywords — jobs scan still
// produced ~0 tasks per company because keyword prefilter dropped 100%
// of jobs. We've been guessing at keywords without seeing the actual
// content the prefilter is matching against.
//
// This endpoint exposes that content. Given a company + a list of rules,
// it fetches the same jobs the production scan would, builds the same
// haystack the prefilter sees, and shows which rules match each job and
// what keywords (if any) hit. The output is direct evidence for keyword
// audits.
//
// Usage:
//   POST /api/debug/jobs-prefilter
//   Body: {
//     account: { name, linkedinCompanyId, linkedinSlug?, domain? },
//     rules: [
//       { name: "CMO / CGO opening", keywords: ["cmo", "cgo", "marketing officer", ...] },
//       ...
//     ],
//     ageDays?: 30  // override default for diagnostic
//   }
//
// Returns one entry per (job × rule) showing: job title, description
// preview, normalized haystack, and which keywords matched the rule.
// ═════════════════════════════════════════════════════════════════════════

export const maxDuration = 300;

// ─── Helpers (mirror scan/route.js production logic exactly) ──────────
function getApifyTokens() {
  const tokens = [];
  if (process.env.APIFY_TOKEN) tokens.push({ key: "APIFY_TOKEN", token: process.env.APIFY_TOKEN });
  if (process.env.APIFY_TOKEN_2) tokens.push({ key: "APIFY_TOKEN_2", token: process.env.APIFY_TOKEN_2 });
  if (process.env.APIFY_TOKEN_3) tokens.push({ key: "APIFY_TOKEN_3", token: process.env.APIFY_TOKEN_3 });
  return tokens;
}

function cleanCompanyName(name) {
  if (!name) return "";
  return name.replace(/\s*\([^)]*\)\s*$/, "").replace(/\s*\[[^\]]*\]\s*$/, "").trim();
}

// EXACT copy of production normalizeForMatch — we want behaviour identical
function normalizeForMatch(s) {
  return (s || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
}

const cl = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

async function apifyCall(actorId, input, diag) {
  const tokens = getApifyTokens();
  if (tokens.length === 0) {
    diag.push({ stage: "apify", error: "No APIFY_TOKEN env vars" });
    return null;
  }
  const apiActorId = actorId.replace("/", "~");
  for (const { key, token } of tokens) {
    try {
      const ctrl = new AbortController();
      const tt = setTimeout(() => ctrl.abort(), 480000);
      const res = await fetch(
        `https://api.apify.com/v2/acts/${apiActorId}/run-sync-get-dataset-items?token=${token}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal: ctrl.signal }
      );
      clearTimeout(tt);
      if (!res.ok) {
        diag.push({ stage: "apify", tokenTried: key, status: res.status });
        continue;
      }
      const data = await res.json();
      diag.push({ stage: "apify", tokenUsed: key, recordCount: Array.isArray(data) ? data.length : 0 });
      return data;
    } catch (e) {
      diag.push({ stage: "apify", tokenTried: key, exception: e.message });
    }
  }
  return null;
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
    const account = body.account;
    const rules = Array.isArray(body.rules) ? body.rules : [];
    const ageDays = Number.isFinite(body.ageDays) ? body.ageDays : 30; // default to wider window for diagnosis

    if (!account || !account.name) {
      return NextResponse.json({ error: "Provide account: { name, linkedinCompanyId?, linkedinSlug?, domain? }" }, { status: 400 });
    }
    if (rules.length === 0) {
      return NextResponse.json({ error: "Provide rules: [{ name, keywords: [...] }, ...]" }, { status: 400 });
    }

    const diagnostics = [];
    diagnostics.push({ stage: "init", account, ruleCount: rules.length, ageDays });

    // ── Fetch jobs from Apify (single-company URL) ──
    const cleanName = cleanCompanyName(account.name);
    const TPR = process.env.APIFY_JOBS_TPR || "r2592000";
    const url = account.linkedinCompanyId
      ? `https://www.linkedin.com/jobs/search/?f_C=${account.linkedinCompanyId}&f_TPR=${TPR}&keywords=marketing&sortBy=DD`
      : `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(`"${cleanName}" marketing`)}&sortBy=DD`;
    diagnostics.push({ stage: "url", url });

    const actorId = process.env.APIFY_ACTOR_ID || "curious_coder/linkedin-jobs-scraper";
    const baseInput = { count: 100, scrapeCompany: false, includeJobDescription: true };
    const allJobs = await apifyCall(actorId, { urls: [url], ...baseInput }, diagnostics);

    if (!Array.isArray(allJobs) || allJobs.length === 0) {
      return NextResponse.json({
        verdict: "FAIL: Apify returned no jobs. Check diagnostics for token/auth issues.",
        diagnostics,
      });
    }

    // ── Match jobs to this account (same logic as production) ──
    const companyLower = cleanName.toLowerCase().trim();
    const cleanedDomain = (account.domain || "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
    const rawBase = cleanedDomain.split(".")[0].toLowerCase();
    const domainBase = rawBase.length >= 3 ? rawBase : "";
    const companySlug = (account.linkedinSlug || "").toLowerCase();
    const hasId = !!account.linkedinCompanyId;

    const matched = allJobs.filter(job => {
      const jobCoName = (job.companyName || "").toLowerCase().trim();
      const jobLinkedinUrl = (job.companyLinkedinUrl || job.companyUrl || "").toLowerCase();
      const jobSlug = jobLinkedinUrl.match(/linkedin\.com\/company\/([^\/?\s]+)/)?.[1] || "";
      if (!jobCoName || jobCoName.length < 3) return false;
      if (hasId) {
        return jobSlug === companySlug || jobCoName.includes(companyLower) || companyLower.includes(jobCoName) ||
          (domainBase && jobCoName.includes(domainBase)) ||
          (companySlug && jobCoName.replace(/[^a-z0-9]/g, "").includes(companySlug.replace(/[^a-z0-9]/g, "")));
      }
      return jobCoName.includes(companyLower) || companyLower.includes(jobCoName) || (domainBase && jobCoName.includes(domainBase));
    });

    // ── Age filter ──
    const cutoff = Date.now() - ageDays * 24 * 60 * 60 * 1000;
    const recent = matched.filter(j => {
      if (!j.postedAt) return true;
      const d = new Date(j.postedAt).getTime();
      return !isNaN(d) && d >= cutoff;
    });

    diagnostics.push({
      stage: "match_filter",
      apifyTotal: allJobs.length,
      matchedToAccount: matched.length,
      withinAgeWindow: recent.length,
    });

    if (recent.length === 0) {
      return NextResponse.json({
        verdict: `FAIL: ${matched.length} jobs matched the account but 0 are within ${ageDays} days. Check apifyRawJobs for ages.`,
        diagnostics,
        rawJobsForInspection: allJobs.slice(0, 10).map(j => ({ title: j.title, company: j.companyName, postedAt: j.postedAt })),
      });
    }

    // ── Build the same signal structure production uses ──
    const signals = recent.slice(0, 25).map(job => ({
      headline: `${job.title || "Open Role"} — ${job.companyName || account.name}`,
      description: cl(job.descriptionText || job.descriptionHtml || "").slice(0, 500),
      jobTitle: job.title || "",
      url: job.url || "",
      postedAt: job.postedAt || null,
    }));

    // ── For each job × each rule: show match result ──
    const perJobAudit = signals.map((sig, jobIdx) => {
      const haystack = normalizeForMatch(`${sig.headline || ""} ${sig.description || ""} ${sig.jobTitle || ""}`);
      const ruleResults = rules.map(rule => {
        const cleanKws = (rule.keywords || [])
          .filter(k => k && k.length >= 2)
          .map(k => normalizeForMatch(k))
          .filter(k => k.length >= 2);
        if (cleanKws.length === 0) {
          return { ruleName: rule.name, status: "no_keywords_send_all" };
        }
        const matchingKws = cleanKws.filter(kw => haystack.includes(kw));
        return {
          ruleName: rule.name,
          status: matchingKws.length > 0 ? "MATCH" : "drop",
          matchingKeywords: matchingKws,
        };
      });

      // Mark whether THIS job survives ANY rule
      const survivesAnyRule = ruleResults.some(r => r.status === "MATCH" || r.status === "no_keywords_send_all");

      return {
        jobIdx,
        jobTitle: sig.jobTitle,
        descriptionPreview: sig.description.slice(0, 250),
        descriptionFull200: sig.description.slice(0, 200), // for keyword auditing
        normalizedHaystack: haystack.slice(0, 400) + (haystack.length > 400 ? "…" : ""),
        survivesAnyRule,
        ruleResults,
      };
    });

    // ── Per-rule summary: how many jobs each rule would catch ──
    const perRuleSummary = rules.map(rule => {
      const matchCount = perJobAudit.filter(j => j.ruleResults.find(r => r.ruleName === rule.name)?.status === "MATCH").length;
      return {
        ruleName: rule.name,
        keywords: rule.keywords,
        normalizedKeywords: (rule.keywords || []).map(k => normalizeForMatch(k)),
        matchedJobs: matchCount,
        totalJobsExamined: signals.length,
      };
    });

    // ── Keyword frequency analysis: which words actually appear across job titles ──
    // This helps spot keywords that should be ADDED to rules.
    const wordCounts = {};
    for (const sig of signals) {
      const titleWords = normalizeForMatch(sig.jobTitle).split(" ");
      const seen = new Set();
      for (const w of titleWords) {
        if (w.length < 3) continue;
        if (seen.has(w)) continue;
        seen.add(w);
        wordCounts[w] = (wordCounts[w] || 0) + 1;
      }
    }
    const topTitleWords = Object.entries(wordCounts)
      .filter(([w]) => !["the", "and", "for", "with", "our", "new", "are", "this", "you", "your", "from", "their"].includes(w))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([word, count]) => ({ word, count }));

    const totalMatched = perJobAudit.filter(j => j.survivesAnyRule).length;

    return NextResponse.json({
      verdict: totalMatched === 0
        ? `${signals.length} recent jobs found for ${account.name}, but ZERO would survive keyword prefilter on ANY of the ${rules.length} rules. Inspect perJobAudit to see actual job titles + descriptions, and topTitleWords to see what words ARE common in this company's job titles. Use these to revise keywords.`
        : `${totalMatched} of ${signals.length} jobs would survive prefilter on at least one rule. Inspect perRuleSummary for per-rule counts and perJobAudit for which jobs each rule catches.`,
      summary: {
        company: account.name,
        apifyTotal: allJobs.length,
        matchedToAccount: matched.length,
        withinAgeWindow: recent.length,
        examined: signals.length,
        survivesPrefilter: totalMatched,
      },
      perRuleSummary,
      topTitleWords,
      perJobAudit,
      diagnostics,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message, stack: e.stack }, { status: 500 });
  }
}
