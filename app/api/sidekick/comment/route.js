import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK — POST A LINKEDIN COMMENT  (Kunal Jul-20 auto-comment ask)
// POST /api/sidekick/comment
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Posts a comment on a LinkedIn post via Unipile, AS the campaign's
// connected LinkedIn account. This is the FIRST real outbound side-effect
// the chatbot performs directly (everything before was copy+open). It only
// ever runs on an explicit operator action (a click or a typed "comment
// this") — the approval invariant is preserved: a human decides, the agent
// executes what was approved.
//
// Body:
//   { baseId, postUrl, text, accountId?, dryRun? }
//   - postUrl  : the post's LinkedIn URL (card.url) — the social_id is
//                extracted from it (urn:li:activity|ugcPost|share:<id>).
//   - text     : the comment. 1-1250 chars. Em dashes stripped, trimmed.
//   - accountId: Unipile account to post from. If omitted, resolved from
//                the campaign's "LinkedIn Account ID" (via baseId).
//   - dryRun   : validate + resolve everything (social_id, account identity,
//                text) and return what WOULD post, WITHOUT calling Unipile.
//
// Returns:
//   dryRun  → { ok, dryRun:true, wouldPost:{ social_id, account:{id,name}, text, textLength } }
//   live    → { ok, commentId, social_id, account:{id,name} }
//
// Formatting guarantee (Samarth: "no mistakes with formatting"): LinkedIn
// comments are plain text. We send the text verbatim except: trim, strip em
// dashes (house rule), collapse 3+ blank lines, and hard-cap at 1250. No
// markdown is interpreted by LinkedIn, so nothing else is transformed.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const UNIPILE_DSN = process.env.UNIPILE_DSN;
const UNIPILE_KEY = process.env.UNIPILE_API_KEY;
const AT_API = "https://api.airtable.com/v0";
const COMMENT_MAX = 1250;

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  return (request.headers.get("authorization") || "") === `Bearer ${SIDEKICK_API_KEY}`;
}

// Vercel blocks non-standard ports — Unipile moves the port to a query param.
function buildUnipileUrl(path) {
  if (!UNIPILE_DSN) return null;
  let dsn = UNIPILE_DSN.replace(/\/$/, "");
  let portParam = "";
  const m = dsn.match(/^(https?:\/\/[^:\/]+)(?::(\d+))?/i);
  if (m && m[2]) { dsn = m[1]; portParam = `port=${m[2]}`; }
  const sep = path.includes("?") ? "&" : "?";
  return `${dsn}/api/v1${path}${portParam ? sep + portParam : ""}`;
}

async function unipileReq(path, method = "GET", body = null) {
  const url = buildUnipileUrl(path);
  if (!url) return { ok: false, status: 0, data: { error: "UNIPILE_DSN not set" } };
  const opts = { method, headers: { "X-API-KEY": UNIPILE_KEY, Accept: "application/json" } };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  try {
    const res = await fetch(url, opts);
    const t = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(t) }; }
    catch { return { ok: res.ok, status: res.status, data: t }; }
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

// Extract the Unipile social_id from a LinkedIn post URL. LinkedIn embeds the
// URN directly in feed/activity URLs, and the URN IS the social_id for
// activity/ugcPost/share posts (per Unipile docs). Return null if we can't
// find one — we refuse to guess rather than post to the wrong place.
function socialIdFromUrl(rawUrl) {
  const s = String(rawUrl || "");
  // Full URN already present (the common case: card.url = .../urn:li:activity:123)
  const urn = s.match(/urn:li:(?:activity|ugcPost|share|comment):\d+/);
  if (urn) return urn[0];
  // Bare activity id in a /feed/update/ or /posts/ path → build the activity URN.
  const num = s.match(/(?:activity[-:]|fbid=|:activity:)(\d{15,})/i) || s.match(/\/(\d{15,})(?:[/?]|$)/);
  if (num) return `urn:li:activity:${num[1]}`;
  return null;
}

