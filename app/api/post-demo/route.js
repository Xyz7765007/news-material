import { NextResponse } from "next/server";
import OpenAI from "openai";

let _openai;
function getOpenAI() { if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY }); return _openai; }

const AT_API = "https://api.airtable.com/v0";
const AT_KEY = process.env.AIRTABLE_API_KEY;
const atHdr = { Authorization: `Bearer ${AT_KEY}`, "Content-Type": "application/json" };

// ─── Load records from Airtable ──────────────────────────────
async function loadRecords(baseId, table) {
  let all = [], offset = null;
  do {
    const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}?${offset ? "offset=" + offset : ""}`;
    const res = await fetch(url, { headers: atHdr });
    if (!res.ok) break;
    const d = await res.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

// ─── Find leads matching trigger condition ───────────────────
function findTriggeredLeads(leads, rule) {
  const { triggerField, triggerValue, triggerOperator } = rule;
  if (!triggerField) return [];

  return leads.filter(l => {
    const val = String((l.fields || {})[triggerField] || "").toLowerCase().trim();
    const target = (triggerValue || "").toLowerCase().trim();

    switch (triggerOperator || "equals") {
      case "equals": return val === target;
      case "contains": return val.includes(target);
      case "not_empty": return val.length > 0;
      case "changed_to": return val === target; // simplified — full impl needs tracking
      case "greater_than": return parseFloat(val) > parseFloat(target);
      case "less_than": return parseFloat(val) < parseFloat(target);
      default: return val === target;
    }
  });
}

// ─── Get engagement history for a lead ───────────────────────
function getEngagementHistory(lead, tasks, allLeads) {
  const f = lead.fields || {};
  const leadName = (f.Name || "").toLowerCase();
  const company = (f.Company || "").toLowerCase();

  // Find tasks related to this lead or company
  const relatedTasks = tasks.filter(t => {
    const tf = t.fields || {};
    const taskCompany = (tf.Company || "").toLowerCase();
    const taskLead = (tf["Lead Name"] || "").toLowerCase();
    return taskCompany === company || taskLead === leadName;
  });

  // Build history summary
  const history = [];
  if (relatedTasks.length > 0) {
    history.push(`${relatedTasks.length} previous tasks/signals:`);
    relatedTasks.slice(0, 10).forEach(t => {
      const tf = t.fields || {};
      history.push(`- ${tf["Task Rule"] || "Task"}: ${(tf.Signal || "").slice(0, 100)} (Score: ${tf.Score || "?"}, ${tf.Date || ""})`);
    });
  }

  // Lead data summary
  const leadData = Object.entries(f)
    .filter(([k, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${String(v).slice(0, 100)}`)
    .join("\n");

  return { relatedTasks, leadData, historySummary: history.join("\n") };
}

// ─── AI: Generate follow-up tasks ────────────────────────────
async function generateFollowUpTasks(lead, engagement, rule) {
  const openai = getOpenAI();
  const f = lead.fields || {};

  const prompt = rule.aiPrompt || `Based on this contact's data and engagement history, recommend 1-3 specific follow-up tasks for the SDR. Each task should have a clear action, be personalized to the contact, and reference their engagement signals.`;

  try {
    const c = await openai.chat.completions.create({
      model: "gpt-5.4-mini",
      temperature: 0.3,
      max_tokens: 1000,
      messages: [
        {
          role: "system",
          content: `You are an SDR task recommendation engine. Given a contact's profile and their engagement history, generate specific, actionable follow-up tasks.

Return ONLY a JSON array of tasks:
[{
  "subject": "Brief task title (max 10 words)",
  "action": "Specific action the SDR should take (max 30 words)",
  "priority": "HIGH" | "MEDIUM" | "LOW",
  "reason": "Why this task matters based on the data (max 20 words)",
  "channel": "email" | "phone" | "linkedin" | "meeting"
}]

Rules:
- Generate 1-3 tasks maximum
- Each task must reference specific data from the contact's profile or history
- If there's engagement history (signals, scores), use it to personalize
- If there's a phone number, include a call task
- If there's a LinkedIn URL, include a LinkedIn engagement task
- Tasks should be ordered by priority
- No generic tasks — everything must be specific to this contact
No markdown, just JSON.`
        },
        {
          role: "user",
          content: `SDR Instructions:\n${prompt}\n\nContact:\nName: ${f.Name || ""}\nTitle: ${f.Title || ""}\nCompany: ${f.Company || ""}\nEmail: ${f.Email || ""}\nPhone: ${f.Phone || ""}\nLinkedIn: ${f["LinkedIn URL"] || ""}\n\nFull Profile:\n${engagement.leadData}\n\nEngagement History:\n${engagement.historySummary || "No previous engagement recorded"}\n\nTrigger: "${rule.triggerField}" = "${(f[rule.triggerField] || "")}"`,
        },
      ],
    });

    const text = c.choices[0]?.message?.content || "[]";
    try {
      return JSON.parse(text.replace(/```json\n?|```/g, "").trim());
    } catch {
      const m = text.match(/\[[\s\S]*?\]/);
      return m ? JSON.parse(m[0]) : [];
    }
  } catch (e) {
    console.error("[POST-DEMO] AI error:", e.message);
    return [{ subject: "Follow up with " + (f.Name || "contact"), action: "Review engagement and reach out", priority: "MEDIUM", reason: "AI generation failed", channel: "email" }];
  }
}

