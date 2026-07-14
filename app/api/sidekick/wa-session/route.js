import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK WHATSAPP SESSION STORE
// POST /api/sidekick/wa-session
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// WhatsApp is a stateful conversation on a stateless serverless function:
// between two inbound messages we must remember which task of the batch
// the operator is on, the current draft, the chosen hook, etc. sidekick-chat
// owns no data (CLAUDE.md §1), so the session blob lives here, in the
// campaign base, like everything else.
//
// One row per phone number. State is an opaque JSON blob written by
// sidekick-chat's WhatsApp flow — this endpoint never interprets it.
//
// Body:
//   { baseId, phone, action: "get" }                 → { ok, state, recordId }
//   { baseId, phone, action: "set", state: {...} }   → { ok, recordId }
//   { baseId, phone, action: "clear" }               → { ok, recordId }
//
// The `WhatsApp Sessions` table is auto-created on first use (same spirit as
// /api/setup-fix — a missing table must not take the webhook down).
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";
const TABLE = "WhatsApp Sessions";

// Airtable long-text ceiling is ~100k; a session blob that big means a bug
// upstream (unbounded draft/history growth), so refuse rather than persist it.
const STATE_CAP = 60000;

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false; // fail closed if env not set
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

// Airtable formula string escaping — a phone is digits-only in practice, but
// never interpolate unescaped user input into a filterByFormula.
function esc(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function missingTable(status, text) {
  return status === 403 && String(text).includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND");
}

async function createTable(baseId) {
  const r = await fetch(`${AT_API}/meta/bases/${baseId}/tables`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: TABLE,
      description: "One row per WhatsApp number — conversation state for the Side Kick WhatsApp channel.",
      fields: [
        { name: "Phone", type: "singleLineText" },
        { name: "State", type: "multilineText" },
        { name: "Updated", type: "singleLineText" },
      ],
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    // Concurrent webhooks can race to create it — a duplicate-name error means
    // the other one won, which is the outcome we wanted anyway.
    if (t.includes("DUPLICATE_OR_EMPTY_FIELD_NAME") || t.includes("TABLE_NAME_ALREADY_EXISTS")) return true;
    throw new Error(`Could not create ${TABLE} table: ${r.status} ${t.slice(0, 200)}`);
  }
  return true;
}

async function findRow(baseId, phone) {
  const params = new URLSearchParams({
    filterByFormula: `{Phone} = '${esc(phone)}'`,
    maxRecords: "1",
  });
  let r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(TABLE)}?${params}`, {
    headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text();
    if (missingTable(r.status, t)) {
      await createTable(baseId);
      return null; // freshly created table has no rows
    }
    throw new Error(`Airtable ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return (data.records || [])[0] || null;
}

async function writeRow(baseId, existingId, fields) {
  const url = existingId
    ? `${AT_API}/${baseId}/${encodeURIComponent(TABLE)}/${existingId}`
    : `${AT_API}/${baseId}/${encodeURIComponent(TABLE)}`;
  const r = await fetch(url, {
    method: existingId ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ fields, typecast: true }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Airtable ${r.status}: ${t.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.id;
}

export async function POST(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY" }, { status: 500 });
  }

  let body;
  try { body = await request.json(); }
  catch { return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 }); }

  const { baseId, phone, action, state } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  if (!phone) return NextResponse.json({ ok: false, error: "phone required" }, { status: 400 });
  if (!["get", "set", "clear"].includes(action)) {
    return NextResponse.json({ ok: false, error: "action must be 'get', 'set' or 'clear'" }, { status: 400 });
  }

  try {
    const row = await findRow(baseId, phone);

    if (action === "get") {
      let parsed = {};
      const raw = row?.fields?.State;
      if (raw) { try { parsed = JSON.parse(raw); } catch { parsed = {}; } }
      return NextResponse.json({ ok: true, state: parsed, recordId: row?.id || null });
    }

    const next = action === "clear" ? {} : (state && typeof state === "object" ? state : {});
    const serialized = JSON.stringify(next);
    if (serialized.length > STATE_CAP) {
      return NextResponse.json({ ok: false, error: `State too large (${serialized.length} > ${STATE_CAP})` }, { status: 413 });
    }

    const id = await writeRow(baseId, row?.id, {
      Phone: String(phone),
      State: serialized,
      Updated: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true, recordId: id });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
