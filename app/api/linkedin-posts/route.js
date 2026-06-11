import { NextResponse } from "next/server";
import OpenAI from "openai";
import { trackOpenAIUsage } from "@/lib/ai-usage";
import { pickLeadField } from "@/lib/lead-fields";
import { checkRoleFreshness } from "@/lib/role-freshness";
import { fetchActiveRelevanceRules } from "@/lib/relevance-rules";

// Role-freshness gate: confirm a lead still belongs to the company before we
// create an engagement task (Kunal, 2026-06-04 — never surface "engage with
// this CMO" after they've left). Default ON; set ROLE_GATE_ENABLED=false to
// disable. Fail-open by design: only a confident "left the company" suppresses.
const ROLE_GATE_ENABLED = process.env.ROLE_GATE_ENABLED !== "false";

// ═══════════════════════════════════════════════════════════════════════════
// LINKEDIN POSTS — FETCH + SCORE + CREATE TASKS
// ═══════════════════════════════════════════════════════════════════════════
//
// Flow per lead:
//   1. Extract username from LinkedIn URL → hit /user/profile to get URN
//   2. Hit /user/posts with URN → filter to last 7 days
//   3. Apply Apps-Script-style category filters (hiring/spam/etc) to skip junk
//   4. Send remaining posts to OpenAI for scoring (gpt-5.4-mini, JSON mode)
//   5. Apply category penalties on top of AI score
//   6. If adjusted_score >= threshold → append to Tasks table
//
// Critical design: progress + partial state persisted to Airtable after
// EACH lead, so a crash mid-scan doesn't lose work. A second run with
// mode=resume picks up where it left off.
// ═══════════════════════════════════════════════════════════════════════════

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = "fresh-linkedin-scraper-api.p.rapidapi.com";

const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

// ─── Airtable helpers ──────────────────────────────────────────
async function atList(baseId, table, params = {}) {
  const qs = new URLSearchParams();
  if (params.filterByFormula) qs.set("filterByFormula", params.filterByFormula);
  if (params.maxRecords) qs.set("maxRecords", params.maxRecords);
  if (params.fields) params.fields.forEach(f => qs.append("fields[]", f));
  let all = [], offset = null;
  do {
    const u = new URLSearchParams(qs);
    if (offset) u.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${u}`, { headers: atHdr });
    if (!r.ok) throw new Error(`Airtable list ${table}: ${r.status} ${await r.text().then(t => t.slice(0, 200))}`);
    const d = await r.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

async function atGet(baseId, table, id) {
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${id}`, { headers: atHdr });
  if (!r.ok) return null;
  return r.json();
}

async function atUpdate(baseId, table, id, fields) {
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${id}`, {
    method: "PATCH", headers: atHdr, body: JSON.stringify({ fields }),
  });
  if (!r.ok) throw new Error(`Airtable update ${table}/${id}: ${r.status} ${await r.text().then(t => t.slice(0, 200))}`);
  return r.json();
}

async function atCreateBatch(baseId, table, records) {
  const results = [];
  const errors = [];

  // Fields that MUST NEVER be stripped — task is broken without them. If
  // Airtable's error response somehow names one of these as the bad field
  // (e.g. malformed parse, regex over-match), we abort that record instead
  // of silently creating it with a critical field missing. Score is here
  // because a 0-score task is functionally a broken task — it sorts to the
  // bottom and the operator can't tell what the AI thought of the post.
  const CRITICAL_FIELDS = new Set(["Name", "Score", "Signal", "Task Type", "Source"]);

  // Iteratively strip unknown fields and retry. Airtable only tells us ONE bad field per error,
  // so if your schema is missing 3 fields, we need 3 retries. Max 10 to avoid infinite loops.
  async function tryBatchWithStripping(batch, strippedFields = []) {
    if (strippedFields.length > 10) {
      return { ok: false, error: `Gave up after stripping 10 fields: ${strippedFields.join(", ")}` };
    }
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST", headers: atHdr, body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (r.ok) {
      const d = await r.json();
      return { ok: true, records: d.records || [], strippedFields };
    }
    const errText = await r.text().then(t => t.slice(0, 500));
    // Match Airtable's error shape for unknown fields
    if (errText.includes("UNKNOWN_FIELD_NAME") || errText.includes("INVALID_VALUE_FOR_COLUMN")) {
      const m = errText.match(/[Uu]nknown field name:?\s*\\?"([^"\\]+)\\?"/)
        || errText.match(/Field\s+\\?"([^"\\]+)\\?"/)
        || errText.match(/"([^"]+)"\s+(?:does not exist|is not a valid column)/);
      const badField = m ? m[1] : null;
      if (badField) {
        // SAFEGUARD: never strip critical fields. If Airtable says one of
        // them is bad, surface the error — don't silently create broken tasks.
        if (CRITICAL_FIELDS.has(badField)) {
          console.error(`[linkedin-posts] REFUSING to strip critical field "${badField}". Airtable error: ${errText.slice(0, 300)}`);
          return { ok: false, error: `Critical field "${badField}" rejected by Airtable. Fix the schema or value type. Error: ${errText.slice(0, 200)}`, strippedFields };
        }
        console.warn(`[linkedin-posts] Stripping bad field "${badField}" from Tasks batch (attempt ${strippedFields.length + 1}). Error: ${errText.slice(0, 200)}`);
        const stripped = batch.map(rec => {
          const f = { ...rec.fields };
          delete f[badField];
          return { ...rec, fields: f };
        });
        return tryBatchWithStripping(stripped, [...strippedFields, badField]);
      }
    }
    return { ok: false, error: `${r.status}: ${errText}`, strippedFields };
  }

  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const result = await tryBatchWithStripping(batch);
    if (result.ok) {
      results.push(...result.records);
      if (result.strippedFields.length > 0) {
        console.log(`[linkedin-posts] Batch succeeded after stripping: ${result.strippedFields.join(", ")}`);
      }
    } else {
      console.error(`[linkedin-posts] Task batch failed permanently:`, result.error);
      errors.push(result.error);
    }
  }
  return { results, errors };
}

// Auto-create missing fields + retry (for status-progress field on Campaigns, or scoring fields on Leads)
async function atUpdateWithAutoCreate(baseId, table, id, fields, attempt = 0) {
  if (attempt > 6) return false;
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${id}`, {
    method: "PATCH", headers: atHdr, body: JSON.stringify({ fields, typecast: true }),
  });
  if (r.ok) return true;
  const errText = await r.text();
  if (errText.includes("UNKNOWN_FIELD_NAME") || errText.includes("INVALID_VALUE_FOR_COLUMN")) {
    const m = errText.match(/[Uu]nknown field name:?\s+\\?"([^"\\]+)\\?"/) || errText.match(/Field\s+\\?"([^"\\]+)\\?"/);
    const badField = m ? m[1] : null;
    if (badField) {
      // Try to create the field first
      try {
        const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: atHdr });
        if (tablesRes.ok) {
          const { tables } = await tablesRes.json();
          const t = tables.find(t => t.name === table);
          if (t) {
            // Pick field type based on name (longText for status JSON/notes, number for scores)
            const fieldType = /Score|Count|Total|Scanned|Processed|Remaining/i.test(badField) ? "number"
              : /Status|Progress|State|Log|Error/i.test(badField) ? "multilineText"
              : "singleLineText";
            const createBody = { name: badField, type: fieldType };
            if (fieldType === "number") createBody.options = { precision: 0 };
            const cr = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${t.id}/fields`, {
              method: "POST", headers: atHdr, body: JSON.stringify(createBody),
            });
            if (cr.ok) {
              console.log(`[linkedin-posts] Auto-created field "${badField}" on ${table}`);
              await new Promise(r => setTimeout(r, 1200));
              return atUpdateWithAutoCreate(baseId, table, id, fields, attempt + 1);
            }
          }
        }
      } catch (e) { console.error("Field create exception:", e.message); }
      // Strip the bad field and retry
      const newFields = { ...fields };
      delete newFields[badField];
      return atUpdateWithAutoCreate(baseId, table, id, newFields, attempt + 1);
    }
  }
  console.error(`[linkedin-posts] atUpdateWithAutoCreate failed (${r.status}):`, errText.slice(0, 200));
  return false;
}

// ─── LinkedIn URL parsing ──────────────────────────────────────
// Extract the public username from a LinkedIn profile URL.
// Handles: linkedin.com/in/username, linkedin.com/in/username/, with/without https, with trailing query
function extractLinkedInUsername(url) {
  if (!url) return null;
  const s = String(url).trim();
  const m = s.match(/linkedin\.com\/in\/([^\/\?#\s]+)/i);
  if (!m) return null;
  return decodeURIComponent(m[1]).trim().replace(/\/$/, "");
}

// Extract millisecond timestamp from a LinkedIn activity ID (upper 42 bits are the ms timestamp).
// Used as a FALLBACK if the API doesn't return a date field for a post.
function timestampFromActivityUrl(url) {
  if (!url) return null;
  const m = String(url).match(/activity[-:]?(\d{15,})/i);
  if (!m) return null;
  try {
    // BigInt-safe extraction since activity IDs exceed Number.MAX_SAFE_INTEGER
    const id = BigInt(m[1]);
    const ms = Number(id >> 22n);
    if (ms < 1262304000000 || ms > 1893456000000) return null; // sanity: 2010-2030
    return ms;
  } catch { return null; }
}

// ─── RapidAPI: Fresh LinkedIn Scraper ──────────────────────────
// Global throttle state for RapidAPI calls.
// PRO plan limits vary — observed ~30-60 requests/minute. We pace at ~1 req per 1.2s to stay safe.
// On a 429, we exponentially back off and also increase the minimum interval for this function's lifetime.
let rapidLastCallMs = 0;
let rapidMinIntervalMs = 1200; // starts at 1.2s, grows after 429s

async function rapidCall(path, params, { retries = 3, timeoutMs = 45000 } = {}) {
  if (!RAPIDAPI_KEY) return { ok: false, status: 0, error: "RAPIDAPI_KEY not set in Vercel env" };
  const qs = new URLSearchParams(params).toString();
  const url = `https://${RAPIDAPI_HOST}${path}?${qs}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    // Global throttle: ensure minimum interval between RapidAPI calls.
    // This is process-wide — all leads in this invocation share the same throttle.
    const sinceLast = Date.now() - rapidLastCallMs;
    if (sinceLast < rapidMinIntervalMs) {
      await new Promise(res => setTimeout(res, rapidMinIntervalMs - sinceLast));
    }
    rapidLastCallMs = Date.now();

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: { "x-rapidapi-key": RAPIDAPI_KEY, "x-rapidapi-host": RAPIDAPI_HOST },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      const text = await r.text();
      if (!r.ok) {
        // 429 = rate limit. Back off aggressively AND widen the throttle for this function's remaining life.
        if (r.status === 429 && attempt < retries) {
          // Grow the minimum interval permanently (for this invocation) — tells us we need to slow down
          rapidMinIntervalMs = Math.min(rapidMinIntervalMs * 1.5, 5000);
          // Back off for this specific retry: 3s, 6s, 12s
          const backoffMs = 3000 * Math.pow(2, attempt);
          console.warn(`[linkedin-posts] RapidAPI 429 — backing off ${backoffMs}ms, new min interval ${rapidMinIntervalMs}ms (attempt ${attempt + 1})`);
          await new Promise(res => setTimeout(res, backoffMs));
          continue;
        }
        // 503 = upstream overload — normal retry with short delay
        if (r.status === 503 && attempt < retries) {
          await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
          continue;
        }
        return { ok: false, status: r.status, error: text.slice(0, 300) };
      }
      try { return { ok: true, data: JSON.parse(text) }; }
      catch { return { ok: false, status: 200, error: "Invalid JSON from RapidAPI: " + text.slice(0, 200) }; }
    } catch (e) {
      clearTimeout(t);
      if (attempt < retries) { await new Promise(res => setTimeout(res, 1000)); continue; }
      return { ok: false, status: 0, error: e.message };
    }
  }
  return { ok: false, status: 0, error: "Exhausted retries" };
}

