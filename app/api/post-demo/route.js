import { NextResponse } from "next/server";
import OpenAI from "openai";

let _openai;
function getOpenAI() { if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }

const HS_API = "https://api.hubapi.com";
const AT_API = "https://api.airtable.com/v0";
const AT_KEY = process.env.AIRTABLE_API_KEY;
const MASTER_BASE = process.env.AIRTABLE_BASE_ID;
const atHdr = { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" };

function hsHdr(key) { return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }; }

// ─── Get stored HubSpot key from Airtable campaign ──────────
async function getHsKey(campaignId) {
  if (!campaignId || !MASTER_BASE) return null;
  try {
    const res = await fetch(`${AT_API}/${MASTER_BASE}/Campaigns/${campaignId}`, { headers: atHdr });
    if (!res.ok) return null;
    const { fields } = await res.json();
    return fields?.["HubSpot API Key"] || null;
  } catch { return null; }
}

// ─── HubSpot: Get contact properties (fields + options) ─────
async function getContactProperties(apiKey) {
  const res = await fetch(`${HS_API}/crm/v3/properties/contacts`, { headers: hsHdr(apiKey) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).filter(p => !p.hidden && !p.calculated).map(p => ({
    name: p.name,
    label: p.label,
    type: p.type,
    fieldType: p.fieldType,
    options: (p.options || []).map(o => ({ label: o.label, value: o.value })),
    groupName: p.groupName,
  }));
}

// ─── HubSpot: Get deal pipelines + stages ───────────────────
async function getDealPipelines(apiKey) {
  const res = await fetch(`${HS_API}/crm/v3/pipelines/deals`, { headers: hsHdr(apiKey) });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.results || []).map(p => ({
    id: p.id, label: p.label,
    stages: (p.stages || []).map(s => ({ id: s.id, label: s.label, displayOrder: s.displayOrder })).sort((a, b) => a.displayOrder - b.displayOrder),
  }));
}

// ─── HubSpot: Search contacts by property value ─────────────
async function searchContacts(apiKey, field, operator, value, limit = 100) {
  const filterMap = {
    "equals": "EQ",
    "contains": "CONTAINS_TOKEN",
    "not_empty": "HAS_PROPERTY",
    "greater_than": "GT",
    "less_than": "LT",
  };
  const hsOp = filterMap[operator] || "EQ";

  const filter = { propertyName: field, operator: hsOp };
  if (operator !== "not_empty") filter.value = value;

  const allContacts = [];
  let after = 0;

  // Paginate to get all matching contacts
  while (allContacts.length < 500) { // cap at 500
    const body = {
      filterGroups: [{ filters: [filter] }],
      properties: ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage",
        "hs_lead_status", "hubspot_owner_id", "hs_linkedinid", "notes_last_updated",
        "num_associated_deals", "hs_analytics_num_page_views", "hs_email_last_open_date",
        "hs_analytics_source", "city", "state", "country", field],
      limit: Math.min(limit, 100),
      after,
    };

    const res = await fetch(`${HS_API}/crm/v3/objects/contacts/search`, {
      method: "POST", headers: hsHdr(apiKey), body: JSON.stringify(body),
    });
    if (!res.ok) break;
    const data = await res.json();
    allContacts.push(...(data.results || []));
    if (!data.paging?.next?.after) break;
    after = data.paging.next.after;
  }

  return allContacts;
}

// ─── HubSpot: Get engagement history for a contact ──────────
async function getEngagements(apiKey, contactId) {
  try {
    // Get recent activities
    const res = await fetch(`${HS_API}/crm/v3/objects/contacts/${contactId}/associations/engagements?limit=20`, { headers: hsHdr(apiKey) });
    if (!res.ok) return [];
    const data = await res.json();
    return data.results || [];
  } catch { return []; }
}

// ─── HubSpot: Get deals for a contact ───────────────────────
async function getDeals(apiKey, contactId) {
  try {
    const res = await fetch(`${HS_API}/crm/v3/objects/contacts/${contactId}/associations/deals?limit=10`, { headers: hsHdr(apiKey) });
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.results?.length) return [];

    // Fetch deal details
    const dealIds = data.results.map(r => r.id || r.toObjectId).filter(Boolean).slice(0, 5);
    const deals = [];
    for (const id of dealIds) {
      const dr = await fetch(`${HS_API}/crm/v3/objects/deals/${id}?properties=dealname,dealstage,amount,pipeline,closedate,hs_lastmodifieddate`, { headers: hsHdr(apiKey) });
      if (dr.ok) deals.push(await dr.json());
    }
    return deals;
  } catch { return []; }
}

