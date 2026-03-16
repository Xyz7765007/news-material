import { NextResponse } from "next/server";
import OpenAI from "openai";

const UNIPILE_DSN = process.env.UNIPILE_DSN; // e.g. https://api1.unipile.com:13371
const UNIPILE_KEY = process.env.UNIPILE_API_KEY;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const AT_API = "https://api.airtable.com/v0";

// ═══════════════════════════════════════════════════════════════
// UNIPILE API HELPERS
// ═══════════════════════════════════════════════════════════════

async function unipileReq(path, method = "GET", body = null) {
  const url = `${UNIPILE_DSN}/api/v1${path}`;
  const opts = {
    method,
    headers: { "X-API-KEY": UNIPILE_KEY, "Accept": "application/json" },
  };
  if (body) {
    if (body instanceof FormData) {
      opts.body = body;
    } else {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, data: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, data: text }; }
}

// ─── Account Management ──────────────────────────────────────

async function getHostedAuthLink(callbackUrl) {
  return unipileReq("/hosted/accounts/link", "POST", {
    type: "create",
    providers_restrictions: ["LINKEDIN"],
    api_url: UNIPILE_DSN,
    success_redirect_url: callbackUrl || undefined,
    failure_redirect_url: callbackUrl || undefined,
    notify_url: callbackUrl || undefined,
  });
}

async function listAccounts() {
  return unipileReq("/accounts");
}

async function getAccount(accountId) {
  return unipileReq(`/accounts/${accountId}`);
}

// ─── Profile & Invitations ───────────────────────────────────

async function getProfile(accountId, identifier) {
  return unipileReq(`/users/${encodeURIComponent(identifier)}?account_id=${accountId}&linkedin_sections=*`);
}

async function sendInvitation(accountId, profileUrl, message) {
  const body = {
    account_id: accountId,
    provider_id: profileUrl,
    message: message || undefined,
  };
  return unipileReq("/users/invite", "POST", body);
}

// ─── Messaging ───────────────────────────────────────────────

async function startNewChat(accountId, attendeeId, text) {
  const form = new FormData();
  form.append("account_id", accountId);
  form.append("attendees_ids", attendeeId);
  form.append("text", text);
  return unipileReq("/chats", "POST", form);
}

async function sendMessage(chatId, text) {
  const form = new FormData();
  form.append("text", text);
  return unipileReq(`/chats/${chatId}/messages`, "POST", form);
}

async function getRelations(accountId, limit = 100) {
  return unipileReq(`/users/relations?account_id=${accountId}&limit=${limit}`);
}

// ═══════════════════════════════════════════════════════════════
// AIRTABLE HELPERS (direct, not via /api/airtable)
// ═══════════════════════════════════════════════════════════════

const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

async function atList(baseId, table, params = {}) {
  const qs = new URLSearchParams();
  if (params.filterByFormula) qs.set("filterByFormula", params.filterByFormula);
  if (params.maxRecords) qs.set("maxRecords", params.maxRecords);
  let all = [], offset = null;
  do {
    const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}${offset ? "&offset=" + offset : ""}`;
    const res = await fetch(url, { headers: atHdr });
    if (!res.ok) { console.error(`AT list ${table}:`, await res.text()); break; }
    const d = await res.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

async function atCreate(baseId, table, records) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ fields: r }));
    const res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST", headers: atHdr, body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) { console.error(`AT create ${table}:`, await res.text()); continue; }
    const d = await res.json();
    results.push(...(d.records || []));
  }
  return results;
}

async function atUpdate(baseId, table, records) {
  const results = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    const res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: atHdr, body: JSON.stringify({ records: batch }),
    });
    if (!res.ok) { console.error(`AT update ${table}:`, await res.text()); continue; }
    const d = await res.json();
    results.push(...(d.records || []));
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════
// AI: SELECT LEADS + PERSONALIZE MESSAGES
// ═══════════════════════════════════════════════════════════════

async function aiSelectLeads(leads, prompt, count) {
  if (!OPENAI_KEY || !leads.length) return leads.slice(0, count);
  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  const leadList = leads.map((l, i) => {
    const f = l.fields || {};
    const data = Object.entries(f)
      .filter(([_, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}: ${String(v).slice(0, 100)}`)
      .join(" | ");
    return `[${i}] ${f.Name || "Unknown"} — ${data}`;
  }).join("\n");

  try {
    const c = await openai.chat.completions.create({
      model: "gpt-4.1-mini", temperature: 0.2, max_tokens: 500,
      messages: [
        { role: "system", content: `Select the top ${count} leads that best match the criteria. Return ONLY a JSON array of indices: [0, 3, 7, ...]. No markdown.` },
        { role: "user", content: `Criteria:\n${prompt}\n\nLeads:\n${leadList}` },
      ],
    });
    const text = c.choices[0]?.message?.content || "[]";
    const indices = JSON.parse(text.replace(/```json\n?|```/g, "").trim());
    return indices.filter(i => leads[i]).map(i => leads[i]).slice(0, count);
  } catch (e) {
    console.error("AI lead selection failed:", e.message);
    return leads.slice(0, count);
  }
}

