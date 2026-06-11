import { NextResponse } from "next/server";

// ═══════════════════════════════════════════════════════════════════
// SIDEKICK ACTION ENDPOINT
// POST /api/sidekick/action
//
// Auth: Authorization: Bearer <SIDEKICK_API_KEY>
//
// Body:
//   {
//     baseId: "appXYZ...",  // Airtable base for this campaign
//     taskId: "recABC...",  // The Task record ID to update
//     action: "done" | "skip" | "reopen",  // What the user chose
//     notes?: "Optional human note"
//   }
//
// done/skip: stamps the Task row so it disappears from the chatbot's
// feed. Does not delete the task — historical state stays in Airtable.
// reopen (2026-06-11, Samarth: "revisit tasks even if actioned once"):
// clears Handled At / Handled As / Handled Notes so the task returns to
// the pending feed. The chatbot's Handled panel + toast-Undo drive this.
//
// Returns: { ok: true, taskId, handledAt }
//
// Note: this endpoint only stamps the task as handled. It does NOT
// execute any downstream side-effects (e.g. send a calendar link,
// post a comment, make a call). Those will be added in a later phase
// once the action_type → side_effect map is wired.
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

export async function POST(request) {
  if (!authOk(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!AIRTABLE_KEY) {
    return NextResponse.json({ ok: false, error: "Server missing AIRTABLE_API_KEY env var" }, { status: 500 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const { baseId, taskId, action, notes } = body || {};
  if (!baseId) return NextResponse.json({ ok: false, error: "baseId required" }, { status: 400 });
  if (!taskId) return NextResponse.json({ ok: false, error: "taskId required" }, { status: 400 });
  if (!action || !["done", "skip", "reopen"].includes(action)) {
    return NextResponse.json({ ok: false, error: "action must be 'done', 'skip' or 'reopen'" }, { status: 400 });
  }

  const handledAt = new Date().toISOString();
  let fields;
  if (action === "reopen") {
    // Clear the handled stamps → task returns to the pending feed. Notes
    // are cleared too (they described the action being undone).
    fields = { "Handled At": null, "Handled As": null, "Handled Notes": null };
  } else {
    fields = {
      "Handled At": handledAt,
      "Handled As": action,
    };
    if (notes && typeof notes === "string") {
      fields["Handled Notes"] = notes.slice(0, 2000); // cap to keep payload sane
    }
  }

  try {
    // PATCH the task. Use typecast so Airtable accepts the singleSelect
    // value even if the option doesn't exist yet (it'll auto-create).
    const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}/${taskId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields, typecast: true }),
      cache: "no-store",
    });
    if (!r.ok) {
      const errText = await r.text();
      // If unknown field, the schema hasn't been bootstrapped yet
      if (r.status === 422 && errText.includes("UNKNOWN_FIELD_NAME")) {
        return NextResponse.json({ ok: false, error: "Handled At / Handled As / Handled Notes fields missing in Tasks table. Run POST /api/setup-fix to add them.", needsSetup: true }, { status: 412 });
      }
      if (r.status === 404) {
        return NextResponse.json({ ok: false, error: `Task ${taskId} not found in base ${baseId}` }, { status: 404 });
      }
      return NextResponse.json({ ok: false, error: `Airtable returned ${r.status}`, detail: errText.slice(0, 500) }, { status: 502 });
    }
    const data = await r.json();
    return NextResponse.json({
      ok: true,
      taskId: data.id,
      handledAt,
      action,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}
