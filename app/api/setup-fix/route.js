// ─── Setup Auto-Fix ────────────────────────────────────────────────
// Reads the same schema requirements as setup-diagnostic and calls
// bootstrapTable() for each missing or incomplete table. Run AFTER
// setup-diagnostic to fix everything bootstrap can fix automatically.
//
// What this CAN fix: create missing tables, add missing fields with proper types
// What this CANNOT fix: change an EXISTING field's type (Airtable doesn't allow
//   in-place type changes via API). Those still need manual Airtable column
//   edit (or column delete + this endpoint re-run).
//
// USAGE: POST /api/setup-fix?key=<CRON_SECRET>

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store"; // Critical: disable Next.js fetch cache so Airtable data is always fresh
export const maxDuration = 120;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const metaHdr = AIRTABLE_KEY ? { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" } : null;

// ─── bootstrap helper (same logic as outreach route) ───────────────
async function bootstrapTable(baseId, tableName, fieldDefs) {
  if (!baseId || !AIRTABLE_KEY) return { ok: false, error: "Missing baseId or AIRTABLE_API_KEY" };

  const normalized = fieldDefs.map(fd => typeof fd === "string"
    ? { name: fd, type: "singleLineText" }
    : { name: fd.name, type: fd.type || "singleLineText", options: fd.options }
  );

  let tables;
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: metaHdr });
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 401 || r.status === 403) {
        return { ok: false, missingScope: true, error: `PAT lacks schema.bases:read on ${baseId}` };
      }
      return { ok: false, error: `Failed to list tables: HTTP ${r.status} — ${t.slice(0, 200)}` };
    }
    const d = await r.json();
    tables = d.tables || [];
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }

  const existing = tables.find(t => t.name === tableName);

  if (existing) {
    const existingByName = new Map((existing.fields || []).map(f => [f.name, f]));
    const missing = normalized.filter(fd => !existingByName.has(fd.name));
    if (missing.length === 0) return { ok: true, action: "already_complete" };

    const errors = [];
    const added = [];
    for (const fd of missing) {
      try {
        const body = { name: fd.name, type: fd.type };
        if (fd.options) body.options = fd.options;
        const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${existing.id}/fields`, {
          method: "POST", headers: metaHdr, body: JSON.stringify(body),
        });
        if (!r.ok) errors.push(`${fd.name}: ${(await r.text()).slice(0, 100)}`);
        else added.push(fd.name);
      } catch (e) {
        errors.push(`${fd.name}: ${e.message}`);
      }
    }
    if (errors.length) return { ok: false, error: `Added ${added.length}, failed ${errors.length}: ${errors.join("; ").slice(0, 300)}`, added, failed: errors };
    return { ok: true, action: "fields_added", added };
  }

  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, {
      method: "POST", headers: metaHdr,
      body: JSON.stringify({ name: tableName, fields: normalized }),
    });
    if (!r.ok) {
      const t = await r.text();
      if (r.status === 401 || r.status === 403) {
        return { ok: false, missingScope: true, error: `PAT lacks schema.bases:write on ${baseId}` };
      }
      return { ok: false, error: `Failed to create table: HTTP ${r.status} — ${t.slice(0, 200)}` };
    }
    return { ok: true, action: "created" };
  } catch (e) {
    return { ok: false, error: `Network error: ${e.message}` };
  }
}

// ─── Schema definitions ──────────────────────────────────────────
const TZ_ISO = { timeZone: "utc", dateFormat: { name: "iso" }, timeFormat: { name: "24hour" } };

const MASTER_TABLES = {
  "Cron Run Log": [
    { name: "Cron Name", type: "singleLineText" },
    { name: "Run At", type: "dateTime", options: TZ_ISO },
    { name: "Trigger", type: "singleLineText" },
    { name: "Status", type: "singleLineText" },
    { name: "Duration ms", type: "number", options: { precision: 0 } },
    { name: "Campaigns Checked", type: "number", options: { precision: 0 } },
    { name: "Outreach Rules Found", type: "number", options: { precision: 0 } },
    { name: "Active Rules", type: "number", options: { precision: 0 } },
    { name: "Connections Sent", type: "number", options: { precision: 0 } },
    { name: "DMs Sent", type: "number", options: { precision: 0 } },
    { name: "Errors Count", type: "number", options: { precision: 0 } },
    { name: "Details", type: "multilineText" },
  ],
};

const CAMPAIGN_TABLES = {
  "Outreach": [
    { name: "Lead Name", type: "singleLineText" },
    { name: "LinkedIn URL", type: "singleLineText" },
    { name: "Campaign", type: "singleLineText" },
    { name: "Mode", type: "singleLineText" },
    { name: "Status", type: "singleLineText" },
    { name: "Company", type: "singleLineText" },
    { name: "Title", type: "singleLineText" },
    { name: "Email", type: "singleLineText" },
    { name: "Signal", type: "multilineText" },
    { name: "DM Step", type: "number", options: { precision: 0 } },
    { name: "Next Action Date", type: "date", options: { dateFormat: { name: "iso" } } },
    { name: "Created At", type: "dateTime", options: TZ_ISO },
    { name: "Connection Sent At", type: "dateTime", options: TZ_ISO },
    { name: "Last DM Sent At", type: "dateTime", options: TZ_ISO },
    { name: "Unipile Chat ID", type: "singleLineText" },
    { name: "Notes", type: "multilineText" },
    { name: "Replied At", type: "dateTime", options: TZ_ISO },
    { name: "Connection Accepted At", type: "dateTime", options: TZ_ISO },
  ],
  "Tasks": [
    // Don't redefine "Name" — Airtable uses the existing primary
    { name: "Company", type: "singleLineText" },
    { name: "Source", type: "singleLineText" },
    { name: "Task Type", type: "singleLineText" },
    { name: "Score", type: "number", options: { precision: 0 } },
    { name: "Signal", type: "multilineText" },
    { name: "Event ID", type: "singleLineText" },
    { name: "Account ID", type: "singleLineText" },
    { name: "URL", type: "url" },
    { name: "Created", type: "dateTime", options: TZ_ISO },
  ],
  "Sent Messages Review": [
    { name: "Lead Name", type: "singleLineText" },
    { name: "LinkedIn URL", type: "singleLineText" },
    { name: "Company", type: "singleLineText" },
    { name: "Title", type: "singleLineText" },
    { name: "Message Type", type: "singleLineText" },
    { name: "Template Used", type: "multilineText" },
    { name: "AI Output (Sent)", type: "multilineText" },
    { name: "AI Input Context", type: "multilineText" },
    { name: "Campaign", type: "singleLineText" },
    { name: "Account ID", type: "singleLineText" },
    { name: "Unipile Chat ID", type: "singleLineText" },
    { name: "Sent At", type: "dateTime", options: TZ_ISO },
    { name: "Status", type: "singleLineText" },
    { name: "Reviewer Notes", type: "multilineText" },
    { name: "Reviewed At", type: "dateTime", options: TZ_ISO },
  ],
};

export async function POST(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized — pass ?key=<CRON_SECRET>" }, { status: 401 });
  }
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return NextResponse.json({ error: "AIRTABLE_API_KEY or AIRTABLE_BASE_ID env var not set" }, { status: 500 });
  }

  const report = { master: {}, campaigns: [], summary: { fixed: 0, failed: 0, warnings: [] } };

  // ─── Fix master base tables ────────────────────────────────────
  for (const [tableName, fields] of Object.entries(MASTER_TABLES)) {
    const r = await bootstrapTable(MASTER_BASE_ID, tableName, fields);
    report.master[tableName] = r;
    if (r.ok) report.summary.fixed++;
    else report.summary.failed++;
  }

  // ─── For each linkedin_outreach campaign, fix its tables ───────
  try {
    const campRes = await fetch(`https://api.airtable.com/v0/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}`, { headers: metaHdr });
    if (campRes.ok) {
      const { records } = await campRes.json();
      for (const camp of (records || [])) {
        const cf = camp.fields || {};
        const rawFeatures = cf.Features;
        const features = Array.isArray(rawFeatures)
          ? rawFeatures.map(s => String(s).trim())
          : String(rawFeatures || "").split(",").map(s => s.trim());
        if (!features.includes("linkedin_outreach")) continue;
        const baseId = cf["Base ID"];
        if (!baseId) {
          report.campaigns.push({ name: cf.Name, error: "no Base ID set" });
          continue;
        }
        const campReport = { name: cf.Name, baseId, tables: {} };
        for (const [tableName, fields] of Object.entries(CAMPAIGN_TABLES)) {
          const r = await bootstrapTable(baseId, tableName, fields);
          campReport.tables[tableName] = r;
          if (r.ok) report.summary.fixed++;
          else report.summary.failed++;
        }
        report.campaigns.push(campReport);
      }
    } else {
      report.summary.warnings.push(`Could not enumerate campaigns: HTTP ${campRes.status}`);
    }
  } catch (e) {
    report.summary.warnings.push(`Campaign enumeration error: ${e.message}`);
  }

  // ─── Detect type mismatches (can't fix; need manual action) ────
  // Re-list each base to find fields with wrong types
  const typeFixesNeeded = [];
  const allBases = [{ baseId: MASTER_BASE_ID, tables: MASTER_TABLES, label: "master" }];
  for (const camp of report.campaigns) {
    if (camp.baseId) allBases.push({ baseId: camp.baseId, tables: CAMPAIGN_TABLES, label: camp.name });
  }

  for (const { baseId, tables, label } of allBases) {
    try {
      const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: metaHdr });
      if (!r.ok) continue;
      const d = await r.json();
      for (const [tableName, expectedFields] of Object.entries(tables)) {
        const actual = (d.tables || []).find(t => t.name === tableName);
        if (!actual) continue;
        const byName = new Map((actual.fields || []).map(f => [f.name, f]));
        for (const fd of expectedFields) {
          const exists = byName.get(fd.name);
          if (exists && exists.type !== fd.type) {
            typeFixesNeeded.push({
              base: label, baseId, table: tableName, field: fd.name,
              currentType: exists.type, requiredType: fd.type,
              action: `In Airtable, open "${label}" → "${tableName}" → "${fd.name}" column → "Customize field type" → change to ${fd.type}. (Bootstrap can't change types in-place; you must do this manually OR delete the column and re-run /api/setup-fix.)`,
            });
          }
        }
      }
    } catch {}
  }
  report.typeFixesNeeded = typeFixesNeeded;
  report.summary.typeFixesNeededCount = typeFixesNeeded.length;
  report.allGreen = report.summary.failed === 0 && typeFixesNeeded.length === 0;

  return NextResponse.json(report);
}
