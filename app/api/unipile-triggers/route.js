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
      // 403 INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND usually means the table
      // doesn't exist yet — treat as empty silently. Only log truly unexpected
      // errors (auth issues, 500s).
      const errTxt = await r.text().catch(() => "");
      const isMissingTable = r.status === 403 && /INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/i.test(errTxt);
      if (!isMissingTable) {
        console.error(`[unipile-triggers] atListAll ${table} failed: ${r.status} — ${errTxt.slice(0, 200)}`);
      }
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
  unipile_message_reaction: {
    label: "😊 Lead reacted to your DM",
    description: "Lead reacted with emoji to your message — engagement signal",
    default_score: 60,
    source: "Unipile",
    surface: "webhook",
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
// ACCOUNT ROUTING
// Map a Unipile LinkedIn account_id → Airtable base ID. Lets one webhook
// URL serve all clients — events route based on which connected LinkedIn
// account fired them, not based on URL parameters.
//
// Routing config lives in the master base in an "Account Routing" table:
//   - Account ID (text, primary): Unipile's LinkedIn account_id
//   - Account Name (text): user name as shown in Unipile
//   - Provider (text): "linkedin", "email", etc.
//   - Campaign Base ID (text): target Airtable base
//   - Client Name (text): for UI display
//   - Active (checkbox): can disable without deleting
//   - Last Event At (datetime)
//   - Notes (long text)
//
// Unrouted events (account_id not in routing table) get logged to "Unrouted Triggers"
// so we can see what fell through and add the routing later.
// ═══════════════════════════════════════════════════════════════

let routingCache = null; // { byAccountId: Map, fetchedAt: ms }
const ROUTING_CACHE_TTL_MS = 2 * 60 * 1000; // 2 min — rebuild often enough that new mappings take effect quickly

async function loadRoutingTable() {
  const now = Date.now();
  if (routingCache && (now - routingCache.fetchedAt) < ROUTING_CACHE_TTL_MS) return routingCache;
  if (!MASTER_BASE_ID) {
    routingCache = { byAccountId: new Map(), fetchedAt: now };
    return routingCache;
  }
  try {
    const records = await atListAll(MASTER_BASE_ID, "Account Routing");
    const byAccountId = new Map();
    for (const r of records) {
      const f = r.fields || {};
      const acctId = (f["Account ID"] || "").trim();
      const baseId = (f["Campaign Base ID"] || "").trim();
      // Active checkbox: Airtable returns `true` when checked, omits the field when unchecked.
      // Treat ONLY explicit `true` as active. Anything else (undefined, false) is inactive.
      // This means newly-created rows must have Active explicitly set to true (which set_routing does).
      const active = f["Active"] === true;
      if (acctId && baseId && active) {
        byAccountId.set(acctId, {
          baseId,
          accountName: f["Account Name"] || "",
          clientName: f["Client Name"] || "",
          recordId: r.id,
        });
      }
    }
    routingCache = { byAccountId, fetchedAt: now };
    console.log(`[routing] Loaded ${byAccountId.size} active routing entries`);
    return routingCache;
  } catch (e) {
    console.warn(`[routing] Could not load Account Routing table (${e.message}). Defaulting to no routing.`);
    routingCache = { byAccountId: new Map(), fetchedAt: now };
    return routingCache;
  }
}

async function lookupBaseForAccount(accountId) {
  if (!accountId) return null;
  const cache = await loadRoutingTable();
  const entry = cache.byAccountId.get(accountId);
  return entry || null;
}

// When a routing miss happens, log the event to "Unrouted Triggers" table in master.
// Auto-creates fields if missing. Lets user see what events fell through and
// configure routing for them.
async function logUnroutedEvent({ accountId, eventType, eventId, signalText, evidenceUrl, leadLinkedInData, payload }) {
  if (!MASTER_BASE_ID) return;
  try {
    // Dedupe by event ID — Unipile may redeliver the same event
    if (eventId) {
      const dupeFormula = `{Event ID} = "${eventId.replace(/"/g, '\\"')}"`;
      const existing = await atFindOne(MASTER_BASE_ID, "Unrouted Triggers", dupeFormula);
      if (existing) return { skipped: true };
    }
    const record = {
      fields: {
        Name: `${eventType} from ${accountId?.slice(0, 12) || "unknown"}`,
        "Account ID": accountId || "",
        "Event Type": eventType || "",
        "Event ID": eventId || "",
        "Lead Name": leadLinkedInData?.public_identifier || leadLinkedInData?.name || "",
        "Lead Profile URL": leadLinkedInData?.profile_url || evidenceUrl || "",
        "Signal Text": (signalText || "").slice(0, 500),
        "Raw Payload": JSON.stringify(payload || {}).slice(0, 5000),
        Received: new Date().toISOString(),
      },
    };
    await atCreateBatch(MASTER_BASE_ID, "Unrouted Triggers", [record]);
  } catch (e) {
    // Don't let logging failures break webhook handling
    console.warn(`[routing] Failed to log unrouted event: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK HANDLER
// Unipile POSTs events here. We auth via shared secret in URL query
// (since Unipile doesn't sign webhooks by default).
// ═══════════════════════════════════════════════════════════════

async function handleWebhook(request, fallbackBaseId) {
  const body = await request.json().catch(() => ({}));
  const eventType = body.event || body.type || body.AccountType || "unknown";
  const accountId = body.account_id || body.account?.id || null;
  const eventId = body.event_id || body.message_id || body.id || `${eventType}-${Date.now()}`;

  // Verbose payload logging — invaluable for debugging field extraction issues.
  // Logs first 1500 chars of raw payload so we can see what Unipile actually sent.
  console.log(`[unipile-triggers] Webhook received: type=${eventType} account=${accountId} event=${eventId}`);
  try {
    console.log(`[unipile-triggers] Raw payload: ${JSON.stringify(body).slice(0, 1500)}`);
  } catch {}

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
      signalText = (body.message?.text || body.text || body.message || "").toString().slice(0, 500);
      evidenceUrl = body.chat_url || body.message?.url || "";
      // Unipile message payload has `sender` object with attendee_provider_id.
      // Normalize: surface the provider_id under canonical name so findLead matches.
      // Real shape: { sender: { attendee_id, attendee_provider_id, ... } }
      leadLinkedInData = {
        provider_id: body.sender?.attendee_provider_id || body.sender?.provider_id || body.from?.provider_id || null,
        public_identifier: body.sender?.attendee_public_identifier || body.sender?.public_identifier || null,
        profile_url: body.sender?.attendee_profile_url || body.sender?.profile_url || null,
        full_name: body.sender?.attendee_name || body.sender?.name || null,
      };
      break;

    case "users.relations.created":
    case "new_relation":
    case "connection_accepted":
    case "invitation_accepted":
      triggerType = "unipile_connection_accepted";
      // Unipile new_relation payload is FLAT — fields are at top level with `user_` prefix.
      // Real shape per docs: { user_provider_id, user_public_identifier, user_profile_url, user_full_name }
      // (NOT nested under body.user or body.relation as I previously assumed)
      leadLinkedInData = {
        provider_id: body.user_provider_id || body.user?.provider_id || null,
        public_identifier: body.user_public_identifier || body.user?.public_identifier || null,
        profile_url: body.user_profile_url || body.user?.profile_url || null,
        full_name: body.user_full_name || body.user?.full_name || null,
      };
      signalText = `Connection accepted${leadLinkedInData.full_name ? ` (${leadLinkedInData.full_name})` : ""} on ${new Date().toLocaleDateString()}`;
      evidenceUrl = leadLinkedInData.profile_url || "";
      break;

    case "message_reaction":
      // Reaction on a DM — score 60. The reactor data is in body.sender like message_received.
      triggerType = "unipile_message_reaction";
      signalText = `Reacted to your DM with ${body.reaction || body.message?.reaction || ""}`;
      leadLinkedInData = {
        provider_id: body.sender?.attendee_provider_id || body.sender?.provider_id || null,
        public_identifier: body.sender?.attendee_public_identifier || null,
        profile_url: body.sender?.attendee_profile_url || null,
        full_name: body.sender?.attendee_name || null,
      };
      break;

    case "post.commented":
    case "post_comment":
    case "comment.received":
      triggerType = "unipile_post_comment_on_yours";
      signalText = body.comment?.text || body.text || "";
      evidenceUrl = body.post_url || body.comment?.url || "";
      leadLinkedInData = body.author || body.commenter || body.user || {};
      break;

    case "account_status":
    case "credentials_expired":
    case "account_disconnected":
    case "creation_success":
    case "creation_fail":
      // Ops event — log it but don't try to create a lead task. Will route to
      // Slack notification in a future build. For now, just acknowledge.
      console.log(`[unipile-triggers] Account status event: ${eventType} for account ${accountId}. Body: ${JSON.stringify(body).slice(0, 300)}`);
      return NextResponse.json({ ok: true, ignored: true, reason: "account_status events not yet wired to Slack notifications", type: eventType, accountId });

    default:
      console.log(`[unipile-triggers] Unhandled event type: ${eventType}. Payload sample: ${JSON.stringify(body).slice(0, 300)}`);
      return NextResponse.json({ ok: true, ignored: true, reason: "unhandled event type", type: eventType });
  }

  console.log(`[unipile-triggers] Extracted lead data: ${JSON.stringify(leadLinkedInData)}`);

  // ─── Account-based routing ───
  // Look up which campaign base this account_id belongs to. If not mapped,
  // log to Unrouted Triggers so the user can see and configure later.
  // Falls back to fallbackBaseId from URL ONLY if the URL provided one (legacy support).
  let routingEntry = null;
  let baseId = null;
  if (accountId) {
    routingEntry = await lookupBaseForAccount(accountId);
    if (routingEntry) {
      baseId = routingEntry.baseId;
    }
  }

  if (!baseId) {
    if (fallbackBaseId) {
      // Legacy webhook URL with explicit ?base= param. Use it but log the fact.
      baseId = fallbackBaseId;
      console.log(`[routing] No routing entry for account ${accountId}, using fallback base from URL: ${fallbackBaseId}`);
    } else {
      // No routing. Log to Unrouted Triggers and bail.
      await logUnroutedEvent({ accountId, eventType, eventId, signalText, evidenceUrl, leadLinkedInData, payload: body });
      return NextResponse.json({
        ok: true,
        ignored: true,
        reason: "no routing entry for this account_id",
        accountId,
        hint: "Add this account to the Account Routing table in master base, OR set up the routing via the Triggers tab in SignalScope",
      });
    }
  }

  // Find the lead this event is about (in the routed base)
  const { lead, match_type } = await findLeadForUnipileEvent(baseId, leadLinkedInData);
  if (!lead) {
    console.log(`[unipile-triggers] No matching lead in base ${baseId} for event:`, leadLinkedInData);
    return NextResponse.json({
      ok: true,
      ignored: true,
      reason: "no matching lead in Leads table",
      base: baseId,
      tried: { provider_id: leadLinkedInData.provider_id, public_id: leadLinkedInData.public_identifier },
    });
  }

  // Create the task in the routed base
  const result = await createTriggerTask(baseId, {
    triggerType, lead, signalText, evidenceUrl,
    accountId, eventId,
  });

  // ─── REAL-TIME OUTREACH STATUS SYNC ─────────────────────────
  // When a high-signal event (reply or connection accepted) lands, also
  // update the Outreach record IMMEDIATELY. Otherwise we wait up to 4
  // hours for the next outreach cron run to notice — meaning another DM
  // step could fire in the meantime. This closes that window.
  //
  // Strict guardrails:
  //   - Only updates Outreach records that match the lead's LinkedIn URL
  //   - For connection_accepted: only flips to "connected" if currently in
  //     "queued"/"connection_sent" — won't overwrite "dm_2" or "completed"
  //   - For message_reply: always flips to "replied" (this is the strongest
  //     signal — even if we're mid-sequence, lead replied → stop everything)
  //   - Failure is non-fatal (logged but doesn't fail the webhook response)
  const leadUrl = (lead.fields?.["LinkedIn URL"] || "").trim();
  if (leadUrl && (triggerType === "unipile_message_reply" || triggerType === "unipile_connection_accepted")) {
    try {
      const escUrl = leadUrl.toLowerCase().replace(/"/g, '\\"');
      const outreach = await atFindOne(baseId, "Outreach", `LOWER({LinkedIn URL}) = "${escUrl}"`);
      if (outreach) {
        const currentStatus = outreach.fields?.Status || "queued";
        const fields = {};
        if (triggerType === "unipile_message_reply") {
          // Reply is the strongest stop signal — override any in-flight state
          if (currentStatus !== "replied" && currentStatus !== "completed") {
            fields.Status = "replied";
            fields.Notes = "Lead replied (webhook real-time) — DM sequence stopped";
          }
        } else if (triggerType === "unipile_connection_accepted") {
          // Only advance forward; never regress from dm_N back to connected
          if (currentStatus === "queued" || currentStatus === "connection_sent") {
            fields.Status = "connected";
            fields["Connection Accepted At"] = new Date().toISOString();
            // Schedule first DM for tomorrow if rule has days_after_accept; the
            // outreach cron will fire the first DM on its next run after that date
            const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
            fields["Next Action Date"] = tomorrow.toISOString().slice(0, 10);
          }
        }
        if (Object.keys(fields).length > 0) {
          const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}/${outreach.id}`, {
            method: "PATCH", headers: atHdr,
            body: JSON.stringify({ fields, typecast: true }),
          });
          if (r.ok) {
            console.log(`[unipile-triggers] Outreach ${outreach.id} updated: ${currentStatus} → ${fields.Status || "(unchanged)"}`);
          } else {
            const errTxt = await r.text();
            console.warn(`[unipile-triggers] Outreach sync PATCH failed (non-fatal): ${errTxt.slice(0, 200)}`);
          }
        } else {
          console.log(`[unipile-triggers] Outreach ${outreach.id} found but no status change needed (current: ${currentStatus})`);
        }
      } else {
        console.log(`[unipile-triggers] No Outreach record found for lead URL ${leadUrl} — lead matched in Leads table but not in an active outreach sequence`);
      }
    } catch (e) {
      console.warn(`[unipile-triggers] Outreach sync failed (non-fatal): ${e.message}`);
    }
  }

  return NextResponse.json({
    ok: true,
    trigger_type: triggerType,
    matched_lead: lead.fields?.Name || null,
    match_type,
    routed_to_base: baseId,
    routed_via: routingEntry ? "account_routing_table" : "fallback_url_param",
    client_name: routingEntry?.clientName || null,
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
        webhook_url: `${url.origin}/api/unipile-triggers?action=webhook&key=YOUR_CRON_SECRET`,
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
          account_id: r.fields?.["Account ID"] || null,
          event_id: r.fields?.["Event ID"] || null,
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
    // For the webhook, only use ?base= param if EXPLICITLY provided in URL.
    // Otherwise pass null and let account-based routing decide.
    // Master base would be wrong as a fallback — events would land in the campaigns
    // registry table instead of a real client base.
    const explicitBase = url.searchParams.get("base") || null;
    return handleWebhook(request, explicitBase);
  }

  // UI actions (called from the SignalScope frontend)
  let body;
  try { body = await request.json(); }
  catch { body = {}; } // some UI actions may not send a body

  // Action can come from URL (frontend pattern: ?action=X) OR from body (legacy)
  const uiAction = body.action || (action !== "ui_action" ? action : null);

  // SECURITY: Block ALL UI actions on this route from /client/[id] pages.
  // Every action here either reads master-base routing data or modifies it.
  // Clients should never touch this. Webhook path above is unaffected (it's gated by CRON_SECRET).
  const referer = request.headers.get("referer") || "";
  if (/\/client\/[^/?#]+/.test(referer)) {
    console.warn(`[SECURITY] unipile-triggers action "${uiAction}" blocked from client-mode referer: ${referer}`);
    return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
  }

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

    // ─── Routing UI actions ───
    case "list_routing": {
      // Return all routing entries from master base + the connected Unipile accounts,
      // joined so UI can show "Account X → Campaign Y" with a dropdown to change Y.
      try {
        const [accountsRes, routingRecords, campaignsRes] = await Promise.all([
          unipileReq("/accounts"),
          MASTER_BASE_ID ? atListAll(MASTER_BASE_ID, "Account Routing").catch(() => []) : [],
          MASTER_BASE_ID ? atListAll(MASTER_BASE_ID, "Campaigns").catch(() => []) : [],
        ]);
        // Surface Unipile connection errors so the UI knows why no accounts show up
        if (!accountsRes.ok) {
          return NextResponse.json({
            ok: false,
            error: `Could not connect to Unipile: ${typeof accountsRes.data === "string" ? accountsRes.data.slice(0, 200) : (accountsRes.data?.error || JSON.stringify(accountsRes.data).slice(0, 200))}`,
            unipile_status: accountsRes.status,
          });
        }
        const accounts = accountsRes.data?.items || accountsRes.data?.accounts || (Array.isArray(accountsRes.data) ? accountsRes.data : []);
        const routingByAcct = new Map();
        for (const r of routingRecords) {
          const f = r.fields || {};
          if (f["Account ID"]) routingByAcct.set(f["Account ID"], { recordId: r.id, ...f });
        }
        const campaigns = (campaignsRes || []).map(c => ({
          id: c.id,
          name: c.fields?.Name || "Unnamed",
          baseId: c.fields?.["Base ID"] || c.fields?.["Airtable Base ID"] || "",
        })).filter(c => c.baseId);
        const accountList = accounts.map(a => {
          const acctId = a.id || a.account_id;
          const routing = routingByAcct.get(acctId);
          return {
            account_id: acctId,
            name: a.name || a.user?.name || "unnamed",
            provider: a.provider || a.type || "unknown",
            status: a.status,
            routed_to_base_id: routing?.["Campaign Base ID"] || null,
            routed_to_client: routing?.["Client Name"] || null,
            routing_record_id: routing?.recordId || null,
            active: routing ? routing["Active"] === true : false,
          };
        });
        return NextResponse.json({ ok: true, accounts: accountList, campaigns, total_routed: routingByAcct.size });
      } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    case "set_routing": {
      // body: { account_id, account_name, campaign_base_id, client_name }
      const { account_id, account_name, campaign_base_id, client_name } = body;
      if (!account_id || !campaign_base_id) return NextResponse.json({ error: "account_id and campaign_base_id required" }, { status: 400 });
      if (!MASTER_BASE_ID) return NextResponse.json({ error: "Master base not configured" }, { status: 500 });
      try {
        // Upsert: check if row exists for this account_id
        const existing = await atFindOne(MASTER_BASE_ID, "Account Routing", `{Account ID} = "${account_id.replace(/"/g, '\\"')}"`);
        const fields = {
          Name: `${client_name || account_name || account_id} routing`,
          "Account ID": account_id,
          "Account Name": account_name || "",
          "Campaign Base ID": campaign_base_id,
          "Client Name": client_name || "",
          Active: true,
        };
        if (existing) {
          // Update — using direct PATCH since atUpdateBatch isn't in this file
          const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Account Routing")}/${existing.id}`, {
            method: "PATCH", headers: atHdr,
            body: JSON.stringify({ fields, typecast: true }),
          });
          if (!r.ok) {
            const errText = await r.text();
            return NextResponse.json({ error: `Update failed: ${errText.slice(0, 200)}` }, { status: 500 });
          }
          routingCache = null; // invalidate
          return NextResponse.json({ ok: true, action: "updated", record_id: existing.id });
        } else {
          const result = await atCreateBatch(MASTER_BASE_ID, "Account Routing", [{ fields }]);
          if (result.errors.length > 0) return NextResponse.json({ error: result.errors[0] }, { status: 500 });
          routingCache = null; // invalidate
          return NextResponse.json({ ok: true, action: "created", record_id: result.results[0]?.id });
        }
      } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    case "delete_routing": {
      const { record_id } = body;
      if (!record_id) return NextResponse.json({ error: "record_id required" }, { status: 400 });
      if (!MASTER_BASE_ID) return NextResponse.json({ error: "Master base not configured" }, { status: 500 });
      try {
        const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Account Routing")}/${record_id}`, {
          method: "DELETE", headers: atHdr,
        });
        if (!r.ok) return NextResponse.json({ error: `Delete failed: ${r.status}` }, { status: 500 });
        routingCache = null;
        return NextResponse.json({ ok: true });
      } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    case "list_unrouted": {
      // For UI: show events that fell through (no account routing entry).
      // Lets user see what they need to add to the routing table.
      if (!MASTER_BASE_ID) return NextResponse.json({ ok: true, unrouted: [] });
      try {
        const records = await atListAll(MASTER_BASE_ID, "Unrouted Triggers", {
          "sort[0][field]": "Received", "sort[0][direction]": "desc", maxRecords: "100",
        }).catch(() => []);
        return NextResponse.json({
          ok: true,
          unrouted: records.slice(0, 100).map(r => ({
            id: r.id,
            account_id: r.fields?.["Account ID"],
            event_type: r.fields?.["Event Type"],
            lead_name: r.fields?.["Lead Name"],
            signal_text: r.fields?.["Signal Text"],
            received: r.fields?.Received,
          })),
          // Group by account_id so user sees how many events per unmapped account
          by_account: (() => {
            const m = {};
            for (const r of records) {
              const a = r.fields?.["Account ID"] || "unknown";
              m[a] = (m[a] || 0) + 1;
            }
            return Object.entries(m).map(([account_id, count]) => ({ account_id, count })).sort((a, b) => b.count - a.count);
          })(),
        });
      } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    case "ensure_routing_tables": {
      // Trigger the airtable route's schema setup on the master base — creates
      // Account Routing and Unrouted Triggers tables if they don't exist.
      if (!MASTER_BASE_ID) return NextResponse.json({ error: "Master base not configured" }, { status: 500 });
      try {
        const r = await fetch(`${url.origin}/api/airtable`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "setup", baseId: MASTER_BASE_ID }),
        });
        const result = await r.json();
        return NextResponse.json({ ok: r.ok, ...result });
      } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 500 });
      }
    }

    default:
      return NextResponse.json({ error: `Unknown action: ${uiAction}` }, { status: 400 });
  }
}