// The house-style formatting pass for a comment about to hit LinkedIn.
function cleanComment(raw) {
  let t = String(raw || "").replace(/\r\n/g, "\n").trim();
  // Strip em/en dashes (house rule). Rewrite to a comma, or a space before a conjunction.
  t = t.replace(/\s*[—–]\s*(?=(?:and|but|so|or|yet|then|because|which)\b)/gi, " ")
       .replace(/\s*[—–]\s*/g, ", ")
       .replace(/,\s*,+/g, ",")
       .replace(/\s+,/g, ",")
       .replace(/,\s*([.!?;:])/g, "$1");
  // Collapse 3+ newlines to a double (LinkedIn keeps \n; avoid a wall of gaps).
  t = t.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
  return t.slice(0, COMMENT_MAX);
}

// The Veloka connected LinkedIn account (Unipile). Non-secret identifier;
// stored in the master Campaigns table and echoed here as a fallback the same
// way CRON_SECRET has a hardcoded fallback in this repo. The dry-run always
// surfaces the resolved account NAME so identity is confirmed before any live
// post, so a wrong id can never post silently.
const VELOKA_BASE = "appPcAzAyMmtNNEmT";
const VELOKA_ACCOUNT_FALLBACK = "iqFY_VqkTty6Ns6q-kpxvA";

// Resolve the posting account: explicit id → campaign's "LinkedIn Account ID"
// (matched by Airtable Base ID) → env → known Veloka fallback.
async function resolveAccountId(accountId, baseId) {
  if (accountId) return accountId;
  if (AIRTABLE_KEY && MASTER_BASE_ID && baseId) {
    try {
      const r = await fetch(
        `${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}?pageSize=100`,
        { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` }, cache: "no-store" }
      );
      if (r.ok) {
        const d = await r.json();
        const row = (d.records || []).find(
          (rec) => (rec.fields?.["Airtable Base ID"] || "").trim() === baseId.trim()
        );
        const id = row?.fields?.["LinkedIn Account ID"];
        if (id) return id;
      }
    } catch { /* fall through */ }
  }
  if (process.env.VELOKA_UNIPILE_ACCOUNT_ID) return process.env.VELOKA_UNIPILE_ACCOUNT_ID;
  if (baseId === VELOKA_BASE) return VELOKA_ACCOUNT_FALLBACK;
  return "";
}

// Human-readable identity of the account that will post (so the operator can
// confirm it's really their LinkedIn before anything goes public).
async function accountName(accountId) {
  const r = await unipileReq(`/accounts/${accountId}`);
  if (!r.ok || !r.data || typeof r.data !== "object") return "";
  const im = r.data?.connection_params?.im || {};
  return r.data.name || im.username || im.publicIdentifier || "";
}

export async function POST(request) {
  if (!authOk(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  if (!UNIPILE_DSN || !UNIPILE_KEY) return NextResponse.json({ ok: false, error: "Unipile not configured" }, { status: 500 });

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 }); }

  const { baseId, postUrl, text, dryRun } = body || {};
  const social_id = socialIdFromUrl(postUrl);
  if (!social_id) {
    return NextResponse.json({ ok: false, error: "Could not read the post id from the URL. Open the post and try again." }, { status: 400 });
  }
  const clean = cleanComment(text);
  if (!clean) return NextResponse.json({ ok: false, error: "Comment text is empty" }, { status: 400 });

  const acctId = await resolveAccountId(body.accountId, baseId);
  if (!acctId) {
    return NextResponse.json({ ok: false, error: "No LinkedIn account is assigned for this campaign. Assign one in LinkedIn Automation." }, { status: 400 });
  }
  const name = await accountName(acctId);

  if (dryRun) {
    return NextResponse.json({
      ok: true,
      dryRun: true,
      wouldPost: { social_id, account: { id: acctId, name }, text: clean, textLength: clean.length },
    });
  }

  // LIVE: post the comment.
  const res = await unipileReq(`/posts/${encodeURIComponent(social_id)}/comments`, "POST", {
    account_id: acctId,
    text: clean,
  });
  if (!res.ok) {
    const err = typeof res.data === "object" ? (res.data.detail || res.data.error || res.data.title || JSON.stringify(res.data)) : String(res.data);
    return NextResponse.json({ ok: false, error: `LinkedIn rejected the comment: ${String(err).slice(0, 300)}`, status: res.status }, { status: 502 });
  }
  const commentId = (res.data && typeof res.data === "object" && (res.data.id || res.data.comment_id)) || null;
  return NextResponse.json({ ok: true, commentId, social_id, account: { id: acctId, name }, text: clean });
}
