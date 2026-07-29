export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 60;

// ─── COST + ACTIVITY API ────────────────────────────────────────────────────
//
// The queryable surface over the per-call rows written by lib/llm-cost-log.js.
// Lives in the backend on purpose — one place holds every campaign's spend and
// activity, across all three providers, so "what did this actually cost and
// what did the operator actually do" is one request away.
//
//   POST /api/cost-log            ingest one call
//     Authorization: Bearer <SIDEKICK_API_KEY>
//     { route, model, usage, campaignId?, postKey?, action?, meta? }
//     or for a zero-cost funnel milestone:
//     { kind: "activity", route, action?, campaignId?, postKey?, meta? }
//
//   GET /api/cost-log?key=<CRON_SECRET>&days=7[&campaign=][&provider=]
//     Everything the dashboard needs, aggregated server-side: spend, unit
//     economics, the pipeline funnel, and operator behaviour.
//
// Read auth is CRON_SECRET (operator), write auth is SIDEKICK_API_KEY (the app
// reporting its own usage) — deliberately different scopes.

import { logLLMCall, logActivity, COST_LOG_TABLE, MASTER_BASE_ID, RAPIDAPI_PLANS, ACTIVE_RAPIDAPI_PLAN, SHADOW_MODEL } from "@/lib/llm-cost-log";

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_KEY = process.env.SIDEKICK_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

// A gap longer than this between calls starts a new working session.
const SESSION_GAP_MS = 30 * 60 * 1000;
// Below this many observations a ratio is noise, and the UI is told to say so.
const MIN_SAMPLE_FOR_RATIO = 5;

// ─── POST: ingest ───────────────────────────────────────────────────────────
export async function POST(request) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!SIDEKICK_KEY || token !== SIDEKICK_KEY) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { kind, route, model, usage, campaignId, user, userLabel, postKey, action, meta } = body || {};

  // Zero-cost funnel milestones (comment published, task handled) carry no
  // usage and must not be rejected for lacking one.
  if (kind === "activity") {
    if (!route) return Response.json({ ok: false, error: "route is required" }, { status: 400 });
    const result = await logActivity({ route, action, campaignId, user, userLabel, postKey, meta });
    return Response.json({ ok: result.ok !== false, ...result });
  }

  if (!route || !model || !usage) {
    return Response.json({ ok: false, error: "route, model and usage are required" }, { status: 400 });
  }

  const result = await logLLMCall({ route, model, usage, campaignId, user, userLabel, postKey, action, meta });
  return Response.json({ ok: result.ok !== false, ...result });
}

// ─── Airtable read ──────────────────────────────────────────────────────────
// `from` / `to` are ISO instants. They exist so the operator can draw a hard
// baseline: everything on or after the baseline is the live measurement window,
// everything before it is prior activity that must not contaminate it.
async function listRows(fromISO, toISO) {
  const rows = [];
  let offset = null;
  const clauses = [];
  if (fromISO) clauses.push(`IS_AFTER({Called At}, "${fromISO}")`);
  if (toISO) clauses.push(`IS_BEFORE({Called At}, "${toISO}")`);
  const formula = clauses.length > 1 ? `AND(${clauses.join(", ")})` : (clauses[0] || "TRUE()");
  do {
    const qs = new URLSearchParams({ filterByFormula: formula, pageSize: "100" });
    if (offset) qs.set("offset", offset);
    const res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent(COST_LOG_TABLE)}?${qs}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
    });
    if (!res.ok) {
      const txt = await res.text();
      // A missing table means nothing has been logged yet. That is an empty
      // result, not an error the operator needs to debug.
      if (res.status === 404 || txt.includes("TABLE_NOT_FOUND") || txt.includes("NOT_FOUND")) return [];
      throw new Error(`Airtable ${res.status}: ${txt.slice(0, 200)}`);
    }
    const data = await res.json();
    rows.push(...(data.records || []));
    offset = data.offset;
  } while (offset);
  return rows;
}

