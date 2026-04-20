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
  // Unipile hosted auth requires ISO date for expiresOn, proper field names
  const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    type: "create",
    providers: ["LINKEDIN"],
    api_url: UNIPILE_DSN,
    expiresOn,
  };
  if (callbackUrl) {
    payload.success_redirect_url = callbackUrl;
    payload.failure_redirect_url = callbackUrl;
    payload.notify_url = callbackUrl;
  }
  const res = await unipileReq("/hosted/accounts/link", "POST", payload);
  console.log("[UNIPILE] Auth link response:", res.status, JSON.stringify(res.data).slice(0, 300));
  return res;
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

// Extract LinkedIn public identifier from URL or slug
function extractLinkedInIdentifier(input) {
  if (!input) return "";
  const s = input.trim();
  if (!s.includes("/")) return s; // already a slug
  const m = s.match(/linkedin\.com\/in\/([^\/\?\s&#]+)/i);
  return m ? m[1] : s;
}

// Unipile invite needs provider_id (LinkedIn member ID), not the URL
// So we resolve URL → profile → provider_id first
async function sendInvitation(accountId, profileUrl, message) {
  const identifier = extractLinkedInIdentifier(profileUrl);
  // Resolve profile to get provider_id
  const profileRes = await getProfile(accountId, identifier);
  if (!profileRes.ok) {
    return { ok: false, status: profileRes.status, data: { error: "Could not resolve profile", details: profileRes.data, identifier } };
  }
  const providerId = profileRes.data?.provider_id || profileRes.data?.id;
  if (!providerId) {
    return { ok: false, status: 400, data: { error: "No provider_id in profile response", details: profileRes.data } };
  }
  const body = {
    account_id: accountId,
    provider_id: providerId,
    message: message || undefined,
  };
  return unipileReq("/users/invite", "POST", body);
}

// Disconnect / delete account
async function disconnectAccount(accountId) {
  return unipileReq(`/accounts/${accountId}`, "DELETE");
}

// ─── Messaging ───────────────────────────────────────────────

async function startNewChat(accountId, linkedinUrlOrId, text) {
  // Resolve profile first to get the provider_id
  const identifier = extractLinkedInIdentifier(linkedinUrlOrId);
  let providerId = identifier;
  // If it looks like a slug (not numeric), resolve it
  if (!/^\d+$/.test(identifier)) {
    const profileRes = await getProfile(accountId, identifier);
    if (profileRes.ok) {
      providerId = profileRes.data?.provider_id || profileRes.data?.id || identifier;
    } else {
      return { ok: false, status: profileRes.status, data: { error: "Could not resolve profile for DM", details: profileRes.data } };
    }
  }
  const form = new FormData();
  form.append("account_id", accountId);
  form.append("attendees_ids", providerId);
  form.append("text", text);
  return unipileReq("/chats", "POST", form);
}

async function sendMessage(chatId, text) {
  const form = new FormData();
  form.append("text", text);
  return unipileReq(`/chats/${chatId}/messages`, "POST", form);
}

// Get messages in a chat to detect replies
async function getChatMessages(chatId, accountId) {
  return unipileReq(`/chats/${chatId}/messages?account_id=${accountId}&limit=20`);
}

// Check if lead has replied in a chat (any incoming message from lead = reply)
async function hasLeadReplied(chatId, accountId) {
  if (!chatId || !accountId) return false;
  try {
    const res = await getChatMessages(chatId, accountId);
    if (!res.ok) return false;
    const messages = res.data?.items || res.data?.messages || [];
    // is_sender=true means WE sent it; false/0 means lead replied
    return messages.some(m => m.is_sender === false || m.is_sender === 0);
  } catch (e) {
    console.error("[UNIPILE] Reply check failed:", e.message);
    return false;
  }
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
      model: "gpt-5.4-mini", temperature: 0.2, max_tokens: 500,
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
      model: "gpt-5.4-mini", temperature: 0.5, max_tokens: 300,
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

  // SAFETY CAPS — protect the LinkedIn account
  const MAX_CONNECTIONS_PER_RUN = ruleConfig.maxConnectionsPerRun || 20;
  const MAX_DMS_PER_RUN = ruleConfig.maxDmsPerRun || 30;

  // Load outreach queue items that need action
  const queue = await atList(baseId, "Outreach");
  const campaign = ruleConfig.name || "Outreach";

  // Filter to this campaign's items AND auto mode only (manual items are user-controlled)
  const items = queue.filter(q => {
    const f = q.fields || {};
    return (f.Campaign || "") === campaign && (f.Mode || "auto") === "auto";
  });

  let connSent = 0, dmsSent = 0, errors = 0;

  for (const item of items) {
    // SAFETY: stop if caps hit
    if (connSent >= MAX_CONNECTIONS_PER_RUN && dmsSent >= MAX_DMS_PER_RUN) break;

    const f = item.fields || {};
    const status = f.Status || "queued";
    const nextAction = f["Next Action Date"] || "";

    // Skip if next action is in the future
    if (nextAction && nextAction > today) continue;

    // Respect caps per action type
    if (status === "queued" && connSent >= MAX_CONNECTIONS_PER_RUN) continue;
    if ((status === "connected" || status.startsWith("dm_")) && dmsSent >= MAX_DMS_PER_RUN) continue;

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
        // ─── REPLY GUARDRAIL: stop if lead already replied ─
        const existingChatId = f["Unipile Chat ID"];
        if (existingChatId) {
          const replied = await hasLeadReplied(existingChatId, accountId);
          if (replied) {
            await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
              Status: "replied",
              "Replied At": now.toISOString(),
              "Next Action Date": "",
              Notes: "Lead replied — DM sequence stopped",
            }}]);
            log.push(`✋ ${f.Name || "Lead"} replied — sequence stopped`);
            continue;
          }
        }

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

        // If we have an existing chat, send a follow-up message there instead of starting new
        let chatRes;
        if (existingChatId) {
          chatRes = await sendMessage(existingChatId, msg);
        } else {
          const linkedinUrl = f["LinkedIn URL"] || "";
          chatRes = await startNewChat(accountId, linkedinUrl, msg);
        }

        if (chatRes.ok) {
          const nextStep = dmStep + 1;
          const nextDaysGap = sequence[nextStep]?.daysAfterPrev || 3;
          const nextDate = new Date(now.getTime() + nextDaysGap * 86400000).toISOString().slice(0, 10);
          await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
            Status: nextStep >= sequence.length ? "completed" : `dm_${nextStep}`,
            "DM Step": nextStep,
            "Last DM Sent At": now.toISOString(),
            "Next Action Date": nextStep >= sequence.length ? "" : nextDate,
            "Unipile Chat ID": existingChatId || chatRes.data?.chat_id || chatRes.data?.id || "",
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
// ENQUEUE LEADS — auto mode (AI-selected) or manual mode
// ═══════════════════════════════════════════════════════════════

async function enqueueLeads(baseId, ruleConfig, options = {}) {
  const { mode = "auto", selectedIds = [], count = 10 } = options;

  // Load all leads
  const leads = await atList(baseId, "Leads");
  if (!leads.length) return { error: "No leads found", enqueued: 0 };

  // GLOBAL DEDUP — check ALL outreach records across ALL campaigns
  const existing = await atList(baseId, "Outreach");
  const existingLinkedIns = new Set(
    existing.map(q => (q.fields?.["LinkedIn URL"] || "").toLowerCase().trim()).filter(Boolean)
  );

  let eligible;
  let skippedDupes = 0;

  if (mode === "manual" && selectedIds.length) {
    // Manual mode: user picked specific lead IDs
    eligible = leads.filter(l => selectedIds.includes(l.id));
    // Still dedupe against existing outreach
    const beforeCount = eligible.length;
    eligible = eligible.filter(l => {
      const li = (l.fields?.["LinkedIn URL"] || "").toLowerCase().trim();
      return li && !existingLinkedIns.has(li);
    });
    skippedDupes = beforeCount - eligible.length;
  } else {
    // Auto mode: AI selects from leads with LinkedIn URLs not yet in queue
    const hasLinkedIn = leads.filter(l => (l.fields?.["LinkedIn URL"] || "").trim());
    skippedDupes = hasLinkedIn.length - hasLinkedIn.filter(l => !existingLinkedIns.has((l.fields?.["LinkedIn URL"] || "").toLowerCase().trim())).length;
    eligible = hasLinkedIn.filter(l => !existingLinkedIns.has((l.fields?.["LinkedIn URL"] || "").toLowerCase().trim()));

    if (!eligible.length) return { error: "No eligible leads (all already in outreach or missing LinkedIn URL)", enqueued: 0, skippedDupes };

    // AI selects the best leads
    eligible = await aiSelectLeads(eligible, ruleConfig.leadPrompt || "", count);
  }

  if (!eligible.length) return { error: "No eligible leads after dedup", enqueued: 0, skippedDupes };

  // Create outreach queue records
  const records = eligible.map(l => {
    const f = l.fields || {};
    return {
      "Lead Name": f.Name || "Unknown",
      "LinkedIn URL": f["LinkedIn URL"] || "",
      Campaign: ruleConfig.name || "Outreach",
      Mode: mode, // "auto" or "manual"
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
  return { enqueued: created.length, total: eligible.length, skippedDupes, mode };
}

// ═══════════════════════════════════════════════════════════════
// MANUAL CONNECTIONS — send X connection requests to selected leads
// ═══════════════════════════════════════════════════════════════

async function sendManualConnections(baseId, accountId, outreachItemIds, ruleConfig) {
  const now = new Date();
  const queue = await atList(baseId, "Outreach");
  const items = queue.filter(q => outreachItemIds.includes(q.id));

  let sent = 0, errors = 0;
  const results = [];

  for (const item of items) {
    const f = item.fields || {};
    if (f.Status !== "queued") {
      results.push({ id: item.id, name: f["Lead Name"], skipped: "Already processed: " + f.Status });
      continue;
    }
    const linkedinUrl = f["LinkedIn URL"] || "";
    if (!linkedinUrl) {
      results.push({ id: item.id, name: f["Lead Name"], skipped: "No LinkedIn URL" });
      continue;
    }

    const connMsg = ruleConfig.connectionMessage
      ? await aiPersonalizeMessage(ruleConfig.connectionMessage, f, f.Signal || "", f.Company || "")
      : undefined;

    const res = await sendInvitation(accountId, linkedinUrl, connMsg);
    if (res.ok) {
      await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
        Status: "connection_sent",
        Mode: "manual",
        "Connection Sent At": now.toISOString(),
        "Next Action Date": "", // Manual: no auto date, user triggers DM manually
      }}]);
      sent++;
      results.push({ id: item.id, name: f["Lead Name"], ok: true });
    } else {
      await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
        Status: "error",
        Notes: JSON.stringify(res.data).slice(0, 500),
      }}]);
      errors++;
      results.push({ id: item.id, name: f["Lead Name"], error: JSON.stringify(res.data).slice(0, 150) });
    }

    // Throttle — human-like spacing
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
  }

  return { sent, errors, results };
}

