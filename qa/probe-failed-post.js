// READ-ONLY. Drives the real comment chain in dryRun against the post that
// 422'd for Samarth on 2026-08-05 13:19 UTC, and a control post that succeeded
// at 13:22, so the difference between them is visible. Nothing is posted.
const BASE = process.env.QA_BASE || "https://sidekick-posts.vercel.app";
const PASS = process.env.QA_PASS || "tester.sidekick.2856";

// From the Vercel error log: tried ["urn:li:activity:7490314258417766400"],
// status 422, "Post cannot be found".
const FAILED = "https://www.linkedin.com/feed/update/urn:li:activity:7490314258417766400";
// Posts from the same session that the app handled without complaint.
const CONTROLS = [
  "https://www.linkedin.com/feed/update/urn:li:activity:7490329866286809088",
  "https://www.linkedin.com/feed/update/urn:li:activity:7490265612762595328",
];

(async () => {
  const r = await fetch(`${BASE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: PASS }),
  });
  const cookie = (r.headers.get("set-cookie") || "").match(/^([^;]+)/)[1];

  for (const [label, url] of [["FAILED  ", FAILED], ...CONTROLS.map((u, i) => [`control${i + 1}`, u])]) {
    const res = await fetch(`${BASE}/api/comment-linkedin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ postUrl: url, text: "probe only, never posted", dryRun: true }),
    });
    const d = await res.json().catch(() => ({}));
    const id = (url.match(/activity:(\d+)/) || [])[1];
    console.log("=".repeat(74));
    console.log(`${label}  activity:${id}  posted ${new Date(Number(BigInt(id) >> 22n)).toISOString()}`);
    console.log(`  http ${res.status}  account="${d?.wouldPost?.account?.name || "?"}" (${d?.wouldPost?.account?.id || "?"})`);
    console.log(`  attempts the live path would make: ${JSON.stringify(d?.wouldPost?.attempts || [])}`);
    console.log(`  Unipile sees the post: ${JSON.stringify(d?.post || d?.error || "(no probe field - old build?)")}`);
  }
})();
