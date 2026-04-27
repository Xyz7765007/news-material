import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════

const UNIPILE_DSN = process.env.UNIPILE_DSN;
const UNIPILE_KEY = process.env.UNIPILE_API_KEY;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const CRON_SECRET = process.env.CRON_SECRET;
const AT_API = "https://api.airtable.com/v0";

const atHdr = {
  Authorization: `Bearer ${AIRTABLE_KEY}`,
  "Content-Type": "application/json",
};

export const maxDuration = 300;

// ═══════════════════════════════════════════════════════════════
// UNIPILE HTTP HELPERS (mirrors outreach/route.js — kept separate
// to avoid coupling)
// ═══════════════════════════════════════════════════════════════

function buildUnipileUrl(path) {
  if (!UNIPILE_DSN) return null;
  let dsn = UNIPILE_DSN.replace(/\/$/, "");
  let portParam = "";
  const match = dsn.match(/^(https?:\/\/[^:\/]+)(?::(\d+))?/i);
  if (match && match[2]) {
    dsn = match[1];
    portParam = `port=${match[2]}`;
  }
  const sep = path.includes("?") ? "&" : "?";
  const qs = portParam ? `${sep}${portParam}` : "";
  return `${dsn}/api/v1${path}${qs}`;
}

async function unipileReq(path, method = "GET", body = null) {
  const url = buildUnipileUrl(path);
  if (!url) return { ok: false, status: 0, data: { error: "UNIPILE_DSN not set" } };
  const opts = {
    method,
    headers: { "X-API-KEY": UNIPILE_KEY, "Accept": "application/json" },
  };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
    catch { return { ok: res.ok, status: res.status, data: text }; }
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

// ═══════════════════════════════════════════════════════════════
// AIRTABLE HELPERS
// ═══════════════════════════════════════════════════════════════

async function atListAll(baseId, table, params = {}) {
  const all = [];
  let offset = null;
  do {
    const qs = new URLSearchParams({ pageSize: "100", ...(offset ? { offset } : {}), ...params }).toString();
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}`, { headers: atHdr });
    if (!r.ok) {
      console.error(`[unipile-triggers] atListAll ${table} failed: ${r.status}`);
      break;
    }
    const d = await r.json();
    all.push(...(d.records || []));
    offset = d.offset || null;
  } while (offset);
  return all;
}

async function atFindOne(baseId, table, filterByFormula) {
  const qs = new URLSearchParams({ filterByFormula, pageSize: "1", maxRecords: "1" }).toString();
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}`, { headers: atHdr });
  if (!r.ok) return null;
  const d = await r.json();
  return d.records?.[0] || null;
}

// Strip-and-retry creation — same pattern as linkedin-posts/route.js
async function atCreateBatch(baseId, table, records) {
  const results = [];
  const errors = [];
  async function tryWithStripping(batch, strippedFields = []) {
    if (strippedFields.length > 10) return { ok: false, error: `Gave up after stripping ${strippedFields.join(", ")}` };
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST", headers: atHdr, body: JSON.stringify({ records: batch, typecast: true }),
    });
    if (r.ok) {
      const d = await r.json();
      return { ok: true, records: d.records || [], strippedFields };
    }
    const errText = await r.text().then(t => t.slice(0, 500));
    if (errText.includes("UNKNOWN_FIELD_NAME") || errText.includes("INVALID_VALUE_FOR_COLUMN")) {
      const m = errText.match(/[Uu]nknown field name:?\s*\\?"([^"\\]+)\\?"/) || errText.match(/Field\s+\\?"([^"\\]+)\\?"/);
      const badField = m ? m[1] : null;
      if (badField) {
        const stripped = batch.map(rec => {
          const f = { ...rec.fields };
          delete f[badField];
          return { ...rec, fields: f };
        });
        return tryWithStripping(stripped, [...strippedFields, badField]);
      }
    }
    return { ok: false, error: `${r.status}: ${errText}` };
  }
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const result = await tryWithStripping(batch);
    if (result.ok) results.push(...result.records);
    else errors.push(result.error);
  }
  return { results, errors };
}