async function aiPersonalizeMessage(template, lead, signal, companyName) {
  if (!OPENAI_KEY) return fillMergeFields(template, lead, signal, companyName);

  const f = lead.fields || lead;
  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  try {
    const c = await openai.chat.completions.create({
      model: "gpt-4.1-mini", temperature: 0.5, max_tokens: 300,
      messages: [
        { role: "system", content: `Personalize this LinkedIn message template for the specific lead. Keep the same structure and intent. Make it natural and conversational. Replace merge fields and add personal touches based on the lead's data. Return ONLY the message text, nothing else.` },
        { role: "user", content: `Template:\n${template}\n\nLead: ${f.Name || "there"}\nTitle: ${f.Title || ""}\nCompany: ${f.Company || companyName || ""}\nLinkedIn: ${f["LinkedIn URL"] || ""}\nSignal: ${signal || ""}` },
      ],
    });
    return c.choices[0]?.message?.content?.trim() || fillMergeFields(template, lead, signal, companyName);
  } catch {
    return fillMergeFields(template, lead, signal, companyName);
  }
}

function fillMergeFields(template, lead, signal, companyName) {
  const f = lead.fields || lead;
  return (template || "")
    .replace(/\{name\}/gi, f.Name || f["First Name"] || "there")
    .replace(/\{first_name\}/gi, f["First Name"] || (f.Name || "").split(" ")[0] || "there")
    .replace(/\{last_name\}/gi, f["Last Name"] || (f.Name || "").split(" ").slice(1).join(" ") || "")
    .replace(/\{title\}/gi, f.Title || "")
    .replace(/\{company\}/gi, f.Company || companyName || "")
    .replace(/\{signal\}/gi, signal || "")
    .replace(/\{linkedin\}/gi, f["LinkedIn URL"] || "");
}

// ═══════════════════════════════════════════════════════════════
// QUEUE PROCESSING — THE AUTOMATION ENGINE
// ═══════════════════════════════════════════════════════════════