// ─── Aggregation helpers ────────────────────────────────────────────────────
function newBucket() {
  return { calls: 0, units: 0, inTok: 0, outTok: 0, cacheTok: 0, cost: 0, shadow: 0 };
}
function bump(map, key, f) {
  const k = key || "unknown";
  if (!map[k]) map[k] = newBucket();
  const t = map[k];
  t.calls += 1;
  t.units += Number(f.Units) || 1;
  t.inTok += Number(f["Input Tokens"]) || 0;
  t.outTok += Number(f["Output Tokens"]) || 0;
  t.cacheTok += (Number(f["Cache Write Tokens"]) || 0) + (Number(f["Cache Read Tokens"]) || 0);
  t.cost += Number(f["Cost USD"]) || 0;
  t.shadow += Number(f["Shadow Cost USD"]) || 0;
}
const r6 = (n) => Number((n || 0).toFixed(6));
function finish(map) {
  return Object.fromEntries(
    Object.entries(map)
      .map(([k, v]) => [k, { ...v, cost: r6(v.cost), shadow: r6(v.shadow) }])
      .sort((a, b) => b[1].cost - a[1].cost)
  );
}
function safeMeta(raw) {
  try { return JSON.parse(raw || "{}"); } catch { return {}; }
}
const ratio = (num, den) =>
  den >= MIN_SAMPLE_FOR_RATIO ? Number((num / den).toFixed(4)) : null;

