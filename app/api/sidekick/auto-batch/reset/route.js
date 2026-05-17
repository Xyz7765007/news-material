import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// AUTO-BATCH RESET
// One-click full reset for the Sidekick Auto-Batch v1 system.
// Deletes EVERY Outreach record with Campaign = "Sidekick Auto-Batch v1",
// regardless of status (pending_approval, queued, skipped, sent, etc.).
//
// Use cases:
//  - Debugging accumulated audit-trail records from many regen cycles
//  - Starting over after a stuck state
//  - Veloka baseline reset before going live
//
// IMPORTANT: Manual Outreach records (other campaigns) are NEVER touched.
// Only records where Campaign field exactly equals "Sidekick Auto-Batch v1"
// get deleted. Manual records continue tracking for replies normally.
//
// Body: { baseId: string, confirm: true }
// Returns: { ok, deletedCount, byStatus: {pending_approval: N, queued: N, ...} }
// ═══════════════════════════════════════════════════════════════════

const AT_API = "https://api.airtable.com/v0";
const AT_KEY = process.env.AIRTABLE_API_KEY;
const atHdr = { Authorization: `Bearer ${AT_KEY}` };

const AUTO_BATCH_CAMPAIGN = "Sidekick Auto-Batch v1";

async function atList(baseId, table, filter) {
  const params = new URLSearchParams();
  if (filter) params.set("filterByFormula", filter);
  params.set("pageSize", "100");
  const all = [];
  let offset = "";
  do {
    if (offset) params.set("offset", offset);
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${params}`, { headers: atHdr });
    if (!r.ok) throw new Error(`atList ${table}: ${r.status} ${await r.text()}`);
    const data = await r.json();
    all.push(...(data.records || []));
    offset = data.offset || "";
  } while (offset);
  return all;
}

async function atDelete(baseId, table, recordIds) {
  // Airtable DELETE supports up to 10 records per request
  const deleted = [];
  for (let i = 0; i < recordIds.length; i += 10) {
    const batch = recordIds.slice(i, i + 10);
    const params = new URLSearchParams();
    batch.forEach(id => params.append("records[]", id));
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${params}`, {
      method: "DELETE",
      headers: atHdr,
    });
    if (!r.ok) {
      const errText = await r.text();
      console.error(`[AUTO-BATCH-RESET] atDelete failed:`, errText.slice(0, 300));
      throw new Error(`atDelete ${table}: ${r.status}`);
    }
    const data = await r.json();
    deleted.push(...(data.records || []));
  }
  return deleted;
}

export async function POST(req) {
  if (!AT_KEY) {
    return NextResponse.json({ error: "AIRTABLE_API_KEY not set" }, { status: 500 });
  }

  let body = {};
  try { body = await req.json(); } catch {}
  const { baseId, confirm } = body;

  if (!baseId) {
    return NextResponse.json({ error: "baseId required" }, { status: 400 });
  }
  if (confirm !== true) {
    return NextResponse.json({
      error: "Confirmation required. Pass { confirm: true } in the body to delete.",
    }, { status: 400 });
  }

  try {
    // 1. Fetch all Outreach records on the Sidekick Auto-Batch v1 campaign
    const records = await atList(
      baseId,
      "Outreach",
      `{Campaign} = '${AUTO_BATCH_CAMPAIGN}'`
    );

    if (!records.length) {
      return NextResponse.json({
        ok: true,
        deletedCount: 0,
        message: "No Sidekick Auto-Batch records to delete — already clean.",
      });
    }

    // 2. Count by status for the response (useful audit log)
    const byStatus = records.reduce((acc, r) => {
      const s = r.fields?.Status || "unknown";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    }, {});

    // 3. Delete in batches of 10
    const ids = records.map(r => r.id);
    await atDelete(baseId, "Outreach", ids);

    // 4. ALSO reset the auto-batch rule's lastBatchGeneratedAt so the next
    //    generate call doesn't think today's batch already exists. Without this,
    //    the idempotency check would block tomorrow's auto-generate-on-mount.
    try {
      const rules = await atList(
        baseId,
        "Task Rules",
        `{Name} = '${AUTO_BATCH_CAMPAIGN}'`
      );
      if (rules.length) {
        const rule = rules[0];
        let config = {};
        try { config = JSON.parse(rule.fields?.["Outreach Config"] || "{}"); } catch {}
        delete config.lastBatchGeneratedAt;
        const r = await fetch(`${AT_API}/${baseId}/Task%20Rules/${rule.id}`, {
          method: "PATCH",
          headers: { ...atHdr, "Content-Type": "application/json" },
          body: JSON.stringify({
            fields: { "Outreach Config": JSON.stringify(config) },
          }),
        });
        if (!r.ok) console.warn("[AUTO-BATCH-RESET] failed to reset lastBatchGeneratedAt:", await r.text());
      }
    } catch (e) {
      console.warn("[AUTO-BATCH-RESET] rule reset (non-fatal):", e.message);
    }

    return NextResponse.json({
      ok: true,
      deletedCount: records.length,
      byStatus,
      message: `Deleted ${records.length} Sidekick Auto-Batch records. Manual Outreach records (and any other campaigns) untouched. Next chatbot mount or Regenerate will create a fresh batch.`,
    });
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
