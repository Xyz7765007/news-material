import { NextResponse } from "next/server";
import OpenAI from "openai";

const UNIPILE_DSN = process.env.UNIPILE_DSN; // e.g. https://api1.unipile.com:13371
const UNIPILE_KEY = process.env.UNIPILE_API_KEY;
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const AT_API = "https://api.airtable.com/v0";

// ═══════════════════════════════════════════════════════════════
// UNIPILE API HELPERS
// ═══════════════════════════════════════════════════════════════

// Build the actual request URL. Vercel blocks non-standard ports.
// Unipile supports moving the port to a query param when custom ports are blocked.
// e.g. https://api1.unipile.com:15009/api/v1/accounts
//   -> https://api1.unipile.com/api/v1/accounts?port=15009
function buildUnipileUrl(path) {
  if (!UNIPILE_DSN) return null;
  let dsn = UNIPILE_DSN.replace(/\/$/, ""); // strip trailing slash
  let portParam = "";
  const match = dsn.match(/^(https?:\/\/[^:\/]+)(?::(\d+))?/i);
  if (match && match[2]) {
    // Has custom port — rewrite to standard 443 and pass as query param
    dsn = match[1];
    portParam = `port=${match[2]}`;
  }
  const sep = path.includes("?") ? "&" : "?";
  const qs = portParam ? `${sep}${portParam}` : "";
  return `${dsn}/api/v1${path}${qs}`;
}

async function unipileReq(path, method = "GET", body = null) {
  const url = buildUnipileUrl(path);
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
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    try { return { ok: res.ok, status: res.status, data: JSON.parse(text), url }; }
    catch { return { ok: res.ok, status: res.status, data: text, url }; }
  } catch (e) {
    console.error("[UNIPILE] Fetch error:", e.message, "URL:", url);
    return { ok: false, status: 0, data: { error: e.message, url }, fetchError: true };
  }
}

// ─── Account Management ──────────────────────────────────────

async function getHostedAuthLink(callbackUrl, reconnectAccountId = null) {
  // Unipile hosted auth requires ISO date for expiresOn, proper field names
  const expiresOn = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const payload = {
    type: reconnectAccountId ? "reconnect" : "create",
    providers: ["LINKEDIN"],
    api_url: UNIPILE_DSN,
    expiresOn,
  };
  if (reconnectAccountId) {
    payload.reconnect_account = reconnectAccountId;
  }
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
  // SAFETY: validate message before any Unipile call
  if (message) {
    const v = validateMessage(message, "connection_note");
    if (!v.ok) {
      console.error("[SEND-BLOCKED] Invitation:", v.error, "message:", message.slice(0, 100));
      return { ok: false, status: 0, data: { error: "Message validation failed: " + v.error, blocked: true } };
    }
  }
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
  // SAFETY: validate first message before any Unipile call
  const v = validateMessage(text, "first_dm");
  if (!v.ok) {
    console.error("[SEND-BLOCKED] DM:", v.error, "text:", (text || "").slice(0, 100));
    return { ok: false, status: 0, data: { error: "Message validation failed: " + v.error, blocked: true } };
  }
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
  // SAFETY: validate message before any Unipile call
  const v = validateMessage(text, "dm_followup");
  if (!v.ok) {
    console.error("[SEND-BLOCKED] Follow-up DM:", v.error, "text:", (text || "").slice(0, 100));
    return { ok: false, status: 0, data: { error: "Message validation failed: " + v.error, blocked: true } };
  }
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
  const errors = [];
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10).map(r => ({ fields: r }));
    let res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "POST", headers: atHdr, body: JSON.stringify({ records: batch }),
    });

    // If 422 "Unknown field name", remove unknown fields and retry
    if (res.status === 422) {
      const errText = await res.text();
      console.warn(`[AT CREATE] 422 on ${table}, error: ${errText.slice(0,300)}`);
      const unknownFields = [];
      // Extract field names from Airtable error messages like "Unknown field name: \"Mode\""
      const matches = errText.matchAll(/[Uu]nknown field name:?\s*["']([^"']+)["']/g);
      for (const m of matches) unknownFields.push(m[1]);

      if (unknownFields.length > 0) {
        console.warn(`[AT CREATE] Retrying without unknown fields: ${unknownFields.join(", ")}`);
        const cleanBatch = batch.map(r => {
          const clean = { ...r.fields };
          for (const uf of unknownFields) delete clean[uf];
          return { fields: clean };
        });
        res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
          method: "POST", headers: atHdr, body: JSON.stringify({ records: cleanBatch }),
        });
      }
    }

    if (!res.ok) {
      const err = await res.text();
      console.error(`[AT CREATE] ${table} failed ${res.status}:`, err.slice(0, 300));
      errors.push({ status: res.status, body: err.slice(0, 300) });
      continue;
    }
    const d = await res.json();
    results.push(...(d.records || []));
  }
  return { records: results, errors };
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