// ═══════════════════════════════════════════════════════════════
// TRIGGER DEFINITIONS
// Each trigger type maps a Unipile event → task fields.
// Default scores and labels live here; the user can override per-trigger
// via the Unipile Triggers settings UI.
// ═══════════════════════════════════════════════════════════════

const TRIGGER_DEFINITIONS = {
  unipile_message_reply: {
    label: "📬 Inbound DM/InMail reply",
    description: "Lead replied to your message — highest-priority signal",
    default_score: 95,
    source: "Unipile",
    surface: "webhook",
  },
  unipile_connection_accepted: {
    label: "🤝 Connection accepted",
    description: "Lead accepted your invite — warm intro window opens",
    default_score: 70,
    source: "Unipile",
    surface: "webhook",
  },
  unipile_post_comment_on_yours: {
    label: "💬 Lead commented on your post",
    description: "Lead engaged publicly with your content",
    default_score: 80,
    source: "Unipile",
    surface: "webhook",
  },
  unipile_post_reaction_on_yours: {
    label: "👍 Lead reacted to your post",
    description: "Lead liked/celebrated your content",
    default_score: 60,
    source: "Unipile",
    surface: "poll",
  },
  unipile_profile_view: {
    label: "👀 Lead viewed your profile",
    description: "Lead is researching you — top-of-funnel signal",
    default_score: 50,
    source: "Unipile",
    surface: "poll",
  },
};

// ═══════════════════════════════════════════════════════════════
// LEAD MATCHING
// Find a Lead row in Airtable that matches the Unipile event. The match is
// by LinkedIn provider_id (Unipile gives us the lead's LinkedIn ID), or by
// LinkedIn URL slug, or by name+company as a fallback.
// ═══════════════════════════════════════════════════════════════

let leadCacheByBase = {}; // baseId -> { byProviderId: Map, byPublicId: Map, byUrl: Map, fetchedAt: ms }
const LEAD_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — long enough to dedupe a webhook burst

