import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const SMARTLEAD_BASE = "https://server.smartlead.ai/api/v1";
const AIRTABLE_KEY = process.env.AIRTABLE_API_KEY;
const AT_API = "https://api.airtable.com/v0";
const MASTER_BASE_ID = process.env.AIRTABLE_BASE_ID;

const atHdr = { Authorization: `Bearer ${AIRTABLE_KEY}`, "Content-Type": "application/json" };

// ═══════════════════════════════════════════════════════════════
// SMARTLEAD HELPERS
// ═══════════════════════════════════════════════════════════════
async function smartleadReq(path, method = "GET", body = null, apiKey) {
  if (!apiKey) return { ok: false, status: 0, data: { error: "No Smartlead API key" } };
  const sep = path.includes("?") ? "&" : "?";
  const url = `${SMARTLEAD_BASE}${path}${sep}api_key=${apiKey}`;
  const opts = { method, headers: { "Accept": "application/json" } };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  try {
    const res = await fetch(url, opts);
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: e.message } };
  }
}

const slListCampaigns = (key) => smartleadReq("/campaigns", "GET", null, key);
const slListEmailAccounts = (key) => smartleadReq("/email-accounts", "GET", null, key);
const slCreateCampaign = (key, payload) => smartleadReq("/campaigns/create", "POST", payload, key);
const slUpdateSchedule = (key, id, payload) => smartleadReq(`/campaigns/${id}/schedule`, "POST", payload, key);
const slUpdateSettings = (key, id, payload) => smartleadReq(`/campaigns/${id}/settings`, "POST", payload, key);
const slAddEmailAccounts = (key, id, ids) => smartleadReq(`/campaigns/${id}/email-accounts`, "POST", { email_account_ids: ids }, key);
const slSaveSequences = (key, id, sequences) => smartleadReq(`/campaigns/${id}/sequences`, "POST", { sequences }, key);
const slAddLeads = (key, id, leads) => smartleadReq(`/campaigns/${id}/leads`, "POST", { lead_list: leads }, key);
const slUpdateStatus = (key, id, status) => smartleadReq(`/campaigns/${id}/status`, "POST", { status }, key);

// ═══════════════════════════════════════════════════════════════
// AIRTABLE HELPERS
// ═══════════════════════════════════════════════════════════════
async function atList(baseId, table, params = {}) {
  const qs = new URLSearchParams();
  if (params.filterByFormula) qs.set("filterByFormula", params.filterByFormula);
  let all = [], offset = null;
  do {
    const url = `${AT_API}/${baseId}/${encodeURIComponent(table)}?${qs}${offset ? "&offset=" + offset : ""}`;
    const res = await fetch(url, { headers: atHdr });
    if (!res.ok) break;
    const d = await res.json();
    all.push(...(d.records || []));
    offset = d.offset;
  } while (offset);
  return all;
}