async function aiPersonalizeMessageWithMeta(template, lead, signal, companyName) {
  // Always do deterministic merge first — this is our safety net
  const deterministic = fillMergeFields(template, lead, signal, companyName);

  if (!OPENAI_KEY) {
    console.warn("[MERGE] OPENAI_API_KEY not set — returning deterministic merge");
    return { text: deterministic, method: "deterministic_no_key" };
  }

  const f = lead.fields || lead;
  const names = deriveNames(f);

  // Detect rich engagement context (GA, prior interactions, etc.)
  const gaScore = Number(f["GA Engagement Score"] || 0);
  const gaSessions = Number(f["GA Sessions"] || 0);
  const gaViews = Number(f["GA Views"] || 0);
  const gaLastVisit = f["GA Last Visit"] || "";
  const gaEngagementTime = Number(f["GA Engagement Time"] || 0);
  const hasGAContext = gaScore > 0 || gaSessions > 0;
  const hasSignal = !!(signal && signal.trim());

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  try {
    let systemPrompt, userPrompt;

    if (hasGAContext) {
      // GA path — write a FRESH message from scratch using engagement data
      // This produces genuinely personalized output (not template-with-name-filled-in)
      systemPrompt = `You write LinkedIn connection request notes for B2B sales. The lead has ALREADY VISITED OUR WEBSITE — this is warm outreach.

YOUR JOB: Write a fresh, personal opening that references their actual website behavior. Don't use a template — actually write something specific to this lead's engagement pattern.

RULES:
1. UNDER 280 characters total (LinkedIn cap is 300; leave headroom)
2. Open with their behavior — not a generic "noticed you've been exploring our site"
3. Be specific: if they had 6 sessions, mention that. If they spent 8 minutes, mention that. Use the actual numbers when meaningful.
4. Sound like a human SDR who genuinely noticed them — not a creepy stalker, not a marketing bot
5. Lowercase, casual tone is fine. Use first name only.
6. NO subject line — this is a connection note, not an email.
7. End with a soft, low-friction ask (e.g., "happy to share what we've been working on if useful" or "open to chatting if it's relevant")
8. Vary sentence structure — every lead should get a meaningfully different opener even if the engagement data is similar
9. NEVER use placeholder syntax like {first_name} — write actual values
10. Return ONLY the message text — no preamble, quotes, or markdown

GOOD opener examples (do NOT copy these — generate your own based on the lead's actual data):
- "hey [name] — saw your team at [company] dropped in 6 times last week, mostly digging through our pricing pages."
- "hi [name], noticed you've been spending real time on our site (8m+ across 4 sessions). usually means there's something specific you're trying to solve."
- "[name] — your visits to our site this week caught my eye. rather than guess at what you're after, easier to ask: what brought you in?"

BAD opener examples (DO NOT do this):
- "Hi [name], noticed you've been exploring our site — figured it's worth connecting." (too generic, ignores actual data)
- "Hi {first_name}..." (placeholder leaked)
- "Dear [Full Name], I hope this message finds you well." (formal/cold opener)`;

      const ctxLines = [
        `=== LEAD ===`,
        `Name: ${names.full || "Unknown"}`,
        `First name (use this in the message): ${names.first || "(unknown)"}`,
        `Title: ${f.Title || "(unknown)"}`,
        `Company: ${f.Company || companyName || "(unknown)"}`,
        ``,
        `=== WEBSITE ENGAGEMENT (use this to personalize the opener) ===`,
        `Engagement tier: ${gaScore >= 51 ? "🔥 Hot" : gaScore >= 21 ? "⚡ Interested" : "👀 Warm"} (score ${gaScore}/100)`,
      ];
      if (gaSessions > 0) ctxLines.push(`Sessions: ${gaSessions}`);
      if (gaViews > 0) ctxLines.push(`Pageviews: ${gaViews}`);
      if (gaEngagementTime > 0) {
        const t = gaEngagementTime >= 60 ? `${Math.floor(gaEngagementTime/60)}m ${Math.floor(gaEngagementTime%60)}s` : `${Math.floor(gaEngagementTime)}s`;
        ctxLines.push(`Time on site: ${t}`);
      }
      if (gaLastVisit) ctxLines.push(`Last visit: ${gaLastVisit}`);
      ctxLines.push(``);
      ctxLines.push(`=== STYLE REFERENCE (optional — what we'd say if no engagement data) ===`);
      ctxLines.push(template);
      ctxLines.push(``);
      ctxLines.push(`Now write a fresh connection note for this lead using their engagement data. Under 280 characters.`);

      userPrompt = ctxLines.join("\n");
    } else {
      // No GA — just personalize the template with lead's basic info
      systemPrompt = `Personalize this LinkedIn connection note for the specific lead.

RULES:
1. Keep the same structure and intent as the template
2. Replace ALL merge fields like {first_name}, {company}, {title}
3. NO curly braces in output
4. If a field is empty, rewrite naturally (don't say "at " or "in your role as ")
5. UNDER 280 characters total
6. Make it natural and conversational
7. Return ONLY the message text — no preamble, quotes, or markdown`;

      userPrompt = `Template:\n${template}\n\nLead data:\nName: ${names.full || "Unknown"}\nFirst name: ${names.first || "(unknown)"}\nTitle: ${f.Title || "(unknown)"}\nCompany: ${f.Company || companyName || "(unknown)"}${hasSignal ? `\nSignal: ${signal}` : ""}`;
    }

    console.log(`[MERGE] Calling AI for ${names.first || "(unknown)"} @ ${f.Company || "?"}. hasGAContext=${hasGAContext}, gaScore=${gaScore}, sessions=${gaSessions}, views=${gaViews}`);

    const c = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      temperature: hasGAContext ? 0.85 : 0.5, // higher creativity when writing from scratch with engagement data
      max_tokens: 300,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    });

    const aiMsg = c.choices?.[0]?.message?.content?.trim();
    if (!aiMsg) {
      console.warn(`[MERGE] AI returned empty content. Falling back. Raw response:`, JSON.stringify(c).slice(0, 300));
      return { text: deterministic, method: "deterministic_empty_ai" };
    }

    // Strip any leaked quotes around the whole message
    const cleaned = aiMsg.replace(/^["'`]+|["'`]+$/g, "").trim();

    // CRITICAL SAFETY CHECK: if AI left any merge fields unresolved, don't trust it
    const v = validateMessage(cleaned, "ai_output");
    if (!v.ok) {
      console.warn("[MERGE] AI returned message with unresolved fields, falling back:", v.error, "AI output:", cleaned.slice(0, 100));
      return { text: deterministic, method: "deterministic_validation_failed" };
    }

    // Length safety
    if (cleaned.length > 295) {
      console.warn(`[MERGE] AI message too long (${cleaned.length} chars). Falling back to deterministic.`);
      return { text: deterministic, method: "deterministic_too_long", aiAttempt: cleaned.slice(0, 100) };
    }

    console.log(`[MERGE] ✅ AI message generated for ${names.first || "lead"} (${cleaned.length} chars, ${hasGAContext ? "with GA" : "no GA"})`);
    return { text: cleaned, method: hasGAContext ? "ai_with_ga" : "ai_no_ga" };
  } catch (e) {
    console.error("[MERGE] AI personalization threw:", e.message, e.stack?.slice(0, 200));
    return { text: deterministic, method: "deterministic_error", error: e.message };
  }
}

// Backward-compat wrapper: returns just the string (most callers use this)
async function aiPersonalizeMessage(template, lead, signal, companyName) {
  try {
    const result = await aiPersonalizeMessageWithMeta(template, lead, signal, companyName);
    return result?.text || fillMergeFields(template, lead, signal, companyName);
  } catch (e) {
    console.error("[MERGE] aiPersonalizeMessage wrapper threw:", e.message);
    return fillMergeFields(template, lead, signal, companyName);
  }
}