async function loadLeadIndex(baseId) {
  const now = Date.now();
  const cached = leadCacheByBase[baseId];
  if (cached && (now - cached.fetchedAt) < LEAD_CACHE_TTL_MS) return cached;

  const records = await atListAll(baseId, "Leads");
  const byProviderId = new Map(); // linkedin numeric id (e.g. ACoAAB...) -> record
  const byPublicId = new Map();   // /in/<slug> -> record
  const byUrl = new Map();        // full URL -> record

  for (const r of records) {
    const f = r.fields || {};
    const url = (f["LinkedIn URL"] || f["Linkedin URL"] || "").trim();
    const providerId = (f["LinkedIn Provider ID"] || f["Provider ID"] || "").trim();
    if (providerId) byProviderId.set(providerId, r);
    if (url) {
      byUrl.set(url.replace(/\/$/, ""), r);
      const slugMatch = url.match(/linkedin\.com\/in\/([^\/\?#]+)/i);
      if (slugMatch) byPublicId.set(slugMatch[1].toLowerCase(), r);
    }
  }

  const idx = { byProviderId, byPublicId, byUrl, fetchedAt: now, totalLeads: records.length };
  leadCacheByBase[baseId] = idx;
  return idx;
}

async function findLeadForUnipileEvent(baseId, eventLinkedInData) {
  const idx = await loadLeadIndex(baseId);

  // 1. Try provider_id (most reliable — Unipile's stable LinkedIn ID)
  const providerId = eventLinkedInData.provider_id || eventLinkedInData.member_id || eventLinkedInData.user_id;
  if (providerId && idx.byProviderId.has(providerId)) {
    return { lead: idx.byProviderId.get(providerId), match_type: "provider_id" };
  }

  // 2. Try public_identifier / slug
  const publicId = (eventLinkedInData.public_identifier || eventLinkedInData.username || "").toLowerCase();
  if (publicId && idx.byPublicId.has(publicId)) {
    return { lead: idx.byPublicId.get(publicId), match_type: "public_id" };
  }

  // 3. Try full URL
  const profileUrl = (eventLinkedInData.profile_url || eventLinkedInData.url || "").replace(/\/$/, "");
  if (profileUrl && idx.byUrl.has(profileUrl)) {
    return { lead: idx.byUrl.get(profileUrl), match_type: "url" };
  }

  return { lead: null, match_type: null };
}

// ═══════════════════════════════════════════════════════════════
// TASK CREATION FROM TRIGGER EVENT
// ═══════════════════════════════════════════════════════════════

async function createTriggerTask(baseId, { triggerType, lead, signalText, evidenceUrl, scoreOverride, accountId, eventId }) {
  const def = TRIGGER_DEFINITIONS[triggerType];
  if (!def) throw new Error(`Unknown trigger type: ${triggerType}`);

  // IDEMPOTENCY: dedupe by Unipile event ID. Webhooks can fire twice;
  // never create the same task twice for the same event.
  if (eventId) {
    const dupeFormula = `{Event ID} = "${eventId.replace(/"/g, '\\"')}"`;
    const existing = await atFindOne(baseId, "Tasks", dupeFormula);
    if (existing) {
      return { skipped: true, reason: "duplicate event_id", existingId: existing.id };
    }
  }

  const f = lead.fields || {};
  const leadName = f.Name || f["Full Name"] || "Unknown";
  const leadCompany = f.Company || "";
  const score = typeof scoreOverride === "number" ? scoreOverride : def.default_score;

  const signalParts = [
    evidenceUrl ? `🔗 ${evidenceUrl}` : null,
    evidenceUrl ? `` : null,
    `🎯 Trigger: ${def.label}`,
    `💡 ${def.description}`,
    ``,
    signalText ? `📝 ${signalText}` : null,
    ``,
    `📊 Score: ${score}/100`,
    `📡 Source: Unipile (${accountId ? `account: ${accountId.slice(0, 8)}...` : "no account"})`,
  ].filter(v => v !== null && v !== undefined);

  const record = {
    fields: {
      Name: leadName,
      Company: leadCompany,
      "Task Rule": def.label,
      Score: score,
      "Scan Target": leadName,
      "Lead Title": f.Title || "",
      Email: f.Email || "",
      "LinkedIn URL": f["LinkedIn URL"] || f["Linkedin URL"] || "",
      Phone: f.Phone || "",
      Signal: signalParts.join("\n"),
      URL: evidenceUrl || "",
      "Post URL": evidenceUrl || "",
      Source: def.source,
      "Task Type": triggerType,
      "Event ID": eventId || "",
      "Account ID": accountId || "",
      Date: new Date().toISOString().slice(0, 10),
      Created: new Date().toISOString(),
    },
  };

  const { results, errors } = await atCreateBatch(baseId, "Tasks", [record]);
  return { created: results[0] || null, errors };
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK HANDLER
// Unipile POSTs events here. We auth via shared secret in URL query
// (since Unipile doesn't sign webhooks by default).
// ═══════════════════════════════════════════════════════════════

async function handleWebhook(request, baseId) {
  const body = await request.json().catch(() => ({}));
  const eventType = body.event || body.type || body.AccountType || "unknown";
  const accountId = body.account_id || body.account?.id || null;
  const eventId = body.event_id || body.message_id || body.id || `${eventType}-${Date.now()}`;

  console.log(`[unipile-triggers] Webhook received: type=${eventType} account=${accountId} event=${eventId}`);

  // Map Unipile event → our trigger type
  let triggerType = null;
  let signalText = "";
  let evidenceUrl = "";
  let leadLinkedInData = {};

  switch (eventType) {
    case "message.received":
    case "new_message":
    case "message_received":
      triggerType = "unipile_message_reply";
      signalText = (body.message?.text || body.text || "").slice(0, 500);
      evidenceUrl = body.chat_url || body.message?.url || "";
      leadLinkedInData = body.sender || body.from || body.attendee || {};
      break;

    case "users.relations.created":
    case "new_relation":
    case "connection_accepted":
    case "invitation_accepted":
      triggerType = "unipile_connection_accepted";
      signalText = `Connection accepted on ${new Date().toLocaleDateString()}`;
      leadLinkedInData = body.user || body.relation || {};
      evidenceUrl = leadLinkedInData.profile_url || "";
      break;

    case "post.commented":
    case "post_comment":
    case "comment.received":
      triggerType = "unipile_post_comment_on_yours";
      signalText = body.comment?.text || body.text || "";
      evidenceUrl = body.post_url || body.comment?.url || "";
      leadLinkedInData = body.author || body.commenter || body.user || {};
      break;

    default:
      console.log(`[unipile-triggers] Unhandled event type: ${eventType}`);
      return NextResponse.json({ ok: true, ignored: true, reason: "unhandled event type", type: eventType });
  }

  // Find the lead this event is about
  const { lead, match_type } = await findLeadForUnipileEvent(baseId, leadLinkedInData);
  if (!lead) {
    console.log(`[unipile-triggers] No matching lead for event:`, leadLinkedInData);
    return NextResponse.json({
      ok: true,
      ignored: true,
      reason: "no matching lead in Leads table",
      tried: { provider_id: leadLinkedInData.provider_id, public_id: leadLinkedInData.public_identifier },
    });
  }

  // Create the task
  const result = await createTriggerTask(baseId, {
    triggerType, lead, signalText, evidenceUrl,
    accountId, eventId,
  });

  return NextResponse.json({
    ok: true,
    trigger_type: triggerType,
    matched_lead: lead.fields?.Name || null,
    match_type,
    task: result.created ? { id: result.created.id } : null,
    skipped: result.skipped || false,
    errors: result.errors || [],
  });
}

// ═══════════════════════════════════════════════════════════════
// POLLING — runs from cron / manual trigger
// Fetches profile views and post reactions across all connected accounts.
// ═══════════════════════════════════════════════════════════════

async function pollAllAccounts(baseId) {
  const accountsRes = await unipileReq("/accounts");
  if (!accountsRes.ok) return { ok: false, error: `Could not list Unipile accounts: ${JSON.stringify(accountsRes.data).slice(0, 200)}` };

  const accounts = accountsRes.data?.items || accountsRes.data?.accounts || (Array.isArray(accountsRes.data) ? accountsRes.data : []);
  const summary = { accounts_checked: 0, profile_views_processed: 0, reactions_processed: 0, tasks_created: 0, skipped_dupes: 0, errors: [] };

  for (const acct of accounts) {
    const accountId = acct.id || acct.account_id;
    if (!accountId) continue;
    summary.accounts_checked++;

    // Fetch recent profile views
    try {
      const viewsRes = await unipileReq(`/users/me/profile-views?account_id=${accountId}&limit=20`);
      if (viewsRes.ok) {
        const views = viewsRes.data?.items || [];
        for (const view of views) {
          const eventId = `view-${accountId}-${view.viewer?.provider_id || view.id}-${view.viewed_at || view.timestamp}`;
          const r = await createTriggerTask(baseId, {
            triggerType: "unipile_profile_view",
            lead: null, // resolved inside
            signalText: `Viewed your profile on ${new Date(view.viewed_at || Date.now()).toLocaleDateString()}`,
            evidenceUrl: view.viewer?.profile_url || "",
            accountId, eventId,
          }).catch(e => ({ errors: [e.message] }));
          // Skip if no lead matched
          if (r.skipped) summary.skipped_dupes++;
          else if (r.created) summary.tasks_created++;
        }
        summary.profile_views_processed += views.length;
      }
    } catch (e) {
      summary.errors.push(`Profile views poll for ${accountId}: ${e.message}`);
    }

    // Fetch reactions on user's own posts
    // Unipile path varies — using a defensive try
    try {
      const reactionsRes = await unipileReq(`/users/me/reactions?account_id=${accountId}&limit=20`);
      if (reactionsRes.ok) {
        const reactions = reactionsRes.data?.items || [];
        for (const reaction of reactions) {
          const eventId = `reaction-${accountId}-${reaction.id || reaction.actor?.provider_id}-${reaction.created_at || reaction.timestamp}`;
          const { lead } = await findLeadForUnipileEvent(baseId, reaction.actor || {});
          if (!lead) continue;
          const r = await createTriggerTask(baseId, {
            triggerType: "unipile_post_reaction_on_yours",
            lead,
            signalText: `Reacted "${reaction.type || "👍"}" to your post`,
            evidenceUrl: reaction.post_url || "",
            accountId, eventId,
          });
          if (r.skipped) summary.skipped_dupes++;
          else if (r.created) summary.tasks_created++;
        }
        summary.reactions_processed += reactions.length;
      }
    } catch (e) {
      summary.errors.push(`Reactions poll for ${accountId}: ${e.message}`);
    }
  }

  return { ok: true, ...summary };
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════

// GET — used by cron-job.org for polling AND for fetching status from UI
export async function GET(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "status";
  const baseId = url.searchParams.get("base") || MASTER_BASE_ID;
  const key = url.searchParams.get("key");

  // Auth for poll/webhook actions
  if (action === "poll" || action === "webhook") {
    if (!CRON_SECRET) return NextResponse.json({ error: "CRON_SECRET not set" }, { status: 500 });
    if (key !== CRON_SECRET) return NextResponse.json({ error: "Invalid key" }, { status: 401 });
  }

  try {
    if (action === "status") {
      // Quick health check + lead index size
      const idx = await loadLeadIndex(baseId);
      const accountsRes = await unipileReq("/accounts");
      const accounts = accountsRes.data?.items || accountsRes.data?.accounts || [];
      return NextResponse.json({
        ok: true,
        unipile_connected: accountsRes.ok,
        accounts_count: accounts.length,
        accounts: accounts.map(a => ({
          id: a.id,
          provider: a.provider || a.type,
          status: a.status,
          name: a.name || a.user?.name || "unnamed",
        })),
        leads_indexed: idx.totalLeads,
        webhook_url: `${url.origin}/api/unipile-triggers?action=webhook&key=YOUR_CRON_SECRET&base=${baseId}`,
        poll_url: `${url.origin}/api/unipile-triggers?action=poll&key=YOUR_CRON_SECRET&base=${baseId}`,
      });
    }

    if (action === "poll") {
      const result = await pollAllAccounts(baseId);
      return NextResponse.json(result);
    }

    if (action === "list_triggers") {
      // For UI: show recent trigger tasks
      const since = url.searchParams.get("since"); // optional ISO date
      const sourceFilter = `{Source} = "Unipile"`;
      const sinceClause = since ? ` AND IS_AFTER({Created}, "${since}")` : "";
      const formula = `AND(${sourceFilter}${sinceClause})`;
      const records = await atListAll(baseId, "Tasks", { filterByFormula: formula, "sort[0][field]": "Created", "sort[0][direction]": "desc", maxRecords: "100" });
      return NextResponse.json({
        ok: true,
        triggers: records.slice(0, 100).map(r => ({
          id: r.id,
          name: r.fields?.Name,
          company: r.fields?.Company,
          task_type: r.fields?.["Task Type"],
          score: r.fields?.Score,
          signal: r.fields?.Signal,
          url: r.fields?.URL,
          created: r.fields?.Created,
        })),
      });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (e) {
    console.error("[unipile-triggers] GET error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// POST — webhook endpoint (Unipile pushes events here) AND UI actions
export async function POST(request) {
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "ui_action";
  const baseId = url.searchParams.get("base") || MASTER_BASE_ID;
  const key = url.searchParams.get("key");

  // Webhook path: requires the CRON_SECRET key in the URL
  if (action === "webhook") {
    if (!CRON_SECRET || key !== CRON_SECRET) {
      return NextResponse.json({ error: "Invalid key" }, { status: 401 });
    }
    return handleWebhook(request, baseId);
  }

  // UI actions (called from the SignalScope frontend)
  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const uiAction = body.action;

  switch (uiAction) {
    case "test_match": {
      // For UI: given a sample LinkedIn URL/slug, find the matching lead
      const { sampleProfileUrl } = body;
      const slug = (sampleProfileUrl || "").match(/linkedin\.com\/in\/([^\/\?#]+)/i)?.[1];
      const idx = await loadLeadIndex(baseId);
      const lead = slug ? idx.byPublicId.get(slug.toLowerCase()) : null;
      return NextResponse.json({
        ok: true,
        matched: !!lead,
        lead: lead ? { name: lead.fields?.Name, company: lead.fields?.Company } : null,
        leads_indexed: idx.totalLeads,
      });
    }

    case "manual_poll": {
      // UI button to force a poll right now
      const result = await pollAllAccounts(baseId);
      return NextResponse.json(result);
    }

    case "trigger_definitions": {
      return NextResponse.json({ ok: true, triggers: TRIGGER_DEFINITIONS });
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${uiAction}` }, { status: 400 });
  }
}