async function atUpdate(baseId, table, records) {
  for (let i = 0; i < records.length; i += 10) {
    const batch = records.slice(i, i + 10);
    await fetch(`${AT_API}/${baseId}/${encodeURIComponent(table)}`, {
      method: "PATCH", headers: atHdr, body: JSON.stringify({ records: batch }),
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// AI EMAIL GENERATION
// ═══════════════════════════════════════════════════════════════
function buildPersonalizationContext(lead, factors) {
  const f = lead.fields || lead;
  const lines = [];
  if (factors.name !== false) lines.push(`Name: ${f.Name || "Unknown"}`);
  if (factors.title !== false) lines.push(`Title: ${f.Title || "(unknown)"}`);
  if (factors.company !== false) lines.push(`Company: ${f.Company || "(unknown)"}`);
  if (factors.industry && f.Industry) lines.push(`Industry: ${f.Industry}`);
  if (factors.companySize && (f["Company Size"] || f.Size)) lines.push(`Company size: ${f["Company Size"] || f.Size}`);
  if (factors.location && (f.Country || f.Location)) lines.push(`Location: ${f.Country || f.Location}`);
  if (factors.linkedin && f["LinkedIn URL"]) lines.push(`LinkedIn: ${f["LinkedIn URL"]}`);
  if (factors.signals && f.Signal) lines.push(`Recent signal: ${f.Signal}`);
  if (factors.bio && f.Bio) lines.push(`Bio: ${String(f.Bio).slice(0, 300)}`);
  return lines.join("\n");
}

function getAnthropic() {
  if (!ANTHROPIC_KEY) throw new Error("ANTHROPIC_API_KEY not set");
  return new Anthropic({ apiKey: ANTHROPIC_KEY });
}

// Build static system + cached context blocks (these stay identical across all leads in a batch
// → enables prompt caching for ~80% cost reduction within a 5-min window)
function buildCachedBlocks(config) {
  const sequenceInstr = config.sequenceLength > 1
    ? `Generate ${config.sequenceLength} emails in a sequence (initial + ${config.sequenceLength - 1} follow-ups). Each follow-up references the previous email subtly without being repetitive. Each adds a new angle or value. Subject lines for follow-ups should be in the same thread (e.g. "Re: <original>" or a shorter variant).`
    : `Generate ONE personalized email.`;

  const systemRules = `You are an expert B2B cold email copywriter. You write personalized, conversational, low-friction cold emails that get replies.

RULES:
- Subject lines: 3-7 words, conversational, no clickbait, no question marks unless natural
- Body: 50-120 words for initial, 30-80 for follow-ups. Short paragraphs. No fluff.
- Open with something SPECIFIC to the lead (their role, company, signal, industry) — NEVER generic
- Tie the offer to their specific context
- One clear CTA at the end
- Skip "I hope this email finds you well", "I came across your profile", "I wanted to reach out"
- Casual professional tone. Lowercase signoffs are fine.
- Do NOT include any merge field placeholders like {first_name} — use the actual lead data
- Do NOT include a signature block (sender's email tool adds it automatically)
- Do NOT mention you're an AI or apologize for cold outreach

${sequenceInstr}

Return ONLY valid JSON, no markdown wrapping:
${config.sequenceLength > 1
  ? `{"emails": [{"subject": "...", "body": "..."}, {"subject": "...", "body": "..."}, ...]}`
  : `{"subject": "...", "body": "..."}`}`;

  const senderBlock = `=== SENDER (who's writing this email) ===
${config.senderProfile || "(not specified)"}`;

  const offerBlock = `=== CAMPAIGN OFFER ===
What this campaign is about:
${config.purpose || "(not specified)"}

CTA Link: ${config.ctaLink || "(reply to email)"}
What the CTA does: ${config.ctaPurpose || "(reply to learn more)"}`;

  const referenceBlock = config.referenceEmail
    ? `\n=== STYLE REFERENCE (emulate tone/structure, do not copy) ===\n${config.referenceEmail}`
    : "";

  return {
    system: [
      { type: "text", text: systemRules, cache_control: { type: "ephemeral" } },
      { type: "text", text: senderBlock + "\n\n" + offerBlock + referenceBlock, cache_control: { type: "ephemeral" } },
    ],
  };
}

async function generateEmailForLead(lead, config, factors, feedback = "") {
  const anthropic = getAnthropic();
  const leadCtx = buildPersonalizationContext(lead, factors);
  const cached = buildCachedBlocks(config);

  const userMsg = `=== THIS LEAD ===
${leadCtx}

${feedback ? `\n=== USER FEEDBACK ON PREVIOUS DRAFT (apply this carefully) ===\n${feedback}\n` : ""}
Write the email${config.sequenceLength > 1 ? "s" : ""} now. Return JSON only.`;

  try {
    const msg = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      temperature: 0.7,
      system: cached.system,
      messages: [{ role: "user", content: userMsg }],
    });

    // Extract text from response
    const textBlock = msg.content.find(b => b.type === "text");
    const raw = textBlock?.text || "{}";
    // Strip any accidental markdown fences
    const clean = raw.replace(/^```json\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(clean);

    if (config.sequenceLength > 1) {
      const emails = parsed.emails || [];
      return { ok: true, emails: emails.map(e => ({ subject: e.subject || "", body: e.body || "" })) };
    } else {
      return { ok: true, emails: [{ subject: parsed.subject || "", body: parsed.body || "" }] };
    }
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLER
// ═══════════════════════════════════════════════════════════════
export async function POST(request) {
  try {
    const body = await request.json();
    const { action, baseId, campaignId } = body;

    switch (action) {
      // ─── Smartlead config & lookups ─────────────────────
      case "save_smartlead_key": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const key = body.apiKey;
        if (!key) return NextResponse.json({ error: "apiKey required" }, { status: 400 });
        // Verify key works
        const test = await slListEmailAccounts(key);
        if (!test.ok) return NextResponse.json({ error: "Invalid Smartlead key", details: test.data }, { status: 400 });
        // Persist on Campaigns table
        await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
          method: "PATCH", headers: atHdr,
          body: JSON.stringify({ fields: { "Smartlead API Key": key } }),
        });
        return NextResponse.json({ ok: true, masked: "****" + key.slice(-4) });
      }

      case "get_smartlead_key": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, { headers: atHdr });
        if (!r.ok) return NextResponse.json({ hasKey: false });
        const rec = await r.json();
        const key = rec.fields?.["Smartlead API Key"] || "";
        return NextResponse.json({ hasKey: !!key, masked: key ? "****" + key.slice(-4) : null, rawKey: key || null });
      }

      // ─── SENDER PROFILE (one per campaign, on master Campaigns table) ───
      case "save_sender_profile": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        if (!body.senderProfile?.trim()) return NextResponse.json({ error: "senderProfile required" }, { status: 400 });
        await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
          method: "PATCH", headers: atHdr,
          body: JSON.stringify({ fields: { "Sender Profile": body.senderProfile } }),
        });
        return NextResponse.json({ ok: true });
      }

      case "get_sender_profile": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, { headers: atHdr });
        if (!r.ok) return NextResponse.json({ senderProfile: "" });
        const rec = await r.json();
        return NextResponse.json({ senderProfile: rec.fields?.["Sender Profile"] || "" });
      }

      // ─── EMAIL OFFERS (per-campaign library, lives in campaign's own base) ───
      case "list_offers": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        try {
          const offers = await atList(baseId, "Email Offers");
          // Sort by Last Used At desc, then by Use Count
          offers.sort((a, b) => (b.fields?.["Last Used At"] || "").localeCompare(a.fields?.["Last Used At"] || ""));
          return NextResponse.json({ offers });
        } catch (e) {
          return NextResponse.json({ offers: [], error: e.message });
        }
      }

      case "save_offer": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const fields = {
          Name: body.name || "Untitled Offer",
          "Offer Description": body.offerDescription || "",
          "CTA Link": body.ctaLink || "",
          "CTA Purpose": body.ctaPurpose || "",
          "Last Used At": new Date().toISOString(),
          "Use Count": body.useCount || 0,
        };
        // Auto-create the table if missing — relies on airtable route's ensure_fields
        try {
          await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Email Offers")}`, {
            method: "POST", headers: atHdr,
            body: JSON.stringify({ records: [{ fields }] }),
          }).then(async r => {
            if (!r.ok) {
              const err = await r.text();
              throw new Error(err.slice(0, 300));
            }
            return r.json();
          });
          return NextResponse.json({ ok: true });
        } catch (e) {
          return NextResponse.json({ error: "Failed to save offer: " + e.message + "\n\nIf the Email Offers table is missing, click 🔧 Setup in the sidebar to create it." }, { status: 400 });
        }
      }

      case "update_offer": {
        if (!baseId || !body.offerId) return NextResponse.json({ error: "baseId & offerId required" }, { status: 400 });
        const fields = {};
        if (body.name !== undefined) fields.Name = body.name;
        if (body.offerDescription !== undefined) fields["Offer Description"] = body.offerDescription;
        if (body.ctaLink !== undefined) fields["CTA Link"] = body.ctaLink;
        if (body.ctaPurpose !== undefined) fields["CTA Purpose"] = body.ctaPurpose;
        if (body.markUsed) {
          fields["Last Used At"] = new Date().toISOString();
        }
        await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Email Offers")}/${body.offerId}`, {
          method: "PATCH", headers: atHdr,
          body: JSON.stringify({ fields }),
        });
        return NextResponse.json({ ok: true });
      }

      case "delete_offer": {
        if (!baseId || !body.offerId) return NextResponse.json({ error: "baseId & offerId required" }, { status: 400 });
        await fetch(`${AT_API}/${baseId}/${encodeURIComponent("Email Offers")}/${body.offerId}`, {
          method: "DELETE", headers: atHdr,
        });
        return NextResponse.json({ ok: true });
      }

      // ─── LEGACY CONTEXT (kept for backward compatibility, not surfaced in new UI) ───
      case "save_email_context": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const fields = {};
        if (body.referenceEmail !== undefined) fields["Email Reference"] = body.referenceEmail;
        if (body.purpose !== undefined) fields["Email Purpose"] = body.purpose;
        if (body.ctaLink !== undefined) fields["Email CTA Link"] = body.ctaLink;
        if (body.ctaPurpose !== undefined) fields["Email CTA Purpose"] = body.ctaPurpose;
        await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, {
          method: "PATCH", headers: atHdr,
          body: JSON.stringify({ fields }),
        });
        return NextResponse.json({ ok: true });
      }

      case "get_email_context": {
        if (!campaignId) return NextResponse.json({ error: "campaignId required" }, { status: 400 });
        const r = await fetch(`${AT_API}/${MASTER_BASE_ID}/${encodeURIComponent("Campaigns")}/${campaignId}`, { headers: atHdr });
        if (!r.ok) return NextResponse.json({});
        const rec = await r.json();
        const f = rec.fields || {};
        return NextResponse.json({
          referenceEmail: f["Email Reference"] || "",
          purpose: f["Email Purpose"] || "",
          ctaLink: f["Email CTA Link"] || "",
          ctaPurpose: f["Email CTA Purpose"] || "",
        });
      }

      case "list_smartlead_campaigns": {
        const key = body.apiKey;
        const res = await slListCampaigns(key);
        return NextResponse.json(res.ok ? { campaigns: res.data || [] } : { error: res.data?.message || "Failed", details: res.data });
      }

      case "list_smartlead_email_accounts": {
        const key = body.apiKey;
        const res = await slListEmailAccounts(key);
        return NextResponse.json(res.ok ? { accounts: res.data || [] } : { error: res.data?.message || "Failed", details: res.data });
      }

      // ─── Lead listing ──────────────────────────────────
      case "list_leads_by_tag": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const leads = await atList(baseId, "Leads");
        const tag = body.campaignTag;
        const filtered = tag ? leads.filter(l => (l.fields?.["Campaign Tag"] || "") === tag) : leads;
        // Only those with email
        const withEmail = filtered.filter(l => (l.fields?.Email || "").includes("@"));
        return NextResponse.json({ leads: withEmail, total: filtered.length, withEmail: withEmail.length });
      }

      case "list_campaign_tags": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const leads = await atList(baseId, "Leads");
        const tagCounts = {};
        for (const l of leads) {
          const tag = l.fields?.["Campaign Tag"] || "(no tag)";
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
        return NextResponse.json({ tags: Object.entries(tagCounts).map(([tag, count]) => ({ tag, count })) });
      }

      // ─── AI generation ─────────────────────────────────
      case "generate_emails": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const { leadIds, config, factors = {} } = body;
        if (!leadIds?.length) return NextResponse.json({ error: "leadIds required" }, { status: 400 });
        if (!config?.purpose) return NextResponse.json({ error: "Campaign offer description (purpose) is required" }, { status: 400 });
        if (!config?.senderProfile) return NextResponse.json({ error: "Sender profile is required — set it once at the top of the wizard" }, { status: 400 });

        const allLeads = await atList(baseId, "Leads");
        const targetLeads = allLeads.filter(l => leadIds.includes(l.id));

        const results = [];
        for (const lead of targetLeads) {
          const r = await generateEmailForLead(lead, config, factors);
          results.push({
            leadId: lead.id,
            name: lead.fields?.Name || "Unknown",
            email: lead.fields?.Email || "",
            company: lead.fields?.Company || "",
            title: lead.fields?.Title || "",
            ...(r.ok ? { emails: r.emails, ok: true } : { error: r.error, ok: false }),
          });
          // brief throttle to avoid rate limits
          await new Promise(r => setTimeout(r, 300));
        }
        return NextResponse.json({ results });
      }

      case "regenerate_email": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const { leadId, config, factors = {}, feedback = "" } = body;
        const allLeads = await atList(baseId, "Leads");
        const lead = allLeads.find(l => l.id === leadId);
        if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
        const r = await generateEmailForLead(lead, config, factors, feedback);
        return NextResponse.json(r.ok
          ? { leadId, name: lead.fields?.Name, email: lead.fields?.Email, company: lead.fields?.Company, title: lead.fields?.Title, emails: r.emails, ok: true }
          : { leadId, error: r.error, ok: false });
      }

      // ─── Smartlead campaign launch ─────────────────────
      case "launch_smartlead_campaign": {
        const { apiKey, campaignName, mode, existingCampaignId, emailAccountIds, schedule, settings, generatedEmails, sequenceConfig } = body;
        if (!apiKey) return NextResponse.json({ error: "Smartlead apiKey required" }, { status: 400 });
        if (!generatedEmails?.length) return NextResponse.json({ error: "No generated emails" }, { status: 400 });

        const log = [];
        let slCampaignId;

        try {
          if (mode === "existing" && existingCampaignId) {
            slCampaignId = existingCampaignId;
            log.push(`Using existing Smartlead campaign ${slCampaignId}`);
          } else {
            // Create new
            const createRes = await slCreateCampaign(apiKey, {
              name: campaignName || `SignalScope Campaign ${new Date().toISOString().slice(0,16)}`,
              client_id: null,
            });
            if (!createRes.ok) return NextResponse.json({ error: "Smartlead create failed", details: createRes.data }, { status: 400 });
            slCampaignId = createRes.data?.id || createRes.data?.campaign_id;
            if (!slCampaignId) return NextResponse.json({ error: "No campaign ID returned", details: createRes.data }, { status: 400 });
            log.push(`Created Smartlead campaign ${slCampaignId}`);

            // Schedule
            if (schedule) {
              const schRes = await slUpdateSchedule(apiKey, slCampaignId, schedule);
              if (!schRes.ok) log.push(`⚠️ Schedule update failed: ${JSON.stringify(schRes.data).slice(0,150)}`);
              else log.push(`Schedule applied`);
            }

            // Settings
            if (settings) {
              const setRes = await slUpdateSettings(apiKey, slCampaignId, settings);
              if (!setRes.ok) log.push(`⚠️ Settings update failed: ${JSON.stringify(setRes.data).slice(0,150)}`);
              else log.push(`Settings applied`);
            }

            // Email accounts
            if (emailAccountIds?.length) {
              const eaRes = await slAddEmailAccounts(apiKey, slCampaignId, emailAccountIds);
              if (!eaRes.ok) return NextResponse.json({ error: "Failed to attach mailboxes", details: eaRes.data, log }, { status: 400 });
              log.push(`Attached ${emailAccountIds.length} mailbox(es)`);
            }

            // Sequences — use placeholder template that pulls per-lead custom fields
            const seqLen = sequenceConfig?.length || 1;
            const sequences = [];
            for (let step = 0; step < seqLen; step++) {
              sequences.push({
                seq_number: step + 1,
                seq_delay_details: step === 0 ? { delay_in_days: 0 } : { delay_in_days: sequenceConfig?.delays?.[step] || 3 },
                subject: `{{${step === 0 ? "subject" : "subject_" + (step + 1)}}}`,
                email_body: `{{${step === 0 ? "body" : "body_" + (step + 1)}}}`,
              });
            }
            const seqRes = await slSaveSequences(apiKey, slCampaignId, sequences);
            if (!seqRes.ok) return NextResponse.json({ error: "Failed to save sequences", details: seqRes.data, log }, { status: 400 });
            log.push(`Saved ${sequences.length} sequence step(s)`);
          }

          // Add leads with per-lead personalized content via custom_fields
          const leadList = generatedEmails.filter(g => g.ok && g.email).map(g => {
            const cf = {};
            (g.emails || []).forEach((e, i) => {
              if (i === 0) {
                cf.subject = e.subject;
                cf.body = e.body;
              } else {
                cf[`subject_${i + 1}`] = e.subject;
                cf[`body_${i + 1}`] = e.body;
              }
            });
            const [first, ...rest] = (g.name || "").split(" ");
            return {
              email: g.email,
              first_name: first || "",
              last_name: rest.join(" ") || "",
              company_name: g.company || "",
              custom_fields: cf,
            };
          });

          // Smartlead caps at 400 per request
          let added = 0, skipped = 0;
          const errors = [];
          for (let i = 0; i < leadList.length; i += 400) {
            const batch = leadList.slice(i, i + 400);
            const addRes = await slAddLeads(apiKey, slCampaignId, batch);
            if (addRes.ok) {
              added += addRes.data?.added_count || addRes.data?.upload_count || batch.length;
              skipped += addRes.data?.skipped_count || 0;
            } else {
              errors.push(JSON.stringify(addRes.data).slice(0, 200));
            }
          }
          log.push(`Added ${added} leads, ${skipped} skipped`);

          // Activate campaign if user requested
          if (body.activate !== false) {
            const actRes = await slUpdateStatus(apiKey, slCampaignId, "START");
            if (!actRes.ok) log.push(`⚠️ Failed to activate: ${JSON.stringify(actRes.data).slice(0,150)}`);
            else log.push(`✅ Campaign activated`);
          } else {
            log.push(`Campaign created in DRAFT state — activate from Smartlead manually`);
          }

          return NextResponse.json({
            ok: true,
            smartleadCampaignId: slCampaignId,
            added, skipped,
            errors: errors.length > 0 ? errors : undefined,
            log,
            smartleadUrl: `https://app.smartlead.ai/app/email-campaign/${slCampaignId}/analytics`,
          });
        } catch (e) {
          return NextResponse.json({ error: e.message, log }, { status: 500 });
        }
      }

      default:
        return NextResponse.json({ error: "Unknown action: " + action }, { status: 400 });
    }
  } catch (e) {
    console.error("[email-campaign] Error:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
