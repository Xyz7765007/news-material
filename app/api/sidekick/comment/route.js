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

// ── URN shape (VERIFIED live 2026-07-27) ───────────────────────────────
// Unipile's POST /posts/{id}/comments accepts ONLY an `urn:li:activity:` id.
// Probed against the live chain: a ugcPost URN and a share URN BOTH come back
// 422 "Requested post might not be accessible, or has a misspelled ID.", every
// time — so forwarding those shapes verbatim (which socialIdFromUrl happily
// extracts) is a guaranteed failure. We don't refuse them, because refusing
// would strand any card whose provider handed us a ugcPost/share URL; we send
// the activity form first and keep the original as a single retry.
// A `comment` URN is a reply target, not a post — that one we do refuse.
function urnKind(socialId) {
  const m = String(socialId || "").match(/^urn:li:([A-Za-z]+):/);
  return m ? m[1] : "";
}
function asActivityUrn(socialId) {
  const d = String(socialId || "").match(/(\d{6,})/);
  return d ? `urn:li:activity:${d[1]}` : null;
}

// ── Ask Unipile what it thinks this post IS (read-only) ────────────────
// Added 2026-08-05 after a live 422 "Post cannot be found" on a post the
// operator could comment on by hand seconds later. A URL's activity id is not
// always the id Unipile will accept: LinkedIn gives the same post an activity
// id AND a ugcPost/share id, and `asActivityUrn` can only ever re-wrap the
// digits it was handed. A GET tells us the id Unipile itself uses, which is
// the one worth retrying with. Never throws — a failed probe just returns null
// and the caller carries on with what it had.
async function fetchPostIdentity(socialId, accountId) {
  const r = await unipileReq(`/posts/${encodeURIComponent(socialId)}?account_id=${encodeURIComponent(accountId)}`);
  if (!r.ok || !r.data || typeof r.data !== "object") {
    return { reachable: false, status: r.status, detail: typeof r.data === "object" ? JSON.stringify(r.data).slice(0, 300) : String(r.data ?? "").slice(0, 300) };
  }
  const d = r.data;
  const ids = [d.social_id, d.id, d.share_url, d.post_id].filter(v => typeof v === "string");
  const urns = ids.map(v => (v.match(/urn:li:(?:activity|ugcPost|share):\d+/) || [])[0]).filter(Boolean);
  return {
    reachable: true,
    status: r.status,
    author: d.author?.name || d.author_name || "",
    isRepost: !!(d.is_repost || d.repost || d.reshared_post),
    canonicalIds: [...new Set(urns)],
  };
}

