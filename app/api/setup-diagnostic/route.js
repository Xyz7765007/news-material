// ─── Setup Diagnostic ──────────────────────────────────────────────
// One-shot endpoint that audits the full SignalScope setup:
//   - Master base tables (Campaigns, Account Routing, Unrouted Triggers, Cron Run Log)
//   - For each linkedin_outreach campaign: Leads, Outreach, Sent Messages Review
//   - For each table: required fields present? wrong types?
//   - Reports back a clear checklist of what's working vs what to fix
//
// USAGE: GET /api/setup-diagnostic?key=<CRON_SECRET>
//        Returns a JSON report; UI surfaces it as a setup checklist.

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const metaHdr = AIRTABLE_KEY ? { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" } : null;

// Required schema per table — field name → expected type
const SCHEMA_REQUIREMENTS = {
  master: {
    "Campaigns": {
      "Name": "singleLineText",
      "Base ID": "singleLineText",
      "Features": "singleLineText",
    },
    "Account Routing": {
      "Name": "singleLineText",
      "Account ID": "singleLineText",
      "Account Name": "singleLineText",
      "Campaign Base ID": "singleLineText",
      "Client Name": "singleLineText",
      "Active": "checkbox",
      "Provider": "singleLineText",
    },
    "Unrouted Triggers": {
      "Account ID": "singleLineText",
      "Event Type": "singleLineText",
      "Event ID": "singleLineText",
    },
    "Cron Run Log": {
      "Cron Name": "singleLineText",
      "Run At": "dateTime",
      "Status": "singleLineText",
    },
  },
  campaign: {
    "Leads": {
      "Name": "any", // primary; might be configured by user
      "LinkedIn URL": "any",
      "Company": "any",
      "Title": "any",
    },
    "Outreach": {
      "Lead Name": "any",
      "LinkedIn URL": "any",
      "Status": "any",
      "DM Step": "number",                // MUST be number — code sends integer
      "Next Action Date": "any",          // date or text both fine
      "Created At": "any",
      "Connection Sent At": "any",
      "Last DM Sent At": "any",
      "Unipile Chat ID": "any",
      "Notes": "any",
      "Replied At": "any",
      "Connection Accepted At": "any",
    },
    "Tasks": {
      "Name": "any",
      "Company": "any",
      "Source": "any",
      "Task Type": "any",
      "Score": "any",
      "Signal": "any",
      "Event ID": "any",      // webhook dedup
      "Account ID": "any",    // per-account routing context
    },
    "Sent Messages Review": {
      "Lead Name": "any",
      "AI Output (Sent)": "any",
      "Message Type": "any",
      "Status": "any",
      "Sent At": "any",
    },
  },
};

// Read-only types that cause writes to fail
const READ_ONLY_TYPES = new Set(["autoNumber", "formula", "rollup", "lookup", "count", "button", "createdTime", "lastModifiedTime"]);

async function listTables(baseId) {
  try {
    const r = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: metaHdr });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, status: r.status, error: t.slice(0, 300) };
    }
    const d = await r.json();
    return { ok: true, tables: d.tables || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function auditTable(actualTable, requiredFields) {
  const result = {
    name: actualTable.name,
    exists: true,
    missingFields: [],
    typeMismatches: [],
    readOnlyFields: [],
    fieldsPresent: 0,
    fieldsRequired: Object.keys(requiredFields).length,
  };
  const actualFieldsByName = new Map((actualTable.fields || []).map(f => [f.name, f]));
  for (const [reqName, reqType] of Object.entries(requiredFields)) {
    const actual = actualFieldsByName.get(reqName);
    if (!actual) {
      result.missingFields.push(reqName);
      continue;
    }
    result.fieldsPresent++;
    if (READ_ONLY_TYPES.has(actual.type)) {
      result.readOnlyFields.push({ name: reqName, actualType: actual.type, expectedType: reqType });
    }
    if (reqType !== "any" && actual.type !== reqType) {
      result.typeMismatches.push({ name: reqName, actualType: actual.type, expectedType: reqType });
    }
  }
  result.healthy = result.missingFields.length === 0 && result.readOnlyFields.length === 0 && result.typeMismatches.length === 0;
  return result;
}

export async function GET(request) {
  const url = new URL(request.url);
  if (url.searchParams.get("key") !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized — pass ?key=<CRON_SECRET>" }, { status: 401 });
  }
  if (!AIRTABLE_KEY || !MASTER_BASE_ID) {
    return NextResponse.json({ error: "AIRTABLE_API_KEY or AIRTABLE_BASE_ID env var not set" }, { status: 500 });
  }

  const report = {
    masterBase: { id: MASTER_BASE_ID, ok: false, tables: {}, errors: [] },
    campaigns: [],
    summary: { totalIssues: 0, criticalIssues: 0 },
  };

  // ─── Audit master base ──────────────────────────────────────────
  const masterRes = await listTables(MASTER_BASE_ID);
  if (!masterRes.ok) {
    report.masterBase.errors.push(`Could not list tables (HTTP ${masterRes.status}): ${masterRes.error}`);
    if (masterRes.status === 401 || masterRes.status === 403) {
      report.masterBase.errors.push("Likely cause: PAT lacks schema.bases:read on master base");
      report.summary.criticalIssues++;
    }
    return NextResponse.json(report);
  }
  report.masterBase.ok = true;
  for (const [tableName, requiredFields] of Object.entries(SCHEMA_REQUIREMENTS.master)) {
    const actual = masterRes.tables.find(t => t.name === tableName);
    if (!actual) {
      report.masterBase.tables[tableName] = { exists: false, hint: `Table missing in master base. Create it OR call /api/unipile-triggers with action=ensure_routing_tables` };
      report.summary.totalIssues++;
      if (tableName === "Campaigns") report.summary.criticalIssues++; // app can't run without this
    } else {
      report.masterBase.tables[tableName] = auditTable(actual, requiredFields);
      if (!report.masterBase.tables[tableName].healthy) report.summary.totalIssues++;
    }
  }

  // ─── For each campaign with linkedin_outreach feature, audit its base ────
  if (report.masterBase.tables.Campaigns?.exists !== false) {
    try {
      const campRes = await fetch(`https://api.airtable.com/v0/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}`, { headers: metaHdr });
      if (campRes.ok) {
        const { records } = await campRes.json();
        for (const camp of (records || [])) {
          const cf = camp.fields || {};
          const features = (cf.Features || "").split(",").map(s => s.trim());
          if (!features.includes("linkedin_outreach")) continue;
          const baseId = cf["Base ID"];
          if (!baseId) {
            report.campaigns.push({ name: cf.Name, error: "Campaign has no Base ID field set" });
            continue;
          }
          const cRes = await listTables(baseId);
          const campReport = { name: cf.Name, baseId, ok: cRes.ok, tables: {}, errors: [] };
          if (!cRes.ok) {
            campReport.errors.push(`Could not list tables (HTTP ${cRes.status}): ${cRes.error}`);
            if (cRes.status === 401 || cRes.status === 403) {
              campReport.errors.push("Likely cause: PAT lacks schema.bases:read on this campaign base");
              report.summary.criticalIssues++;
            }
            report.campaigns.push(campReport);
            continue;
          }
          for (const [tableName, requiredFields] of Object.entries(SCHEMA_REQUIREMENTS.campaign)) {
            const actual = cRes.tables.find(t => t.name === tableName);
            if (!actual) {
              campReport.tables[tableName] = { exists: false };
              report.summary.totalIssues++;
            } else {
              campReport.tables[tableName] = auditTable(actual, requiredFields);
              if (!campReport.tables[tableName].healthy) report.summary.totalIssues++;
              // Read-only fields on required-write columns are critical
              if (campReport.tables[tableName].readOnlyFields.length > 0) report.summary.criticalIssues++;
            }
          }
          report.campaigns.push(campReport);
        }
      }
    } catch (e) {
      report.summary.totalIssues++;
      report.masterBase.errors.push(`Failed to enumerate campaigns: ${e.message}`);
    }
  }

  // ─── Generate actionable summary ───────────────────────────────
  const actions = [];
  if (report.summary.criticalIssues > 0) {
    actions.push(`⚠ ${report.summary.criticalIssues} CRITICAL issue(s) — fix these first`);
  }
  for (const [tableName, t] of Object.entries(report.masterBase.tables)) {
    if (!t.exists) actions.push(`Master base: create table "${tableName}"`);
    else {
      if (t.missingFields?.length) actions.push(`Master base "${tableName}": add fields ${t.missingFields.join(", ")}`);
      if (t.readOnlyFields?.length) actions.push(`Master base "${tableName}": fix read-only fields → ${t.readOnlyFields.map(f => `${f.name} is ${f.actualType} (need ${f.expectedType})`).join("; ")}`);
    }
  }
  for (const camp of report.campaigns) {
    if (!camp.ok) continue;
    for (const [tableName, t] of Object.entries(camp.tables)) {
      if (!t.exists) actions.push(`"${camp.name}" base: create table "${tableName}"`);
      else {
        if (t.missingFields?.length) actions.push(`"${camp.name}" / "${tableName}": add fields ${t.missingFields.join(", ")}`);
        if (t.readOnlyFields?.length) actions.push(`"${camp.name}" / "${tableName}": fix read-only fields → ${t.readOnlyFields.map(f => `${f.name} is ${f.actualType} (need ${f.expectedType})`).join("; ")}`);
        if (t.typeMismatches?.length) actions.push(`"${camp.name}" / "${tableName}": type mismatches → ${t.typeMismatches.map(f => `${f.name} is ${f.actualType} (need ${f.expectedType})`).join("; ")}`);
      }
    }
  }
  report.actionableChecklist = actions;
  report.healthy = actions.length === 0;
  return NextResponse.json(report, { status: 200 });
}
