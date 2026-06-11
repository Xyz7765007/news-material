import { NextResponse } from "next/server";

// ─── Reviewer feedback — demote + teach the scorer ─────────────────
// Signal Review's promote button had no opposite: a wrongly-qualified task
// could only be deleted, and the AI never learned why it was wrong. This
// endpoint closes the loop (Samarth, 2026-06-11):
//
//   1. DEMOTE — move a qualified Task → Signal Archive (Signal Status
//      "demoted", feedback stored on the row) so nothing is thrown away,
//      mirroring the retention philosophy of the 2026-06-04 archive build.
//   2. REMEMBER — append a dated feedback line to the matching Task Rule's
//      "Reviewer Feedback" field (news / job_post / company_post), or to the
//      master Campaigns row's "LinkedIn Posts Feedback" field for
//      linkedin_engagement (which has no Task Rule). Every scoring path
//      injects that memory into its prompt, so the same mistake isn't
//      repeated on the next scan. Promote feedback ("this should have
//      qualified") is recorded the same way via action "promote_feedback".
//
// Isolated endpoint on purpose (same reasoning as /api/role-check): the scan
// routes are high blast radius; this runs only when an operator clicks.
//
// POST body:
//   {
//     action: "demote" | "promote_feedback",
//     baseId,                  // campaign base (Tasks / Signal Archive / Task Rules)
//     campaignAirtableId,      // master Campaigns row — linkedin_engagement memory
//     feedback,                // the human's correction, free text (required)
//     task: { id, company, rule, type, score, reason, signal, source, url,
//             scanTarget, leadTitle, name, linkedinUrl, date }
//   }
// Returns { ok, archived?: [rec], feedbackSaved, feedbackError? }

export const maxDuration = 60;
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const AT_API = "https://api.airtable.com/v0";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

// Keep the memory bounded so it never bloats the scoring prompt: newest
// entries win, hard cap on characters (≈1k tokens — cheap vs. a wrong task).
const FEEDBACK_MAX_CHARS = 4000;

function formatEntry({ action, company, score, signal, feedback }) {
  const date = new Date().toISOString().slice(0, 10);
  const verdict = action === "demote" ? "DEMOTED (AI scored it too HIGH" : "PROMOTED (AI scored it too LOW";
  const sig = String(signal || "").replace(/\s+/g, " ").trim().slice(0, 110);
  return `• [${date}] ${verdict} at ${Number(score) || 0}): "${sig}" (${company || "?"}) — ${String(feedback).trim()}`;
}

// Append a line to an existing digest, trimming OLDEST entries (front) to stay
// under the cap. Entries are bullet lines, so trimming at line boundaries.
function appendToDigest(existing, line) {
  const lines = String(existing || "").split("\n").map(l => l.trim()).filter(Boolean);
  lines.push(line);
  while (lines.length > 1 && lines.join("\n").length > FEEDBACK_MAX_CHARS) lines.shift();
  return lines.join("\n").slice(-FEEDBACK_MAX_CHARS);
}

// PATCH one record, auto-creating the field if it doesn't exist yet (same
// pattern as linkedin-posts' atUpdateWithAutoCreate — multilineText for our
// feedback fields). Returns { ok, error? }.
async function atUpdateAutoCreate(baseId, table, id, fields, attempt = 0) {
  if (attempt > 4) return { ok: false, error: "auto-create retries exhausted" };
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}/${id}`, {
    method: "PATCH", headers: atHdr, body: JSON.stringify({ fields, typecast: true }),
  });
  if (r.ok) return { ok: true };
  const errText = await r.text();
  if (errText.includes("UNKNOWN_FIELD_NAME")) {
    const m = errText.match(/[Uu]nknown field name:?\s*\\?"([^"\\]+)\\?"/);
    const badField = m ? m[1] : null;
    if (badField) {
      try {
        const tablesRes = await fetch(`${AT_API}/meta/bases/${baseId}/tables`, { headers: atHdr });
        if (tablesRes.ok) {
          const { tables } = await tablesRes.json();
          const t = tables.find(t => t.name === table);
          if (t) {
            const cr = await fetch(`${AT_API}/meta/bases/${baseId}/tables/${t.id}/fields`, {
              method: "POST", headers: atHdr, body: JSON.stringify({ name: badField, type: "multilineText" }),
            });
            if (cr.ok) {
              await new Promise(res => setTimeout(res, 1200));
              return atUpdateAutoCreate(baseId, table, id, fields, attempt + 1);
            }
          }
        }
      } catch (e) { console.error("[review-feedback] field create exception:", e.message); }
    }
  }
  return { ok: false, error: `${r.status}: ${errText.slice(0, 200)}` };
}

// Create one Signal Archive row. Missing optional fields (Review Feedback /
// Reviewed At / Name / LinkedIn URL on un-provisioned bases) are stripped and
// retried, so a demote works even before setup-fix has run — the feedback is
// still preserved on the Task Rule memory either way.
async function createArchiveRow(baseId, fields, attempt = 0) {
  if (attempt > 8) return { ok: false, error: "field-strip retries exhausted" };
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Signal Archive")}`, {
    method: "POST", headers: atHdr, body: JSON.stringify({ records: [{ fields }], typecast: true }),
  });
  if (r.ok) { const d = await r.json(); return { ok: true, records: d.records || [] }; }
  const errText = await r.text();
  if (errText.includes("UNKNOWN_FIELD_NAME")) {
    const m = errText.match(/[Uu]nknown field name:?\s*\\?"([^"\\]+)\\?"/);
    if (m && m[1] && m[1] in fields) {
      const stripped = { ...fields };
      delete stripped[m[1]];
      console.warn(`[review-feedback] Signal Archive missing field "${m[1]}" — stripped, retrying`);
      return createArchiveRow(baseId, stripped, attempt + 1);
    }
  }
  return { ok: false, error: `${r.status}: ${errText.slice(0, 200)}` };
}