// Turn a Unipile failure into something the operator can ACT on. Kunal hit this
// live on the 2026-07-27 call ("Some error. It didn't post." → "I have no choice
// but to skip") because the only thing that reached the UI was Unipile's raw
// string, which is frequently "Please try again later." — advice that is wrong
// whenever the post is simply gone.
function classifyUnipileError(status, data) {
  const raw =
    typeof data === "object" && data
      ? data.detail || data.error || data.title || JSON.stringify(data)
      : String(data);
  const low = String(raw).toLowerCase();
  if (status === 429 || /rate limit|too many|throttl/.test(low))
    return { reason: "rate_limited", message: "LinkedIn is throttling comments from this account. Wait a few minutes, then try again, or comment manually on the post." };
  if (status === 401 || status === 403 || /disconnect|credential|checkpoint|reconnect|unauthor/.test(low))
    return { reason: "account_disconnected", message: "This LinkedIn account is no longer connected in Unipile. Reconnect it, then try again." };
  if (status === 404 || status === 422 || /misspelled id|not be accessible|not found/.test(low))
    return { reason: "post_unavailable", message: "LinkedIn will not accept a comment on this post. It was most likely deleted, made private, or has comments restricted. Open it on LinkedIn to check." };
  // Verified 2026-07-27: Unipile returns 503 "Please try again later." for a
  // post it cannot reach AND (per LinkedIn's standard behaviour) when we are
  // being throttled. The string alone cannot tell them apart, so say both
  // rather than guess — and the full body is logged for whoever looks next.
  if (status === 503 || /try again later/.test(low))
    return { reason: "post_unreachable_or_throttled", message: "LinkedIn would not take this comment. Either the post is gone or LinkedIn is throttling us. Open the post on LinkedIn to comment manually." };
  return { reason: "unknown", message: `LinkedIn rejected the comment: ${String(raw).slice(0, 300)}` };
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
        // FIELD NAME BUG, fixed 2026-07-28. This matched "Airtable Base ID",
        // which does not exist on the Campaigns table — the field is "Base ID".
        // So this lookup ALWAYS missed and every caller silently fell through to
        // the env/hardcoded fallback below. Harmless while Veloka was the only
        // campaign; with a second user it meant everyone posted as Kunal.
        // Both spellings are accepted so a renamed field cannot re-break it.
        const row = (d.records || []).find((rec) => {
          const f = rec.fields || {};
          const v = (f["Base ID"] || f["Airtable Base ID"] || "").trim();
          return v && v === baseId.trim();
        });
        const id = row?.fields?.["LinkedIn Account ID"];
        if (id) return id;
      }
    } catch { /* fall through */ }
  }
  // BOTH fallbacks are scoped to the Veloka base (2026-07-28). The env check
  // used to be unconditional, so ANY campaign with no configured account
  // resolved to Kunal's personal LinkedIn and would have published a second
  // user's comments under his name. A campaign that has not connected an
  // account must resolve to "" and be told to connect one.
  if (baseId === VELOKA_BASE) {
    if (process.env.VELOKA_UNIPILE_ACCOUNT_ID) return process.env.VELOKA_UNIPILE_ACCOUNT_ID;
    return VELOKA_ACCOUNT_FALLBACK;
  }
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

  // ── action:"comments" — READ-ONLY listing of a post's comments ────────
  // Added 2026-08-05 to locate a comment after the fact. Unipile has no
  // delete endpoint for comments, so when one lands that should not have,
  // the only remedy is a human deleting it on LinkedIn — and to do that they
  // need to find it. Never writes.
  if (body?.action === "comments") {
    const sid = socialIdFromUrl(postUrl);
    if (!sid) return NextResponse.json({ ok: false, error: "no post id in url" }, { status: 400 });
    const acct = await resolveAccountId(body.accountId, baseId);
    if (!acct) return NextResponse.json({ ok: false, error: "no account" }, { status: 400 });
    const out = [];
    const ident = await fetchPostIdentity(sid, acct);
    for (const urn of [...new Set([sid, ...(ident.canonicalIds || [])])]) {
      const g = await unipileReq(`/posts/${encodeURIComponent(urn)}/comments?account_id=${encodeURIComponent(acct)}&limit=50`);
      const items = (g.data?.items || g.data?.data || []);
      out.push({
        urn, status: g.status, count: items.length,
        comments: items.map(c => ({
          id: c.id || c.comment_id || "",
          author: c?.author?.name || c?.author_name || "",
          date: c.date || c.created_at || "",
          text: String(c.text || "").replace(/\s+/g, " ").slice(0, 200),
        })),
      });
    }
    return NextResponse.json({ ok: true, post: ident, lists: out });
  }

  // ── action:"delete-comment" — remove a comment we should not have left ──
  // middleware.js in sidekick-posts warns that this integration publishes "a
  // REAL public LinkedIn comment under a real person's name with no delete
  // endpoint upstream". That was an assumption, never tested. It is tested
  // here, because on 2026-08-05 a diagnostic ran with dryRun:false against a
  // real post and left a comment on a stranger's post under Kunal's name.
  // Tries each plausible shape and reports exactly what the vendor said, so
  // the answer is on record either way.
  if (body?.action === "delete-comment") {
    const acct = await resolveAccountId(body.accountId, baseId);
    const cid = String(body.commentId || "");
    const pid = String(body.postUrn || "");
    if (!cid || !acct) return NextResponse.json({ ok: false, error: "commentId and account required" }, { status: 400 });
    const shapes = [
      `/posts/comments/${encodeURIComponent(cid)}?account_id=${encodeURIComponent(acct)}`,
      `/posts/${encodeURIComponent(pid)}/comments/${encodeURIComponent(cid)}?account_id=${encodeURIComponent(acct)}`,
      `/comments/${encodeURIComponent(cid)}?account_id=${encodeURIComponent(acct)}`,
      `/posts/${encodeURIComponent(cid)}?account_id=${encodeURIComponent(acct)}`,
    ];
    const tried = [];
    for (const p of shapes) {
      const r = await unipileReq(p, "DELETE");
      tried.push({ path: p.split("?")[0], status: r.status, ok: r.ok, detail: typeof r.data === "object" ? JSON.stringify(r.data).slice(0, 160) : String(r.data ?? "").slice(0, 160) });
      if (r.ok) return NextResponse.json({ ok: true, deleted: true, tried });
    }
    return NextResponse.json({ ok: false, deleted: false, tried }, { status: 502 });
  }

  const social_id = socialIdFromUrl(postUrl);
  if (!social_id) {
    return NextResponse.json({ ok: false, reason: "no_post_id", error: "Could not read the post id from the URL. Open the post and try again." }, { status: 400 });
  }
  // A comment URN targets a REPLY, not a post — posting to it would either fail
  // or land the text somewhere the operator did not intend. Refuse explicitly.
  if (urnKind(social_id) === "comment") {
    return NextResponse.json({ ok: false, reason: "not_a_post", error: "That link points at a comment, not a post. Open it on LinkedIn and reply there." }, { status: 400 });
  }
  // Send the activity form first (the only shape Unipile accepts), keeping the
  // extracted URN as a single fallback. Deduped, so an activity URN = 1 call.
  const attempts = [...new Set([asActivityUrn(social_id), social_id].filter(Boolean))];
  const clean = cleanComment(text);
  if (!clean) return NextResponse.json({ ok: false, error: "Comment text is empty" }, { status: 400 });

  // ── DEFAULT SAFE (2026-08-05) ──────────────────────────────────────────
  // `dryRun` defaulted to false, so "publish publicly under a real person's
  // name" was what you got by FORGETTING a field. On 2026-08-05 a diagnostic
  // script did exactly that and left a junk comment on a stranger's post under
  // Kunal's name; Unipile has no delete endpoint (tested, four shapes, all
  // 404), so a human had to remove it by hand. An irreversible public action
  // must never be the default branch. Publishing now requires saying so.
  // The sidekick-posts proxy sends `live: true`; nothing else should.
  if (!dryRun && body?.live !== true) {
    return NextResponse.json(
      { ok: false, reason: "not_confirmed_live",
        error: "Refusing to publish: a live comment requires live:true. Use dryRun:true to validate the chain without posting." },
      { status: 400 }
    );
  }

  const acctId = await resolveAccountId(body.accountId, baseId);
  if (!acctId) {
    return NextResponse.json({ ok: false, error: "No LinkedIn account is assigned for this campaign. Assign one in LinkedIn Automation." }, { status: 400 });
  }
  const name = await accountName(acctId);

  if (dryRun) {
    // A dry run used to validate everything EXCEPT the one thing that actually
    // fails in the field: whether Unipile can reach the post at all. It can now,
    // read-only, so a pre-flight is worth running.
    const identity = await fetchPostIdentity(attempts[0], acctId);
    // Which URN does the COMMENTS sub-resource answer to? GET /posts/{urn}
    // resolving proves nothing about commenting: on 2026-08-05 a post GET-ed
    // fine on its activity URN and still 422'd when commented on. Listing the
    // comments is the same sub-resource the POST writes to, and it is read-only,
    // so it is the honest pre-flight.
    const candidates = [...new Set([...attempts, ...(identity.canonicalIds || [])])];
    const commentEndpoint = [];
    for (const urn of candidates) {
      const g = await unipileReq(`/posts/${encodeURIComponent(urn)}/comments?account_id=${encodeURIComponent(acctId)}&limit=1`);
      commentEndpoint.push({
        urn,
        status: g.status,
        ok: g.ok,
        detail: g.ok ? undefined : (typeof g.data === "object" ? JSON.stringify(g.data).slice(0, 160) : String(g.data ?? "").slice(0, 160)),
      });
    }
    return NextResponse.json({
      ok: true,
      dryRun: true,
      post: identity,
      commentEndpoint,
      wouldPost: { social_id, attempts, account: { id: acctId, name }, text: clean, textLength: clean.length },
    });
  }

  // LIVE: post the comment. Retry ONLY on a definitive rejection (400/422) —
  // those mean Unipile refused the id outright and created nothing, so a second
  // attempt with a different URN shape cannot double-post. A 5xx or a network
  // failure is NEVER retried: the comment may well have landed.
  let res = null;
  let used = attempts[0];
  const tried = [];
  for (const candidate of attempts) {
    used = candidate;
    tried.push(candidate);
    res = await unipileReq(`/posts/${encodeURIComponent(candidate)}/comments`, "POST", {
      account_id: acctId,
      text: clean,
    });
    if (res.ok) break;
    if (res.status !== 400 && res.status !== 422) break;
  }

  // LAST RESORT on a definitive rejection (2026-08-05). Every id we have tried
  // so far was derived from the URL by re-wrapping digits. If Unipile says the
  // post cannot be found, ASK it: a read-only GET returns the id Unipile itself
  // uses for this post, which is frequently a different URN kind than the URL
  // carried. Bounded to 400/422 for the same reason as the loop above — those
  // mean nothing was created, so another attempt cannot double-post. A 5xx or a
  // network error is still never retried.
  let probe = null;
  if (res && !res.ok && (res.status === 400 || res.status === 422)) {
    probe = await fetchPostIdentity(attempts[0], acctId);
    const fresh = (probe.canonicalIds || []).filter(u => !tried.includes(u));
    for (const candidate of fresh) {
      used = candidate;
      tried.push(candidate);
      res = await unipileReq(`/posts/${encodeURIComponent(candidate)}/comments`, "POST", {
        account_id: acctId,
        text: clean,
      });
      if (res.ok) break;
      if (res.status !== 400 && res.status !== 422) break;
    }
  }

  if (!res || !res.ok) {
    let { reason, message } = classifyUnipileError(res?.status, res?.data);
    // Unipile answers "Post cannot be found" for a post it can happily GET.
    // Samarth hit this 2026-08-05 and was told the post was "most likely
    // deleted, made private, or has comments restricted" — then commented on it
    // by hand thirty seconds later. Telling an operator a live post is dead is
    // worse than saying nothing. If the read-only probe reached it, say what is
    // actually true: LinkedIn refused this ONE post, the manual path works.
    if (probe?.reachable && (res?.status === 400 || res?.status === 422)) {
      reason = "post_rejects_api_comment";
      message = "LinkedIn will not accept an API comment on this particular post, though the post is fine. Your comment is copied. Open it on LinkedIn and paste it there.";
    }
    const detail =
      typeof res?.data === "object" && res?.data
        ? JSON.stringify(res.data).slice(0, 500)
        : String(res?.data ?? "").slice(0, 500);
    // Logged so the NEXT failure is diagnosable after the fact. Before this, the
    // route swallowed everything except a 300-char `detail` and Vercel kept no
    // record at all, which is why the 2026-07-27 call failure could not be
    // traced the same day.
    // `probe` is included because Vercel's runtime log window is about an hour
    // on this plan: by the time an operator reports "it errored", the log is
    // gone. Whether the post was even REACHABLE is the first question anyone
    // asks next, so it travels in the response too, not just the log.
    console.error(
      "[sidekick/comment] post failed",
      JSON.stringify({ tried, used, account: acctId, status: res?.status ?? 0, reason, detail, probe })
    );
    return NextResponse.json(
      { ok: false, reason, error: message, detail, status: res?.status ?? 0, social_id: used, tried, probe, account: { id: acctId, name } },
      { status: 502 }
    );
  }
  const commentId = (res.data && typeof res.data === "object" && (res.data.id || res.data.comment_id)) || null;
  return NextResponse.json({ ok: true, commentId, social_id: used, account: { id: acctId, name }, text: clean });
}
