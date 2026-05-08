import { NextResponse } from "next/server";
import OpenAI from "openai";
import { trackOpenAIUsage } from "@/lib/ai-usage";

let _openai;
function getOpenAI() { if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }

const HS = "https://api.hubapi.com";
const AT_API = "https://api.airtable.com/v0";
const AT_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE = process.env.AIRTABLE_BASE_ID;
const atHdr = { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" };
function hh(k) { return { Authorization: `Bearer ${k}`, "Content-Type": "application/json" }; }

async function getHsKey(cid) {
  if (!cid || !MASTER_BASE) return null;
  try { const r = await fetch(`${AT_API}/${MASTER_BASE}/Campaigns/${cid}`, { headers: atHdr }); if (!r.ok) return null; return (await r.json()).fields?.["HubSpot API Key"] || null; } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// HUBSPOT DATA FETCHERS
// ═══════════════════════════════════════════════════════════════

async function getPipelines(k) {
  const r = await fetch(`${HS}/crm/v3/pipelines/deals`, { headers: hh(k) });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.results || []).map(p => ({
    id: p.id, label: p.label,
    stages: (p.stages || []).sort((a, b) => a.displayOrder - b.displayOrder).map(s => ({ id: s.id, label: s.label })),
  }));
}

async function getDealsAtStage(k, stageId, limit = 200) {
  const all = []; let after = 0;
  while (all.length < limit) {
    const r = await fetch(`${HS}/crm/v3/objects/deals/search`, {
      method: "POST", headers: hh(k),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "dealstage", operator: "EQ", value: stageId }] }],
        properties: ["dealname", "dealstage", "amount", "pipeline", "closedate", "hubspot_owner_id", "hs_lastmodifieddate", "createdate"],
        limit: 100, after,
      }),
    });
    if (!r.ok) break;
    const d = await r.json();
    all.push(...(d.results || []));
    if (!d.paging?.next?.after) break;
    after = d.paging.next.after;
  }
  return all;
}

async function getDealContacts(k, dealId) {
  try {
    const r = await fetch(`${HS}/crm/v4/objects/deals/${dealId}/associations/contacts`, { headers: hh(k) });
    if (!r.ok) return [];
    const d = await r.json();
    const ids = (d.results || []).map(a => a.toObjectId).filter(Boolean);
    if (!ids.length) return [];
    // Fetch contact details
    const contacts = [];
    for (const id of ids.slice(0, 5)) {
      const cr = await fetch(`${HS}/crm/v3/objects/contacts/${id}?properties=firstname,lastname,email,phone,company,jobtitle,lifecyclestage,hs_lead_status,hs_linkedinid,city,state,country,notes_last_updated,num_associated_deals,hs_analytics_num_page_views,hs_email_last_open_date,hs_analytics_source`, { headers: hh(k) });
      if (cr.ok) contacts.push(await cr.json());
    }
    return contacts;
  } catch { return []; }
}