async function processOutreachQueue(baseId, accountId, ruleConfig) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const log = [];

  // Load outreach queue items that need action
  const queue = await atList(baseId, "Outreach");
  const campaign = ruleConfig.name || "Outreach";

  // Filter to this campaign's items
  const items = queue.filter(q => (q.fields?.Campaign || "") === campaign);

  let connSent = 0, dmsSent = 0, errors = 0;

  for (const item of items) {
    const f = item.fields || {};
    const status = f.Status || "queued";
    const nextAction = f["Next Action Date"] || "";

    // Skip if next action is in the future
    if (nextAction && nextAction > today) continue;

    try {
      if (status === "queued") {
        // ─── Send connection request ─────────────────────
        const linkedinUrl = f["LinkedIn URL"] || "";
        if (!linkedinUrl) continue;

        const connMsg = ruleConfig.connectionMessage
          ? await aiPersonalizeMessage(ruleConfig.connectionMessage, f, f.Signal || "", f.Company || "")
          : undefined;

        const res = await sendInvitation(accountId, linkedinUrl, connMsg);
        if (res.ok) {
          const daysGap = ruleConfig.daysAfterConnect || 2;
          const nextDate = new Date(now.getTime() + daysGap * 86400000).toISOString().slice(0, 10);
          await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
            Status: "connection_sent",
            "Connection Sent At": now.toISOString(),
            "Next Action Date": nextDate,
          }}]);
          connSent++;
        } else {
          console.error("Invitation failed:", res.data);
          await atUpdate(baseId, "Outreach", [{ id: item.id, fields: { Status: "error", Notes: JSON.stringify(res.data).slice(0, 500) }}]);
          errors++;
        }
      }
      else if (status === "connection_sent") {
        // ─── Check if connection was accepted ────────────
        // We check by trying to start a chat — if it works, they're connected
        // For now, mark as connected if enough time has passed and move to DM phase
        // The cron will re-check periodically
        const daysGap = ruleConfig.daysAfterConnect || 2;
        const nextDate = new Date(now.getTime() + 1 * 86400000).toISOString().slice(0, 10); // check again tomorrow
        await atUpdate(baseId, "Outreach", [{ id: item.id, fields: { "Next Action Date": nextDate }}]);
      }
      else if (status === "connected" || status.startsWith("dm_")) {
        // ─── Send next DM in sequence ────────────────────
        const dmStep = parseInt(f["DM Step"] || "0");
        const sequence = ruleConfig.dmSequence || [];

        if (dmStep >= sequence.length) {
          await atUpdate(baseId, "Outreach", [{ id: item.id, fields: { Status: "completed" }}]);
          continue;
        }

        const step = sequence[dmStep];
        const msg = step.aiGenerate
          ? await aiPersonalizeMessage(step.message, f, f.Signal || "", f.Company || "")
          : fillMergeFields(step.message, f, f.Signal || "", f.Company || "");

        // Try to send DM
        const linkedinUrl = f["LinkedIn URL"] || "";
        const chatRes = await startNewChat(accountId, linkedinUrl, msg);

        if (chatRes.ok) {
          const nextStep = dmStep + 1;
          const nextDaysGap = sequence[nextStep]?.daysAfterPrev || 3;
          const nextDate = new Date(now.getTime() + nextDaysGap * 86400000).toISOString().slice(0, 10);
          await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
            Status: nextStep >= sequence.length ? "completed" : `dm_${nextStep}`,
            "DM Step": nextStep,
            "Last DM Sent At": now.toISOString(),
            "Next Action Date": nextStep >= sequence.length ? "" : nextDate,
            "Unipile Chat ID": chatRes.data?.chat_id || chatRes.data?.id || "",
          }}]);
          dmsSent++;
        } else if (chatRes.status === 422 || chatRes.status === 403) {
          // Not connected yet or can't message — keep waiting
          const nextDate = new Date(now.getTime() + 1 * 86400000).toISOString().slice(0, 10);
          await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
            "Next Action Date": nextDate,
            Notes: "Waiting for connection acceptance",
          }}]);
        } else {
          console.error("DM failed:", chatRes.data);
          await atUpdate(baseId, "Outreach", [{ id: item.id, fields: { Status: "error", Notes: JSON.stringify(chatRes.data).slice(0, 500) }}]);
          errors++;
        }
      }
    } catch (e) {
      console.error("Queue item error:", e.message);
      errors++;
    }

    // Rate limiting — space out requests
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000));
  }

  return { processed: items.length, connectionsSent: connSent, dmsSent, errors, date: today };
}

// ═══════════════════════════════════════════════════════════════
// ENQUEUE LEADS — AI selects + adds to outreach queue
// ═══════════════════════════════════════════════════════════════

