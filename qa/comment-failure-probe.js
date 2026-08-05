// ═══════════════════════════════════════════════════════════════════
// READ-ONLY probe into Kunal's 2026-08-05 auto-comment failure.
//
// He reported: the first auto-comment errored (he then used copy + open
// LinkedIn, which worked), the second auto-comment succeeded untouched.
// Vercel's runtime log window no longer reaches 07:52-07:55 UTC, so this
// reconstructs what happened from Unipile itself.
//
// NOTHING IS POSTED. Only GETs. Two questions:
//   1. Is any of these posts unreachable / restricted for his account?
//      (that is the `post_unavailable` class)
//   2. Did the "failed" attempt actually land, leaving a DUPLICATE next to
//      the one he then posted manually? A 5xx is never retried precisely
//      because the side effect may already have happened.
// ═══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const envTxt = fs.readFileSync(path.join(__dirname, "..", ".env.unipile-pull"), "utf8");
const env = Object.fromEntries(envTxt.split("\n").map(l => {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/); return m ? [m[1], m[2].replace(/^["']|["']$/g, "")] : null;
}).filter(Boolean));

const ACCOUNT = process.env.ACCOUNT_ID || "iqFY_VqkTty6Ns6q-kpxvA"; // Kunal's connected LinkedIn

function buildUrl(p) {
  let dsn = String(env.UNIPILE_DSN || "").replace(/\/$/, "");
  let portParam = "";
  const m = dsn.match(/^(https?:\/\/[^:\/]+)(?::(\d+))?/i);
  if (m && m[2]) { dsn = m[1]; portParam = `port=${m[2]}`; }
  const sep = p.includes("?") ? "&" : "?";
  return `${dsn}/api/v1${p}${portParam ? sep + portParam : ""}`;
}
async function get(p) {
  const r = await fetch(buildUrl(p), { headers: { "X-API-KEY": env.UNIPILE_API_KEY, Accept: "application/json" } });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch { return { status: r.status, data: t }; }
}

// The posts Kunal worked on, from the cost log for 2026-08-05 07:52-07:55 UTC.
const IDS = [
  "7490329866286809088",
  "7490265612762595328",
  "7490258979181248512",
  "7490307260460609536",
];
// An activity id encodes its post time in the high bits.
const postedAt = id => new Date(Number(BigInt(id) >> 22n)).toISOString();

(async () => {
  const me = await get(`/accounts/${ACCOUNT}`);
  const im = me.data?.connection_params?.im || {};
  const myName = me.data?.name || im.username || im.publicIdentifier || "";
  const myId = im.id || im.provider_id || "";
  console.log(`account ${ACCOUNT} -> ${myName || "(unknown)"} [${me.status}] providerId=${myId}\n`);

  for (const id of IDS) {
    const urn = `urn:li:activity:${id}`;
    console.log("=".repeat(74));
    console.log(`${urn}   posted ${postedAt(id)}`);
    const post = await get(`/posts/${encodeURIComponent(urn)}?account_id=${ACCOUNT}`);
    const author = post.data?.author?.name || post.data?.author_name || "";
    console.log(`  GET /posts        -> ${post.status} ${post.status === 200
      ? `author="${author}" comments=${post.data?.comment_counter ?? "?"}`
      : JSON.stringify(post.data).slice(0, 220)}`);

    const cs = await get(`/posts/${encodeURIComponent(urn)}/comments?account_id=${ACCOUNT}&limit=100`);
    if (cs.status !== 200) {
      console.log(`  GET /comments     -> ${cs.status} ${JSON.stringify(cs.data).slice(0, 200)}`);
      continue;
    }
    const items = cs.data?.items || cs.data?.data || [];
    const mine = items.filter(c => {
      const n = c?.author?.name || c?.author_name || "";
      return myName && n.toLowerCase().includes(myName.toLowerCase().split(" ")[0]);
    });
    console.log(`  GET /comments     -> ${items.length} total, ${mine.length} from ${myName || "this account"}`);
    mine.forEach((c, i) => {
      const when = c.date || c.created_at || c.timestamp || "";
      console.log(`     [${i + 1}] ${when}  "${String(c.text || "").replace(/\s+/g, " ").slice(0, 110)}"`);
    });
    if (mine.length > 1) console.log("     *** DUPLICATE — a 'failed' post may actually have landed ***");
  }
})();