// ─── Full engagement timeline for a contact ──────────────────
async function getContactTimeline(k, contactId) {
  const timeline = [];

  // Emails
  try {
    const r = await fetch(`${HS}/crm/v4/objects/contacts/${contactId}/associations/emails`, { headers: hh(k) });
    if (r.ok) { const d = await r.json(); const ids = (d.results || []).map(a => a.toObjectId).slice(0, 10);
      for (const id of ids) {
        const er = await fetch(`${HS}/crm/v3/objects/emails/${id}?properties=hs_email_subject,hs_email_direction,hs_email_status,hs_timestamp`, { headers: hh(k) });
        if (er.ok) { const e = await er.json(); timeline.push({ type: "email", subject: e.properties?.hs_email_subject || "", direction: e.properties?.hs_email_direction || "", status: e.properties?.hs_email_status || "", date: e.properties?.hs_timestamp || "" }); }
      }
    }
  } catch {}

  // Meetings
  try {
    const r = await fetch(`${HS}/crm/v4/objects/contacts/${contactId}/associations/meetings`, { headers: hh(k) });
    if (r.ok) { const d = await r.json(); const ids = (d.results || []).map(a => a.toObjectId).slice(0, 5);
      for (const id of ids) {
        const mr = await fetch(`${HS}/crm/v3/objects/meetings/${id}?properties=hs_meeting_title,hs_meeting_outcome,hs_timestamp,hs_meeting_start_time`, { headers: hh(k) });
        if (mr.ok) { const m = await mr.json(); timeline.push({ type: "meeting", title: m.properties?.hs_meeting_title || "", outcome: m.properties?.hs_meeting_outcome || "", date: m.properties?.hs_timestamp || m.properties?.hs_meeting_start_time || "" }); }
      }
    }
  } catch {}

  // Calls
  try {
    const r = await fetch(`${HS}/crm/v4/objects/contacts/${contactId}/associations/calls`, { headers: hh(k) });
    if (r.ok) { const d = await r.json(); const ids = (d.results || []).map(a => a.toObjectId).slice(0, 5);
      for (const id of ids) {
        const cr = await fetch(`${HS}/crm/v3/objects/calls/${id}?properties=hs_call_title,hs_call_disposition,hs_call_duration,hs_timestamp`, { headers: hh(k) });
        if (cr.ok) { const c = await cr.json(); timeline.push({ type: "call", title: c.properties?.hs_call_title || "", disposition: c.properties?.hs_call_disposition || "", duration: c.properties?.hs_call_duration || "", date: c.properties?.hs_timestamp || "" }); }
      }
    }
  } catch {}

  // Notes
  try {
    const r = await fetch(`${HS}/crm/v4/objects/contacts/${contactId}/associations/notes`, { headers: hh(k) });
    if (r.ok) { const d = await r.json(); const ids = (d.results || []).map(a => a.toObjectId).slice(0, 5);
      for (const id of ids) {
        const nr = await fetch(`${HS}/crm/v3/objects/notes/${id}?properties=hs_note_body,hs_timestamp`, { headers: hh(k) });
        if (nr.ok) { const n = await nr.json(); timeline.push({ type: "note", body: (n.properties?.hs_note_body || "").slice(0, 200), date: n.properties?.hs_timestamp || "" }); }
      }
    }
  } catch {}

  return timeline.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// ─── Get conversion patterns from won deals ─────────────────
async function getConversionPatterns(k) {
  try {
    const r = await fetch(`${HS}/crm/v3/objects/deals/search`, {
      method: "POST", headers: hh(k),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName: "dealstage", operator: "EQ", value: "closedwon" }] }],
        properties: ["dealname", "amount", "closedate", "createdate", "hs_time_in_closedwon"],
        limit: 20, sorts: [{ propertyName: "closedate", direction: "DESCENDING" }],
      }),
    });
    if (!r.ok) return "No conversion data available";
    const d = await r.json();
    const won = d.results || [];
    if (!won.length) return "No closed-won deals found to analyze patterns";

    // Get contacts from a few won deals for pattern analysis
    const patterns = [];
    for (const deal of won.slice(0, 5)) {
      const contacts = await getDealContacts(k, deal.id);
      if (contacts.length > 0) {
        const c = contacts[0].properties || {};
        const timeline = await getContactTimeline(k, contacts[0].id);
        patterns.push({
          deal: deal.properties?.dealname || "",
          amount: deal.properties?.amount || "",
          daysToClose: deal.properties?.createdate && deal.properties?.closedate
            ? Math.round((new Date(deal.properties.closedate) - new Date(deal.properties.createdate)) / 86400000)
            : "?",
          contactTitle: c.jobtitle || "",
          source: c.hs_analytics_source || "",
          emailCount: timeline.filter(t => t.type === "email").length,
          meetingCount: timeline.filter(t => t.type === "meeting").length,
          callCount: timeline.filter(t => t.type === "call").length,
        });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    if (!patterns.length) return "Won deals found but no contact patterns available";
    return patterns.map(p =>
      `${p.deal}: ${p.contactTitle}, ${p.daysToClose} days to close, ${p.emailCount} emails, ${p.meetingCount} meetings, ${p.callCount} calls, amount: ${p.amount || "?"}, source: ${p.source}`
    ).join("\n");
  } catch (e) {
    return "Could not fetch conversion patterns: " + e.message;
  }
}

