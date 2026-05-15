import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK COUNT ENDPOINT
// GET /api/sidekick/count?baseId={airtable_base_id}
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Returns just the count of pending tasks — for the chatbot's task
// counter badge. Lighter than /feed since it doesn't format card
// payloads or fetch full record data.
// ═══════════════════════════════════════════════════════════════════

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 30;

const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const SIDEKICK_API_KEY = process.env.SIDEKICK_API_KEY;
const AT_API = "https://api.airtable.com/v0";

function authOk(request) {
  if (!SIDEKICK_API_KEY) return false;
  const h = request.headers.get("authorization") || "";
  return h === `Bearer ${SIDEKICK_API_KEY}`;
}

export async function GET(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY env var" }, { status: 500 });
  }

  const url = new URL(request.url);
  const baseId = url.searchParams.get("baseId");
  if (!baseId) {
    return NextResponse.json({ ok: false, error: "baseId query param required" }, { status: 400 });
  }

  // Fetch only the Name field (smallest possible payload) with the same
  // filter as /feed. Walk pages to get a true total. Most campaigns
  // won't have >100 pending tasks at any time, so this is fast.
  let total = 0;
  let offset = "";
  let pages = 0;
  try {
    while (pages < 10) { // safety cap; 10 pages × 100 = 1000 tasks
      const params = new URLSearchParams({
        filterByFormula: `{Handled At} = BLANK()`,
        "fields[]": "Name",
        pageSize: "100",
      });
      if (offset) params.set("offset", offset);

      const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_KEY}` },
        cache: "no-store",
      });
      if (!r.ok) {
        const errText = await r.text();
        if (r.status === 403 && errText.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND")) {
          return NextResponse.json({ ok: true, count: 0, note: "Tasks table not found" });
        }
        if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
          return NextResponse.json({ ok: false, error: "Handled At field missing. Run POST /api/setup-fix.", needsSetup: true }, { status: 412 });
        }
        return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}` }, { status: 502 });
      }
      const data = await r.json();
      total += (data.records || []).length;
      offset = data.offset || "";
      pages++;
      if (!offset) break;
    }
    return NextResponse.json({ ok: true, baseId, count: total });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