// Find the Task Rule record on this base whose Name matches the task's rule.
async function findRuleByName(baseId, ruleName) {
  const safe = String(ruleName || "").replace(/"/g, "").trim();
  if (!safe) return null;
  const params = new URLSearchParams({ filterByFormula: `{Name} = "${safe}"`, pageSize: "1" });
  const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Task Rules")}?${params}`, { headers: atHdr, cache: "no-store" });
  if (!r.ok) return null;
  const d = await r.json();
  return (d.records || [])[0] || null;
}

// Append the feedback line to the right memory for this task type.
// linkedin_engagement → master Campaigns row; everything else → its Task Rule.
async function saveFeedback({ baseId, campaignAirtableId, task, line }) {
  if (task.type === "linkedin_engagement") {
    if (!campaignAirtableId) return { ok: false, error: "campaignAirtableId required for linkedin_engagement feedback" };
    const rec = await fetch(`${AT_API}/${MASTER_BASE_ID}/Campaigns/${campaignAirtableId}`, { headers: atHdr, cache: "no-store" });
    const existing = rec.ok ? ((await rec.json()).fields?.["LinkedIn Posts Feedback"] || "") : "";
    return atUpdateAutoCreate(MASTER_BASE_ID, "Campaigns", campaignAirtableId, {
      "LinkedIn Posts Feedback": appendToDigest(existing, line),
    });
  }
  const rule = await findRuleByName(baseId, task.rule);
  if (!rule) return { ok: false, error: `Task Rule "${task.rule}" not found on this base` };
  return atUpdateAutoCreate(baseId, "Task Rules", rule.id, {
    "Reviewer Feedback": appendToDigest(rule.fields?.["Reviewer Feedback"] || "", line),
  });
}

export async function POST(request) {
  try {
    // Operator-only surface — block client-portal callers, same as /api/role-check.
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) {
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }
    if (!AIRTABLE_KEY) return NextResponse.json({ error: "AIRTABLE_API_KEY not configured" }, { status: 500 });
    const body = await request.json();
    const { action, baseId, campaignAirtableId, task = {}, feedback } = body;
    if (!["demote", "promote_feedback"].includes(action)) return NextResponse.json({ error: "action must be demote | promote_feedback" }, { status: 400 });
    if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
    if (!String(feedback || "").trim()) return NextResponse.json({ error: "feedback required — it's what teaches the scorer" }, { status: 400 });

    const line = formatEntry({ action: action === "demote" ? "demote" : "promote", company: task.company, score: task.score, signal: task.signal, feedback });
    const out = { ok: true };

    if (action === "demote") {
      if (!task.id) return NextResponse.json({ error: "task.id required for demote" }, { status: 400 });
      const nowISO = new Date().toISOString();
      // 1) Retain in Signal Archive — demotes are reviewable + reversible
      //    (promote brings them back), never silently destroyed.
      const arch = await createArchiveRow(baseId, {
        Company: task.company || "",
        "Signal Status": "demoted", // typecast:true auto-creates the select choice
        Score: Math.max(0, Math.min(100, Number(task.score) || 0)),
        "Score Reason": task.reason || "",
        Signal: task.signal || "",
        "Task Rule": task.rule || "",
        "Task Type": task.type || "news",
        Source: task.source || "",
        URL: task.url || "",
        "Scan Target": task.scanTarget || "accounts",
        "Lead Title": task.leadTitle || "",
        Name: task.name || "",
        "LinkedIn URL": task.linkedinUrl || "",
        "Review Feedback": String(feedback).trim(),
        "Reviewed At": nowISO,
        Date: (task.date || nowISO).slice(0, 10),
        Created: nowISO,
      });
      if (!arch.ok) return NextResponse.json({ error: `Archive write failed — task NOT demoted. ${arch.error}` }, { status: 502 });
      out.archived = arch.records;
      // 2) Remove the live Task (archive row is already safe).
      const del = await fetch(`${AT_API}/${baseId}/Tasks/${task.id}`, { method: "DELETE", headers: atHdr });
      if (!del.ok) {
        out.taskDeleted = false;
        out.deleteError = `Task delete failed (${del.status}) — archive copy created; delete the task manually.`;
      } else out.taskDeleted = true;
    }

    // 3) Teach the scorer. Best-effort: a demote still demotes even if the
    //    memory write fails — the caller is told so it can surface it.
    const fb = await saveFeedback({ baseId, campaignAirtableId, task, line });
    out.feedbackSaved = fb.ok;
    if (!fb.ok) out.feedbackError = fb.error;

    return NextResponse.json(out);
  } catch (e) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