// ═══════════════════════════════════════════════════════════════
// AI TASK GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateTasks(contact, deal, timeline, conversionPatterns, rule, campaignId = null) {
  const openai = getOpenAI();
  const p = contact.properties || {};
  const dp = deal.properties || {};

  const contactInfo = `Name: ${p.firstname || ""} ${p.lastname || ""}\nEmail: ${p.email || ""}\nPhone: ${p.phone || ""}\nTitle: ${p.jobtitle || ""}\nCompany: ${p.company || ""}\nLinkedIn: ${p.hs_linkedinid || ""}\nLifecycle: ${p.lifecyclestage || ""}\nLead Status: ${p.hs_lead_status || ""}\nSource: ${p.hs_analytics_source || ""}\nPage Views: ${p.hs_analytics_num_page_views || 0}`;

  const dealInfo = `Deal: ${dp.dealname || "?"}\nStage: ${dp.dealstage || "?"}\nAmount: ${dp.amount || "?"}\nCreated: ${dp.createdate || "?"}\nOwner: ${dp.hubspot_owner_id || "unassigned"}`;

  const timelineSummary = timeline.length > 0
    ? timeline.slice(0, 15).map(t => {
        if (t.type === "email") return `[Email] ${t.direction}: "${t.subject}" (${t.date?.slice(0, 10)})`;
        if (t.type === "meeting") return `[Meeting] "${t.title}" outcome: ${t.outcome} (${t.date?.slice(0, 10)})`;
        if (t.type === "call") return `[Call] "${t.title}" ${t.disposition} ${t.duration}s (${t.date?.slice(0, 10)})`;
        if (t.type === "note") return `[Note] ${t.body?.slice(0, 80)} (${t.date?.slice(0, 10)})`;
        return `[${t.type}] ${t.date?.slice(0, 10)}`;
      }).join("\n")
    : "No engagement history found";

  const prompt = rule.aiPrompt || "Create follow-up tasks based on this contact's full HubSpot history and what worked for similar converted deals.";

  try {
    const c = await openai.chat.completions.create({
      model: "gpt-5.4-mini", temperature: 0.3, max_completion_tokens: 1200,
      messages: [
        { role: "system", content: `You are an expert SDR task engine. You have access to a contact's FULL HubSpot history (emails, meetings, calls, notes) plus patterns from successfully converted deals.

Generate 1-3 specific, actionable follow-up tasks. Each task must reference actual data from the contact's history or conversion patterns.

Return ONLY JSON: [{"subject":"max 10 words","action":"specific next step, max 40 words, reference actual history","priority":"HIGH|MEDIUM|LOW","reason":"why this matters based on data, max 25 words","channel":"email|phone|linkedin|meeting","timing":"today|tomorrow|this_week|next_week"}]

Rules:
- Reference SPECIFIC emails/meetings/calls from their history
- If they had a meeting → reference its outcome
- If they opened emails → reference which topics they engaged with
- Compare their engagement to conversion patterns (e.g. "converted deals averaged 3 meetings, this contact has had 1")
- If phone exists → include a call task
- Timing should be concrete based on deal urgency` },
        { role: "user", content: `SDR Instructions:\n${prompt}\n\n── CONTACT ──\n${contactInfo}\n\n── DEAL ──\n${dealInfo}\n\n── ENGAGEMENT HISTORY ──\n${timelineSummary}\n\n── CONVERSION PATTERNS (what worked for won deals) ──\n${conversionPatterns}` },
      ],
    });
    trackOpenAIUsage({ campaignId, completion: c, action: "post_demo_generate_tasks" });
    const text = c.choices[0]?.message?.content || "[]";
    try { return JSON.parse(text.replace(/```json\n?|```/g, "").trim()); }
    catch { const m = text.match(/\[[\s\S]*?\]/); return m ? JSON.parse(m[0]) : []; }
  } catch (e) {
    return [{ subject: "Follow up with " + (p.firstname || "contact"), action: "Review HubSpot history and reach out", priority: "MEDIUM", reason: "AI unavailable", channel: "email", timing: "today" }];
  }
}

// ═══════════════════════════════════════════════════════════════
// PROCESS: find deals at stage → get contacts → get history → AI
// ═══════════════════════════════════════════════════════════════