// ─── GET: everything the dashboard needs ────────────────────────────────────
export async function GET(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (!CRON_SECRET || key !== CRON_SECRET) {
    return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return Response.json({ ok: false, error: "Airtable not configured" }, { status: 500 });
  }

  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") || "7", 10) || 7, 1), 90);
  const campaignFilter = (url.searchParams.get("campaign") || "").toLowerCase();
  const providerFilter = (url.searchParams.get("provider") || "").toLowerCase();

  // Explicit bounds win over the rolling `days` window. `from` alone means
  // "everything since the baseline"; `to` alone means "everything before it".
  const fromParam = url.searchParams.get("from") || "";
  const toParam = url.searchParams.get("to") || "";
  const from = fromParam ? new Date(fromParam).toISOString() : null;
  const to = toParam ? new Date(toParam).toISOString() : null;
  const since = from || (to ? null : new Date(Date.now() - days * 86400000).toISOString());

  try {
    let records = await listRows(since, to);
    if (campaignFilter) records = records.filter((r) => String(r.fields?.Campaign || "").toLowerCase() === campaignFilter);
    if (providerFilter) records = records.filter((r) => String(r.fields?.Provider || "").toLowerCase() === providerFilter);

    const byProvider = {}, byDay = {}, byRoute = {}, byModel = {}, byCampaign = {}, byHour = {}, byUser = {};
    // Per-user streams. COST and ACTIVITY are accumulated separately on
    // purpose: 'what did this person spend' and 'what did this person do'
    // are different questions, and averaging them into one number answers
    // neither. One event stream feeds both so they can never disagree.
    const users = {};
    const userOf = (f) => String(f.User || '') || '(no session)';
    function userBucket(f) {
      const k = userOf(f);
      if (!users[k]) users[k] = {
        user: k, label: String(f['User Label'] || '') || k, campaign: String(f.Campaign || ''),
        cost: { calls: 0, costUSD: 0, inTok: 0, outTok: 0, byProvider: {}, byRoute: {} },
        activity: { events: 0, postsTouched: new Set(), postsWorked: new Set(), postsPublished: new Set(),
                    drafts: 0, regenerates: 0, postsRegenerated: new Set(), angles: 0, chats: 0,
                    firstSeen: '', lastSeen: '', timestamps: [] },
      };
      return users[k];
    }
    const postsTouched = new Set();
    const postsWorked = new Set();     // a post that reached a comment draft
    const postsPublished = new Set();  // a post whose comment actually went out
    // The angle carousel auto-generates a draft for all 3 angles on card mount,
    // so raw generate-comment rows are ~3x per post BY CONSTRUCTION and measure
    // nothing about the operator. Only Meta.regenerate === true is a real
    // rejection, and the honest denominator is DISTINCT POSTS, not raw drafts.
    const postsRegenerated = new Set();
    const anglesByPost = {}, chatByPost = {}, draftsByPost = {};
    const timestamps = [];
    let totalCost = 0, totalShadow = 0, totalIn = 0, totalOut = 0, totalCache = 0;
    let drafts = 0, regenerates = 0, scoringCalls = 0, scoringWithFeedback = 0;
    let rapidCalls = 0, rapidEmptyBodies = 0, unpricedRows = 0;
    let rapidFailures = 0, lastRapidError = "";
    const rapidFailureCodes = {};

    for (const rec of records) {
      const f = rec.fields || {};
      const provider = String(f.Provider || "other");
      const route = String(f.Route || "unknown");
      const meta = safeMeta(f.Meta);
      const postKey = String(f["Post Key"] || "");

      bump(byProvider, provider, f);
      bump(byDay, f.Day, f);
      bump(byRoute, route, f);
      if (provider !== "activity") bump(byModel, f.Model, f);
      bump(byCampaign, f.Campaign || "(unattributed)", f);
      bump(byHour, String(f.Hour ?? "?"), f);
      bump(byUser, userOf(f), f);

      // ── per-user split ──
      const ub = userBucket(f);
      const rowCost = Number(f["Cost USD"]) || 0;
      if (provider !== "activity") {
        ub.cost.calls += 1;
        ub.cost.costUSD += rowCost;
        ub.cost.inTok += Number(f["Input Tokens"]) || 0;
        ub.cost.outTok += Number(f["Output Tokens"]) || 0;
        ub.cost.byProvider[provider] = (ub.cost.byProvider[provider] || 0) + rowCost;
        ub.cost.byRoute[route] = (ub.cost.byRoute[route] || 0) + rowCost;
      }
      ub.activity.events += 1;
      if (f["Called At"]) {
        const ts = String(f["Called At"]);
        ub.activity.timestamps.push(Date.parse(ts));
        if (!ub.activity.firstSeen || ts < ub.activity.firstSeen) ub.activity.firstSeen = ts;
        if (!ub.activity.lastSeen || ts > ub.activity.lastSeen) ub.activity.lastSeen = ts;
      }
      if (postKey) ub.activity.postsTouched.add(postKey);
      if (route === "generate-comment") {
        ub.activity.drafts += 1;
        if (postKey) ub.activity.postsWorked.add(postKey);
        if (meta.regenerate) { ub.activity.regenerates += 1; if (postKey) ub.activity.postsRegenerated.add(postKey); }
      }
      if (route === "comment-angles") ub.activity.angles += 1;
      if (route === "post-chat") ub.activity.chats += 1;
      if (route === "comment-published" && postKey) ub.activity.postsPublished.add(postKey);

      totalCost += Number(f["Cost USD"]) || 0;
      totalShadow += Number(f["Shadow Cost USD"]) || 0;
      totalIn += Number(f["Input Tokens"]) || 0;
      totalOut += Number(f["Output Tokens"]) || 0;
      totalCache += (Number(f["Cache Write Tokens"]) || 0) + (Number(f["Cache Read Tokens"]) || 0);

      if (f["Called At"]) timestamps.push(Date.parse(f["Called At"]));
      if (postKey) postsTouched.add(postKey);

      if (provider === "rapidapi") {
        rapidCalls += Number(f.Units) || 0;
        if (meta.emptyBody) rapidEmptyBodies += 1;
        // A provider failure must surface as a failure, never as a quiet week.
        if (meta.failed) {
          rapidFailures += 1;
          const code = `${meta.status || "?"}`;
          rapidFailureCodes[code] = (rapidFailureCodes[code] || 0) + 1;
          if (meta.error) lastRapidError = String(meta.error).slice(0, 200);
        }
      }
      if (route.includes("score")) {
        scoringCalls += 1;
        if (meta.hasReviewerFeedback) scoringWithFeedback += 1;
      }
      if (!String(f["Priced As"] || "") && provider !== "activity") unpricedRows += 1;

      if (route === "generate-comment") {
        drafts += 1;
        if (meta.regenerate) {
          regenerates += 1;
          if (postKey) postsRegenerated.add(postKey);
        }
        if (postKey) {
          postsWorked.add(postKey);
          draftsByPost[postKey] = (draftsByPost[postKey] || 0) + 1;
        }
      }
      if (route === "comment-angles" && postKey) anglesByPost[postKey] = (anglesByPost[postKey] || 0) + 1;
      if (route === "post-chat" && postKey) chatByPost[postKey] = (chatByPost[postKey] || 0) + 1;
      if (route === "comment-published" && postKey) postsPublished.add(postKey);
    }

    // ── Working sessions: a gap over SESSION_GAP_MS starts a new one ──
    timestamps.sort((a, b) => a - b);
    const sessions = [];
    for (const t of timestamps) {
      const last = sessions[sessions.length - 1];
      if (!last || t - last.end > SESSION_GAP_MS) sessions.push({ start: t, end: t, calls: 1 });
      else { last.end = t; last.calls += 1; }
    }
    const sessionMinutes = sessions.map((s) => (s.end - s.start) / 60000);
    const totalActiveMin = sessionMinutes.reduce((a, b) => a + b, 0);

    const dayCount = Object.keys(byDay).length || 1;
    const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

    // ── Plan quota burn-down for the ACTIVE RapidAPI plan ──
    const plan = RAPIDAPI_PLANS[ACTIVE_RAPIDAPI_PLAN] || RAPIDAPI_PLANS.Pro;
    const rapidMonthlyProjected = (rapidCalls / dayCount) * 30.44;

    return Response.json({
      ok: true,
      window: { days, since, to, from, daysWithActivity: dayCount, bounded: !!(from || to) },

      totals: {
        rows: records.length,
        costUSD: r6(totalCost),
        // What the same work would cost with scoring moved to the shadow model.
        shadowCostUSD: r6(totalShadow),
        shadowModel: SHADOW_MODEL,
        inputTokens: totalIn,
        outputTokens: totalOut,
        cacheTokens: totalCache,
        avgCostPerDayUSD: r6(totalCost / dayCount),
        projectedMonthlyUSD: Number(((totalCost / dayCount) * 30.44).toFixed(2)),
        projectedMonthlyShadowUSD: Number(((totalShadow / dayCount) * 30.44).toFixed(2)),
      },

      // Unit economics — the numbers that price a client. Null where the
      // denominator is too small to mean anything yet.
      unitEconomics: {
        postsScored: scoringCalls,
        postsTouched: postsTouched.size,
        postsWorked: postsWorked.size,
        postsPublished: postsPublished.size,
        costPerPostScored: scoringCalls ? r6(totalCost / scoringCalls) : null,
        costPerPostWorked: postsWorked.size ? r6(totalCost / postsWorked.size) : null,
        costPerCommentPublished: postsPublished.size ? r6(totalCost / postsPublished.size) : null,
        rapidapiCostPerPost: scoringCalls ? r6((byProvider.rapidapi?.cost || 0) / scoringCalls) : null,
      },

      // The pipeline, stage by stage. Drop-off between stages is the point.
      // Provider health. Surfaced at the top level, not buried in the funnel,
      // because a dead subscription invalidates every number below it.
      providerHealth: {
        rapidapiFailures: rapidFailures,
        rapidapiFailureCodes: rapidFailureCodes,
        lastRapidapiError: lastRapidError,
        rapidapiEmptyBodies: rapidEmptyBodies,
      },

      funnel: {
        rapidapiCalls: rapidCalls,
        rapidapiEmptyBodies: rapidEmptyBodies,
        postsScored: scoringCalls,
        postsOpened: sum(Object.keys(anglesByPost).map(() => 1)) || Object.keys(anglesByPost).length,
        postsDrafted: postsWorked.size,
        commentsPublished: postsPublished.size,
      },

      // Operator behaviour. Ratios return null below the sample floor rather
      // than presenting noise as signal.
      behaviour: {
        draftsGenerated: drafts,
        regenerates,
        // Denominator is DISTINCT POSTS, not raw drafts. The angle carousel
        // auto-generates one draft per angle on card mount, so raw drafts are
        // ~3x per post by construction and a raw ratio would understate
        // rejection by roughly a third while looking authoritative.
        postsWithDraft: postsWorked.size,
        postsRegenerated: postsRegenerated.size,
        regenerateRate: ratio(postsRegenerated.size, postsWorked.size),
        regeneratesPerRegeneratedPost: ratio(regenerates, postsRegenerated.size),
        anglesRequests: sum(Object.values(anglesByPost)),
        anglesPerPost: ratio(sum(Object.values(anglesByPost)), Object.keys(anglesByPost).length),
        chatTurns: sum(Object.values(chatByPost)),
        chatTurnsPerPost: ratio(sum(Object.values(chatByPost)), Object.keys(chatByPost).length),
        draftsPerWorkedPost: ratio(drafts, postsWorked.size),
        scoringWithReviewerFeedback: scoringWithFeedback,
        sessions: sessions.length,
        totalActiveMinutes: Math.round(totalActiveMin),
        avgSessionMinutes: sessions.length ? Number((totalActiveMin / sessions.length).toFixed(1)) : null,
        callsPerActiveHour: totalActiveMin > 0 ? Number((records.length / (totalActiveMin / 60)).toFixed(1)) : null,
        sampleFloor: MIN_SAMPLE_FOR_RATIO,
      },

      rapidapiPlan: {
        active: ACTIVE_RAPIDAPI_PLAN,
        price: plan.price,
        quota: plan.quota,
        ratePerCall: Number(plan.rate.toFixed(6)),
        callsInWindow: rapidCalls,
        projectedMonthlyCalls: Math.round(rapidMonthlyProjected),
        projectedQuotaUsed: Number((rapidMonthlyProjected / plan.quota).toFixed(4)),
        allPlans: RAPIDAPI_PLANS,
      },

      // Rows with no price on record are counted at $0, so every total is low
      // until the model is added to PRICING. The UI must say this out loud.
      integrity: { unpricedRows },

      // `activity` rows are zero-cost funnel milestones, not a cost source.
      // Including them in a spend composition injects a $0 category that reads
      // as "this provider is free" rather than "this is not a provider".
      // ── PER-USER, cost and activity kept as separate objects ──
      users: Object.values(users)
        .map((u) => {
          const ts = u.activity.timestamps.sort((a, b) => a - b);
          const sess = [];
          for (const t of ts) {
            const last = sess[sess.length - 1];
            if (!last || t - last.end > SESSION_GAP_MS) sess.push({ start: t, end: t });
            else last.end = t;
          }
          const activeMin = sess.reduce((a, x) => a + (x.end - x.start) / 60000, 0);
          const worked = u.activity.postsWorked.size;
          const published = u.activity.postsPublished.size;
          return {
            user: u.user,
            label: u.label,
            campaign: u.campaign,
            // What this person SPENT.
            cost: {
              calls: u.cost.calls,
              costUSD: r6(u.cost.costUSD),
              inputTokens: u.cost.inTok,
              outputTokens: u.cost.outTok,
              costPerWorkedPost: worked ? r6(u.cost.costUSD / worked) : null,
              costPerPublishedComment: published ? r6(u.cost.costUSD / published) : null,
              byProvider: Object.fromEntries(Object.entries(u.cost.byProvider).map(([k, v]) => [k, r6(v)])),
              byRoute: Object.fromEntries(
                Object.entries(u.cost.byRoute).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, r6(v)])
              ),
            },
            // What this person DID. No money in here by design.
            activity: {
              events: u.activity.events,
              postsTouched: u.activity.postsTouched.size,
              postsWorked: worked,
              commentsPublished: published,
              draftsGenerated: u.activity.drafts,
              regenerations: u.activity.regenerates,
              postsRegenerated: u.activity.postsRegenerated.size,
              regenerateRate: ratio(u.activity.postsRegenerated.size, worked),
              publishRate: ratio(published, worked),
              angleRequests: u.activity.angles,
              chatTurns: u.activity.chats,
              sessions: sess.length,
              activeMinutes: Math.round(activeMin),
              firstSeen: u.activity.firstSeen,
              lastSeen: u.activity.lastSeen,
            },
          };
        })
        .sort((a, b) => b.cost.costUSD - a.cost.costUSD),

      byUser: finish(byUser),
      byProvider: finish(
        Object.fromEntries(Object.entries(byProvider).filter(([p]) => p !== "activity"))
      ),
      activityEvents: byProvider.activity ? byProvider.activity.calls : 0,
      byDay: finish(byDay),
      byRoute: finish(byRoute),
      byModel: finish(byModel),
      byCampaign: finish(byCampaign),
      byHour: finish(byHour),

      // Newest-first detail rows for the drill-down table.
      recent: records
        .map((r) => r.fields || {})
        .sort((a, b) => String(b["Called At"] || "").localeCompare(String(a["Called At"] || "")))
        .slice(0, 300)
        .map((f) => ({
          calledAt: f["Called At"] || "",
          provider: f.Provider || "",
          route: f.Route || "",
          model: f.Model || "",
          inTok: Number(f["Input Tokens"]) || 0,
          outTok: Number(f["Output Tokens"]) || 0,
          cost: Number(f["Cost USD"]) || 0,
          shadow: Number(f["Shadow Cost USD"]) || 0,
          postKey: f["Post Key"] || "",
          campaign: f.Campaign || "",
          meta: f.Meta || "",
        })),

      caveats: [
        "RapidAPI is a monthly subscription. Attributed per-call cost is a share of a bill you already pay, not incremental spend.",
        `Shadow cost models scoring on ${SHADOW_MODEL}. It is a projection, not a bill.`,
        `Ratios are suppressed below ${MIN_SAMPLE_FOR_RATIO} observations and shown as no-data rather than as a misleading number.`,
      ],
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}