// Get the URN for a lead's LinkedIn URL. Required before fetching posts.
// Some leads may already have URN cached on their Airtable record — use that to save an API call.
async function getUrnForLead(lead, baseId) {
  const f = lead.fields || {};
  const cached = f["LinkedIn URN"];
  if (cached) return { urn: cached, cached: true };

  const url = f["LinkedIn URL"] || f["Linkedin URL"] || "";
  const username = extractLinkedInUsername(url);
  if (!username) return { error: `Invalid LinkedIn URL: "${url}"` };

  const r = await rapidCall("/api/v1/user/profile", { username });
  if (!r.ok) return { error: `Profile fetch failed (${r.status}): ${r.error}` };
  // Response structure varies — try all shapes
  const urn = r.data?.data?.urn
    || r.data?.data?.profile_urn
    || r.data?.data?.entity_urn
    || r.data?.urn
    || r.data?.profile_urn
    || r.data?.entity_urn
    || "";
  if (!urn) {
    console.error(`[linkedin-posts] No URN in response for ${username}:`, JSON.stringify(r.data).slice(0, 300));
    return { error: `No URN in profile response for ${username}` };
  }

  // Cache it so we skip this call next time
  try { await atUpdateWithAutoCreate(baseId, "Leads", lead.id, { "LinkedIn URN": urn }); } catch {}
  return { urn, username };
}

// Fetch posts for a URN. Paginates until we hit a post older than cutoff, collect N recent posts,
// OR we exhaust pages. maxPosts caps how many we keep.
//
// CRITICAL behavior: we trust the API's newest-first ordering. LinkedIn post APIs return posts
// in reverse chronological order. So even without a timestamp, the FIRST N posts are "probably recent".
// We use best-effort timestamp parsing to enforce a date cutoff, but accept undatable posts if they're
// among the first few in the response (assumed newest).
async function fetchPostsForUrn(urn, cutoffMs, maxPages = 3, maxPosts = 2) {
  const all = [];
  let reachedCutoff = false;
  let reachedMaxPosts = false;
  let undatableCount = 0;
  let rawReturnedCount = 0;
  let loggedSample = false;

  for (let page = 1; page <= maxPages && !reachedCutoff && !reachedMaxPosts; page++) {
    const r = await rapidCall("/api/v1/user/posts", { urn, page: String(page) });
    if (!r.ok) {
      return { ok: false, error: `Posts fetch page ${page} failed (${r.status}): ${r.error}`, posts: all, undatableCount, rawReturnedCount };
    }

    // Log the raw response structure ONCE per fetch so we can debug API shape changes
    if (!loggedSample && page === 1) {
      loggedSample = true;
      const sampleShape = {
        top_keys: Object.keys(r.data || {}).slice(0, 10),
        data_keys: r.data?.data ? Object.keys(r.data.data).slice(0, 10) : null,
        first_post_keys: null,
      };
      const firstPost = r.data?.data?.posts?.[0]
        || (Array.isArray(r.data?.data) ? r.data.data[0] : null)
        || r.data?.posts?.[0]
        || (Array.isArray(r.data) ? r.data[0] : null);
      if (firstPost && typeof firstPost === "object") {
        sampleShape.first_post_keys = Object.keys(firstPost).slice(0, 30);
        sampleShape.first_post_preview = JSON.stringify(firstPost).slice(0, 500);
      }
      console.log(`[linkedin-posts] RapidAPI response shape for URN ${urn}:`, JSON.stringify(sampleShape));
    }

    const posts = r.data?.data?.posts
      || (Array.isArray(r.data?.data) ? r.data.data : null)
      || r.data?.posts
      || (Array.isArray(r.data) ? r.data : null)
      || [];
    if (!Array.isArray(posts) || posts.length === 0) break;
    rawReturnedCount += posts.length;

    for (let idx = 0; idx < posts.length; idx++) {
      const p = posts[idx];
      // Extract post timestamp — field names vary across API responses.
      let ts = null;
      const candidates = [
        p.posted_at_timestamp, p.posted_at, p.postedAt, p.published_at,
        p.publishedAt, p.date, p.timestamp, p.created_at,
        p.posted_date, p.time, p.createdAt,
        p.posted_at?.timestamp, p.posted_at?.date,
        p.time_info?.timestamp, p.time_info?.posted_at,
        p.metadata?.posted_at, p.metadata?.timestamp,
      ];
      for (const c of candidates) {
        if (!c) continue;
        if (typeof c === "number") { ts = c < 1e12 ? c * 1000 : c; break; }
        if (typeof c === "object") continue;
        const parsed = new Date(c).getTime();
        if (!isNaN(parsed) && parsed > 1262304000000) { ts = parsed; break; }
      }
      // Fallback: extract from activity URL (LinkedIn embeds unix ms in the ID)
      if (!ts) ts = timestampFromActivityUrl(p.post_url || p.url || p.share_url || p.activity_url || "");

      // Extract text up-front so we can decide what to do with undatable posts
      const textSource = p.text || p.post_text || p.content || p.commentary || p.description || "";
      const text = (typeof textSource === "string" ? textSource : String(textSource || "")).trim();

      if (!ts) {
        undatableCount++;
        // If this is one of the first 3 posts in the response AND it has meaningful
        // text, accept it. Posts are newest-first, so first 3 are almost certainly
        // within the 7-day window. This is a pragmatic fallback — better than
        // rejecting every post when API schema changes. Same <30-char text gate as
        // the dated path: media-only posts have nothing to score on.
        if (idx < 3 && text.length >= 30) {
          // Log the rejected-schema for debugging, just once
          if (undatableCount <= 2) {
            console.warn(`[linkedin-posts] Accepting undatable post (idx=${idx}, assumed recent):`, {
              keys: Object.keys(p).slice(0, 20),
              text_preview: text.slice(0, 100),
            });
          }
          all.push({
            text,
            date: new Date().toISOString(), // best guess: now
            url: p.post_url || p.url || p.share_url || "",
            urn: p.urn || p.post_urn || p.activity_urn || "",
            likes: p.total_reactions || p.likes_count || p.likes || 0,
            comments: p.comments_count || p.comments || 0,
            reposts: p.reposts_count || p.reposts || 0,
            is_repost: !!(p.reshared || p.is_repost || p.reposted_post),
            _undated: true, // flag so we know this one's date is a guess
          });
          if (all.length >= maxPosts) { reachedMaxPosts = true; break; }
        }
        // If it's deeper in the response, skip — likely old content
        continue;
      }

      // Hard 7-day filter — skip anything older
      if (ts < cutoffMs) {
        reachedCutoff = true;
        continue;
      }

      // Skip posts without meaningful text. Kunal (Jun 9): an image/video-only
      // post has no text to reason over — don't fetch/score the media, just drop
      // it. Scoring stays purely text-based (matches Material). The provider does
      // not return media bytes here anyway; a trimmed length < 30 chars means
      // there's no substantive caption worth a scoring call.
      if (!text || text.length < 30) continue;

      all.push({
        text,
        date: new Date(ts).toISOString(),
        url: p.post_url || p.url || p.share_url || "",
        urn: p.urn || p.post_urn || p.activity_urn || "",
        likes: p.total_reactions || p.likes_count || p.likes || 0,
        comments: p.comments_count || p.comments || 0,
        reposts: p.reposts_count || p.reposts || 0,
        is_repost: !!(p.reshared || p.is_repost || p.reposted_post),
      });

      if (all.length >= maxPosts) { reachedMaxPosts = true; break; }
    }

    // Small delay between pages to be nice to the API
    if (page < maxPages && !reachedCutoff && !reachedMaxPosts) await new Promise(r => setTimeout(r, 400));
  }

  return { ok: true, posts: all, undatableCount, rawReturnedCount, reachedMaxPosts };
}

// ═══════════════════════════════════════════════════════════════════════════
// APPS-SCRIPT-STYLE CATEGORY FILTERS (ported to JS)
// Applied BEFORE AI scoring to save API costs, AND again AFTER to adjust scores.
// ═══════════════════════════════════════════════════════════════════════════

const HIRING_SIGNALS = [
  "hiring", "#hiring", "we're hiring", "we are hiring",
  "open role", "open roles", "open position", "open positions",
  "join our team", "join my team", "come join",
  "#opentowork", "open to work", "#lookingforwork", "open to opportunities",
  "we're looking for", "we are looking for", "i'm looking for a",
  "looking to hire", "is growing!",
  "apply now", "apply here", "apply today", "apply below",
  "job posting", "job opportunity", "job alert",
  "dm me if interested", "send me your resume",
  "recruiting", "we need a", "new opening", "new openings",
  "talent acquisition", "please share with your network if you know",
  "vacancy", "vacancies",
  "we're growing", "my team is hiring", "i'm #hiring",
  "know anyone who might be a good fit",
  "call for speakers",
];

const LINKEDIN_SPAM_SIGNALS = [
  "just finished the course", "i've obtained a new certification",
  "obtained a new certification", "completed a course", "earned a badge",
  "just completed", "happy to share that i've obtained",
  "i'm happy to share that i've obtained",
  "earned the following badge", "new certification:",
  "certificate from coursera", "certificate from linkedin",
  "finished a linkedin learning", "just earned",
  "#certificateofcompletion", "course certificate",
  "linkedin learning course", "passed the exam",
];

const FAREWELL_SIGNALS = [
  "today is my last day", "my last day at", "leaving after",
  "moving on from", "final day at", "end of my time at",
  "i completed my assignment", "farewell to", "signing off from",
  "wrapping up my time", "last week at", "goodbye to my",
  "bittersweet to say goodbye",
];