// ─── Process a post-demo rule ────────────────────────────────
async function processRule(baseId, rule) {
  console.log(`[POST-DEMO] Processing rule: ${rule.name}`);

  const [leads, tasks, existingPostDemo] = await Promise.all([
    loadRecords(baseId, "Leads"),
    loadRecords(baseId, "Tasks"),
    loadRecords(baseId, "Tasks").then(t => t.filter(x => (x.fields || {})["Task Type"] === "post_demo")),
  ]);

  // Find leads matching trigger
  const triggered = findTriggeredLeads(leads, rule);
  console.log(`[POST-DEMO] ${triggered.length} leads match trigger: ${rule.triggerField} ${rule.triggerOperator || "equals"} "${rule.triggerValue}"`);

  if (!triggered.length) return { triggered: 0, tasksCreated: 0, results: [] };

  // Filter out leads that already have post-demo tasks (no duplicates)
  const alreadyProcessed = new Set(
    existingPostDemo.map(t => ((t.fields || {})["Lead Name"] || "").toLowerCase().trim())
  );
  const newTriggers = triggered.filter(l => {
    const name = ((l.fields || {}).Name || "").toLowerCase().trim();
    return !alreadyProcessed.has(name);
  });

  console.log(`[POST-DEMO] ${newTriggers.length} new (${triggered.length - newTriggers.length} already processed)`);

  const allResults = [];
  const newTasks = [];

  for (const lead of newTriggers) {
    const f = lead.fields || {};
    const engagement = getEngagementHistory(lead, tasks, leads);
    const followUps = await generateFollowUpTasks(lead, engagement, rule);

    for (const task of followUps) {
      newTasks.push({
        Company: f.Company || "",
        "Task Rule": rule.name || "Post-Demo Follow-up",
        Score: task.priority === "HIGH" ? 90 : task.priority === "MEDIUM" ? 70 : 50,
        "Scan Target": "leads",
        Signal: `${task.subject}: ${task.action}`,
        Source: `Post-Demo Automation (${task.channel})`,
        "Task Type": "post_demo",
        Date: new Date().toISOString().slice(0, 10),
        Created: new Date().toISOString(),
        "Lead Name": f.Name || "",
        "Lead Title": f.Title || "",
        "Lead Company": f.Company || "",
        Phone: f.Phone || "",
        Email: f.Email || "",
      });
    }

    allResults.push({
      lead: f.Name || "Unknown",
      company: f.Company || "",
      title: f.Title || "",
      trigger: `${rule.triggerField}: ${f[rule.triggerField] || ""}`,
      tasksGenerated: followUps.length,
      tasks: followUps,
      engagementCount: engagement.relatedTasks.length,
    });

    // Rate limit
    await new Promise(r => setTimeout(r, 300));
  }

  // Save tasks to Airtable
  let created = 0;
  if (newTasks.length > 0) {
    for (let i = 0; i < newTasks.length; i += 10) {
      const batch = newTasks.slice(i, i + 10).map(t => ({ fields: t }));
      try {
        const res = await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Tasks")}`, {
          method: "POST", headers: atHdr,
          body: JSON.stringify({ records: batch, typecast: true }),
        });
        if (res.ok) { const d = await res.json(); created += (d.records || []).length; }
        else console.error("[POST-DEMO] Create error:", (await res.text()).slice(0, 200));
      } catch (e) { console.error("[POST-DEMO] Create error:", e.message); }
    }
  }

  console.log(`[POST-DEMO] Done: ${newTriggers.length} leads → ${created} tasks`);
  return { triggered: triggered.length, newTriggers: newTriggers.length, tasksCreated: created, results: allResults };
}

// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, baseId } = body;

    if (!AT_KEY) return NextResponse.json({ error: "AIRTABLE_API_KEY not set" }, { status: 500 });
    if (!process.env.OPENAI_API_KEY) return NextResponse.json({ error: "OPENAI_API_KEY not set" }, { status: 500 });

    switch (action) {
      case "get_lead_fields": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const leads = await loadRecords(baseId, "Leads");
        const fields = [...new Set(leads.flatMap(l => Object.keys(l.fields || {})))].sort();
        return NextResponse.json({ fields, totalLeads: leads.length });
      }

      case "get_field_values": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const { field } = body;
        if (!field) return NextResponse.json({ error: "field required" }, { status: 400 });
        const leads = await loadRecords(baseId, "Leads");
        const counts = {};
        let empty = 0;
        for (const l of leads) {
          const val = String((l.fields || {})[field] || "").trim();
          if (!val) { empty++; continue; }
          counts[val] = (counts[val] || 0) + 1;
        }
        // Sort by count descending
        const values = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([value, count]) => ({ value, count }));
        return NextResponse.json({ field, values, empty, total: leads.length });
      }

      case "preview": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const leads = await loadRecords(baseId, "Leads");
        const matched = findTriggeredLeads(leads, body.rule);
        return NextResponse.json({ matched: matched.length, sample: matched.slice(0, 5).map(l => ({ name: (l.fields || {}).Name, company: (l.fields || {}).Company, value: (l.fields || {})[body.rule.triggerField] })) });
      }

      case "run": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const result = await processRule(baseId, body.rule);
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