// ─── REPLY INTENT CLASSIFICATION ────────────────────────────
// Takes a reply message and returns:
//   intent: interested | objection | referral | not_interested | out_of_office | auto_reply | unclear
//   urgency: high | medium | low
//   summary: 1-line summary of what they said
//   suggested_action: 1 short sentence on what to do next
//   confidence: 0-100 (how confident the classifier is)
async function classifyReplyIntent(replyText, context = {}) {
  if (!replyText || !replyText.trim()) {
    return { intent: "unclear", urgency: "low", summary: "Empty reply", suggested_action: "Wait for follow-up", confidence: 0 };
  }
  if (!OPENAI_KEY) {
    return { intent: "unclear", urgency: "low", summary: "(classifier disabled — OPENAI_API_KEY missing)", suggested_action: "Review manually", confidence: 0, error: "OPENAI_API_KEY not set" };
  }

  // Quick local heuristics for obvious cases (saves LLM cost + latency)
  const lower = replyText.toLowerCase();
  const hasOOOPattern = /(out of (the )?office|out of office|on vacation|on leave|on annual leave|away until|will be back|maternity|paternity|bereavement|holiday|automatic reply|auto[- ]?reply|out till|out from|currently out|away from my desk)/i.test(replyText);
  // Don't shortcut OOO if the reply is long — could be a real reply mentioning OOO casually
  if (hasOOOPattern && replyText.length < 600) {
    return {
      intent: "out_of_office",
      urgency: "low",
      summary: "Out of office auto-reply",
      suggested_action: "Pause sequence, retry after they're back. Check message body for return date.",
      confidence: 90,
      method: "heuristic",
    };
  }

  const openai = new OpenAI({ apiKey: OPENAI_KEY });
  const ctxLine = [];
  if (context.leadName) ctxLine.push(`Lead: ${context.leadName}`);
  if (context.leadTitle) ctxLine.push(`Title: ${context.leadTitle}`);
  if (context.leadCompany) ctxLine.push(`Company: ${context.leadCompany}`);
  if (context.priorMessage) ctxLine.push(`\nWhat WE sent them:\n${String(context.priorMessage).slice(0, 500)}`);

  try {
    const c = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      temperature: 0.1, // low temp — classification needs determinism
      max_tokens: 250,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You classify replies to outbound B2B sales messages. Return JSON only.

Categories (pick ONE for "intent"):
- "interested": expresses interest, asks a question, requests info, wants to chat / book a call
- "objection": engaging but with a concern (price, timing, fit, "send me more", "later", "not now")
- "referral": pointing you to someone else who handles this
- "not_interested": clear no, unsubscribe, "not the right person", "remove me"
- "out_of_office": auto-reply about being away (NOT a manual reply that mentions vacation in passing)
- "auto_reply": other automated replies (delivery confirmations, ticket systems, no-reply bounces)
- "unclear": neutral acknowledgment, brief reply that doesn't reveal intent, ambiguous

For "urgency":
- "high": explicit ask to talk, hot interest, time-sensitive
- "medium": questions, objections that need a response within a day
- "low": polite no, OOO, FYI replies

Return JSON: {
  "intent": "<one of above>",
  "urgency": "high|medium|low",
  "summary": "<1 sentence — what they said in their own context>",
  "suggested_action": "<1 sentence — concrete next step for the SDR>",
  "confidence": <0-100 integer — how confident you are>,
  "key_quote": "<optional: 5-15 word direct quote that drove the classification>"
}`
        },
        {
          role: "user",
          content: `${ctxLine.length > 0 ? ctxLine.join("\n") + "\n\n" : ""}=== THEIR REPLY ===\n${replyText.slice(0, 2000)}`
        },
      ],
    });

    const raw = c.choices?.[0]?.message?.content || "{}";
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch (e) {
      console.error("[CLASSIFY] JSON parse failed. Raw:", raw.slice(0, 200));
      return { intent: "unclear", urgency: "low", summary: "Classifier returned invalid JSON", suggested_action: "Review manually", confidence: 0, error: "parse_failed" };
    }

    // Validate intent value
    const validIntents = ["interested", "objection", "referral", "not_interested", "out_of_office", "auto_reply", "unclear"];
    if (!validIntents.includes(parsed.intent)) {
      console.warn(`[CLASSIFY] Got unexpected intent "${parsed.intent}", normalizing to unclear`);
      parsed.intent = "unclear";
    }
    const validUrgency = ["high", "medium", "low"];
    if (!validUrgency.includes(parsed.urgency)) parsed.urgency = "medium";

    return {
      intent: parsed.intent,
      urgency: parsed.urgency,
      summary: String(parsed.summary || "").slice(0, 200),
      suggested_action: String(parsed.suggested_action || "").slice(0, 200),
      confidence: Math.round(Math.max(0, Math.min(100, Number(parsed.confidence) || 50))),
      key_quote: parsed.key_quote ? String(parsed.key_quote).slice(0, 150) : null,
      method: "ai",
    };
  } catch (e) {
    console.error("[CLASSIFY] OpenAI call failed:", e.message);
    return { intent: "unclear", urgency: "low", summary: "Classification failed", suggested_action: "Review manually", confidence: 0, error: e.message };
  }
}

// Safely pull a string value from lead fields, never return literal braces
function safeField(value) {
  if (value === null || value === undefined) return "";
  const s = String(value).trim();
  // Strip any curly braces that leaked from user data (prevents recursion/confusion)
  return s.replace(/[{}]/g, "");
}

// Derive first/last name from Name field if dedicated fields missing
function deriveNames(f) {
  const fullName = safeField(f.Name || f["Full Name"] || "");
  const parts = fullName.split(/\s+/).filter(Boolean);
  return {
    first: safeField(f["First Name"] || f.first_name || parts[0] || ""),
    last: safeField(f["Last Name"] || f.last_name || parts.slice(1).join(" ") || ""),
    full: fullName,
  };
}

function fillMergeFields(template, lead, signal, companyName) {
  const f = lead.fields || lead;
  const names = deriveNames(f);
  const title = safeField(f.Title || f.title);
  const company = safeField(f.Company || f.company || companyName);
  const linkedin = safeField(f["LinkedIn URL"] || f.linkedin_url);
  const sig = safeField(signal);

  // Friendly fallbacks — never leave awkward blanks
  const firstOrFallback = names.first || "there";
  const nameOrFallback = names.full || firstOrFallback;

  // Handle all case/format variations: {first_name}, {firstName}, {FirstName}, {FIRST_NAME}, etc.
  // Regex is case-insensitive and accepts optional underscore or camelCase
  const REPLACERS = [
    [/\{\s*first[_\s]?name\s*\}/gi, firstOrFallback],
    [/\{\s*last[_\s]?name\s*\}/gi, names.last],
    [/\{\s*full[_\s]?name\s*\}/gi, nameOrFallback],
    [/\{\s*name\s*\}/gi, nameOrFallback],
    [/\{\s*title\s*\}/gi, title],
    [/\{\s*role\s*\}/gi, title],
    [/\{\s*company\s*\}/gi, company],
    [/\{\s*signal\s*\}/gi, sig],
    [/\{\s*linkedin(_url)?\s*\}/gi, linkedin],
  ];

  let out = String(template || "");
  for (const [re, val] of REPLACERS) out = out.replace(re, val);

  // Clean up artifacts from empty replacements
  out = out
    .replace(/\s+,/g, ",")           // "hey , how" -> "hey, how"
    .replace(/\s+\./g, ".")          // "nice . Great" -> "nice. Great"
    .replace(/\(\s*\)/g, "")         // empty parens "(your title)"
    .replace(/\[\s*\]/g, "")         // empty brackets
    .replace(/ {2,}/g, " ")          // collapse multiple spaces
    .replace(/\n{3,}/g, "\n\n")      // collapse extra newlines
    .trim();

  return out;
}

// Validate a message is safe to send — returns {ok, error}
function validateMessage(msg, context = "message") {
  if (!msg || !msg.trim()) return { ok: false, error: `${context} is empty` };

  // CRITICAL: any unreplaced merge field is a DEAL BREAKER
  const unresolvedMerge = msg.match(/\{[a-zA-Z_][a-zA-Z0-9_\s]*\}/);
  if (unresolvedMerge) {
    return { ok: false, error: `${context} contains unresolved merge field: ${unresolvedMerge[0]}. This would send literal text to the lead. Check your template and lead data.` };
  }

  // Likely template placeholders from other systems
  if (/\[\s*[A-Z_ ]+\s*\]/.test(msg) && msg.match(/\[[A-Z_ ]{3,}\]/)) {
    return { ok: false, error: `${context} contains unresolved placeholder like [NAME]. Did you mean {first_name}?` };
  }

  // LinkedIn connection note limit
  if (context === "connection_note" && msg.length > 300) {
    return { ok: false, error: `Connection note too long (${msg.length}/300 chars)` };
  }

  return { ok: true };
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

  // Defensive: manual mode with empty selection = noop, not auto fallback
  if (mode === "manual" && !selectedIds.length) {
    return { error: "No leads selected. Check the boxes next to leads you want to add.", enqueued: 0, skippedDupes: 0 };
  }

  // GLOBAL DEDUP — check ALL outreach records across ALL campaigns
  const existing = await atList(baseId, "Outreach");
  const existingLinkedIns = new Set(
    existing.map(q => (q.fields?.["LinkedIn URL"] || "").toLowerCase().trim()).filter(Boolean)
  );

  let eligible;
  let skippedDupes = 0;

  if (mode === "manual") {
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

  // Pre-flight: ensure Outreach table has all fields we'll write.
  // Airtable will return 422 Unknown field otherwise and atCreate has a retry,
  // but ensuring up-front gives a cleaner first attempt and persists the schema.
  const REQUIRED_OUTREACH_FIELDS = [
    "Lead Name", "LinkedIn URL", "Campaign", "Mode", "Status", "Company", "Title",
    "Email", "Signal", "DM Step", "Next Action Date", "Created At",
    "Connection Sent At", "Last DM Sent At", "Unipile Chat ID", "Notes",
    "Replied At", "Connection Accepted At",
  ];
  try {
    await fetch(`${process.env.VERCEL_URL ? "https://" + process.env.VERCEL_URL : "http://localhost:3000"}/api/airtable`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "ensure_fields", table: "Outreach", fieldNames: REQUIRED_OUTREACH_FIELDS, baseId }),
    }).catch(() => null);
  } catch {} // best-effort, atCreate has a retry anyway

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

  const createResult = await atCreate(baseId, "Outreach", records);
  const created = createResult.records || [];
  const createErrors = createResult.errors || [];

  const response = { enqueued: created.length, total: eligible.length, skippedDupes, mode };
  if (createErrors.length > 0 && created.length === 0) {
    response.error = `Airtable create failed: ${createErrors[0].body}`;
    response.airtableErrors = createErrors;
  } else if (createErrors.length > 0) {
    response.warning = `${createErrors.length} batch(es) failed. Partial success.`;
    response.airtableErrors = createErrors;
  }
  return response;
}

// ═══════════════════════════════════════════════════════════════
// MANUAL CONNECTIONS — send X connection requests to selected leads
// ═══════════════════════════════════════════════════════════════

async function sendManualConnections(baseId, accountId, outreachItemIds, ruleConfig) {
  const now = new Date();
  const queue = await atList(baseId, "Outreach");
  const items = queue.filter(q => outreachItemIds.includes(q.id));

  // ─── PRE-FLIGHT VALIDATION ─────────────────────────────────
  // Resolve every message FIRST. If any fails, abort the whole batch.
  // This prevents 5 good sends + 10 broken ones scenario.
  const resolved = [];
  const validationFailures = [];
  for (const item of items) {
    const f = item.fields || {};
    if (f.Status !== "queued") continue;
    if (!f["LinkedIn URL"]) continue;
    const connMsg = ruleConfig.connectionMessage
      ? await aiPersonalizeMessage(ruleConfig.connectionMessage, f, f.Signal || "", f.Company || "")
      : undefined;
    if (connMsg) {
      const v = validateMessage(connMsg, "connection_note");
      if (!v.ok) {
        validationFailures.push({ id: item.id, name: f["Lead Name"], error: v.error, preview: connMsg.slice(0, 150) });
        continue;
      }
    }
    resolved.push({ item, connMsg });
  }

  if (validationFailures.length > 0) {
    return {
      sent: 0,
      errors: 0,
      aborted: true,
      error: `Aborted: ${validationFailures.length} message${validationFailures.length!==1?"s":""} failed validation. Fix your template before sending.`,
      validationFailures,
    };
  }

  let sent = 0, errors = 0;
  const results = [];

  for (const { item, connMsg } of resolved) {
    const f = item.fields || {};
    const linkedinUrl = f["LinkedIn URL"] || "";

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

  // ─── PRE-FLIGHT VALIDATION ─────────────────────────────────
  // Resolve every DM message first. If ANY fails, abort entire batch.
  const resolved = [];
  const validationFailures = [];
  for (const item of items) {
    const f = item.fields || {};
    const dmStep = parseInt(f["DM Step"] || "0");
    if (dmStep >= sequence.length) continue; // will be marked completed
    const step = sequence[dmStep];
    if (!step || !step.message) {
      validationFailures.push({ id: item.id, name: f["Lead Name"], error: `No message defined for DM step ${dmStep + 1} in sequence`, preview: "" });
      continue;
    }
    const msg = step.aiGenerate
      ? await aiPersonalizeMessage(step.message, f, f.Signal || "", f.Company || "")
      : fillMergeFields(step.message, f, f.Signal || "", f.Company || "");
    const v = validateMessage(msg, `dm_step_${dmStep + 1}`);
    if (!v.ok) {
      validationFailures.push({ id: item.id, name: f["Lead Name"], error: v.error, preview: msg.slice(0, 150) });
      continue;
    }
    resolved.push({ item, msg, dmStep });
  }

  if (validationFailures.length > 0) {
    return {
      sent: 0,
      errors: 0,
      skippedReplied: 0,
      aborted: true,
      error: `Aborted: ${validationFailures.length} DM${validationFailures.length!==1?"s":""} failed validation. Fix your templates — see details below.`,
      validationFailures,
    };
  }

  let sent = 0, errors = 0, skippedReplied = 0;
  const results = [];

  for (const { item, msg, dmStep } of resolved) {
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

    // Test_unipile is a diagnostic — let it run even without env vars to tell user what's missing
    if (action === "test_unipile") {
      const tests = {
        dsn_set: !!UNIPILE_DSN,
        key_set: !!UNIPILE_KEY,
        dsn_value: UNIPILE_DSN ? UNIPILE_DSN.slice(0, 40) + (UNIPILE_DSN.length > 40 ? "..." : "") : "NOT SET",
        key_length: UNIPILE_KEY ? UNIPILE_KEY.length : 0,
      };
      if (!UNIPILE_DSN) return NextResponse.json({ ok: false, tests, error: "UNIPILE_DSN environment variable is not set. Add it to Vercel → Settings → Environment Variables, then redeploy." });
      if (!UNIPILE_KEY) return NextResponse.json({ ok: false, tests, error: "UNIPILE_API_KEY environment variable is not set. Add it to Vercel → Settings → Environment Variables, then redeploy." });

      // DSN format check
      if (!UNIPILE_DSN.startsWith("http")) {
        tests.dsn_format_error = "DSN should start with https://";
        return NextResponse.json({ ok: false, tests, error: "UNIPILE_DSN must be a full URL starting with https://" });
      }

      // Show the actual URL that will be called (with port→query param workaround applied)
      tests.request_url = buildUnipileUrl("/accounts");

      try {
        const listRes = await listAccounts();
        tests.canListAccounts = listRes.ok;
        tests.accountsStatus = listRes.status;
        if (!listRes.ok) {
          tests.accountsError = typeof listRes.data === "string" ? listRes.data.slice(0, 200) : JSON.stringify(listRes.data).slice(0, 200);
          let hint;
          if (listRes.fetchError) hint = "Network error — Vercel may be blocking the port. DSN was auto-rewritten to use port as query param, but the request still failed. Double-check DSN in Unipile dashboard.";
          else if (listRes.status === 401) hint = "API key is invalid — check UNIPILE_API_KEY in Vercel";
          else if (listRes.status === 404) hint = "DSN URL is wrong — check UNIPILE_DSN in Vercel dashboard";
          else hint = "Check Unipile dashboard for account status";
          return NextResponse.json({ ok: false, tests, error: `Unipile returned ${listRes.status || "network error"}`, hint });
        }
        return NextResponse.json({ ok: true, tests, message: "✅ Connection healthy" });
      } catch (e) {
        return NextResponse.json({ ok: false, tests, error: "Request failed: " + e.message, hint: "Check that UNIPILE_DSN is the correct URL" });
      }
    }

    if (!UNIPILE_DSN || !UNIPILE_KEY) {
      return NextResponse.json({ error: "UNIPILE_DSN and UNIPILE_API_KEY environment variables required. Click Test Unipile Connection for diagnostics." }, { status: 400 });
    }

    switch (action) {
      case "get_auth_link": {
        const res = await getHostedAuthLink(body.callbackUrl, body.reconnectAccountId || null);
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

      case "list_accounts": {
        const res = await listAccounts();
        return NextResponse.json(res.data);
      }

      case "save_assigned_account": {
        // Persist which LinkedIn account this campaign uses
        if (!body.campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        try {
          let res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${body.campaignId}`, {
            method: "PATCH", headers: atHdr,
            body: JSON.stringify({ fields: { "LinkedIn Account ID": body.accountId || "" } }),
          });
          // If 422 (field doesn't exist yet), create it then retry
          if (res.status === 422) {
            const errText = await res.text();
            if (errText.includes("Unknown field") || errText.includes("LinkedIn Account ID")) {
              // Create the field via Airtable Meta API
              const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE_ID}/tables`, { headers: atHdr });
              if (tablesRes.ok) {
                const { tables } = await tablesRes.json();
                const campaignsTable = (tables || []).find(t => t.name === "Campaigns");
                if (campaignsTable) {
                  await fetch(`https://api.airtable.com/v0/meta/bases/${MASTER_BASE_ID}/tables/${campaignsTable.id}/fields`, {
                    method: "POST", headers: atHdr,
                    body: JSON.stringify({ name: "LinkedIn Account ID", type: "singleLineText" }),
                  });
                  // Retry the PATCH
                  res = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${body.campaignId}`, {
                    method: "PATCH", headers: atHdr,
                    body: JSON.stringify({ fields: { "LinkedIn Account ID": body.accountId || "" } }),
                  });
                }
              }
            }
          }
          if (!res.ok) {
            const err = await res.text();
            return NextResponse.json({ error: `Airtable PATCH failed (${res.status}): ${err.slice(0, 300)}` }, { status: 400 });
          }
          return NextResponse.json({ ok: true });
        } catch (e) {
          return NextResponse.json({ error: e.message }, { status: 500 });
        }
      }

      case "get_assigned_account": {
        if (!body.campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        try {
          const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${body.campaignId}`, { headers: atHdr });
          if (!r.ok) return NextResponse.json({ accountId: "" });
          const rec = await r.json();
          return NextResponse.json({ accountId: rec.fields?.["LinkedIn Account ID"] || "" });
        } catch (e) {
          return NextResponse.json({ accountId: "", error: e.message });
        }
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

      case "preview_connection_note": {
        // Generate AI-personalized connection note for preview (doesn't send)
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        if (!body.leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
        try {
          const leadRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Leads")}/${body.leadId}`, { headers: atHdr });
          if (!leadRes.ok) return NextResponse.json({ error: `Lead not found (${leadRes.status})` }, { status: 404 });
          const leadRecord = await leadRes.json();
          const f = leadRecord.fields || {};

          // Build a rich signal string if GA context is available
          let signal = body.signal || "";
          if (!signal && (f["GA Engagement Score"] || 0) > 0) {
            const fmtT = (s) => { const n = Math.round(Number(s) || 0); if (n < 60) return n + "s"; return Math.floor(n/60) + "m"; };
            signal = `Visited our website ${f["GA Last Visit"] ? "on " + f["GA Last Visit"] : "recently"}: ${f["GA Sessions"] || 0} session${(f["GA Sessions"]||0)!==1?"s":""}, ${f["GA Views"] || 0} pageview${(f["GA Views"]||0)!==1?"s":""}, ${fmtT(f["GA Engagement Time"])} engagement.`;
          }

          // Default template if ruleConfig doesn't provide one
          const template = body.template || `Hi {first_name}, noticed you've been exploring our site — figured it's worth connecting. Happy to share what we've been working on if useful.`;

          const result = await aiPersonalizeMessageWithMeta(template, leadRecord, signal, f.Company || "");

          return NextResponse.json({
            ok: true,
            note: result.text,
            charCount: result.text.length,
            maxChars: 300,
            method: result.method, // ai_with_ga | ai_no_ga | deterministic_* — visible in UI for debugging
            error: result.error || null,
            lead: {
              name: f.Name || "",
              firstName: (f.Name || "").split(" ")[0] || "",
              title: f.Title || "",
              company: f.Company || "",
              linkedinUrl: f["LinkedIn URL"] || "",
              signal,
              gaScore: f["GA Engagement Score"] || 0,
              gaSessions: f["GA Sessions"] || 0,
              gaViews: f["GA Views"] || 0,
              gaLastVisit: f["GA Last Visit"] || "",
            },
          });
        } catch (e) {
          return NextResponse.json({ error: e.message }, { status: 500 });
        }
      }

      case "send_connection_with_note": {
        // Send a connection request with the exact note provided (from preview modal)
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        if (!body.leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
        if (!body.note || !body.note.trim()) return NextResponse.json({ error: "note required" }, { status: 400 });

        // Resolve accountId: prefer explicit, else look up from campaign record
        let resolvedAccountId = accountId;
        if (!resolvedAccountId && body.campaignId) {
          try {
            const campRes = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${body.campaignId}`, { headers: atHdr });
            if (campRes.ok) {
              const campData = await campRes.json();
              resolvedAccountId = campData?.fields?.["LinkedIn Account ID"] || "";
            }
          } catch (e) { console.error("Couldn't fetch campaign for accountId lookup:", e); }
        }
        if (!resolvedAccountId) return NextResponse.json({ error: "No LinkedIn account assigned to this campaign. Go to LinkedIn Automation → Assign account." }, { status: 400 });

        try {
          // Fetch lead
          const leadRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Leads")}/${body.leadId}`, { headers: atHdr });
          if (!leadRes.ok) return NextResponse.json({ error: `Lead not found (${leadRes.status})` }, { status: 404 });
          const leadRecord = await leadRes.json();
          const f = leadRecord.fields || {};
          const linkedinUrl = f["LinkedIn URL"] || "";
          if (!linkedinUrl) return NextResponse.json({ error: "Lead has no LinkedIn URL" }, { status: 400 });

          // Check for existing outreach record for this lead
          const queue = await atList(baseId, "Outreach");
          const existing = queue.find(q => (q.fields?.["LinkedIn URL"] || "").toLowerCase().trim() === linkedinUrl.toLowerCase().trim());
          if (existing && !["error"].includes(existing.fields?.Status)) {
            return NextResponse.json({ error: `Outreach already exists for this lead (status: ${existing.fields?.Status || "unknown"}). To resend, first clear or retry the existing record.` }, { status: 400 });
          }

          // Send invitation — sendInvitation handles profile resolution internally,
          // same as manual mode. Pass LinkedIn URL directly.
          const inviteRes = await sendInvitation(resolvedAccountId, linkedinUrl, body.note.slice(0, 300));
          if (!inviteRes.ok) {
            // Build a user-friendly error message based on Unipile's response
            const detailStr = JSON.stringify(inviteRes.data || {});
            let friendlyError = `LinkedIn rejected the request (${inviteRes.status})`;
            if (detailStr.includes("invalid_recipient") || detailStr.includes("cannot be reached")) {
              friendlyError = `LinkedIn won't let this connection go through. Common reasons:\n\n• The person has strict connection settings (requires email to connect)\n• You're a 3rd-degree or out-of-network connection and LinkedIn needs extra verification\n• Daily connection limit hit on this LinkedIn account\n• The profile is locked/deactivated\n• The LinkedIn URL on this lead may be outdated\n\nTry connecting directly on LinkedIn, or use Send Email instead if available.`;
            } else if (detailStr.includes("rate_limit") || detailStr.includes("too_many")) {
              friendlyError = `LinkedIn rate limit hit. Wait a few hours and try again, or reduce your connection volume.`;
            } else if (detailStr.includes("already_connected") || detailStr.includes("already_invited")) {
              friendlyError = `You've already connected with or invited this person previously.`;
            } else {
              friendlyError += `: ${detailStr.slice(0, 250)}`;
            }
            return NextResponse.json({ error: friendlyError, raw: inviteRes.data }, { status: 400 });
          }

          // Record in Outreach table
          const nowISO = new Date().toISOString();
          const outreachFields = {
            "Lead Name": f.Name || "",
            "LinkedIn URL": linkedinUrl,
            Campaign: body.campaignName || "",
            Mode: "quick_send_ga",
            Status: "connection_sent",
            Company: f.Company || "",
            Title: f.Title || "",
            Email: f.Email || "",
            Signal: body.signal || "",
            "DM Step": 0,
            "Created At": nowISO,
            "Connection Sent At": nowISO,
            Notes: "Sent via GA engaged leads quick-send. Note: " + body.note.slice(0, 200),
          };
          if (existing) {
            // Update existing (was in error state)
            await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}/${existing.id}`, {
              method: "PATCH", headers: atHdr,
              body: JSON.stringify({ fields: outreachFields }),
            });
          } else {
            await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}`, {
              method: "POST", headers: atHdr,
              body: JSON.stringify({ records: [{ fields: outreachFields }] }),
            });
          }

          return NextResponse.json({ ok: true, sent: 1, leadName: f.Name || "" });
        } catch (e) {
          console.error("[outreach] send_connection_with_note error:", e);
          return NextResponse.json({ error: e.message }, { status: 500 });
        }
      }

      case "quick_send_connection": {
        // One-click: enqueue this specific lead + send connection request immediately
        // Used from the GA Engaged Leads UI
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        if (!body.leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
        if (!accountId) return NextResponse.json({ error: "accountId required (assign a LinkedIn account to this campaign first)" }, { status: 400 });

        // Step 1: enqueue this single lead
        const enqueueOptions = { mode: "manual", selectedIds: [body.leadId], count: 1 };
        const enqueueResult = await enqueueLeads(baseId, body.ruleConfig || {}, enqueueOptions);
        if (enqueueResult.error) return NextResponse.json({ error: `Enqueue failed: ${enqueueResult.error}` }, { status: 400 });

        // Find the newly created outreach record for this lead
        const queue = await atList(baseId, "Outreach");
        const leadRecord = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Leads")}/${body.leadId}`, { headers: atHdr }).then(r => r.json()).catch(() => null);
        if (!leadRecord?.fields) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
        const leadLinkedIn = (leadRecord.fields["LinkedIn URL"] || "").toLowerCase().trim();
        const outreachItem = queue.find(q =>
          (q.fields?.["LinkedIn URL"] || "").toLowerCase().trim() === leadLinkedIn &&
          (q.fields?.Status || "") === "queued"
        );
        if (!outreachItem) return NextResponse.json({ error: "Could not find queued outreach item — might already be in a different state" }, { status: 400 });

        // Step 2: send the connection immediately
        const sendResult = await sendManualConnections(baseId, accountId, [outreachItem.id], body.ruleConfig || {});
        return NextResponse.json({ ok: true, sent: sendResult.sent || 0, failed: sendResult.failed || 0, result: sendResult });
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
        const classifyEnabled = body.classify !== false; // default ON
        for (const item of items) {
          const f = item.fields || {};
          const chatId = f["Unipile Chat ID"];
          // Fetch messages so we can both detect reply AND classify the latest one in one call
          const msgRes = await getChatMessages(chatId, accountId);
          if (!msgRes.ok) {
            console.warn(`[check_replies] Couldn't fetch messages for chat ${chatId}`);
            await new Promise(r => setTimeout(r, 300));
            continue;
          }
          const messages = msgRes.data?.items || msgRes.data?.messages || [];
          // Find latest message from THEM (is_sender = false/0 means from lead)
          const theirMessages = messages.filter(m => m.is_sender === false || m.is_sender === 0);
          if (theirMessages.length === 0) {
            await new Promise(r => setTimeout(r, 300));
            continue;
          }
          // Their latest reply text
          const latestReply = theirMessages[theirMessages.length - 1];
          const replyText = latestReply?.text || latestReply?.body || latestReply?.content || "";
          // What we sent them last (most recent OUR message)
          const ourMessages = messages.filter(m => m.is_sender === true || m.is_sender === 1);
          const priorMessage = ourMessages.length > 0 ? (ourMessages[ourMessages.length - 1]?.text || ourMessages[ourMessages.length - 1]?.body || "") : "";

          // Classify
          let classification = null;
          if (classifyEnabled && replyText.trim()) {
            classification = await classifyReplyIntent(replyText, {
              leadName: f.Name || "",
              leadTitle: f.Title || "",
              leadCompany: f.Company || "",
              priorMessage,
            });
          }

          // Build the Airtable update — include classification fields if we got them
          const updateFields = {
            Status: "replied",
            "Replied At": new Date().toISOString(),
            "Next Action Date": "",
            Notes: classification
              ? `Lead replied [${classification.intent} · ${classification.urgency}]: ${classification.summary}`
              : "Lead replied — DM sequence stopped",
          };
          if (classification) {
            updateFields["Reply Intent"] = classification.intent;
            updateFields["Reply Urgency"] = classification.urgency;
            updateFields["Reply Summary"] = classification.summary;
            updateFields["Reply Suggested Action"] = classification.suggested_action;
            updateFields["Reply Confidence"] = classification.confidence;
            if (replyText) updateFields["Reply Text"] = replyText.slice(0, 5000);
          }

          // Auto-create missing fields on first 422
          // We do the fetch directly here (not via atUpdate helper) so we can read error text
          const tryUpdate = async (attempt = 0) => {
            if (attempt > 6) {
              console.error("[check_replies] Max retries exceeded");
              return false;
            }
            const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}`, {
              method: "PATCH", headers: atHdr,
              body: JSON.stringify({ records: [{ id: item.id, fields: updateFields }] }),
            });
            if (r.ok) return true;
            const errText = await r.text();
            if (errText.includes("UNKNOWN_FIELD_NAME") || errText.includes("INVALID_VALUE_FOR_COLUMN")) {
              const m = errText.match(/[Uu]nknown field name:?\s+\\?"([^"\\]+)\\?"/) || errText.match(/Field\s+\\?"([^"\\]+)\\?"/);
              const badField = m ? m[1] : null;
              if (badField) {
                console.log(`[check_replies] Missing field "${badField}", attempting auto-create...`);
                let fieldCreated = false;
                try {
                  const tablesRes = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables`, { headers: atHdr });
                  if (tablesRes.ok) {
                    const { tables } = await tablesRes.json();
                    const t = tables.find(t => t.name === "Outreach");
                    if (t) {
                      const fieldType = badField === "Reply Confidence" ? "number" : "singleLineText";
                      const createBody = { name: badField, type: fieldType };
                      if (fieldType === "number") createBody.options = { precision: 0 };
                      const cr = await fetch(`https://api.airtable.com/v0/meta/bases/${baseId}/tables/${t.id}/fields`, {
                        method: "POST", headers: atHdr, body: JSON.stringify(createBody),
                      });
                      if (cr.ok) {
                        console.log(`[check_replies] Created field "${badField}". Waiting 1.5s for propagation...`);
                        fieldCreated = true;
                        await new Promise(r => setTimeout(r, 1500));
                      } else {
                        const cre = await cr.text();
                        console.warn(`[check_replies] Field create returned ${cr.status}: ${cre.slice(0, 150)}`);
                      }
                    } else {
                      console.warn(`[check_replies] Outreach table not found in base meta`);
                    }
                  } else {
                    console.warn(`[check_replies] Couldn't fetch base tables: ${tablesRes.status}`);
                  }
                } catch (createErr) {
                  console.error("[check_replies] Field create exception:", createErr.message);
                }
                if (!fieldCreated) {
                  // Strip the bad field and retry without it (preserves the rest of the data)
                  console.log(`[check_replies] Stripping field "${badField}" from update`);
                  delete updateFields[badField];
                }
                return tryUpdate(attempt + 1);
              }
            }
            console.error(`[check_replies] Airtable update failed (status ${r.status}):`, errText.slice(0, 200));
            return false;
          };
          await tryUpdate();

          repliesFound++;
          replied.push({
            name: f.Name || f["LinkedIn URL"] || item.id,
            intent: classification?.intent || null,
            urgency: classification?.urgency || null,
            summary: classification?.summary || null,
          });
          await new Promise(r => setTimeout(r, 300)); // rate limit
        }
        return NextResponse.json({ checked: items.length, repliesFound, replied });
      }

      // Standalone: classify a single reply on demand (no Airtable side effects)
      // Useful for: pasting a manually-received reply, classifying email replies from Smartlead webhook, debugging
      case "classify_reply_text": {
        const { replyText, leadName, leadTitle, leadCompany, priorMessage } = body;
        if (!replyText) return NextResponse.json({ error: "replyText required" }, { status: 400 });
        const result = await classifyReplyIntent(replyText, { leadName, leadTitle, leadCompany, priorMessage });
        return NextResponse.json({ ok: true, ...result });
      }

      // Re-classify a stored Outreach record's reply (without re-fetching from LinkedIn)
      case "reclassify_reply": {
        if (!baseId || !body.outreachId) return NextResponse.json({ error: "baseId and outreachId required" }, { status: 400 });
        const recRes = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Outreach")}/${body.outreachId}`, { headers: atHdr });
        if (!recRes.ok) return NextResponse.json({ error: `Outreach record not found (${recRes.status})` }, { status: 404 });
        const rec = await recRes.json();
        const f = rec.fields || {};
        const replyText = f["Reply Text"] || body.replyText || "";
        if (!replyText) return NextResponse.json({ error: "No reply text on record. Pass replyText in body, or run check_replies to fetch from LinkedIn." }, { status: 400 });
        const classification = await classifyReplyIntent(replyText, {
          leadName: f.Name || "",
          leadTitle: f.Title || "",
          leadCompany: f.Company || "",
          priorMessage: body.priorMessage || "",
        });
        try {
          await atUpdate(baseId, "Outreach", [{ id: body.outreachId, fields: {
            "Reply Intent": classification.intent,
            "Reply Urgency": classification.urgency,
            "Reply Summary": classification.summary,
            "Reply Suggested Action": classification.suggested_action,
            "Reply Confidence": classification.confidence,
          }}]);
        } catch (e) {
          return NextResponse.json({ ok: true, classification, warning: "Classification done but Airtable write failed: " + e.message });
        }
        return NextResponse.json({ ok: true, classification });
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
        const validation = validateMessage(msg, body.context || "message");
        return NextResponse.json({ message: msg, valid: validation.ok, validationError: validation.error || null });
      }

      case "preview_batch": {
        // Preview messages for multiple leads at once — catch broken templates BEFORE sending
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const template = body.template || "";
        const leadIds = body.leadIds || [];
        const outreachItemIds = body.outreachItemIds || [];
        const context = body.context || "message";
        const signal = body.signal || "";

        // Load source data
        let source = [];
        if (leadIds.length) {
          const allLeads = await atList(baseId, "Leads");
          source = allLeads.filter(l => leadIds.includes(l.id));
        } else if (outreachItemIds.length) {
          const allQueue = await atList(baseId, "Outreach");
          source = allQueue.filter(q => outreachItemIds.includes(q.id)).map(q => ({ id: q.id, fields: { Name: q.fields?.["Lead Name"], "First Name": (q.fields?.["Lead Name"] || "").split(" ")[0], Title: q.fields?.Title, Company: q.fields?.Company } }));
        }

        const previews = [];
        let issues = 0;
        for (const lead of source.slice(0, 100)) {
          const msg = body.aiGenerate
            ? await aiPersonalizeMessage(template, lead, signal, lead.fields?.Company || "")
            : fillMergeFields(template, lead, signal, lead.fields?.Company || "");
          const v = validateMessage(msg, context);
          if (!v.ok) issues++;
          previews.push({ leadId: lead.id, name: lead.fields?.Name, message: msg, valid: v.ok, error: v.error });
        }
        return NextResponse.json({ previews, issues, total: previews.length });
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("Outreach API error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