const SELF_PROMO_SIGNALS = [
  "i'm thrilled to announce", "excited to share that i",
  "i'm honored", "i am honored", "proud to announce",
  "i've been promoted", "starting a new position",
  "i've joined", "i have joined", "just started at",
  "thrilled to join", "excited to join",
  "pleased to share that i have been",
  "new chapter", "next adventure",
  "started a new position", "new position as",
  "accepted an offer", "beginning my journey at",
  "first day at", "first week at",
  "i'm happy to share that i started",
  "happy to share that i started",
  "excited to announce", "i'm excited to join", "i'm excited to share",
  "officially a #noogler", "#noogler",
];

const EVENT_PROMO_SIGNALS = [
  "join us at", "register now", "sign up for",
  "upcoming webinar", "upcoming event", "save the date",
  "link in comments to register", "rsvp",
  "join me at", "speaking at", "presenting at",
  "tune in", "watch live", "catch the live stream",
  "live stream at", "streaming live", "watch the replay",
  "link to register", "register here", "grab your spot",
  "reserve your seat",
];

const ENGAGEMENT_BAIT_SIGNALS = [
  "agree or disagree", "like if you agree",
  "repost if", "share if", "tag someone who",
];

// ─── NEW CATEGORIES — catch the false positives your current filter misses ───

// Holiday/greetings — should never become tasks
const HOLIDAY_SIGNALS = [
  "happy diwali", "happy new year", "happy holi", "happy eid", "eid mubarak",
  "merry christmas", "happy christmas", "happy thanksgiving", "happy easter",
  "happy holidays", "happy weekend", "happy fourth of july", "happy 4th of july",
  "happy independence day", "happy republic day", "happy labor day", "happy labour day",
  "happy mother's day", "happy mothers day", "happy father's day", "happy fathers day",
  "happy valentine's day", "happy valentines day", "happy women's day", "happy womens day",
  "international women's day", "international womens day",
  "happy hanukkah", "happy ramadan", "ramadan mubarak", "ramadan kareem",
  "joyeux noel", "feliz navidad", "feliz año nuevo",
  "season's greetings", "seasons greetings", "festive season",
  "wishing you all a", "wishing everyone a", "wishing you and your",
];

// Work anniversaries — ALWAYS personal celebration, never buying signals
const ANNIVERSARY_SIGNALS = [
  "work anniversary", "workiversary", "#workanniversary",
  "1 year at ", "2 years at ", "3 years at ", "4 years at ", "5 years at ",
  "6 years at ", "7 years at ", "8 years at ", "9 years at ", "10 years at ",
  "15 years at ", "20 years at ", "25 years at ",
  "1 year ago today", "2 years ago today", "3 years ago today",
  "5 years ago today", "10 years ago today",
  "celebrating my ", "celebrating years at", "th anniversary at",
  "i joined ", // common "reflecting on X years since I joined"
  "reflecting on my time at",
  "time at my company",
];

// Birthday posts
const BIRTHDAY_SIGNALS = [
  "happy birthday", "birthday to", "#birthday", "hbd ",
  "feliz cumpleaños", "birthday wishes",
];

// Award / recognition — self-promotion, near-zero signal value
const AWARD_SIGNALS = [
  "honored to be named", "honored to receive", "honored to be recognized",
  "proud to be named", "proud to be recognized", "proud to receive",
  "named in the top", "named one of the top", "named to the",
  "recognized as", "recognized by ", "recognized for",
  "received the ", "awarded the ", "won the award",
  "#award", "industry award", "recognition from",
  "certified ", "certification from",
  "named a fellow", "elected as a fellow",
  "forbes 30 under 30", "forbes list",
  "best place to work", "great place to work certified",
  "finalist for", "nominated for",
];

// Thank-you / gratitude posts — rarely contain buying signals
const GRATITUDE_SIGNALS = [
  "thank you to everyone who", "thank you all for",
  "grateful to everyone", "i'm grateful to", "i am grateful to",
  "heartfelt thanks", "huge thank you",
  "appreciate everyone who", "couldn't have done it without",
  "shoutout to my team", "thanks to my incredible team",
];

// Condolences — never a signal
const CONDOLENCE_SIGNALS = [
  "passing of", "passed away", "rest in peace", "rip ",
  "sad to hear", "deeply saddened", "heartfelt condolences",
  "our thoughts are with", "remembering ", "in memoriam",
  "with a heavy heart",
];

// Generic motivational / quote posts
const MOTIVATIONAL_SIGNALS = [
  "monday motivation", "#mondaymotivation", "monday vibes",
  "friday feeling", "tgif", "#friyay",
  "food for thought", "some thoughts on ",
  "3 lessons learned", "5 lessons learned", "7 lessons learned",
  "10 lessons", "things i've learned", "what i learned this week",
  "lessons from my", "my top 5", "my top 10",
  "#inspiration", "#motivation", "stay positive",
];

// Reshares with minimal commentary — "reposting this because..." with 1-2 words
const RESHARE_SIGNALS = [
  "reposting this", "resharing this", "sharing this here",
  "worth a read", "great read", "must read",
  "check this out", "don't miss this", "thought-provoking read",
  "loved this", "fantastic insights from",
];

// Book / podcast / content promos
const CONTENT_PROMO_SIGNALS = [
  "my new book", "new book is out", "buy my book",
  "my latest book", "my podcast", "latest podcast episode",
  "check out my latest", "tune into my podcast",
  "my youtube channel", "subscribe to my channel",
  "my newsletter", "subscribe to my newsletter",
  "link to my article", "my article in",
];

// Funding / fundraising announcements — usually not a pain signal (they just closed it)
const FUNDING_ANNOUNCEMENT_SIGNALS = [
  "we've raised", "we have raised", "just raised",
  "our series a", "our series b", "our series c", "our seed round",
  "closed our round", "announcing our funding",
];

function categorizePost(text) {
  if (!text) return { category: "unknown", penalty: -100 };
  // Normalize smart quotes + padding
  let lower = " " + text.toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"') + " ";

  // Order matters — most-obvious-junk first so we don't waste AI on definite skips.
  // Penalty of -100 means it'll be floored to 0 regardless of AI score.
  const checks = [
    { signals: HOLIDAY_SIGNALS, category: "holiday", penalty: -100, hardSkip: true },
    { signals: ANNIVERSARY_SIGNALS, category: "anniversary", penalty: -100, hardSkip: true },
    { signals: BIRTHDAY_SIGNALS, category: "birthday", penalty: -100, hardSkip: true },
    { signals: CONDOLENCE_SIGNALS, category: "condolence", penalty: -100, hardSkip: true },
    { signals: HIRING_SIGNALS, category: "hiring", penalty: -100, hardSkip: true },
    { signals: LINKEDIN_SPAM_SIGNALS, category: "linkedin_spam", penalty: -100, hardSkip: true },
    { signals: FAREWELL_SIGNALS, category: "farewell", penalty: -100, hardSkip: true },
    { signals: AWARD_SIGNALS, category: "award", penalty: -70 },
    { signals: GRATITUDE_SIGNALS, category: "gratitude", penalty: -60 },
    { signals: CONTENT_PROMO_SIGNALS, category: "content_promo", penalty: -50 },
    { signals: FUNDING_ANNOUNCEMENT_SIGNALS, category: "funding_announcement", penalty: -40 },
    { signals: SELF_PROMO_SIGNALS, category: "self_promo", penalty: -50 },
    { signals: MOTIVATIONAL_SIGNALS, category: "motivational", penalty: -40 },
    { signals: RESHARE_SIGNALS, category: "reshare_minimal", penalty: -40 },
    { signals: EVENT_PROMO_SIGNALS, category: "event_promo", penalty: -25 },
    { signals: ENGAGEMENT_BAIT_SIGNALS, category: "engagement_bait", penalty: -20 },
  ];

  for (const check of checks) {
    for (const signal of check.signals) {
      if (lower.indexOf(signal) !== -1) return { category: check.category, penalty: check.penalty, hardSkip: !!check.hardSkip };
    }
  }

  // Thin content: < 40 words after stripping URLs
  const textNoUrls = lower.replace(/https?:\/\/[^\s]+/g, "").trim();
  const wordCount = textNoUrls.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount < 40) return { category: "thin_content", penalty: -50 };
  if (wordCount < 80) return { category: "short_content", penalty: -20 };

  return { category: "genuine_content", penalty: 0 };
}

// Categories that CANNOT become tasks regardless of AI score.
// These are structurally not buying signals — no amount of AI optimism changes that.
const NEVER_TASK_CATEGORIES = new Set([
  "holiday", "anniversary", "birthday", "condolence",
  "hiring", "linkedin_spam", "farewell",
  "award", "gratitude",
]);

// Post types (from AI) that CAN become tasks. Anything else is structurally not a buying signal.
const VALID_TASK_POST_TYPES = new Set([
  "pain_point", "project_announcement", "question_to_network",
  "thought_leadership", "industry_news", "event_announcement", "other",
]);

// Hard score ceilings per category. Even if AI scores 95, if category is "motivational", cap at 30.
const CATEGORY_SCORE_CEILING = {
  holiday: 5, anniversary: 5, birthday: 5, condolence: 5,
  hiring: 10, linkedin_spam: 10, farewell: 10,
  award: 25, gratitude: 30,
  content_promo: 35, self_promo: 35, motivational: 35,
  reshare_minimal: 40, funding_announcement: 40,
  event_promo: 55, engagement_bait: 55,
  thin_content: 50, short_content: 70,
  genuine_content: 100, unknown: 60,
};

// ═══════════════════════════════════════════════════════════════════════════
// OPENAI SCORING
// ═══════════════════════════════════════════════════════════════════════════
//
// DEFAULT MODE: Campaign-agnostic post-quality scoring.
// Scores "is this a substantive post worth engaging with?" — NOT "does this reveal buying intent?"
// This matches how users typically work LinkedIn: they comment on good posts to warm up leads,
// not only when the post reveals a sales opportunity.
//
// CUSTOM MODE: Pass systemPromptOverride for sales-relevance scoring tied to a specific ICP.
//
// Output schema (JSON, enforced via response_format):
//   relevance_score: integer 1-100 (engagement quality score)
//   relevance_rationale, evidence_quote, structured_sentence, suggested_comment, post_type

