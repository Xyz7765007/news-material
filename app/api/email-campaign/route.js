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
const slGetSequences = (key, id) => smartleadReq(`/campaigns/${id}/sequences`, "GET", null, key);
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
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Airtable ${table} fetch failed (${res.status}): ${errText.slice(0, 200)}`);
    }
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

  // GA engagement data — included by default if present (factors.ga !== false explicitly disables)
  // This is critical for warm outreach that references actual website behavior
  const gaScore = Number(f["GA Engagement Score"] || 0);
  if (factors.ga !== false && gaScore > 0) {
    const gaSessions = Number(f["GA Sessions"] || 0);
    const gaViews = Number(f["GA Views"] || 0);
    const gaEngagementTime = Number(f["GA Engagement Time"] || 0);
    const gaLastVisit = f["GA Last Visit"] || "";
    const tier = gaScore >= 51 ? "🔥 Hot" : gaScore >= 21 ? "⚡ Interested" : "👀 Warm";
    lines.push(`\n=== Website Engagement (THEY VISITED OUR SITE) ===`);
    lines.push(`Engagement tier: ${tier} (score ${gaScore}/100)`);
    if (gaSessions > 0) lines.push(`Sessions: ${gaSessions}`);
    if (gaViews > 0) lines.push(`Pageviews: ${gaViews}`);
    if (gaEngagementTime > 0) {
      const t = gaEngagementTime >= 60 ? `${Math.floor(gaEngagementTime/60)} minutes ${Math.floor(gaEngagementTime%60)}s` : `${Math.floor(gaEngagementTime)} seconds`;
      lines.push(`Time on site: ${t}`);
    }
    if (gaLastVisit) lines.push(`Last visit: ${gaLastVisit}`);
    lines.push(`USE THIS to open the email — they're already aware of you. Don't pitch from scratch; reference their actual interest.`);
  }
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

ENGAGEMENT-AWARE OPENING (when "Website Engagement" data is present in the lead context):
- This is a WARM lead — they've already visited your website
- The opener MUST reference their actual behavior (e.g., "saw you've been digging into our [topic]" or "noticed you spent X minutes on our [page]")
- Frame as helpful follow-up, NOT cold pitch — they're already curious
- Don't be creepy — keep it casual ("happened to notice", "your team's been exploring")
- The subject line should also reflect this warmth (e.g., "quick follow-up" instead of generic intro)

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
      // Anthropic's Messages API REQUIRES max_tokens (verified against
      // docs.anthropic.com). max_completion_tokens is OpenAI-only — previous
      // code used it here, which would cause the call to either error or
      // be silently ignored, explaining the "Email engine in development"
      // banner since generation never worked.
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
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (parseErr) {
      console.error(`[generateEmail] JSON parse failed for ${lead.fields?.Name || lead.id}. Raw response:`, raw.slice(0, 500));
      return { ok: false, error: `AI returned invalid JSON: ${parseErr.message}. Raw start: "${clean.slice(0, 100)}"` };
    }

    if (config.sequenceLength > 1) {
      const emails = parsed.emails || [];
      if (!Array.isArray(emails) || emails.length === 0) {
        return { ok: false, error: `AI response missing "emails" array. Got keys: ${Object.keys(parsed).join(", ")}` };
      }
      // Pad with empty if AI returned fewer than requested
      const padded = [];
      for (let i = 0; i < config.sequenceLength; i++) {
        const e = emails[i] || {};
        padded.push({ subject: e.subject || "", body: e.body || "" });
      }
      // Validate at least the first email has content
      if (!padded[0].subject || !padded[0].body) {
        return { ok: false, error: "AI returned email with missing subject or body" };
      }
      return { ok: true, emails: padded };
    } else {
      if (!parsed.subject || !parsed.body) {
        return { ok: false, error: `AI response missing subject/body. Got: ${JSON.stringify(parsed).slice(0, 150)}` };
      }
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
    // SECURITY: Block from /client/[id] pages. Sends emails, handles Smartlead/Gmail tokens.
    const referer = request.headers.get("referer") || "";
    if (/\/client\/[^/?#]+/.test(referer)) {
      console.warn(`[SECURITY] email-campaign blocked from client referer: ${referer}`);
      return NextResponse.json({ error: "Not authorized in client mode" }, { status: 403 });
    }
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

      // ─── Inspect an existing campaign before adding leads to it ───
      case "inspect_smartlead_campaign": {
        const { apiKey, smartleadCampaignId } = body;
        if (!apiKey) return NextResponse.json({ error: "apiKey required" }, { status: 400 });
        if (!smartleadCampaignId) return NextResponse.json({ error: "smartleadCampaignId required" }, { status: 400 });
        const res = await slGetSequences(apiKey, smartleadCampaignId);
        if (!res.ok) return NextResponse.json({ error: "Failed to fetch sequences", details: res.data }, { status: 400 });
        // Smartlead returns sequences as array — each with seq_number, subject, email_body
        const sequences = Array.isArray(res.data) ? res.data : (res.data?.sequences || []);
        return NextResponse.json({
          sequenceCount: sequences.length,
          sequences: sequences.map(s => ({ seq_number: s.seq_number, subject: s.subject, has_body: !!s.email_body })),
        });
      }

      case "list_smartlead_email_accounts": {
        const key = body.apiKey;
        const res = await slListEmailAccounts(key);
        return NextResponse.json(res.ok ? { accounts: res.data || [] } : { error: res.data?.message || "Failed", details: res.data });
      }

      // ─── Lead listing ──────────────────────────────────
      case "list_leads_by_tag": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        try {
          const leads = await atList(baseId, "Leads");
          const tag = body.campaignTag;
          const filtered = tag ? leads.filter(l => (l.fields?.["Campaign Tag"] || "") === tag) : leads;
          // Only those with email
          const withEmail = filtered.filter(l => (l.fields?.Email || "").includes("@"));
          return NextResponse.json({ leads: withEmail, total: filtered.length, withEmail: withEmail.length });
        } catch (e) {
          return NextResponse.json({ error: "Failed to load leads: " + e.message }, { status: 500 });
        }
      }

      case "list_campaign_tags": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        try {
          const leads = await atList(baseId, "Leads");
          const tagCounts = {};
          for (const l of leads) {
            const tag = l.fields?.["Campaign Tag"] || "(no tag)";
            tagCounts[tag] = (tagCounts[tag] || 0) + 1;
          }
          return NextResponse.json({ tags: Object.entries(tagCounts).map(([tag, count]) => ({ tag, count })) });
        } catch (e) {
          return NextResponse.json({ tags: [], error: "Failed to load tags: " + e.message });
        }
      }

      // ─── AI generation ─────────────────────────────────
      case "generate_emails": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const { leadIds, config, factors = {} } = body;
        if (!leadIds?.length) return NextResponse.json({ error: "leadIds required" }, { status: 400 });
        if (!config?.purpose) return NextResponse.json({ error: "Campaign offer description (purpose) is required" }, { status: 400 });
        if (!config?.senderProfile) return NextResponse.json({ error: "Sender profile is required — set it once at the top of the wizard" }, { status: 400 });

        let allLeads;
        try { allLeads = await atList(baseId, "Leads"); }
        catch (e) { return NextResponse.json({ error: "Failed to load leads from Airtable: " + e.message }, { status: 500 }); }
        const targetLeads = allLeads.filter(l => leadIds.includes(l.id));
        if (targetLeads.length === 0) {
          return NextResponse.json({ error: `None of the ${leadIds.length} selected lead IDs were found in Airtable. They may have been deleted.` }, { status: 404 });
        }

        const results = [];
        let failedCount = 0;
        for (const lead of targetLeads) {
          const r = await generateEmailForLead(lead, config, factors);
          if (!r.ok) failedCount++;
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
        console.log(`[generate_emails] ${results.length} processed, ${failedCount} failed`);
        return NextResponse.json({ results, generated: results.length - failedCount, failed: failedCount });
      }

      case "regenerate_email": {
        if (!baseId) return NextResponse.json({ error: "baseId required" }, { status: 400 });
        const { leadId, config, factors = {}, feedback = "" } = body;
        if (!leadId) return NextResponse.json({ error: "leadId required" }, { status: 400 });
        if (!config?.purpose) return NextResponse.json({ error: "config.purpose required" }, { status: 400 });
        if (!config?.senderProfile) return NextResponse.json({ error: "config.senderProfile required" }, { status: 400 });

        let allLeads;
        try { allLeads = await atList(baseId, "Leads"); }
        catch (e) { return NextResponse.json({ error: "Failed to load leads: " + e.message }, { status: 500 }); }
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

            // CRITICAL: verify the existing campaign's sequence count matches what we generated
            // If we generated 3 emails per lead but the campaign only has 1 step, follow-ups will be lost
            const generatedSeqLen = (generatedEmails[0]?.emails || []).length || 1;
            const seqRes = await slGetSequences(apiKey, slCampaignId);
            if (!seqRes.ok) {
              return NextResponse.json({ error: "Couldn't read existing campaign's sequence steps to verify compatibility", details: seqRes.data, log }, { status: 400 });
            }
            const existingSequences = Array.isArray(seqRes.data) ? seqRes.data : (seqRes.data?.sequences || []);
            const existingSeqCount = existingSequences.length;
            log.push(`Existing campaign has ${existingSeqCount} sequence step(s); generated ${generatedSeqLen} email(s) per lead`);

            if (existingSeqCount === 0) {
              return NextResponse.json({
                error: `Existing campaign "${existingCampaignId}" has NO sequence steps configured. Set up sequences in Smartlead first, OR create a new campaign instead.`,
                log,
              }, { status: 400 });
            }
            if (generatedSeqLen > existingSeqCount && body.allowSequenceMismatch !== true) {
              return NextResponse.json({
                error: `Sequence mismatch: you generated ${generatedSeqLen} emails per lead, but the existing campaign only has ${existingSeqCount} step(s). Follow-ups beyond step ${existingSeqCount} would be silently dropped. Either: (1) reduce sequence length to ${existingSeqCount}, (2) create a new campaign, or (3) re-launch with allowSequenceMismatch=true to accept the loss.`,
                log,
                existingSeqCount,
                generatedSeqLen,
                requiresConfirmation: true,
              }, { status: 400 });
            }
            // Verify each existing sequence step references the placeholder we expect
            // (subject_2, body_2 for step 2, etc.) — if not, leads' custom_fields won't render
            const placeholderIssues = [];
            existingSequences.slice(0, generatedSeqLen).forEach((s, i) => {
              const expectedSubjectPh = i === 0 ? "{{subject}}" : `{{subject_${i + 1}}}`;
              const expectedBodyPh = i === 0 ? "{{body}}" : `{{body_${i + 1}}}`;
              const subjOk = (s.subject || "").includes(expectedSubjectPh);
              const bodyOk = (s.email_body || "").includes(expectedBodyPh);
              if (!subjOk || !bodyOk) {
                placeholderIssues.push(`Step ${i + 1}: ${!subjOk ? `subject missing ${expectedSubjectPh}` : ""}${!subjOk && !bodyOk ? "; " : ""}${!bodyOk ? `body missing ${expectedBodyPh}` : ""}`);
              }
            });
            if (placeholderIssues.length > 0 && body.allowPlaceholderMismatch !== true) {
              return NextResponse.json({
                error: `Existing campaign sequences don't reference SignalScope placeholders. Each step must contain ${"{{subject}} / {{body}}"} (step 1) or ${"{{subject_N}} / {{body_N}}"} (step N). Issues:\n${placeholderIssues.join("\n")}\n\nFix the sequences in Smartlead to use these placeholders, or create a new campaign instead.`,
                log,
                placeholderIssues,
                requiresConfirmation: true,
              }, { status: 400 });
            }
            if (placeholderIssues.length > 0) {
              log.push(`⚠️ Placeholder mismatches accepted by user (${placeholderIssues.length} issue(s))`);
            }
          } else {
            // Create new
            const createRes = await slCreateCampaign(apiKey, {
              name: campaignName || `SignalScope Campaign ${new Date().toISOString().slice(0,16)}`,
              client_id: null,
            });
            if (!createRes.ok) return NextResponse.json({ error: "Smartlead create failed", details: createRes.data, log }, { status: 400 });
            // Defensive: parse multiple possible response shapes
            slCampaignId = createRes.data?.id
              || createRes.data?.campaign_id
              || createRes.data?.data?.id
              || createRes.data?.data?.campaign_id;
            if (!slCampaignId) return NextResponse.json({ error: "No campaign ID returned by Smartlead", details: createRes.data, log }, { status: 400 });
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
            } else {
              return NextResponse.json({ error: "At least one mailbox is required for a new campaign", log }, { status: 400 });
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
          const skippedNoEmail = generatedEmails.filter(g => !g.ok || !g.email).length;
          const validGenerated = generatedEmails.filter(g => g.ok && g.email);
          if (skippedNoEmail > 0) log.push(`⚠️ ${skippedNoEmail} lead(s) skipped (generation failed or no email)`);
          if (validGenerated.length === 0) {
            return NextResponse.json({ error: "No leads have generated emails — nothing to send", log }, { status: 400 });
          }
          const leadList = validGenerated.map(g => {
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
          let added = 0, skipped = 0, batchFailures = 0;
          const errors = [];
          for (let i = 0; i < leadList.length; i += 400) {
            const batch = leadList.slice(i, i + 400);
            const addRes = await slAddLeads(apiKey, slCampaignId, batch);
            if (addRes.ok) {
              // Smartlead returns { upload_count: N, total_leads: M, ... } for new uploads,
              // or { added_count } for older API. Don't fall back to batch.length — that masks errors.
              const a = addRes.data?.upload_count ?? addRes.data?.added_count ?? addRes.data?.uploaded;
              const s = addRes.data?.duplicate_count ?? addRes.data?.skipped_count ?? 0;
              if (typeof a === "number") {
                added += a;
                skipped += (typeof s === "number" ? s : 0);
              } else {
                // Unknown response shape — don't claim success blindly. Log it.
                log.push(`⚠️ Batch ${Math.floor(i / 400) + 1}: unrecognized response shape, treating as ${batch.length} added pending verification`);
                added += batch.length;
              }
            } else {
              batchFailures++;
              errors.push(`Batch ${Math.floor(i / 400) + 1} (HTTP ${addRes.status}): ${JSON.stringify(addRes.data).slice(0, 200)}`);
              console.error("[launch] Lead batch failed:", addRes.status, JSON.stringify(addRes.data).slice(0, 300));
            }
          }
          if (batchFailures > 0) log.push(`❌ ${batchFailures} of ${Math.ceil(leadList.length / 400)} lead batches failed`);
          log.push(`Added ${added} leads${skipped > 0 ? `, ${skipped} duplicates skipped` : ""}`);

          // Activate campaign if user requested
          if (body.activate === true) {
            const actRes = await slUpdateStatus(apiKey, slCampaignId, "START");
            if (!actRes.ok) {
              log.push(`⚠️ Failed to activate: ${JSON.stringify(actRes.data).slice(0,150)}`);
              return NextResponse.json({
                ok: true,
                warning: "Campaign created and leads added, but activation failed. Activate manually in Smartlead.",
                smartleadCampaignId: slCampaignId,
                added, skipped,
                errors: errors.length > 0 ? errors : undefined,
                log,
                smartleadUrl: `https://app.smartlead.ai/app/email-campaign/${slCampaignId}/analytics`,
              });
            }
            log.push(`✅ Campaign activated`);
          } else {
            log.push(`Campaign created in DRAFT state — activate from Smartlead manually`);
          }

          return NextResponse.json({
            ok: true,
            smartleadCampaignId: slCampaignId,
            added, skipped,
            skippedNoEmail,
            batchFailures,
            errors: errors.length > 0 ? errors : undefined,
            log,
            smartleadUrl: `https://app.smartlead.ai/app/email-campaign/${slCampaignId}/analytics`,
          });
        } catch (e) {
          console.error("[launch] Exception:", e);
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