async function enqueueLeads(baseId, ruleConfig) {
  // Load all leads
  const leads = await atList(baseId, "Leads");
  if (!leads.length) return { error: "No leads found", enqueued: 0 };

  // Load existing outreach to avoid duplicates
  const existing = await atList(baseId, "Outreach");
  const existingLinkedIns = new Set(existing.map(q => (q.fields?.["LinkedIn URL"] || "").toLowerCase()));

  // Filter leads that have LinkedIn URLs and aren't already in queue
  const eligible = leads.filter(l => {
    const li = (l.fields?.["LinkedIn URL"] || "").toLowerCase().trim();
    return li && !existingLinkedIns.has(li);
  });

  if (!eligible.length) return { error: "No eligible leads (all already in queue or missing LinkedIn URL)", enqueued: 0 };

  // AI selects the best leads
  const selected = await aiSelectLeads(eligible, ruleConfig.leadPrompt || "", ruleConfig.leadsPerBatch || 10);

  // Create outreach queue records
  const records = selected.map(l => {
    const f = l.fields || {};
    return {
      "Lead Name": f.Name || "Unknown",
      "LinkedIn URL": f["LinkedIn URL"] || "",
      Campaign: ruleConfig.name || "Outreach",
      Status: "queued",
      Company: f.Company || "",
      Title: f.Title || "",
      Email: f.Email || "",
      Signal: ruleConfig.signal || "",
      "DM Step": 0,
      "Next Action Date": new Date().toISOString().slice(0, 10),
      "Created At": new Date().toISOString(),
    };
  });

  const created = await atCreate(baseId, "Outreach", records);
  return { enqueued: created.length, total: eligible.length };
}

// ═══════════════════════════════════════════════════════════════
// GET OUTREACH STATS
// ═══════════════════════════════════════════════════════════════

async function getOutreachStats(baseId, campaign) {
  const items = await atList(baseId, "Outreach");
  const filtered = campaign ? items.filter(q => (q.fields?.Campaign || "") === campaign) : items;

  const stats = {
    total: filtered.length,
    queued: 0,
    connectionSent: 0,
    connected: 0,
    dmInProgress: 0,
    completed: 0,
    errors: 0,
  };

  for (const q of filtered) {
    const s = (q.fields?.Status || "queued");
    if (s === "queued") stats.queued++;
    else if (s === "connection_sent") stats.connectionSent++;
    else if (s === "connected") stats.connected++;
    else if (s.startsWith("dm_")) stats.dmInProgress++;
    else if (s === "completed") stats.completed++;
    else if (s === "error") stats.errors++;
  }

  return { stats, items: filtered };
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════

export async function POST(request) {
  try {
    const body = await request.json();
    const { action, baseId, accountId } = body;

    if (!UNIPILE_DSN || !UNIPILE_KEY) {
      return NextResponse.json({ error: "UNIPILE_DSN and UNIPILE_API_KEY required" }, { status: 500 });
    }

    switch (action) {
      case "get_auth_link": {
        const res = await getHostedAuthLink(body.callbackUrl);
        return NextResponse.json(res.data);
      }

      case "list_accounts": {
        const res = await listAccounts();
        return NextResponse.json(res.data);
      }

      case "get_account": {
        const res = await getAccount(accountId);
        return NextResponse.json(res.data);
      }

      case "get_profile": {
        const res = await getProfile(accountId, body.identifier);
        return NextResponse.json(res.data);
      }

      case "send_invitation": {
        const res = await sendInvitation(accountId, body.profileUrl, body.message);
        return NextResponse.json({ ok: res.ok, data: res.data });
      }

      case "send_message": {
        const res = body.chatId
          ? await sendMessage(body.chatId, body.text)
          : await startNewChat(accountId, body.attendeeId, body.text);
        return NextResponse.json({ ok: res.ok, data: res.data });
      }

      case "enqueue_leads": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const result = await enqueueLeads(baseId, body.ruleConfig || {});
        return NextResponse.json(result);
      }

      case "process_queue": {
        if (!baseId || !accountId) return NextResponse.json({ error: "baseId and accountId required" }, { status: 400 });
        const result = await processOutreachQueue(baseId, accountId, body.ruleConfig || {});
        return NextResponse.json(result);
      }

      case "get_stats": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const result = await getOutreachStats(baseId, body.campaign);
        return NextResponse.json(result);
      }

      case "preview_message": {
        const msg = body.aiGenerate
          ? await aiPersonalizeMessage(body.template, body.lead || {}, body.signal || "", body.company || "")
          : fillMergeFields(body.template, body.lead || {}, body.signal || "", body.company || "");
        return NextResponse.json({ message: msg });
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Outreach API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