function defaultScoringSystemPrompt(campaignContext) {
  // campaignContext is IGNORED in default mode — scoring is post-quality only, no sales framing.
  // If user wants sales framing, they must paste a custom prompt.
  return `ROLE
You score LinkedIn posts for ENGAGEMENT-WORTHINESS. Return JSON only.

GOAL
You are scoring: "Is this post substantive enough for a human to leave a thoughtful, non-salesy comment on it?"

You are NOT scoring sales relevance, buying intent, or product fit. Ignore whether the post mentions any specific industry, product, or pain point.

A substantive post:
- Has an original perspective, framework, observation, or concrete example
- Articulates a real opinion or asks a genuine question
- Gives the reader something to react to or extend
- Is the author's own thinking, not a generic celebration or rewrap

A non-substantive post:
- Celebrates a personal milestone (birthday, anniversary, holiday, award)
- Thanks a team without context
- Reshares someone else's content with 1-2 sentences of token praise
- Is pure motivational fluff or generic enthusiasm
- Is self-promotional (book/podcast/course announcements, hiring, farewell)

SCORING RUBRIC — use these anchors strictly:

1-15 JUNK. No one should comment on this for business reasons.
- Holiday greetings, birthdays, anniversaries, condolences
- Work anniversaries, farewells, award announcements
- Course completion / certification spam

16-30 LOW VALUE. Technically on LinkedIn but not worth engaging.
- Thank-you posts to team without substance
- Self-promo (book launch, podcast plug, newsletter promo)
- Pure motivational / "5 lessons I learned this week" without depth
- Hiring posts, job listings

31-45 MEH. Some signal but thin.
- Reshare of a third-party article with brief commentary
- Event announcements, "join me at..." posts
- Funding round announcements
- Generic enthusiasm ("excited about the future of X!")
- Very short posts (< 80 words of substantive content)
- Engagement bait ("agree or disagree?", "repost if...")

46-65 DECENT. Engagement has some value but post is routine.
- Thought leadership piece with a standard industry take
- Event recap with basic observations
- Reshare with 3-4 sentences of own analysis
- Question to network that's somewhat open-ended
- Industry observation without concrete data or example

66-85 GOOD. Clearly worth commenting on.
- Substantive thought leadership with original perspective
- Specific observation backed by data, numbers, or a concrete example
- Sharp opinion that invites debate
- Specific question that a commenter could genuinely answer
- Lessons from a real project with specifics

86-100 EXCELLENT. High-quality post, priority to engage.
- Articulates a genuine pain point or challenge they're working through
- Asks their network for recommendations/help/input on a real decision
- Announces a major initiative in substantive detail
- Takes a strong, unusual position with reasoning
- Shares a framework or breakdown original to the author

CRITICAL RULES:
1. DEFAULT LOW. Score above 60 requires the author's own substantive thought — not just a topic.
2. Reshares (starts with "Reposting", "Great read", "Must read", "Sharing this"): max 35.
3. Posts under 80 words of substantive content (URLs/hashtags excluded): max 50.
4. If evidence_quote is "NO_SPECIFIC_EVIDENCE" or the post has no substantive sentence: score must be <=25.
5. Holiday/birthday/anniversary/condolence/award/farewell: 1-10 regardless of other content.
6. Generic enthusiasm without substance ("Excited about the future of X!", "Loved today's panel"): max 25.
7. Ignore name/title/company. Judge purely on post content.

OUTPUT JSON (no other text, no markdown):
{
  "post_type": string, one of: "holiday" | "anniversary" | "birthday" | "award" | "gratitude" | "condolence" | "hiring" | "farewell" | "self_promo" | "content_promo" | "motivational" | "reshare" | "thought_leadership" | "industry_news" | "event_announcement" | "pain_point" | "project_announcement" | "question_to_network" | "personal" | "other",
  "relevance_score": integer 1-100 (engagement-worthiness score),
  "evidence_quote": string <=25 words — the EXACT sentence from the post that justifies your score. If no substantive content, write "NO_SPECIFIC_EVIDENCE" and score must be <=25.
  "relevance_rationale": string <=40 words — what makes this post engagement-worthy (or why not).
  "structured_sentence": string <=20 words, format: "{Full name}, {simplified title} at {simplified company} posted about {neutral 15-word summary}",
  "suggested_comment": string <=20 words, MUST start with 'You could comment' or 'You could highlight'. Must reference specific content from THIS post, not generic pleasantries.
}`;
}

