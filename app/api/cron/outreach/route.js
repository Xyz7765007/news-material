import { NextResponse } from "next/server";

// Vercel Cron — runs every 4 hours to process outreach queues
// Reads active outreach rules from master base, processes each campaign's queue

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AT_API = "https://api.airtable.com/v0";
const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

export async function GET(request) {
  // Verify cron secret (Vercel sends this header)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log("[CRON] Outreach processing started");

  try {
    // Load campaigns from master base
    const campRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}`, { headers: atHdr });
    if (!campRes.ok) return NextResponse.json({ error: "Failed to load campaigns" }, { status: 500 });
    const { records: campaigns } = await campRes.json();

    let totalProcessed = 0;

    for (const camp of (campaigns || [])) {
      const cf = camp.fields || {};
      const baseId = cf["Base ID"];
      const features = (cf.Features || "").split(",").map(s => s.trim());
      if (!baseId || !features.includes("linkedin_outreach")) continue;

      // Load outreach rules for this campaign
      const rulesRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Task Rules")}`, { headers: atHdr });
      if (!rulesRes.ok) continue;
      const { records: rules } = await rulesRes.json();

      const outreachRules = (rules || []).filter(r => (r.fields || {})["Task Type"] === "linkedin_outreach");

      for (const rule of outreachRules) {
        const rf = rule.fields || {};
        let config;
        try { config = JSON.parse(rf["Outreach Config"] || "{}"); } catch { config = {}; }
        if (!config.accountId || !config.active) continue;

        console.log(`[CRON] Processing: ${rf.Name} (${cf.Name})`);

        // Call the outreach API to process queue
        const processRes = await fetch(new URL("/api/outreach", request.url).toString(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "process_queue",
            baseId,
            campaignId: camp.id, // for AI cost tracking — billing attribution
            accountId: config.accountId,
            ruleConfig: { ...config, name: rf.Name },
          }),
        });

        if (processRes.ok) {
          const result = await processRes.json();
          console.log(`[CRON] ${rf.Name}: ${result.connectionsSent} conn, ${result.dmsSent} DMs, ${result.errors} errors`);
          totalProcessed += result.processed;
        }
      }
    }

    console.log(`[CRON] Done. ${totalProcessed} items processed.`);
    return NextResponse.json({ ok: true, processed: totalProcessed });
  } catch (error) {
    console.error("[CRON] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
