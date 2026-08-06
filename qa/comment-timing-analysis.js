// ═══════════════════════════════════════════════════════════════════
// Kunal 2026-08-06: "my comments are getting between 2 and 10 impressions. In
// contrast, my organic comments on LinkedIn when I'm browsing get between
// 100-300 impressions."
//
// HYPOTHESIS: it is not the comment, it is WHEN it lands. Browsing means
// commenting on posts minutes to a couple of hours old, while they are still
// being pushed into feeds. A queue means commenting whenever he opens the app,
// which can be a day or more after the post went up and long after LinkedIn
// stopped distributing it. A comment on a dead post reaches the author and
// almost nobody else, which is exactly the 2-10 he is seeing.
//
// A LinkedIn activity id encodes its post time in the high bits, so every task
// in the queue can be dated exactly with no extra API calls.
// ═══════════════════════════════════════════════════════════════════
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
const KEY = env.SIDEKICK_API_KEY;
const API = "https://news-material-two.vercel.app/api/sidekick/feed";

const BASES = [
  ["Veloka (Kunal)", "appPcAzAyMmtNNEmT"],
];

const postedAt = id => new Date(Number(BigInt(id) >> 22n));
const HOURS = ms => ms / 36e5;

(async () => {
  const now = Date.now();
  for (const [label, baseId] of BASES) {
    const r = await fetch(`${API}?baseId=${baseId}&limit=100`, {
      headers: { Authorization: `Bearer ${KEY}` }, cache: "no-store",
    });
    const d = await r.json().catch(() => ({}));
    const cards = d.cards || d.items || [];
    const engagement = cards.filter(c => c.task_type === "linkedin_engagement");
    console.log(`\n${"=".repeat(72)}\n${label}  —  ${cards.length} pending tasks, ${engagement.length} are comment tasks`);

    const ages = [];
    for (const c of engagement) {
      const m = String(c.url || "").match(/(?:activity[-:]|ugcPost:)(\d{15,})/);
      if (!m) continue;
      const t = postedAt(m[1]);
      ages.push({ h: HOURS(now - t.getTime()), who: c.lead_name || "?", when: t.toISOString() });
    }
    if (!ages.length) { console.log("  no datable posts in the queue"); continue; }
    ages.sort((a, b) => a.h - b.h);

    const bucket = (lo, hi) => ages.filter(a => a.h >= lo && a.h < hi).length;
    const pct = n => `${Math.round((n / ages.length) * 100)}%`;
    console.log(`\n  AGE OF THE POST, right now, for everything sitting in his queue:`);
    console.log(`    under 2h   ${String(bucket(0, 2)).padStart(3)}  ${pct(bucket(0, 2)).padStart(4)}   <- the window organic commenting lives in`);
    console.log(`    2h to 6h   ${String(bucket(2, 6)).padStart(3)}  ${pct(bucket(2, 6)).padStart(4)}`);
    console.log(`    6h to 24h  ${String(bucket(6, 24)).padStart(3)}  ${pct(bucket(6, 24)).padStart(4)}`);
    console.log(`    1d to 3d   ${String(bucket(24, 72)).padStart(3)}  ${pct(bucket(24, 72)).padStart(4)}`);
    console.log(`    over 3d    ${String(bucket(72, 1e9)).padStart(3)}  ${pct(bucket(72, 1e9)).padStart(4)}`);
    const med = ages[Math.floor(ages.length / 2)].h;
    console.log(`\n    median age ${med.toFixed(1)}h   youngest ${ages[0].h.toFixed(1)}h   oldest ${ages[ages.length - 1].h.toFixed(1)}h`);
    console.log(`    share already older than 24h: ${pct(ages.filter(a => a.h >= 24).length)}`);
    console.log(`\n  youngest 5 in the queue:`);
    ages.slice(0, 5).forEach(a => console.log(`    ${a.h.toFixed(1).padStart(6)}h  ${a.who}`));
  }
})();