async function scorePost({ post, lead, campaignContext, systemPromptOverride, categoryHint, campaignId = null, reviewerFeedback = "" }) {
  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  const f = lead.fields || {};
  const fullName = f.Name || f["Full Name"] || ((f["First Name"] || "") + " " + (f["Last Name"] || "")).trim() || "Unknown";
  const title = f.Title || f.title || "";
  const company = f.Company || f.company || "";

  const userPayload = {
    full_name: fullName,
    title,
    company,
    post_text: (post.text || "").slice(0, 3000),
    // Category hint helps the model calibrate (pre-filter already applied a label)
    pre_filter_category: categoryHint || "genuine_content",
  };

  let systemPrompt = systemPromptOverride && systemPromptOverride.trim()
    ? systemPromptOverride
    : defaultScoringSystemPrompt(campaignContext);
  // Reviewer feedback memory — Signal Review demotes/promotes of linkedin_engagement
  // tasks, stored on the master Campaigns row ("LinkedIn Posts Feedback"). Injected
  // so a human-corrected scoring mistake isn't repeated on the next scan.
  const fb = String(reviewerFeedback || "").trim().slice(0, 4000);
  if (fb) {
    systemPrompt += `\n\nREVIEWER FEEDBACK — human corrections on past post scoring for this campaign (most recent last). DEMOTED = the AI's score was too HIGH for that post; score similar posts LOWER. PROMOTED = too LOW; score similar posts HIGHER. Apply these corrections; do NOT repeat these mistakes:\n${fb}`;
  }

  try {
    const c = await openai.chat.completions.create({
      // Upgraded from gpt-5.4-mini 2026-06-10 (Samarth): full gpt-5.4 for
      // post engagement scoring — fewer mis-bucketed/fluff-scored posts.
      model: "gpt-5.4",
      temperature: 0.1, // very low — we want consistency, not creativity
      max_completion_tokens: 500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(userPayload, null, 2) },
      ],
    });
    trackOpenAIUsage({ campaignId, completion: c, action: "score_linkedin_post" });
    const raw = c.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      return { ok: false, error: `JSON parse failed: ${raw.slice(0, 200)}` };
    }

    let score = Math.max(0, Math.min(100, Math.round(Number(parsed.relevance_score) || 0)));
    const evidenceQuote = String(parsed.evidence_quote || "").slice(0, 300);
    const postType = String(parsed.post_type || "other").toLowerCase();
    const rationale = String(parsed.relevance_rationale || "").slice(0, 500);

    // ─── SANITY CHECK LAYER — catches AI over-scoring ───
    // Even with strict rubric, models sometimes score 80+ on fluff. Enforce the rules in code.
    const sanityFlags = [];

    // Rule: no specific evidence → cap at 25
    if (!evidenceQuote || evidenceQuote === "NO_SPECIFIC_EVIDENCE" || evidenceQuote.length < 10) {
      if (score > 25) { sanityFlags.push(`no_evidence → capped 25`); score = Math.min(score, 25); }
    }
    // Rule: post_type has a quality ceiling. Matches the post-quality rubric above.
    // Thought leadership and industry news CAN be genuinely engagement-worthy (not just sales-relevant)
    // so they get higher ceilings in this mode.
    const postTypeCeiling = {
      holiday: 5, anniversary: 5, birthday: 5, condolence: 5,
      hiring: 10, farewell: 10, award: 15, gratitude: 20,
      self_promo: 25, content_promo: 25, motivational: 30,
      reshare: 35, event_announcement: 45, personal: 15,
      thought_leadership: 85, industry_news: 70,
      pain_point: 100, project_announcement: 95, question_to_network: 90,
      other: 70,
    };
    const ceiling = postTypeCeiling[postType];
    if (ceiling != null && score > ceiling) {
      sanityFlags.push(`post_type="${postType}" → capped ${ceiling}`);
      score = ceiling;
    }
    // Rule: rationale must reference the evidence quote if score > 55
    if (score > 55 && evidenceQuote && evidenceQuote !== "NO_SPECIFIC_EVIDENCE") {
      const quoteWords = evidenceQuote.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      const rationaleLower = rationale.toLowerCase();
      const matchCount = quoteWords.filter(w => rationaleLower.includes(w)).length;
      if (quoteWords.length >= 3 && matchCount < 1) {
        sanityFlags.push(`rationale_disconnected_from_evidence → capped 50`);
        score = Math.min(score, 50);
      }
    }

    return {
      ok: true,
      relevance_score: score,
      raw_ai_score: Math.max(0, Math.min(100, Math.round(Number(parsed.relevance_score) || 0))),
      relevance_rationale: rationale,
      evidence_quote: evidenceQuote,
      post_type: postType,
      structured_sentence: String(parsed.structured_sentence || "").slice(0, 300),
      suggested_comment: String(parsed.suggested_comment || "").slice(0, 300),
      sanity_flags: sanityFlags,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PROGRESS PERSISTENCE — writes to Campaigns.LinkedIn Post Scan Status
// The status is a JSON string so the frontend can parse and render a live view.
// ═══════════════════════════════════════════════════════════════════════════

async function writeProgress(campaignAirtableId, state) {
  if (!campaignAirtableId) return;
  try {
    // Defensive caps so we never overflow Airtable's 100KB multilineText limit.
    // The concerning fields are arrays that can grow unboundedly:
    //   - completed_lead_ids: capped at 5000 (scan of more than this needs different architecture anyway)
    //   - errors: capped at 200 most recent (old ones dropped with a hint)
    const safe = { ...state };
    if (Array.isArray(safe.completed_lead_ids) && safe.completed_lead_ids.length > 5000) {
      safe.completed_lead_ids = safe.completed_lead_ids.slice(-5000);
    }
    if (Array.isArray(safe.errors) && safe.errors.length > 200) {
      const dropped = safe.errors.length - 200;
      safe.errors = [`[${dropped} older errors dropped to fit Airtable field limit]`, ...safe.errors.slice(-199)];
    }
    const serialized = JSON.stringify({ ...safe, updated_at: new Date().toISOString() });
    if (serialized.length > 95000) {
      // Last-resort trim: strip completed_lead_ids entirely (keeps everything else readable)
      const minimal = { ...safe, completed_lead_ids: safe.completed_lead_ids?.slice(-1000) || [] };
      await atUpdateWithAutoCreate(MASTER_BASE_ID, "Campaigns", campaignAirtableId, {
        "LinkedIn Post Scan Status": JSON.stringify({ ...minimal, updated_at: new Date().toISOString(), _truncated: true }),
      });
    } else {
      await atUpdateWithAutoCreate(MASTER_BASE_ID, "Campaigns", campaignAirtableId, {
        "LinkedIn Post Scan Status": serialized,
      });
    }
  } catch (e) {
    console.error("[linkedin-posts] Failed to write progress:", e.message);
  }
}

async function readProgress(campaignAirtableId) {
  if (!campaignAirtableId) return null;
  const rec = await atGet(MASTER_BASE_ID, "Campaigns", campaignAirtableId);
  if (!rec) return null;
  const raw = rec.fields?.["LinkedIn Post Scan Status"];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN SCAN FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

async function runLinkedInPostScan({
  baseId,
  campaignAirtableId,
  leadIds,        // optional: specific lead Airtable IDs (mutually exclusive with whole-campaign)
  scoreThreshold = 70, // posts below this (after category adjustment) are NOT turned into tasks
  daysBack = 7,
  taskRuleName = "LinkedIn Post Engagement",
  systemPromptOverride,
  resume = false, // if true, skip leads that already appear in progress.completed
  timeBudgetMs = 270_000, // 270s default for UI runs; cron passes 25_000 for fast returns
}) {
  const startedAt = new Date().toISOString();
  const cutoffMs = Date.now() - (daysBack * 24 * 60 * 60 * 1000);

  // Load campaign for context
  let campaignContext = "";
  let campaignName = "";
  let reviewerFeedback = ""; // Signal Review demote/promote memory for linkedin_engagement
  if (campaignAirtableId) {
    const camp = await atGet(MASTER_BASE_ID, "Campaigns", campaignAirtableId);
    if (camp) {
      campaignContext = camp.fields?.["Email Reference"] || camp.fields?.["ICP Description"] || camp.fields?.["Campaign Context"] || "";
      campaignName = camp.fields?.Name || camp.fields?.["Campaign Name"] || "";
      reviewerFeedback = camp.fields?.["LinkedIn Posts Feedback"] || "";
    }
  }

  // Note: old-task cleanup is handled at the handler level (see the "scan" case in POST),
  // not here. If autoCleanupDays was passed, stale tasks have already been deleted before
  // this function was called, so the existingTaskUrls dedupe set below will naturally reflect
  // the post-cleanup state.

  // Load prior progress first — needed for resume to know original scope (leadIds may be null on resume calls)
  const prior = await readProgress(campaignAirtableId);
  // On resume, if the original scan was scoped to specific leadIds, use that scope.
  // (Cron-triggered resumes don't pass leadIds, so this restores the original subset.)
  let effectiveLeadIds = leadIds;
  if (resume && !effectiveLeadIds?.length && prior?.original_lead_ids?.length) {
    effectiveLeadIds = prior.original_lead_ids;
  }

  // Load leads. For "specific leads", it's still faster to list all and filter
  // than to hit atGet for each ID (N sequential API calls vs one paginated list).
  let leads = await atList(baseId, "Leads");
  if (effectiveLeadIds?.length) {
    const idSet = new Set(effectiveLeadIds);
    leads = leads.filter(l => idSet.has(l.id));
  }

  // Filter to those with LinkedIn URL
  leads = leads.filter(l => (l.fields?.["LinkedIn URL"] || l.fields?.["Linkedin URL"] || "").trim());

  // ─── Best-effort relevance pre-skip (token / RapidAPI saver) ──────
  // Secondary to the feed read-filter (which is the correctness guarantee).
  // If the operator already suppressed the whole linkedin_engagement signal,
  // or a lead's title/company matches an active suppression rule, skip the
  // expensive provider call up front. NEVER throws → [] on missing table, so
  // un-migrated bases / any failure = no change in behaviour.
  try {
    const relRules = await fetchActiveRelevanceRules(baseId);
    if (relRules.length) {
      const titleNeedles = relRules.filter(r => r.kind === "title_irrelevant").map(r => String(r.value || "").toLowerCase()).filter(Boolean);
      const companyNeedles = relRules.filter(r => r.kind === "company_irrelevant").map(r => String(r.value || "").toLowerCase()).filter(Boolean);
      const signalSuppressed = relRules.some(r => r.kind === "signal_irrelevant" &&
        String(r.value || "").toLowerCase().includes("linkedin_engagement"));
      if (signalSuppressed) {
        leads = [];
      } else if (titleNeedles.length || companyNeedles.length) {
        leads = leads.filter(l => {
          const f = l.fields || {};
          const title = String(pickLeadField(f, "title") || "").toLowerCase();
          const company = String(f.Company || "").toLowerCase();
          if (titleNeedles.some(n => title.includes(n))) return false;
          if (companyNeedles.some(n => company.includes(n))) return false;
          return true;
        });
      }
    }
  } catch { /* best-effort only — read-side suppression still guards the feed */ }

  // Resume mode: skip leads already processed in the saved progress record
  const completedLeadIds = new Set(resume ? (prior?.completed_lead_ids || []) : []);
  if (resume && completedLeadIds.size > 0) {
    leads = leads.filter(l => !completedLeadIds.has(l.id));
    console.log(`[linkedin-posts] Resume: skipping ${completedLeadIds.size} already-processed leads, ${leads.length} remaining`);
  }

  // Initialize progress
  const progress = {
    phase: "starting",
    status: "running",
    started_at: prior?.started_at || startedAt,
    campaign: campaignName,
    total_leads: leads.length + completedLeadIds.size,
    leads_done: completedLeadIds.size,
    leads_remaining: leads.length,
    current_lead: null,
    current_lead_step: null,
    posts_fetched: prior?.posts_fetched || 0,
    posts_scored: prior?.posts_scored || 0,
    posts_filtered_out: prior?.posts_filtered_out || 0,
    posts_deduped: prior?.posts_deduped || 0,
    tasks_created: prior?.tasks_created || 0,
    errors: prior?.errors || [],
    completed_lead_ids: Array.from(completedLeadIds),
    // Scan config persisted so external cron resume knows how to call runLinkedInPostScan
    score_threshold: scoreThreshold,
    days_back: daysBack,
    task_rule_name: taskRuleName,
    system_prompt_override: systemPromptOverride || null,
    // Persist the scan's lead scope. On a FRESH scan (resume=false) use THIS run's leadIds —
    // a new scoped run must NOT inherit a previous completed scan's scope (that hijacks it back
    // onto the old lead set). On resume, preserve the original scope so cron-triggered resumes
    // (which pass no leadIds) stay scoped to the same subset.
    original_lead_ids: resume ? (prior?.original_lead_ids || null) : (leadIds || null),
    last_log: "Scan started",
  };
  await writeProgress(campaignAirtableId, progress);

  if (leads.length === 0) {
    progress.phase = "done";
    progress.status = "complete";
    progress.last_log = resume ? "Nothing to resume — all leads already processed" : "No leads with LinkedIn URL to scan";
    progress.ended_at = new Date().toISOString();
    await writeProgress(campaignAirtableId, progress);
    return progress;
  }

  // Pre-load existing task URLs for dedup — prevents re-creating tasks for posts we already processed.
  // Scope: tasks with this Task Rule, created in last N days (default 14).
  // Why 14 days: longer than the 7-day post window + buffer for weekly scan cadence.
  // A post URL is permanent on LinkedIn so same URL = same post content.
  const dedupLookbackDays = 14;
  const dedupCutoffISO = new Date(Date.now() - dedupLookbackDays * 86400000).toISOString();
  const existingTaskUrls = new Set();
  try {
    const escapedRule = (taskRuleName || "").replace(/"/g, '\\"');
    const formula = `AND({Task Rule} = "${escapedRule}", IS_AFTER({Created}, "${dedupCutoffISO}"), {URL} != "")`;
    const existing = await atList(baseId, "Tasks", { filterByFormula: formula, fields: ["URL"] });
    for (const rec of existing) {
      const url = rec.fields?.URL;
      if (url) existingTaskUrls.add(String(url).trim());
    }
    progress.last_log = `Pre-loaded ${existingTaskUrls.size} existing task URL(s) for dedup (last ${dedupLookbackDays} days).`;
    await writeProgress(campaignAirtableId, progress);
  } catch (e) {
    console.error("[linkedin-posts] Dedup pre-load failed:", e.message);
    // Continue without dedup — better to risk duplicates than block the scan
  }

  const rollupCategoryCounts = prior?.category_counts || {};

  // Time budget: we must return BEFORE Vercel kills the function.
  // Fluid Compute on Hobby now supports 300s. Leave 30s safety margin for final writes.
  // The scan self-terminates with status=running so Resume picks up cleanly.
  const scanStartMs = Date.now();
  const maxBudgetMs = timeBudgetMs;
  const shouldStopForTime = () => (Date.now() - scanStartMs) > maxBudgetMs;

  // Process each lead
  for (let i = 0; i < leads.length; i++) {
    // Check for user-triggered stop — re-read progress state before each lead.
    // Adds one Airtable read per lead (~50ms) but makes the Stop button feel instant
    // instead of having a 30s lag waiting for the i%3 cadence.
    try {
      const currentProgress = await readProgress(campaignAirtableId);
      if (currentProgress?.stopped_by_user) {
        console.log(`[linkedin-posts] Scan stopped by user at lead ${i}/${leads.length}`);
        // Merge the stopped state back into our in-memory progress and persist
        progress.status = "complete";
        progress.phase = "done";
        progress.stopped_by_user = true;
        progress.ended_at = new Date().toISOString();
        progress.last_log = `⛔ Scan stopped by user at ${progress.leads_done}/${leads.length} leads.`;
        await writeProgress(campaignAirtableId, progress);
        return progress;
      }
    } catch {}

    // Bail out gracefully if we're about to hit Vercel's timeout.
    // Progress is already persisted after every lead — user hits Resume to continue.
    if (shouldStopForTime()) {
      progress.last_log = `⏸ Paused at ${i}/${leads.length} (time budget, ${Math.round((Date.now() - scanStartMs) / 1000)}s elapsed). ${leads.length - i} leads remaining. Hit Resume to continue.`;
      progress.status = "running"; // signals frontend to show Resume button
      progress.paused_for_time_budget = true;
      await writeProgress(campaignAirtableId, progress);
      return progress;
    }
    const lead = leads[i];
    const f = lead.fields || {};
    const leadName = f.Name || f["Full Name"] || "Unknown";
    const leadCompany = f.Company || "";

    progress.current_lead = `${leadName}${leadCompany ? " @ " + leadCompany : ""}`;
    progress.current_lead_step = "fetching_urn";
    progress.last_log = `[${i + 1}/${leads.length}] Fetching profile for ${leadName}...`;
    await writeProgress(campaignAirtableId, progress);

    // Step 1: Get URN
    const urnResult = await getUrnForLead(lead, baseId);
    if (urnResult.error) {
      progress.errors.push(`${leadName}: ${urnResult.error}`);
      progress.last_log = `⚠️ ${leadName}: ${urnResult.error}`;
      progress.completed_lead_ids.push(lead.id);
      progress.leads_done++;
      progress.leads_remaining--;
      await writeProgress(campaignAirtableId, progress);
      continue;
    }
    if (urnResult.cached) progress.last_log = `[${i + 1}/${leads.length}] ${leadName}: using cached URN`;

    // Step 2: Fetch posts
    progress.current_lead_step = "fetching_posts";
    progress.last_log = `[${i + 1}/${leads.length}] ${leadName}: fetching recent posts...`;
    await writeProgress(campaignAirtableId, progress);

    const postsResult = await fetchPostsForUrn(urnResult.urn, cutoffMs);
    if (!postsResult.ok) {
      progress.errors.push(`${leadName}: ${postsResult.error}`);
      progress.last_log = `⚠️ ${leadName}: ${postsResult.error}`;
      progress.completed_lead_ids.push(lead.id);
      progress.leads_done++;
      progress.leads_remaining--;
      await writeProgress(campaignAirtableId, progress);
      continue;
    }

    const fetchedPosts = postsResult.posts;
    progress.posts_fetched += fetchedPosts.length;
    if (postsResult.undatableCount) {
      progress.posts_undatable = (progress.posts_undatable || 0) + postsResult.undatableCount;
    }
    if (postsResult.rawReturnedCount) {
      progress.posts_raw_returned = (progress.posts_raw_returned || 0) + postsResult.rawReturnedCount;
    }

    if (fetchedPosts.length === 0) {
      const reason = postsResult.undatableCount
        ? `${postsResult.rawReturnedCount} posts returned, ${postsResult.undatableCount} had no parseable date, others older than ${daysBack} days`
        : `no posts in last ${daysBack} days`;
      progress.last_log = `[${i + 1}/${leads.length}] ${leadName}: ${reason}`;
      progress.completed_lead_ids.push(lead.id);
      progress.leads_done++;
      progress.leads_remaining--;
      await writeProgress(campaignAirtableId, progress);
      continue;
    }

    // Step 3: Pre-filter with expanded Apps-Script rules + score the survivors
    const scoredPosts = [];
    const rejectionReasons = progress.rejection_reasons || {};
    for (let p = 0; p < fetchedPosts.length; p++) {
      const post = fetchedPosts[p];

      // DEDUP: skip if this exact post URL already has a recent task. Saves AI cost too.
      const postUrl = (post.url || "").trim();
      if (postUrl && existingTaskUrls.has(postUrl)) {
        progress.posts_deduped++;
        rejectionReasons["deduped_already_scanned"] = (rejectionReasons["deduped_already_scanned"] || 0) + 1;
        continue;
      }

      const cat = categorizePost(post.text);
      rollupCategoryCounts[cat.category] = (rollupCategoryCounts[cat.category] || 0) + 1;

      // Hard skip: definitely-not-a-signal categories never hit OpenAI. Saves cost + prevents false positives.
      if (cat.hardSkip) {
        progress.posts_filtered_out++;
        rejectionReasons[`skipped_${cat.category}`] = (rejectionReasons[`skipped_${cat.category}`] || 0) + 1;
        continue;
      }

      // Also skip "never-task" categories even without hardSkip — just count and move on
      if (NEVER_TASK_CATEGORIES.has(cat.category)) {
        progress.posts_filtered_out++;
        rejectionReasons[`skipped_${cat.category}`] = (rejectionReasons[`skipped_${cat.category}`] || 0) + 1;
        continue;
      }

      // Score with OpenAI
      progress.current_lead_step = "scoring";
      progress.last_log = `[${i + 1}/${leads.length}] ${leadName}: scoring post ${p + 1}/${fetchedPosts.length} (category: ${cat.category})...`;
      await writeProgress(campaignAirtableId, progress);

      const scored = await scorePost({
        post, lead, campaignContext, systemPromptOverride,
        categoryHint: cat.category,
        campaignId: campaignAirtableId,
        reviewerFeedback,
      });
      progress.posts_scored++;

      if (!scored.ok) {
        progress.errors.push(`Score failed for ${leadName} post: ${scored.error}`);
        continue;
      }

      // Apply two layers of defensive caps:
      // 1. AI's own sanity checks (already applied inside scorePost)
      // 2. Apps-Script category ceiling (belt-and-braces — prevents AI+AI-post-type agreement error)
      // 3. Category penalty (subtractive adjustment on top of ceiling)
      let adjusted = scored.relevance_score;
      const ceiling = CATEGORY_SCORE_CEILING[cat.category];
      if (ceiling != null && adjusted > ceiling) adjusted = ceiling;
      adjusted = Math.max(0, Math.min(100, adjusted + cat.penalty));

      // Determine final outcome (same logic as task creation at line 1132-1136)
      const wouldCreateTask = adjusted >= scoreThreshold
        && VALID_TASK_POST_TYPES.has(scored.post_type)
        && !NEVER_TASK_CATEGORIES.has(cat.category);

      const reasonCode = wouldCreateTask
        ? "task_created"
        : adjusted < scoreThreshold
          ? (scored.relevance_score >= scoreThreshold
              ? `ai_scored_${scored.relevance_score}_but_capped_by_${cat.category}_to_${adjusted}`
              : `below_threshold_${adjusted}`)
          : NEVER_TASK_CATEGORIES.has(cat.category)
            ? `score_${adjusted}_but_category_${cat.category}_never_creates_tasks`
            : !VALID_TASK_POST_TYPES.has(scored.post_type)
              ? `score_${adjusted}_but_post_type_${scored.post_type}_not_engagement_worthy`
              : `dropped_${adjusted}`;
      rejectionReasons[reasonCode] = (rejectionReasons[reasonCode] || 0) + 1;

      scoredPosts.push({
        post, category: cat.category, penalty: cat.penalty,
        ai_score: scored.raw_ai_score, ai_score_after_sanity: scored.relevance_score,
        adjusted_score: adjusted,
        rationale: scored.relevance_rationale,
        evidence_quote: scored.evidence_quote,
        post_type: scored.post_type,
        structured_sentence: scored.structured_sentence,
        suggested_comment: scored.suggested_comment,
        sanity_flags: scored.sanity_flags,
      });

      // Keep a rolling sample of the last 20 scored posts so the user can audit decisions
      // without having to look up individual tasks. Especially useful for debugging "why nothing passed".
      // Outcome is optimistic here — will flip to "task_creation_failed" later if Airtable rejects.
      // For now: "would_create_task" (pending batch write) or "dropped" (decision final).
      const willAttemptTask = adjusted >= scoreThreshold && VALID_TASK_POST_TYPES.has(scored.post_type) && !NEVER_TASK_CATEGORIES.has(cat.category);
      if (!progress.recent_samples) progress.recent_samples = [];
      progress.recent_samples.unshift({
        lead: leadName,
        company: leadCompany,
        post_text: (post.text || "").slice(0, 280),
        post_url: post.url || "",
        category: cat.category,
        penalty: cat.penalty,
        ai_score: scored.raw_ai_score,
        final_score: adjusted,
        post_type: scored.post_type,
        evidence: scored.evidence_quote,
        rationale: scored.relevance_rationale,
        outcome: willAttemptTask ? "pending_task_creation" : "dropped",
      });
      if (progress.recent_samples.length > 20) progress.recent_samples = progress.recent_samples.slice(0, 20);

      await new Promise(r => setTimeout(r, 250));
    }
    progress.rejection_reasons = rejectionReasons;

    // Step 4: Only post_types that CAN be buying signals create tasks
    const taskWorthy = scoredPosts.filter(sp =>
      sp.adjusted_score >= scoreThreshold &&
      VALID_TASK_POST_TYPES.has(sp.post_type) &&
      !NEVER_TASK_CATEGORIES.has(sp.category)
    );

    // ── Role-freshness gate ──────────────────────────────────────
    // Before creating an engagement task, confirm the lead STILL belongs to the
    // company on file. Best-effort + FAIL-OPEN: any error/uncertainty still
    // creates the task, so a flaky LinkedIn fetch never silently kills real
    // signals. Only a confident "they've left the company" (status=stale)
    // suppresses creation; a same-company title change creates the task with a
    // visible ⚠ caution. One extra profile fetch per lead that produced a
    // task-worthy post — rare, so cheap (exactly Kunal's point).
    let roleInfo = { status: "", currentTitle: "", reason: "" };
    if (ROLE_GATE_ENABLED && taskWorthy.length > 0) {
      try {
        roleInfo = await checkRoleFreshness({ linkedinUrl: pickLeadField(f, "linkedinUrl"), storedTitle: pickLeadField(f, "title"), storedCompany: leadCompany });
      } catch (_) { roleInfo = { status: "unverified", currentTitle: "", reason: "role check threw" }; }
    }
    const roleStale = roleInfo.status === "stale";
    if (roleStale) {
      progress.posts_filtered_out += taskWorthy.length;
      progress.stale_role_skipped = (progress.stale_role_skipped || 0) + taskWorthy.length;
      rejectionReasons["left_company_role_stale"] = (rejectionReasons["left_company_role_stale"] || 0) + taskWorthy.length;
      progress.last_log = `[${i + 1}/${leads.length}] ${leadName}: skipped ${taskWorthy.length} task(s) — ${roleInfo.reason}`;
      if (progress.recent_samples) for (const s of progress.recent_samples) { if (s.lead === leadName && s.outcome === "pending_task_creation") { s.outcome = "skipped_role_stale"; s.error = roleInfo.reason; } }
      await writeProgress(campaignAirtableId, progress);
    }

    if (taskWorthy.length > 0 && !roleStale) {
      progress.current_lead_step = "creating_tasks";
      progress.last_log = `[${i + 1}/${leads.length}] ${leadName}: creating ${taskWorthy.length} task(s)...`;
      await writeProgress(campaignAirtableId, progress);

      const todayStr = new Date().toISOString().slice(0, 10);
      const nowISO = new Date().toISOString();
      // Same-company title change → still belongs, but flag it so the SDR knows.
      const roleCaution = roleInfo.status === "changed" ? `⚠ ROLE CHECK: ${roleInfo.reason}` : null;
      const records = taskWorthy.map(sp => {
        const postUrl = sp.post.url || "";
        // Underlying post's TRUE publish date (ISO from the provider, or the
        // best-guess "now" for undatable posts — see fetchPostsForUrn). Stored
        // as Post Date so the feed freshness gate can age the task out by post
        // age (1-6d at fetch, ages daily) rather than by scan time (2026-06-09).
        const postDateStr = (() => {
          const d = new Date(sp.post.date || nowISO);
          return isNaN(d.getTime()) ? todayStr : d.toISOString().slice(0, 10);
        })();
        // Build a transparent Signal that shows the SDR exactly why this post passed.
        // Put the post URL at the TOP so it's always visible even if a dedicated URL field
        // doesn't exist in the user's Tasks table.
        const signalParts = [
          roleCaution,
          roleCaution ? `` : null,
          postUrl ? `🔗 ${postUrl}` : null,
          postUrl ? `` : null,
          `📝 ${sp.structured_sentence}`,
          ``,
          `💬 Suggested comment: ${sp.suggested_comment}`,
          ``,
          `🔍 Evidence from post: "${sp.evidence_quote}"`,
          ``,
          `💡 Why this matters: ${sp.rationale}`,
          ``,
          `📊 Final score: ${sp.adjusted_score}/100`,
          `   • AI raw score: ${sp.ai_score}`,
          sp.ai_score !== sp.ai_score_after_sanity ? `   • After AI sanity checks: ${sp.ai_score_after_sanity}` : null,
          `   • Post type: ${sp.post_type}`,
          `   • Pre-filter category: ${sp.category}${sp.penalty !== 0 ? ` (penalty: ${sp.penalty})` : ""}`,
          sp.sanity_flags?.length ? `   • Sanity flags: ${sp.sanity_flags.join(", ")}` : null,
        ].filter(v => v !== null && v !== undefined);

        return {
          fields: {
            Name: leadName,
            Company: leadCompany,
            "Task Rule": taskRuleName,
            Score: sp.adjusted_score,
            "Scan Target": leadName,
            "Lead Title": pickLeadField(f, "title"),
            Email: pickLeadField(f, "email"),
            "LinkedIn URL": pickLeadField(f, "linkedinUrl"),
            Phone: pickLeadField(f, "phone"),
            Signal: signalParts.join("\n"),
            // Full raw post text (capped 3000, same cap as the AI prompt input).
            // The chatbot's "Read full post here" renders THIS — the Signal
            // field only carries the structured summary + internal scoring,
            // which is not the post (Samarth 2026-06-11). Auto-heal strips
            // this field on bases that haven't run setup-fix yet.
            "Post Text": (sp.post.text || "").slice(0, 3000),
            URL: postUrl,              // canonical post URL field
            "Post URL": postUrl,       // alt name — some schemas use this
            "Signal URL": postUrl,     // alt name — some schemas use this
            Source: "LinkedIn Posts (RapidAPI)",
            "Task Type": "linkedin_engagement",
            "Post Date": postDateStr,   // underlying post publish date → feed freshness gate
            Date: todayStr,
            Created: nowISO,
          },
        };
      });

      const { results: created, errors: createErrors } = await atCreateBatch(baseId, "Tasks", records);
      progress.tasks_created += created.length;

      // Flip the "pending_task_creation" samples to final state based on what Airtable did.
      if (progress.recent_samples) {
        // Build a set of URLs that successfully got created (from the Airtable response)
        const createdUrls = new Set(created.map(rec => rec.fields?.URL).filter(Boolean));
        for (const sample of progress.recent_samples) {
          if (sample.outcome !== "pending_task_creation") continue;
          if (sample.lead !== leadName) continue;
          if (createdUrls.has(sample.post_url)) {
            sample.outcome = "task_created";
          } else {
            sample.outcome = "task_creation_failed";
            sample.error = createErrors[0] || "Task not in Airtable response";
          }
        }
      }

      // CRITICAL: Surface task creation failures in progress so the user sees them.
      if (createErrors && createErrors.length > 0) {
        for (const err of createErrors) {
          progress.errors.push(`⚠️ Task create failed for ${leadName}: ${err}`);
        }
      }

      // Add these URLs to the in-memory dedup set so subsequent posts in the same
      // scan (e.g., if a resume picks up mid-lead) don't double-create.
      for (const sp of taskWorthy) {
        const u = (sp.post?.url || "").trim();
        if (u) existingTaskUrls.add(u);
      }
    }

    progress.completed_lead_ids.push(lead.id);
    progress.leads_done++;
    progress.leads_remaining--;
    progress.category_counts = rollupCategoryCounts;
    progress.last_log = `✓ [${i + 1}/${leads.length}] ${leadName}: ${fetchedPosts.length} fetched · ${progress.posts_filtered_out} pre-filtered · ${scoredPosts.length} scored · ${taskWorthy.length} tasks`;
    await writeProgress(campaignAirtableId, progress);
  }

  progress.phase = "done";
  progress.status = "complete";
  progress.current_lead = null;
  progress.current_lead_step = null;
  progress.last_log = `✅ Scan complete. ${progress.tasks_created} tasks created from ${progress.posts_scored} scored posts across ${progress.leads_done} leads.`;
  progress.ended_at = new Date().toISOString();
  await writeProgress(campaignAirtableId, progress);

  return progress;
}

// ═══════════════════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function POST(request) {
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const { action } = body;

  // SECURITY: Block from /client/[id] pages. This route handles LinkedIn auth
  // tokens, custom prompts, and scan operations that should remain admin-only.
  const referer = request.headers.get("referer") || "";
  if (/\/client\/[^/?#]+/.test(referer)) {
    console.warn(`[SECURITY] linkedin-posts action "${action}" blocked from client referer: ${referer}`);
    return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
  }

  try {
    switch (action) {
      case "get_progress": {
        // Frontend polls this every 2s to render the live progress UI
        const { campaignAirtableId } = body;
        if (!campaignAirtableId) return NextResponse.json({ error: "campaignAirtableId required" }, { status: 400 });
        const progress = await readProgress(campaignAirtableId);
        return NextResponse.json({ ok: true, progress });
      }

      // Returns the live default scoring prompt + sanity-check rules + output schema.
      // Used by the frontend so the Custom Prompt section always displays the
      // CURRENT default rather than a stale duplicate. Lets users click "Load Default"
      // to get the actual prompt as a starting point for customization.
      case "get_default_prompt": {
        return NextResponse.json({
          ok: true,
          defaultPrompt: defaultScoringSystemPrompt(""),
          // Sanity-check rules applied AFTER AI scoring (the AI's score can be capped):
          sanityRules: [
            "If evidence_quote is missing or 'NO_SPECIFIC_EVIDENCE' → score capped at 25",
            "If post_type is holiday/anniversary/birthday/condolence → score capped at 5",
            "If post_type is hiring/farewell → score capped at 10",
            "If post_type is award → score capped at 15",
            "If post_type is gratitude → score capped at 20",
            "If post_type is self_promo/content_promo → score capped at 25",
            "If post_type is motivational → score capped at 30",
            "If post_type is reshare → score capped at 35",
            "If post_type is event_announcement → score capped at 45",
            "If post_type is thought_leadership → score capped at 85 (high ceiling — quality posts welcome)",
            "If post_type is industry_news → score capped at 70",
            "If post_type is pain_point/project_announcement/question_to_network → no cap (100 max)",
            "If score > 55 but rationale doesn't reference any 5-letter+ word from evidence_quote → score capped at 50",
          ],
          // Pre-filter category ceilings (applied BEFORE AI based on regex pattern matching).
          // Even if user prompt scores 100, if pre-filter caught it as 'motivational', cap at 35.
          categoryCeilings: {
            holiday: 5, anniversary: 5, birthday: 5, condolence: 5,
            hiring: 10, linkedin_spam: 10, farewell: 10,
            award: 25, gratitude: 30,
            content_promo: 35, self_promo: 35, motivational: 35,
            reshare_minimal: 40, funding_announcement: 40,
            event_promo: 55, engagement_bait: 55,
            thin_content: 50, short_content: 70,
            genuine_content: 100, unknown: 60,
          },
          // Required output schema. ANY custom prompt MUST return this shape.
          requiredOutputSchema: {
            post_type: "string — one of: holiday, anniversary, birthday, award, gratitude, condolence, hiring, farewell, self_promo, content_promo, motivational, reshare, thought_leadership, industry_news, event_announcement, pain_point, project_announcement, question_to_network, personal, other",
            relevance_score: "integer 1-100",
            evidence_quote: "string ≤25 words — the EXACT sentence from the post that justifies your score. If no substantive content, write 'NO_SPECIFIC_EVIDENCE' and score must be ≤25",
            relevance_rationale: "string ≤40 words — what makes this post engagement-worthy (or why not)",
            structured_sentence: "string ≤20 words, format: '{Full name}, {simplified title} at {simplified company} posted about {neutral 15-word summary}'",
            suggested_comment: "string ≤20 words, MUST start with 'You could comment' or 'You could highlight'. Must reference specific content from THIS post, not generic pleasantries",
          },
          // What the user payload looks like (so users can reference these fields in their custom prompt)
          inputPayload: {
            full_name: "Lead's full name",
            title: "Lead's job title",
            company: "Lead's company",
            post_text: "Post content (capped at 3000 chars)",
            pre_filter_category: "Category assigned by pre-filter (e.g. 'motivational', 'genuine_content')",
          },
        });
      }

      case "clear_progress": {
        // Reset state so next run starts fresh (doesn't delete any tasks already created)
        const { campaignAirtableId } = body;
        if (!campaignAirtableId) return NextResponse.json({ error: "campaignAirtableId required" }, { status: 400 });
        await atUpdateWithAutoCreate(MASTER_BASE_ID, "Campaigns", campaignAirtableId, { "LinkedIn Post Scan Status": "" });
        return NextResponse.json({ ok: true, cleared: true });
      }

      // Stop a running scan by marking it complete in progress state.
      // The actively-running function will see status!==running next time it checks and bail out.
      // Any cron-triggered resume will also see status=complete and return DONE.
      case "stop_scan": {
        const { campaignAirtableId } = body;
        if (!campaignAirtableId) return NextResponse.json({ error: "campaignAirtableId required" }, { status: 400 });
        const prior = await readProgress(campaignAirtableId);
        if (!prior) return NextResponse.json({ ok: true, message: "No scan to stop" });
        const stopped = {
          ...prior,
          status: "complete",
          phase: "done",
          last_log: `⛔ Scan stopped by user at ${prior.leads_done}/${prior.total_leads} leads.`,
          ended_at: new Date().toISOString(),
          stopped_by_user: true,
        };
        await writeProgress(campaignAirtableId, stopped);
        return NextResponse.json({ ok: true, stopped: true, progress: stopped });
      }

      // List stale LinkedIn post tasks (for preview before deletion). Returns count + sample.
      case "list_stale_tasks": {
        const { baseId, olderThanDays, taskRuleName } = body;
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const days = typeof olderThanDays === "number" && olderThanDays > 0 ? olderThanDays : 14;
        const cutoffISO = new Date(Date.now() - days * 86400000).toISOString();
        const rule = (taskRuleName || "LinkedIn Post Engagement").replace(/"/g, '\\"');
        const formula = `AND({Task Rule} = "${rule}", IS_BEFORE({Created}, "${cutoffISO}"))`;
        try {
          const stale = await atList(baseId, "Tasks", { filterByFormula: formula, fields: ["Name", "Company", "Score", "Created", "HubSpot Task ID"] });
          const pushedCount = stale.filter(r => r.fields?.["HubSpot Task ID"]).length;
          return NextResponse.json({
            ok: true,
            total: stale.length,
            pushed_to_hubspot: pushedCount,
            not_pushed: stale.length - pushedCount,
            cutoff: cutoffISO,
            days,
            sample: stale.slice(0, 10).map(r => ({
              id: r.id,
              lead: r.fields?.["Name"] || r.fields?.["Lead Name"] || "",
              company: r.fields?.Company || "",
              score: r.fields?.Score,
              created: r.fields?.Created,
              pushed: !!r.fields?.["HubSpot Task ID"],
            })),
          });
        } catch (e) {
          return NextResponse.json({ error: e.message }, { status: 500 });
        }
      }

      // Actually delete stale LinkedIn post tasks. Dangerous → requires explicit confirm flag.
      // Airtable records only — does NOT touch HubSpot. If a task was already pushed, the HubSpot
      // record remains (it's independent). We're just cleaning up the local signal history.
      case "cleanup_old_tasks": {
        const { baseId, olderThanDays, taskRuleName, excludePushed, confirm } = body;
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        if (!confirm) return NextResponse.json({ error: "Pass confirm:true to actually delete (safety guard)" }, { status: 400 });
        const days = typeof olderThanDays === "number" && olderThanDays > 0 ? olderThanDays : 14;
        const cutoffISO = new Date(Date.now() - days * 86400000).toISOString();
        const rule = (taskRuleName || "LinkedIn Post Engagement").replace(/"/g, '\\"');
        let formula = `AND({Task Rule} = "${rule}", IS_BEFORE({Created}, "${cutoffISO}"))`;
        // If excludePushed, skip tasks that have a HubSpot Task ID (user is still acting on them in HubSpot)
        if (excludePushed) formula = `AND(${formula.slice(4, -1)}, {HubSpot Task ID} = "")`;
        try {
          const stale = await atList(baseId, "Tasks", { filterByFormula: formula, fields: ["Created"] });
          if (stale.length === 0) return NextResponse.json({ ok: true, deleted: 0, message: "No stale tasks to delete" });

          // Batch delete (max 10 per DELETE call in Airtable)
          let deleted = 0;
          const failures = [];
          for (let i = 0; i < stale.length; i += 10) {
            const batch = stale.slice(i, i + 10);
            const qs = batch.map(r => `records[]=${r.id}`).join("&");
            const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${qs}`, {
              method: "DELETE", headers: atHdr,
            });
            if (r.ok) deleted += batch.length;
            else failures.push(`Batch ${i / 10 + 1}: ${r.status} ${await r.text().then(t => t.slice(0, 100))}`);
          }
          return NextResponse.json({ ok: true, deleted, failed: stale.length - deleted, failures, days, cutoff: cutoffISO });
        } catch (e) {
          return NextResponse.json({ error: e.message }, { status: 500 });
        }
      }

      case "scan": {
        // Kick off a scan. This is a long-running op (can take several minutes for large campaigns).
        // Vercel has a 60s limit on Hobby, 300s on Pro — so we process as much as we can within the
        // budget, leaving progress state. User hits "resume" to continue.
        const { baseId, campaignAirtableId, leadIds, scoreThreshold, daysBack, taskRuleName, systemPromptOverride, resume, force, autoCleanupDays, autoCleanupExcludePushed } = body;
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        if (!campaignAirtableId) return NextResponse.json({ error: "campaignAirtableId required" }, { status: 400 });
        if (!OPENAI_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 400 });
        if (!RAPIDAPI_KEY) return NextResponse.json({ error: "RAPIDAPI_KEY not set (for Fresh LinkedIn Scraper API)" }, { status: 400 });

        // Concurrent-scan lock: refuse if another scan is actively writing progress.
        // Progress is updated after every lead (~every 5-15s), so a live scan will always
        // have a fresh updated_at. 30s threshold catches legit concurrent scans while
        // allowing cron-triggered resumes to pick up after the prior function completes.
        if (!force) {
          const prior = await readProgress(campaignAirtableId);
          if (prior?.status === "running" && prior.updated_at) {
            const ageMs = Date.now() - new Date(prior.updated_at).getTime();
            if (!isNaN(ageMs) && ageMs < 30 * 1000) {
              return NextResponse.json({
                error: `Another scan is actively running (last progress write ${Math.round(ageMs/1000)}s ago). Wait ${Math.ceil((30*1000-ageMs)/1000)}s or retry with force:true.`,
                locked: true,
                prior,
              }, { status: 409 });
            }
          }
        }

        // Optional: auto-cleanup stale tasks BEFORE starting the scan.
        // Keeps the Tasks table from piling up week after week.
        let cleanedUp = 0;
        if (typeof autoCleanupDays === "number" && autoCleanupDays > 0 && !resume) {
          const cutoffISO = new Date(Date.now() - autoCleanupDays * 86400000).toISOString();
          const rule = (taskRuleName || "LinkedIn Post Engagement").replace(/"/g, '\\"');
          let formula = `AND({Task Rule} = "${rule}", IS_BEFORE({Created}, "${cutoffISO}"))`;
          if (autoCleanupExcludePushed) formula = `AND(${formula.slice(4, -1)}, {HubSpot Task ID} = "")`;
          try {
            const stale = await atList(baseId, "Tasks", { filterByFormula: formula, fields: ["Created"] });
            for (let i = 0; i < stale.length; i += 10) {
              const batch = stale.slice(i, i + 10);
              const qs = batch.map(r => `records[]=${r.id}`).join("&");
              const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${qs}`, {
                method: "DELETE", headers: atHdr,
              });
              if (r.ok) cleanedUp += batch.length;
            }
            if (cleanedUp > 0) console.log(`[linkedin-posts] Auto-cleanup: deleted ${cleanedUp} stale tasks older than ${autoCleanupDays} days`);
          } catch (e) {
            console.error("[linkedin-posts] Auto-cleanup failed (continuing anyway):", e.message);
          }
        }

        const result = await runLinkedInPostScan({
          baseId, campaignAirtableId, leadIds,
          scoreThreshold: typeof scoreThreshold === "number" ? scoreThreshold : 70,
          daysBack: typeof daysBack === "number" ? daysBack : 7,
          taskRuleName: taskRuleName || "LinkedIn Post Engagement",
          systemPromptOverride,
          resume: !!resume,
        });
        if (cleanedUp > 0) result.auto_cleaned_up = cleanedUp;
        return NextResponse.json({ ok: true, progress: result });
      }

      case "test_profile": {
        // Debug: fetch a single lead's URN + first page of posts without scoring
        const { baseId, leadId } = body;
        if (!baseId || !leadId) return NextResponse.json({ error: "baseId and leadId required" }, { status: 400 });
        const lead = await atGet(baseId, "Leads", leadId);
        if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
        const urnResult = await getUrnForLead(lead, baseId);
        if (urnResult.error) return NextResponse.json({ ok: false, error: urnResult.error });
        const cutoffMs = Date.now() - (7 * 86400000);
        const posts = await fetchPostsForUrn(urnResult.urn, cutoffMs, 1);
        return NextResponse.json({ ok: true, urn: urnResult.urn, cached: !!urnResult.cached, posts });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    console.error("[linkedin-posts] Route error:", e.message, e.stack?.slice(0, 400));
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export const maxDuration = 300; // Fluid Compute on Hobby now allows 300s (was 60s pre-2025)

// ═══════════════════════════════════════════════════════════════════════════
// GET HANDLER — public cron endpoint for external schedulers
// ═══════════════════════════════════════════════════════════════════════════
//
// Designed for cron-job.org / UptimeRobot / any GET-based webhook scheduler.
// Call every 1-5 minutes from an external scheduler. It:
//   1. Checks if a scan is running for the given campaign
//   2. If yes, calls resume (picks up where last invocation stopped)
//   3. If scan is complete, returns 200 with "DONE" so cron can be disabled
//   4. If no scan exists, returns 200 with "IDLE"
//
// URL format:
//   https://<vercel-app>/api/linkedin-posts?key=<CRON_SECRET>&base=<baseId>&campaign=<campaignAirtableId>
//
// Security: requires ?key=<CRON_SECRET> matching env var.
// If CRON_SECRET env not set, the endpoint is disabled.

export async function GET(request) {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  const baseId = url.searchParams.get("base");
  const campaignAirtableId = url.searchParams.get("campaign");
  const taskRuleName = url.searchParams.get("task_rule") || "LinkedIn Post Engagement";

  // Auth
  const CRON_SECRET = process.env.CRON_SECRET;
  if (!CRON_SECRET) return NextResponse.json({ error: "CRON_SECRET not set on server" }, { status: 500 });
  if (key !== CRON_SECRET) return NextResponse.json({ error: "Invalid or missing key" }, { status: 401 });

  if (!baseId || !campaignAirtableId) {
    return NextResponse.json({ error: "base and campaign query params required" }, { status: 400 });
  }

  try {
    const prior = await readProgress(campaignAirtableId);
    if (!prior) {
      return NextResponse.json({ status: "IDLE", message: "No scan state exists for this campaign. Start one from the UI first." });
    }
    if (prior.status === "complete" || prior.phase === "done") {
      return NextResponse.json({
        status: "DONE",
        message: "Scan complete — you can disable the cron now.",
        leads_done: prior.leads_done,
        tasks_created: prior.tasks_created,
        ended_at: prior.ended_at,
      });
    }
    if (prior.leads_remaining === 0) {
      return NextResponse.json({ status: "DONE", message: "No leads remaining" });
    }

    // Resume. Pull scoreThreshold/daysBack/systemPromptOverride from the prior progress if available,
    // otherwise use safe defaults. The scan function reads these as args.
    const scoreThreshold = typeof prior.score_threshold === "number" ? prior.score_threshold : 70;
    const daysBack = typeof prior.days_back === "number" ? prior.days_back : 7;
    const ruleName = prior.task_rule_name || taskRuleName;

    // Use a SHORT time budget (25s) when called from cron so cron-job.org's 30s HTTP
    // timeout doesn't register as "Failed" on every tick. Processes ~3 leads per call.
    // Over 30 min of 1-per-minute cron = ~90 leads processed via cron alone.
    // The UI-triggered run (270s budget) handles most of the work up front.
    const result = await runLinkedInPostScan({
      baseId, campaignAirtableId,
      leadIds: null,
      scoreThreshold,
      daysBack,
      taskRuleName: ruleName,
      systemPromptOverride: prior.system_prompt_override || null,
      resume: true,
      timeBudgetMs: 25_000,
    });

    return NextResponse.json({
      status: result.status === "complete" ? "DONE" : "RESUMED",
      leads_done: result.leads_done,
      leads_remaining: result.leads_remaining,
      tasks_created: result.tasks_created,
      last_log: result.last_log,
    });
  } catch (e) {
    console.error("[linkedin-posts cron] Error:", e.message);
    return NextResponse.json({ status: "ERROR", error: e.message }, { status: 500 });
  }
}