async function processRule(k, baseId, rule, campaignId = null) {
  const { stageId, stageName } = rule;
  console.log(`[POST-DEMO] Trigger: deals at stage "${stageName}" (${stageId})`);

  const deals = await getDealsAtStage(k, stageId);
  console.log(`[POST-DEMO] ${deals.length} deals at this stage`);
  if (!deals.length) return { deals: 0, contacts: 0, tasksCreated: 0, results: [] };

  // Check already-processed contacts
  let processedNames = new Set();
  if (baseId) {
    try {
      let all = [], offset = null;
      do {
        const url = `${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?${offset ? "offset=" + offset : ""}`;
        const r = await fetch(url, { headers: atHdr }); if (!r.ok) break;
        const d = await r.json(); all.push(...(d.records || [])); offset = d.offset;
      } while (offset);
      processedNames = new Set(all.filter(t => (t.fields || {})["Task Type"] === "post_demo").map(t => ((t.fields || {})["Lead Name"] || "").toLowerCase().trim()));
    } catch {}
  }

  // Get conversion patterns once (reuse for all contacts)
  console.log(`[POST-DEMO] Fetching conversion patterns...`);
  const conversionPatterns = await getConversionPatterns(k);

  const allResults = [];
  const newTasks = [];

  for (const deal of deals) {
    const contacts = await getDealContacts(k, deal.id);
    if (!contacts.length) continue;

    for (const contact of contacts) {
      const p = contact.properties || {};
      const name = `${p.firstname || ""} ${p.lastname || ""}`.trim();
      if (!name || processedNames.has(name.toLowerCase())) continue;
      processedNames.add(name.toLowerCase()); // prevent within-run dupes

      console.log(`[POST-DEMO] Processing: ${name} (${p.company || "?"})`);
      const timeline = await getContactTimeline(k, contact.id);
      const followUps = await generateTasks(contact, deal, timeline, conversionPatterns, rule, campaignId);

      for (const task of followUps) {
        newTasks.push({
          Company: p.company || "",
          "Task Rule": rule.name || "Post-Demo",
          Score: task.priority === "HIGH" ? 90 : task.priority === "MEDIUM" ? 70 : 50,
          "Scan Target": "leads",
          Signal: `${task.subject}: ${task.action}`,
          Source: `Post-Demo (${task.channel}) — ${task.timing || ""}`,
          "Task Type": "post_demo",
          Date: new Date().toISOString().slice(0, 10),
          Created: new Date().toISOString(),
          "Lead Name": name,
          Phone: p.phone || "",
          Email: p.email || "",
        });
      }

      allResults.push({
        lead: name, company: p.company || "", title: p.jobtitle || "", email: p.email || "",
        deal: deal.properties?.dealname || "",
        dealAmount: deal.properties?.amount || "",
        engagementSummary: `${timeline.filter(t=>t.type==="email").length} emails, ${timeline.filter(t=>t.type==="meeting").length} meetings, ${timeline.filter(t=>t.type==="call").length} calls`,
        tasks: followUps,
      });

      await new Promise(r => setTimeout(r, 400));
    }
  }

  // Save to Airtable
  let created = 0;
  if (newTasks.length > 0 && baseId) {
    for (let i = 0; i < newTasks.length; i += 10) {
      const batch = newTasks.slice(i, i + 10).map(t => ({ fields: t }));
      try {
        const r = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}`, {
          method: "POST", headers: atHdr, body: JSON.stringify({ records: batch, typecast: true }),
        });
        if (r.ok) { const d = await r.json(); created += (d.records || []).length; }
      } catch {}
    }
  }

  return { deals: deals.length, contacts: allResults.length, tasksCreated: created, results: allResults };
}

// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    // SECURITY: Block from /client/[id] pages. Uses HubSpot API keys.
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) {
      console.warn(`[SECURITY] post-demo blocked from client referer: ${referer}`);
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }
    const body = await request.json();
    const { action, campaignId, baseId } = body;
    const k = body.apiKey || await getHsKey(campaignId);
    if (!k) return NextResponse.json({ error: "HubSpot not connected. Go to the HubSpot tab first." }, { status: 400 });

    switch (action) {
      case "get_pipelines": {
        const pipelines = await getPipelines(k);
        return NextResponse.json({ pipelines });
      }

      case "get_stage_deals": {
        const { stageId } = body;
        if (!stageId) return NextResponse.json({ error: "stageId required" }, { status: 400 });
        const deals = await getDealsAtStage(k, stageId, 10);
        // Get contacts for preview
        const previews = [];
        for (const deal of deals.slice(0, 5)) {
          const contacts = await getDealContacts(k, deal.id);
          for (const c of contacts) {
            const p = c.properties || {};
            previews.push({ name: `${p.firstname || ""} ${p.lastname || ""}`.trim(), company: p.company || "", email: p.email || "", title: p.jobtitle || "", deal: deal.properties?.dealname || "" });
          }
        }
        return NextResponse.json({ totalDeals: deals.length, previews: previews.slice(0, 10) });
      }

      case "run": {
        if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
        const result = await processRule(k, baseId, body.rule, campaignId);
        return NextResponse.json(result);
      }

      default:
        return NextResponse.json({ error: "Unknown action" }, { status: 400 });
    }
  } catch (error) {
    console.error("[POST-DEMO] Error:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
