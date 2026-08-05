// READ-ONLY probe straight at the SignalScope backend (skips the sidekick-posts
// login, so it can address the Veloka campaign and the account that actually
// failed). Nothing is posted: dryRun only.
//
// Context: 2026-08-05 13:19 UTC, account AjM_nuLXTpCn8MTQxt2hnQ got
//   422 errors/invalid_post "Post cannot be found" on
//   urn:li:activity:7490314258417766400
// after exactly ONE attempt, while the next post at 13:22 succeeded. Samarth
// then commented on the failed post BY HAND without trouble, so the post is
// neither deleted nor comment-restricted for him.
const fs = require("fs");
const path = require("path");

function readEnv(p) {
  try {
    return Object.fromEntries(fs.readFileSync(p, "utf8").split("\n").map(l => {
      const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      return m ? [m[1], m[2].replace(/^["']|["']$/g, "")] : null;
    }).filter(Boolean));
  } catch { return {}; }
}
const env = { ...readEnv(path.join(__dirname, "..", ".env.local")),
              ...readEnv(path.join(__dirname, "..", "..", "sidekick-posts", ".env.local")) };
const KEY = process.env.SIDEKICK_API_KEY || env.SIDEKICK_API_KEY;
const API = "https://news-material-two.vercel.app/api/sidekick/comment";
const VELOKA_BASE = "appPcAzAyMmtNNEmT";
const ACCOUNT = "AjM_nuLXTpCn8MTQxt2hnQ";   // the account that hit the 422

const POSTS = [
  ["FAILED 13:19", "7490314258417766400"],
  ["ok?  control", "7490329866286809088"],
  ["ok?  control", "7490265612762595328"],
  ["ok?  control", "7490307260460609536"],
];

(async () => {
  if (!KEY) { console.error("no SIDEKICK_API_KEY found locally"); process.exit(1); }
  for (const [label, id] of POSTS) {
    const r = await fetch(API, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        baseId: VELOKA_BASE,
        accountId: ACCOUNT,
        postUrl: `https://www.linkedin.com/feed/update/urn:li:activity:${id}`,
        text: "probe only, never posted",
        dryRun: true,
      }),
    });
    const d = await r.json().catch(() => ({}));
    console.log("=".repeat(76));
    console.log(`${label}  activity:${id}  posted ${new Date(Number(BigInt(id) >> 22n)).toISOString()}`);
    console.log(`  http ${r.status}  account="${d?.wouldPost?.account?.name || "?"}"`);
    console.log(`  live path would try: ${JSON.stringify(d?.wouldPost?.attempts || [])}`);
    console.log(`  Unipile GET /posts : ${JSON.stringify(d?.post ?? d?.error ?? "(no probe field)")}`);
  }
})();