// ═══════════════════════════════════════════════════════════════
// MANUAL DM TRIGGER — send next DM to specific items (user confirms accepted)
// ═══════════════════════════════════════════════════════════════

async function triggerManualDMs(baseId, accountId, outreachItemIds, ruleConfig) {
  const now = new Date();
  const queue = await atList(baseId, "Outreach");
  const items = queue.filter(q => outreachItemIds.includes(q.id));
  const sequence = ruleConfig.dmSequence || [];

  let sent = 0, errors = 0, skippedReplied = 0;
  const results = [];

  for (const item of items) {
    const f = item.fields || {};

    // Guard: check reply first
    const existingChatId = f["Unipile Chat ID"];
    if (existingChatId) {
      const replied = await hasLeadReplied(existingChatId, accountId);
      if (replied) {
        await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
          Status: "replied", "Replied At": now.toISOString(), "Next Action Date": "",
          Notes: "Lead replied — DM sequence stopped",
        }}]);
        skippedReplied++;
        results.push({ id: item.id, name: f["Lead Name"], skipped: "Already replied" });
        continue;
      }
    }

    const dmStep = parseInt(f["DM Step"] || "0");
    if (dmStep >= sequence.length) {
      await atUpdate(baseId, "Outreach", [{ id: item.id, fields: { Status: "completed" }}]);
      results.push({ id: item.id, name: f["Lead Name"], skipped: "Sequence complete" });
      continue;
    }

    const step = sequence[dmStep];
    const msg = step.aiGenerate
      ? await aiPersonalizeMessage(step.message, f, f.Signal || "", f.Company || "")
      : fillMergeFields(step.message, f, f.Signal || "", f.Company || "");

    let chatRes;
    if (existingChatId) {
      chatRes = await sendMessage(existingChatId, msg);
    } else {
      chatRes = await startNewChat(accountId, f["LinkedIn URL"] || "", msg);
    }

    if (chatRes.ok) {
      const nextStep = dmStep + 1;
      await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
        Status: nextStep >= sequence.length ? "completed" : `dm_${nextStep}`,
        "DM Step": nextStep,
        "Last DM Sent At": now.toISOString(),
        "Next Action Date": "", // Manual mode: user controls timing
        "Unipile Chat ID": existingChatId || chatRes.data?.chat_id || chatRes.data?.id || "",
      }}]);
      sent++;
      results.push({ id: item.id, name: f["Lead Name"], ok: true, step: nextStep });
    } else {
      await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
        Notes: "DM failed: " + JSON.stringify(chatRes.data).slice(0, 300),
      }}]);
      errors++;
      results.push({ id: item.id, name: f["Lead Name"], error: JSON.stringify(chatRes.data).slice(0, 150) });
    }

    await new Promise(r => setTimeout(r, 3000 + Math.random() * 3000));
  }

  return { sent, errors, skippedReplied, results };
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
    replied: 0,
    completed: 0,
    errors: 0,
  };

  for (const q of filtered) {
    const s = (q.fields?.Status || "queued");
    if (s === "queued") stats.queued++;
    else if (s === "connection_sent") stats.connectionSent++;
    else if (s === "connected") stats.connected++;
    else if (s.startsWith("dm_")) stats.dmInProgress++;
    else if (s === "replied") stats.replied++;
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
        if (!res.ok || !res.data?.url) {
          console.error("[UNIPILE] Auth link failed:", res.status, res.data);
          return NextResponse.json({
            error: "Unipile auth link failed",
            status: res.status,
            details: res.data,
            hint: res.status === 401 ? "UNIPILE_API_KEY is invalid" : res.status === 404 ? "UNIPILE_DSN is wrong — check your DSN URL" : "Check Unipile credentials and account status",
          }, { status: 400 });
        }
        return NextResponse.json(res.data);
      }

      case "test_unipile": {
        // Diagnostic: test connection and return config status
        const tests = { dsn: !!UNIPILE_DSN, key: !!UNIPILE_KEY, dsnValue: UNIPILE_DSN || "NOT SET" };
        if (!UNIPILE_DSN || !UNIPILE_KEY) {
          return NextResponse.json({ ok: false, tests, error: "Missing env vars" });
        }
        const listRes = await listAccounts();
        tests.canListAccounts = listRes.ok;
        tests.accountsStatus = listRes.status;
        if (!listRes.ok) tests.accountsError = typeof listRes.data === "string" ? listRes.data.slice(0, 200) : JSON.stringify(listRes.data).slice(0, 200);
        return NextResponse.json({ ok: listRes.ok, tests });
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

      case "disconnect_account": {
        if (!accountId) return NextResponse.json({ error: "accountId required" }, { status: 400 });
        const res = await disconnectAccount(accountId);
        return NextResponse.json({ ok: res.ok, status: res.status, data: res.data });
      }

      case "enqueue_leads": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        // Safety: hard cap manual/auto adds
        const count = Math.min(body.count || body.ruleConfig?.leadsPerBatch || 10, 100);
        const options = { mode: body.mode || "auto", selectedIds: body.selectedIds || [], count };
        const result = await enqueueLeads(baseId, body.ruleConfig || {}, options);
        return NextResponse.json(result);
      }

      case "list_queue": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const queue = await atList(baseId, "Outreach");
        const items = body.campaign ? queue.filter(q => (q.fields?.Campaign || "") === body.campaign) : queue;
        // Optional status filter
        const filtered = body.status ? items.filter(q => (q.fields?.Status || "queued") === body.status) : items;
        return NextResponse.json({ items: filtered });
      }

      case "send_manual_connections": {
        if (!baseId || !accountId) return NextResponse.json({ error: "baseId and accountId required" }, { status: 400 });
        const ids = body.outreachItemIds || [];
        // SAFETY: hard cap per batch to protect the account
        const SAFE_DAILY_CAP = 30;
        if (ids.length > SAFE_DAILY_CAP) {
          return NextResponse.json({ error: `Safety limit: max ${SAFE_DAILY_CAP} connection requests per batch to protect the account`, attempted: ids.length }, { status: 400 });
        }
        const result = await sendManualConnections(baseId, accountId, ids, body.ruleConfig || {});
        return NextResponse.json(result);
      }

      case "mark_connected": {
        // Manually mark a lead's connection as accepted (user confirmed on LinkedIn)
        if (!baseId || !body.outreachItemIds?.length) return NextResponse.json({ error: "baseId and outreachItemIds required" }, { status: 400 });
        const updates = body.outreachItemIds.map(id => ({ id, fields: { Status: "connected", "Connection Accepted At": new Date().toISOString() } }));
        await atUpdate(baseId, "Outreach", updates);
        return NextResponse.json({ marked: updates.length });
      }

      case "trigger_manual_dms": {
        if (!baseId || !accountId) return NextResponse.json({ error: "baseId and accountId required" }, { status: 400 });
        const ids = body.outreachItemIds || [];
        const SAFE_DM_CAP = 50;
        if (ids.length > SAFE_DM_CAP) {
          return NextResponse.json({ error: `Safety limit: max ${SAFE_DM_CAP} DMs per batch`, attempted: ids.length }, { status: 400 });
        }
        const result = await triggerManualDMs(baseId, accountId, ids, body.ruleConfig || {});
        return NextResponse.json(result);
      }

      case "check_replies": {
        if (!baseId || !accountId) return NextResponse.json({ error: "baseId and accountId required" }, { status: 400 });
        const queue = await atList(baseId, "Outreach");
        // Only check items with an active chat and not already replied/completed
        const active = queue.filter(q => {
          const f = q.fields || {};
          const s = f.Status || "";
          return f["Unipile Chat ID"] && !["replied", "completed", "error"].includes(s);
        });
        const campaign = body.ruleConfig?.name;
        const items = campaign ? active.filter(q => (q.fields?.Campaign || "") === campaign) : active;

        let repliesFound = 0;
        const replied = [];
        for (const item of items) {
          const f = item.fields || {};
          const chatId = f["Unipile Chat ID"];
          const didReply = await hasLeadReplied(chatId, accountId);
          if (didReply) {
            await atUpdate(baseId, "Outreach", [{ id: item.id, fields: {
              Status: "replied",
              "Replied At": new Date().toISOString(),
              "Next Action Date": "",
              Notes: "Lead replied — DM sequence stopped",
            }}]);
            repliesFound++;
            replied.push(f.Name || f["LinkedIn URL"] || item.id);
          }
          await new Promise(r => setTimeout(r, 300)); // rate limit
        }
        return NextResponse.json({ checked: items.length, repliesFound, replied });
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