// ─── AI: Generate follow-up tasks ────────────────────────────
async function generateTasks(contact, deals, rule) {
  const openai = getOpenAI();
  const p = contact.properties || {};

  const contactSummary = Object.entries(p)
    .filter(([_, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 120)}`)
    .join("\n");

  const dealSummary = deals.length > 0
    ? deals.map(d => `Deal: ${d.properties?.dealname || "?"} | Stage: ${d.properties?.dealstage || "?"} | Amount: ${d.properties?.amount || "?"} | Close: ${d.properties?.closedate || "?"}`).join("\n")
    : "No deals associated";

  const prompt = rule.aiPrompt || "Based on this contact's HubSpot data and deal history, create specific follow-up tasks for the SDR.";

  try {
    const c = await openai.chat.completions.create({
      model: "gpt-5.4-mini", temperature: 0.3, max_tokens: 1000,
      messages: [
        { role: "system", content: `You generate SDR follow-up tasks based on HubSpot contact data. Return ONLY JSON array:
[{"subject":"max 10 words","action":"specific action max 30 words","priority":"HIGH|MEDIUM|LOW","reason":"why, max 20 words","channel":"email|phone|linkedin|meeting"}]
Rules: 1-3 tasks max. Reference specific data. If phone exists → call task. If LinkedIn exists → engagement task. Order by priority. No generic tasks.` },
        { role: "user", content: `Instructions:\n${prompt}\n\nContact:\n${contactSummary}\n\nDeals:\n${dealSummary}\n\nTrigger: "${rule.triggerField}" = "${p[rule.triggerField] || ""}"` },
      ],
    });
    const text = c.choices[0]?.message?.content || "[]";
    try { return JSON.parse(text.replace(/```json\n?|```/g, "").trim()); }
    catch { const m = text.match(/\[[\s\S]*?\]/); return m ? JSON.parse(m[0]) : []; }
  } catch (e) {
    console.error("[POST-DEMO] AI error:", e.message);
    return [{ subject: "Follow up with " + (p.firstname || "contact"), action: "Review and reach out", priority: "MEDIUM", reason: "AI unavailable", channel: "email" }];
  }
}

// ─── Process rule ────────────────────────────────────────────
async function processRule(apiKey, baseId, rule) {
  console.log(`[POST-DEMO] Running: ${rule.triggerField} ${rule.triggerOperator} "${rule.triggerValue}"`);

  const contacts = await searchContacts(apiKey, rule.triggerField, rule.triggerOperator || "equals", rule.triggerValue);
  console.log(`[POST-DEMO] ${contacts.length} contacts match`);
  if (!contacts.length) return { triggered: 0, tasksCreated: 0, results: [] };

  // Check for already-processed contacts (in Airtable tasks)
  let existingNames = new Set();
  if (baseId) {
    try {
      let all = [], offset = null;
      do {
        const url = `${AT_API}/${baseId}/${encodeURIComponent("Tasks")}?filterByFormula={Task Type}="post_demo"${offset ? "&offset=" + offset : ""}`;
        const res = await fetch(url, { headers: atHdr });
        if (!res.ok) break;
        const d = await res.json();
        all.push(...(d.records || []));
        offset = d.offset;
      } while (offset);
      existingNames = new Set(all.map(t => ((t.fields || {})["Lead Name"] || "").toLowerCase().trim()));
    } catch {}
  }

  const newContacts = contacts.filter(c => {
    const name = `${c.properties?.firstname || ""} ${c.properties?.lastname || ""}`.trim().toLowerCase();
    return name && !existingNames.has(name);
  });

  console.log(`[POST-DEMO] ${newContacts.length} new (${contacts.length - newContacts.length} already processed)`);

  const allResults = [];
  const newTasks = [];

  for (const contact of newContacts) {
    const p = contact.properties || {};
    const name = `${p.firstname || ""} ${p.lastname || ""}`.trim();
    const deals = await getDeals(apiKey, contact.id);
    const followUps = await generateTasks(contact, deals, rule);

    for (const task of followUps) {
      newTasks.push({
        Company: p.company || "",
        "Task Rule": rule.name || "Post-Demo",
        Score: task.priority === "HIGH" ? 90 : task.priority === "MEDIUM" ? 70 : 50,
        "Scan Target": "leads",
        Signal: `${task.subject}: ${task.action}`,
        Source: `Post-Demo (${task.channel})`,
        "Task Type": "post_demo",
        Date: new Date().toISOString().slice(0, 10),
        Created: new Date().toISOString(),
        "Lead Name": name,
        Phone: p.phone || "",
        Email: p.email || "",
      });
    }

    allResults.push({
      lead: name, company: p.company || "", title: p.jobtitle || "",
      trigger: `${rule.triggerField}: ${p[rule.triggerField] || ""}`,
      dealCount: deals.length,
      tasksGenerated: followUps.length,
      tasks: followUps,
    });

    await new Promise(r => setTimeout(r, 300));
  }

  // Save to Airtable
  let created = 0;
  if (newTasks.length > 0 && baseId) {
    for (let i = 0; i < newTasks.length; i += 10) {
      const batch = newTasks.slice(i, i + 10).map(t => ({ fields: t }));
      try {
        const res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}`, {
          method: "POST", headers: atHdr, body: JSON.stringify({ records: batch, typecast: true }),
        });
        if (res.ok) { const d = await res.json(); created += (d.records || []).length; }
      } catch {}
    }
  }

  return { triggered: contacts.length, newTriggers: newContacts.length, tasksCreated: created, results: allResults };
}

// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, campaignId, baseId } = body;
    const apiKey = body.apiKey || await getHsKey(campaignId);

    if (!apiKey) return NextResponse.json({ error: "HubSpot not connected. Go to the HubSpot tab first." }, { status: 400 });

    switch (action) {
      case "get_properties": {
        const [props, pipelines] = await Promise.all([
          getContactProperties(apiKey),
          getDealPipelines(apiKey),
        ]);
        // Group properties by category for better UX
        const groups = {};
        for (const p of props) {
          const g = p.groupName || "other";
          if (!groups[g]) groups[g] = [];
          groups[g].push(p);
        }
        return NextResponse.json({ properties: props, groups, pipelines });
      }

      case "get_field_values": {
        const { field } = body;
        if (!field) return NextResponse.json({ error: "field required" }, { status: 400 });

        // Check if this property has predefined options
        const props = await getContactProperties(apiKey);
        const prop = props.find(p => p.name === field);

        if (prop?.options?.length > 0) {
          // Use predefined options (lifecycle stages, dropdowns, etc.)
          // Get counts for each option
          const values = [];
          for (const opt of prop.options) {
            const searchRes = await searchContacts(apiKey, field, "equals", opt.value, 1);
            // HubSpot search returns total in response
            values.push({ value: opt.value, label: opt.label, count: searchRes.length > 0 ? "1+" : "0" });
            await new Promise(r => setTimeout(r, 100));
          }
          return NextResponse.json({ field, label: prop.label, values, type: "predefined" });
        }

        // No predefined options — sample values from contacts
        const contacts = await searchContacts(apiKey, field, "not_empty", "", 100);
        const counts = {};
        for (const c of contacts) {
          const val = String(c.properties?.[field] || "").trim();
          if (val) counts[val] = (counts[val] || 0) + 1;
        }
        const values = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([value, count]) => ({ value, label: value, count }));
        return NextResponse.json({ field, label: prop?.label || field, values, type: "sampled", total: contacts.length });
      }

      case "preview": {
        const contacts = await searchContacts(apiKey, body.rule.triggerField, body.rule.triggerOperator || "equals", body.rule.triggerValue, 5);
        return NextResponse.json({
          matched: contacts.length,
          sample: contacts.slice(0, 5).map(c => ({
            name: `${c.properties?.firstname || ""} ${c.properties?.lastname || ""}`.trim(),
            company: c.properties?.company || "",
            email: c.properties?.email || "",
            value: c.properties?.[body.rule.triggerField] || "",
          })),
        });
      }

      case "run": {
        if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });
        const result = await processRule(apiKey, baseId, body.rule);
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
