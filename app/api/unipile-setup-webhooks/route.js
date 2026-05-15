// ─── Unipile Webhook Auto-Setup ────────────────────────────────────────
//
// Creates the SignalScope webhooks in Unipile via their API.
// One-shot admin endpoint — call once after deploying or whenever the
// webhook URL changes.
//
// WHY API instead of dashboard:
// Unipile's dashboard sometimes doesn't let you create multiple webhooks
// per source, or hides certain event types. Creating via API gives full
// control over which event names are subscribed.
//
// USAGE:
//   GET  /api/unipile-setup-webhooks?key=<CRON_SECRET>   — list current
//   POST /api/unipile-setup-webhooks?key=<CRON_SECRET>   — create missing
//   DELETE /api/unipile-setup-webhooks?key=<CRON_SECRET>&id=<webhook_id> — remove one
//
// All Unipile webhooks are workspace-level (no per-account scoping —
// that's intentional, since SignalScope routes by account_id internally
// via the Account Routing table in Airtable).

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UNIPILE_DSN = process.env.UNIPILE_DSN;
const UNIPILE_KEY = process.env.UNIPILE_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET || "signalscope_7765007";

// ─── Build Unipile API URL with optional port parameter ────────────
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
  if (!UNIPILE_KEY) return { ok: false, status: 0, data: { error: "UNIPILE_API_KEY not set" } };
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

// ─── Construct the SignalScope webhook receiver URL ────────────────
function getReceiverUrl(req) {
  // Build the absolute URL of /api/unipile-triggers on the current deployment.
  // We avoid hardcoding so this works across multiple Vercel deployments.
  const reqUrl = new URL(req.url);
  return `${reqUrl.protocol}//${reqUrl.host}/api/unipile-triggers?action=webhook&key=${encodeURIComponent(CRON_SECRET)}`;
}

// ─── The 3 webhooks SignalScope wants ──────────────────────────────
function getDesiredWebhooks(receiverUrl) {
  return [
    {
      label: "SignalScope-Messaging",
      source: "messaging",
      events: ["message_received", "message_reaction"],
      request_url: receiverUrl,
      name: "SignalScope-Messaging",
      headers: [{ key: "Content-Type", value: "application/json" }],
    },
    {
      label: "SignalScope-Users",
      source: "users",
      events: ["new_relation"],
      request_url: receiverUrl,
      name: "SignalScope-Users",
      headers: [{ key: "Content-Type", value: "application/json" }],
    },
    {
      label: "SignalScope-AccountStatus",
      source: "account_status",
      // No explicit events array — Unipile sends all account_status events by default
      request_url: receiverUrl,
      name: "SignalScope-AccountStatus",
      headers: [{ key: "Content-Type", value: "application/json" }],
    },
  ];
}

// ─── Auth gate ─────────────────────────────────────────────────────
function authorize(req) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key !== CRON_SECRET) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

// ─── GET: list current webhooks ────────────────────────────────────
export async function GET(req) {
  const denied = authorize(req);
  if (denied) return denied;

  const list = await unipileReq("/webhooks", "GET");
  if (!list.ok) {
    return NextResponse.json({
      ok: false,
      error: "Failed to fetch existing Unipile webhooks",
      status: list.status,
      details: list.data,
    }, { status: 500 });
  }

  const items = Array.isArray(list.data) ? list.data : (list.data?.items || []);
  const receiverUrl = getReceiverUrl(req);

  return NextResponse.json({
    ok: true,
    receiverUrl,
    existingWebhooks: items.map(w => ({
      id: w.id,
      name: w.name,
      source: w.source,
      request_url: w.request_url,
      events: w.events,
      isOurs: (w.request_url || "").includes("/api/unipile-triggers"),
    })),
  });
}

// ─── POST: create missing webhooks ─────────────────────────────────
export async function POST(req) {
  const denied = authorize(req);
  if (denied) return denied;

  const receiverUrl = getReceiverUrl(req);
  const desired = getDesiredWebhooks(receiverUrl);

  // List existing first to avoid duplicates
  const listRes = await unipileReq("/webhooks", "GET");
  if (!listRes.ok) {
    return NextResponse.json({
      ok: false,
      error: "Failed to fetch existing webhooks before creating",
      details: listRes.data,
    }, { status: 500 });
  }
  const existingArr = Array.isArray(listRes.data) ? listRes.data : (listRes.data?.items || []);
  const existingByKey = new Map();
  for (const w of existingArr) {
    // Match key: same source + same request_url → considered duplicate
    if (w.source && w.request_url) {
      existingByKey.set(`${w.source}::${w.request_url}`, w);
    }
  }

  const results = [];
  for (const d of desired) {
    const key = `${d.source}::${d.request_url}`;
    const existing = existingByKey.get(key);
    if (existing) {
      results.push({
        label: d.label,
        source: d.source,
        status: "exists",
        webhookId: existing.id,
        message: `Already configured (id: ${existing.id})`,
      });
      continue;
    }
    // Create it
    const body = {
      source: d.source,
      request_url: d.request_url,
      name: d.name,
      headers: d.headers,
    };
    if (d.events && d.events.length > 0) body.events = d.events;

    const createRes = await unipileReq("/webhooks", "POST", body);
    if (!createRes.ok) {
      results.push({
        label: d.label,
        source: d.source,
        status: "failed",
        httpStatus: createRes.status,
        message: typeof createRes.data === "string" ? createRes.data.slice(0, 300) : JSON.stringify(createRes.data).slice(0, 300),
      });
    } else {
      results.push({
        label: d.label,
        source: d.source,
        status: "created",
        webhookId: createRes.data?.id || createRes.data?.webhook_id || null,
        message: "✅ Webhook created successfully",
        response: createRes.data,
      });
    }
  }

  const created = results.filter(r => r.status === "created").length;
  const existed = results.filter(r => r.status === "exists").length;
  const failed = results.filter(r => r.status === "failed").length;

  return NextResponse.json({
    ok: failed === 0,
    summary: `${created} created, ${existed} already existed, ${failed} failed`,
    receiverUrl,
    results,
  });
}

// ─── DELETE: remove a specific webhook by id ───────────────────────
export async function DELETE(req) {
  const denied = authorize(req);
  if (denied) return denied;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id query param required" }, { status: 400 });

  const res = await unipileReq(`/webhooks/${encodeURIComponent(id)}`, "DELETE");
  return NextResponse.json({
    ok: res.ok,
    status: res.status,
    data: res.data,
  });
}
