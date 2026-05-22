"use client";
import { useState, useEffect, useRef, useCallback, Fragment } from "react";
import LeadMovementScanModal from "./LeadMovementScanModal";

// ─── Airtable helper — passes baseId with every request ─────
async function at(action, table, data = {}, baseId) {
  const res = await fetch("/api/airtable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, table, baseId, ...data }) });
  if (!res.ok) throw new Error("Airtable " + action + " failed: " + res.status);
  return res.json();
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function extractLinkedInSlug(url) {
  if (!url) return "";
  const t = url.trim().replace(/\/+$/, "");
  const m = t.match(/linkedin\.com\/company\/([^\/\?\s&#]+)/i);
  if (m) { const v = m[1].toLowerCase(); if (/^\d{3,15}$/.test(v)) return ""; return v; }
  if (/^[a-z0-9][a-z0-9-]{0,50}$/i.test(t) && !/^\d+$/.test(t)) return t.toLowerCase();
  return "";
}
function extractLinkedInId(url) {
  if (!url) return null;
  const t = url.trim().replace(/\/+$/, "");
  if (/^\d{3,15}$/.test(t)) return t;
  const fc = t.match(/f_C=(\d+)/); if (fc) return fc[1];
  const np = t.match(/linkedin\.com\/company\/(\d{3,15})/i); if (np) return np[1];
  return null;
}

const SRC_OPTS = ["News","New Hires","Job Posts","Social","Exits / Promotions","Custom","Earnings","SEC Filings"];

// ─── All available features ──────────────────────────────────
const ALL_FEATURES = [
  { id: "news", label: "News Scanning", emoji: "📰", desc: "Scan RSS feeds and news sources for company signals" },
  { id: "job_posts", label: "Job Post Tracking", emoji: "📋", desc: "Track LinkedIn job postings at target companies" },
  { id: "top_x", label: "Top X Scoring", emoji: "🎯", desc: "Rank leads/accounts by weighted field scoring" },
  { id: "linkedin_outreach", label: "LinkedIn Outreach", emoji: "💬", desc: "Automated LinkedIn connection requests & DM sequences" },
];

// Default campaigns (use master base)
const DEFAULT_CAMPAIGNS = [
  { id:"material", name:"Material Signals Campaign", emoji:"📡", desc:"Track news, job posts, and market intelligence.", badge:"Active", active:true, features:["news","job_posts"], baseId:null },
  { id:"veloka", name:"Veloka", emoji:"🎯", desc:"Rank leads & accounts by weighted scoring to surface top prospects.", badge:"Active", active:true, features:["top_x"], baseId:null },
];

const I = {
  Plus:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Trash:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  Upload:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  Play:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  Check:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  Back:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  Sparkle:()=><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>,
  Download:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>,
  Link:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
  Copy:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>,
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
:root{--bg:#0a0a0c;--card:#111114;--hover:#1a1a1e;--input:#141418;--bdr:#222228;--bdr2:#333338;--t1:#e8e6e0;--t2:#9a9890;--t3:#5c5a55;--acc:#bfa35a;--acc-d:rgba(191,163,90,0.12);--grn:#5da87a;--grn-d:rgba(93,168,122,0.12);--blu:#5b8fd4;--blu-d:rgba(91,143,212,0.12);--red:#c45c5c;--red-d:rgba(196,92,92,0.12);--amb:#c9a84c;--pur:#9b7ed8;--pur-d:rgba(155,126,216,0.12)}
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--t1)}
.landing{min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 20px}
.landing h1{font-size:32px;font-weight:700;letter-spacing:-0.03em;margin-bottom:4px}.landing .sub{font-size:13px;color:var(--t3);margin-bottom:40px}
.cgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;width:100%;max-width:920px}
.ccard{padding:24px;border:1px solid var(--bdr);border-radius:12px;background:var(--card);cursor:pointer;transition:all .2s}
.ccard:hover{border-color:var(--acc);transform:translateY(-2px)}.ccard.off{opacity:.35;cursor:not-allowed}.ccard.off:hover{border-color:var(--bdr);transform:none}
.ccard .em{font-size:28px;margin-bottom:12px}.ccard .nm{font-size:15px;font-weight:600;margin-bottom:4px}.ccard .ds{font-size:11px;color:var(--t3);line-height:1.5}
.ccard .bdg{display:inline-block;font-size:9px;font-weight:600;padding:2px 8px;border-radius:4px;margin-top:10px;text-transform:uppercase;letter-spacing:.05em}
.dash{display:flex;min-height:100vh}.side{width:220px;background:var(--card);border-right:1px solid var(--bdr);padding:20px 0;flex-shrink:0;display:flex;flex-direction:column}
.side-hd{padding:0 16px 16px;border-bottom:1px solid var(--bdr);margin-bottom:8px}.side-brand{font-size:14px;font-weight:700;color:var(--acc)}
.side-camp{font-size:10px;color:var(--t3);margin-top:2px}.side-back{font-size:11px;color:var(--t3);cursor:pointer;display:flex;align-items:center;gap:6px;margin-top:8px}.side-back:hover{color:var(--acc)}
.side-nav{flex:1;padding:4px 8px}.nav-i{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;font-size:12px;font-weight:500;color:var(--t2);cursor:pointer;transition:all .15s;margin-bottom:2px}
.nav-i:hover{background:var(--hover);color:var(--t1)}.nav-i.on{background:var(--acc-d);color:var(--acc)}
.nav-i .cnt{margin-left:auto;font-size:10px;font-family:'JetBrains Mono',monospace;background:var(--hover);padding:1px 6px;border-radius:4px}.nav-i.on .cnt{background:rgba(191,163,90,.2)}
.main{flex:1;padding:24px 32px;overflow-y:auto;max-height:100vh}
.ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}.pt{font-size:18px;font-weight:700;letter-spacing:-.02em}.pd{font-size:11px;color:var(--t3);margin-top:2px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border:1px solid var(--bdr);border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;transition:all .15s;font-family:'DM Sans',sans-serif;background:var(--card);color:var(--t1)}
.btn:hover{border-color:var(--bdr2);background:var(--hover)}.btn-p{background:var(--acc);border-color:var(--acc);color:#0a0a0c}.btn-p:hover{background:#d4b662}
.btn-d{background:var(--red-d);border-color:rgba(196,92,92,.3);color:var(--red)}.btn-ai{background:var(--acc-d);border-color:rgba(191,163,90,.3);color:var(--acc)}.btn-s{padding:5px 10px;font-size:11px}
.btn:disabled{opacity:.4;cursor:not-allowed}
.inp{width:100%;padding:8px 12px;background:var(--input);border:1px solid var(--bdr);border-radius:6px;color:var(--t1);font-size:12px;font-family:'DM Sans',sans-serif;outline:none}.inp:focus{border-color:var(--acc)}
.ta{min-height:60px;resize:vertical;line-height:1.5}
.tw{border:1px solid var(--bdr);border-radius:8px;overflow:hidden}table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;padding:10px 12px;background:var(--hover);color:var(--t3);font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--bdr)}
td{padding:10px 12px;border-bottom:1px solid var(--bdr);color:var(--t2)}tr:last-child td{border-bottom:none}tr:hover td{background:rgba(191,163,90,.03)}
.empty{text-align:center;padding:40px 20px;color:var(--t3)}.empty .em{font-size:32px;margin-bottom:12px}.empty p{font-size:12px;margin-bottom:12px}
.chip{display:inline-block;font-size:9px;font-weight:600;padding:2px 8px;border-radius:4px;text-transform:uppercase;letter-spacing:.03em}
.cg{background:var(--grn-d);color:var(--grn)}.cb{background:var(--blu-d);color:var(--blu)}.ca{background:var(--acc-d);color:var(--acc)}.cr{background:var(--red-d);color:var(--red)}.cp{background:var(--pur-d);color:var(--pur)}
.sb{display:flex;align-items:center;gap:8px}.st{flex:1;height:5px;background:var(--hover);border-radius:6px;overflow:hidden}.sf{height:100%;border-radius:6px}
.sv{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:500;width:28px;text-align:right}
.modal-o{position:fixed;inset:0;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;z-index:100}
.modal{background:var(--card);border:1px solid var(--bdr);border-radius:12px;width:90%;max-width:560px;max-height:85vh;overflow-y:auto}
.modal-h{padding:16px 20px;border-bottom:1px solid var(--bdr);display:flex;align-items:center;justify-content:space-between}.modal-b{padding:20px}
.modal-f{padding:12px 20px;border-top:1px solid var(--bdr);display:flex;justify-content:flex-end;gap:8px}
.ig{margin-bottom:14px}.il{display:block;font-size:10px;font-weight:600;color:var(--t3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.kt{display:inline-flex;align-items:center;font-size:10px;padding:3px 8px;border-radius:4px;background:var(--acc-d);color:var(--acc);border:1px solid rgba(191,163,90,.2);margin:2px;cursor:pointer}
.stag{font-size:10px;padding:4px 10px;border-radius:4px;border:1px solid var(--bdr);background:var(--input);color:var(--t3);cursor:pointer}.stag.sel{border-color:var(--acc);background:var(--acc-d);color:var(--acc)}
.fb{display:flex;align-items:center;gap:8px;margin-bottom:16px;flex-wrap:wrap}
.scan-s{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--card);border:1px solid var(--bdr);border-radius:8px;margin-bottom:16px}
.scan-d{width:8px;height:8px;border-radius:50%;background:var(--grn);animation:pulse 1.5s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.sld{flex:1;-webkit-appearance:none;height:4px;background:var(--hover);border-radius:4px;outline:none}
.sld::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:var(--acc);cursor:pointer}
.wt-row{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--bdr);border-radius:6px;margin-bottom:6px;background:var(--card)}
.wt-row .wt-name{flex:1;font-size:12px;color:var(--t1)}.wt-row .wt-pct{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--acc);min-width:40px;text-align:right}
.feat-tag{display:inline-flex;align-items:center;gap:4px;font-size:9px;padding:2px 8px;border-radius:4px;margin:2px}
`;

export default function SignalScope({ clientMode = false, fixedCampaignId = null }) {
  const [camp, setCamp] = useState(null); // active campaign object
  const [campaigns, setCampaigns] = useState(clientMode ? [] : DEFAULT_CAMPAIGNS);
  const [tab, setTab] = useState("dashboard");
  const [emailPrefilledLeadId, setEmailPrefilledLeadId] = useState(null);
  // Listen for "open email for lead" event fired from GA tab
  useEffect(() => {
    const handler = (e) => {
      setEmailPrefilledLeadId(e.detail?.leadId || null);
      setTab("email_campaign");
    };
    window.addEventListener("signalscope:open_email_for_lead", handler);
    return () => window.removeEventListener("signalscope:open_email_for_lead", handler);
  }, []);
  // Client mode auth
  const [clientAuth, setClientAuth] = useState(clientMode ? "loading" : "ok"); // loading | password | ok | error
  const [clientPw, setClientPw] = useState("");
  const [clientPwErr, setClientPwErr] = useState("");
  const [clientError, setClientError] = useState("");
  const [accounts, setAccounts] = useState([]);
  const [leads, setLeads] = useState([]);
  const [rules, setRules] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [threshold, setThreshold] = useState(70);
  const [loading, setLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProg, setScanProg] = useState(0);
  const [scanText, setScanText] = useState("");
  const scanRef = useRef(false);
  const taskSeenRef = useRef(new Set()); // tracks task fingerprints during scan to prevent dupes
  const [editRule, setEditRule] = useState(null); // unified rule editor — signal or top_x
  const [filter, setFilter] = useState({src:"all",target:"all",q:"",from:"",to:"",datePreset:"all"});
  const [csvModal, setCsvModal] = useState(null);
  const [csvUploadResult, setCsvUploadResult] = useState(null); // { msg, isError } — shows for ~8s after upload
  const [csvPrepping, setCsvPrepping] = useState(false); // shows toast "Preparing CSV upload..." while we fetch fresh records
  const [setupStatus, setSetupStatus] = useState(null);
  const [availableFields, setAvailableFields] = useState({ Accounts: [], Leads: [] });
  const [showAddCampaign, setShowAddCampaign] = useState(false);
  const [editingBase, setEditingBase] = useState(false);
  const [baseInput, setBaseInput] = useState("");
  const [baseConnecting, setBaseConnecting] = useState(false);
  const [baseError, setBaseError] = useState("");
  const [selectedTasks, setSelectedTasks] = useState(new Set());
  const [showExportModal, setShowExportModal] = useState(false);
  const [linkedinAccount, setLinkedinAccount] = useState(null);
  const [outreachStats, setOutreachStats] = useState(null);
  // AI usage stats — populated from the campaign record after each load.
  // Used to display per-client OpenAI cost on the dashboard for billing transparency.
  // Hidden in clientMode (admin-only billing data).
  const [aiUsage, setAiUsage] = useState(null); // {inputTokens, outputTokens, totalCostUSD, callsCount, lastCallAt, resetAt}
  const [aiUsageLoading, setAiUsageLoading] = useState(false);
  // Same pattern for RapidAPI (Lead Movement Scan) usage — separate cost line
  const [rapidApiUsage, setRapidApiUsage] = useState(null); // {totalCostUSD, callsCount, lastCallAt, resetAt, perCallCostUSD}
  const [rapidApiUsageLoading, setRapidApiUsageLoading] = useState(false);
  const [outreachItems, setOutreachItems] = useState([]);
  const [outreachLoading, setOutreachLoading] = useState(false);
  // Outreach queue UI filter — by default hides terminal/audit-trail statuses
  // (skipped, completed, replied, error) to keep the table scannable. The
  // historical records still exist in Airtable but don't clutter the view.
  // Click "Show history" to flip and reveal them.
  const [outreachShowHistory, setOutreachShowHistory] = useState(false);
  const [outreachCleanupRunning, setOutreachCleanupRunning] = useState(false);
  // Cron health — polled once on LinkedIn Automation tab mount.
  // Reads /api/cron/outreach/status which returns last N runs from the
  // Cron Run Log table in the master base. State === null means "not fetched yet";
  // state === false means "fetch failed".
  const [cronStatus, setCronStatus] = useState(null);
  // HubSpot
  const [hsConnected, setHsConnected] = useState(false);
  const [hsKey, setHsKey] = useState(""); // input field
  const hsApiKeyRef = useRef(""); // actual stored key
  const [hsMasked, setHsMasked] = useState("");
  const [hsOwners, setHsOwners] = useState([]);
  const [hsLoading, setHsLoading] = useState(false);
  const [hsMsg, setHsMsg] = useState("");
  const [repairModal, setRepairModal] = useState(null); // { step: "config" | "preview" | "running" | "done", ... }
  const [backfillRunning, setBackfillRunning] = useState(false);
  const [backfillMsg, setBackfillMsg] = useState("");
  // Enrichment
  const [enrichModal, setEnrichModal] = useState(null); // { mode: "enrich" | "push", tasks: [] }
  const [enrichLoading, setEnrichLoading] = useState(false);
  const [enrichResults, setEnrichResults] = useState([]);
  const [campTagFilter, setCampTagFilter] = useState("all");
  const [engagementFilter, setEngagementFilter] = useState("all");
  const [sortByEngagement, setSortByEngagement] = useState(false);
  // Post-Demo
  const [pdRule, setPdRule] = useState({ name: "Post-Demo Follow-up", stageId: "", stageName: "", pipelineId: "", aiPrompt: "" });
  const [pdPipelines, setPdPipelines] = useState([]);
  const [pdStagePreview, setPdStagePreview] = useState(null);
  const [pdPreview, setPdPreview] = useState(null);
  const [pdResults, setPdResults] = useState(null);
  const [pdLoading, setPdLoading] = useState(false);
  const [showLeadMovementModal, setShowLeadMovementModal] = useState(false);

  const bid = camp?.baseId || undefined; // current campaign's base

  // ─── Feature flags — derived from initial config + actual rules ──
  // Initial selection personalizes first run, but the campaign adapts
  // as users add new task types. If you picked only Top X but later
  // add a news rule, the signal scanning UI appears automatically.
  const configFeatures = camp?.features || [];
  const ruleTaskTypes = rules.map(r => (r.fields || {})["Task Type"]).filter(Boolean);
  const hasNews = configFeatures.includes("news") || ruleTaskTypes.some(t => t === "news" || t === "both");
  const hasJobs = configFeatures.includes("job_posts") || ruleTaskTypes.some(t => t === "job_post" || t === "both");
  const hasTopX = configFeatures.includes("top_x") || ruleTaskTypes.includes("top_x");
  const hasOutreach = configFeatures.includes("linkedin_outreach") || ruleTaskTypes.includes("linkedin_outreach");
  const hasSignals = hasNews || hasJobs;
  // Combined active features (for display in sidebar)
  const activeFeatures = [...new Set([
    ...configFeatures,
    ...(ruleTaskTypes.some(t => t === "news" || t === "both") ? ["news"] : []),
    ...(ruleTaskTypes.some(t => t === "job_post" || t === "both") ? ["job_posts"] : []),
    ...(ruleTaskTypes.includes("top_x") ? ["top_x"] : []),
    ...(ruleTaskTypes.includes("linkedin_outreach") ? ["linkedin_outreach"] : []),
  ])];

  // ─── Load campaign registry from master base ──────────────
  useEffect(() => {
    if (clientMode && fixedCampaignId) {
      // Client mode: load single campaign by ID
      (async () => {
        try {
          const res = await fetch("/api/airtable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "get_campaign", campaignId: fixedCampaignId }) });
          const d = await res.json();
          console.log("[CLIENT] Campaign load:", d);
          if (d.error || !d.id) { console.error("[CLIENT] Campaign error:", d.error); setClientError(d.error || "No campaign ID returned"); setClientAuth("error"); return; }
          const c = { id: "client_" + d.id, airtableId: d.id, name: d.fields?.Name || "Campaign", emoji: d.fields?.Emoji || "📊", desc: d.fields?.Description || "", badge: "Active", active: true, features: (d.fields?.Features || "").split(",").map(s => s.trim()).filter(Boolean), baseId: d.fields?.["Base ID"] || null };
          if (d.hasPassword) { setClientAuth("password"); window.__pendingCamp = c; }
          else { setClientAuth("ok"); setCamp(c); }
        } catch (e) { console.error("[CLIENT] Load failed:", e); setClientError(e.message || "Network error"); setClientAuth("error"); }
      })();
      return;
    }
    // SECURITY: NEVER call list_campaigns in clientMode. Even though clientMode short-circuits
    // above, defense-in-depth: if clientMode flag is set we don't enumerate campaigns.
    if (clientMode) return;
    (async () => {
      try {
        const res = await at("list_campaigns", "");
        const recs = res.records || [];
        const userCamps = recs.map(r => {
          const f = r.fields || {};
          return {
            id: "user_" + r.id, airtableId: r.id,
            name: f.Name || "Untitled", emoji: f.Emoji || "📊",
            desc: f.Description || "", badge: f.Status || "Active",
            active: (f.Status || "Active") !== "Disabled",
            features: (f.Features || "").split(",").map(s => s.trim()).filter(Boolean),
            baseId: f["Base ID"] || null, tables: f.Tables || "",
          };
        });
        // Deduplicate: if a default campaign exists in Airtable, skip the default
        const userNames = new Set(userCamps.map(c => c.name.toLowerCase().trim()));
        const dedupedDefaults = DEFAULT_CAMPAIGNS.filter(d => !userNames.has(d.name.toLowerCase().trim()));
        setCampaigns([...dedupedDefaults, ...userCamps]);
      } catch (e) { console.log("Could not load campaigns:", e.message); }
    })();
  }, []);

  useEffect(() => {
    if (camp) {
      // Reset state for new campaign
      setAccounts([]); setLeads([]); setRules([]); setTasks([]);
      setFilter({src:"all",target:"all",q:"",from:"",to:"",datePreset:"all"});
      setSetupStatus(null); setAvailableFields({ Accounts: [], Leads: [] });
      setEditingBase(false); setBaseInput(""); setBaseError("");
      setSelectedTasks(new Set()); setShowExportModal(false);
      setLinkedinAccount(null); setOutreachStats(null); setOutreachItems([]);
      setTab("dashboard");
      loadAll();
      fetchAvailableFields();
      loadLinkedInAccounts();
      loadHubSpot();
    }
  }, [camp]);

  const validateClientPw = async () => {
    const res = await fetch("/api/airtable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "validate_client", campaignId: fixedCampaignId, password: clientPw }) });
    const d = await res.json();
    if (d.valid) {
      // SECURITY: if pendingCamp was lost (page reload, multi-tab, etc), DO NOT fall through
      // to landing page. Force error state instead.
      const pending = window.__pendingCamp;
      if (!pending) { setClientError("Session lost. Please reload the page."); setClientAuth("error"); return; }
      setClientAuth("ok");
      setCamp(pending);
    }
    else setClientPwErr("Incorrect password");
  };

  const loadAll = async () => {
    setLoading(true);
    // Load each table independently — one missing table/field shouldn't block others
    const safeLoad = async (table, params = {}) => {
      try { return await at("list", table, params, bid); }
      catch (e) { console.warn(`Load ${table}:`, e.message); return { records: [] }; }
    };
    const [a, l, r, t] = await Promise.all([
      safeLoad("Accounts"), safeLoad("Leads"), safeLoad("Task Rules"), safeLoad("Tasks"),
    ]);
    setAccounts(a.records || []);
    setLeads(l.records || []);
    setRules(r.records || []);
    // Sort tasks by Created client-side (safe even if field doesn't exist)
    const taskRecs = (t.records || []).sort((a, b) => ((b.fields?.Created || "") > (a.fields?.Created || "") ? 1 : -1));
    setTasks(taskRecs);
    setLoading(false);
  };

  const fetchAvailableFields = async () => {
    try {
      const [af, lf] = await Promise.all([
        at("get_fields","Accounts",{},bid).catch(() => ({ fields: [] })),
        at("get_fields","Leads",{},bid).catch(() => ({ fields: [] })),
      ]);
      const fresh = { Accounts: af.fields || [], Leads: lf.fields || [] };
      setAvailableFields(fresh);
      // Also return the fresh data so callers can use it immediately —
      // setAvailableFields is async, so the closure that called us still
      // sees the OLD state until React re-renders. This avoids that race.
      return fresh;
    } catch (e) {
      console.error(e);
      return { Accounts: [], Leads: [] };
    }
  };

  const del = async (table, ids, setter) => { try{await at("delete",table,{recordIds:ids},bid);setter(p=>p.filter(r=>!ids.includes(r.id)))} catch(e){console.error(e)} };

  // ─── Outreach helpers ──────────────────────────────────────
  const outreachAPI = async (action, data = {}) => {
    // campaignId for AI cost tracking — billing attribution
    const res = await fetch("/api/outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, baseId: bid, campaignId: camp?.airtableId, ...data }) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { error: text.slice(0, 300) }; }
    if (!res.ok) return { ...body, _httpStatus: res.status, _httpOk: false };
    return body;
  };

  const [linkedinError, setLinkedinError] = useState("");
  const [manualModal, setManualModal] = useState(null); // { mode: "select_leads" | "send_requests" | "trigger_dms", ... }

  const connectLinkedIn = async () => {
    setLinkedinError("");
    try {
      const data = await outreachAPI("get_auth_link", { callbackUrl: window.location.href });
      if (data.url) {
        // Track current healthy account IDs — any NEW ones after popup closes is the just-connected one
        const beforeIds = new Set(allHealthyAccounts.map(a => a.id));
        const popup = window.open(data.url, "_blank", "width=600,height=700");
        if (!popup || popup.closed) {
          setLinkedinError("Popup blocked — allow popups for this site and try again");
          return;
        }
        setLinkedinError("🔗 Auth window opened — complete login then come back. Auto-assigning to this campaign once connected...");

        // Poll for popup close, then check for new account
        const pollInterval = setInterval(async () => {
          if (popup.closed) {
            clearInterval(pollInterval);
            // Give Unipile a moment to register the account
            setTimeout(async () => {
              try {
                const d = await outreachAPI("list_accounts");
                const items = d.items || d.accounts || (Array.isArray(d) ? d : []);
                const linkedinItems = items.filter(a => (a.type || a.provider || "").toUpperCase() === "LINKEDIN");
                const nowHealthy = linkedinItems.filter(a => (a.sources || []).some(s => (s.status || "").toUpperCase() === "OK"));
                const newAccount = nowHealthy.find(a => !beforeIds.has(a.id || a.account_id));
                if (newAccount && camp?.airtableId) {
                  const newId = newAccount.id || newAccount.account_id;
                  await outreachAPI("save_assigned_account", { campaignId: camp.airtableId, accountId: newId });
                  setLinkedinError(`✅ Connected ${newAccount.name || "new account"} and assigned to ${camp.name}`);
                  await loadLinkedInAccounts();
                } else {
                  await loadLinkedInAccounts();
                  setLinkedinError("✓ Auth window closed. If the account is connected, pick it from the list to assign.");
                }
              } catch (e) { console.error(e); }
            }, 2000);
          }
        }, 1000);
        // Safety timeout after 10 min
        setTimeout(() => clearInterval(pollInterval), 600000);
      } else if (data.error) {
        setLinkedinError((data.error || "") + (data.hint ? " — " + data.hint : "") + (data.details ? " | " + JSON.stringify(data.details).slice(0, 200) : ""));
      } else {
        setLinkedinError("Unknown response: " + JSON.stringify(data).slice(0, 200));
      }
    } catch (e) { setLinkedinError(e.message); }
  };
  const testUnipile = async () => {
    setLinkedinError("🧪 Testing...");
    try {
      const data = await outreachAPI("test_unipile");
      const lines = [];
      if (data.ok) lines.push("✅ " + (data.message || "Connection healthy"));
      else lines.push("❌ " + (data.error || "Test failed"));
      if (data.hint) lines.push("💡 " + data.hint);
      if (data.tests) {
        lines.push("—");
        lines.push("DSN set: " + (data.tests.dsn_set ? "✅" : "❌") + (data.tests.dsn_value ? ` (${data.tests.dsn_value})` : ""));
        lines.push("API key set: " + (data.tests.key_set ? "✅" : "❌") + (data.tests.key_length ? ` (length ${data.tests.key_length})` : ""));
        if (data.tests.request_url) lines.push("Request URL: " + data.tests.request_url);
        if (data.tests.canListAccounts !== undefined) lines.push("Can list accounts: " + (data.tests.canListAccounts ? "✅" : "❌ " + (data.tests.accountsError || data.tests.accountsStatus)));
      }
      setLinkedinError(lines.join("\n"));
    } catch (e) { setLinkedinError("❌ " + e.message); }
  };
  const disconnectLinkedIn = async () => {
    if (!linkedinAccount?.id) return;
    const choice = confirm(`Fully DELETE ${linkedinAccount.name} from Unipile?\n\n• OK = Delete permanently from Unipile (affects all campaigns using this account)\n• Cancel = Just unassign from this campaign (account stays in Unipile)`);
    try {
      setOutreachLoading(true);
      if (choice) {
        await outreachAPI("disconnect_account", { accountId: linkedinAccount.id });
        setLinkedinError("✅ Deleted from Unipile");
      }
      // Either way, unassign from this campaign
      if (camp?.airtableId) {
        await outreachAPI("save_assigned_account", { campaignId: camp.airtableId, accountId: "" });
      }
      setLinkedinAccount(null);
      await loadLinkedInAccounts();
      if (!choice) setLinkedinError("✅ Unassigned from this campaign");
    } catch (e) { setLinkedinError("❌ " + e.message); }
    setOutreachLoading(false);
  };

  const [disconnectedAccounts, setDisconnectedAccounts] = useState([]);
  const [allHealthyAccounts, setAllHealthyAccounts] = useState([]); // all OK LinkedIn accounts across Unipile

  const loadLinkedInAccounts = async () => {
    try {
      const data = await outreachAPI("list_accounts");
      const items = data.items || data.accounts || (Array.isArray(data) ? data : []);
      const linkedinItems = items.filter(a => (a.type || a.provider || "").toUpperCase() === "LINKEDIN");
      const isHealthy = (a) => {
        const sources = a.sources || [];
        if (sources.length === 0) return false;
        return sources.some(s => (s.status || "").toUpperCase() === "OK");
      };
      const healthy = linkedinItems.filter(isHealthy);
      const dead = linkedinItems.filter(a => !isHealthy(a));
      setDisconnectedAccounts(dead.map(a => ({ id: a.id || a.account_id, name: a.name || "LinkedIn" })));

      const healthyMapped = healthy.map(a => ({
        id: a.id || a.account_id,
        name: a.name || a.connection_params?.im_username || "LinkedIn",
        email: a.connection_params?.mail || a.connection_params?.im_username || "",
      }));
      setAllHealthyAccounts(healthyMapped);

      // Which account is assigned to THIS campaign?
      let assignedId = null;
      if (camp?.airtableId) {
        try {
          const r = await outreachAPI("get_assigned_account", { campaignId: camp.airtableId });
          assignedId = r.accountId || null;
        } catch {}
      }

      if (assignedId && healthyMapped.find(a => a.id === assignedId)) {
        // Use the campaign's assigned account
        const li = healthyMapped.find(a => a.id === assignedId);
        setLinkedinAccount({ id: li.id, name: li.name, email: li.email, type: "LINKEDIN" });
      } else if (assignedId && !healthyMapped.find(a => a.id === assignedId)) {
        // Assigned account is missing/disconnected — show as unassigned
        setLinkedinAccount(null);
        if (dead.find(a => a.id === assignedId)) {
          setLinkedinError(`⚠️ The LinkedIn account assigned to this campaign is disconnected. Reconnect it or pick a different account below.`);
        } else {
          setLinkedinError(`⚠️ The LinkedIn account assigned to this campaign no longer exists in Unipile. Pick a different account below.`);
        }
      } else {
        // No assignment — don't auto-pick. Make user explicitly assign one to avoid sending from wrong account.
        setLinkedinAccount(null);
      }
    } catch (e) { console.log("No LinkedIn accounts:", e.message); }
  };

  const assignAccountToCampaign = async (accountId) => {
    if (!camp?.airtableId) { setLinkedinError("No campaign loaded"); return; }
    setOutreachLoading(true);
    try {
      const r = await outreachAPI("save_assigned_account", { campaignId: camp.airtableId, accountId });
      if (r.ok) {
        // Optimistic update — set linkedinAccount immediately so UI flips to connected state
        if (accountId) {
          const acc = allHealthyAccounts.find(a => a.id === accountId);
          if (acc) {
            setLinkedinAccount({ id: acc.id, name: acc.name, email: acc.email, type: "LINKEDIN" });
            setLinkedinError(`✅ Assigned ${acc.name} to ${camp.name}`);
          } else {
            setLinkedinError("✅ Account assigned (refreshing...)");
          }
        } else {
          setLinkedinAccount(null);
          setLinkedinError("✅ Unassigned from this campaign");
        }
        // Background refresh to confirm
        loadLinkedInAccounts();
      } else {
        setLinkedinError(r.error || "Failed to assign");
      }
    } catch (e) { setLinkedinError(e.message); }
    setOutreachLoading(false);
  };

  const reconnectAccount = async (accountId) => {
    setLinkedinError("🔄 Generating reconnect link...");
    try {
      const data = await outreachAPI("get_auth_link", { callbackUrl: window.location.href, reconnectAccountId: accountId });
      if (data.url) {
        const popup = window.open(data.url, "_blank", "width=600,height=700");
        if (!popup || popup.closed) setLinkedinError("Popup blocked — allow popups for this site and try again");
        else setLinkedinError("✅ Reconnect window opened — complete auth in the popup, then click Refresh.");
      } else if (data.error) {
        setLinkedinError((data.error || "") + (data.hint ? " — " + data.hint : ""));
      } else {
        setLinkedinError("Unknown response: " + JSON.stringify(data).slice(0, 200));
      }
    } catch (e) { setLinkedinError(e.message); }
  };

  const removeAccount = async (accountId, name) => {
    if (!confirm(`Remove ${name} from Unipile permanently? Use this if you don't want to reconnect.`)) return;
    setOutreachLoading(true);
    try {
      await outreachAPI("disconnect_account", { accountId });
      setLinkedinError(`✅ Removed ${name}`);
      await loadLinkedInAccounts();
    } catch (e) { setLinkedinError("❌ " + e.message); }
    setOutreachLoading(false);
  };

  const cleanupDisconnectedAccounts = async () => {
    if (disconnectedAccounts.length === 0) return;
    if (!confirm(`Delete ${disconnectedAccounts.length} disconnected LinkedIn account${disconnectedAccounts.length!==1?"s":""} from Unipile? This frees up your account slots.`)) return;
    setOutreachLoading(true);
    let deleted = 0;
    for (const a of disconnectedAccounts) {
      try { await outreachAPI("disconnect_account", { accountId: a.id }); deleted++; }
      catch (e) { console.error("Cleanup failed for", a.id, e); }
    }
    setLinkedinError(`✅ Cleaned up ${deleted} disconnected account${deleted!==1?"s":""}`);
    await loadLinkedInAccounts();
    setOutreachLoading(false);
  };

  const loadOutreachStats = async (campaign) => {
    try {
      setOutreachLoading(true);
      const data = await outreachAPI("get_stats", { campaign });
      setOutreachStats(data.stats || null);
      setOutreachItems(data.items || []);
    } catch (e) { console.error("Outreach stats error:", e); }
    setOutreachLoading(false);
    // Fetch cron health in parallel — cheap read, gives us a health indicator
    // chip next to the queue. Failure is non-fatal; chip just won't show.
    try {
      const r = await fetch("/api/cron/outreach/status?limit=10", { cache: "no-store" });
      if (r.ok) {
        const data = await r.json();
        setCronStatus(data.ok ? data : false);
      } else {
        setCronStatus(false);
      }
    } catch { setCronStatus(false); }
  };

  // Load AI usage stats from the Campaign record. Read the same get_campaign
  // endpoint used elsewhere — fields are passed through (except HubSpot key/pw).
  // Hidden in clientMode; admin sees per-client cost on dashboard for billing.
  const loadAIUsage = async () => {
    if (clientMode) return; // never load billing data in client mode
    if (!camp?.airtableId) return;
    try {
      setAiUsageLoading(true);
      const res = await fetch("/api/airtable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_campaign", campaignId: camp.airtableId }),
      });
      if (!res.ok) { setAiUsage(null); return; }
      const data = await res.json();
      const f = data.fields || {};
      setAiUsage({
        inputTokens: f["AI Total Input Tokens"] || 0,
        outputTokens: f["AI Total Output Tokens"] || 0,
        totalCostUSD: f["AI Total Cost USD"] || 0,
        callsCount: f["AI Calls Count"] || 0,
        lastCallAt: f["AI Last Call At"] || null,
        resetAt: f["AI Usage Reset At"] || null,
      });
    } catch (e) {
      console.error("AI usage load error:", e);
      setAiUsage(null);
    } finally {
      setAiUsageLoading(false);
    }
  };

  // Reset the AI usage counters back to zero. Used after monthly invoicing.
  // Confirmation dialog because this is destructive (lost reset history is unrecoverable).
  const resetAIUsage = async () => {
    if (clientMode) return;
    if (!camp?.airtableId) return;
    if (!confirm("Reset AI usage counters to zero?\n\nThis is for billing cycles — typically you'd run this AFTER invoicing the client for the previous period. The reset is permanent.")) return;
    try {
      const res = await fetch("/api/airtable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_ai_usage", campaignId: camp.airtableId }),
      });
      const data = await res.json();
      if (data.ok) {
        setMsg("✅ AI usage counters reset");
        await loadAIUsage();
      } else {
        setMsg("❌ Reset failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      setMsg("❌ Reset failed: " + e.message);
    }
  };

  // Load RapidAPI usage stats from the Campaign record. Same get_campaign
  // endpoint as AI usage; parses different field set. Admin-only.
  const loadRapidAPIUsage = async () => {
    if (clientMode) return;
    if (!camp?.airtableId) return;
    try {
      setRapidApiUsageLoading(true);
      const res = await fetch("/api/airtable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "get_campaign", campaignId: camp.airtableId }),
      });
      if (!res.ok) { setRapidApiUsage(null); return; }
      const data = await res.json();
      const f = data.fields || {};
      setRapidApiUsage({
        totalCostUSD: f["RapidAPI Total Cost USD"] || 0,
        callsCount: f["RapidAPI Calls Count"] || 0,
        lastCallAt: f["RapidAPI Last Call At"] || null,
        resetAt: f["RapidAPI Usage Reset At"] || null,
        perCallCostUSD: f["RapidAPI Per Call Cost USD"] || 0.01,
      });
    } catch (e) {
      console.error("RapidAPI usage load error:", e);
      setRapidApiUsage(null);
    } finally {
      setRapidApiUsageLoading(false);
    }
  };

  // Reset RapidAPI counters — same billing-cycle pattern as AI reset.
  const resetRapidAPIUsage = async () => {
    if (clientMode) return;
    if (!camp?.airtableId) return;
    if (!confirm("Reset RapidAPI (Lead Movement) usage counters to zero?\n\nThis is for billing cycles — typically you'd run this AFTER invoicing the client for the previous period. The reset is permanent.")) return;
    try {
      const res = await fetch("/api/airtable", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reset_rapidapi_usage", campaignId: camp.airtableId }),
      });
      const data = await res.json();
      if (data.ok) {
        setMsg("✅ RapidAPI usage counters reset");
        await loadRapidAPIUsage();
      } else {
        setMsg("❌ Reset failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      setMsg("❌ Reset failed: " + e.message);
    }
  };

  // Load AI usage when dashboard is shown — refresh on every tab visit so cost
  // updates show immediately after a scan/AI operation. Skipped in clientMode.
  useEffect(() => {
    if (tab === "dashboard" && !clientMode && camp?.airtableId) {
      loadAIUsage();
      loadRapidAPIUsage();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, camp?.airtableId, clientMode]);

  const enqueueLeads = async (ruleConfig) => {
    try {
      setOutreachLoading(true);
      const data = await outreachAPI("enqueue_leads", { ruleConfig });
      if (data.enqueued > 0) await loadOutreachStats(ruleConfig.name);
      return data;
    } catch (e) { console.error(e); return { error: e.message }; }
    finally { setOutreachLoading(false); }
  };

  const runOutreachNow = async (rule) => {
    const f = rule.fields || {};
    let config; try { config = JSON.parse(f["Outreach Config"] || "{}"); } catch { config = {}; }
    if (!linkedinAccount?.id) { alert("Connect your LinkedIn account first"); return; }
    try {
      setOutreachLoading(true);
      const data = await outreachAPI("process_queue", { accountId: linkedinAccount.id, ruleConfig: { ...config, name: f.Name } });
      await loadOutreachStats(f.Name);
      return data;
    } catch (e) { console.error(e); }
    finally { setOutreachLoading(false); }
  };

  // ─── HubSpot helpers ───────────────────────────────────────
  const hsAPI = async (action, data = {}) => {
    const payload = { action, campaignId: camp?.airtableId, ...data };
    if (hsApiKeyRef.current && !payload.apiKey) payload.apiKey = hsApiKeyRef.current;
    const res = await fetch("/api/hubspot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    return res.json();
  };
  const loadHubSpot = async () => { try { const d = await hsAPI("get_stored_key"); if (d.hasKey) { setHsConnected(true); setHsMasked(d.maskedKey || ""); if (d.rawKey) hsApiKeyRef.current = d.rawKey; loadHsOwners(); } } catch {} };
  const connectHubSpot = async (key) => {
    setHsLoading(true); setHsMsg("");
    try { const d = await hsAPI("save_key", { apiKey: key }); if (d.ok) { hsApiKeyRef.current = key; setHsConnected(true); setHsMasked("****" + key.slice(-4)); setHsKey(""); setHsMsg("✅ Connected"); loadHsOwners(); } else setHsMsg("❌ " + (d.error || "Failed")); }
    catch (e) { setHsMsg("❌ " + e.message); } setHsLoading(false);
  };
  const loadHsOwners = async () => { try { const d = await hsAPI("fetch_owners"); setHsOwners(d.owners || []); } catch {} };
  const pushToHubSpot = async (tasksToPush, config) => {
    setHsLoading(true); setHsMsg("⏳ Looking up contact info for association...");
    try {
      // Build a quick lookup map from leads: Name → {email, linkedin, title, ...}
      const leadLookup = {};
      (leads || []).forEach(l => {
        const f = l.fields || {};
        const name = (f.Name || "").trim().toLowerCase();
        if (name) leadLookup[name] = {
          email: f.Email || "",
          linkedinUrl: f["LinkedIn URL"] || "",
          title: f.Title || "",
          firstName: (f.Name || "").split(" ")[0] || "",
          lastName: (f.Name || "").split(" ").slice(1).join(" ") || "",
        };
      });

      const mapped = tasksToPush.map(t => {
        const f = t.fields || t;
        const leadName = (f["Scan Target"] || f["Lead Name"] || "").trim().toLowerCase();
        const leadInfo = leadLookup[leadName] || {};
        return {
          airtableId: t.id, // so backend can save HubSpot ID back
          hubspotTaskId: f["HubSpot Task ID"] || "", // existing task? update instead of create
          "HubSpot Last Synced Hash": f["HubSpot Last Synced Hash"] || "", // for skip-if-unchanged
          Company: f.Company,
          "Task Rule": f["Task Rule"],
          Score: f.Score,
          Signal: f.Signal,
          URL: f.URL,
          Date: f.Date,
          "Lead Name": f["Lead Name"] || f["Scan Target"] || "",
          "Lead Title": f["Lead Title"] || leadInfo.title || "",
          "Scan Target": f["Scan Target"] || "",
          Phone: f.Phone || "",
          Email: f.Email || leadInfo.email || "",
          LinkedinUrl: f["LinkedIn URL"] || leadInfo.linkedinUrl || "",
          FirstName: leadInfo.firstName || "",
          LastName: leadInfo.lastName || "",
        };
      });

      // Pre-flight breakdown
      const withHubspotId = mapped.filter(m => m.hubspotTaskId).length;
      const willCreate = mapped.length - withHubspotId;
      const withEmail = mapped.filter(m => m.Email).length;
      const withLinkedIn = mapped.filter(m => m.LinkedinUrl).length;
      const withPhone = mapped.filter(m => m.Phone).length;
      setHsMsg(`⏳ Pushing ${mapped.length} tasks: ${willCreate} new + ${withHubspotId} updates · 📧 ${withEmail} email · 🔗 ${withLinkedIn} LinkedIn · 📞 ${withPhone} phone...`);

      console.log("[pushToHubSpot] sending", mapped.length, "tasks |", willCreate, "new /", withHubspotId, "updates |", withEmail, "emails /", withLinkedIn, "LinkedIn /", withPhone, "phone");
      const d = await hsAPI("push_tasks", { tasks: mapped, config, baseId: bid });
      console.log("[pushToHubSpot] response:", d);
      let toast = "";
      if (d.error) {
        toast = `❌ ${d.error}`;
      } else if (d.created > 0 || d.updated > 0 || d.unchanged > 0) {
        const parts = [];
        if (d.created > 0) parts.push(`✅ ${d.created} created`);
        if (d.updated > 0) parts.push(`🔄 ${d.updated} updated (body refreshed in HubSpot)`);
        if (d.unchanged > 0) parts.push(`✨ ${d.unchanged} unchanged (no HubSpot API call needed)`);
        if (d.skipped > 0) parts.push(`⏭️ ${d.skipped} skipped`);
        if (typeof d.associated === "number" && d.associated > 0) parts.push(`🔗 ${d.associated} linked to contacts`);
        if (typeof d.notAssociated === "number" && d.notAssociated > 0) parts.push(`⚠️ ${d.notAssociated} unlinked (contact not in HubSpot)`);
        if (d.airtableSynced) parts.push(`💾 ${d.airtableSynced} IDs saved to Airtable`);
        if (d.errors?.length) parts.push(`❌ ${d.errors.length} errors: ${d.errors[0]?.slice(0, 100)}`);
        toast = parts.join(" · ");
      } else if (d.skipped > 0) {
        toast = `⏭️ All ${d.skipped} tasks were skipped (mode=skip_existing). Use 'Smart' mode to update them.`;
      } else if (d.errors?.length) {
        toast = `❌ Push failed: ${d.errors[0]}`;
      } else {
        toast = `⚠️ HubSpot accepted the request but reported 0 changes. Sent ${mapped.length}, breakdown: ${withHubspotId} updates / ${willCreate} new. Response: ${JSON.stringify(d).slice(0, 200)}`;
      }
      setHsMsg(toast);
      setTimeout(() => setHsMsg(""), 30000);

      // Refresh tasks so UI reflects the new HubSpot Task IDs
      if (d.airtableSynced > 0) {
        try {
          const refreshed = await at("list", "Tasks", {}, bid);
          if (refreshed?.records) setTasks(refreshed.records.sort((a, b) => ((b.fields?.Created || "") > (a.fields?.Created || "") ? 1 : -1)));
        } catch {}
      }
    } catch (e) { setHsMsg("❌ " + e.message); } setHsLoading(false);
  };
  const pushLeadsToHS = async (leadsToPush, config) => {
    setHsLoading(true); setHsMsg("");
    try {
      const mapped = leadsToPush.map(l => { const f = l.fields || l; return { name: f.Name || "", email: f.Email || "", phone: f.Phone || "", company: f.Company || "", title: f.Title || "", linkedinUrl: f["LinkedIn URL"] || "", website: f.Domain || f.Website || "", city: f.City || "", state: f.State || "", country: f.Country || "" }; });
      const d = await hsAPI("push_leads", { leads: mapped, config });
      const parts = [];
      if (d.created) parts.push(`${d.created} created`);
      if (d.alreadyExist) parts.push(`${d.alreadyExist} already existed (skipped)`);
      if (d.skipped) parts.push(`${d.skipped} skipped (no email/name)`);
      if (d.errors?.length) parts.push(`${d.errors.length} errors`);
      setHsMsg(parts.length ? (d.created > 0 ? "✅ " : "ℹ️ ") + parts.join(", ") : "❌ No leads pushed");
    } catch (e) { setHsMsg("❌ " + e.message); } setHsLoading(false);
  };

  // ─── Orphaned task repair ─────────────────────────────────
  const openRepairModal = () => {
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    setRepairModal({
      step: "config",
      dateFrom: weekAgo.toISOString().slice(0, 10),
      dateTo: now.toISOString().slice(0, 10),
      subjectContains: "",
      preview: null,
      running: false,
      result: null,
      error: "",
    });
  };
  const runRepairPreview = async () => {
    setRepairModal(m => ({ ...m, running: true, error: "" }));
    try {
      const d = await hsAPI("find_orphaned_tasks", {
        baseId: bid,
        dateFrom: repairModal.dateFrom ? new Date(repairModal.dateFrom).toISOString() : undefined,
        dateTo: repairModal.dateTo ? new Date(new Date(repairModal.dateTo).getTime() + 86400000).toISOString() : undefined, // include full "to" day
        subjectContains: repairModal.subjectContains || undefined,
      });
      if (d.error) {
        setRepairModal(m => ({ ...m, running: false, error: d.error }));
      } else {
        setRepairModal(m => ({ ...m, running: false, step: "preview", preview: d }));
      }
    } catch (e) {
      setRepairModal(m => ({ ...m, running: false, error: e.message }));
    }
  };
  const executeRepair = async () => {
    if (!repairModal?.preview?.pairs?.length) return;
    setRepairModal(m => ({ ...m, running: true, step: "running", error: "" }));
    try {
      const d = await hsAPI("repair_orphaned_tasks", {
        taskContactPairs: repairModal.preview.pairs,
        baseId: bid,
      });
      setRepairModal(m => ({ ...m, running: false, step: "done", result: d }));
    } catch (e) {
      setRepairModal(m => ({ ...m, running: false, error: e.message, step: "preview" }));
    }
  };

  const runBackfillIds = async () => {
    if (!confirm("This will scan HubSpot tasks from the last 60 days, match them to your Airtable tasks, and write their HubSpot IDs back.\n\nSafe operation — does NOT modify any HubSpot data. Only updates Airtable.\n\nProceed?")) return;
    setBackfillRunning(true);
    setBackfillMsg("⏳ Scanning HubSpot tasks and matching to Airtable...");
    try {
      const d = await hsAPI("backfill_hubspot_ids", {
        baseId: bid,
        dateFrom: new Date(Date.now() - 60 * 86400000).toISOString(),
        dateTo: new Date().toISOString(),
      });
      console.log("[backfill] response:", d);
      if (d.error) {
        setBackfillMsg("❌ " + d.error);
      } else {
        const parts = [];
        parts.push(`Scanned ${d.totalHubspotTasks} HubSpot tasks`);
        if (d.newlyMatched > 0) parts.push(`💾 ${d.newlyMatched} IDs newly written to Airtable`);
        if (d.alreadyTracked > 0) parts.push(`✓ ${d.alreadyTracked} already tracked`);
        if (d.airtableSynced > 0) parts.push(`✅ ${d.airtableSynced} synced`);
        if (d.airtableSyncFailed > 0) parts.push(`⚠️ ${d.airtableSyncFailed} Airtable writes failed`);
        if (d.ambiguous > 0) parts.push(`⚠️ ${d.ambiguous} ambiguous (skipped)`);
        if (d.unmatched > 0) parts.push(`❓ ${d.unmatched} unmatched`);
        const icon = d.airtableSynced > 0 ? "✅" : (d.unmatched > 0 || d.ambiguous > 0 ? "⚠️" : "ℹ️");
        setBackfillMsg(`${icon} ${parts.join(" · ")}\n\nRun ID: ${d.runId} — search Vercel logs by [backfill:${d.runId}]`);
      }
      // Refresh tasks so the newly-populated "HubSpot Task ID" column shows up
      try {
        const refreshed = await at("list", "Tasks", {}, bid);
        if (refreshed?.records) {
          setTasks(refreshed.records.sort((a, b) => ((b.fields?.Created || "") > (a.fields?.Created || "") ? 1 : -1)));
        }
      } catch (e) { console.warn("Task refresh failed:", e.message); }
    } catch (e) {
      setBackfillMsg("❌ " + e.message);
    }
    setBackfillRunning(false);
  };
  // ─── Enrichment helpers ────────────────────────────────────
  const enrichTasks = async (tasksToEnrich) => {
    setEnrichLoading(true);
    const records = tasksToEnrich.map(t => { const f = t.fields || t; return { id: t.id, name: f["Lead Name"] || f.Company || "", email: f.Email || "", company: f.Company || "", linkedinUrl: f["LinkedIn URL"] || "", domain: f.Domain || "" }; });
    try {
      const res = await fetch("/api/enrich", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "enrich", records }) });
      const data = await res.json();
      if (data.results) {
        setEnrichResults(data.results);
        const updates = data.results.filter(r => r.found && (r.phone || r.mobile)).map(r => ({ id: r.id, fields: { Phone: r.phone || r.mobile || "" } }));
        if (updates.length > 0) { try { await at("update", "Tasks", { records: updates }, bid); } catch {} setTasks(prev => prev.map(t => { const u = updates.find(x => x.id === t.id); return u ? { ...t, fields: { ...t.fields, ...u.fields } } : t; })); }
        setEnrichLoading(false); return data;
      }
    } catch (e) { console.error(e); }
    setEnrichLoading(false); return null;
  };

  // ─── CSV ───────────────────────────────────────────────────
  const parseCSVLine = (line) => {
    const result = []; let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i+1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    result.push(cur.trim()); return result;
  };

  const FIELD_ALIASES = {
    Accounts: { Name:["name","company","company name","account","account name","organization","org name","business name","company_name"],Domain:["domain","website","company website","url","company url","company domain","company_website","site"],Industry:["industry","vertical","sector","category"],Size:["size","employees","employee count","company size","headcount","num employees","number of employees","# employees","employee_count","total employees"],"LinkedIn URL":["linkedin","linkedin url","linkedin company","company linkedin","linkedin link","linkedin_url","company linkedin url","company_linkedin_url","linkedinurl"],Country:["country","location","hq","headquarters","region","geography","company country","company_country"] },
    Leads: { Name:["name","full name","contact name","contact","person","lead name","full_name","contact_name","lead_name"],Email:["email","email address","work email","business email","e-mail","mail","email_address","work_email"],Title:["title","job title","position","role","designation","current title","job_title","jobtitle"],"First Name":["first name","first_name","firstname","given name","fname"],"Last Name":["last name","last_name","lastname","surname","family name","lname"],Company:["company","organization","employer","company name","org","account name","company_name","account_name"],"LinkedIn URL":["linkedin","linkedin url","linkedin profile","profile url","li url","linkedin_url","linkedinurl","linkedin profile url"],"Company LinkedIn URL":["company linkedin url","company_linkedin_url","company linkedin"],Phone:["phone","phone number","direct phone","mobile","cell","telephone","work phone","phone_number","direct_phone","mobile phone"],Website:["website","domain","company website","company_website","company domain","site","web"],City:["city","lead city","company city"],State:["state","lead state","company state","province","region"],Country:["country","lead country","company country"],"Annual Revenue":["annual revenue","annual_revenue","revenue"],"Total Funding":["total funding","total_funding","funding"],"# Employees":["# employees","employees","employee count","headcount","company size","number of employees"],"Custom Code":["custom code","customcode","custom_code","tracking code","tracking_code","trackingcode","utm code","utm_code","utm campaign","utm_campaign","session campaign id","session_campaign_id","campaign id","campaign_id","code","short code","unique code"] },
  };

  const autoDetect = (headers, table, freshRecords = null, freshMeta = null) => {
    const aliases = FIELD_ALIASES[table] || {};
    // Get fields from Airtable metadata. Prefer freshMeta if given to avoid React state lag.
    const metaSource = freshMeta || availableFields;
    const metaFields = (metaSource[table] || []).map(f => f.name || f);
    // Also get fields from loaded records as fallback. Prefer freshRecords if given
    // (handleCSVFile passes the just-fetched records to avoid stale React state).
    const recordSource = freshRecords || (table === "Accounts" ? accounts : table === "Leads" ? leads : []);
    const recordFields = [...new Set(recordSource.flatMap(r => Object.keys(r.fields || {})))];
    // Combine both — metadata + record fields
    const existingFields = [...new Set([...metaFields, ...recordFields])];

    const m = {};
    for (const h of headers) {
      const l = h.toLowerCase().trim();
      let hit = false;
      // 1. Check hardcoded aliases
      for (const [f, alts] of Object.entries(aliases)) { if (alts.includes(l) || l === f.toLowerCase()) { m[h] = f; hit = true; break; } }
      if (hit) continue;
      // 2. Exact match against existing Airtable fields (case-insensitive)
      const exact = existingFields.find(ef => ef.toLowerCase() === l);
      if (exact) { m[h] = exact; continue; }
      // 3. Fuzzy match (strip spaces/underscores/hyphens)
      const hNorm = l.replace(/[\s_-]/g, "");
      const fuzzy = existingFields.find(ef => ef.toLowerCase().replace(/[\s_-]/g, "") === hNorm);
      if (fuzzy) { m[h] = fuzzy; continue; }
      // 4. Default: use header as-is
      m[h] = h;
    }
    return m;
  };

  // Normalize a field value for comparison. Handles strings, numbers, arrays, null.
  // Critical for matching CSV uploads against existing Airtable records, where the
  // existing field might be a number ("12345"), array (lookup field returns ["foo"]),
  // or have weird whitespace. Without this, .toLowerCase() crashes silently.
  const normalizeForMatch = (v) => {
    if (v === null || v === undefined) return "";
    let s;
    if (Array.isArray(v)) {
      // Lookup/multiselect — join, but if it's a single-value lookup, just take that
      s = v.length === 1 ? String(v[0]) : v.join(",");
    } else if (typeof v === "object") {
      // Linked records etc — try id then name, else fail
      s = v.id || v.name || "";
    } else {
      s = String(v);
    }
    // Lowercase, trim, collapse internal whitespace (handles non-breaking spaces too)
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  };

  const handleCSVFile = async (file, table, setter) => {
    setCsvPrepping(true); // local indicator — doesn't blank the whole tab like setLoading does
    try {
      // Fetch fresh schema BEFORE showing the modal — so newly-created custom fields
      // get auto-detected on this upload, not the next one. Was fire-and-forget before.
      // We capture the returned value because setAvailableFields is async — the React state
      // won't be updated until next render, but we need fresh fields RIGHT NOW for autoDetect.
      const freshMeta = await fetchAvailableFields();
      // Also fetch fresh records, so the match-existing flow has up-to-date data.
      // Without this, if records were imported in a previous session and state was reset,
      // every row would be miscategorized as "unmatched" → created as new.
      let freshRecords = table === "Accounts" ? accounts : leads;
      try {
        const r = await at("list", table, {}, bid);
        freshRecords = r.records || [];
        setter(freshRecords);
      } catch (e) {
        console.warn(`Could not refresh ${table} before CSV upload, using cached state (${freshRecords.length} records)`);
      }

      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        // Proper CSV parse — handles multi-line quoted fields, escaped quotes
        const parseFullCSV = (csv) => {
          const rows = []; let row = []; let cell = ""; let inQ = false;
          for (let i = 0; i < csv.length; i++) {
            const c = csv[i];
            if (inQ) {
              if (c === '"') {
                if (csv[i + 1] === '"') { cell += '"'; i++; } // escaped quote
                else inQ = false; // end quote
              } else { cell += c; }
            } else {
              if (c === '"') { inQ = true; }
              else if (c === ',') { row.push(cell.trim()); cell = ""; }
              else if (c === '\n' || c === '\r') {
                if (c === '\r' && csv[i + 1] === '\n') i++; // skip \r\n
                row.push(cell.trim()); cell = "";
                if (row.some(c => c)) rows.push(row);
                row = [];
              } else { cell += c; }
            }
          }
          // Last cell/row
          row.push(cell.trim());
          if (row.some(c => c)) rows.push(row);
          return rows;
        };

        const allRows = parseFullCSV(text);
        if (allRows.length < 2) { setCsvPrepping(false); return; }
        const headers = allRows[0];
        const dataRows = allRows.slice(1).filter(r => r.length >= 2 && r.some(c => c)); // need at least 2 non-empty cells
        setCsvModal({ table, setter, headers, rows: dataRows, mappings: autoDetect(headers, table, freshRecords, freshMeta), mode: "create", matchField: "Name", campaignTag: camp?.name || "", newCampaignTag: "", existingCount: freshRecords.length });
        setCsvPrepping(false); // modal is up, user takes over
      };
      reader.onerror = () => { setCsvPrepping(false); console.error("CSV read error"); };
      reader.readAsText(file);
    } catch (e) {
      console.error("CSV prep failed:", e);
      setCsvPrepping(false);
    }
  };

  const uploadMappedCSV = async () => {
    if (!csvModal) return;
    const { table, setter, headers, rows, mappings, mode, matchField, campaignTag, newCampaignTag } = csvModal;
    const active = Object.entries(mappings).filter(([_, v]) => v !== "__skip__");
    const tag = (newCampaignTag || "").trim() || (campaignTag || "").trim();

    const recs = rows.map(row => {
      const obj = {};
      active.forEach(([csv, field]) => { const idx = headers.indexOf(csv); if (idx >= 0 && row[idx]) obj[field] = row[idx]; });
      if (tag) obj["Campaign Tag"] = tag;
      return obj;
    }).filter(r => Object.keys(r).length > (tag ? 1 : 0)); // don't count only-tag records
    if (!recs.length) { setCsvModal(null); return; }

    // Client-side chunking. Vercel Hobby has a 4.5MB request body limit. A typical lead
    // record is 1-15KB once you count Lead Summary + Description + reasoning fields.
    // With ~1500 leads × ~3.5KB = ~5MB → exceeds the limit. Chunking at 50 records per
    // request keeps each payload safely under 1MB even for very heavy lead data.
    // The backend already batches Airtable PATCH/POST internally at 10/call, so this
    // outer chunk size only affects the Vercel function payload, not Airtable rate limits.
    const CHUNK_SIZE = 50;
    const chunkArray = (arr, size) => {
      const chunks = [];
      for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
      return chunks;
    };

    try {
      // Use local prepping state instead of global setLoading. Global setLoading hides the
      // entire tab (because every tab has `tab===X && !loading && (...)`), which makes the
      // user think their data disappeared during a slow upload.
      setCsvPrepping(true);
      setCsvModal(null);

      if (mode === "update" && matchField) {
        // ─── Partial update: match by field, update existing records ───
        // Use fresh state — handleCSVFile refreshed this just before showing the modal.
        const existing = table === "Accounts" ? accounts : leads;

        // Pre-build a normalized lookup map. O(N) once, O(1) lookups instead of O(M*N).
        // Also lets us detect duplicate match values in the existing data (which would
        // cause non-deterministic behavior — first-found wins).
        const existingByMatch = new Map();
        const dupKeys = [];
        for (const e of existing) {
          const key = normalizeForMatch(e.fields?.[matchField]);
          if (!key) continue; // skip records with no value in match field
          if (existingByMatch.has(key)) dupKeys.push(key);
          else existingByMatch.set(key, e);
        }
        if (dupKeys.length > 0) {
          console.warn(`[CSV Update] ${dupKeys.length} duplicate ${matchField} values in existing data — first-found wins for matching`);
        }

        const matched = [];
        const unmatched = [];
        const skippedNoMatchValue = [];

        for (const rec of recs) {
          const matchVal = normalizeForMatch(rec[matchField]);
          if (!matchVal) {
            // This row has no value in the match field. Don't silently create — flag it.
            skippedNoMatchValue.push(rec);
            continue;
          }
          const found = existingByMatch.get(matchVal);
          if (found) {
            // Build update payload — only include non-match fields (new data)
            const updates = {};
            for (const [k, v] of Object.entries(rec)) {
              if (k !== matchField && v !== undefined && v !== "") updates[k] = v;
            }
            if (Object.keys(updates).length > 0) {
              matched.push({ id: found.id, fields: updates });
            }
          } else {
            unmatched.push(rec);
          }
        }

        // Update matched records — chunked to avoid Vercel's 4.5MB request body limit
        let updateErrors = [];
        let updatedCount = 0;
        if (matched.length > 0) {
          const chunks = chunkArray(matched, CHUNK_SIZE);
          for (let i = 0; i < chunks.length; i++) {
            // Update progress toast so user sees we're not hung
            setCsvUploadResult({ msg: `Uploading: updated ${updatedCount}/${matched.length}, creating ${unmatched.length} new...`, isError: false, isProgress: true });
            try {
              const res = await at("update", table, { records: chunks[i] }, bid);
              const updatedMap = {};
              (res.records || []).forEach(r => { updatedMap[r.id] = r; });
              setter(p => p.map(r => updatedMap[r.id] ? { ...r, fields: { ...r.fields, ...updatedMap[r.id].fields } } : r));
              updatedCount += res.records?.length || 0;
            } catch (e) {
              updateErrors.push(`chunk ${i + 1}/${chunks.length}: ${e.message}`);
              // Don't bail — keep going so partial success isn't lost
            }
          }
        }

        // Create unmatched as new records (if any) — also chunked
        let createErrors = [];
        let createdCount = 0;
        if (unmatched.length > 0) {
          const chunks = chunkArray(unmatched, CHUNK_SIZE);
          for (let i = 0; i < chunks.length; i++) {
            setCsvUploadResult({ msg: `Uploading: ${updatedCount} updated, creating ${createdCount}/${unmatched.length}...`, isError: false, isProgress: true });
            try {
              const res = await at("create", table, { records: chunks[i] }, bid);
              setter(p => [...p, ...(res.records || [])]);
              createdCount += res.records?.length || 0;
            } catch (e) {
              createErrors.push(`chunk ${i + 1}/${chunks.length}: ${e.message}`);
            }
          }
        }

        // Tell the user what happened — was failing silently before
        const summary = [];
        if (updatedCount > 0) summary.push(`${updatedCount} updated`);
        if (createdCount > 0) summary.push(`${createdCount} created (no match by ${matchField})`);
        if (skippedNoMatchValue.length > 0) summary.push(`${skippedNoMatchValue.length} skipped (blank ${matchField} field)`);
        if (updateErrors.length > 0) summary.push(`${updateErrors.length} update chunks failed: ${updateErrors[0].slice(0, 80)}`);
        if (createErrors.length > 0) summary.push(`${createErrors.length} create chunks failed: ${createErrors[0].slice(0, 80)}`);
        const msg = `CSV ${mode}: ${summary.join(", ")}`;
        console.log(`[CSV Update]`, msg);
        // Inline notification — show for 8 sec so user has time to read
        setCsvUploadResult({ msg, isError: updateErrors.length + createErrors.length > 0 });
        setTimeout(() => setCsvUploadResult(null), 12000);
      } else {
        // ─── Normal create — chunked to avoid Vercel 4.5MB body limit ───
        const chunks = chunkArray(recs, CHUNK_SIZE);
        let createdCount = 0;
        const errors = [];
        for (let i = 0; i < chunks.length; i++) {
          setCsvUploadResult({ msg: `Uploading: ${createdCount}/${recs.length} ${table.toLowerCase()} created...`, isError: false, isProgress: true });
          try {
            const res = await at("create", table, { records: chunks[i] }, bid);
            setter(p => [...p, ...(res.records || [])]);
            createdCount += res.records?.length || 0;
          } catch (e) {
            errors.push(`chunk ${i + 1}/${chunks.length}: ${e.message}`);
          }
        }
        if (errors.length > 0) {
          setCsvUploadResult({ msg: `Created ${createdCount}/${recs.length}. ${errors.length} chunks failed: ${errors[0].slice(0, 100)}`, isError: true });
          setTimeout(() => setCsvUploadResult(null), 12000);
        } else {
          setCsvUploadResult({ msg: `CSV create: ${createdCount} new ${table.toLowerCase()} created`, isError: false });
          setTimeout(() => setCsvUploadResult(null), 6000);
        }
      }

      fetchAvailableFields();
    } catch (e) {
      console.error("Upload failed:", e);
      setCsvUploadResult({ msg: `Upload failed: ${e.message}`, isError: true });
      setTimeout(() => setCsvUploadResult(null), 8000);
    }
    setCsvPrepping(false);
  };

  // ─── Filtered tasks (used by export + task tab) ─────────────
  const fTasks=tasks.filter(t=>{const f=t.fields||{};if(filter.src!=="all"&&f["Task Type"]!==filter.src)return false;if(filter.target!=="all"&&f["Scan Target"]!==filter.target)return false;if(filter.q&&!(f.Company||"").toLowerCase().includes(filter.q.toLowerCase())&&!(f["Task Rule"]||"").toLowerCase().includes(filter.q.toLowerCase()))return false;if(filter.from&&(f.Date||"")<filter.from)return false;if(filter.to&&(f.Date||"")>filter.to)return false;return true});

  // ─── Date presets ───────────────────────────────────────────
  const setDatePreset = (preset) => {
    const now = new Date();
    const fmt = (d) => d.toISOString().slice(0, 10);
    switch (preset) {
      case "24h": setFilter(f => ({...f, from: fmt(new Date(now - 86400000)), to: fmt(now), datePreset: "24h"})); break;
      case "7d": setFilter(f => ({...f, from: fmt(new Date(now - 7*86400000)), to: fmt(now), datePreset: "7d"})); break;
      case "14d": setFilter(f => ({...f, from: fmt(new Date(now - 14*86400000)), to: fmt(now), datePreset: "14d"})); break;
      case "30d": setFilter(f => ({...f, from: fmt(new Date(now - 30*86400000)), to: fmt(now), datePreset: "30d"})); break;
      case "all": setFilter(f => ({...f, from: "", to: "", datePreset: "all"})); break;
    }
  };

  // ─── Selection helpers ─────────────────────────────────────
  const toggleTask = (id) => setSelectedTasks(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAllVisible = () => {
    const visibleIds = fTasks.map(t => t.id);
    const allSelected = visibleIds.every(id => selectedTasks.has(id));
    if (allSelected) setSelectedTasks(p => { const n = new Set(p); visibleIds.forEach(id => n.delete(id)); return n; });
    else setSelectedTasks(p => { const n = new Set(p); visibleIds.forEach(id => n.add(id)); return n; });
  };
  const selCount = fTasks.filter(t => selectedTasks.has(t.id)).length;

  // ─── Task deduplication ────────────────────────────────────
  // Fingerprint: lowercase Company|TaskRule|first60charsOfSignal
  const taskFingerprint = (t) => {
    const c = (t.Company || "").toLowerCase().trim();
    const r = (t["Task Rule"] || "").toLowerCase().trim();
    const s = (t.Signal || "").toLowerCase().trim().replace(/[^a-z0-9 ]/g, "").slice(0, 60);
    return `${c}|${r}|${s}`;
  };

  // Fuzzy: word overlap ratio between two strings
  const wordOverlap = (a, b) => {
    if (!a || !b) return 0;
    const wa = new Set(a.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 2));
    const wb = new Set(b.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 2));
    if (!wa.size || !wb.size) return 0;
    let overlap = 0;
    for (const w of wa) { if (wb.has(w)) overlap++; }
    return overlap / Math.min(wa.size, wb.size);
  };

  // Check if a new task is a duplicate of anything we've seen
  const isDuplicate = (newTask, existingTasks) => {
    const fp = taskFingerprint(newTask);
    // Layer 1: exact fingerprint
    if (taskSeenRef.current.has(fp)) return true;
    // Layer 2: URL dedup — same URL for same company = same signal
    const newUrl = (newTask.URL || "").toLowerCase().trim();
    if (newUrl) {
      const newCo = (newTask.Company || "").toLowerCase().trim();
      for (const t of existingTasks) {
        const f = t.fields || t;
        if ((f.URL || "").toLowerCase().trim() === newUrl && (f.Company || "").toLowerCase().trim() === newCo) return true;
      }
    }
    // Layer 3: fuzzy — same company + same rule + similar signal text
    const co = (newTask.Company || "").toLowerCase().trim();
    const ru = (newTask["Task Rule"] || "").toLowerCase().trim();
    for (const t of existingTasks) {
      const f = t.fields || t;
      const ec = (f.Company || "").toLowerCase().trim();
      const er = (f["Task Rule"] || "").toLowerCase().trim();
      if (ec === co && er === ru) {
        const overlap = wordOverlap(newTask.Signal || "", f.Signal || "");
        if (overlap > 0.6) return true; // >60% word overlap = duplicate
      }
    }
    return false;
  };

  // Build the seen set from existing tasks (called at scan start)
  const buildSeenSet = () => {
    taskSeenRef.current = new Set();
    for (const t of tasks) {
      const f = t.fields || {};
      taskSeenRef.current.add(taskFingerprint(f));
    }
  };

  // ─── AI Dedup — semantic dedup via GPT after batch creation ──
  const aiDedupBatch = async (newTasks) => {
    if (newTasks.length <= 1) return newTasks;
    // Group by company
    const groups = {};
    newTasks.forEach((t, idx) => {
      const f = t.fields || t;
      const co = f.Company || "unknown";
      if (!groups[co]) groups[co] = [];
      groups[co].push({ signal: f.Signal || "", taskRule: f["Task Rule"] || "", score: f.Score || 0, taskType: f["Task Type"] || "", url: f.URL || "", idx });
    });
    // Only AI-dedup companies with 2+ tasks (worth the API call)
    const toDedup = Object.entries(groups).filter(([_, tasks]) => tasks.length > 1).map(([company, tasks]) => ({ company, tasks }));
    if (toDedup.length === 0) return newTasks;

    try {
      const res = await fetch("/api/classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dedup_tasks", taskGroups: toDedup, campaignId: camp?.airtableId }) });
      if (res.ok) {
        const { keepIndices } = await res.json();
        const keepSet = new Set(keepIndices || []);
        // Also keep all tasks from single-task companies (not sent to AI)
        const singleIdxs = Object.values(groups).filter(g => g.length <= 1).flatMap(g => g.map(t => t.idx));
        singleIdxs.forEach(i => keepSet.add(i));
        return newTasks.filter((_, i) => keepSet.has(i));
      }
    } catch (e) { console.error("AI dedup failed:", e); }
    return newTasks; // fallback: keep all
  };

  // ─── Save rule (any type — signal, top_x, or outreach) ─────
  const saveRule = async (rule) => {
    let fields;
    if (rule.taskType === "linkedin_outreach") {
      // Auto-attach the campaign's currently-assigned LinkedIn account so the
      // cron can find it. Otherwise the rule has active:true but no accountId
      // and the cron silently skips it. User can re-pick the campaign's
      // assigned account via the LinkedIn Account section at the top of the
      // LinkedIn Automation tab.
      const oc = rule.outreachConfig || {};
      if (!oc.accountId && linkedinAccount?.id) {
        oc.accountId = linkedinAccount.id;
        console.log(`[saveRule] Auto-attached campaign LinkedIn account ${linkedinAccount.id} to rule "${rule.name}"`);
      }
      if (!oc.accountId) {
        alert("⚠ This outreach rule has no LinkedIn account assigned. The cron will skip it.\n\nFix: go to the LinkedIn Automation tab and connect/assign a LinkedIn account for this campaign first, then save this rule again.");
      }
      fields = { Name: rule.name, Description: rule.description || "", "Task Type": "linkedin_outreach", "Outreach Config": JSON.stringify(oc) };
    } else if (rule.taskType === "top_x") {
      fields = { Name: rule.name, Description: rule.description || "", "Task Type": "top_x", "Scan Target": rule.scanTarget || "leads", "Top N": rule.topN || 10, "Scoring Fields": JSON.stringify(rule.scoringFields || []), "Scoring Prompt": rule.scoringPrompt || "", Ease: rule.ease || "Medium", Strength: rule.strength || "Strong",
        "Smart Compile": rule.smartCompile ? "true" : "false",
        "Compiled Rules JSON": rule.compiledRules ? JSON.stringify(rule.compiledRules) : "",
        "Compiled At": rule.compiledAt || "",
      };
    } else {
      fields = { Name: rule.name, Description: rule.description || "", "Task Type": rule.taskType || "news", "Scan Target": rule.scanTarget || "accounts", Ease: rule.ease || "Medium", Strength: rule.strength || "Medium", Sources: (rule.sources || []).join(", "), Keywords: (rule.keywords || []).join(", "), "Job Title Keywords": (rule.jobTitleKeywords || []).join(", "), "Scoring Prompt": rule.scoringPrompt || "" };
    }
    try {
      if (rule.airtableId) { await at("update", "Task Rules", { records: [{ id: rule.airtableId, fields }] }, bid); setRules(p => p.map(r => r.id === rule.airtableId ? { ...r, fields } : r)); }
      else { const res = await at("create", "Task Rules", { records: [fields] }, bid); setRules(p => [...p, ...(res.records || [])]); }
    } catch (e) { console.error(e); }
    setEditRule(null);
  };

  // ─── Duplicate a rule ──────────────────────────────────────
  const duplicateRule = async (r) => {
    const f = { ...(r.fields || {}) };
    f.Name = (f.Name || "") + " (copy)";
    // Remove any auto-generated IDs
    delete f.id;
    try {
      const res = await at("create", "Task Rules", { records: [f] }, bid);
      setRules(p => [...p, ...(res.records || [])]);
    } catch (e) { console.error(e); }
  };

  // ─── Run Top X ─────────────────────────────────────────────
  const runTopX = async (rule) => {
    const ruleFields = rule.fields || {};
    const hasPrompt = !!(ruleFields["Scoring Prompt"] || "").trim();
    // Smart Compile detection: rule has Smart Compile = true AND compiled rules JSON exists
    const smartCompileEnabled = ruleFields["Smart Compile"] === "true" || ruleFields["Smart Compile"] === true;
    let compiledRules = null;
    if (smartCompileEnabled && ruleFields["Compiled Rules JSON"]) {
      try { compiledRules = JSON.parse(ruleFields["Compiled Rules JSON"]); }
      catch (e) { console.warn("Failed to parse compiled rules JSON:", e.message); }
    }
    const useSmartCompile = smartCompileEnabled && compiledRules && Array.isArray(compiledRules.rules);

    setScanning(true);
    setScanText(useSmartCompile ? "⚡ Running Smart Compile (rules)..." : hasPrompt ? "🧠 Running Top X + AI scoring..." : "🎯 Running Top X scoring...");
    setScanProg(30);
    buildSeenSet();
    try {
      const sf = JSON.parse(ruleFields["Scoring Fields"] || "[]");

      // Build exclude keys from existing Tasks. Server uses these to drop
      // candidates BEFORE scoring so the topN slice gives the operator
      // the volume they asked for, not "30 of 150 after post-score dedup".
      //
      // Two key shapes — record is excluded if either matches:
      //   - urls:   normalized LinkedIn URL from the task's URL or LinkedIn URL field
      //   - nameCo: lowercased "name|company" composite (catches leads with no URL)
      const normalizeUrl = u => (u || "").trim().toLowerCase()
        .replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/$/, "")
        .split("?")[0].split("#")[0];
      const excludeUrls = new Set();
      const excludeNameCo = new Set();
      for (const t of tasks) {
        const f = t.fields || {};
        const u = normalizeUrl(f["LinkedIn URL"] || f.URL || "");
        if (u) excludeUrls.add(u);
        const name = String(f.Name || "").toLowerCase().trim();
        const company = String(f.Company || "").toLowerCase().trim();
        if (name && company) excludeNameCo.add(`${name}|${company}`);
      }

      const ruleBody = {
        name: ruleFields.Name,
        scanTarget: ruleFields["Scan Target"] || "leads",
        topN: ruleFields["Top N"] || 10,
        scoringFields: sf,
        scoringPrompt: ruleFields["Scoring Prompt"] || "",
        useSmartCompile,
        compiledRules,
        excludeKeys: {
          urls: Array.from(excludeUrls),
          nameCo: Array.from(excludeNameCo),
        },
      };
      const res = await at("run_topx", "", { rule: ruleBody }, bid);
      setScanProg(70);
      const aiLabel = res.aiScored ? " (AI scored)" : "";
      // Smart Compile metrics — surface scale info so user can see if fuzzy was capped
      let compileLabel = "";
      if (res.smartCompile) {
        const sc = res.smartCompile;
        const parts = [];
        parts.push(`${sc.total_rules_applied} rules in ${sc.deterministic_ms}ms`);
        if (sc.fuzzy_api_calls > 0) parts.push(`${sc.fuzzy_api_calls} AI calls (${sc.fuzzy_adjusted_count} adjusted)`);
        if (sc.fuzzy_skipped > 0) parts.push(`⚠ ${sc.fuzzy_skipped} borderline skipped (cost cap)`);
        compileLabel = ` [smart: ${parts.join(", ")}]`;
      }
      // Cross-reference coverage — show match rate so user knows if account joining actually worked
      let crossRefLabel = "";
      if (res.crossRef?.enabled) {
        const cr = res.crossRef;
        if (cr.failed) {
          crossRefLabel = ` ⚠ XREF FAILED: ${cr.error} — Account.* rules contributed 0`;
        } else {
          crossRefLabel = ` [xref: ${cr.matched_to_account}/${cr.total_leads} leads matched (${cr.match_rate_pct}%) to ${cr.total_accounts_indexed} accounts]`;
          if (cr.match_rate_pct < 60) {
            crossRefLabel += ` ⚠ low match rate — check that Domain/Website/LinkedIn fields are populated`;
          }
        }
      }
      // Legacy cap warning — only shows when pure-AI mode hit the 600-record cap
      let legacyWarning = "";
      if (res.legacy?.skipped_at_cap > 0) {
        legacyWarning = ` ⚠ ${res.legacy.skipped_at_cap} records skipped (legacy mode cap). Enable Smart Compile for full coverage.`;
      }
      if (res.tasks?.length > 0) {
        const unique = res.tasks.filter(t => !isDuplicate(t, tasks));
        const duped = res.tasks.length - unique.length;
        setScanText(`🔍 ${duped > 0 ? duped + " duplicates removed, " : ""}creating ${unique.length} tasks...`);
        setScanProg(85);
        if (unique.length > 0) {
          unique.forEach(t => taskSeenRef.current.add(taskFingerprint(t)));
          const cr = await at("create", "Tasks", { records: unique }, bid);
          setTasks(p => [...(cr.records || []), ...p]);
          // Build the result string from server-supplied counts so operator
          // sees the full pipeline: scored pool, pre-excluded volume, fresh tasks.
          const excludedStr = res.excludedAsAlreadyTasked > 0
            ? ` (${res.excludedAsAlreadyTasked} already tasked, skipped before scoring)`
            : "";
          const scoredOf = res.scoredRecords && res.scoredRecords !== res.totalRecords
            ? `${res.scoredRecords}/${res.totalRecords}`
            : `${res.totalRecords}`;
          setScanText(`✅ ${unique.length} tasks${aiLabel}${compileLabel}${crossRefLabel} from top ${res.topN} of ${scoredOf}${excludedStr}${duped > 0 ? `, ${duped} post-score dupes skipped` : ""}${legacyWarning}`);
        } else {
          setScanText(`✅ All ${res.tasks.length} tasks already exist (no new tasks)`);
        }
      } else setScanText(res.error || "No results");
    } catch (e) { setScanText("❌ " + e.message); }
    setScanProg(100); setTimeout(() => setScanning(false), 2000);
  };

  // ─── Run Signal Scan (news + jobs) ─────────────────────────
  const scanBufferRef = useRef([]); // collects all new tasks during scan
  const dupCountRef = useRef(0);

  // mode: "all" | "news" | "jobs"
  // Allows user to run only news scans, only jobs scans, or both. Each mode
  // filters its rule set and skips the other phase entirely (saves time + API cost
  // when user only wants one signal type).
  const startScan = useCallback(async(mode = "all")=>{
    // Filter rules based on mode. "both" rules run in BOTH news and jobs phases.
    const ruleMatches = (tt) => {
      if (mode === "news") return tt === "news" || tt === "both";
      if (mode === "jobs") return tt === "job_post" || tt === "both";
      return tt === "news" || tt === "job_post" || tt === "both";
    };
    const sigRules=rules.filter(r=>ruleMatches((r.fields||{})["Task Type"]||"news"));
    // scanRef.current synchronously catches fast double-clicks (between event and React state flush)
    if(scanning||scanRef.current||!accounts.length||!sigRules.length)return;
    setScanning(true);scanRef.current=true;setScanProg(0);
    buildSeenSet(); scanBufferRef.current = []; dupCountRef.current = 0;
    const taskDefs=rules.filter(r=>ruleMatches((r.fields||{})["Task Type"]||"news")).map(r=>{const f=r.fields||{};const kws=(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean);const jtk=(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean);let sp=f["Scoring Prompt"]||"";if(!sp){const ak=[...kws,...jtk].slice(0,5).join(", ");sp="Rate this signal for \""+f.Name+"\". Score 90-100 for exact matches ("+ak+"). 70-89 strong. 50-69 partial. Below 50 unrelated."}return{id:r.id,name:f.Name||"",description:f.Description||"",taskType:f["Task Type"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease||"Medium",strength:f.Strength||"Medium",sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:kws,jobTitleKeywords:jtk,scoringPrompt:sp}});
    const companies=accounts.map(a=>{const f=a.fields||{};const li=f["LinkedIn URL"]||f.LinkedIn||"";return{name:f.Name||f.Company||"",domain:f.Domain||f.Website||"",linkedinSlug:extractLinkedInSlug(li),linkedinCompanyId:extractLinkedInId(li)}}).filter(c=>c.name);
    const nT=taskDefs.filter(t=>t.taskType==="news"||t.taskType==="both");
    const jT=taskDefs.filter(t=>t.taskType==="job_post"||t.taskType==="both");
    const total=companies.length;
    // Progress allocation: if running a single mode, that mode gets the full 0-90% range.
    // If running "all", news is 0-50% and jobs is 50-90% (legacy split).
    const newsRange = mode === "news" ? 90 : 50;
    const jobsBase = mode === "jobs" ? 0 : 50;
    const jobsRange = mode === "jobs" ? 90 : 40;
    // Track fetch stats across all news scans this run — surface in completion message
    // so user knows if poor fetch rates may have caused signal loss this run.
    const aggFetchStats = { totalArticles: 0, succeededArticles: 0, errorBreakdown: {}, lowFetchCompanies: [], failedCompanies: [] };
    // ── NEWS phase ──
    if(mode!=="jobs"&&nT.length>0){for(let i=0;i<companies.length;i++){if(!scanRef.current)break;setScanText("📰 "+companies[i].name);setScanProg(Math.round(i/total*newsRange));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({company:companies[i],taskDefs:nT,mode:"news",threshold,campaignId:camp?.airtableId})});if(res.ok){const d=await res.json();bufferSignals(d.news||[],companies[i],taskDefs);if(d.fetchStats){aggFetchStats.totalArticles+=d.fetchStats.total||0;aggFetchStats.succeededArticles+=d.fetchStats.succeeded||0;for(const[k,v]of Object.entries(d.fetchStats.errors||{})){aggFetchStats.errorBreakdown[k]=(aggFetchStats.errorBreakdown[k]||0)+v}if(d.fetchStats.total>=5&&d.fetchStats.successRate<50){aggFetchStats.lowFetchCompanies.push(`${companies[i].name} (${d.fetchStats.successRate}%)`)}}}else{aggFetchStats.failedCompanies.push(`${companies[i].name} (HTTP ${res.status})`);console.error(`[Scan] ${companies[i].name} failed: HTTP ${res.status}`)}}catch(e){aggFetchStats.failedCompanies.push(`${companies[i].name} (${e.message||"network error"})`);console.error(`[Scan] ${companies[i].name} threw:`,e)}await sleep(100)}}
    // ── JOBS phase ──
    if(scanRef.current&&mode!=="news"&&jT.length>0){const need=companies.filter(c=>c.linkedinSlug&&!c.linkedinCompanyId);if(need.length>0){setScanText("🔗 Resolving LinkedIn IDs...");try{const res=await fetch("/api/resolve-linkedin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slugs:need.map(c=>c.linkedinSlug)})});if(res.ok){const{ids}=await res.json();for(const c of companies){if(c.linkedinSlug&&!c.linkedinCompanyId&&ids[c.linkedinSlug.toLowerCase()])c.linkedinCompanyId=ids[c.linkedinSlug.toLowerCase()]}}}catch(e){console.error(e)}}
    const BS=5;for(let b=0;b<companies.length;b+=BS){if(!scanRef.current)break;const batch=companies.slice(b,b+BS);setScanText("📋 Jobs — Batch "+(Math.floor(b/BS)+1));setScanProg(jobsBase+Math.round(b/companies.length*jobsRange));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({companies:batch,taskDefs:jT,mode:"jobs-batch",threshold,campaignId:camp?.airtableId})});if(res.ok){const d=await res.json();for(const result of(d.results||[])){const co=batch.find(c=>c.name===result.company);if(co)bufferSignals(result.signals||[],co,taskDefs)}}}catch(e){console.error(e)}await sleep(200)}}

    // ─── Post-scan: AI dedup + save ───────────────────────────
    const buffered = scanBufferRef.current;
    const exactDupes = dupCountRef.current;
    // Build fetch warning suffix to append to completion message. Helps user
    // diagnose when low fetch rates may have caused signal loss.
    let fetchWarning = "";
    if (mode !== "jobs" && (aggFetchStats.totalArticles > 0 || aggFetchStats.failedCompanies.length > 0)) {
      const aggRate = aggFetchStats.totalArticles > 0 ? Math.round((aggFetchStats.succeededArticles / aggFetchStats.totalArticles) * 100) : 0;
      const errs = Object.entries(aggFetchStats.errorBreakdown).map(([k,v])=>`${k}:${v}`).join(",");
      console.log(`[Scan] News article fetch aggregate: ${aggFetchStats.succeededArticles}/${aggFetchStats.totalArticles} (${aggRate}%) — errors: ${errs||"none"}`);
      if (aggFetchStats.failedCompanies.length > 0) {
        console.error(`[Scan] ⚠ ${aggFetchStats.failedCompanies.length} company scans FAILED entirely: ${aggFetchStats.failedCompanies.join(", ")}`);
      }
      if (aggFetchStats.lowFetchCompanies.length > 0) {
        console.warn(`[Scan] ⚠ ${aggFetchStats.lowFetchCompanies.length} companies had <50% fetch success: ${aggFetchStats.lowFetchCompanies.join(", ")}`);
      }
      // Build user-visible warning, prioritizing the more severe issue
      if (aggFetchStats.failedCompanies.length > 0) {
        fetchWarning = ` ⚠ ${aggFetchStats.failedCompanies.length} co's failed entirely (check console)`;
      } else if (aggFetchStats.lowFetchCompanies.length > 0) {
        fetchWarning = ` ⚠ ${aggFetchStats.lowFetchCompanies.length} co's had low fetch (${aggRate}% overall — re-run if results look thin)`;
      } else if (aggRate < 70 && aggRate > 0) {
        fetchWarning = ` (article fetch ${aggRate}% — re-run for better coverage)`;
      }
    }
    if(buffered.length>0){
      setScanText(`🔍 AI dedup on ${buffered.length} tasks…`);setScanProg(90);
      const deduped = await aiDedupBatch(buffered);
      const aiRemoved = buffered.length - deduped.length;
      setScanText(`💾 Saving ${deduped.length} tasks…`);setScanProg(95);
      if(deduped.length>0){
        try{const res=await at("create","Tasks",{records:deduped},bid);setTasks(p=>[...(res.records||[]),...p])}catch(e){console.error(e)}
      }
      const totalDupes = exactDupes + aiRemoved;
      setScanText(`✅ ${deduped.length} tasks created${totalDupes>0?` (${totalDupes} duplicates removed${aiRemoved>0?`, ${aiRemoved} by AI`:""})`:""}${fetchWarning}`);
    } else {
      setScanText((exactDupes > 0 ? `✅ Scan complete — ${exactDupes} duplicates skipped, no new tasks` : "✅ Scan complete — no signals found") + fetchWarning);
    }
    setScanProg(100);setScanning(false);scanRef.current=false;
  },[accounts,rules,threshold,scanning,bid,tasks]);

  // Buffer signals with instant dedup (layers 1-3), defer AI dedup to post-scan
  const bufferSignals = (signals, company, taskDefs)=>{
    for(const sig of signals){
      const scores=sig.relevanceScores||{};
      const reasons=sig.scoreReasons||{};
      for(const tid of(sig.matchedTaskIds||[])){
        const td=taskDefs.find(t=>t.id===tid);if(!td)continue;
        // Use ?? not || so score=0 is preserved (|| would fall through to confidence-based).
        // confidence fallback only kicks in if scores[tid] is undefined/null.
        const rawScore = scores[tid] ?? Math.round((sig.confidence||0.7)*100);
        const score = Math.max(0,Math.min(100,Number(rawScore) || 0));
        if(score<threshold)continue;
        const newTask={
          Company:company.name,
          "Task Rule":td.name,
          Score:score,
          "Score Reason":reasons[tid]||"",
          "Scan Target":td.scanTarget||"accounts",
          Signal:sig.headline||"",
          Source:sig.source||"",
          URL:sig.url||"",
          "Task Type":sig.taskType||"news",
          Date:sig.date?sig.date.slice(0,10):new Date().toISOString().slice(0,10),
          Created:new Date().toISOString()
        };
        // Instant dedup: fingerprint + URL + fuzzy against existing + buffer
        if(isDuplicate(newTask, [...tasks, ...scanBufferRef.current.map(t=>({fields:t}))])){
          dupCountRef.current++;
          continue;
        }
        taskSeenRef.current.add(taskFingerprint(newTask));
        scanBufferRef.current.push(newTask);
      }
    }
  };

  // ─── Campaign CRUD ─────────────────────────────────────────
  const saveCampaign = async (data) => {
    const res = await at("create_campaign", "", { fields: { Name: data.name, "Base ID": data.baseId, Features: data.features.join(","), Description: data.desc || "", Emoji: data.emoji || "📊", Tables: data.tables || "" } });
    const r = (res.records || [])[0];
    if (r) setCampaigns(p => [...p, { id: "user_" + r.id, airtableId: r.id, name: data.name, emoji: data.emoji || "📊", desc: data.desc || "", badge: "Active", active: true, features: data.features, baseId: data.baseId, tables: data.tables || "" }]);
  };

  const deleteCampaign = async (c) => {
    if (!c.airtableId) return;
    try { await at("delete_campaign", "", { campaignRecordId: c.airtableId }); setCampaigns(p => p.filter(x => x.id !== c.id)); } catch (e) { console.error(e); }
  };

  // ─── Change Airtable base for any campaign ─────────────────
  const updateCampaignBase = async (newBaseUrl) => {
    // Extract base ID from URL or raw ID
    const disc = await fetch("/api/airtable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "discover", baseUrl: newBaseUrl }) });
    const info = await disc.json();
    if (info.error) throw new Error(info.error);
    const newBaseId = info.baseId;

    if (camp.airtableId) {
      // Existing user campaign — update the record
      await at("update_campaign", "", { campaignRecords: [{ id: camp.airtableId, fields: { "Base ID": newBaseId, Tables: info.tableNames.join(", ") } }] });
    } else {
      // Default campaign — save to Campaigns table for the first time
      const res = await at("create_campaign", "", { fields: { Name: camp.name, "Base ID": newBaseId, Features: (camp.features || []).join(","), Description: camp.desc || "", Emoji: camp.emoji || "📊", Tables: info.tableNames.join(", ") } });
      const r = (res.records || [])[0];
      if (r) {
        // Update campaign in list with new airtableId
        setCampaigns(p => p.map(c => c.id === camp.id ? { ...c, airtableId: r.id, baseId: newBaseId, tables: info.tableNames.join(", ") } : c));
        setCamp(prev => ({ ...prev, airtableId: r.id, baseId: newBaseId, tables: info.tableNames.join(", ") }));
        return;
      }
    }
    // Update state
    setCampaigns(p => p.map(c => c.id === camp.id ? { ...c, baseId: newBaseId, tables: info.tableNames.join(", ") } : c));
    setCamp(prev => ({ ...prev, baseId: newBaseId, tables: info.tableNames.join(", ") }));
  };

  // ═══ CLIENT MODE GATES ════════════════════════════════════
  if (clientMode && clientAuth === "loading") return (<><style>{CSS}</style><div className="landing"><div style={{fontSize:40,marginBottom:16}}>⏳</div><div style={{color:"var(--t3)"}}>Loading...</div></div></>);
  if (clientMode && clientAuth === "error") return (<><style>{CSS}</style><div className="landing"><div style={{fontSize:40,marginBottom:16}}>❌</div><h1 style={{fontSize:18,marginBottom:8}}>Campaign Not Found</h1><div style={{color:"var(--t3)",fontSize:13,marginBottom:8}}>This link is invalid or has expired.</div><div style={{color:"var(--t3)",fontSize:10,fontFamily:"'JetBrains Mono',monospace"}}>{fixedCampaignId}</div></div></>);
  if (clientMode && clientAuth === "password") return (<><style>{CSS}</style><div className="landing">
    <div style={{maxWidth:400,padding:40,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:16,textAlign:"center"}}>
      <div style={{fontSize:40,marginBottom:16}}>🔒</div>
      <h1 style={{fontSize:20,marginBottom:4}}>{window.__pendingCamp?.emoji} {window.__pendingCamp?.name || "Campaign"}</h1>
      <div style={{fontSize:12,color:"var(--t3)",marginBottom:24}}>Enter the password to access</div>
      <input className="inp" type="password" placeholder="Password" value={clientPw} onChange={e=>{setClientPw(e.target.value);setClientPwErr("")}} onKeyDown={e=>e.key==="Enter"&&validateClientPw()} style={{marginBottom:12,textAlign:"center"}}/>
      {clientPwErr && <div style={{color:"var(--red)",fontSize:11,marginBottom:12}}>{clientPwErr}</div>}
      <button className="btn btn-p" style={{width:"100%",justifyContent:"center"}} onClick={validateClientPw}>Access Campaign</button>
    </div>
  </div></>);

  // ═══ LANDING ═══════════════════════════════════════════════
  // SECURITY CRITICAL: NEVER render the landing page (which lists ALL campaigns)
  // in clientMode. If we somehow reach here in clientMode without a campaign set
  // (clientAuth went to "ok" but camp is null due to lost session, race, or page
  // navigation), show an error instead of leaking the full campaign list.
  // This is the bug that exposed all campaigns to a client who reloaded after
  // password entry.
  //
  // IMPORTANT: This must check `!camp` to NOT block the success path (clientMode
  // with camp set should render the campaign view normally below).
  if (clientMode && !camp) {
    return (<><style>{CSS}</style><div className="landing"><div style={{fontSize:40,marginBottom:16}}>⚠️</div><h1 style={{fontSize:18,marginBottom:8}}>Session Expired</h1><div style={{color:"var(--t3)",fontSize:13,marginBottom:8}}>Please reload this page to access your campaign.</div><button className="btn btn-p" style={{marginTop:16}} onClick={()=>window.location.reload()}>Reload</button></div></>);
  }
  if(!camp){return(<><style>{CSS}</style><div className="landing"><h1>SignalScope</h1><div className="sub">B2B Signal Intelligence Platform</div>
  <div className="cgrid">
    {campaigns.map(c=>(<div key={c.id} className={"ccard"+(c.active?"":" off")} onClick={()=>c.active&&setCamp(c)}>
      <div className="em">{c.emoji}</div><div className="nm">{c.name}</div><div className="ds">{c.desc}</div>
      <div style={{display:"flex",alignItems:"center",gap:6,marginTop:10,flexWrap:"wrap"}}>
        <div className="bdg" style={{background:c.active?"var(--grn-d)":"var(--hover)",color:c.active?"var(--grn)":"var(--t3)"}}>{c.badge}</div>
        {(c.features||[]).map(f=><span key={f} className="feat-tag" style={{background:"var(--hover)",color:"var(--t2)"}}>{ALL_FEATURES.find(af=>af.id===f)?.emoji||"•"} {f.replace(/_/g," ")}</span>)}
        {c.baseId&&<span style={{fontSize:8,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{c.baseId.slice(0,12)}…</span>}
        {c.airtableId&&<button className="btn btn-d btn-s" style={{marginLeft:"auto",padding:"2px 6px",fontSize:9}} onClick={e=>{e.stopPropagation();if(confirm("Delete \""+c.name+"\"?"))deleteCampaign(c)}}>✕</button>}
      </div>
    </div>))}
    <div className="ccard" onClick={()=>setShowAddCampaign(true)} style={{borderStyle:"dashed"}}>
      <div className="em">➕</div><div className="nm">Add Campaign</div><div className="ds">Connect an Airtable base to start a new campaign.</div>
      <div className="bdg" style={{background:"var(--pur-d)",color:"var(--pur)"}}>New</div>
    </div>
  </div></div>
  {showAddCampaign&&<AddCampaignModal onSave={saveCampaign} onClose={()=>setShowAddCampaign(false)}/>}
  </>)}

  // ═══ DASHBOARD ═════════════════════════════════════════════
  const signalRules = rules.filter(r => { const tt = (r.fields||{})["Task Type"]; return !tt || tt==="news" || tt==="job_post" || tt==="both"; });
  // Per-mode counts for the split scan buttons. "both" rules count toward BOTH news and jobs.
  const newsRuleCount = signalRules.filter(r => { const tt=(r.fields||{})["Task Type"]||"news"; return tt==="news"||tt==="both"; }).length;
  const jobsRuleCount = signalRules.filter(r => { const tt=(r.fields||{})["Task Type"]||"news"; return tt==="job_post"||tt==="both"; }).length;
  const topXRules = rules.filter(r => (r.fields||{})["Task Type"] === "top_x");

  // Admin-only tabs hidden from clientMode. These either expose master-base data
  // (Triggers shows ALL Account Routing across campaigns), integration credentials
  // (HubSpot, GA), or admin functions. Clients see only their campaign's
  // operational data + read-only LinkedIn outreach/posts views.
  const ADMIN_ONLY_TABS = new Set([
    // Originally admin-only (back-office integrations + speculative features)
    "triggers", "email_campaign", "google_analytics", "hubspot", "post_demo",
    // Added 2026-05-22 per operator request — client portal should not expose
    // the rule-building / scoring-tuning surface or the LinkedIn automation
    // control plane. Client sees results (Dashboard, Accounts, Leads, Tasks)
    // not the machinery that produced them.
    "rules", "prompts", "threshold", "outreach", "linkedin_posts",
  ]);
  const navs = [
    {id:"dashboard",label:"📊 Dashboard",count:null},
    null,
    {id:"accounts",label:"Accounts",count:accounts.length},
    {id:"leads",label:"Leads",count:leads.length},
    null,
    {id:"rules",label:"Task Rules",count:rules.length},
    {id:"prompts",label:"Prompts",count:rules.length},
    {id:"threshold",label:"Scoring",count:null},
    {id:"tasks",label:"Tasks",count:tasks.length},
    null,
    {id:"outreach",label:"💬 LinkedIn Automation",count:null},
    {id:"linkedin_posts",label:"📝 LinkedIn Posts",count:null},
    {id:"triggers",label:"🔥 Triggers",count:null},
    {id:"email_campaign",label:"📧 Email Campaign",count:null},
    {id:"google_analytics",label:"📊 Google Analytics",count:null},
    {id:"hubspot",label:"🔗 HubSpot",count:null},
    {id:"post_demo",label:"🤖 Post-Demo Auto",count:null},
    ...(!clientMode ? [{id:"coming_soon",label:"🚀 Coming Soon",count:null}] : []),
  ].filter(n => n === null || !clientMode || !ADMIN_ONLY_TABS.has(n.id));

  return(<><style>{CSS}</style><div className="dash">
  <div className="side"><div className="side-hd"><div className="side-brand">SignalScope</div><div className="side-camp">{camp.name}</div>{!clientMode&&<div className="side-back" onClick={()=>setCamp(null)}><I.Back/> All Campaigns</div>}{clientMode&&camp.desc&&<div style={{fontSize:10,color:"var(--t3)",marginTop:4,lineHeight:1.4}}>{camp.desc}</div>}</div>
  <div className="side-nav">{navs.map((n,i)=> n===null
    ? <div key={"sep"+i} style={{height:1,background:"var(--bdr)",margin:"6px 12px"}}/>
    : <div key={n.id} className={"nav-i"+(tab===n.id?" on":"")} onClick={()=>{setTab(n.id);if(n.id==="outreach")loadOutreachStats()}}><span>{n.label}</span>{n.count!==null&&n.count>0&&<span className="cnt">{n.count}</span>}</div>
  )}</div>
  <div style={{padding:"12px 16px",borderTop:"1px solid var(--bdr)"}}>
    {/* Airtable Base — admin only */}
    {!clientMode&&(<>
    <div style={{marginBottom:10}}>
      <div style={{fontSize:9,fontWeight:600,color:"var(--t3)",textTransform:"uppercase",letterSpacing:".05em",marginBottom:4}}>Airtable Base</div>
      {editingBase ? (
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          <input className="inp" style={{fontSize:10,padding:"5px 8px"}} value={baseInput} onChange={e=>{setBaseInput(e.target.value);setBaseError("")}} placeholder="Paste base URL or ID…" autoFocus onKeyDown={e=>{if(e.key==="Escape"){setEditingBase(false);setBaseInput("");setBaseError("")}}}/>
          {baseError&&<div style={{fontSize:9,color:"var(--red)",padding:"4px 0"}}>{baseError}</div>}
          <div style={{display:"flex",gap:4}}>
            <button className="btn btn-s btn-p" style={{flex:1,justifyContent:"center",fontSize:9}} disabled={!baseInput.trim()||baseConnecting} onClick={async()=>{
              setBaseConnecting(true);setBaseError("");
              try{await updateCampaignBase(baseInput.trim());setEditingBase(false);setBaseInput("")}catch(e){setBaseError(e.message)}
              setBaseConnecting(false);
            }}>{baseConnecting?"Connecting…":"Connect"}</button>
            <button className="btn btn-s" style={{fontSize:9}} onClick={()=>{setEditingBase(false);setBaseInput("");setBaseError("")}}>Cancel</button>
          </div>
        </div>
      ) : (
        <div style={{display:"flex",alignItems:"center",gap:4}}>
          <span style={{fontSize:9,color:bid?"var(--t2)":"var(--amb)",fontFamily:"'JetBrains Mono',monospace",flex:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{bid||"Using master base"}</span>
          <button className="btn btn-s" style={{padding:"2px 6px",fontSize:8}} onClick={()=>{setEditingBase(true);setBaseInput(bid||"")}}>{bid?"Change":"Set"}</button>
        </div>
      )}
    </div>
    <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:8}}>{activeFeatures.map(f=><span key={f} className="feat-tag" style={{background:"var(--acc-d)",color:"var(--acc)"}}>{ALL_FEATURES.find(af=>af.id===f)?.emoji} {f.replace(/_/g," ")}</span>)}</div>
    <div style={{display:"flex",gap:6,marginBottom:6}}>
      <button className="btn btn-s" style={{flex:1,justifyContent:"center",fontSize:10}} onClick={async()=>{setSetupStatus("testing");try{const r=await at("test","",{},bid);setSetupStatus({test:r})}catch(e){setSetupStatus({test:{steps:[{step:"API",ok:false,msg:e.message}]}})}}} disabled={setupStatus==="loading"||setupStatus==="testing"}>{setupStatus==="testing"?"⏳":"🧪 Test"}</button>
      <button className="btn btn-s btn-p" style={{flex:1,justifyContent:"center",fontSize:10}} onClick={async()=>{setSetupStatus("loading");try{const r=await at("setup","",{},bid);setSetupStatus(r)}catch(e){setSetupStatus({errors:[e.message]})}}} disabled={setupStatus==="loading"||setupStatus==="testing"}>{setupStatus==="loading"?"⏳":"🔧 Setup"}</button>
    </div>
    {setupStatus&&setupStatus!=="loading"&&setupStatus!=="testing"&&(<div style={{marginTop:4,fontSize:9,lineHeight:1.6,maxHeight:120,overflowY:"auto"}}>
      {setupStatus.test?.steps?.map((s,i)=>(<div key={i} style={{color:s.ok?"var(--grn)":"var(--red)"}}>{s.ok?"✅":"❌"} {s.step}: {s.msg}</div>))}
      {setupStatus.tables_created?.length>0&&<div style={{color:"var(--grn)"}}>🆕 Created {setupStatus.tables_created.length} tables: {setupStatus.tables_created.join(", ")}</div>}
      {setupStatus.fields_created?.length>0&&<div style={{color:"var(--grn)"}}>✅ Created {setupStatus.fields_created.length} fields</div>}
      {setupStatus.fields_skipped?.length>0&&<div style={{color:"var(--t3)"}}>⏭ {setupStatus.fields_skipped.length} fields already exist</div>}
      {setupStatus.tables_found&&<div style={{color:"var(--t3)"}}>📋 {setupStatus.tables_found.join(", ")}</div>}
      {setupStatus.errors?.length>0&&setupStatus.errors.map((e,i)=><div key={i} style={{color:"var(--red)"}}>❌ {e}</div>)}
      {!setupStatus.tables_created?.length&&!setupStatus.fields_created?.length&&!setupStatus.errors?.length&&!setupStatus.test&&<div style={{color:"var(--grn)"}}>✅ All good!</div>}
    </div>)}
    </>)}
    {/* LinkedIn Status */}
    <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid var(--bdr)"}}>
      <div style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer"}} onClick={()=>setTab("outreach")}>
        <div style={{width:8,height:8,borderRadius:"50%",background:linkedinAccount?"var(--grn)":"var(--t3)"}}/>
        <span style={{fontSize:10,color:"var(--t2)",flex:1}}>LinkedIn {linkedinAccount?"Connected":"Not connected"}</span>
        <span style={{fontSize:9,color:"var(--t3)"}}>→</span>
      </div>
    </div>
  </div>
  </div>

  <div className="main">{loading&&<div style={{textAlign:"center",padding:40,color:"var(--t3)"}}>Loading…</div>}

  {/* ════ DASHBOARD ════ */}
  {tab==="dashboard"&&!loading&&(<div>
    <div className="ph"><div><div className="pt">{clientMode ? `${camp.emoji||"📊"} ${camp.name}` : "Dashboard"}</div><div className="pd">{clientMode ? "Your campaign workspace — everything in one view" : `${camp.name} — Real-time overview`}</div></div>
      <div style={{display:"flex",gap:6}}>
        {hasSignals&&!clientMode&&<>
          <button className="btn btn-s btn-p" onClick={()=>startScan("news")} disabled={scanning||!accounts.length||!newsRuleCount} title={!newsRuleCount?"No news or both-type rules":`Scan ${newsRuleCount} news rule${newsRuleCount===1?"":"s"}`}>{scanning?"⏳ "+Math.round(scanProg)+"%":<>📰 News</>}</button>
          <button className="btn btn-s btn-p" onClick={()=>startScan("jobs")} disabled={scanning||!accounts.length||!jobsRuleCount} title={!jobsRuleCount?"No job_post or both-type rules":`Scan ${jobsRuleCount} jobs rule${jobsRuleCount===1?"":"s"}`}>{scanning?"⏳ "+Math.round(scanProg)+"%":<>📋 Jobs</>}</button>
        </>}
      </div>
    </div>

    {(() => {
      // ─── Compute all derived dashboard data ───
      const now = Date.now();
      const today = new Date(); today.setHours(0,0,0,0);
      const todayMs = today.getTime();
      const week = todayMs - 7 * 86400000;
      const month = todayMs - 30 * 86400000;

      // Tasks
      const parseDate = (s) => { if (!s) return NaN; const t = new Date(s).getTime(); return isNaN(t) ? NaN : t; };
      const tasksToday = tasks.filter(t => { const d = parseDate(t.fields?.Date || t.fields?.Created); return !isNaN(d) && d >= todayMs; });
      const tasksWeek = tasks.filter(t => { const d = parseDate(t.fields?.Date || t.fields?.Created); return !isNaN(d) && d >= week; });
      const tasksMonth = tasks.filter(t => { const d = parseDate(t.fields?.Date || t.fields?.Created); return !isNaN(d) && d >= month; });
      const tasksByType = tasks.reduce((acc, t) => { const k = t.fields?.["Task Type"] || "other"; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
      const tasksHubspot = tasks.filter(t => t.fields?.["HubSpot Task ID"]);
      const tasksWithPhone = tasks.filter(t => t.fields?.Phone);
      const tasksAvgScore = tasks.length > 0 ? Math.round(tasks.reduce((s, t) => s + (t.fields?.Score || 0), 0) / tasks.length) : 0;
      const hotTasks = [...tasks].sort((a, b) => (b.fields?.Score || 0) - (a.fields?.Score || 0)).slice(0, 5);

      // Leads
      const leadsWithEmail = leads.filter(l => (l.fields?.Email || "").includes("@"));
      const leadsWithLinkedIn = leads.filter(l => l.fields?.["LinkedIn URL"]);
      const leadsWithPhone = leads.filter(l => l.fields?.Phone);

      // GA engagement
      const gaLeads = leads.filter(l => (l.fields?.["GA Engagement Score"] || 0) > 0);
      const gaHot = gaLeads.filter(l => (l.fields?.["GA Engagement Score"] || 0) >= 51);
      const gaWarm = gaLeads.filter(l => { const s = l.fields?.["GA Engagement Score"] || 0; return s >= 21 && s <= 50; });
      const gaCool = gaLeads.filter(l => { const s = l.fields?.["GA Engagement Score"] || 0; return s >= 1 && s <= 20; });
      const gaThisWeek = leads.filter(l => { const d = parseDate(l.fields?.["GA Last Visit"]); return !isNaN(d) && d >= week; });
      const gaTotalSessions = gaLeads.reduce((s, l) => s + (l.fields?.["GA Sessions"] || 0), 0);
      const topGaLeads = [...gaLeads].sort((a, b) => (b.fields?.["GA Engagement Score"] || 0) - (a.fields?.["GA Engagement Score"] || 0)).slice(0, 5);

      // Outreach
      const ot = outreachStats || {};
      const otTotal = ot.total || 0;
      const otReplyRate = (ot.connectionSent + ot.connected) > 0 ? Math.round((ot.replied / (ot.connectionSent + ot.connected)) * 100) : 0;
      const otAcceptRate = ot.connectionSent > 0 ? Math.round((ot.connected / ot.connectionSent) * 100) : 0;

      // Health checks
      const issues = [];
      if (accounts.length === 0) issues.push({ severity: "warn", text: "No accounts uploaded — needed for signal scanning", action: () => setTab("accounts") });
      if (rules.length === 0) issues.push({ severity: "warn", text: "No task rules configured", action: () => setTab("rules") });
      if (leads.length > 0 && leadsWithEmail.length / leads.length < 0.5) issues.push({ severity: "info", text: `${Math.round(leadsWithEmail.length / leads.length * 100)}% of leads have emails — enrich for higher coverage`, action: () => setTab("leads") });
      if (hasOutreach && !linkedinAccount) issues.push({ severity: "warn", text: "LinkedIn outreach enabled but Unipile not connected", action: () => setTab("linkedin_outreach") });
      if (tasks.length > 50 && !hsConnected) issues.push({ severity: "info", text: `${tasks.length} tasks ready — connect HubSpot to push them`, action: () => setTab("hubspot") });

      const StatTile = ({ label, value, sub, emoji, color, trend, onClick }) => (
        <div onClick={onClick} style={{padding:"14px 16px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,cursor:onClick?"pointer":"default",transition:"border-color .15s,transform .15s"}} onMouseOver={e=>{if(onClick){e.currentTarget.style.borderColor="var(--acc)";e.currentTarget.style.transform="translateY(-1px)"}}} onMouseOut={e=>{e.currentTarget.style.borderColor="var(--bdr)";e.currentTarget.style.transform="none"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
            <span style={{fontSize:18,opacity:.85}}>{emoji}</span>
            {trend != null && <span style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:trend>0?"var(--grn-d)":"var(--hover)",color:trend>0?"var(--grn)":"var(--t3)",fontWeight:600}}>{trend>0?"+":""}{trend}</span>}
          </div>
          <div style={{fontSize:22,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:color||"var(--t1)",lineHeight:1.1}}>{value}</div>
          <div style={{fontSize:10,color:"var(--t3)",marginTop:4,fontWeight:500}}>{label}</div>
          {sub && <div style={{fontSize:9,color:"var(--t3)",marginTop:2,opacity:.75}}>{sub}</div>}
        </div>
      );

      const SectionHeader = ({ title, sub, action, actionLabel }) => (
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10,marginTop:24}}>
          <div>
            <div style={{fontSize:12,fontWeight:700,color:"var(--t1)",letterSpacing:".3px",textTransform:"uppercase"}}>{title}</div>
            {sub && <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>{sub}</div>}
          </div>
          {action && <button className="btn btn-s" style={{fontSize:10}} onClick={action}>{actionLabel || "View →"}</button>}
        </div>
      );

      return (<>
        {/* ───── HEALTH BANNER (only if issues) ───── */}
        {issues.length > 0 && (
          <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:20}}>
            <div style={{fontSize:11,fontWeight:600,color:"var(--t2)",marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
              <span style={{fontSize:14}}>⚠️</span> {issues.length} item{issues.length===1?"":"s"} need attention
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {issues.map((iss, i) => (
                <div key={i} onClick={iss.action} style={{padding:"8px 12px",background:iss.severity==="warn"?"rgba(245,158,11,.08)":"var(--hover)",borderRadius:6,fontSize:11,color:iss.severity==="warn"?"var(--amb)":"var(--t2)",cursor:iss.action?"pointer":"default",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span>{iss.text}</span>
                  {iss.action && <span style={{fontSize:10,opacity:.7}}>→</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ───── TODAY'S PULSE ───── */}
        <SectionHeader title="📊 Activity Pulse" sub="What's happening right now" />
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:8}}>
          <StatTile label="Tasks today" value={tasksToday.length} sub={`${tasksWeek.length} this week`} emoji="📋" color="var(--acc)" onClick={()=>setTab("tasks")} />
          <StatTile label="GA visitors / wk" value={gaThisWeek.length} sub={`${gaTotalSessions} total sessions`} emoji="📈" color="var(--blu)" onClick={()=>setTab("ga")} />
          <StatTile label="Hot leads (GA)" value={gaHot.length} sub={gaHot.length > 0 ? "Score 51+" : "No hot leads yet"} emoji="🔥" color={gaHot.length>0?"var(--red)":"var(--t3)"} onClick={()=>setTab("ga")} />
          <StatTile label="LinkedIn replies" value={ot.replied || 0} sub={otReplyRate > 0 ? `${otReplyRate}% reply rate` : "—"} emoji="💬" color={ot.replied>0?"var(--grn)":"var(--t3)"} onClick={()=>setTab("linkedin_outreach")} />
        </div>

        {/* ───── PIPELINE ───── */}
        <SectionHeader title="📦 Pipeline" sub="Your data inventory" />
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10}}>
          <StatTile label="Accounts" value={accounts.length} sub="Target companies" emoji="🏢" onClick={()=>setTab("accounts")} />
          <StatTile label="Leads" value={leads.length} sub={`${leadsWithEmail.length} with email · ${leadsWithLinkedIn.length} with LinkedIn`} emoji="👤" onClick={()=>setTab("leads")} />
          <StatTile label="Task Rules" value={rules.length} sub={hasNews||hasJobs||hasTopX?"Active":"—"} emoji="⚙️" onClick={()=>setTab("rules")} />
          <StatTile label="Tasks" value={tasks.length} sub={`Avg score ${tasksAvgScore} · ${tasksMonth.length} this month`} emoji="📋" color={tasksAvgScore>=70?"var(--grn)":"var(--t1)"} onClick={()=>setTab("tasks")} />
        </div>

        {/* ───── GA ENGAGEMENT BREAKDOWN ───── */}
        {gaLeads.length > 0 && (<>
          <SectionHeader title="📈 Website Engagement (GA)" sub={`${gaLeads.length} leads scored from analytics`} action={()=>setTab("ga")} />
          <div style={{display:"grid",gridTemplateColumns:"2fr 3fr",gap:14,marginBottom:8}}>
            {/* Engagement breakdown */}
            <div style={{padding:16,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
              <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,fontWeight:500}}>Engagement Distribution</div>
              {[
                {label:"🔥 Hot (51+)",count:gaHot.length,color:"var(--red)"},
                {label:"⚡ Interested (21-50)",count:gaWarm.length,color:"var(--amb)"},
                {label:"👀 Warm (1-20)",count:gaCool.length,color:"var(--t2)"},
              ].map(b => {
                const pct = gaLeads.length > 0 ? (b.count / gaLeads.length * 100) : 0;
                return (
                  <div key={b.label} style={{marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:11}}>
                      <span style={{color:"var(--t2)"}}>{b.label}</span>
                      <span style={{color:b.color,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{b.count}</span>
                    </div>
                    <div style={{height:5,background:"var(--hover)",borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:pct+"%",background:b.color,borderRadius:3,transition:"width .3s"}}/>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Top engaged leads */}
            <div style={{padding:16,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
              <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,fontWeight:500}}>Top Engaged Leads</div>
              {topGaLeads.length === 0 ? (
                <div style={{fontSize:10,color:"var(--t3)",fontStyle:"italic"}}>No engaged leads yet</div>
              ) : topGaLeads.map(l => {
                const f = l.fields || {};
                const score = f["GA Engagement Score"] || 0;
                return (
                  <div key={l.id} onClick={()=>setTab("ga")} style={{padding:"6px 0",borderBottom:"1px solid var(--bdr)",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:11,color:"var(--t1)",fontWeight:500,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{f.Name || "(no name)"}</div>
                      <div style={{fontSize:9,color:"var(--t3)"}}>{f.Title || ""}{f.Title && f.Company ? " · " : ""}{f.Company || ""}</div>
                    </div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginLeft:8}}>
                      <span style={{fontSize:9,color:"var(--t3)"}}>{f["GA Sessions"] || 0} sess</span>
                      <span style={{fontSize:11,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:score>=51?"var(--red)":score>=21?"var(--amb)":"var(--t2)",minWidth:26,textAlign:"right"}}>{score}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>)}

        {/* ───── OUTREACH ───── */}
        {(otTotal > 0 || hasOutreach) && (<>
          <SectionHeader title="💬 LinkedIn Outreach" sub={otTotal > 0 ? `${otTotal} leads in queue` : "Configure rules to start"} action={()=>setTab("linkedin_outreach")} />
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:10,marginBottom:8}}>
            <StatTile label="Queued" value={ot.queued || 0} emoji="⏱" color="var(--t2)" />
            <StatTile label="Conn. sent" value={ot.connectionSent || 0} emoji="✉" color="var(--blu)" sub={otAcceptRate > 0 ? `${otAcceptRate}% accept` : null} />
            <StatTile label="Connected" value={ot.connected || 0} emoji="✅" color="var(--grn)" />
            <StatTile label="Replied" value={ot.replied || 0} emoji="💬" color="var(--grn)" sub={otReplyRate > 0 ? `${otReplyRate}% reply` : null} />
            {ot.errors > 0 && <StatTile label="Errors" value={ot.errors} emoji="⚠" color="var(--red)" />}
          </div>
          {/* Reply intent breakdown — only shown when we have classified replies */}
          {(() => {
            const repliedItems = (outreachItems || []).filter(q => q.fields?.Status === "replied");
            if (repliedItems.length === 0) return null;
            const byIntent = repliedItems.reduce((acc, q) => { const i = q.fields?.["Reply Intent"] || "unclassified"; acc[i] = (acc[i] || 0) + 1; return acc; }, {});
            const interested = repliedItems.filter(q => q.fields?.["Reply Intent"] === "interested");
            const intentMeta = {
              interested: { emoji: "🔥", label: "Interested", color: "var(--grn)" },
              objection: { emoji: "⚖️", label: "Objection", color: "var(--amb)" },
              referral: { emoji: "↪️", label: "Referral", color: "var(--blu)" },
              not_interested: { emoji: "❌", label: "Not interested", color: "var(--red)" },
              out_of_office: { emoji: "🏖", label: "OOO", color: "var(--t3)" },
              auto_reply: { emoji: "🤖", label: "Auto-reply", color: "var(--t3)" },
              unclear: { emoji: "❓", label: "Unclear", color: "var(--t3)" },
              unclassified: { emoji: "•", label: "Unclassified", color: "var(--t3)" },
            };
            return (
              <div style={{marginTop:12}}>
                <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
                  <div style={{fontSize:11,color:"var(--t3)",marginBottom:10,fontWeight:500,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span>Reply intent distribution ({repliedItems.length} replies)</span>
                    {interested.length > 0 && <button className="btn btn-s btn-p" style={{fontSize:9}} onClick={()=>setTab("linkedin_outreach")}>{interested.length} hot lead{interested.length===1?"":"s"} to action →</button>}
                  </div>
                  <div style={{display:"flex",height:8,borderRadius:4,overflow:"hidden",background:"var(--hover)",marginBottom:8}}>
                    {Object.entries(byIntent).sort((a,b) => b[1] - a[1]).map(([k, v]) => {
                      const pct = (v / repliedItems.length) * 100;
                      return <div key={k} style={{width:pct+"%",background:intentMeta[k]?.color || "var(--t3)"}} title={`${intentMeta[k]?.label || k}: ${v}`} />;
                    })}
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:10,fontSize:10,color:"var(--t2)"}}>
                    {Object.entries(byIntent).sort((a,b) => b[1] - a[1]).map(([k, v]) => {
                      const m = intentMeta[k] || intentMeta.unclassified;
                      return (
                        <span key={k} style={{display:"inline-flex",alignItems:"center",gap:4}}>
                          <span style={{width:6,height:6,borderRadius:"50%",background:m.color}}/>
                          {m.emoji} <strong style={{color:m.color}}>{v}</strong> {m.label}
                        </span>
                      );
                    })}
                  </div>
                  {/* Show top 3 interested replies inline for quick action */}
                  {interested.length > 0 && (
                    <div style={{marginTop:12,paddingTop:12,borderTop:"1px solid var(--bdr)"}}>
                      <div style={{fontSize:10,color:"var(--t3)",marginBottom:6,fontWeight:500}}>🔥 Recent interested replies:</div>
                      {interested.slice(0,3).map(q => {
                        const f = q.fields || {};
                        return (
                          <div key={q.id} onClick={()=>setTab("linkedin_outreach")} style={{padding:"6px 0",borderBottom:"1px solid var(--bdr)",cursor:"pointer",fontSize:10}}>
                            <div style={{color:"var(--t1)",fontWeight:500}}>{f["Lead Name"] || "—"} <span style={{color:"var(--t3)",fontWeight:400}}>· {f.Company || ""}</span></div>
                            {f["Reply Summary"] && <div style={{color:"var(--t2)",marginTop:2,fontSize:10}}>"{f["Reply Summary"].slice(0, 120)}{f["Reply Summary"].length > 120 ? "..." : ""}"</div>}
                            {f["Reply Suggested Action"] && <div style={{color:"var(--grn)",marginTop:2,fontSize:9}}>→ {f["Reply Suggested Action"].slice(0, 100)}</div>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            );
          })()}
        </>)}

        {/* ───── HUBSPOT SYNC HEALTH ───── */}
        {hsConnected && (<>
          <SectionHeader title="🔗 HubSpot Sync" sub={`${tasksHubspot.length} of ${tasks.length} tasks tracked`} action={()=>setTab("hubspot")} />
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:10}}>
            <StatTile label="Synced tasks" value={tasksHubspot.length} sub={tasks.length>0?`${Math.round(tasksHubspot.length/tasks.length*100)}% coverage`:""} emoji="✅" color="var(--grn)" onClick={()=>setTab("hubspot")} />
            <StatTile label="Untracked" value={tasks.length - tasksHubspot.length} sub={tasks.length-tasksHubspot.length>0?"Run backfill":"All synced"} emoji="📥" color={tasks.length-tasksHubspot.length>0?"var(--amb)":"var(--t3)"} onClick={()=>setTab("hubspot")} />
            <StatTile label="With phone" value={tasksWithPhone.length} sub={`Of ${tasks.length} tasks`} emoji="📞" color="var(--t2)" onClick={()=>setTab("tasks")} />
            <StatTile label="HubSpot key" value={hsMasked || "✓"} sub="Connected" emoji="🔑" color="var(--grn)" />
          </div>
        </>)}

        {/* ───── TASK BREAKDOWN BY TYPE ───── */}
        {Object.keys(tasksByType).length > 0 && (<>
          <SectionHeader title="📋 Tasks by Source" sub="Where your tasks are coming from" />
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:10}}>
            {Object.entries(tasksByType).sort((a,b)=>b[1]-a[1]).map(([type, count]) => {
              const emojiMap = { news: "📰", job_post: "💼", top_x: "🎯", linkedin_engagement: "🔗", linkedin_outreach: "🔗", engagement: "📈", website_engagement: "📈", post_demo: "🤖", other: "📋" };
              const labelMap = { news: "News signals", job_post: "Job posts", top_x: "Top X scoring", linkedin_engagement: "LinkedIn", linkedin_outreach: "LinkedIn outreach", engagement: "Website (GA)", website_engagement: "Website (GA)", post_demo: "Post-demo", other: "Other" };
              const pct = tasks.length > 0 ? Math.round(count / tasks.length * 100) : 0;
              return (
                <div key={type} onClick={()=>setTab("tasks")} style={{padding:"12px 14px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,cursor:"pointer"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontSize:14}}>{emojiMap[type] || "📋"}</span>
                    <span style={{fontSize:18,fontWeight:700,fontFamily:"'JetBrains Mono',monospace"}}>{count}</span>
                  </div>
                  <div style={{fontSize:10,color:"var(--t2)",marginBottom:4}}>{labelMap[type] || type.replace(/_/g, " ")}</div>
                  <div style={{height:3,background:"var(--hover)",borderRadius:2,overflow:"hidden"}}>
                    <div style={{height:"100%",width:pct+"%",background:"var(--acc)"}}/>
                  </div>
                  <div style={{fontSize:9,color:"var(--t3)",marginTop:3}}>{pct}% of tasks</div>
                </div>
              );
            })}
          </div>
        </>)}

        {/* ───── TOP HOT TASKS ───── */}
        {hotTasks.length > 0 && (<>
          <SectionHeader title="🔥 Highest-Scoring Tasks" sub="Top 5 by score" action={()=>setTab("tasks")} actionLabel="All Tasks →" />
          <div className="tw"><table><thead><tr><th>Company</th><th>Lead</th><th>Rule</th><th>Score</th><th>Type</th><th>Date</th></tr></thead>
          <tbody>{hotTasks.map(t => { const f = t.fields || {}; return (<tr key={t.id} style={{cursor:"pointer"}} onClick={()=>setTab("tasks")}>
            <td style={{color:"var(--t1)",fontWeight:500}}>{f.Company}</td>
            <td style={{fontSize:10,color:"var(--t2)"}}>{f["Lead Name"] || f["Scan Target"] || "—"}</td>
            <td style={{fontSize:10}}>{f["Task Rule"]}</td>
            <td><div className="sb"><div className="st"><div className="sf" style={{width:Math.min(100,f.Score||0)+"%",background:f.Score>=80?"var(--grn)":f.Score>=60?"var(--acc)":"var(--red)"}}/></div><span className="sv">{f.Score}</span></div></td>
            <td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="top_x"?"cp":"cg")}>{(f["Task Type"]||"news").replace(/_/g," ")}</span></td>
            <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f.Date}</td>
          </tr>);})}</tbody></table></div>
        </>)}

        {/* ───── INTEGRATIONS STATUS ───── */}
        <SectionHeader title="🔌 Integrations" sub="Connected systems" />
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(170px,1fr))",gap:10}}>
          {[
            {n:"Airtable",ok:!!bid,sub:bid?"Connected":"Not connected"},
            {n:"LinkedIn",ok:!!linkedinAccount,sub:linkedinAccount?linkedinAccount.name:"Not connected",onClick:()=>setTab("linkedin_outreach")},
            {n:"HubSpot",ok:hsConnected,sub:hsConnected?"Connected":"Not connected",onClick:()=>setTab("hubspot")},
            {n:"Google Analytics",ok:gaLeads.length > 0,sub:gaLeads.length>0?`${gaLeads.length} leads scored`:"Not configured",onClick:()=>setTab("ga")},
            {n:"Smartlead",ok:false,sub:"Email Campaign tab",onClick:()=>setTab("email_campaign")},
            {n:"Apollo (Enrich)",ok:tasksWithPhone.length>0,sub:tasksWithPhone.length>0?`${tasksWithPhone.length} enriched`:"Not used yet"},
          ].map(ig => (
            <div key={ig.n} onClick={ig.onClick} style={{padding:"12px 14px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,display:"flex",alignItems:"center",gap:10,cursor:ig.onClick?"pointer":"default",transition:"border-color .15s"}} onMouseOver={e=>{if(ig.onClick)e.currentTarget.style.borderColor="var(--acc)"}} onMouseOut={e=>e.currentTarget.style.borderColor="var(--bdr)"}>
              <div style={{width:8,height:8,borderRadius:"50%",background:ig.ok?"var(--grn)":"var(--t3)",flexShrink:0,boxShadow:ig.ok?"0 0 6px rgba(93,168,122,.6)":"none"}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>{ig.n}</div>
                <div style={{fontSize:9,color:"var(--t3)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{ig.sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* ───── AI USAGE & COST (admin-only — for client billing) ─────
            Tracks per-campaign OpenAI token usage and dollar cost. Used to bill
            clients for their share of the shared OpenAI key. Hidden in
            clientMode (clients shouldn't see billing internals or each other's
            costs). Reset button stamps a new billing cycle — typically run
            after invoicing the previous period. */}
        {!clientMode && (
          <div style={{marginTop:24}}>
            <SectionHeader title="💰 AI Usage & Cost" sub="OpenAI tokens billed to this campaign" />
            {aiUsage === null && aiUsageLoading ? (
              <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,textAlign:"center",color:"var(--t3)",fontSize:11}}>Loading usage…</div>
            ) : aiUsage === null ? (
              <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,textAlign:"center",color:"var(--t3)",fontSize:11}}>
                No AI usage data yet. Counters initialize on the first OpenAI call (any scan, AI scoring, or post-demo run).
              </div>
            ) : (
              <>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:10}}>
                  <StatTile
                    label="Total cost"
                    value={`$${(aiUsage.totalCostUSD || 0).toFixed(4)}`}
                    sub={aiUsage.resetAt ? `Since ${new Date(aiUsage.resetAt).toLocaleDateString()}` : "All-time"}
                    emoji="💵"
                    color={aiUsage.totalCostUSD > 5 ? "var(--amb)" : "var(--grn)"}
                  />
                  <StatTile
                    label="API calls"
                    value={(aiUsage.callsCount || 0).toLocaleString()}
                    sub={aiUsage.lastCallAt ? `Last: ${new Date(aiUsage.lastCallAt).toLocaleString()}` : "No calls yet"}
                    emoji="🔄"
                    color="var(--blu)"
                  />
                  <StatTile
                    label="Input tokens"
                    value={(aiUsage.inputTokens || 0).toLocaleString()}
                    sub={`Avg ${aiUsage.callsCount > 0 ? Math.round((aiUsage.inputTokens || 0) / aiUsage.callsCount).toLocaleString() : 0}/call`}
                    emoji="📥"
                    color="var(--t2)"
                  />
                  <StatTile
                    label="Output tokens"
                    value={(aiUsage.outputTokens || 0).toLocaleString()}
                    sub={`Avg ${aiUsage.callsCount > 0 ? Math.round((aiUsage.outputTokens || 0) / aiUsage.callsCount).toLocaleString() : 0}/call`}
                    emoji="📤"
                    color="var(--pur)"
                  />
                </div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,fontSize:10,color:"var(--t3)"}}>
                  <div>
                    <span style={{color:"var(--t2)"}}>For billing:</span> after invoicing the client for this period, click Reset to start a fresh accumulation cycle. Reset stamps "AI Usage Reset At" so you have a paper trail.
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button className="btn btn-s" onClick={loadAIUsage} disabled={aiUsageLoading} title="Refresh from Airtable">{aiUsageLoading ? "⏳" : "🔄"} Refresh</button>
                    <button className="btn btn-s btn-d" onClick={resetAIUsage} disabled={!aiUsage.callsCount} title={!aiUsage.callsCount ? "Nothing to reset" : "Zero out the counters and stamp a new cycle"}>↺ Reset Counters</button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ─── RapidAPI Usage & Cost (Lead Movement Scan) ──────────────
            Separate line item from AI because it bills against a different
            RapidAPI subscription. Shown only when there's been activity OR
            we have a perCallCost configured — keeps the dashboard clean for
            campaigns that haven't used Lead Movement yet. */}
        {!clientMode && (
          <div style={{marginTop:24}}>
            <SectionHeader title="🧭 RapidAPI Usage & Cost" sub="LinkedIn profile lookups (Lead Movement Scan) billed to this campaign" />
            {rapidApiUsage === null && rapidApiUsageLoading ? (
              <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,textAlign:"center",color:"var(--t3)",fontSize:11}}>Loading usage…</div>
            ) : rapidApiUsage === null || rapidApiUsage.callsCount === 0 ? (
              <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,textAlign:"center",color:"var(--t3)",fontSize:11}}>
                No RapidAPI usage yet. Counters initialize on the first Lead Movement scan. Per-call cost defaults to ${(rapidApiUsage?.perCallCostUSD || 0.01).toFixed(4)}; configure on Campaign record field "RapidAPI Per Call Cost USD" to match your actual plan.
              </div>
            ) : (
              <>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(160px,1fr))",gap:10,marginBottom:10}}>
                  <StatTile
                    label="Total cost"
                    value={`$${(rapidApiUsage.totalCostUSD || 0).toFixed(4)}`}
                    sub={rapidApiUsage.resetAt ? `Since ${new Date(rapidApiUsage.resetAt).toLocaleDateString()}` : "All-time"}
                    emoji="💵"
                    color={rapidApiUsage.totalCostUSD > 20 ? "var(--amb)" : "var(--grn)"}
                  />
                  <StatTile
                    label="Profile lookups"
                    value={(rapidApiUsage.callsCount || 0).toLocaleString()}
                    sub={rapidApiUsage.lastCallAt ? `Last: ${new Date(rapidApiUsage.lastCallAt).toLocaleString()}` : "No calls yet"}
                    emoji="🔍"
                    color="var(--blu)"
                  />
                  <StatTile
                    label="Per-call rate"
                    value={`$${(rapidApiUsage.perCallCostUSD || 0.01).toFixed(4)}`}
                    sub="Set on Campaign field"
                    emoji="💲"
                    color="var(--t2)"
                  />
                  <StatTile
                    label="Avg/scan"
                    value={rapidApiUsage.callsCount > 0 ? `$${((rapidApiUsage.totalCostUSD || 0) / Math.max(1, Math.ceil(rapidApiUsage.callsCount / 200))).toFixed(4)}` : "—"}
                    sub={`Est. ~${Math.ceil(rapidApiUsage.callsCount / 200)} scans`}
                    emoji="📊"
                    color="var(--pur)"
                  />
                </div>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 14px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,fontSize:10,color:"var(--t3)"}}>
                  <div>
                    <span style={{color:"var(--t2)"}}>For billing:</span> bills separately from AI usage. Set actual per-call cost on Campaign field "RapidAPI Per Call Cost USD" to match your plan.
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button className="btn btn-s" onClick={loadRapidAPIUsage} disabled={rapidApiUsageLoading} title="Refresh from Airtable">{rapidApiUsageLoading ? "⏳" : "🔄"} Refresh</button>
                    <button className="btn btn-s btn-d" onClick={resetRapidAPIUsage} disabled={!rapidApiUsage.callsCount} title={!rapidApiUsage.callsCount ? "Nothing to reset" : "Zero out the counters and stamp a new cycle"}>↺ Reset Counters</button>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </>);
    })()}

    {/* Empty state for first-time users */}
    {tasks.length===0&&accounts.length===0&&!clientMode&&(<div className="empty" style={{marginTop:30}}><div className="em">📡</div><p>Upload accounts & leads, create task rules, and run your first scan</p>
      <button className="btn btn-p" onClick={()=>setTab("accounts")}><I.Plus/> Start with Accounts</button>
    </div>)}

    {/* Client mode: Setup Guide (only show when not yet set up) */}
    {clientMode && (accounts.length===0 || leads.length===0 || rules.length===0) &&(<div style={{marginTop:24}}>
      <div style={{fontSize:14,fontWeight:700,color:"var(--t1)",marginBottom:4}}>🚀 Getting Started</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:16}}>Follow these steps to set up your campaign. Each step unlocks the next.</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {[
          {n:"Upload Accounts",d:"Upload your target company list (CSV). These are the companies you want to track signals for.",done:accounts.length>0,act:()=>setTab("accounts"),btn:"Upload Accounts"},
          {n:"Upload Leads",d:"Upload your contact list (CSV). Leads are the people at those companies you'll reach out to.",done:leads.length>0,act:()=>setTab("leads"),btn:"Upload Leads"},
          {n:"Create Task Rules",d:"Define what signals to watch for — news mentions, job posts, or score your leads with Top X.",done:rules.length>0,act:()=>setTab("rules"),btn:"Create Rule"},
          {n:"Run a Scan",d:"Execute your task rules. The AI scans RSS feeds, job boards, and scores leads to create actionable tasks.",done:tasks.length>0,act:()=>setTab("tasks"),btn:"Go to Tasks"},
          {n:"Connect HubSpot",d:"Push tasks and leads directly to your CRM. Run Post-Demo automation from your deal pipeline.",done:hsConnected,act:()=>setTab("hubspot"),btn:"Connect HubSpot"},
        ].map((step,i)=>(
          <div key={i} onClick={step.act} style={{padding:"16px 20px",background:"var(--card)",border:"1px solid "+(step.done?"rgba(93,168,122,.3)":"var(--bdr)"),borderRadius:10,cursor:"pointer",display:"flex",alignItems:"center",gap:14,transition:"all .15s"}} onMouseOver={e=>e.currentTarget.style.borderColor="var(--acc)"} onMouseOut={e=>e.currentTarget.style.borderColor=step.done?"rgba(93,168,122,.3)":"var(--bdr)"}>
            <div style={{width:32,height:32,borderRadius:"50%",background:step.done?"var(--grn-d)":"var(--hover)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
              {step.done ? <span style={{color:"var(--grn)",fontSize:14}}>✓</span> : <span style={{color:"var(--t3)",fontSize:12,fontWeight:700}}>{i+1}</span>}
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:600,color:step.done?"var(--grn)":"var(--t1)"}}>{step.n}</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:2,lineHeight:1.4}}>{step.d}</div>
            </div>
            {!step.done&&<button className="btn btn-s btn-p" onClick={e=>{e.stopPropagation();step.act()}}>{step.btn} →</button>}
          </div>
        ))}
      </div>
    </div>)}

    {/* Admin mode: Client Portal Link */}
    {!clientMode && camp?.airtableId && (<div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginTop:24}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:8}}>🔗 Client Portal</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:14,lineHeight:1.5}}>Share this link with your client. They get the full SignalScope experience without Airtable config or campaign switching.</div>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:12}}>
        <input className="inp" readOnly value={typeof window!=="undefined"?`${window.location.origin}/client/${camp.airtableId}`:""} style={{flex:1,fontSize:11,fontFamily:"'JetBrains Mono',monospace"}} onClick={e=>e.target.select()}/>
        <button className="btn btn-s btn-p" onClick={()=>{navigator.clipboard.writeText(`${window.location.origin}/client/${camp.airtableId}`)}}>📋 Copy Link</button>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Password Protection <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— optional, leave blank for open access</span></div>
        <div style={{display:"flex",gap:8}}>
          <input className="inp" placeholder="Set a password…" id="cp-pw-input" style={{flex:1}}/>
          <button className="btn btn-s" onClick={async()=>{
            const pw = document.getElementById("cp-pw-input")?.value || "";
            try{ await fetch("/api/airtable",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"update",table:"Campaigns",baseId:undefined,records:[{id:camp.airtableId,fields:{"Client Password":pw}}]})}); }catch{}
          }}>Save</button>
        </div>
      </div>
    </div>)}
  </div>)}

  {/* ════ GOOGLE ANALYTICS — admin only ════ */}
  {tab==="google_analytics"&&!loading&&!clientMode&&(<div>
    <div className="ph"><div><div className="pt">📊 Google Analytics</div><div className="pd">Connect GA4 to enrich leads with website engagement data — sliding 7-day window</div></div></div>
    <GoogleAnalyticsCard baseId={bid} campaign={camp} onSyncComplete={()=>at("list","Leads",{},bid).then(r=>setLeads(r.records||[]))} />
  </div>)}

  {/* ════ HUBSPOT — admin only ════ */}
  {tab==="hubspot"&&!loading&&!clientMode&&(<div>
    <div className="ph"><div><div className="pt">🔗 HubSpot Integration</div><div className="pd">Connect HubSpot, push tasks, manage enrichment</div></div></div>

    {/* Connection */}
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
        <div style={{width:10,height:10,borderRadius:"50%",background:hsConnected?"var(--grn)":"var(--red)"}}/>
        <span style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>{hsConnected?"HubSpot Connected":"Connect HubSpot"}</span>
        {hsConnected && <span style={{fontSize:10,color:"var(--t3)",marginLeft:"auto"}}>API Key: {hsMasked}</span>}
      </div>
      {!hsConnected ? (<div>
        <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,lineHeight:1.5}}>Enter your HubSpot Private App access token. Create one in HubSpot → Settings → Integrations → Private Apps. Needs scopes: <code style={{background:"var(--hover)",padding:"1px 4px",borderRadius:3,fontSize:10}}>crm.objects.contacts.read</code>, <code style={{background:"var(--hover)",padding:"1px 4px",borderRadius:3,fontSize:10}}>crm.objects.owners.read</code>, <code style={{background:"var(--hover)",padding:"1px 4px",borderRadius:3,fontSize:10}}>tickets</code>.</div>
        <div style={{display:"flex",gap:8}}>
          <input className="inp" type="password" placeholder="pat-na1-xxxxxxxx..." value={hsKey} onChange={e=>setHsKey(e.target.value)} style={{flex:1}}/>
          <button className="btn btn-p btn-s" disabled={!hsKey.trim()||hsLoading} onClick={()=>connectHubSpot(hsKey)}>{hsLoading?"⏳":"Connect"}</button>
        </div>
      </div>) : (<div>
        <div style={{display:"flex",gap:8}}>
          <button className="btn btn-s" onClick={async()=>{const d=await hsAPI("test");setHsMsg(d.ok?"✅ Connection healthy":"❌ "+d.error)}} disabled={hsLoading}>🧪 Test Connection</button>
          <button className="btn btn-s" onClick={()=>{setHsConnected(false);setHsMasked("")}}>Disconnect</button>
        </div>
      </div>)}
      {hsMsg && <div style={{marginTop:8,fontSize:11,color:hsMsg.startsWith("✅")||hsMsg.startsWith("🔄")||hsMsg.includes("updated")||hsMsg.includes("created")?"var(--grn)":hsMsg.startsWith("❌")?"var(--red)":"var(--t2)"}}>{hsMsg}</div>}
    </div>

    {hsConnected && (<>
    {/* Push Tasks */}
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:12}}>📋 Push Tasks to HubSpot</div>
      {tasks.length === 0 ? <div style={{fontSize:11,color:"var(--t3)"}}>No tasks to push. Run a scan first.</div> : (<div>
        <div style={{fontSize:11,color:"var(--t3)",marginBottom:12}}>{tasks.length} tasks available. Select tasks on the Tasks tab, or push all.</div>
        <PushToHubSpotForm tasks={tasks} owners={hsOwners} onPush={pushToHubSpot} loading={hsLoading} rules={rules}/>
      </div>)}
    </div>

    {/* Enrich + Push */}
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:8}}>📞 Enrich & Push</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,lineHeight:1.5}}>Enrich tasks with phone numbers via Apollo, then push enriched tasks to HubSpot. Requires <code style={{background:"var(--hover)",padding:"1px 4px",borderRadius:3,fontSize:10}}>APOLLO_API_KEY</code> env var.</div>
      <button className="btn btn-s" style={{color:"var(--pur)",borderColor:"rgba(155,126,216,.3)"}} disabled={!tasks.length} onClick={()=>setEnrichModal({mode:"select"})}><I.Sparkle/> Enrich Phone Numbers</button>
    </div>

    {/* Upload Leads to HubSpot */}
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:8}}>👤 Upload Leads to HubSpot</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,lineHeight:1.5}}>Push your SignalScope leads directly to HubSpot as contacts. Existing contacts (matched by email) will be updated, new ones created.</div>
      {leads.length === 0 ? <div style={{fontSize:11,color:"var(--t3)"}}>No leads loaded. Upload leads on the Leads tab first.</div> : (
        <LeadsToHubSpotForm leads={leads} owners={hsOwners} onPush={pushLeadsToHS} loading={hsLoading}/>
      )}
    </div>

    {/* Repair Orphaned Tasks */}
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:8}}>🔧 HubSpot Repair Tools</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,lineHeight:1.5}}>
        <strong style={{color:"var(--t2)"}}>Repair Orphans</strong>: Find HubSpot tasks with no contact linked and retroactively link them. Creates associations.<br/>
        <strong style={{color:"var(--t2)"}}>Backfill IDs</strong>: Match existing HubSpot tasks to your Airtable tasks and save their IDs. No HubSpot changes — just syncs IDs so future pushes update instead of duplicating.
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button className="btn btn-s" onClick={openRepairModal} disabled={hsLoading}><I.Sparkle/> Find Orphaned Tasks</button>
        <button className="btn btn-s" onClick={runBackfillIds} disabled={hsLoading || backfillRunning} style={{color:"var(--t2)"}}>
          {backfillRunning ? "⏳ Backfilling..." : "💾 Backfill HubSpot IDs"}
        </button>
      </div>
      {backfillMsg && <div style={{marginTop:12,padding:10,background:backfillMsg.startsWith("✅")?"var(--grn-d)":backfillMsg.startsWith("⏳")?"var(--hover)":"var(--red-d)",color:backfillMsg.startsWith("✅")?"var(--grn)":backfillMsg.startsWith("⏳")?"var(--t2)":"var(--red)",borderRadius:6,fontSize:11,lineHeight:1.5,whiteSpace:"pre-wrap"}}>{backfillMsg}</div>}
    </div>
    </>)}
  </div>)}

  {/* ════ POST-DEMO AUTOMATION — admin only ════ */}
  {tab==="post_demo"&&!loading&&!clientMode&&(<div>
    <div className="ph"><div><div className="pt">🤖 Post-Demo Automation</div><div className="pd">HubSpot deal stage → AI reads full history → SDR tasks</div></div></div>
    {!hsConnected?(
      <div className="empty"><div className="em">🔗</div><p>Connect HubSpot first</p><button className="btn btn-p" onClick={()=>setTab("hubspot")}>Go to HubSpot →</button></div>
    ):(<>
    {/* Step 1: Pipeline + Stage */}
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}><span style={{width:22,height:22,borderRadius:"50%",background:"var(--acc)",color:"#0a0a0c",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700}}>1</span><span style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>Select Deal Pipeline & Trigger Stage</span><span style={{fontSize:9,padding:"2px 8px",background:"rgba(91,143,212,.12)",color:"var(--blu)",borderRadius:4}}>from HubSpot</span></div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:14,lineHeight:1.5}}>Pick which deal stage triggers follow-up task creation. AI will read each contact's full HubSpot history + analyze closed-won patterns.</div>
      <div className="ig" style={{marginBottom:12}}><div className="il">Rule Name</div><input className="inp" value={pdRule.name} onChange={e=>setPdRule(p=>({...p,name:e.target.value}))} placeholder="e.g. Post-Demo Follow-up"/></div>
      {pdPipelines.length===0?(
        <button className="btn btn-s btn-p" disabled={pdLoading} onClick={async()=>{setPdLoading(true);try{const r=await fetch("/api/post-demo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"get_pipelines",campaignId:camp?.airtableId,apiKey:hsApiKeyRef.current})});setPdPipelines((await r.json()).pipelines||[])}catch{}setPdLoading(false)}}>{pdLoading?"⏳":"📊 Load Pipelines from HubSpot"}</button>
      ):(
        <div>{pdPipelines.map(pl=>(<div key={pl.id} style={{marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:600,color:"var(--t2)",marginBottom:10}}>📊 {pl.label}</div>
          <div style={{display:"flex",flexWrap:"wrap",gap:6}}>{pl.stages.map((st,idx)=>(<button key={st.id} onClick={async()=>{setPdRule(p=>({...p,stageId:st.id,stageName:st.label,pipelineId:pl.id}));setPdStagePreview(null);setPdResults(null);try{const r=await fetch("/api/post-demo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"get_stage_deals",campaignId:camp?.airtableId,apiKey:hsApiKeyRef.current,stageId:st.id})});setPdStagePreview(await r.json())}catch{}}} style={{padding:"8px 14px",borderRadius:8,border:"1px solid "+(pdRule.stageId===st.id?"var(--acc)":"var(--bdr)"),background:pdRule.stageId===st.id?"var(--acc-d)":"var(--hover)",cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
            <span style={{fontSize:9,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{idx+1}</span>
            <span style={{fontSize:11,color:pdRule.stageId===st.id?"var(--acc)":"var(--t1)",fontWeight:pdRule.stageId===st.id?600:400}}>{st.label}</span>
          </button>))}</div>
        </div>))}<button className="btn btn-s" style={{fontSize:9}} onClick={()=>setPdPipelines([])}>↻ Reload</button></div>
      )}
    </div>
    {/* Stage preview */}
    {pdStagePreview&&pdRule.stageId&&(<div style={{padding:16,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
      <div style={{fontSize:12,fontWeight:600,color:"var(--t2)",marginBottom:8}}>📋 {pdStagePreview.totalDeals} deal{pdStagePreview.totalDeals!==1?"s":""} at "{pdRule.stageName}"</div>
      {pdStagePreview.previews?.length>0?(<div className="tw"><table><thead><tr><th>Contact</th><th>Company</th><th>Title</th><th>Email</th><th>Deal</th></tr></thead>
        <tbody>{pdStagePreview.previews.map((p,i)=><tr key={i}><td style={{color:"var(--t1)",fontWeight:500}}>{p.name}</td><td>{p.company}</td><td style={{fontSize:10}}>{p.title}</td><td style={{fontSize:10}}>{p.email}</td><td style={{fontSize:10,color:"var(--acc)"}}>{p.deal}</td></tr>)}</tbody></table></div>)
      :<div style={{fontSize:11,color:"var(--t3)"}}>No deals at this stage</div>}
    </div>)}
    {/* Step 2: AI + Run */}
    {pdRule.stageId&&(<div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}><span style={{width:22,height:22,borderRadius:"50%",background:"var(--acc)",color:"#0a0a0c",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:700}}>2</span><span style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>Configure & Run</span></div>
      <div style={{padding:10,background:"var(--hover)",borderRadius:8,marginBottom:14,fontSize:11,color:"var(--t2)",lineHeight:1.6}}>🎯 <strong>Trigger:</strong> Deals at <strong style={{color:"var(--acc)"}}>{pdRule.stageName}</strong><br/>📖 AI reads each contact's emails, meetings, calls, notes from HubSpot + analyzes closed-won deal patterns</div>
      <div className="ig"><div className="il">AI Instructions</div><textarea className="inp" value={pdRule.aiPrompt} onChange={e=>setPdRule(p=>({...p,aiPrompt:e.target.value}))} style={{minHeight:80}} placeholder={"Create follow-up tasks after the demo.\n- Reference their meeting outcomes and emails\n- Compare to closed-won deal patterns\n- If phone exists → call task\n- Suggest timing based on deal urgency"}/></div>
      <button className="btn btn-p btn-s" disabled={pdLoading} onClick={async()=>{setPdLoading(true);setPdResults(null);try{const r=await fetch("/api/post-demo",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"run",campaignId:camp?.airtableId,apiKey:hsApiKeyRef.current,baseId:bid,rule:pdRule})});const d=await r.json();setPdResults(d);if(d.tasksCreated>0){const all=await fetch("/api/airtable",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"list",table:"Tasks",baseId:bid})});if(all.ok){const ad=await all.json();setTasks((ad.records||[]).sort((a,b)=>((b.fields?.Created||"")>(a.fields?.Created||"")?1:-1)))}}}catch(e){setPdResults({error:e.message})}setPdLoading(false)}}>{pdLoading?"⏳ Reading HubSpot & generating...":"▶ Run Automation"}</button>
    </div>)}
    {/* Results */}
    {pdResults&&(<div style={{padding:16,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
      {pdResults.error?<div style={{color:"var(--red)",fontSize:11}}>❌ {pdResults.error}</div>:(<>
      <div style={{display:"flex",gap:12,marginBottom:16}}>{[{l:"Deals",v:pdResults.deals||0,c:"var(--t1)"},{l:"Contacts",v:pdResults.contacts||0,c:"var(--blu)"},{l:"Tasks",v:pdResults.tasksCreated||0,c:"var(--grn)"}].map(s=>(<div key={s.l} style={{padding:"10px 16px",background:"var(--hover)",borderRadius:8}}><div style={{fontSize:20,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:s.c}}>{s.v}</div><div style={{fontSize:9,color:"var(--t3)"}}>{s.l}</div></div>))}</div>
      {pdResults.results?.length>0&&(<div style={{maxHeight:400,overflowY:"auto"}}>{pdResults.results.map((r,i)=>(<div key={i} style={{padding:14,border:"1px solid var(--bdr)",borderRadius:8,marginBottom:8,background:"var(--hover)"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}><div><span style={{fontWeight:600,color:"var(--t1)"}}>{r.lead}</span> <span style={{fontSize:10,color:"var(--t3)"}}>— {r.title} at {r.company}</span></div><div style={{display:"flex",gap:8,alignItems:"center"}}><span style={{fontSize:9,color:"var(--t3)"}}>{r.engagementSummary}</span>{r.dealAmount&&<span style={{fontSize:9,fontFamily:"'JetBrains Mono',monospace",color:"var(--grn)"}}>${r.dealAmount}</span>}</div></div>
        <div style={{fontSize:10,color:"var(--acc)",marginBottom:6}}>Deal: {r.deal}</div>
        {r.tasks.map((t,j)=>(<div key={j} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:"var(--card)",borderRadius:6,marginBottom:4}}><span className={"chip "+(t.priority==="HIGH"?"cr":t.priority==="MEDIUM"?"ca":"cg")}>{t.priority}</span><span style={{fontSize:10,color:"var(--t2)",flex:1}}><strong style={{color:"var(--t1)"}}>{t.subject}</strong> — {t.action}</span><span style={{fontSize:9,color:"var(--pur)",padding:"2px 6px",background:"rgba(155,126,216,.1)",borderRadius:4}}>{t.channel}</span>{t.timing&&<span style={{fontSize:8,color:"var(--t3)"}}>{t.timing}</span>}</div>))}
      </div>))}</div>)}
      {pdResults.tasksCreated>0&&<div style={{marginTop:12,fontSize:11,color:"var(--grn)"}}>✅ {pdResults.tasksCreated} tasks saved. View on Tasks tab.</div>}
      </>)}
    </div>)}
    {!pdRule.stageId&&pdPipelines.length===0&&(<div style={{padding:20,background:"var(--hover)",borderRadius:10}}>
      <div style={{fontSize:12,fontWeight:600,color:"var(--t2)",marginBottom:10}}>How it works</div>
      <div style={{fontSize:11,color:"var(--t3)",lineHeight:1.7}}><strong style={{color:"var(--t2)"}}>1.</strong> Load your HubSpot deal pipelines<br/><strong style={{color:"var(--t2)"}}>2.</strong> Click the stage that triggers follow-up (e.g. "Demo Completed")<br/><strong style={{color:"var(--t2)"}}>3.</strong> See contacts at that stage<br/><strong style={{color:"var(--t2)"}}>4.</strong> Run — AI reads each contact's <strong>full HubSpot timeline</strong> (emails, meetings, calls, notes)<br/><strong style={{color:"var(--t2)"}}>5.</strong> AI analyzes your <strong>closed-won deals</strong> to identify what worked<br/><strong style={{color:"var(--t2)"}}>6.</strong> Generates personalized SDR tasks referencing actual engagement + conversion patterns</div>
    </div>)}
    </>)}
  </div>)}

  {/* ════ EMAIL CAMPAIGN — admin only ════ */}
  {tab==="email_campaign"&&!loading&&!clientMode&&(<EmailCampaignTab baseId={bid} campaign={camp} leads={leads} prefilledLeadId={emailPrefilledLeadId} />)}

  {/* ════ TRIGGERS — admin only (exposes master-base routing across all campaigns) ════ */}
  {tab==="triggers"&&!loading&&!clientMode&&(<TriggersTab baseId={bid} campaign={camp} />)}

  {/* ════ COMING SOON ════ */}
  {tab==="coming_soon"&&(<div>
    <div className="ph"><div><div className="pt">🚀 Coming Soon</div><div className="pd">Features in development & planned</div></div></div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
      {[
        {e:"🔗",n:"HubSpot Integration",s:"Live",d:"Connect HubSpot CRM, push tasks, assign to reps. API key stored per campaign.",f:["Push tasks to HubSpot","Assignee selection from HubSpot owners","Phone enrichment via Apollo","Enriched task push"]},
        {e:"📊",n:"Google Analytics Integration",s:"Planned",d:"Pull GA4 data into dashboards — traffic, conversions, channel performance. Correlate web analytics with signal data.",f:["GA4 property connection","Traffic & conversion dashboards","Channel attribution reports","Signal-to-web-visit correlation"]},
        {e:"📧",n:"Smartlead Integration",s:"Planned",d:"Connect Smartlead for email campaign tracking — opens, replies, bounces alongside LinkedIn outreach data.",f:["Campaign sync & status tracking","Reply & bounce monitoring","Email + LinkedIn sequence coordination","Deliverability analytics"]},
        {e:"🤖",n:"Post-Demo Automation",s:"Live",d:"When a lead's status changes, AI analyzes their profile + engagement history and creates personalized SDR follow-up tasks.",f:["Trigger on any field value change","AI generates 1-3 tasks per lead","References engagement history","Dedup — won't re-process leads"]},
        {e:"📝",n:"LinkedIn Post Monitoring",s:"Live",d:"Monitor leads' LinkedIn posts weekly. AI scores relevance, generates structured summaries and suggested comments for engagement.",f:["Fetch posts via RapidAPI (last 7 days)","AI relevance scoring with custom prompts","Apps-Script style category filters (hiring/spam/etc)","Resumable across crashes","Structured sentence + suggested comment output"]},
        {e:"💬",n:"LinkedIn Outreach Automation",s:"In Development",d:"Automated connection requests → DM sequences → follow-ups. AI personalizes each message. Full dashboard with acceptance rates.",f:["Multi-step DM sequences","AI message personalization with merge fields","Connection acceptance tracking","Rate-limited scheduling (safe for LinkedIn)"]},
        {e:"🧠",n:"AI Task Recommendations",s:"Planned",d:"AI analyzes contact + company data to recommend priority tasks. Based on engagement signals, deal stage, and historical patterns.",f:["Next-best-action scoring","Engagement pattern analysis","SDR workload optimization","Priority queue with reasoning"]},
        {e:"📋",n:"Automated HubSpot Task Push",s:"Planned",d:"Tasks created in SignalScope automatically pushed to HubSpot as activities/tasks, assigned to the right rep with full context.",f:["Real-time task sync to HubSpot","Rep assignment rules","Signal context in task description","Two-way status sync"]},
      ].map(item=>(
        <div key={item.n} style={{padding:18,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
            <span style={{fontSize:22}}>{item.e}</span>
            <div style={{flex:1}}><div style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>{item.n}</div></div>
            <span className={"chip "+(item.s==="In Testing"?"cg":item.s==="In Development"?"ca":"cp")}>{item.s}</span>
          </div>
          <div style={{fontSize:11,color:"var(--t3)",lineHeight:1.5,marginBottom:12}}>{item.d}</div>
          {item.f.map(ft=><div key={ft} style={{fontSize:10,color:"var(--t2)",padding:"2px 0",display:"flex",alignItems:"center",gap:6}}><span style={{color:"var(--acc)",fontSize:8}}>●</span>{ft}</div>)}
        </div>
      ))}
    </div>
  </div>)}

  {/* ACCOUNTS */}
  {tab==="accounts"&&!loading&&(()=>{
    const prefCols = ["Name","Domain","Industry","Size","LinkedIn URL","Country","Campaign Tag"];
    const allCols = accounts.length ? [...new Set(accounts.flatMap(a => Object.keys(a.fields || {})))] : [];
    const cols = [...prefCols.filter(c => allCols.includes(c)), ...allCols.filter(c => !prefCols.includes(c) && c !== "Campaign Tag")].slice(0, 8);
    if (allCols.includes("Campaign Tag") && !cols.includes("Campaign Tag")) cols.push("Campaign Tag");
    const fmt = v => { if (v === null || v === undefined) return ""; if (typeof v === "object") return JSON.stringify(v).slice(0, 50); return String(v).slice(0, 60); };
    const acctTags = [...new Set(accounts.map(a => (a.fields || {})["Campaign Tag"]).filter(Boolean))].sort();
    const filteredAccts = campTagFilter === "all" ? accounts : accounts.filter(a => (a.fields || {})["Campaign Tag"] === campTagFilter);
    return (<div><div className="ph"><div><div className="pt">Accounts</div><div className="pd">{filteredAccts.length}{campTagFilter!=="all"?` of ${accounts.length}`:""} companies</div></div>
      <div style={{display:"flex",gap:8}}>
        {acctTags.length > 0 && <select className="inp" style={{width:160,fontSize:10,padding:"5px 8px"}} value={campTagFilter} onChange={e=>setCampTagFilter(e.target.value)}>
          <option value="all">All Campaigns ({accounts.length})</option>
          {acctTags.map(t => <option key={t} value={t}>{t} ({accounts.filter(a=>(a.fields||{})["Campaign Tag"]===t).length})</option>)}
        </select>}
        {!clientMode&&<label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])handleCSVFile(e.target.files[0],"Accounts",setAccounts)}}/></label>}
      </div></div>
    {filteredAccts.length===0?<div className="empty"><div className="em">🏢</div><p>{accounts.length>0?"No accounts match this campaign filter.":"Upload a CSV to get started."}</p></div>:
    <div className="tw"><table><thead><tr>{cols.map(k=><th key={k}>{k}</th>)}{!clientMode&&<th></th>}</tr></thead><tbody>{filteredAccts.map(a=>{const f=a.fields||{};return(<tr key={a.id}>{cols.map(k=><td key={k} style={k==="Name"?{color:"var(--t1)",fontWeight:500}:k==="Campaign Tag"?{fontSize:10,color:"var(--acc)"}:{}}>{fmt(f[k])}</td>)}{!clientMode&&<td><button className="btn btn-d btn-s" onClick={()=>del("Accounts",[a.id],setAccounts)}><I.Trash/></button></td>}</tr>)})}</tbody></table></div>}</div>);
  })()}

  {/* LEADS */}
  {tab==="leads"&&!loading&&(()=>{
    const allCols = leads.length ? [...new Set(leads.flatMap(l => Object.keys(l.fields || {})))] : [];
    const hasGAData = leads.some(l => (l.fields?.["GA Engagement Score"] || 0) > 0);

    // Column order: basics → Custom Code → (GA columns only if GA has ever run) → overflow → Campaign Tag
    const basicsCols = ["Name","Email","Title","Company"];
    const gaCols = ["Custom Code","GA Engagement Score","GA Last Visit","GA Sessions","GA Engaged Sessions","GA Views","GA Views Per Session","GA Engagement Time","GA Avg Session Duration"];
    const ALWAYS_SHOW_GA = ["Custom Code","GA Engagement Score","GA Last Visit","GA Sessions","GA Engaged Sessions","GA Views","GA Engagement Time"];
    const effectiveCols = [...new Set([...allCols, ...ALWAYS_SHOW_GA])];

    // Start with basics that exist
    const cols = basicsCols.filter(c => effectiveCols.includes(c));
    // Add GA columns (Custom Code always; rest only if GA data exists or field is present)
    if (effectiveCols.includes("Custom Code")) cols.push("Custom Code");
    if (hasGAData || allCols.includes("GA Engagement Score")) {
      for (const c of ["GA Engagement Score","GA Last Visit","GA Sessions","GA Engaged Sessions","GA Views","GA Engagement Time"]) {
        if (effectiveCols.includes(c)) cols.push(c);
      }
    }
    // Campaign Tag at the end
    if (effectiveCols.includes("Campaign Tag")) cols.push("Campaign Tag");

    const fmtTime = (sec) => {
      const s = Math.round(Number(sec) || 0);
      if (s === 0) return "—";
      if (s < 60) return s + "s";
      const m = Math.floor(s / 60); const r = s % 60;
      return m + "m " + (r > 0 ? r + "s" : "");
    };
    const fmtNum = (v) => { const n = Number(v); return n > 0 ? String(n) : "—"; };
    const fmtScore = (v) => { const n = Number(v) || 0; return n > 0 ? String(n) : "—"; };
    const fmt = (v, colName) => {
      if (v === null || v === undefined || v === "") return colName && colName.startsWith("GA ") ? "—" : "";
      if (colName === "GA Engagement Time" || colName === "GA Avg Session Duration") return fmtTime(v);
      if (colName === "GA Sessions" || colName === "GA Engaged Sessions" || colName === "GA Views") return fmtNum(v);
      if (colName === "GA Engagement Score") return fmtScore(v);
      if (colName === "GA Views Per Session") { const n = Number(v); return n > 0 ? n.toFixed(1) : "—"; }
      if (typeof v === "object") return JSON.stringify(v).slice(0, 50);
      return String(v).slice(0, 60);
    };

    const leadTags = [...new Set(leads.map(l => (l.fields || {})["Campaign Tag"]).filter(Boolean))].sort();
    let filteredLeads = campTagFilter === "all" ? leads : leads.filter(l => (l.fields || {})["Campaign Tag"] === campTagFilter);
    if (engagementFilter === "engaged") filteredLeads = filteredLeads.filter(l => (l.fields?.["GA Engagement Score"] || 0) > 0);
    if (engagementFilter === "highly_engaged") filteredLeads = filteredLeads.filter(l => (l.fields?.["GA Engagement Score"] || 0) >= 50);
    if (sortByEngagement) filteredLeads = [...filteredLeads].sort((a,b) => (b.fields?.["GA Engagement Score"] || 0) - (a.fields?.["GA Engagement Score"] || 0));
    const engagedCount = leads.filter(l => (l.fields?.["GA Engagement Score"] || 0) > 0).length;
    return (<div><div className="ph"><div><div className="pt">Leads</div><div className="pd">{filteredLeads.length}{campTagFilter!=="all"||engagementFilter!=="all"?` of ${leads.length}`:""} contacts{engagedCount>0?` · ${engagedCount} engaged this week`:""}</div></div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        {engagedCount > 0 && <select className="inp" style={{width:170,fontSize:10,padding:"5px 8px"}} value={engagementFilter} onChange={e=>setEngagementFilter(e.target.value)}>
          <option value="all">All leads</option>
          <option value="engaged">📊 Engaged ({engagedCount})</option>
          <option value="highly_engaged">🔥 Highly engaged (50+)</option>
        </select>}
        {engagedCount > 0 && <button className={"btn btn-s "+(sortByEngagement?"btn-p":"")} onClick={()=>setSortByEngagement(!sortByEngagement)}>{sortByEngagement?"✓ ":""}Sort by score</button>}
        {leadTags.length > 0 && <select className="inp" style={{width:160,fontSize:10,padding:"5px 8px"}} value={campTagFilter} onChange={e=>setCampTagFilter(e.target.value)}>
          <option value="all">All Campaigns ({leads.length})</option>
          {leadTags.map(t => <option key={t} value={t}>{t} ({leads.filter(l=>(l.fields||{})["Campaign Tag"]===t).length})</option>)}
        </select>}
        {!clientMode&&<label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])handleCSVFile(e.target.files[0],"Leads",setLeads)}}/></label>}
        {!clientMode&&<button className="btn btn-s btn-p" onClick={()=>{
          try {
            console.log("[Movement Scan DEBUG-4] STEP 1: handler started");
            const banner = document.createElement('div');
            banner.id = '_lmm_test_banner_v4';
            banner.textContent = 'MOVEMENT SCAN CLICKED — DEBUG-4 BUILD';
            banner.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:red;color:white;padding:40px 60px;font-size:24px;font-weight:bold;z-index:2147483647;border-radius:12px;box-shadow:0 0 40px rgba(255,0,0,0.8);';
            document.body.appendChild(banner);
            setTimeout(()=>{const el=document.getElementById('_lmm_test_banner_v4');if(el)el.remove();}, 6000);
            console.log("[Movement Scan DEBUG-4] STEP 2: banner inserted");
            console.log("[Movement Scan DEBUG-4] STEP 3: about to setState");
            setShowLeadMovementModal(true);
            console.log("[Movement Scan DEBUG-4] STEP 4: setState called");
          } catch (err) {
            console.error("[Movement Scan DEBUG-4] ❌ EXCEPTION:", err);
            alert("Movement Scan error: " + err.message);
          }
        }} title="Scan LinkedIn for newly hired / promoted / exited leads">🧭 Movement Scan</button>}
        {!clientMode&&<button className="btn btn-s" onClick={async()=>{
          // Rebuild Movement Tasks from existing Lead data — no API spend.
          // For when a previous Movement Scan detected movements (Lead rows
          // have Movement Detected = Hired/Promoted/Exited and the Current
          // Job Title / Previous Job Title / etc. fields populated) but the
          // Task half failed silently. Idempotent — dedupes against existing
          // "Lead Movement" tasks by Name + Company + Movement Type.
          if (!bid) { alert("Select a campaign first"); return; }
          const proceed = window.confirm("Rebuild Movement Tasks from existing Lead data?\n\nThis reads all Leads with Movement Detected = Hired/Promoted/Exited and creates Tasks for any that don't already have one. No RapidAPI calls — fast + free.\n\nIdempotent — safe to re-run.");
          if (!proceed) return;
          try {
            const r = await fetch("/api/sidekick/movement-rebuild-tasks", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ baseId: bid }),
            });
            const data = await r.json();
            if (data.ok) {
              alert(`✅ ${data.summary}\n\nLeads with movement: ${data.leadsScanned}\nAlready had tasks: ${data.alreadyHadTasks}\nMissing data skipped: ${data.missingDataSkipped}\nTasks created: ${data.tasksCreated}${data.droppedFields?.length ? `\n\n⚠️ Tasks table missing fields (auto-skipped to make the write succeed):\n  ${data.droppedFields.join(", ")}\n\nRun setup-fix on this base to add them — values for these fields were silently dropped from the tasks just created.` : ""}${data.errors?.length ? `\n\nErrors (${data.errors.length}):\n${data.errors.slice(0,3).join("\n")}` : ""}`);
              // Refresh tasks list so newly created records show up — uses
              // the same at() pattern as other refresh paths in this file
              try {
                const refreshed = await at("list", "Tasks", {}, bid);
                if (refreshed?.records) setTasks(refreshed.records.sort((a, b) => ((b.fields?.Created || "") > (a.fields?.Created || "") ? 1 : -1)));
              } catch {}
            } else {
              alert("❌ " + (data.error || "Rebuild failed"));
            }
          } catch (e) {
            alert("❌ Network error: " + e.message);
          }
        }} title="Backfill Movement Tasks from existing Lead data (no RapidAPI spend). Use when a previous scan detected movements but tasks weren't created.">🔧 Rebuild Tasks from Lead Data</button>}
      </div></div>

    {filteredLeads.length===0?<div className="empty"><div className="em">👤</div><p>{leads.length>0?"No leads match this campaign filter.":"Upload a CSV."}</p></div>:
    <div className="tw"><table><thead><tr>{cols.map(k=><th key={k}>{k}</th>)}{!clientMode&&<th></th>}</tr></thead><tbody>{filteredLeads.map(l=>{const f=l.fields||{};return(<tr key={l.id}>{cols.map(k=><td key={k} style={k==="Name"?{color:"var(--t1)",fontWeight:500}:k==="Email"?{fontSize:10}:k==="Campaign Tag"?{fontSize:10,color:"var(--acc)"}:k==="Custom Code"?{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)"}:k==="GA Engagement Score"?{fontWeight:600,color:f[k]>50?"var(--grn)":f[k]>20?"var(--amb)":f[k]>0?"var(--blu)":"var(--t3)",fontSize:11}:k==="GA Last Visit"?{fontSize:10,color:f[k]?"var(--blu)":"var(--t3)"}:k==="GA Engagement Time"||k==="GA Avg Session Duration"?{fontSize:10,color:Number(f[k])>0?"var(--t1)":"var(--t3)"}:k==="GA Sessions"||k==="GA Engaged Sessions"||k==="GA Views"||k==="GA Views Per Session"?{fontSize:10,color:Number(f[k])>0?"var(--t1)":"var(--t3)",textAlign:"center"}:{}}>{fmt(f[k],k)}</td>)}{!clientMode&&<td><button className="btn btn-d btn-s" onClick={()=>del("Leads",[l.id],setLeads)}><I.Trash/></button></td>}</tr>)})}</tbody></table></div>}</div>);
  })()}

  {/* TASK RULES (unified — signal + top_x) */}
  {tab==="rules"&&!loading&&!clientMode&&(<div><div className="ph"><div><div className="pt">Task Rules</div><div className="pd">{rules.length} rules</div></div>{!clientMode&&<button className="btn btn-s btn-p" onClick={()=>setEditRule({})}><I.Plus/> Add Rule</button>}</div>

  {/* Task type guides — show relevant ones based on campaign features */}
  {rules.length===0&&(<div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:20}}>
    <div style={{fontSize:12,color:"var(--t2)",marginBottom:4}}>Choose a task type to get started. Each type detects different signals from your data.</div>
  </div>)}
  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12,marginBottom:rules.length?0:20}}>
    {(hasNews||rules.length===0||configFeatures.includes("news"))&&(
    <div style={{padding:16,border:"1px solid var(--bdr)",borderRadius:10,background:"var(--card)"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{fontSize:20}}>📰</span><span style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>News Scanning</span><span className="chip cg">news</span></div>
      <div style={{fontSize:11,color:"var(--t3)",lineHeight:1.6,marginBottom:10}}>Monitors Google News RSS feeds for company-level signals. Detects events like leadership changes, funding rounds, rebrands, regulatory shifts, and market moves at your target accounts.</div>
      <div style={{fontSize:10,color:"var(--t3)"}}>
        <div style={{marginBottom:4}}><strong style={{color:"var(--t2)"}}>Needs:</strong> Accounts with company names + domains</div>
        <div style={{marginBottom:4}}><strong style={{color:"var(--t2)"}}>You define:</strong> Keywords to match, scoring prompt for AI classification</div>
        <div><strong style={{color:"var(--t2)"}}>Creates:</strong> Tasks with headline, source URL, relevance score</div>
      </div>
      {!clientMode&&signalRules.filter(r=>{const tt=(r.fields||{})["Task Type"];return tt==="news"||tt==="both"}).length===0&&(
        <button className="btn btn-s btn-ai" style={{marginTop:10}} onClick={()=>setEditRule({taskType:"news",sources:["News"]})}><I.Plus/> Create News Rule</button>
      )}
    </div>)}

    {(hasJobs||rules.length===0||configFeatures.includes("job_posts"))&&(
    <div style={{padding:16,border:"1px solid var(--bdr)",borderRadius:10,background:"var(--card)"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{fontSize:20}}>📋</span><span style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>Job Post Tracking</span><span className="chip cb">job posts</span></div>
      <div style={{fontSize:11,color:"var(--t3)",lineHeight:1.6,marginBottom:10}}>Scrapes LinkedIn job postings at target companies via Apify. Detects when companies are hiring specific roles that signal buying intent, like CMO, VP Marketing, or Marketing Ops roles.</div>
      <div style={{fontSize:10,color:"var(--t3)"}}>
        <div style={{marginBottom:4}}><strong style={{color:"var(--t2)"}}>Needs:</strong> Accounts with LinkedIn company URLs</div>
        <div style={{marginBottom:4}}><strong style={{color:"var(--t2)"}}>You define:</strong> Job title keywords to search for</div>
        <div><strong style={{color:"var(--t2)"}}>Creates:</strong> Tasks with job title, posting URL, relevance score</div>
      </div>
      {!clientMode&&signalRules.filter(r=>{const tt=(r.fields||{})["Task Type"];return tt==="job_post"||tt==="both"}).length===0&&(
        <button className="btn btn-s btn-ai" style={{marginTop:10}} onClick={()=>setEditRule({taskType:"job_post",sources:["Job Posts"]})}><I.Plus/> Create Job Post Rule</button>
      )}
    </div>)}

    {(hasTopX||rules.length===0||configFeatures.includes("top_x"))&&(
    <div style={{padding:16,border:"1px solid var(--bdr)",borderRadius:10,background:"var(--card)"}}>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span style={{fontSize:20}}>🎯</span><span style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>Top X Scoring</span><span className="chip cp">top x</span></div>
      <div style={{fontSize:11,color:"var(--t3)",lineHeight:1.6,marginBottom:10}}>Ranks your existing leads or accounts by weighted field scoring. Reads numeric data from your Airtable (engagement scores, email clicks, revenue, etc.), computes a composite score, and surfaces the top N for action.</div>
      <div style={{fontSize:10,color:"var(--t3)"}}>
        <div style={{marginBottom:4}}><strong style={{color:"var(--t2)"}}>Needs:</strong> Leads or Accounts with numeric/scoring fields in Airtable</div>
        <div style={{marginBottom:4}}><strong style={{color:"var(--t2)"}}>You define:</strong> Which fields to score on, weight per field, how many top results</div>
        <div><strong style={{color:"var(--t2)"}}>Creates:</strong> Tasks for top N leads/accounts with composite score</div>
      </div>
      {!clientMode&&topXRules.length===0&&(
        <button className="btn btn-s btn-ai" style={{marginTop:10}} onClick={()=>setEditRule({taskType:"top_x"})}><I.Plus/> Create Top X Rule</button>
      )}
    </div>)}
  </div>

  {rules.length===0?null:<>

  {/* Signal rules table */}
  {signalRules.length>0&&(<div style={{marginBottom:topXRules.length?20:0}}>
  <div style={{fontSize:11,fontWeight:600,color:"var(--t2)",marginBottom:8}}>📰 Signal Rules</div>
  <div className="tw"><table><thead><tr><th>Name</th><th>Task Type</th><th>Scan Target</th><th>Ease</th><th>Strength</th><th>Keywords</th><th></th></tr></thead><tbody>{signalRules.map(r=>{const f=r.fields||{};const isJobOnly=f["Task Type"]==="job_post";return(<tr key={r.id}><td style={{color:"var(--t1)",fontWeight:500}}>{f.Name}</td><td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="both"?"ca":"cg")}>{f["Task Type"]||"news"}</span></td><td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":f["Scan Target"]==="both"?"ca":"cg")}>{f["Scan Target"]||"accounts"}</span></td><td>{f.Ease}</td><td>{f.Strength}</td><td style={{fontSize:10,color:"var(--t3)"}}>{(isJobOnly?(f["Job Title Keywords"]||""):(f.Keywords||"")).slice(0,40)}</td><td>{!clientMode&&<div style={{display:"flex",gap:4}}><button className="btn btn-s" onClick={()=>setEditRule({airtableId:r.id,name:f.Name,description:f.Description,taskType:f["Task Type"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease,strength:f.Strength,sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean),jobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean),scoringPrompt:f["Scoring Prompt"]||""})}>Edit</button><button className="btn btn-s" onClick={()=>duplicateRule(r)} title="Duplicate"><I.Copy/></button><button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button></div>}</td></tr>)})}</tbody></table></div>
  </div>)}

  {/* Top X rules cards */}
  {topXRules.length>0&&(<div>
  <div style={{fontSize:11,fontWeight:600,color:"var(--t2)",marginBottom:8}}>🎯 Top X Rules</div>
  <div style={{display:"flex",flexDirection:"column",gap:12}}>{topXRules.map(r=>{const f=r.fields||{};const sf=JSON.parse(f["Scoring Fields"]||"[]");return(
    <div key={r.id} style={{padding:16,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}><div><div style={{fontSize:14,fontWeight:600}}>{f.Name}</div>{f.Description&&<div style={{fontSize:11,color:"var(--t3)",marginTop:2}}>{f.Description}</div>}</div><div style={{display:"flex",gap:6}}><span className={"chip "+(f["Scan Target"]==="accounts"?"cg":"cp")}>{f["Scan Target"]||"leads"}</span><span className="chip ca">TOP {f["Top N"]||10}</span></div></div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>{sf.map((s,i)=>(<div key={i} style={{padding:"4px 10px",background:"var(--hover)",borderRadius:4,fontSize:10}}><span style={{color:"var(--t1)"}}>{s.field}</span><span style={{color:"var(--acc)",marginLeft:6}}>{s.weight}%</span></div>))}</div>
      <div style={{display:"flex",gap:6}}><button className="btn btn-p btn-s" onClick={()=>runTopX(r)} disabled={scanning}>{scanning?"Running…":"▶ Run"}</button><button className="btn btn-s" onClick={()=>{
        // Parse compiled rules JSON if present
        let compiledRules = null;
        try { if (f["Compiled Rules JSON"]) compiledRules = JSON.parse(f["Compiled Rules JSON"]); } catch {}
        setEditRule({airtableId:r.id,taskType:"top_x",name:f.Name,description:f.Description||"",scanTarget:f["Scan Target"]||"leads",topN:f["Top N"]||10,scoringFields:sf,ease:f.Ease||"Medium",strength:f.Strength||"Strong",scoringPrompt:f["Scoring Prompt"]||"",
          smartCompile: f["Smart Compile"]==="true"||f["Smart Compile"]===true,
          compiledRules,
          compiledAt: f["Compiled At"] || null,
          baseId: bid,
        });
      }}>Edit</button><button className="btn btn-s" onClick={()=>duplicateRule(r)} title="Duplicate"><I.Copy/></button><button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button></div>
    </div>)})}</div>
  </div>)}

  {/* Outreach Rules summary on Task Rules tab (the actual editor lives on LinkedIn Automation tab) */}
  {(() => {
    const outRules = rules.filter(r => (r.fields || {})["Task Type"] === "linkedin_outreach");
    if (outRules.length === 0) return null;
    return (
      <div style={{marginTop:20}}>
        <div style={{fontSize:11,fontWeight:600,color:"var(--t2)",marginBottom:8}}>🔗 LinkedIn Outreach Rules</div>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {outRules.map(r => {
            const f = r.fields || {};
            let config; try { config = JSON.parse(f["Outreach Config"] || "{}"); } catch { config = {}; }
            const seq = config.dmSequence || [];
            return (
              <div key={r.id} style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>{f.Name}</div>
                  <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>
                    {config.leadsPerBatch || 10} leads/batch · {seq.length} DM steps · {config.connectionsPerDay || 5}/day · {config.active ? <span style={{color:"var(--grn)"}}>● active</span> : <span style={{color:"var(--amb)"}}>○ inactive</span>}
                  </div>
                </div>
                <div style={{display:"flex",gap:6,alignItems:"center"}}>
                  <span style={{fontSize:10,color:"var(--t3)"}}>Edit on the</span>
                  <button className="btn btn-s btn-p" onClick={()=>setTab("outreach")}>💬 LinkedIn Automation tab →</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  })()}
  </>}</div>)}

  {/* PROMPTS */}
  {tab==="prompts"&&!loading&&!clientMode&&(<div>
  <div className="ph">
    <div>
      <div className="pt">Scoring Prompts</div>
      <div className="pd">AI scoring criteria (0-100). Your prompt is the SINGLE source of truth — there are no hardcoded judgement rules competing with it.</div>
    </div>
    {!clientMode&&<button className="btn btn-ai btn-s" onClick={async()=>{const empty=rules.filter(r=>!(r.fields||{})["Scoring Prompt"]);for(const rule of empty){const f=rule.fields||{};try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",campaignId:camp?.airtableId,taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const d=await res.json();if(d.scoringPrompt){await at("update","Task Rules",{records:[{id:rule.id,fields:{"Scoring Prompt":d.scoringPrompt}}]},bid);setRules(p=>p.map(x=>x.id===rule.id?{...x,fields:{...x.fields,"Scoring Prompt":d.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}}><I.Sparkle/> Generate Missing</button>}  </div>

  {/* PROMPT REFERENCE — collapsible, explains the full prompt contract */}
  <details style={{marginBottom:16,padding:0,border:"1px solid rgba(155,126,216,.3)",borderRadius:8,background:"rgba(155,126,216,.04)"}}>
    <summary style={{cursor:"pointer",padding:14,fontSize:12,fontWeight:600,color:"var(--pur)",userSelect:"none"}}>📖 How prompts work — the full contract</summary>
    <div style={{padding:"0 14px 14px",fontSize:11,color:"var(--t2)",lineHeight:1.7}}>

      <div style={{marginTop:8,marginBottom:8,fontSize:11,fontWeight:600,color:"var(--t1)"}}>1. What the AI sees per signal</div>
      <div style={{padding:10,background:"var(--bg)",borderRadius:6,fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t2)",whiteSpace:"pre-wrap",marginBottom:10}}>
{`# News mode — per signal:
[<idx>] <headline>
  Source: <publication name>
  Date: <YYYY-MM-DD>
  Excerpt: <RSS description, 250 chars>
  Article body: <full fetched body, up to 1000 chars>

# Jobs mode — per signal:
[<idx>] <Job Title @ Company>
  Title: <job title>
  Location: <location>
  Company: <Apify-resolved company name>
  Description: <job description, 600 chars>`}
      </div>

      <div style={{marginTop:14,marginBottom:8,fontSize:11,fontWeight:600,color:"var(--t1)"}}>2. The system prompt (sent before your custom prompt)</div>
      <div style={{padding:10,background:"var(--bg)",borderRadius:6,fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t2)",whiteSpace:"pre-wrap",marginBottom:10}}>
{`You are scoring [news articles about "<company>" | job postings] against ONE specific task: "<task name>".

The user has provided their scoring criteria below. Use it AS THE PRIMARY GUIDE — it overrides any generic intuition.

Score each signal 0-100:
- 90-100: exact match, immediately actionable
- 70-89: strong match, likely actionable
- 50-69: partial / tangential
- Below 50: reject

Return ONLY signals scoring <threshold> or higher. Drop everything else.

Output format (strict JSON, no markdown):
{
  "matches": [
    { "idx": <original index from input>, "score": <0-100 integer>, "reason": "<1 sentence, max 140 chars>" }
  ]
}`}
      </div>

      <div style={{marginTop:14,marginBottom:8,fontSize:11,fontWeight:600,color:"var(--t1)"}}>3. Your prompt is appended verbatim — no rewording</div>
      <div style={{padding:10,background:"rgba(93,168,122,.08)",border:"1px solid rgba(93,168,122,.3)",borderRadius:6,marginBottom:10}}>
        ✅ Whatever you write below is sent to the model as-is. Be specific. Use concrete examples. List false positives explicitly.
      </div>

      <div style={{marginTop:14,marginBottom:8,fontSize:11,fontWeight:600,color:"var(--t1)"}}>4. What the app expects back</div>
      <div style={{padding:10,background:"var(--bg)",borderRadius:6,fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:"var(--t2)",whiteSpace:"pre-wrap",marginBottom:10}}>
{`{
  "matches": [
    { "idx": 3, "score": 92, "reason": "CMO publicly stepped down, immediately actionable" },
    { "idx": 7, "score": 75, "reason": "VP Marketing role open — adjacent to target seniority" }
  ]
}`}
      </div>
      <div style={{marginTop:6,marginBottom:14,padding:10,background:"rgba(91,143,212,.08)",border:"1px solid rgba(91,143,212,.3)",borderRadius:6}}>
        <strong style={{color:"var(--blu)"}}>Read by the app:</strong> The <code>idx</code> maps back to the input signal. The <code>score</code> populates the Tasks <code>Score</code> field. The <code>reason</code> populates the new <code>Score Reason</code> field — visible on each task. Anything below the threshold (set in 🎯 Threshold tab, default 70) is dropped at the AI level — you save tokens and the frontend never sees it.
      </div>

      <div style={{marginTop:14,marginBottom:8,fontSize:11,fontWeight:600,color:"var(--t1)"}}>5. Pre-filtering before AI</div>
      <div style={{padding:10,background:"var(--bg)",borderRadius:6,marginBottom:10,color:"var(--t3)",fontSize:10}}>
        Before sending to AI, signals are pre-filtered by keyword presence in headline/description (or job title for jobs). If your rule has keywords <code>[CMO, marketing, brand]</code>, signals not mentioning any of those get dropped without an AI call. <strong>If your rule has NO keywords, all signals go through.</strong> Use keywords as a coarse filter; use the prompt for the precise judgement.
      </div>

      <div style={{marginTop:14,marginBottom:8,fontSize:11,fontWeight:600,color:"var(--t1)"}}>6. Prompt-writing tips</div>
      <div style={{paddingLeft:14,fontSize:11,color:"var(--t2)"}}>
        <div style={{marginBottom:4}}>• <strong>Lead with the WHAT</strong>: "Score 90+ if a senior marketer just exited their role." First sentence anchors the AI.</div>
        <div style={{marginBottom:4}}>• <strong>Define each tier</strong> (90-100, 70-89, 50-69, &lt;50) with concrete examples.</div>
        <div style={{marginBottom:4}}>• <strong>List explicit false positives</strong>: "An engineer leaving is NOT a marketer; score below 30."</div>
        <div style={{marginBottom:4}}>• <strong>Mention the role / seniority precisely</strong>: "Director, VP, CMO" not "senior marketer."</div>
        <div style={{marginBottom:4}}>• <strong>Disambiguate ambiguous topics</strong>: "Regulatory change" → which kind? Healthcare? Privacy? Antitrust?</div>
        <div style={{marginBottom:4}}>• <strong>Don't repeat the system prompt</strong>: no need to say "return JSON" or "score 0-100" — that's already in the system prompt.</div>
        <div style={{marginBottom:4}}>• <strong>Keep it under 500 chars</strong> for best results. Long prompts dilute focus.</div>
      </div>
    </div>
  </details>

  <div style={{display:"flex",flexDirection:"column",gap:12}}>{rules.filter(r=>{const tt=(r.fields||{})["Task Type"]||"news";return tt==="news"||tt==="job_post"||tt==="both"}).map(r=>{const f=r.fields||{};const tt=f["Task Type"]||"news";return(<div key={r.id} style={{padding:14,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:8}}><span className={"chip "+(tt==="job_post"?"cb":tt==="top_x"?"cp":"cg")}>{tt.replace(/_/g," ")}</span><span style={{fontSize:13,fontWeight:600}}>{f.Name}</span></div>
  {!clientMode&&<button className="btn btn-ai btn-s" onClick={async()=>{try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",campaignId:camp?.airtableId,taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const d=await res.json();if(d.scoringPrompt){await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":d.scoringPrompt}}]},bid);setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":d.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}><I.Sparkle/> Regen</button>}</div>
  <textarea className="inp ta" readOnly={clientMode} value={f["Scoring Prompt"]||""} placeholder={clientMode?"(Read-only in client view)":"No prompt — click Regen, or write one using the reference above"} style={{minHeight:90,fontSize:11,background:"var(--bg)"}} onChange={clientMode?undefined:(e=>{const v=e.target.value;setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":v}}:x))})} onBlur={clientMode?undefined:(async e=>{try{await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":e.target.value}}]},bid)}catch{}})}/>
  <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"var(--t3)",marginTop:4}}>
    <span>{f["Scoring Prompt"]?f["Scoring Prompt"].length+" chars":"⚠️ Empty — task name/description will be used"}</span>
    <span>{(f.Keywords||f["Job Title Keywords"])?<>Keywords pre-filter: <strong style={{color:"var(--t2)"}}>{[...(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean),...(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean)].length}</strong> active</>:<span style={{color:"var(--amb)"}}>⚠ No keywords — all signals go to AI</span>}</span>
  </div>
  </div>)})}</div></div>)}

  {/* THRESHOLD */}
  {tab==="threshold"&&!loading&&!clientMode&&(<div><div className="ph"><div><div className="pt">Scoring Threshold</div><div className="pd">Minimum score for signals to become tasks</div></div></div>
  <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,maxWidth:500}}>
  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}><span style={{fontSize:12,color:"var(--t2)"}}>Threshold</span><input type="range" className="sld" min="0" max="100" value={threshold} onChange={e=>setThreshold(+e.target.value)}/><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,fontWeight:600,color:"var(--acc)",minWidth:30,textAlign:"center"}}>{threshold}</span></div>
  <div style={{display:"flex",gap:16,fontSize:10,color:"var(--t3)"}}><span>0-49: Weak</span><span>50-69: Partial</span><span style={{color:"var(--acc)"}}>70-89: Strong</span><span style={{color:"var(--grn)"}}>90-100: Exact</span></div></div></div>)}

  {/* TASKS */}
  {tab==="tasks"&&!loading&&(<div>
    <div className="ph"><div><div className="pt">Tasks</div><div className="pd">{fTasks.length} tasks{selCount>0&&<span style={{color:"var(--acc)",marginLeft:6}}>· {selCount} selected</span>}</div></div>
    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      <button className="btn btn-s" onClick={()=>setShowExportModal(true)} disabled={!tasks.length}><I.Download/> Export{selCount>0?` (${selCount})`:""}</button>
      {!clientMode&&<button className="btn btn-s" style={{color:"var(--pur)",borderColor:"rgba(155,126,216,.3)"}} disabled={!tasks.length} onClick={()=>setEnrichModal({mode:"select"})}><I.Sparkle/> Enrich Phones</button>}
      {!clientMode&&hsConnected && <button className="btn btn-s" style={{color:"var(--grn)",borderColor:"rgba(93,168,122,.3)"}} disabled={!tasks.length} onClick={()=>setEnrichModal({mode:"push"})}><I.Upload/> Push to HubSpot{selCount>0?` (${selCount})`:""}</button>}
      {hasSignals&&!clientMode&&<>
        <button className="btn btn-p btn-s" onClick={()=>startScan("news")} disabled={scanning||!accounts.length||!newsRuleCount} title={!newsRuleCount?"No news or both-type rules":`Scan ${newsRuleCount} news rule${newsRuleCount===1?"":"s"}`}>{scanning?"Scanning "+Math.round(scanProg)+"%":<>📰 News</>}</button>
        <button className="btn btn-p btn-s" onClick={()=>startScan("jobs")} disabled={scanning||!accounts.length||!jobsRuleCount} title={!jobsRuleCount?"No job_post or both-type rules":`Scan ${jobsRuleCount} jobs rule${jobsRuleCount===1?"":"s"}`}>{scanning?"Scanning "+Math.round(scanProg)+"%":<>📋 Jobs</>}</button>
      </>}
    </div></div>
    {scanning&&<div className="scan-s"><div className="scan-d"/><span style={{fontSize:12,flex:1}}>{scanText}</span><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--acc)"}}>{Math.round(scanProg)}%</span>{hasSignals&&<button className="btn btn-d btn-s" onClick={()=>{scanRef.current=false;setScanning(false)}}>Stop</button>}</div>}

    {/* Filters + date presets */}
    <div className="fb">
      <input className="inp" placeholder="Search…" value={filter.q} onChange={e=>setFilter(f=>({...f,q:e.target.value}))} style={{maxWidth:220}}/>
      <select className="inp" style={{width:140}} value={filter.src} onChange={e=>setFilter(f=>({...f,src:e.target.value}))}><option value="all">All Types</option><option value="news">News</option><option value="job_post">Job Posts</option><option value="top_x">Top X</option>{[...new Set(tasks.map(t=>(t.fields||{})["Task Type"]).filter(Boolean))].filter(t=>!["news","job_post","top_x"].includes(t)).map(t=><option key={t} value={t}>{t}</option>)}</select>
      <select className="inp" style={{width:130}} value={filter.target} onChange={e=>setFilter(f=>({...f,target:e.target.value}))}><option value="all">All Targets</option><option value="accounts">Accounts</option><option value="leads">Leads</option></select>
    </div>
    <div className="fb" style={{marginTop:-8}}>
      {[{l:"24h",v:"24h"},{l:"7d",v:"7d"},{l:"14d",v:"14d"},{l:"30d",v:"30d"},{l:"All time",v:"all"}].map(p=>(
        <button key={p.v} className={"btn btn-s"} style={{fontSize:10,padding:"3px 8px",background:filter.datePreset===p.v?"var(--acc-d)":"var(--card)",color:filter.datePreset===p.v?"var(--acc)":"var(--t2)",borderColor:filter.datePreset===p.v?"var(--acc)":"var(--bdr)"}} onClick={()=>setDatePreset(p.v)}>{p.l}</button>
      ))}
      <input type="date" className="inp" style={{width:130,fontSize:10,padding:"3px 8px"}} value={filter.from} onChange={e=>setFilter(f=>({...f,from:e.target.value,datePreset:"custom"}))}/>
      <span style={{color:"var(--t3)",fontSize:10}}>to</span>
      <input type="date" className="inp" style={{width:130,fontSize:10,padding:"3px 8px"}} value={filter.to} onChange={e=>setFilter(f=>({...f,to:e.target.value,datePreset:"custom"}))}/>
    </div>

    {/* Selection bar */}
    {selCount>0&&(<div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 14px",background:"var(--acc-d)",border:"1px solid rgba(191,163,90,.3)",borderRadius:8,marginBottom:12}}>
      <span style={{fontSize:11,color:"var(--acc)",fontWeight:600}}>{selCount} selected</span>
      <button className="btn btn-s" style={{fontSize:10,marginLeft:"auto"}} onClick={()=>setShowExportModal(true)}><I.Download/> Export Selected</button>
      <button className="btn btn-s" style={{fontSize:10}} onClick={()=>setSelectedTasks(new Set())}>Clear</button>
    </div>)}

    {fTasks.length===0?<div className="empty"><div className="em">📡</div><p>{tasks.length===0?"No tasks yet.":"No matches."}</p></div>:
    <div className="tw"><table><thead><tr>
      <th style={{width:32,padding:"10px 8px"}}><input type="checkbox" checked={fTasks.length>0&&fTasks.every(t=>selectedTasks.has(t.id))} onChange={toggleAllVisible} style={{cursor:"pointer",accentColor:"var(--acc)"}}/></th>
      <th>Company</th><th>Task Rule</th><th>Score</th><th>Target</th><th>Signal</th><th>Type</th><th>Date</th><th>Link</th>{!clientMode&&<th></th>}
    </tr></thead><tbody>{fTasks.map(t=>{const f=t.fields||{};const sc=f.Score||0;const sel=selectedTasks.has(t.id);return(<tr key={t.id} style={{background:sel?"rgba(191,163,90,.06)":"transparent"}}>
      <td style={{padding:"10px 8px"}}><input type="checkbox" checked={sel} onChange={()=>toggleTask(t.id)} style={{cursor:"pointer",accentColor:"var(--acc)"}}/></td>
      <td style={{color:"var(--t1)",fontWeight:500}}>{f.Company}</td>
      <td>{f["Task Rule"]}</td>
      <td><div className="sb" style={{width:80}} title={f["Score Reason"]?`AI reason: ${f["Score Reason"]}`:""}><div className="st"><div className="sf" style={{width:sc+"%",background:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}/></div><span className="sv" style={{color:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}>{sc}</span></div></td>
      <td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":"cg")}>{f["Scan Target"]||"accounts"}</span></td>
      <td style={{maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={f.Signal+(f["Score Reason"]?"\n\n💡 Why this matched: "+f["Score Reason"]:"")}>{f.Signal}</td>
      <td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="top_x"?"cp":"cg")}>{(f["Task Type"]||"news").replace(/_/g," ").toUpperCase()}</span></td>
      <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f.Date}</td>
      <td>{f.URL?<a href={f.URL} target="_blank" rel="noopener" style={{color:"var(--blu)",fontSize:10}}>↗</a>:"—"}</td>
      {!clientMode&&<td><button className="btn btn-d btn-s" onClick={()=>del("Tasks",[t.id],setTasks)}><I.Trash/></button></td>}
    </tr>)})}</tbody></table></div>}
  </div>)}

  {/* ════ LINKEDIN POSTS SCANNER ════ */}
  {tab==="linkedin_posts"&&!loading&&!clientMode&&(<LinkedInPostsTab baseId={bid} campaign={camp} leads={leads} onCampaignProvisioned={(newCamp)=>{setCamp(newCamp);setCampaigns(p=>p.map(c=>c.id===newCamp.id?newCamp:c));}}/>)}

  {/* ════ LINKEDIN AUTOMATION ════ */}
  {tab==="outreach"&&!loading&&!clientMode&&(<div>
    <div className="ph"><div><div className="pt">💬 LinkedIn Automation</div><div className="pd">Connection requests, DM sequences & outreach tracking</div></div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {linkedinAccount && <button className="btn btn-s btn-p" onClick={()=>setManualModal({mode:"select_leads"})} disabled={outreachLoading}>✋ Manual Mode</button>}
        {linkedinAccount && <button className="btn btn-s" onClick={async()=>{try{setOutreachLoading(true);const d=await outreachAPI("check_replies",{accountId:linkedinAccount.id});alert(`Checked ${d.checked} items. Found ${d.repliesFound} new replies.${d.replied?.length?"\n\nReplied:\n"+d.replied.join("\n"):""}`);await loadOutreachStats();}catch(e){alert("Error: "+e.message)}setOutreachLoading(false)}} disabled={outreachLoading}>{outreachLoading?"⏳":"✋ Check Replies"}</button>}
        {linkedinAccount && <button className="btn btn-s" onClick={()=>loadOutreachStats()} disabled={outreachLoading}>↻ Refresh</button>}
        {linkedinAccount && <button className="btn btn-s" onClick={async()=>{if(!confirm(`Unassign ${linkedinAccount.name} from ${camp?.name}?\n\nThe account stays connected in Unipile — you can reassign it anytime.`))return;await assignAccountToCampaign("");}} disabled={outreachLoading}>🔄 Switch Account</button>}
        {linkedinAccount && <button className="btn btn-s btn-d" onClick={disconnectLinkedIn} disabled={outreachLoading}>🔌 Disconnect</button>}
      </div>
    </div>

    {/* Show assigned account badge */}
    {linkedinAccount && (
      <div style={{marginBottom:16,padding:"10px 14px",background:"var(--grn-d)",border:"1px solid rgba(93,168,122,.3)",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:11,fontWeight:600,color:"var(--grn)"}}>✅ Using: {linkedinAccount.name}{linkedinAccount.email?` (${linkedinAccount.email})`:""}</div>
          <div style={{fontSize:9,color:"var(--t3)",marginTop:2}}>All outreach from <strong>{camp?.name}</strong> campaign goes through this account</div>
        </div>
      </div>
    )}

    {/* Connection Setup */}
    {!linkedinAccount ? (
      <div style={{marginBottom:24}}>
        {allHealthyAccounts.length > 0 && (
          <div style={{marginBottom:16,padding:16,background:"var(--acc-d)",border:"1px solid rgba(212,165,89,.4)",borderRadius:10}}>
            <div style={{fontSize:12,fontWeight:600,color:"var(--acc)",marginBottom:4}}>👋 Pick a LinkedIn account for this campaign</div>
            <div style={{fontSize:10,color:"var(--t2)",marginBottom:12,lineHeight:1.5}}>You have {allHealthyAccounts.length} healthy LinkedIn account{allHealthyAccounts.length!==1?"s":""} already connected. Assign one to <strong>{camp?.name}</strong> — this campaign will only use that account for outreach. Other campaigns can use different accounts.</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {allHealthyAccounts.map(a => (
                <div key={a.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:"var(--card)",borderRadius:8,border:"1px solid var(--bdr)"}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:12,color:"var(--t1)",fontWeight:500}}>{a.name}</div>
                    {a.email && <div style={{fontSize:10,color:"var(--t3)"}}>{a.email}</div>}
                    <div style={{fontSize:9,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace",marginTop:2}}>{a.id}</div>
                  </div>
                  <button className="btn btn-p btn-s" onClick={()=>assignAccountToCampaign(a.id)} disabled={outreachLoading}>{outreachLoading?"⏳":"Assign to this campaign"}</button>
                </div>
              ))}
            </div>
            <div style={{fontSize:10,color:"var(--t3)",marginTop:10,fontStyle:"italic"}}>Don't see the account you need? Connect a new one below.</div>
          </div>
        )}

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,maxWidth:600}}>
          {/* Option A: Direct Login */}
          <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
            <div style={{fontSize:20,marginBottom:8}}>🔑</div>
            <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:6}}>{allHealthyAccounts.length>0?"Connect New Account":"Login Directly"}</div>
            <div style={{fontSize:10,color:"var(--t3)",lineHeight:1.5,marginBottom:14}}>{allHealthyAccounts.length>0?"Connect another LinkedIn account for this specific campaign.":"Connect your own LinkedIn account via Unipile's secure auth."}</div>
            <button className="btn btn-p btn-s" style={{width:"100%",justifyContent:"center",marginBottom:6}} onClick={connectLinkedIn}>Connect LinkedIn</button>
            <button className="btn btn-s" style={{width:"100%",justifyContent:"center",fontSize:10}} onClick={testUnipile}>🧪 Test Unipile Connection</button>
          </div>
          {/* Option B: Email to Client */}
          <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
            <div style={{fontSize:20,marginBottom:8}}>📧</div>
            <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:6}}>Send to Client</div>
            <div style={{fontSize:10,color:"var(--t3)",lineHeight:1.5,marginBottom:14}}>Generate a secure login link to email your client so they can connect their LinkedIn.</div>
            <button className="btn btn-s" style={{width:"100%",justifyContent:"center"}} onClick={async()=>{
              try{
                // CRITICAL: the link generated here gets emailed to the CLIENT,
                // so the success/failure redirect MUST be the client portal URL
                // for THIS campaign — never the admin URL we're currently on.
                // Previously this passed window.location.href, which meant the
                // client landed on the admin portal after login and could see
                // every other client's data. Data-leak fix 2026-05-22.
                if (!camp?.airtableId) {
                  alert("Save this campaign first — the client portal URL needs a campaign ID to redirect to.");
                  return;
                }
                const clientPortalUrl = `${window.location.origin}/client/${camp.airtableId}`;
                const data = await outreachAPI("get_auth_link",{callbackUrl: clientPortalUrl});
                if(data.url){
                  navigator.clipboard.writeText(data.url);
                  alert(`Auth link copied! Paste it in an email to your client.\n\nAfter login, they'll land on:\n${clientPortalUrl}\n\nLink: ${data.url.slice(0,60)}...`);
                }
                else alert("Could not generate link. Check Unipile credentials.");
              }catch(e){alert("Error: "+e.message+"\n\nMake sure UNIPILE_DSN and UNIPILE_API_KEY are set.")}
            }}>📋 Copy Auth Link</button>
          </div>
        </div>
        <div style={{marginTop:12,fontSize:10,color:"var(--t3)",lineHeight:1.5}}>
          ⚠️ Requires <strong>UNIPILE_DSN</strong> and <strong>UNIPILE_API_KEY</strong> environment variables. <a href="https://app.unipile.com" target="_blank" rel="noopener" style={{color:"var(--blu)"}}>Get them from Unipile →</a>
        </div>
        {disconnectedAccounts.length > 0 && (
          <div style={{marginTop:12,padding:"14px 16px",background:"var(--red-d)",border:"1px solid rgba(196,92,92,.3)",borderRadius:8}}>
            <div style={{color:"var(--red)",fontWeight:600,fontSize:11,marginBottom:6}}>⚠️ {disconnectedAccounts.length} disconnected LinkedIn account{disconnectedAccounts.length!==1?"s":""}</div>
            <div style={{color:"var(--t2)",fontSize:10,marginBottom:10,lineHeight:1.5}}>Each account uses a Unipile slot. Reconnect to re-authenticate (usually LinkedIn needed a checkpoint), or remove to free the slot.</div>
            <div style={{display:"flex",flexDirection:"column",gap:6}}>
              {disconnectedAccounts.map(a => (
                <div key={a.id} style={{display:"flex",alignItems:"center",gap:8,padding:"8px 10px",background:"var(--card)",borderRadius:6}}>
                  <div style={{flex:1}}>
                    <div style={{fontSize:11,color:"var(--t1)",fontWeight:500}}>{a.name}</div>
                    <div style={{fontSize:9,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{a.id}</div>
                  </div>
                  <button className="btn btn-s btn-p" style={{fontSize:10}} onClick={()=>reconnectAccount(a.id)} disabled={outreachLoading}>🔄 Reconnect</button>
                  <button className="btn btn-s btn-d" style={{fontSize:10}} onClick={()=>removeAccount(a.id, a.name)} disabled={outreachLoading}>🗑️ Remove</button>
                </div>
              ))}
            </div>
            {disconnectedAccounts.length > 1 && (
              <button className="btn btn-s" style={{fontSize:10,marginTop:8}} onClick={cleanupDisconnectedAccounts} disabled={outreachLoading}>{outreachLoading?"⏳":"🧹 Remove all "+disconnectedAccounts.length}</button>
            )}
          </div>
        )}
        {linkedinError && (
          <div style={{marginTop:12,padding:"10px 14px",background:linkedinError.startsWith("✅")?"var(--grn-d)":"var(--red-d)",border:"1px solid "+(linkedinError.startsWith("✅")?"rgba(93,168,122,.3)":"rgba(196,92,92,.3)"),borderRadius:8,color:linkedinError.startsWith("✅")?"var(--grn)":"var(--red)",fontSize:11,lineHeight:1.5,wordBreak:"break-word",whiteSpace:"pre-wrap",fontFamily:linkedinError.includes("DSN set:")?"'JetBrains Mono',monospace":"inherit"}}>
            {linkedinError}
          </div>
        )}
      </div>
    ) : (<>

    {/* Stats Cards */}
    {outreachStats && (<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(130px,1fr))",gap:12,marginBottom:20}}>
      {[
        {label:"Total",value:outreachStats.total,color:"var(--t1)"},
        {label:"Queued",value:outreachStats.queued,color:"var(--amb)"},
        {label:"Requests Sent",value:outreachStats.connectionSent,color:"var(--blu)"},
        {label:"Connected",value:outreachStats.connected,color:"var(--grn)"},
        {label:"DMs In Progress",value:outreachStats.dmInProgress,color:"var(--pur)"},
        {label:"Replied ✋",value:outreachStats.replied||0,color:"var(--grn)"},
        {label:"Completed",value:outreachStats.completed,color:"var(--grn)"},
        {label:"Errors",value:outreachStats.errors,color:"var(--red)"},
      ].map(s => (
        <div key={s.label} style={{padding:"14px 16px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8}}>
          <div style={{fontSize:22,fontWeight:700,color:s.color,fontFamily:"'JetBrains Mono',monospace"}}>{s.value}</div>
          <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>{s.label}</div>
        </div>
      ))}
    </div>)}

    {/* Outreach Rules */}
    {(() => {
      // Filter out the auto-batch infrastructure rule. "Sidekick Auto-Batch v1"
      // is created by /api/sidekick/auto-batch/generate as scaffolding for the
      // cron's DM cadence config. It must NOT be manually actionable — clicking
      // Enqueue Leads on it would create generic outreach records bypassing the
      // AI-personalization pipeline. Auto-batch is managed exclusively via the
      // Side Kick chatbot (Daily LinkedIn Batch card).
      const outRules = rules.filter(r => {
        const f = r.fields || {};
        if (f["Task Type"] !== "linkedin_outreach") return false;
        if (f.Name === "Sidekick Auto-Batch v1") return false;
        return true;
      });
      return outRules.length > 0 ? (
        <div style={{marginBottom:20}}>
          <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:"var(--t2)"}}>Outreach Rules</div>
          {outRules.map(r => {
            const f = r.fields || {};
            let config; try { config = JSON.parse(f["Outreach Config"] || "{}"); } catch { config = {}; }
            const seq = config.dmSequence || [];
            return (<div key={r.id} style={{padding:16,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div>
                  <div style={{fontSize:14,fontWeight:600,color:"var(--t1)"}}>{f.Name}</div>
                  <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>{config.leadsPerBatch || 10} leads/batch · {seq.length} DM steps · {config.connectionsPerDay || 5} connections/day</div>
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button className="btn btn-ai btn-s" disabled={outreachLoading} onClick={async()=>{const res=await enqueueLeads({...config,name:f.Name});if(res?.enqueued>0)alert("Enqueued "+res.enqueued+" leads!")}}>{outreachLoading?"…":"⚡ Enqueue Leads"}</button>
                  <button className="btn btn-p btn-s" disabled={outreachLoading||!linkedinAccount} onClick={()=>runOutreachNow(r)}>{outreachLoading?"…":"▶ Run Now"}</button>
                  <button className="btn btn-s" onClick={()=>setEditRule({airtableId:r.id,taskType:"linkedin_outreach",name:f.Name,description:f.Description||"",outreachConfig:config})}>Edit</button>
                  <button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button>
                </div>
              </div>
              {config.connectionMessage && <div style={{fontSize:10,color:"var(--t3)",padding:8,background:"var(--hover)",borderRadius:4,marginBottom:6}}>📨 Connection: "{config.connectionMessage.slice(0,80)}…"</div>}
              {seq.length > 0 && <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{seq.map((s,i) => (
                <div key={i} style={{fontSize:9,padding:"4px 8px",borderRadius:4,background:"var(--pur-d)",color:"var(--pur)"}}>DM {i+1}: {s.daysAfterPrev||s.daysAfterConnect||"?"} days gap{s.aiGenerate?" (AI)":""}</div>
              ))}</div>}
            </div>);
          })}
        </div>
      ) : null;
    })()}

    {/* Add Rule */}
    <button className="btn btn-s" onClick={()=>setEditRule({taskType:"linkedin_outreach",name:"",description:"",outreachConfig:{leadsPerBatch:10,connectionsPerDay:5,connectionMessage:"",daysAfterConnect:2,leadPrompt:"",dmSequence:[{step:1,daysAfterConnect:2,daysAfterPrev:0,message:"Hi {first_name}, thanks for connecting! {signal}",aiGenerate:false}]}})}><I.Plus/> New Outreach Rule</button>

    {/* Queue Table */}
    {outreachItems.length > 0 && (<div style={{marginTop:20}}>
      {(() => {
        // Split into active vs terminal (audit-trail) records.
        // Active: queued, pending_approval, connection_sent, connected, dm_*
        // Terminal: skipped, completed, replied, error
        const TERMINAL_STATUSES = new Set(["skipped", "completed", "replied", "error"]);
        const activeItems = outreachItems.filter(q => !TERMINAL_STATUSES.has(q.fields?.Status));
        const historyItems = outreachItems.filter(q => TERMINAL_STATUSES.has(q.fields?.Status));
        const skippedItems = outreachItems.filter(q => q.fields?.Status === "skipped");
        const displayedItems = outreachShowHistory ? outreachItems : activeItems;
        const cleanupSkipped = async () => {
          if (!skippedItems.length) return;
          if (!confirm(`Permanently delete ${skippedItems.length} skipped records from Airtable? This removes the audit trail but cleans up the queue.`)) return;
          setOutreachCleanupRunning(true);
          try {
            // Delete in batches of 10 (Airtable limit)
            const ids = skippedItems.map(s => s.id);
            for (let i = 0; i < ids.length; i += 10) {
              await del("Outreach", ids.slice(i, i + 10), setOutreachItems);
            }
          } finally {
            setOutreachCleanupRunning(false);
          }
        };
        // ─── Next cron run helper ────────────────────────────────
        // Cron runs every ~4h via GitHub Actions workflow "Outreach Cron
        // (4-hour)" — was previously documented as daily 11:30 IST which was
        // wrong and caused operator confusion. Prediction is grounded in the
        // most recent observed scheduled run + 4h; falls back to a generic
        // "~4h cycle" when no history is loaded yet.
        const nextCronRun = (() => {
          const queuedCount = activeItems.filter(q => q.fields?.Status === "queued").length;
          const lastRunAt = cronStatus?.summary?.lastRunAt;
          if (!lastRunAt) {
            return { relative: "in next ~4h cycle", queuedCount, predicted: false, overdue: false };
          }
          const lastRunMs = new Date(lastRunAt).getTime();
          const nextRunMs = lastRunMs + 4 * 3600 * 1000;
          const diffMs = nextRunMs - Date.now();
          if (diffMs <= 0) {
            const overdueMs = -diffMs;
            const overdueMin = Math.floor(overdueMs / 60000);
            const overdueLabel = overdueMin < 60 ? `${overdueMin}m` : `${Math.floor(overdueMin/60)}h ${overdueMin % 60}m`;
            return { relative: `due now (${overdueLabel} overdue)`, queuedCount, predicted: true, overdue: true };
          }
          const hours = Math.floor(diffMs / 3600000);
          const minutes = Math.floor((diffMs % 3600000) / 60000);
          const relative = hours >= 1 ? `in ~${hours}h ${minutes}m` : `in ~${minutes}m`;
          return { relative, queuedCount, predicted: true, overdue: false };
        })();
        // Count Sidekick Auto-Batch records across ALL statuses for the reset button
        const sidekickItems = outreachItems.filter(q => q.fields?.Campaign === "Sidekick Auto-Batch v1");
        const resetSidekick = async () => {
          if (!sidekickItems.length) return;
          const byStatus = sidekickItems.reduce((acc, q) => {
            const s = q.fields?.Status || "unknown";
            acc[s] = (acc[s] || 0) + 1;
            return acc;
          }, {});
          const breakdown = Object.entries(byStatus).map(([k, v]) => `  · ${k}: ${v}`).join("\n");
          if (!confirm(`Full Sidekick Auto-Batch reset.\n\nWill delete ${sidekickItems.length} records:\n${breakdown}\n\nManual Outreach records will be untouched.\n\nProceed?`)) return;
          setOutreachCleanupRunning(true);
          try {
            const r = await fetch("/api/sidekick/auto-batch/reset", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ baseId: bid, confirm: true }),
            });
            const data = await r.json();
            if (data.ok) {
              // Remove deleted records from local state
              setOutreachItems(prev => prev.filter(q => q.fields?.Campaign !== "Sidekick Auto-Batch v1"));
              alert(`✓ Reset complete. Deleted ${data.deletedCount} records.\n\nBy status:\n${Object.entries(data.byStatus || {}).map(([k,v]) => `· ${k}: ${v}`).join("\n")}\n\nThe chatbot will auto-generate a fresh batch on next visit.`);
            } else {
              alert(`Reset failed: ${data.error || "unknown error"}`);
            }
          } catch (e) {
            alert(`Reset failed: ${e.message}`);
          } finally {
            setOutreachCleanupRunning(false);
          }
        };
        return (<>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8,gap:10,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
          <div style={{fontSize:12,fontWeight:600,color:"var(--t2)"}}>
            Outreach Queue ({outreachShowHistory ? outreachItems.length : activeItems.length}{outreachShowHistory ? "" : " active"})
          </div>
          {historyItems.length > 0 && (
            <button
              className="btn btn-s"
              style={{fontSize:10,padding:"3px 8px"}}
              onClick={() => setOutreachShowHistory(v => !v)}
            >
              {outreachShowHistory ? `✕ Hide history` : `📜 Show history (${historyItems.length})`}
            </button>
          )}
          {skippedItems.length >= 10 && (
            <button
              className="btn btn-d btn-s"
              style={{fontSize:10,padding:"3px 8px"}}
              disabled={outreachCleanupRunning}
              onClick={cleanupSkipped}
              title="Permanently delete all skipped records from Airtable (audit trail)"
            >
              {outreachCleanupRunning ? "…" : `🗑 Clear ${skippedItems.length} skipped`}
            </button>
          )}
          {sidekickItems.length > 0 && (
            <button
              className="btn btn-d btn-s"
              style={{fontSize:10,padding:"3px 8px",borderColor:"var(--red)",color:"var(--red)"}}
              disabled={outreachCleanupRunning}
              onClick={resetSidekick}
              title="Delete ALL Sidekick Auto-Batch records (every status). Manual Outreach untouched."
            >
              {outreachCleanupRunning ? "…" : `💣 Reset Sidekick (${sidekickItems.length})`}
            </button>
          )}
          {nextCronRun.queuedCount > 0 && (
            <div
              style={{
                fontSize: 10,
                padding: "3px 10px",
                borderRadius: 4,
                background: nextCronRun.overdue ? "rgba(196, 107, 107, 0.12)" : "rgba(245, 158, 11, 0.1)",
                color: nextCronRun.overdue ? "var(--red)" : "var(--amb)",
                fontWeight: 500,
              }}
              title={`Cron runs every ~4h via GitHub Actions. ${nextCronRun.queuedCount} queued record${nextCronRun.queuedCount === 1 ? "" : "s"} will be processed on the next run.`}
            >
              ⏰ Next send: {nextCronRun.relative}
            </div>
          )}
          {cronStatus && cronStatus.summary && (() => {
            // Cron health chip — color & label driven by status.summary.health.state
            const h = cronStatus.summary.health;
            const colors = {
              healthy:           { bg: "rgba(93,168,142,0.1)", fg: "var(--grn)",  emoji: "✅" },
              warning:           { bg: "rgba(245,158,11,0.1)", fg: "var(--amb)",  emoji: "⚠️" },
              stale:             { bg: "rgba(239,68,68,0.1)",  fg: "var(--red)",  emoji: "🔴" },
              no_scheduled_runs: { bg: "rgba(239,68,68,0.1)",  fg: "var(--red)",  emoji: "❌" },
            };
            const c = colors[h?.state] || { bg: "var(--hover)", fg: "var(--t3)", emoji: "•" };
            const sum = cronStatus.summary;
            const tooltip = [
              `Health: ${h?.state || "unknown"} — ${h?.message || ""}`,
              `Last run: ${sum.lastRunAt ? new Date(sum.lastRunAt).toLocaleString() : "never"}`,
              `Last status: ${sum.lastRunStatus} (${sum.lastRunTrigger})`,
              `Sent in last 24h: ${sum.connectionsLast24h} connections · ${sum.dmsLast24h} DMs`,
              `Schedule: ${sum.cronSchedule}`,
            ].join("\n");
            return (
              <div
                style={{
                  fontSize: 10, padding: "3px 10px", borderRadius: 4,
                  background: c.bg, color: c.fg, fontWeight: 500,
                  cursor: "help",
                }}
                title={tooltip}
              >
                {c.emoji} Cron: {h?.state === "healthy" ? "healthy" : h?.state === "warning" ? "warning" : h?.state === "stale" ? "stuck" : h?.state === "no_scheduled_runs" ? "not running" : "unknown"}
              </div>
            );
          })()}
        </div>
        {outreachItems.filter(q => q.fields?.Status === "replied").length > 0 && (
          <div style={{fontSize:10,color:"var(--t2)",display:"flex",gap:10,alignItems:"center"}}>
            {(() => {
              const replied = outreachItems.filter(q => q.fields?.Status === "replied");
              const byIntent = replied.reduce((acc, q) => { const i = q.fields?.["Reply Intent"] || "unclassified"; acc[i] = (acc[i] || 0) + 1; return acc; }, {});
              const intentColors = { interested: "var(--grn)", objection: "var(--amb)", referral: "var(--blu)", not_interested: "var(--red)", out_of_office: "var(--t3)", auto_reply: "var(--t3)", unclear: "var(--t3)", unclassified: "var(--t3)" };
              const intentEmoji = { interested: "🔥", objection: "⚖️", referral: "↪️", not_interested: "❌", out_of_office: "🏖", auto_reply: "🤖", unclear: "❓", unclassified: "•" };
              return Object.entries(byIntent).sort((a,b)=>b[1]-a[1]).map(([k, v]) => (
                <span key={k} style={{color:intentColors[k]||"var(--t3)"}}>{intentEmoji[k]||"•"} {v} {k.replace(/_/g," ")}</span>
              ));
            })()}
          </div>
        )}
      </div>
      <div className="tw"><table><thead><tr><th>Lead</th><th>Company</th><th>Campaign</th><th>Status</th><th>Reply Intent</th><th>DM Step</th><th>Next Action</th></tr></thead>
      <tbody>{displayedItems.slice(0,50).map(q => {
        const f = q.fields || {};
        const status = f.Status || "queued";
        const statusColor = status==="replied"?"cg":status==="completed"?"cg":status==="error"?"cr":status==="connected"||status.startsWith("dm_")?"cp":status==="connection_sent"?"cb":"ca";
        const isReplied = status === "replied";
        const intent = f["Reply Intent"];
        const urgency = f["Reply Urgency"];
        const summary = f["Reply Summary"];
        const action = f["Reply Suggested Action"];
        const confidence = f["Reply Confidence"];
        const intentMap = {
          interested: { emoji: "🔥", label: "Interested", color: "var(--grn)", bg: "var(--grn-d)" },
          objection: { emoji: "⚖️", label: "Objection", color: "var(--amb)", bg: "rgba(245,158,11,.1)" },
          referral: { emoji: "↪️", label: "Referral", color: "var(--blu)", bg: "rgba(96,165,250,.1)" },
          not_interested: { emoji: "❌", label: "Not interested", color: "var(--red)", bg: "rgba(239,68,68,.1)" },
          out_of_office: { emoji: "🏖", label: "OOO", color: "var(--t3)", bg: "var(--hover)" },
          auto_reply: { emoji: "🤖", label: "Auto-reply", color: "var(--t3)", bg: "var(--hover)" },
          unclear: { emoji: "❓", label: "Unclear", color: "var(--t3)", bg: "var(--hover)" },
        };
        const intentInfo = intentMap[intent];
        const rowBg = isReplied
          ? (intent === "interested" ? "rgba(93,168,122,.08)" : intent === "not_interested" ? "rgba(239,68,68,.06)" : intent === "objection" ? "rgba(245,158,11,.06)" : "var(--grn-d)")
          : null;
        return (<Fragment key={q.id}>
          <tr style={rowBg ? {background: rowBg} : {}}>
            <td style={{color:"var(--t1)",fontWeight:500}}>{f["Lead Name"]}</td>
            <td>{f.Company}</td>
            <td style={{fontSize:10}}>{f.Campaign}</td>
            <td><span className={"chip "+statusColor}>{status==="replied"?"✋ replied":status.replace(/_/g," ")}</span></td>
            <td>
              {isReplied && intentInfo ? (
                <span title={summary || ""} style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:10,padding:"2px 8px",borderRadius:4,background:intentInfo.bg,color:intentInfo.color,fontWeight:600}}>
                  {intentInfo.emoji} {intentInfo.label}
                  {urgency === "high" && <span style={{color:"var(--red)",marginLeft:2}}>!</span>}
                </span>
              ) : isReplied ? <span style={{fontSize:10,color:"var(--t3)",fontStyle:"italic"}}>not classified</span> : <span style={{fontSize:10,color:"var(--t3)"}}>—</span>}
            </td>
            <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f["DM Step"]||0}</td>
            <td style={{fontSize:10}}>{
              status === "replied" ? "—"
              : status === "queued" ? (
                  <span style={{color:"var(--amb)"}} title={`Cron processes queued records every ~4h via GitHub Actions. Next: ${nextCronRun.relative}.`}>
                    Sends {nextCronRun.relative}
                  </span>
                )
              : (f["Next Action Date"] || "—")
            }</td>
          </tr>
          {isReplied && (summary || action) && (
            <tr style={{background:rowBg}}>
              <td colSpan={7} style={{padding:"4px 14px 10px 14px",fontSize:10,color:"var(--t2)",borderTop:"none"}}>
                {summary && <div style={{marginBottom:3}}><strong style={{color:"var(--t3)"}}>Summary:</strong> {summary}</div>}
                {action && <div><strong style={{color:"var(--t3)"}}>Next:</strong> <span style={{color:urgency==="high"?"var(--red)":"var(--t2)"}}>{action}</span> {confidence != null && <span style={{color:"var(--t3)",marginLeft:4}}>· {confidence}% confidence</span>}</div>}
              </td>
            </tr>
          )}
        </Fragment>);
      })}</tbody></table></div>
        </>);
      })()}
    </div>)}

    </>)}
  </div>)}

  </div></div>

  {/* GLOBAL FLOATING TOAST — visible from any tab so user always sees push results */}
  {hsMsg && (
    <div style={{
      position: "fixed",
      bottom: 20,
      right: 20,
      maxWidth: 480,
      padding: "12px 16px",
      background: hsMsg.startsWith("✅") || hsMsg.startsWith("🔄") || hsMsg.includes("updated") || hsMsg.includes("created")
        ? "var(--grn-d)"
        : hsMsg.startsWith("❌")
          ? "var(--red-d)"
          : "var(--card)",
      border: "1px solid " + (hsMsg.startsWith("✅") || hsMsg.startsWith("🔄") || hsMsg.includes("updated") || hsMsg.includes("created")
        ? "var(--grn)"
        : hsMsg.startsWith("❌")
          ? "var(--red)"
          : "var(--bdr)"),
      color: hsMsg.startsWith("✅") || hsMsg.startsWith("🔄") || hsMsg.includes("updated") || hsMsg.includes("created")
        ? "var(--grn)"
        : hsMsg.startsWith("❌")
          ? "var(--red)"
          : "var(--t1)",
      borderRadius: 8,
      fontSize: 12,
      fontWeight: 500,
      lineHeight: 1.4,
      zIndex: 9999,
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      whiteSpace: "pre-wrap",
      display: "flex",
      alignItems: "flex-start",
      gap: 10,
    }}>
      <span style={{ flex: 1 }}>{hsMsg}</span>
      <button onClick={() => setHsMsg("")} style={{ background: "transparent", border: "none", color: "var(--t3)", cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1, marginLeft: 4 }}>×</button>
    </div>
  )}

  {editRule!==null&&<RuleEditor rule={editRule} onSave={saveRule} onClose={()=>setEditRule(null)} availableFields={availableFields} baseId={bid}/>}
  {showExportModal&&<ExportModal tasks={selCount>0?fTasks.filter(t=>selectedTasks.has(t.id)):fTasks} accounts={accounts} leads={leads} onClose={()=>setShowExportModal(false)}/>}
  {enrichModal&&<EnrichModal mode={enrichModal.mode} tasks={tasks} rules={rules} fTasks={fTasks} selectedTasks={selectedTasks} onEnrich={enrichTasks} onPush={pushToHubSpot} enrichResults={enrichResults} enrichLoading={enrichLoading} hsConnected={hsConnected} hsOwners={hsOwners} hsLoading={hsLoading} onClose={()=>{setEnrichModal(null);setEnrichResults([])}}/>}
  {manualModal&&<ManualOutreachModal leads={leads} rules={rules} linkedinAccount={linkedinAccount} outreachAPI={outreachAPI} onClose={()=>setManualModal(null)} baseId={bid}/>}

  {/* ORPHAN REPAIR MODAL */}
  {repairModal && (
    <div className="modal-o" onClick={e=>e.target===e.currentTarget&&setRepairModal(null)}>
      <div className="modal" style={{maxWidth:720}}>
        <div className="modal-h">
          <span style={{fontWeight:600}}>🔧 Repair Orphaned HubSpot Tasks</span>
          <button className="btn btn-s" onClick={()=>setRepairModal(null)}>✕</button>
        </div>
        <div style={{padding:20}}>

          {/* STEP 1: CONFIG */}
          {repairModal.step === "config" && (<div>
            <div style={{fontSize:11,color:"var(--t2)",marginBottom:14,lineHeight:1.6}}>
              This will scan HubSpot for tasks created by SignalScope that have no contact association, match them to your Airtable leads by subject/name, and create the missing associations. Safe operation — it only ADDS associations.
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
              <div className="ig" style={{marginBottom:0}}>
                <div className="il">Date From</div>
                <input type="date" className="inp" value={repairModal.dateFrom} onChange={e=>setRepairModal(m=>({...m,dateFrom:e.target.value}))}/>
              </div>
              <div className="ig" style={{marginBottom:0}}>
                <div className="il">Date To</div>
                <input type="date" className="inp" value={repairModal.dateTo} onChange={e=>setRepairModal(m=>({...m,dateTo:e.target.value}))}/>
              </div>
            </div>
            <div className="ig">
              <div className="il">Subject contains <span style={{fontWeight:400,color:"var(--t3)",textTransform:"none",marginLeft:4}}>(optional — narrow the scan)</span></div>
              <input type="text" className="inp" placeholder="e.g. Website Engagement" value={repairModal.subjectContains} onChange={e=>setRepairModal(m=>({...m,subjectContains:e.target.value}))}/>
            </div>
            {repairModal.error && <div style={{padding:10,background:"var(--red-d)",color:"var(--red)",borderRadius:6,fontSize:11,marginTop:10}}>❌ {repairModal.error}</div>}
          </div>)}

          {/* STEP 2: PREVIEW */}
          {repairModal.step === "preview" && repairModal.preview && (<div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10,marginBottom:14}}>
              <div style={{padding:14,background:"var(--hover)",borderRadius:8,textAlign:"center"}}>
                <div style={{fontSize:22,fontWeight:700,color:"var(--t1)"}}>{repairModal.preview.totalHubspotTasks}</div>
                <div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>HubSpot tasks scanned</div>
              </div>
              <div style={{padding:14,background:"rgba(245,158,11,0.1)",borderRadius:8,textAlign:"center"}}>
                <div style={{fontSize:22,fontWeight:700,color:"var(--amb)"}}>{repairModal.preview.orphanedTasks}</div>
                <div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>Orphaned</div>
              </div>
              <div style={{padding:14,background:"var(--grn-d)",borderRadius:8,textAlign:"center"}}>
                <div style={{fontSize:22,fontWeight:700,color:"var(--grn)"}}>{repairModal.preview.matchable}</div>
                <div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>Safe to link</div>
              </div>
              <div style={{padding:14,background:"rgba(239,68,68,0.1)",borderRadius:8,textAlign:"center"}}>
                <div style={{fontSize:22,fontWeight:700,color:"var(--red)"}}>{repairModal.preview.unmatchable}</div>
                <div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>Skipped</div>
              </div>
            </div>

            {/* Run ID for log correlation */}
            {repairModal.preview.runId && (
              <div style={{fontSize:9,color:"var(--t3)",marginBottom:10,fontFamily:"monospace"}}>
                Run ID: <strong>{repairModal.preview.runId}</strong> — search Vercel logs by <code style={{background:"var(--hover)",padding:"1px 4px",borderRadius:3}}>[orphan:{repairModal.preview.runId}]</code> for detailed trace
              </div>
            )}

            {/* Match quality preview (sample pairs) */}
            {repairModal.preview.pairs?.length > 0 && (
              <details style={{marginBottom:12,padding:10,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:6}}>
                <summary style={{fontSize:11,color:"var(--grn)",cursor:"pointer",fontWeight:600}}>✅ Preview the {Math.min(repairModal.preview.pairs.length, 20)} associations to create (sample)</summary>
                <div style={{maxHeight:300,overflow:"auto",marginTop:10,fontSize:10,color:"var(--t3)",lineHeight:1.6}}>
                  <table style={{width:"100%",fontSize:10,borderCollapse:"collapse"}}>
                    <thead><tr style={{borderBottom:"1px solid var(--bdr)"}}>
                      <th style={{textAlign:"left",padding:"4px 8px",color:"var(--t2)"}}>Task Subject</th>
                      <th style={{textAlign:"left",padding:"4px 8px",color:"var(--t2)"}}>Lead</th>
                      <th style={{textAlign:"left",padding:"4px 8px",color:"var(--t2)"}}>Email</th>
                      <th style={{textAlign:"left",padding:"4px 8px",color:"var(--t2)"}}>Match Type</th>
                    </tr></thead>
                    <tbody>
                      {repairModal.preview.pairs.slice(0, 20).map((p, i) => (
                        <tr key={i} style={{borderBottom:"1px solid var(--bdr)"}}>
                          <td style={{padding:"4px 8px",color:"var(--t2)",maxWidth:220,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{p.taskSubject}</td>
                          <td style={{padding:"4px 8px"}}>{p.leadName || "—"}</td>
                          <td style={{padding:"4px 8px",fontFamily:"monospace",fontSize:9}}>{p.contactEmail}</td>
                          <td style={{padding:"4px 8px"}}>
                            <span style={{fontSize:9,padding:"2px 6px",borderRadius:3,background:p.matchMethod==="tracked_hubspot_id"?"var(--grn-d)":p.matchMethod==="exact_subject"?"var(--hover)":"rgba(245,158,11,0.2)",color:p.matchMethod==="tracked_hubspot_id"?"var(--grn)":p.matchMethod==="fuzzy_company_name"?"var(--amb)":"var(--t2)"}}>
                              {p.matchMethod === "tracked_hubspot_id" ? "✓ tracked" : p.matchMethod === "exact_subject" ? "exact" : "fuzzy"}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {repairModal.preview.pairs.length > 20 && <div style={{padding:"6px 8px",fontStyle:"italic"}}>...and {repairModal.preview.pairs.length - 20} more</div>}
                </div>
              </details>
            )}

            {/* Unmatched details */}
            {repairModal.preview.unmatchable > 0 && (
              <details style={{marginBottom:14,padding:10,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:6}}>
                <summary style={{fontSize:11,color:"var(--amb)",cursor:"pointer",fontWeight:600}}>⚠️ {repairModal.preview.unmatchable} skipped (click for reasons){repairModal.preview.ambiguous > 0 ? ` — ${repairModal.preview.ambiguous} skipped as ambiguous for safety` : ""}</summary>
                <div style={{maxHeight:200,overflow:"auto",marginTop:10,fontSize:10,color:"var(--t3)",lineHeight:1.6}}>
                  {(repairModal.preview.unmatched || []).slice(0, 50).map((u, i) => (
                    <div key={i} style={{padding:"4px 0",borderBottom:"1px solid var(--bdr)"}}>
                      <strong style={{color:"var(--t2)"}}>{u.taskSubject || "(no subject)"}</strong> — {u.reason}
                    </div>
                  ))}
                  {repairModal.preview.unmatched?.length > 50 && <div style={{paddingTop:6,fontStyle:"italic"}}>...and {repairModal.preview.unmatched.length - 50} more</div>}
                </div>
              </details>
            )}

            {/* Diagnostics */}
            {repairModal.preview.diagnostics && (
              <details style={{marginBottom:14,padding:10,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:6}}>
                <summary style={{fontSize:11,color:"var(--t3)",cursor:"pointer",fontWeight:600}}>🔍 Scan Diagnostics</summary>
                <div style={{marginTop:10,fontSize:10,color:"var(--t3)",lineHeight:1.8,fontFamily:"monospace"}}>
                  {Object.entries(repairModal.preview.diagnostics).map(([k, v]) => (
                    <div key={k}><span style={{color:"var(--t2)"}}>{k}:</span> <strong>{v}</strong></div>
                  ))}
                </div>
              </details>
            )}

            {repairModal.preview.warnings?.length > 0 && (
              <div style={{padding:10,background:"rgba(245,158,11,0.1)",color:"var(--amb)",borderRadius:6,fontSize:11,marginBottom:10}}>
                ⚠️ {repairModal.preview.warnings.join("; ")}
              </div>
            )}

            {repairModal.preview.matchable > 0 && (
              <div style={{padding:12,background:"var(--grn-d)",color:"var(--grn)",borderRadius:6,fontSize:11,lineHeight:1.5}}>
                ✅ <strong>Ready to safely repair {repairModal.preview.matchable} task{repairModal.preview.matchable!==1?"s":""}.</strong> Each will be linked to its verified contact. Review the sample above before clicking Execute.
              </div>
            )}
            {repairModal.preview.matchable === 0 && repairModal.preview.orphanedTasks > 0 && (
              <div style={{padding:12,background:"var(--red-d)",color:"var(--red)",borderRadius:6,fontSize:11,lineHeight:1.5}}>
                ❌ No tasks could be safely matched. Review the skipped reasons above. Common fixes: upload leads to HubSpot first, or check that lead names on tasks match the Leads table exactly.
              </div>
            )}
            {repairModal.preview.orphanedTasks === 0 && (
              <div style={{padding:12,background:"var(--grn-d)",color:"var(--grn)",borderRadius:6,fontSize:11,lineHeight:1.5}}>
                ✨ No orphans found in the selected date range. All tasks are properly linked.
              </div>
            )}
            {repairModal.error && <div style={{padding:10,background:"var(--red-d)",color:"var(--red)",borderRadius:6,fontSize:11,marginTop:10}}>❌ {repairModal.error}</div>}
          </div>)}

          {/* STEP 3: RUNNING */}
          {repairModal.step === "running" && (<div style={{padding:"40px 20px",textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:14}}>⏳</div>
            <div style={{fontSize:13,color:"var(--t1)",fontWeight:600,marginBottom:6}}>Creating associations...</div>
            <div style={{fontSize:11,color:"var(--t3)"}}>Linking {repairModal.preview?.matchable || 0} tasks to their contacts in HubSpot</div>
          </div>)}

          {/* STEP 4: DONE */}
          {repairModal.step === "done" && repairModal.result && (<div>
            <div style={{padding:20,background:repairModal.result.repaired>0?"var(--grn-d)":"var(--red-d)",borderRadius:8,textAlign:"center",marginBottom:14}}>
              <div style={{fontSize:32,marginBottom:8}}>{repairModal.result.repaired>0?"✅":"❌"}</div>
              <div style={{fontSize:16,fontWeight:700,color:repairModal.result.repaired>0?"var(--grn)":"var(--red)"}}>{repairModal.result.repaired} task{repairModal.result.repaired!==1?"s":""} linked to contacts</div>
              {repairModal.result.failed > 0 && (
                <div style={{fontSize:11,color:"var(--amb)",marginTop:6}}>⚠️ {repairModal.result.failed} failed — see details below</div>
              )}
              {repairModal.result.airtableSynced > 0 && (
                <div style={{fontSize:11,color:"var(--grn)",marginTop:6}}>💾 {repairModal.result.airtableSynced} HubSpot IDs synced to Airtable (future pushes will update instead of duplicate)</div>
              )}
              {repairModal.result.runId && (
                <div style={{fontSize:9,color:"var(--t3)",marginTop:10,fontFamily:"monospace"}}>
                  Run ID: <strong>{repairModal.result.runId}</strong>
                </div>
              )}
            </div>
            {repairModal.result.partialFailures?.length > 0 && (
              <details style={{marginBottom:14,padding:10,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:6}}>
                <summary style={{fontSize:11,color:"var(--amb)",cursor:"pointer",fontWeight:600}}>⚠️ Individual task failures ({repairModal.result.partialFailures.length})</summary>
                <div style={{maxHeight:200,overflow:"auto",marginTop:10,fontSize:10,color:"var(--t3)",lineHeight:1.6,fontFamily:"monospace"}}>
                  {repairModal.result.partialFailures.slice(0, 30).map((f, i) => (
                    <div key={i} style={{padding:"4px 0",borderBottom:"1px solid var(--bdr)"}}>
                      Task {f.taskId} → Contact {f.contactId}: <span style={{color:"var(--red)"}}>{f.error}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
            {repairModal.result.errors?.length > 0 && (
              <details style={{marginBottom:14,padding:10,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:6}}>
                <summary style={{fontSize:11,color:"var(--red)",cursor:"pointer",fontWeight:600}}>❌ Batch-level errors ({repairModal.result.errors.length})</summary>
                <div style={{maxHeight:200,overflow:"auto",marginTop:10,fontSize:10,color:"var(--t3)",lineHeight:1.6,fontFamily:"monospace"}}>
                  {repairModal.result.errors.map((e, i) => <div key={i} style={{padding:"4px 0"}}>{e}</div>)}
                </div>
              </details>
            )}
            {repairModal.result.auditLog?.length > 0 && (
              <details style={{marginBottom:14,padding:10,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:6}}>
                <summary style={{fontSize:11,color:"var(--t3)",cursor:"pointer",fontWeight:600}}>📋 Full audit log ({repairModal.result.auditLog.length} entries)</summary>
                <div style={{marginTop:10}}>
                  <button className="btn btn-s" onClick={()=>{
                    const csv = ["Task ID,Contact ID,Success,Method/Reason", ...repairModal.result.auditLog.map(a => `${a.taskId},${a.contactId},${a.success},"${(a.method||a.reason||"").replace(/"/g,'""')}"`)].join("\n");
                    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a");
                    a.href = url;
                    a.download = `hubspot-repair-audit-${repairModal.result.runId || Date.now()}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}>📥 Download audit CSV</button>
                </div>
              </details>
            )}
            <div style={{padding:12,background:"var(--hover)",borderRadius:6,fontSize:11,color:"var(--t2)",lineHeight:1.5}}>
              💡 Verify in HubSpot: open any task from the repaired list — you should now see the contact in the right sidebar.
            </div>
          </div>)}

        </div>
        <div className="modal-f">
          {repairModal.step === "config" && (<>
            <button className="btn" onClick={()=>setRepairModal(null)}>Cancel</button>
            <button className="btn btn-p" disabled={repairModal.running} onClick={runRepairPreview}>
              {repairModal.running ? "⏳ Scanning..." : "🔍 Scan & Preview"}
            </button>
          </>)}
          {repairModal.step === "preview" && (<>
            <button className="btn" onClick={()=>setRepairModal(m=>({...m,step:"config"}))}>← Back</button>
            {repairModal.preview?.matchable > 0 ? (
              <button className="btn btn-p" disabled={repairModal.running} onClick={executeRepair}>
                🔧 Execute Repair ({repairModal.preview.matchable} links)
              </button>
            ) : (
              <button className="btn" onClick={()=>setRepairModal(null)}>Close</button>
            )}
          </>)}
          {repairModal.step === "done" && (
            <button className="btn btn-p" onClick={()=>setRepairModal(null)}>Done</button>
          )}
        </div>
      </div>
    </div>
  )}

  {/* CSV upload prep indicator — shows only during the pre-modal fetch phase.
      During the actual upload, the csvUploadResult toast shows progress instead. */}
  {csvPrepping && !csvUploadResult && (<div style={{position:"fixed",top:20,right:20,zIndex:9998,padding:12,maxWidth:340,background:"rgba(91,143,212,.95)",color:"white",borderRadius:8,fontSize:11,boxShadow:"0 4px 12px rgba(0,0,0,.3)"}}>
    ⏳ Working on CSV — fetching latest records and applying changes...
  </div>)}

  {/* CSV upload result toast — shows match/create counts after upload */}
  {csvUploadResult&&(<div style={{position:"fixed",top:20,right:20,zIndex:9999,padding:14,maxWidth:480,
      background: csvUploadResult.isError ? "rgba(239,68,68,.95)" : csvUploadResult.isProgress ? "rgba(91,143,212,.95)" : "rgba(93,168,122,.95)",
      color:"white",borderRadius:8,fontSize:12,boxShadow:"0 4px 12px rgba(0,0,0,.3)",lineHeight:1.4}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:10}}>
      <div>{csvUploadResult.isError ? "❌ " : csvUploadResult.isProgress ? "⏳ " : "✅ "}{csvUploadResult.msg}</div>
      {!csvUploadResult.isProgress && (
        <button onClick={()=>setCsvUploadResult(null)} style={{background:"transparent",border:"none",color:"white",cursor:"pointer",fontSize:14,padding:0,lineHeight:1}}>✕</button>
      )}
    </div>
  </div>)}

  {/* CSV MODAL */}
  {csvModal&&(<div className="modal-o" onClick={e=>e.target===e.currentTarget&&setCsvModal(null)}><div className="modal" style={{maxWidth:700}}>
  <div className="modal-h"><span style={{fontWeight:600}}>Map CSV → {csvModal.table}</span><button className="btn btn-s" onClick={()=>setCsvModal(null)}>✕</button></div>
  <div className="modal-b">

  {/* Import mode toggle */}
  <div className="ig">
    <div className="il">Import Mode</div>
    <div style={{display:"flex",gap:8}}>
      <button className={"btn btn-s"+(csvModal.mode==="create"?" btn-p":"")} style={{flex:1,justifyContent:"center"}} onClick={()=>setCsvModal(p=>({...p,mode:"create"}))}>
        <I.Plus/> Create New Records
      </button>
      <button className={"btn btn-s"+(csvModal.mode==="update"?" btn-p":"")} style={{flex:1,justifyContent:"center"}} onClick={()=>setCsvModal(p=>({...p,mode:"update"}))}>
        <I.Upload/> Update Existing
      </button>
    </div>
    <div style={{fontSize:10,color:"var(--t3)",marginTop:6}}>
      {csvModal.mode==="create"
        ? "All rows will be created as new records."
        : "Matches rows against existing records by a field you choose, then adds the new columns to those records. Unmatched rows are created as new."}
    </div>
  </div>

  {/* Match field (update mode only) */}
  {csvModal.mode==="update"&&(<div className="ig">
    <div className="il">Match Records By</div>
    <div style={{display:"flex",gap:8,alignItems:"center"}}>
      <select className="inp" style={{flex:1}} value={csvModal.matchField} onChange={e=>setCsvModal(p=>({...p,matchField:e.target.value}))}>
        {Object.values(csvModal.mappings).filter(v=>v!=="__skip__").map(f=>(
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
    </div>
    <div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>
      Pick the field that exists in both your CSV and your current {csvModal.table.toLowerCase()}. Rows with a matching value will be updated, not duplicated.
      {(csvModal.table==="Accounts"?accounts:leads).length>0&&(
        <span style={{color:"var(--t2)",marginLeft:4}}>({(csvModal.table==="Accounts"?accounts:leads).length} existing records to match against)</span>
      )}
    </div>

    {/* PRE-FLIGHT PREVIEW: how many CSV rows will actually match? Catches the "I picked
        update but everything created new" failure mode BEFORE the user clicks Upload. */}
    {(() => {
      const existing = csvModal.table === "Accounts" ? accounts : leads;
      const matchField = csvModal.matchField;
      const existingByMatch = new Map();
      for (const e of existing) {
        const key = normalizeForMatch(e.fields?.[matchField]);
        if (key && !existingByMatch.has(key)) existingByMatch.set(key, e);
      }
      // Find which CSV column maps to the matchField
      const csvCol = Object.entries(csvModal.mappings).find(([_, v]) => v === matchField)?.[0];
      const csvColIdx = csvCol ? csvModal.headers.indexOf(csvCol) : -1;
      let willUpdate = 0, willCreate = 0, willSkipBlank = 0;
      if (csvColIdx >= 0) {
        for (const row of csvModal.rows) {
          const val = normalizeForMatch(row[csvColIdx]);
          if (!val) willSkipBlank++;
          else if (existingByMatch.has(val)) willUpdate++;
          else willCreate++;
        }
      }
      const total = willUpdate + willCreate + willSkipBlank;
      const updatePct = total > 0 ? Math.round((willUpdate / total) * 100) : 0;
      const showWarning = total > 0 && willUpdate === 0;
      const showLowMatch = total > 0 && willUpdate > 0 && updatePct < 30;
      return (
        <div style={{marginTop:8,padding:8,borderRadius:4,fontSize:10,
          background: showWarning ? "rgba(239,68,68,.08)" : showLowMatch ? "rgba(191,163,90,.08)" : "rgba(93,168,122,.08)",
          border: "1px solid " + (showWarning ? "var(--red)" : showLowMatch ? "var(--amb)" : "rgba(93,168,122,.3)")}}>
          <div style={{fontWeight:600,marginBottom:4,color:showWarning?"var(--red)":showLowMatch?"var(--amb)":"var(--grn)"}}>
            🔍 Preview: {willUpdate} will be updated, {willCreate} will be created new{willSkipBlank>0?`, ${willSkipBlank} will be skipped (blank ${matchField})`:""}
          </div>
          {showWarning && (
            <div style={{color:"var(--t2)"}}>
              ⚠️ Zero matches. Possible causes: (1) {matchField} not mapped in your CSV, (2) values differ in case/whitespace, (3) your existing records have empty {matchField} field. Pick a different match field or check your data.
            </div>
          )}
          {showLowMatch && (
            <div style={{color:"var(--t2)"}}>
              ⚠️ Low match rate ({updatePct}%). If you expected most rows to update, double-check the {matchField} field on both sides.
            </div>
          )}
          {!showWarning && !showLowMatch && willUpdate > 0 && (
            <div style={{color:"var(--t3)"}}>
              ✓ Match rate looks healthy. Click Upload to apply.
            </div>
          )}
        </div>
      );
    })()}
  </div>)}

  {/* Campaign Tag */}
  <div className="ig">
    <div className="il">Campaign Tag <span style={{fontWeight:400,color:"var(--t3)",textTransform:"none"}}>— tag all imported rows</span></div>
    {(()=>{
      const allRecords = [...accounts, ...leads];
      const existingTags = [...new Set(allRecords.map(r => (r.fields || {})["Campaign Tag"]).filter(Boolean))].sort();
      return (<div style={{display:"flex",gap:8}}>
        <select className="inp" style={{flex:1}} value={csvModal.campaignTag} onChange={e=>setCsvModal(p=>({...p,campaignTag:e.target.value,newCampaignTag:""}))}>
          <option value="">— No tag —</option>
          {camp?.name && <option value={camp.name}>{camp.name} (current campaign)</option>}
          {existingTags.filter(t => t !== camp?.name).map(t => <option key={t} value={t}>{t}</option>)}
          <option value="__new__">+ Create new tag…</option>
        </select>
        {csvModal.campaignTag === "__new__" && (
          <input className="inp" style={{flex:1}} placeholder="Enter new tag name…" value={csvModal.newCampaignTag} onChange={e=>setCsvModal(p=>({...p,newCampaignTag:e.target.value}))} autoFocus/>
        )}
      </div>);
    })()}
    <div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>All rows will get a "Campaign Tag" field so you can filter leads by campaign later.</div>
  </div>

  <div style={{fontSize:11,color:"var(--t3)",marginBottom:12}}>{csvModal.rows.length} rows · Custom columns auto-created on Airtable</div>
  <div style={{display:"flex",flexDirection:"column",gap:8}}>
  {csvModal.headers.map((h,i)=>{
    const m = csvModal.mappings[h] || "__skip__";
    const std = csvModal.table === "Accounts" ? ["Name","Domain","Industry","Size","LinkedIn URL","Country"] : ["Name","Email","Title","Company","LinkedIn URL","Phone"];
    const isCustom = m !== "__skip__" && !std.includes(m);
    const isMatch = csvModal.mode==="update" && m === csvModal.matchField;
    const sample = csvModal.rows.slice(0,3).map(r=>r[i]).filter(Boolean).join(", ");
    return (<div key={h} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",border:"1px solid "+(isMatch?"var(--acc)":isCustom?"rgba(155,126,216,.3)":"var(--bdr)"),borderRadius:6,background:m==="__skip__"?"transparent":isMatch?"var(--acc-d)":"var(--card)"}}>
      <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:500,color:m==="__skip__"?"var(--t3)":"var(--t1)"}}>{h}</div><div style={{fontSize:9,color:"var(--t3)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sample||"(empty)"}</div></div>
      <span style={{fontSize:10,color:"var(--t3)"}}>→</span>
      <select className="inp" style={{width:180,padding:"5px 8px",fontSize:11}} value={m} onChange={e=>setCsvModal(p=>({...p,mappings:{...p.mappings,[h]:e.target.value}}))}>
        <option value="__skip__">⊘ Skip</option>
        <optgroup label="Standard">{std.map(f=>(<option key={f} value={f}>{f}</option>))}</optgroup>
        <optgroup label="Custom"><option value={h}>✦ Keep as "{h}"</option></optgroup>
      </select>
      {isMatch&&<span style={{fontSize:8,color:"var(--acc)",fontWeight:600}}>MATCH</span>}
      {isCustom&&!isMatch&&<span style={{fontSize:8,color:"var(--pur)",fontWeight:600}}>CUSTOM</span>}
    </div>);
  })}
  </div></div>
  <div className="modal-f"><button className="btn" onClick={()=>setCsvModal(null)}>Cancel</button><button className="btn btn-p" onClick={uploadMappedCSV} disabled={!Object.values(csvModal.mappings).some(v=>v!=="__skip__")}>
    <I.Upload/> {csvModal.mode==="update"?"Update & Import":"Import"} {csvModal.rows.length} rows
  </button></div>
  </div></div>)}

  {/* Lead Movement Scan Modal — RapidAPI Fresh LinkedIn Profile Data */}
  {(()=>{ console.log("[Movement Scan] RENDER (SignalScope JSX): showLeadMovementModal =", showLeadMovementModal); return null; })()}
  {/* Floating AI Reviews badge — always-visible notification box for AI-generated DMs */}
  {!clientMode && <ReviewNotificationBox baseId={bid} />}
  <LeadMovementScanModal
    open={showLeadMovementModal}
    onClose={()=>{
      setShowLeadMovementModal(false);
      // Refresh tasks + leads + RapidAPI usage so new movement tasks, updated
      // lead fields, AND post-scan cost all show in UI without a page reload
      (async()=>{
        try{
          const [t,l] = await Promise.all([
            at("list","Tasks",{},bid),
            at("list","Leads",{},bid),
          ]);
          setTasks((t.records||[]).sort((a,b)=>((b.fields?.Created||"")>(a.fields?.Created||"")?1:-1)));
          setLeads(l.records||[]);
          loadRapidAPIUsage();
        }catch(e){console.error("Post-scan refresh failed",e);}
      })();
    }}
    campaign={camp ? { airtableId: camp.airtableId, baseId: camp.baseId } : null}
    leads={leads}
  />
  </>);
}

// ═══════════════════════════════════════════════════════════════
// PUSH TO HUBSPOT FORM
// ═══════════════════════════════════════════════════════════════
function PushToHubSpotForm({ tasks, owners, onPush, loading, rules }) {
  const [ownerId, setOwnerId] = useState("");
  const [priority, setPriority] = useState("MEDIUM");
  const [status, setStatus] = useState("NOT_STARTED");
  const [ruleFilter, setRuleFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [mode, setMode] = useState("smart"); // smart | skip_existing | force_create

  const ruleNames = [...new Set(tasks.map(t => (t.fields || {})["Task Rule"]).filter(Boolean))];
  const filtered = tasks.filter(t => {
    const f = t.fields || {};
    if (ruleFilter !== "all" && f["Task Rule"] !== ruleFilter) return false;
    if (dateFrom && (f.Date || "") < dateFrom) return false;
    if (dateTo && (f.Date || "") > dateTo) return false;
    return true;
  });

  // Break down filtered tasks into "new" vs "already pushed"
  const withHubspotId = filtered.filter(t => (t.fields||{})["HubSpot Task ID"]).length;
  const newTasks = filtered.length - withHubspotId;

  return (<div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Filter by Task Rule</div>
        <select className="inp" value={ruleFilter} onChange={e=>setRuleFilter(e.target.value)}>
          <option value="all">All Rules ({tasks.length})</option>
          {ruleNames.map(r => <option key={r} value={r}>{r} ({tasks.filter(t=>(t.fields||{})["Task Rule"]===r).length})</option>)}
        </select>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Assign To</div>
        <select className="inp" value={ownerId} onChange={e=>setOwnerId(e.target.value)}>
          <option value="">Unassigned</option>
          {owners.map(o => <option key={o.id} value={o.id}>{o.label} ({o.email})</option>)}
        </select>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12,marginBottom:14}}>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Priority</div>
        <select className="inp" value={priority} onChange={e=>setPriority(e.target.value)}>
          <option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
        </select>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Status</div>
        <select className="inp" value={status} onChange={e=>setStatus(e.target.value)}>
          <option value="NOT_STARTED">Not Started</option><option value="IN_PROGRESS">In Progress</option><option value="WAITING">Waiting</option>
        </select>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Date From</div>
        <input type="date" className="inp" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Date To</div>
        <input type="date" className="inp" value={dateTo} onChange={e=>setDateTo(e.target.value)}/>
      </div>
    </div>

    {/* Duplicate handling mode */}
    <div className="ig" style={{marginBottom:14,padding:12,background:"var(--hover)",borderRadius:6}}>
      <div className="il" style={{marginBottom:8}}>🔄 Duplicate Handling {withHubspotId > 0 && <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)",marginLeft:6}}>· {withHubspotId} of {filtered.length} already pushed to HubSpot</span>}</div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
        {[
          { id: "smart", label: "Smart: Create new + Update existing", desc: "Recommended. Fresh Signal text on existing HubSpot tasks.", icon: "🧠" },
          { id: "skip_existing", label: "Skip already-pushed", desc: "Only create NEW tasks, ignore ones already in HubSpot.", icon: "⏭️" },
          { id: "force_create", label: "Force create duplicates", desc: "Ignore history. Create a new HubSpot task for every record.", icon: "⚠️" },
        ].map(opt => (
          <div key={opt.id} onClick={()=>setMode(opt.id)} style={{padding:10,border:"1px solid "+(mode===opt.id?"var(--acc)":"var(--bdr)"),background:mode===opt.id?"var(--acc-d)":"var(--card)",borderRadius:6,cursor:"pointer"}}>
            <div style={{fontSize:11,fontWeight:600,color:mode===opt.id?"var(--acc)":"var(--t1)",marginBottom:4}}>{opt.icon} {opt.label}</div>
            <div style={{fontSize:9,color:"var(--t3)",lineHeight:1.4}}>{opt.desc}</div>
          </div>
        ))}
      </div>
    </div>

    <div style={{display:"flex",alignItems:"center",gap:12}}>
      <button className="btn btn-p btn-s" disabled={loading || !filtered.length} onClick={() => onPush(filtered, { ownerId, priority, status, mode })}>
        {loading ? "⏳ Pushing..." : (() => {
          if (mode === "smart") {
            if (withHubspotId > 0) return `Push ${filtered.length} (${newTasks} new + ${withHubspotId} updates)`;
            return `Push ${filtered.length} Task${filtered.length!==1?"s":""} to HubSpot`;
          }
          if (mode === "skip_existing") return `Push ${newTasks} new Task${newTasks!==1?"s":""} (skip ${withHubspotId} existing)`;
          if (mode === "force_create") return `Force create ${filtered.length} new Task${filtered.length!==1?"s":""}`;
          return `Push ${filtered.length}`;
        })()}
      </button>
      <span style={{fontSize:10,color:"var(--t3)"}}>{filtered.length} of {tasks.length} tasks match filters</span>
    </div>
  </div>);
}

// ═══════════════════════════════════════════════════════════════
// LEADS TO HUBSPOT FORM
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// MANUAL OUTREACH MODAL
// ═══════════════════════════════════════════════════════════════
// GOOGLE ANALYTICS CARD (in Leads tab)
// ═══════════════════════════════════════════════════════════════
function GoogleAnalyticsCard({ baseId, campaign, onSyncComplete }) {
  const [config, setConfig] = useState({ propertyId: "", hasOAuth: false, oauthEmail: "", hasServiceAccount: false, serviceAccountEmail: "", authMode: "none", lastSync: "" });
  const [propertyDraft, setPropertyDraft] = useState("");
  const [propertyEditing, setPropertyEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [syncResult, setSyncResult] = useState(null);
  const [engagedLeads, setEngagedLeads] = useState([]);
  const [unmatchedCodes, setUnmatchedCodes] = useState([]); // GA visits to tracking URLs whose code isn't in any lead
  const [selectedEngagedIds, setSelectedEngagedIds] = useState(new Set());
  const [scoreCfg, setScoreCfg] = useState({ weights: { time: 50, engaged: 30, views: 20 }, tiers: { warmMax: 20, interestedMax: 50 } });
  const [scoreCfgDraft, setScoreCfgDraft] = useState({ weights: { time: 50, engaged: 30, views: 20 }, tiers: { warmMax: 20, interestedMax: 50 } });
  const [scoreCfgEditing, setScoreCfgEditing] = useState(false);
  const [perLeadBusy, setPerLeadBusy] = useState(null); // tracks which lead's action is in-flight
  const [connectionModal, setConnectionModal] = useState(null); // { lead, note, charCount, loading, sending, error }

  const ga = async (action, data = {}) => {
    const res = await fetch("/api/ga", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, baseId, campaignId: campaign?.airtableId, ...data }),
    });
    return res.json();
  };

  const loadConfig = async () => {
    try {
      const r = await ga("get_ga_config");
      setConfig(r);
      if (!propertyEditing) setPropertyDraft(r.propertyId || "");
    } catch (e) { console.error(e); }
  };

  // Load config on mount
  useEffect(() => {
    if (!campaign?.airtableId) return;
    loadConfig();
  }, [campaign?.airtableId]);

  // Listen for popup message (OAuth callback posts back to parent)
  useEffect(() => {
    const handler = (e) => {
      if (e.data?.type === "ga_oauth_success") {
        setMsg(`✅ Connected as ${e.data.email || "Google user"}`);
        loadConfig();
      } else if (e.data?.type === "ga_oauth_error") {
        setMsg("❌ " + (e.data.message || "OAuth failed"));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [campaign?.airtableId]);

  const loadEngaged = async () => {
    try {
      const r = await ga("list_engaged_leads", { minScore: 1 });
      if (r.ok) {
        setEngagedLeads(r.engaged || []);
        setUnmatchedCodes(r.unmatchedCodes || []);
      }
    } catch (e) { console.error(e); }
  };

  const loadScoreConfig = async () => {
    try {
      const r = await ga("get_score_config");
      if (r.ok && r.config) {
        setScoreCfg(r.config);
        setScoreCfgDraft(r.config);
      }
    } catch (e) { console.error(e); }
  };

  const saveScoreConfig = async () => {
    const sum = Number(scoreCfgDraft.weights.time) + Number(scoreCfgDraft.weights.engaged) + Number(scoreCfgDraft.weights.views);
    if (Math.abs(sum - 100) > 0.1) {
      setMsg(`❌ Weights must sum to 100. Current: ${sum.toFixed(1)}`);
      return;
    }
    setBusy(true); setMsg("⏳ Saving config and recalculating scores...");
    try {
      const save = await ga("save_score_config", { weights: scoreCfgDraft.weights, tiers: scoreCfgDraft.tiers });
      if (!save.ok) { setMsg("❌ " + (save.error || "Save failed")); setBusy(false); return; }

      // Now recalc
      const recalc = await ga("recalculate_scores");
      if (recalc.ok) {
        setScoreCfg(scoreCfgDraft);
        setScoreCfgEditing(false);
        setMsg(`✅ Config saved. Recalculated ${recalc.recalculated} lead${recalc.recalculated!==1?"s":""} (${recalc.leadsWithData} had data).`);
        await loadEngaged();
        if (onSyncComplete) onSyncComplete();
      } else {
        setMsg("⚠️ Config saved but recalc failed: " + (recalc.error || "unknown"));
      }
    } catch (e) { setMsg("❌ " + e.message); }
    setBusy(false);
  };

  const resetScoreConfig = () => {
    const defaults = { weights: { time: 50, engaged: 30, views: 20 }, tiers: { warmMax: 20, interestedMax: 50 } };
    setScoreCfgDraft(defaults);
  };

  // Load engaged leads on mount + after sync
  useEffect(() => {
    if (!campaign?.airtableId || !baseId) return;
    loadEngaged();
    loadScoreConfig();
  }, [campaign?.airtableId, baseId]);

  const isAuthed = config.hasOAuth || config.hasServiceAccount;
  const hasProperty = !!config.propertyId;
  const isReady = isAuthed && hasProperty;

  const connectGoogle = async () => {
    setBusy(true); setMsg("⏳ Opening Google sign-in...");
    try {
      const r = await ga("oauth_start");
      if (r.url) {
        const popup = window.open(r.url, "ga_oauth", "width=520,height=640");
        if (!popup || popup.closed) { setMsg("❌ Popup blocked — allow popups and retry"); setBusy(false); return; }
        setMsg("🔗 Complete sign-in in the popup window...");
        // Poll for popup close (fallback if postMessage doesn't fire)
        const interval = setInterval(() => {
          if (popup.closed) {
            clearInterval(interval);
            setTimeout(loadConfig, 500);
            setBusy(false);
          }
        }, 1000);
      } else {
        setMsg("❌ " + (r.error || "Couldn't start OAuth"));
        setBusy(false);
      }
    } catch (e) { setMsg("❌ " + e.message); setBusy(false); }
  };

  const disconnectGoogle = async () => {
    if (!confirm("Disconnect Google Analytics from this campaign?\n\nThe sign-in will be removed. Sync will stop working until you reconnect.")) return;
    setBusy(true);
    try {
      const r = await ga("oauth_disconnect");
      if (!r.ok) { setMsg("❌ " + (r.error || "Disconnect failed")); setBusy(false); return; }
      // Optimistic reset — immediately show as disconnected
      setConfig(c => ({ ...c, hasOAuth: false, oauthEmail: "", hasServiceAccount: false, serviceAccountEmail: "", authMode: "none" }));
      setSyncResult(null);
      if (r.cleared === false && r.remaining) {
        setMsg(`⚠️ Partial disconnect: some auth remained. Remaining: ${JSON.stringify(r.remaining)}. Try again or contact support.`);
      } else {
        setMsg("✅ Disconnected. Sign in again to reconnect.");
      }
      // Background refresh after 3s (Airtable propagation)
      setTimeout(() => loadConfig(), 3000);
    } catch (e) { setMsg("❌ " + e.message); }
    setBusy(false);
  };

  const saveProperty = async () => {
    if (!propertyDraft.trim()) { setMsg("❌ Property ID required"); return; }
    setBusy(true); setMsg("");
    try {
      const r = await ga("save_ga_config", { propertyId: propertyDraft.trim() });
      if (r.ok) {
        setMsg("✅ Property ID saved");
        setPropertyEditing(false);
        await loadConfig();
      } else setMsg("❌ " + (r.error || "Save failed"));
    } catch (e) { setMsg("❌ " + e.message); }
    setBusy(false);
  };

  const testConnection = async () => {
    setBusy(true); setMsg("⏳ Testing...");
    try {
      const r = await ga("test_ga_connection");
      if (r.ok) setMsg(r.message);
      else setMsg("❌ " + (r.error || "Test failed"));
    } catch (e) { setMsg("❌ " + e.message); }
    setBusy(false);
  };

  const syncNow = async () => {
    if (!confirm(`Sync GA data for last 7 days?\n\nThis fetches engagement data from your GA4 property and updates each lead's GA fields based on their Custom Code. Leads with no activity in the last 7 days will have their GA fields zeroed out.`)) return;
    setBusy(true); setMsg("⏳ Syncing GA data... this can take 10-30 seconds for large lead lists."); setSyncResult(null);
    try {
      const r = await ga("sync_ga_data");
      if (r.ok) {
        setSyncResult(r);
        if (r.updatesFailed > 0) {
          setMsg(`⚠️ Sync partially failed! ${r.updatesSucceeded||0} leads updated, ${r.updatesFailed} FAILED. First error: ${r.updateErrors?.[0] || "unknown"}`);
        } else {
          setMsg(`✅ Sync complete! ${r.activeThisWeek} lead${r.activeThisWeek!==1?"s":""} visited this week. Engaged leads (score ≥ 1) will appear below.${r.unmatchedCodes > 0 ? ` ${r.unmatchedCodes} GA codes had no matching lead.` : ""}`);
        }
        if (onSyncComplete) onSyncComplete();
        await loadConfig();
        await loadEngaged();
      } else {
        setMsg("❌ " + (r.error || "Sync failed"));
      }
    } catch (e) { setMsg("❌ " + e.message); }
    setBusy(false);
  };

  const fmtEngTime = (sec) => {
    const s = Math.round(Number(sec) || 0);
    if (s === 0) return "—";
    if (s < 60) return s + "s";
    const m = Math.floor(s / 60); const r = s % 60;
    return m + "m" + (r > 0 ? " " + r + "s" : "");
  };
  const tierFor = (score) => {
    const warmMax = scoreCfg.tiers?.warmMax || 20;
    const interestedMax = scoreCfg.tiers?.interestedMax || 50;
    if (score > interestedMax) return { label: "🔥 Hot", color: "var(--grn)" };
    if (score > warmMax) return { label: "⚡ Interested", color: "var(--amb)" };
    return { label: "👀 Warm", color: "var(--blu)" };
  };

  const toggleEngagedSelection = (id) => {
    setSelectedEngagedIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const selectAllEngaged = () => setSelectedEngagedIds(new Set(engagedLeads.map(l => l.id)));
  const clearEngagedSelection = () => setSelectedEngagedIds(new Set());

  const [convertMsg, setConvertMsg] = useState(""); // inline feedback near the button
  const convertEngagedToTasks = async () => {
    const ids = Array.from(selectedEngagedIds);
    const target = ids.length > 0 ? ids : engagedLeads.map(l => l.id);
    if (target.length === 0) { setConvertMsg("❌ No engaged leads to convert"); return; }
    setBusy(true); setConvertMsg("⏳ Creating tasks...");
    try {
      const r = await ga("convert_to_tasks", { leadIds: target, minScore: 1 });
      console.log("[convert_to_tasks] response:", r);
      if (r.ok) {
        if (r.created > 0) {
          let m = `✅ Created ${r.created} task${r.created!==1?"s":""}${r.skipped > 0 ? ` (${r.skipped} already existed)` : ""} — check the Tasks tab`;
          if (r.strippedFields?.length) m += ` · Note: Airtable rejected field${r.strippedFields.length>1?"s":""} ${r.strippedFields.join(", ")} (type mismatch) — tasks were created without ${r.strippedFields.length>1?"them":"it"}`;
          setConvertMsg(m);
        } else if (r.skipped > 0 || r.message) {
          setConvertMsg(`ℹ️ ${r.message || "All engaged leads already have tasks (skipped " + r.skipped + ")"}`);
        } else {
          setConvertMsg(`⚠️ Response was OK but no tasks created. Check console for details.`);
        }
        clearEngagedSelection();
      } else {
        setConvertMsg("❌ " + (r.error || "Convert failed — check browser console for details"));
      }
    } catch (e) {
      console.error("[convert_to_tasks] exception:", e);
      setConvertMsg("❌ " + e.message);
    }
    setBusy(false);
  };

  const openConnectionPreview = async (lead) => {
    if (!lead.linkedinUrl) { setMsg("❌ Lead has no LinkedIn URL"); return; }
    setConnectionModal({ lead, note: "", charCount: 0, loading: true, sending: false, error: "", method: null, methodError: null, signal: "", gaScore: 0, gaSessions: 0, gaViews: 0 });
    try {
      const res = await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview_connection_note",
          baseId,
          campaignId: campaign?.airtableId,
          leadId: lead.id,
        }),
      });
      const r = await res.json();
      if (r.ok) {
        setConnectionModal({
          lead,
          note: r.note || "",
          charCount: (r.note || "").length,
          loading: false,
          sending: false,
          error: "",
          signal: r.lead?.signal || "",
          method: r.method || null,
          methodError: r.error || null,
          gaScore: r.lead?.gaScore || 0,
          gaSessions: r.lead?.gaSessions || 0,
          gaViews: r.lead?.gaViews || 0,
        });
      } else {
        setConnectionModal({ lead, note: "", charCount: 0, loading: false, sending: false, error: r.error || "Couldn't generate note" });
      }
    } catch (e) {
      setConnectionModal({ lead, note: "", charCount: 0, loading: false, sending: false, error: e.message });
    }
  };

  const regenerateConnectionNote = async () => {
    if (!connectionModal?.lead) return;
    setConnectionModal(m => ({ ...m, loading: true, error: "" }));
    try {
      const res = await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview_connection_note",
          baseId,
          campaignId: campaign?.airtableId,
          leadId: connectionModal.lead.id,
        }),
      });
      const r = await res.json();
      if (r.ok) {
        setConnectionModal(m => ({
          ...m,
          note: r.note || "",
          charCount: (r.note || "").length,
          loading: false,
          error: "",
          method: r.method || null,
          methodError: r.error || null,
        }));
      } else {
        setConnectionModal(m => ({ ...m, loading: false, error: r.error || "Regenerate failed" }));
      }
    } catch (e) {
      setConnectionModal(m => ({ ...m, loading: false, error: e.message }));
    }
  };

  const sendConnectionNow = async () => {
    if (!connectionModal?.lead || !connectionModal.note.trim()) return;
    setConnectionModal(m => ({ ...m, sending: true, error: "" }));
    try {
      const res = await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "send_connection_with_note",
          baseId,
          campaignId: campaign?.airtableId,
          leadId: connectionModal.lead.id,
          note: connectionModal.note,
          signal: connectionModal.signal || "",
          campaignName: campaign?.name || "",
        }),
      });
      const r = await res.json();
      if (r.ok && r.sent > 0) {
        setMsg(`✅ Connection request sent to ${connectionModal.lead.name}!`);
        setConnectionModal(null);
        await loadEngaged();
      } else {
        setConnectionModal(m => ({ ...m, sending: false, error: r.error || "Send failed" }));
      }
    } catch (e) {
      setConnectionModal(m => ({ ...m, sending: false, error: e.message }));
    }
  };

  const sendConnectionForLead = (lead) => openConnectionPreview(lead);

  const sendEmailForLead = (lead) => {
    // Navigate to Email Campaign tab with this lead pre-selected
    // The tab will pick up the hash/state and focus this lead
    if (!lead.email) { setMsg("❌ No email address on this lead"); return; }
    setMsg(`📧 Opening Email Campaign with ${lead.name}...`);
    // Use window.location hash as a lightweight cross-component signal
    window.location.hash = `email-lead-${lead.id}`;
    // Fire a custom event the parent can listen for
    window.dispatchEvent(new CustomEvent("signalscope:open_email_for_lead", { detail: { leadId: lead.id, leadName: lead.name } }));
  };

  const exportEngagedCSV = () => {
    if (engagedLeads.length === 0 && unmatchedCodes.length === 0) return;
    const escape = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    // Single CSV with a "Source" column that distinguishes matched-lead rows from
    // unknown-code rows. Matched rows have lead identity (name, email, etc); unknown
    // rows have just the Custom Code + GA Campaign + metrics. This way the user gets
    // ALL engagement data in one file — they asked specifically not to skip unmatched.
    const header = ["Source","Name","Title","Company","Email","LinkedIn URL","Custom Code","GA Campaign","Score","Last Visit","Sessions","Engaged Sessions","Views","Views Per Session","Engagement Time (sec)","Avg Session Duration (sec)"].join(",");
    const matchedRows = engagedLeads.map(l => [
      "matched_lead",
      escape(l.name),
      escape(l.title),
      escape(l.company),
      escape(l.email),
      escape(l.linkedinUrl),
      escape(l.customCode),
      escape(l.campaignName), // utm_campaign attribution from GA
      l.score,
      escape(l.lastVisit),
      l.sessions,
      l.engagedSessions,
      l.views,
      l.viewsPerSession,
      l.engagementTime,
      l.avgSessionDuration,
    ].join(","));
    const unmatchedRows = unmatchedCodes.map(u => [
      "unknown_code",
      "", "", "", "", "", // no lead identity for these
      escape(u.code),
      escape(u.campaignName),
      u.score,
      escape(u.lastVisit),
      u.sessions,
      u.engagedSessions,
      u.views,
      u.viewsPerSession,
      u.engagementTime,
      u.avgSessionDuration,
    ].join(","));
    const csv = [header, ...matchedRows, ...unmatchedRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${campaign?.name || "campaign"}-engagement-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const lastSyncStr = config.lastSync
    ? `Last synced ${Math.round((Date.now() - new Date(config.lastSync).getTime()) / 60000)} min ago`
    : "Never synced";

  return (
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>

      {/* STATUS HEADER */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16,paddingBottom:16,borderBottom:"1px solid var(--bdr)"}}>
        <div>
          <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:4}}>
            {isReady ? "✅ Ready to sync" : !isAuthed ? "🔗 Sign in to connect Google Analytics" : "⚠️ Property ID needed"}
          </div>
          <div style={{fontSize:11,color:"var(--t3)"}}>
            {isReady ? `Signed in as ${config.oauthEmail || config.serviceAccountEmail} · Property ${config.propertyId} · ${lastSyncStr}` :
             !isAuthed ? "Connect your Google account to pull website engagement data for leads" :
             `Signed in as ${config.oauthEmail || config.serviceAccountEmail} — now enter the GA4 Property ID`}
          </div>
        </div>
        {isReady && (
          <button className="btn btn-p btn-s" disabled={busy} onClick={syncNow}>{busy?"⏳":"🔄 Sync Now"}</button>
        )}
      </div>

      {/* STEP 1: CONNECT GOOGLE (if not authed) */}
      {!isAuthed && (
        <div>
          <div style={{padding:14,background:"var(--hover)",borderRadius:8,marginBottom:14,fontSize:11,color:"var(--t2)",lineHeight:1.6}}>
            <div style={{fontWeight:600,marginBottom:8,color:"var(--t1)",fontSize:12}}>How this works:</div>
            <div>1. Click "Sign in with Google" below</div>
            <div>2. Sign in with the Google account that has access to the GA4 property</div>
            <div>3. Grant read-only Analytics permission</div>
            <div>4. Enter the GA4 Property ID (numeric, from GA Admin → Property Settings)</div>
            <div>5. Click Sync — SignalScope pulls last 7 days of engagement data per lead</div>
          </div>
          <button className="btn btn-p" disabled={busy} onClick={connectGoogle} style={{display:"flex",alignItems:"center",gap:10,padding:"12px 20px"}}>
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.1 18.9 12 24 12c3.1 0 5.8 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 10-2 13.6-5.2l-6.3-5.3c-2 1.6-4.6 2.5-7.3 2.5-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.3-2.3 4.3-4.1 5.7l6.3 5.3c-.4.4 6.8-5 6.8-15 0-1.3-.1-2.6-.4-3.9z"/></svg>
            {busy ? "⏳ Opening..." : "Sign in with Google"}
          </button>
        </div>
      )}

      {/* STEP 2: PROPERTY ID (if authed but no property) */}
      {isAuthed && (
        <div>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto auto",gap:10,alignItems:"end",marginBottom:12}}>
            <div className="ig" style={{marginBottom:0}}>
              <div className="il">GA4 Property ID</div>
              {hasProperty && !propertyEditing ? (
                <div style={{padding:"8px 12px",background:"var(--hover)",borderRadius:6,fontSize:12,fontFamily:"'JetBrains Mono',monospace",color:"var(--t1)"}}>{config.propertyId}</div>
              ) : (
                <input className="inp" value={propertyDraft} onChange={e=>setPropertyDraft(e.target.value)} placeholder="e.g. 321456789"/>
              )}
            </div>
            {hasProperty && !propertyEditing ? (
              <button className="btn btn-s" onClick={()=>setPropertyEditing(true)}>✏️ Edit</button>
            ) : (
              <button className="btn btn-p btn-s" disabled={busy} onClick={saveProperty}>{busy?"⏳":"💾 Save"}</button>
            )}
            {propertyEditing && hasProperty && <button className="btn btn-s" onClick={()=>{setPropertyEditing(false);setPropertyDraft(config.propertyId);}}>Cancel</button>}
          </div>
          <div style={{fontSize:10,color:"var(--t3)",marginBottom:14,fontStyle:"italic"}}>Find this in Google Analytics → Admin → Property Settings. Numeric ID, like 321456789.</div>

          {/* ACTIONS */}
          <div style={{display:"flex",gap:8,flexWrap:"wrap",paddingTop:12,borderTop:"1px solid var(--bdr)"}}>
            {isReady && <button className="btn btn-s" disabled={busy} onClick={testConnection}>🧪 Test Connection</button>}
            <button className="btn btn-s btn-d" disabled={busy} onClick={disconnectGoogle}>🔌 Disconnect Google</button>
          </div>

          {/* LAST SYNC RESULT */}
          {syncResult && syncResult.ok && (
            <div style={{marginTop:14,padding:12,background:"var(--hover)",borderRadius:6}}>
              <div style={{fontSize:10,color:"var(--t3)",fontWeight:600,marginBottom:6}}>LAST SYNC RESULT</div>
              <div style={{fontSize:11,color:"var(--t1)",lineHeight:1.6}}>
                {syncResult.totalLeads} total leads · {syncResult.leadsTracked} have Custom Codes · <span style={{color:"var(--grn)",fontWeight:600}}>{syncResult.activeThisWeek} visited this week</span> <span style={{color:"var(--t3)"}}>(engaged leads with score ≥ 1 shown below)</span>
                {syncResult.unmatchedCodes > 0 && <> · <span style={{color:"var(--amb)"}}>{syncResult.unmatchedCodes} GA codes don't match any lead</span></>}
              </div>
            </div>
          )}

          {/* ENGAGED LEADS LIST */}
          {engagedLeads.length > 0 && (
            <div style={{marginTop:18}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>🎯 {engagedLeads.length} engaged lead{engagedLeads.length!==1?"s":""} this week</div>
                  <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>{selectedEngagedIds.size > 0 ? `${selectedEngagedIds.size} selected` : "Select individual leads or convert all to tasks"}</div>
                </div>
                <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                  {selectedEngagedIds.size > 0 ? (
                    <button className="btn btn-s" onClick={clearEngagedSelection}>Clear</button>
                  ) : (
                    <button className="btn btn-s" onClick={selectAllEngaged}>Select all</button>
                  )}
                  <button className="btn btn-s" onClick={exportEngagedCSV}>📥 Export CSV</button>
                  <button className="btn btn-p btn-s" disabled={busy} onClick={convertEngagedToTasks}>{busy?"⏳":`✨ Convert ${selectedEngagedIds.size > 0 ? selectedEngagedIds.size : "all"} to tasks`}</button>
                </div>
              </div>

              {/* Inline feedback for convert action — rendered right next to the button so it's always visible */}
              {convertMsg && (
                <div style={{
                  padding:"10px 12px",marginBottom:10,borderRadius:6,fontSize:11,lineHeight:1.5,
                  background:convertMsg.startsWith("✅")?"var(--grn-d)":convertMsg.startsWith("⏳")?"var(--hover)":convertMsg.startsWith("ℹ")?"var(--hover)":"var(--red-d)",
                  color:convertMsg.startsWith("✅")?"var(--grn)":convertMsg.startsWith("⏳")?"var(--t2)":convertMsg.startsWith("ℹ")?"var(--t2)":"var(--red)",
                }}>{convertMsg}</div>
              )}

              <div style={{border:"1px solid var(--bdr)",borderRadius:8,overflow:"hidden"}}>
                {engagedLeads.map((l, idx) => {
                  const tier = tierFor(l.score);
                  const selected = selectedEngagedIds.has(l.id);
                  const thisBusy = perLeadBusy === l.id;
                  // Outreach status styling
                  const statusLabel = l.outreachStatus ? (
                    l.outreachStatus === "queued" ? { text: "⏱ Queued", color: "var(--amb)" } :
                    l.outreachStatus === "connection_sent" ? { text: "✉ Connection sent", color: "var(--blu)" } :
                    l.outreachStatus === "connected" ? { text: "✅ Connected", color: "var(--grn)" } :
                    l.outreachStatus === "replied" ? { text: "💬 Replied", color: "var(--grn)" } :
                    l.outreachStatus === "completed" ? { text: "✓ Completed", color: "var(--t3)" } :
                    l.outreachStatus === "error" ? { text: "⚠ Error", color: "var(--red)" } :
                    { text: l.outreachStatus, color: "var(--t3)" }
                  ) : null;
                  return (
                    <div key={l.id} style={{
                      padding:"12px 14px",
                      background:selected?"var(--hover)":(idx%2===0?"transparent":"rgba(255,255,255,0.015)"),
                      borderBottom:idx<engagedLeads.length-1?"1px solid var(--bdr)":"none",
                      transition:"background 0.1s",
                    }}>
                      {/* Main row */}
                      <div onClick={()=>toggleEngagedSelection(l.id)} style={{display:"grid",gridTemplateColumns:"auto 1fr auto auto auto",gap:14,alignItems:"center",cursor:"pointer"}}>
                        <input type="checkbox" checked={selected} onChange={()=>toggleEngagedSelection(l.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"var(--acc)"}}/>
                        <div style={{minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:600,color:"var(--t1)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{l.name || "Unknown"}</div>
                          <div style={{fontSize:10,color:"var(--t3)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                            {l.title ? l.title : ""}{l.title && l.company ? " · " : ""}{l.company || ""}
                          </div>
                          {l.campaignName && (
                            <div style={{fontSize:9,color:"var(--blu)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`utm_campaign attribution from GA: ${l.campaignName}`}>
                              📣 {l.campaignName}
                            </div>
                          )}
                        </div>
                        <div style={{textAlign:"right",fontSize:10,color:"var(--t3)",minWidth:180}}>
                          <div style={{color:"var(--t2)"}}>{l.sessions} session{l.sessions!==1?"s":""} · {l.views} view{l.views!==1?"s":""}</div>
                          <div>{fmtEngTime(l.engagementTime)} · last visit {l.lastVisit || "—"}</div>
                        </div>
                        <div style={{fontSize:10,fontWeight:600,color:tier.color,minWidth:90,textAlign:"center"}}>{tier.label}</div>
                        <div style={{fontSize:20,fontWeight:700,color:tier.color,minWidth:36,textAlign:"right"}}>{l.score}</div>
                      </div>

                      {/* Action buttons row */}
                      <div style={{display:"flex",gap:6,alignItems:"center",marginTop:10,paddingTop:10,borderTop:"1px solid var(--bdr)",flexWrap:"wrap"}}>
                        {l.canSendConnection && l.linkedinUrl ? (
                          <button className="btn btn-s" disabled={thisBusy} onClick={e=>{e.stopPropagation();sendConnectionForLead(l);}} style={{fontSize:10}}>
                            {thisBusy ? "⏳ Sending..." : "🔗 Send Connection"}
                          </button>
                        ) : statusLabel ? (
                          <div style={{fontSize:10,color:statusLabel.color,fontWeight:600,padding:"4px 10px",background:"var(--hover)",borderRadius:4}}>{statusLabel.text}</div>
                        ) : !l.linkedinUrl ? (
                          <div style={{fontSize:10,color:"var(--t3)",fontStyle:"italic"}}>No LinkedIn URL</div>
                        ) : null}

                        {l.canSendEmail && (
                          <button className="btn btn-s" disabled={thisBusy} onClick={e=>{e.stopPropagation();sendEmailForLead(l);}} style={{fontSize:10}}>
                            📧 Send Email
                          </button>
                        )}
                        {!l.canSendEmail && l.canSendConnection && (
                          <div style={{fontSize:10,color:"var(--t3)",fontStyle:"italic"}}>No email on file</div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* UNMATCHED CODES — GA visits to tracking URLs whose Custom Code isn't
              in any lead. These are real engagement signals that don't have a
              lead identity attached. Could be: shared tracking links, leads not
              yet imported, typos. Surfaced so user doesn't lose visibility. */}
          {unmatchedCodes.length > 0 && (
            <div style={{marginTop:24}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div>
                  <div style={{fontSize:12,fontWeight:600,color:"var(--amb)"}}>❓ Unknown Custom Codes ({unmatchedCodes.length})</div>
                  <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>GA tracked these codes but they don't match any lead in Airtable. Could be shared links, leads not imported yet, or typos.</div>
                </div>
                {/* Show export button here too if no engaged leads (so the export button isn't only on the engaged list) */}
                {engagedLeads.length === 0 && (
                  <button className="btn btn-s" onClick={exportEngagedCSV}>📥 Export CSV</button>
                )}
              </div>
              <div style={{border:"1px solid rgba(245,158,11,.3)",borderRadius:8,overflow:"hidden",background:"rgba(245,158,11,.03)"}}>
                {unmatchedCodes.map((u, idx) => {
                  const tier = tierFor(u.score);
                  return (
                    <div key={u.code} style={{
                      padding:"12px 14px",
                      background: idx%2===0?"transparent":"rgba(255,255,255,0.015)",
                      borderBottom:idx<unmatchedCodes.length-1?"1px solid rgba(245,158,11,.2)":"none",
                    }}>
                      <div style={{display:"grid",gridTemplateColumns:"1fr auto auto auto",gap:14,alignItems:"center"}}>
                        <div style={{minWidth:0}}>
                          <div style={{fontSize:12,fontWeight:600,color:"var(--t1)",fontFamily:"'JetBrains Mono',monospace"}}>{u.code}</div>
                          <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>No matching lead in Airtable</div>
                          {u.campaignName && (
                            <div style={{fontSize:9,color:"var(--blu)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={`utm_campaign attribution from GA: ${u.campaignName}`}>
                              📣 {u.campaignName}
                            </div>
                          )}
                        </div>
                        <div style={{textAlign:"right",fontSize:10,color:"var(--t3)",minWidth:180}}>
                          <div style={{color:"var(--t2)"}}>{u.sessions} session{u.sessions!==1?"s":""} · {u.views} view{u.views!==1?"s":""}</div>
                          <div>{fmtEngTime(u.engagementTime)} · last visit {u.lastVisit || "—"}</div>
                        </div>
                        <div style={{fontSize:10,fontWeight:600,color:tier.color,minWidth:90,textAlign:"center"}}>{tier.label}</div>
                        <div style={{fontSize:20,fontWeight:700,color:tier.color,minWidth:36,textAlign:"right"}}>{u.score}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {engagedLeads.length === 0 && unmatchedCodes.length === 0 && config.lastSync && (
            <div style={{marginTop:18,padding:24,background:"var(--hover)",borderRadius:8,textAlign:"center"}}>
              <div style={{fontSize:24,marginBottom:6}}>🌱</div>
              <div style={{fontSize:12,color:"var(--t2)",fontWeight:500}}>No engaged leads this week yet</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>When leads visit the website via your tracked links, they'll appear here with engagement scores.</div>
            </div>
          )}

          {/* SCORING CONFIG — editable weights + tiers */}
          <div style={{marginTop:14,padding:14,background:"var(--card)",border:"1px dashed var(--bdr)",borderRadius:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
              <div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>📊 Engagement Score Formula (0–100)</div>
              {!scoreCfgEditing ? (
                <button className="btn btn-s" onClick={()=>{setScoreCfgDraft(scoreCfg);setScoreCfgEditing(true);}}>✏️ Edit</button>
              ) : (
                <div style={{display:"flex",gap:6}}>
                  <button className="btn btn-s" onClick={resetScoreConfig}>🔄 Defaults</button>
                  <button className="btn btn-s" onClick={()=>{setScoreCfgEditing(false);setScoreCfgDraft(scoreCfg);setMsg("");}}>Cancel</button>
                  <button className="btn btn-p btn-s" disabled={busy} onClick={saveScoreConfig}>{busy?"⏳":`💾 Save & Recalculate`}</button>
                </div>
              )}
            </div>

            {/* Weights */}
            <div style={{fontSize:10,color:"var(--t3)",marginBottom:8}}>Weight (must sum to 100):</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"8px 10px",alignItems:"center",fontSize:11,marginBottom:10}}>
              <div style={{color:"var(--t2)"}}>⏱️ Engagement Time</div>
              {scoreCfgEditing ? (
                <input type="number" min={0} max={100} value={scoreCfgDraft.weights.time} onChange={e=>setScoreCfgDraft(d=>({...d,weights:{...d.weights,time:Number(e.target.value)}}))} style={{width:60,padding:"4px 6px",background:"var(--hover)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)",fontSize:11,textAlign:"right"}}/>
              ) : (
                <div style={{fontWeight:600,color:"var(--t1)",textAlign:"right",minWidth:40}}>{scoreCfg.weights.time}%</div>
              )}
              <div style={{color:"var(--t2)"}}>🎯 Engaged Sessions</div>
              {scoreCfgEditing ? (
                <input type="number" min={0} max={100} value={scoreCfgDraft.weights.engaged} onChange={e=>setScoreCfgDraft(d=>({...d,weights:{...d.weights,engaged:Number(e.target.value)}}))} style={{width:60,padding:"4px 6px",background:"var(--hover)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)",fontSize:11,textAlign:"right"}}/>
              ) : (
                <div style={{fontWeight:600,color:"var(--t1)",textAlign:"right",minWidth:40}}>{scoreCfg.weights.engaged}%</div>
              )}
              <div style={{color:"var(--t2)"}}>📄 Views per Session</div>
              {scoreCfgEditing ? (
                <input type="number" min={0} max={100} value={scoreCfgDraft.weights.views} onChange={e=>setScoreCfgDraft(d=>({...d,weights:{...d.weights,views:Number(e.target.value)}}))} style={{width:60,padding:"4px 6px",background:"var(--hover)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)",fontSize:11,textAlign:"right"}}/>
              ) : (
                <div style={{fontWeight:600,color:"var(--t1)",textAlign:"right",minWidth:40}}>{scoreCfg.weights.views}%</div>
              )}
              {scoreCfgEditing && (() => {
                const sum = Number(scoreCfgDraft.weights.time) + Number(scoreCfgDraft.weights.engaged) + Number(scoreCfgDraft.weights.views);
                const ok = Math.abs(sum - 100) < 0.1;
                return (<>
                  <div style={{fontSize:10,color:"var(--t3)",fontStyle:"italic",paddingTop:4,borderTop:"1px solid var(--bdr)"}}>Total</div>
                  <div style={{fontWeight:700,textAlign:"right",color:ok?"var(--grn)":"var(--red)",fontSize:11,paddingTop:4,borderTop:"1px solid var(--bdr)"}}>{sum.toFixed(0)}% {ok?"✓":"✗"}</div>
                </>);
              })()}
            </div>

            {/* Tier Boundaries */}
            <div style={{fontSize:10,color:"var(--t3)",marginBottom:8,marginTop:14,paddingTop:10,borderTop:"1px solid var(--bdr)"}}>Score tier boundaries:</div>
            <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",fontSize:11}}>
              <span style={{color:"var(--blu)",fontWeight:600}}>👀 Warm:</span>
              <span style={{color:"var(--t2)"}}>1 –</span>
              {scoreCfgEditing ? (
                <input type="number" min={1} max={99} value={scoreCfgDraft.tiers.warmMax} onChange={e=>setScoreCfgDraft(d=>({...d,tiers:{...d.tiers,warmMax:Number(e.target.value)}}))} style={{width:50,padding:"3px 6px",background:"var(--hover)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)",fontSize:11,textAlign:"center"}}/>
              ) : (
                <span style={{color:"var(--t1)",fontWeight:600}}>{scoreCfg.tiers.warmMax}</span>
              )}
              <span style={{color:"var(--t3)",margin:"0 4px"}}>·</span>
              <span style={{color:"var(--amb)",fontWeight:600}}>⚡ Interested:</span>
              <span style={{color:"var(--t2)"}}>{scoreCfgEditing ? Number(scoreCfgDraft.tiers.warmMax) + 1 : scoreCfg.tiers.warmMax + 1} –</span>
              {scoreCfgEditing ? (
                <input type="number" min={2} max={100} value={scoreCfgDraft.tiers.interestedMax} onChange={e=>setScoreCfgDraft(d=>({...d,tiers:{...d.tiers,interestedMax:Number(e.target.value)}}))} style={{width:50,padding:"3px 6px",background:"var(--hover)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)",fontSize:11,textAlign:"center"}}/>
              ) : (
                <span style={{color:"var(--t1)",fontWeight:600}}>{scoreCfg.tiers.interestedMax}</span>
              )}
              <span style={{color:"var(--t3)",margin:"0 4px"}}>·</span>
              <span style={{color:"var(--grn)",fontWeight:600}}>🔥 Hot Lead:</span>
              <span style={{color:"var(--t1)",fontWeight:600}}>{(scoreCfgEditing ? Number(scoreCfgDraft.tiers.interestedMax) : scoreCfg.tiers.interestedMax) + 1}+</span>
            </div>

            {scoreCfgEditing && (
              <div style={{marginTop:10,padding:8,background:"var(--hover)",borderRadius:4,fontSize:10,color:"var(--t3)",lineHeight:1.5}}>
                💡 Saving will recalculate scores for all leads that have GA data using the new formula. No GA API calls needed — just math on stored data. Takes a few seconds.
              </div>
            )}
          </div>
        </div>
      )}

      {/* CONNECTION PREVIEW MODAL */}
      {connectionModal && (
        <div onClick={e=>{if(e.target===e.currentTarget)setConnectionModal(null);}} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,padding:24,width:"100%",maxWidth:560,maxHeight:"90vh",overflow:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div>
                <div style={{fontSize:15,fontWeight:600,color:"var(--t1)"}}>🔗 Send Connection Request</div>
                <div style={{fontSize:11,color:"var(--t3)",marginTop:4}}>To <strong style={{color:"var(--t1)"}}>{connectionModal.lead.name}</strong>{connectionModal.lead.title ? ` · ${connectionModal.lead.title}` : ""}{connectionModal.lead.company ? ` @ ${connectionModal.lead.company}` : ""}</div>
              </div>
              <button onClick={()=>setConnectionModal(null)} style={{background:"transparent",border:"none",color:"var(--t3)",cursor:"pointer",fontSize:20,padding:0,lineHeight:1}}>×</button>
            </div>

            {/* Engagement context */}
            {connectionModal.signal && (
              <div style={{padding:10,background:"var(--hover)",borderRadius:6,fontSize:10,color:"var(--t2)",marginBottom:14,lineHeight:1.5}}>
                <div style={{fontSize:9,color:"var(--t3)",fontWeight:600,marginBottom:3}}>ENGAGEMENT CONTEXT</div>
                {connectionModal.signal}
                {(connectionModal.gaSessions > 0 || connectionModal.gaViews > 0) && (
                  <div style={{marginTop:6,fontSize:9,color:"var(--t3)",display:"flex",gap:10}}>
                    {connectionModal.gaScore > 0 && <span>Score: <strong style={{color:connectionModal.gaScore>=51?"var(--red)":connectionModal.gaScore>=21?"var(--amb)":"var(--t2)"}}>{connectionModal.gaScore}/100</strong></span>}
                    {connectionModal.gaSessions > 0 && <span>Sessions: <strong style={{color:"var(--t1)"}}>{connectionModal.gaSessions}</strong></span>}
                    {connectionModal.gaViews > 0 && <span>Views: <strong style={{color:"var(--t1)"}}>{connectionModal.gaViews}</strong></span>}
                  </div>
                )}
              </div>
            )}

            {/* Method indicator — visible diagnostic so you can see if AI ran or fell back */}
            {connectionModal.method && !connectionModal.loading && (() => {
              const m = connectionModal.method;
              const meta = {
                "ai_with_ga": { color: "var(--grn)", bg: "var(--grn-d)", label: "🤖 AI-personalized using GA data", desc: "Note generated from scratch using engagement metrics" },
                "ai_no_ga": { color: "var(--blu)", bg: "rgba(96,165,250,.1)", label: "🤖 AI-personalized (no GA data)", desc: "Generic personalization — no website engagement data found for this lead" },
                "deterministic_no_key": { color: "var(--red)", bg: "var(--red-d)", label: "⚠️ AI disabled — OPENAI_API_KEY missing", desc: "Set OPENAI_API_KEY in Vercel env to enable AI personalization" },
                "deterministic_empty_ai": { color: "var(--amb)", bg: "rgba(245,158,11,.1)", label: "⚠️ AI returned empty — using template fallback", desc: "OpenAI API call succeeded but returned no content" },
                "deterministic_validation_failed": { color: "var(--amb)", bg: "rgba(245,158,11,.1)", label: "⚠️ AI output had unresolved {fields} — using template", desc: "AI didn't fill all merge fields, fell back to deterministic merge" },
                "deterministic_too_long": { color: "var(--amb)", bg: "rgba(245,158,11,.1)", label: "⚠️ AI output > 295 chars — using template", desc: "Generated note exceeded LinkedIn's 300-char cap, fell back" },
                "deterministic_error": { color: "var(--red)", bg: "var(--red-d)", label: "❌ AI call failed — using template", desc: connectionModal.methodError || "OpenAI API call threw an exception" },
              }[m] || { color: "var(--t3)", bg: "var(--hover)", label: `Method: ${m}`, desc: "" };
              return (
                <div style={{padding:"6px 10px",background:meta.bg,color:meta.color,borderRadius:4,fontSize:10,marginBottom:10,display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontWeight:600}}>{meta.label}</span>
                  {meta.desc && <span style={{opacity:.75,fontSize:9}}>· {meta.desc}</span>}
                </div>
              );
            })()}

            {/* Note editor */}
            <div className="ig">
              <div className="il" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>Connection Note</span>
                <span style={{fontWeight:400,textTransform:"none",fontSize:10,color:connectionModal.charCount > 300 ? "var(--red)" : "var(--t3)"}}>{connectionModal.charCount} / 300 chars</span>
              </div>
              {connectionModal.loading ? (
                <div style={{padding:"24px 16px",background:"var(--hover)",borderRadius:6,textAlign:"center",color:"var(--t3)",fontSize:11}}>⏳ Generating personalized note...</div>
              ) : (
                <textarea
                  className="inp"
                  value={connectionModal.note}
                  onChange={e=>{
                    const newNote = e.target.value;
                    setConnectionModal(m=>({...m,note:newNote,charCount:newNote.length}));
                  }}
                  style={{minHeight:120,fontSize:12,lineHeight:1.5}}
                  placeholder="Enter your connection note..."
                />
              )}
            </div>

            <div style={{fontSize:10,color:"var(--t3)",marginBottom:14,fontStyle:"italic"}}>
              💡 LinkedIn limits connection notes to 300 characters. Keep it personal and short — referencing their engagement usually helps.
            </div>

            {/* Error */}
            {connectionModal.error && (
              <div style={{padding:10,background:"var(--red-d)",color:"var(--red)",borderRadius:6,fontSize:11,marginBottom:14,whiteSpace:"pre-wrap"}}>❌ {connectionModal.error}</div>
            )}

            {/* Actions */}
            <div style={{display:"flex",gap:8,justifyContent:"flex-end"}}>
              <button className="btn btn-s" onClick={()=>setConnectionModal(null)} disabled={connectionModal.sending}>Cancel</button>
              <button className="btn btn-s" onClick={regenerateConnectionNote} disabled={connectionModal.loading || connectionModal.sending}>✨ Regenerate</button>
              <button className="btn btn-p btn-s" onClick={sendConnectionNow} disabled={connectionModal.loading || connectionModal.sending || !connectionModal.note.trim() || connectionModal.charCount > 300}>
                {connectionModal.sending ? "⏳ Sending..." : "🚀 Send Connection Request"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STATUS MESSAGE */}
      {msg && <div style={{marginTop:14,padding:10,background:msg.startsWith("✅")?"var(--grn-d)":msg.startsWith("⏳")||msg.startsWith("🔗")?"var(--hover)":"var(--red-d)",color:msg.startsWith("✅")?"var(--grn)":msg.startsWith("⏳")||msg.startsWith("🔗")?"var(--t2)":"var(--red)",borderRadius:6,fontSize:11,whiteSpace:"pre-wrap"}}>{msg}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// LINKEDIN POSTS TAB — Fetch + Score + Create tasks from lead posts
// ═══════════════════════════════════════════════════════════════
function LinkedInPostsTab({ baseId, campaign, leads, onCampaignProvisioned }) {
  const [selectedLeadIds, setSelectedLeadIds] = useState(new Set());
  const [selectedCompanies, setSelectedCompanies] = useState(new Set());
  const [selectedCampaignTags, setSelectedCampaignTags] = useState(new Set());
  const [selectMode, setSelectMode] = useState("all"); // "all" | "specific" | "by_company" | "by_campaign_tag"
  const [scoreThreshold, setScoreThreshold] = useState(70);
  const [daysBack, setDaysBack] = useState(7);
  const [taskRuleName, setTaskRuleName] = useState("LinkedIn Post Engagement");
  const [systemPromptOverride, setSystemPromptOverride] = useState("");
  const [showPromptEditor, setShowPromptEditor] = useState(false);
  // For the new Prompt Reference UI — fetched from backend so it always shows
  // the LIVE default prompt + sanity-check rules, not a stale duplicate.
  const [promptReference, setPromptReference] = useState(null); // {defaultPrompt, sanityRules, requiredOutputSchema, ...}
  const [promptRefLoading, setPromptRefLoading] = useState(false);
  const [promptRefView, setPromptRefView] = useState("guide"); // "guide" | "default" | "schema" | "sanity"
  // Saved prompts library — stored in the campaign's Prompts table with Task Rule="LinkedIn Posts"
  // so they're isolated from the per-task-rule scoring prompts used by news/jobs scans.
  const [savedPrompts, setSavedPrompts] = useState([]); // [{id, name, prompt, lastModified}]
  const [loadedPromptId, setLoadedPromptId] = useState(null); // id of the currently-loaded saved prompt
  const [loadedPromptOriginal, setLoadedPromptOriginal] = useState(""); // original prompt text — used to detect "modified"
  const [savePromptModal, setSavePromptModal] = useState(null); // null | {mode: "save" | "save_as", name: ""}
  const [savedPromptsLoading, setSavedPromptsLoading] = useState(false);
  const [savedPromptsError, setSavedPromptsError] = useState("");
  const [promptSaving, setPromptSaving] = useState(false); // lock to prevent double-save races
  const [searchLeads, setSearchLeads] = useState("");
  const [autoCleanup, setAutoCleanup] = useState(true);
  const [autoCleanupDays, setAutoCleanupDays] = useState(14);
  const [autoCleanupExcludePushed, setAutoCleanupExcludePushed] = useState(true);
  const [cleanupModal, setCleanupModal] = useState(null); // { days, preview, loading }
  const [progress, setProgress] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState("");
  const pollRef = useRef(null);

  // Filter leads to those with a LinkedIn URL (can't scan without it)
  const linkedinLeads = (leads || []).filter(l => (l.fields?.["LinkedIn URL"] || l.fields?.["Linkedin URL"] || "").trim());
  const visibleLeads = searchLeads
    ? linkedinLeads.filter(l => {
        const s = searchLeads.toLowerCase();
        const f = l.fields || {};
        return (f.Name || "").toLowerCase().includes(s) || (f.Company || "").toLowerCase().includes(s) || (f.Title || "").toLowerCase().includes(s);
      })
    : linkedinLeads;

  // Load existing progress on mount so user sees any in-flight scan
  useEffect(() => {
    if (!campaign?.airtableId) return;
    (async () => {
      try {
        const res = await fetch("/api/linkedin-posts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_progress", campaignAirtableId: campaign.airtableId }),
        });
        const d = await res.json();
        if (d.progress) setProgress(d.progress);
      } catch {}
    })();
  }, [campaign?.airtableId]);

  // Poll progress every 2s when scanning
  useEffect(() => {
    if (!scanning || !campaign?.airtableId) return;
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/api/linkedin-posts", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "get_progress", campaignAirtableId: campaign.airtableId }),
        });
        const d = await res.json();
        if (d.progress) setProgress(d.progress);
      } catch {}
    }, 2000);
    return () => { clearInterval(pollRef.current); pollRef.current = null; };
  }, [scanning, campaign?.airtableId]);

  // ─── Saved Prompts: load on mount ────────────────────────────────
  // Filtered by Task Rule="LinkedIn Posts" so they're isolated from per-task-rule
  // scoring prompts (which use other Task Rule values like "Material News" etc).
  // We sort by Name for stable display order.
  const loadSavedPrompts = async (autoSetupOnFailure = true) => {
    if (!baseId) return;
    setSavedPromptsLoading(true);
    setSavedPromptsError("");
    try {
      const res = await at("list", "Prompts", {
        filterByFormula: `{Task Rule}="LinkedIn Posts"`,
      }, baseId);
      const records = (res.records || []).map(r => ({
        id: r.id,
        name: (r.fields || {}).Name || "(unnamed)",
        prompt: (r.fields || {}).Prompt || "",
      })).sort((a, b) => a.name.localeCompare(b.name));
      setSavedPrompts(records);
    } catch (e) {
      console.error("Failed to load saved prompts:", e);
      // Auto-recover: if Prompts table is missing on this base, run setup ONCE to create it
      if (autoSetupOnFailure) {
        try {
          console.log("[SavedPrompts] Attempting auto-setup of base schema...");
          await at("setup", null, {}, baseId);
          // Retry list after setup, but don't loop indefinitely
          await loadSavedPrompts(false);
          return;
        } catch (setupErr) {
          console.error("Auto-setup failed:", setupErr);
        }
      }
      setSavedPromptsError("Failed to load saved prompts. The Prompts table may not exist in this base — try opening the Prompts tab in the sidebar to trigger schema setup.");
    } finally {
      setSavedPromptsLoading(false);
    }
  };

  useEffect(() => {
    if (baseId) loadSavedPrompts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId]);

  // Save current prompt as a NEW saved prompt (or overwrite if name exists)
  const handleSavePrompt = async (name) => {
    if (promptSaving) return false; // already saving — ignore
    if (!name || !name.trim()) { alert("Name is required"); return false; }
    if (!systemPromptOverride.trim()) { alert("Cannot save an empty prompt. Write or load a prompt first."); return false; }
    if (!baseId) { alert("No campaign base ID available"); return false; }
    setPromptSaving(true);
    try {
      const trimmedName = name.trim();
      const existing = savedPrompts.find(p => p.name.toLowerCase() === trimmedName.toLowerCase());
      if (existing) {
        if (!confirm(`A saved prompt named "${trimmedName}" already exists. Overwrite it?`)) return false;
        try {
          await at("update", "Prompts", { records: [{ id: existing.id, fields: { Prompt: systemPromptOverride } }] }, baseId);
          await loadSavedPrompts();
          setLoadedPromptId(existing.id);
          setLoadedPromptOriginal(systemPromptOverride);
          return true;
        } catch (e) {
          alert("Save failed: " + e.message);
          return false;
        }
      }
      // New prompt — create it
      try {
        const res = await at("create", "Prompts", {
          records: [{ fields: { Name: trimmedName, "Task Rule": "LinkedIn Posts", Prompt: systemPromptOverride } }],
        }, baseId);
        await loadSavedPrompts();
        const newId = res.records?.[0]?.id;
        if (newId) {
          setLoadedPromptId(newId);
          setLoadedPromptOriginal(systemPromptOverride);
        }
        return true;
      } catch (e) {
        alert("Save failed: " + e.message);
        return false;
      }
    } finally {
      setPromptSaving(false);
    }
  };

  // Update the currently-loaded saved prompt with the current textarea content
  const handleUpdateLoadedPrompt = async () => {
    if (promptSaving) return;
    if (!loadedPromptId) return;
    const loaded = savedPrompts.find(p => p.id === loadedPromptId);
    if (!loaded) { alert("Loaded prompt not found in saved list. It may have been deleted."); setLoadedPromptId(null); return; }
    if (!confirm(`Overwrite saved prompt "${loaded.name}" with current edits?`)) return;
    setPromptSaving(true);
    try {
      await at("update", "Prompts", { records: [{ id: loadedPromptId, fields: { Prompt: systemPromptOverride } }] }, baseId);
      await loadSavedPrompts();
      setLoadedPromptOriginal(systemPromptOverride);
    } catch (e) {
      alert("Update failed: " + e.message);
    } finally {
      setPromptSaving(false);
    }
  };

  // Load a saved prompt into the textarea
  const handleLoadPrompt = (id) => {
    const p = savedPrompts.find(s => s.id === id);
    if (!p) return;
    if (systemPromptOverride.trim() && systemPromptOverride !== loadedPromptOriginal) {
      if (!confirm("You have unsaved changes to the current prompt. Load anyway?")) return;
    }
    setSystemPromptOverride(p.prompt);
    setLoadedPromptId(id);
    setLoadedPromptOriginal(p.prompt);
  };

  // Delete a saved prompt
  const handleDeletePrompt = async (id) => {
    const p = savedPrompts.find(s => s.id === id);
    if (!p) return;
    if (!confirm(`Delete saved prompt "${p.name}"? This cannot be undone.`)) return;
    try {
      await at("delete", "Prompts", { recordIds: [id] }, baseId);
      await loadSavedPrompts();
      if (loadedPromptId === id) {
        setLoadedPromptId(null);
        setLoadedPromptOriginal("");
      }
    } catch (e) {
      alert("Delete failed: " + e.message);
    }
  };

  const toggleLead = (id) => {
    setSelectedLeadIds(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  };
  const selectAll = () => setSelectedLeadIds(new Set(visibleLeads.map(l => l.id)));
  const selectNone = () => setSelectedLeadIds(new Set());

  // Company grouping — for "by company" selection mode.
  // Material has 54 accounts with multiple leads each; scanning by account is the natural workflow.
  const leadsByCompany = linkedinLeads.reduce((acc, l) => {
    const company = (l.fields?.Company || "— no company —").trim();
    if (!acc[company]) acc[company] = [];
    acc[company].push(l);
    return acc;
  }, {});
  const companyList = Object.entries(leadsByCompany)
    .map(([company, leads]) => ({ company, count: leads.length, leadIds: leads.map(l => l.id) }))
    .sort((a, b) => a.company.localeCompare(b.company));
  const visibleCompanies = searchLeads
    ? companyList.filter(c => c.company.toLowerCase().includes(searchLeads.toLowerCase()))
    : companyList;

  const toggleCompany = (company) => {
    setSelectedCompanies(prev => {
      const n = new Set(prev);
      if (n.has(company)) n.delete(company); else n.add(company);
      return n;
    });
  };
  const selectAllCompanies = () => setSelectedCompanies(new Set(visibleCompanies.map(c => c.company)));
  const selectNoCompanies = () => setSelectedCompanies(new Set());

  const leadIdsFromSelectedCompanies = () => {
    const ids = [];
    for (const c of companyList) {
      if (selectedCompanies.has(c.company)) ids.push(...c.leadIds);
    }
    return ids;
  };

  // Campaign tag grouping — for "by campaign" selection mode.
  // Leads carry a Campaign field (single-select in Airtable) like "Veloka", "Crunchbase Campaign",
  // "SaasBhoomi + Bangalore ICP", etc. This groups leads by that tag.
  // Falls back to multiple likely field names since naming may vary by base.
  const getLeadCampaignTag = (l) => {
    const f = l.fields || {};
    const raw = f.Campaign || f["Campaign Tag"] || f["Campaign Source"] || f.Source || f.Tag;
    if (Array.isArray(raw)) return raw[0] || "— no tag —";
    return (raw && String(raw).trim()) || "— no tag —";
  };
  const leadsByCampaignTag = linkedinLeads.reduce((acc, l) => {
    const tag = getLeadCampaignTag(l);
    if (!acc[tag]) acc[tag] = [];
    acc[tag].push(l);
    return acc;
  }, {});
  const campaignTagList = Object.entries(leadsByCampaignTag)
    .map(([tag, leads]) => ({ tag, count: leads.length, leadIds: leads.map(l => l.id) }))
    .sort((a, b) => {
      // "— no tag —" always last, otherwise alphabetical
      if (a.tag === "— no tag —") return 1;
      if (b.tag === "— no tag —") return -1;
      return a.tag.localeCompare(b.tag);
    });
  const visibleCampaignTags = searchLeads
    ? campaignTagList.filter(c => c.tag.toLowerCase().includes(searchLeads.toLowerCase()))
    : campaignTagList;

  const toggleCampaignTag = (tag) => {
    setSelectedCampaignTags(prev => {
      const n = new Set(prev);
      if (n.has(tag)) n.delete(tag); else n.add(tag);
      return n;
    });
  };
  const selectAllCampaignTags = () => setSelectedCampaignTags(new Set(visibleCampaignTags.map(c => c.tag)));
  const selectNoCampaignTags = () => setSelectedCampaignTags(new Set());

  const leadIdsFromSelectedCampaignTags = () => {
    const ids = [];
    for (const c of campaignTagList) {
      if (selectedCampaignTags.has(c.tag)) ids.push(...c.leadIds);
    }
    return ids;
  };

  const startScan = async (resume = false) => {
    setErr("");
    if (!campaign) { setErr("No campaign selected"); return; }

    // Auto-provision campaign record in Airtable if it's a built-in default with no airtableId.
    // Scan progress persistence needs a Campaigns row to write into.
    let activeCampaign = campaign;
    if (!activeCampaign.airtableId) {
      setErr(""); // Clear previous err
      try {
        const res = await fetch("/api/airtable", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "create_campaign", baseId,
            fields: {
              Name: activeCampaign.name,
              "Base ID": baseId,
              Features: (activeCampaign.features || []).join(","),
              Description: activeCampaign.desc || "",
              Emoji: activeCampaign.emoji || "📊",
              Tables: activeCampaign.tables || "",
            },
          }),
        });
        const d = await res.json();
        const newId = d.records?.[0]?.id;
        if (!newId) { setErr("Couldn't provision campaign in Airtable: " + (d.error || "no record returned")); return; }
        activeCampaign = { ...activeCampaign, airtableId: newId };
        onCampaignProvisioned?.(activeCampaign);
      } catch (e) {
        setErr("Couldn't provision campaign in Airtable: " + e.message);
        return;
      }
    }

    // Resolve leadIds based on selection mode
    let leadIds = null;
    if (selectMode === "specific") {
      leadIds = Array.from(selectedLeadIds);
      if (leadIds.length === 0) { setErr("Select at least one lead or switch to 'all leads'"); return; }
    } else if (selectMode === "by_company") {
      leadIds = leadIdsFromSelectedCompanies();
      if (leadIds.length === 0) { setErr("Select at least one company or switch to 'all leads'"); return; }
    } else if (selectMode === "by_campaign_tag") {
      leadIds = leadIdsFromSelectedCampaignTags();
      if (leadIds.length === 0) { setErr("Select at least one campaign tag or switch to 'all leads'"); return; }
    }

    setScanning(true);
    try {
      const res = await fetch("/api/linkedin-posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "scan", baseId,
          campaignAirtableId: activeCampaign.airtableId,
          leadIds,
          scoreThreshold,
          daysBack,
          taskRuleName,
          systemPromptOverride: systemPromptOverride.trim() || null,
          resume,
          autoCleanupDays: !resume && autoCleanup ? autoCleanupDays : null,
          autoCleanupExcludePushed: autoCleanupExcludePushed,
        }),
      });
      const d = await res.json();
      if (!d.ok) {
        setErr(d.error || "Scan failed");
      } else if (d.progress) {
        setProgress(d.progress);
      }
    } catch (e) { setErr(e.message); }
    setScanning(false);
  };

  const openCleanupModal = async () => {
    setCleanupModal({ days: autoCleanupDays, preview: null, loading: true, excludePushed: autoCleanupExcludePushed });
    try {
      const res = await fetch("/api/linkedin-posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "list_stale_tasks", baseId,
          taskRuleName,
          olderThanDays: autoCleanupDays,
        }),
      });
      const d = await res.json();
      setCleanupModal(m => m ? { ...m, preview: d, loading: false } : null);
    } catch (e) {
      setCleanupModal(m => m ? { ...m, loading: false, error: e.message } : null);
    }
  };

  const runCleanup = async () => {
    if (!cleanupModal) return;
    setCleanupModal(m => ({ ...m, running: true }));
    try {
      const res = await fetch("/api/linkedin-posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "cleanup_old_tasks", baseId,
          taskRuleName,
          olderThanDays: cleanupModal.days,
          excludePushed: cleanupModal.excludePushed,
          confirm: true,
        }),
      });
      const d = await res.json();
      if (d.ok) {
        alert(`✅ Deleted ${d.deleted} stale task${d.deleted!==1?"s":""}.${d.failed ? ` ${d.failed} failed.` : ""}`);
        setCleanupModal(null);
      } else {
        alert("❌ " + (d.error || "Cleanup failed"));
        setCleanupModal(m => m ? { ...m, running: false } : null);
      }
    } catch (e) {
      alert("❌ " + e.message);
      setCleanupModal(m => m ? { ...m, running: false } : null);
    }
  };

  const clearProgress = async () => {
    if (!confirm("Clear the saved progress? This doesn't delete any tasks already created, just resets the status display.")) return;
    try {
      await fetch("/api/linkedin-posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear_progress", campaignAirtableId: campaign.airtableId }),
      });
      setProgress(null);
    } catch (e) { setErr(e.message); }
  };

  const stopScan = async () => {
    if (!confirm("Stop the running scan? The current lead will finish, then the scan will halt. Cron (if enabled) will also stop resuming. Tasks already created are preserved.")) return;
    try {
      const res = await fetch("/api/linkedin-posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop_scan", campaignAirtableId: campaign.airtableId }),
      });
      const d = await res.json();
      if (d.progress) setProgress(d.progress);
    } catch (e) { setErr(e.message); }
  };

  const testProfile = async (leadId) => {
    setErr("");
    try {
      const res = await fetch("/api/linkedin-posts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test_profile", baseId, leadId }),
      });
      const d = await res.json();
      if (!d.ok) { alert("❌ " + (d.error || "Test failed")); return; }
      const postsData = d.posts?.posts || [];
      alert(`✅ URN: ${d.urn}${d.cached ? " (cached)" : ""}\n\nFound ${postsData.length} post(s) in last 7 days:\n\n${postsData.slice(0, 3).map(p => "• " + (p.text || "").slice(0, 120)).join("\n\n")}`);
    } catch (e) { alert("❌ " + e.message); }
  };

  const isRunning = scanning || (progress?.status === "running");
  const isResumable = progress && progress.status === "running" && progress.leads_remaining > 0 && !scanning;

  return (
    <div>
      <div className="ph">
        <div>
          <div className="pt">📝 LinkedIn Posts Scanner</div>
          <div className="pd">Fetch recent posts from leads → AI-score for relevance → create tasks for the winners</div>
        </div>
      </div>

      {/* ── CONFIG ── */}
      <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:14}}>⚙️ Scan Configuration</div>

        {/* Lead selection mode */}
        <div className="ig">
          <div className="il">Leads to Scan</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:8,marginBottom:10}}>
            <div onClick={()=>setSelectMode("all")} style={{padding:12,border:"1px solid "+(selectMode==="all"?"var(--acc)":"var(--bdr)"),background:selectMode==="all"?"var(--acc-d)":"var(--card)",borderRadius:6,cursor:"pointer"}}>
              <div style={{fontSize:11,fontWeight:600,color:selectMode==="all"?"var(--acc)":"var(--t1)"}}>🌐 All leads</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:3}}>{linkedinLeads.length} with LinkedIn · of {(leads||[]).length} total</div>
            </div>
            <div onClick={()=>setSelectMode("by_campaign_tag")} style={{padding:12,border:"1px solid "+(selectMode==="by_campaign_tag"?"var(--acc)":"var(--bdr)"),background:selectMode==="by_campaign_tag"?"var(--acc-d)":"var(--card)",borderRadius:6,cursor:"pointer"}}>
              <div style={{fontSize:11,fontWeight:600,color:selectMode==="by_campaign_tag"?"var(--acc)":"var(--t1)"}}>🏷 By campaign tag</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:3}}>{selectedCampaignTags.size} tag{selectedCampaignTags.size!==1?"s":""} selected · {campaignTagList.length} total tags</div>
            </div>
            <div onClick={()=>setSelectMode("by_company")} style={{padding:12,border:"1px solid "+(selectMode==="by_company"?"var(--acc)":"var(--bdr)"),background:selectMode==="by_company"?"var(--acc-d)":"var(--card)",borderRadius:6,cursor:"pointer"}}>
              <div style={{fontSize:11,fontWeight:600,color:selectMode==="by_company"?"var(--acc)":"var(--t1)"}}>🏢 By company</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:3}}>{selectedCompanies.size} selected · {companyList.length} accounts</div>
            </div>
            <div onClick={()=>setSelectMode("specific")} style={{padding:12,border:"1px solid "+(selectMode==="specific"?"var(--acc)":"var(--bdr)"),background:selectMode==="specific"?"var(--acc-d)":"var(--card)",borderRadius:6,cursor:"pointer"}}>
              <div style={{fontSize:11,fontWeight:600,color:selectMode==="specific"?"var(--acc)":"var(--t1)"}}>🎯 Specific leads</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:3}}>{selectedLeadIds.size} lead{selectedLeadIds.size!==1?"s":""} selected</div>
            </div>
          </div>

          {selectMode==="by_campaign_tag" && (
            <div style={{border:"1px solid var(--bdr)",borderRadius:6,overflow:"hidden"}}>
              <div style={{padding:"8px 10px",background:"var(--hover)",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <input type="text" placeholder="Search campaign tags..." value={searchLeads} onChange={e=>setSearchLeads(e.target.value)} style={{flex:1,padding:"4px 8px",fontSize:11,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)"}}/>
                <button className="btn btn-s" onClick={selectAllCampaignTags} style={{fontSize:10}}>Select all visible</button>
                <button className="btn btn-s" onClick={selectNoCampaignTags} style={{fontSize:10}}>Clear</button>
              </div>
              <div style={{padding:"6px 10px",fontSize:10,color:"var(--t3)",borderBottom:"1px solid var(--bdr)",background:"var(--card)"}}>
                {selectedCampaignTags.size > 0 && <>Selected: {selectedCampaignTags.size} {selectedCampaignTags.size===1?"tag":"tags"} · <strong style={{color:"var(--t1)"}}>{leadIdsFromSelectedCampaignTags().length} leads</strong> will be scanned</>}
                {selectedCampaignTags.size === 0 && "Reads the Campaign field on each Lead (fallback: Campaign Tag / Campaign Source / Source / Tag). Tick one or more tags below."}
              </div>
              <div style={{maxHeight:320,overflowY:"auto"}}>
                {visibleCampaignTags.length === 0 && (
                  <div style={{padding:20,textAlign:"center",fontSize:11,color:"var(--t3)"}}>
                    No campaign tags found. Make sure your Leads table has a field called "Campaign" (or "Campaign Tag" / "Source") with values set.
                  </div>
                )}
                {visibleCampaignTags.slice(0, 200).map(c => {
                  const sel = selectedCampaignTags.has(c.tag);
                  const isNoTag = c.tag === "— no tag —";
                  return (
                    <div key={c.tag} onClick={()=>toggleCampaignTag(c.tag)} style={{padding:"8px 10px",display:"flex",alignItems:"center",gap:10,borderTop:"1px solid var(--bdr)",cursor:"pointer",background:sel?"var(--acc-d)":"transparent"}}>
                      <input type="checkbox" checked={sel} onChange={()=>{}} onClick={e=>e.stopPropagation()} style={{margin:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:11,fontWeight:500,color:isNoTag?"var(--t3)":"var(--t1)",fontStyle:isNoTag?"italic":"normal"}}>{c.tag}</div>
                        <div style={{fontSize:9,color:"var(--t3)"}}>{c.count} lead{c.count!==1?"s":""} with LinkedIn URL</div>
                      </div>
                      <span style={{fontSize:10,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{c.count}</span>
                    </div>
                  );
                })}
                {visibleCampaignTags.length > 200 && <div style={{padding:10,textAlign:"center",fontSize:10,color:"var(--t3)",borderTop:"1px solid var(--bdr)"}}>Showing first 200 of {visibleCampaignTags.length}. Use search to narrow.</div>}
              </div>
            </div>
          )}

          {selectMode==="by_company" && (
            <div style={{border:"1px solid var(--bdr)",borderRadius:6,overflow:"hidden"}}>
              <div style={{padding:"8px 10px",background:"var(--hover)",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <input type="text" placeholder="Search companies..." value={searchLeads} onChange={e=>setSearchLeads(e.target.value)} style={{flex:1,padding:"4px 8px",fontSize:11,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)"}}/>
                <button className="btn btn-s" onClick={selectAllCompanies} style={{fontSize:10}}>Select all visible</button>
                <button className="btn btn-s" onClick={selectNoCompanies} style={{fontSize:10}}>Clear</button>
              </div>
              <div style={{padding:"6px 10px",fontSize:10,color:"var(--t3)",borderBottom:"1px solid var(--bdr)",background:"var(--card)"}}>
                {selectedCompanies.size > 0 && <>Selected: {selectedCompanies.size} {selectedCompanies.size===1?"account":"accounts"} · <strong style={{color:"var(--t1)"}}>{leadIdsFromSelectedCompanies().length} leads</strong> will be scanned</>}
                {selectedCompanies.size === 0 && "Tick one or more accounts below"}
              </div>
              <div style={{maxHeight:320,overflowY:"auto"}}>
                {visibleCompanies.length === 0 && <div style={{padding:20,textAlign:"center",fontSize:11,color:"var(--t3)"}}>No companies match your search.</div>}
                {visibleCompanies.slice(0, 200).map(c => {
                  const sel = selectedCompanies.has(c.company);
                  return (
                    <div key={c.company} onClick={()=>toggleCompany(c.company)} style={{padding:"8px 10px",display:"flex",alignItems:"center",gap:10,borderTop:"1px solid var(--bdr)",cursor:"pointer",background:sel?"var(--acc-d)":"transparent"}}>
                      <input type="checkbox" checked={sel} onChange={()=>{}} onClick={e=>e.stopPropagation()} style={{margin:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:11,fontWeight:500,color:"var(--t1)"}}>{c.company}</div>
                        <div style={{fontSize:9,color:"var(--t3)"}}>{c.count} lead{c.count!==1?"s":""} with LinkedIn URL</div>
                      </div>
                      <span style={{fontSize:10,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>{c.count}</span>
                    </div>
                  );
                })}
                {visibleCompanies.length > 200 && <div style={{padding:10,textAlign:"center",fontSize:10,color:"var(--t3)",borderTop:"1px solid var(--bdr)"}}>Showing first 200 of {visibleCompanies.length}. Use search to narrow.</div>}
              </div>
            </div>
          )}

          {selectMode==="specific" && (
            <div style={{border:"1px solid var(--bdr)",borderRadius:6,overflow:"hidden"}}>
              <div style={{padding:"8px 10px",background:"var(--hover)",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                <input type="text" placeholder="Search leads by name, company, title..." value={searchLeads} onChange={e=>setSearchLeads(e.target.value)} style={{flex:1,padding:"4px 8px",fontSize:11,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:4,color:"var(--t1)"}}/>
                <button className="btn btn-s" onClick={selectAll} style={{fontSize:10}}>Select all visible</button>
                <button className="btn btn-s" onClick={selectNone} style={{fontSize:10}}>Clear</button>
              </div>
              <div style={{maxHeight:260,overflowY:"auto"}}>
                {visibleLeads.length === 0 && <div style={{padding:20,textAlign:"center",fontSize:11,color:"var(--t3)"}}>No leads match your search.</div>}
                {visibleLeads.slice(0, 200).map(l => {
                  const f = l.fields || {};
                  const sel = selectedLeadIds.has(l.id);
                  return (
                    <div key={l.id} onClick={()=>toggleLead(l.id)} style={{padding:"8px 10px",display:"flex",alignItems:"center",gap:10,borderTop:"1px solid var(--bdr)",cursor:"pointer",background:sel?"var(--acc-d)":"transparent"}}>
                      <input type="checkbox" checked={sel} onChange={()=>{}} onClick={e=>e.stopPropagation()} style={{margin:0}}/>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{fontSize:11,fontWeight:500,color:"var(--t1)"}}>{f.Name||"(no name)"}</div>
                        <div style={{fontSize:9,color:"var(--t3)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{f.Title||""} {f.Company?"@ "+f.Company:""}</div>
                      </div>
                      <button className="btn btn-s" onClick={e=>{e.stopPropagation();testProfile(l.id);}} style={{fontSize:9,padding:"2px 6px"}} title="Test fetch (no scoring, no tasks)">🧪</button>
                    </div>
                  );
                })}
                {visibleLeads.length > 200 && <div style={{padding:10,textAlign:"center",fontSize:10,color:"var(--t3)",borderTop:"1px solid var(--bdr)"}}>Showing first 200 of {visibleLeads.length}. Use search to narrow down.</div>}
              </div>
            </div>
          )}
        </div>

        {/* Config grid */}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginTop:12}}>
          <div className="ig" style={{marginBottom:0}}>
            <div className="il">Score Threshold</div>
            <input type="number" min="0" max="100" className="inp" value={scoreThreshold} onChange={e=>setScoreThreshold(parseInt(e.target.value)||70)}/>
            <div style={{fontSize:9,color:"var(--t3)",marginTop:3}}>Posts scoring below this become tasks. Default 70 (strict). Lower to 50 for more coverage, but expect more false positives.</div>
          </div>
          <div className="ig" style={{marginBottom:0}}>
            <div className="il">Days Back</div>
            <input type="number" min="1" max="30" className="inp" value={daysBack} onChange={e=>setDaysBack(parseInt(e.target.value)||7)}/>
            <div style={{fontSize:9,color:"var(--t3)",marginTop:3}}>Posts older than this are filtered out. Default 7.</div>
          </div>
          <div className="ig" style={{marginBottom:0}}>
            <div className="il">Task Rule Name</div>
            <input type="text" className="inp" value={taskRuleName} onChange={e=>setTaskRuleName(e.target.value)}/>
            <div style={{fontSize:9,color:"var(--t3)",marginTop:3}}>Appears in the Task Rule column of Tasks tab.</div>
          </div>
        </div>

        {/* Prompt editor (collapsible) — fully interactive prompt reference */}
        <div style={{marginTop:14,padding:12,background:"var(--hover)",borderRadius:6}}>
          <div onClick={()=>{
            setShowPromptEditor(!showPromptEditor);
            // Lazy-load the prompt reference the first time the section opens
            if (!showPromptEditor && !promptReference && !promptRefLoading) {
              setPromptRefLoading(true);
              fetch("/api/linkedin-posts", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({action:"get_default_prompt"})})
                .then(r=>r.json()).then(d=>{ if(d.ok) setPromptReference(d); setPromptRefLoading(false); })
                .catch(()=>setPromptRefLoading(false));
            }
          }} style={{cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>🧠 Custom Scoring Prompt {systemPromptOverride.trim() ? <span style={{color:"var(--grn)",fontWeight:400,fontSize:10,marginLeft:6}}>· custom prompt set ({systemPromptOverride.length} chars)</span> : <span style={{color:"var(--t3)",fontWeight:400,fontSize:10,marginLeft:6}}>· using default</span>}</div>
            <span style={{fontSize:11,color:"var(--t3)"}}>{showPromptEditor?"▲":"▼"}</span>
          </div>
          {showPromptEditor && (
            <div style={{marginTop:10}}>
              {/* Tab bar for switching between guide / default / schema / sanity */}
              <div style={{display:"flex",gap:4,borderBottom:"1px solid var(--bdr)",marginBottom:10,paddingBottom:0}}>
                {[
                  ["guide","📋 Prompting Guide"],
                  ["default","📖 Default Prompt"],
                  ["schema","🔧 Output Schema"],
                  ["sanity","⚠️ Score Caps"],
                ].map(([k,label])=>(
                  <button key={k} onClick={()=>setPromptRefView(k)} style={{padding:"6px 10px",fontSize:10,fontWeight:promptRefView===k?600:400,background:promptRefView===k?"var(--card)":"transparent",border:"none",borderBottom:promptRefView===k?"2px solid var(--acc)":"2px solid transparent",color:promptRefView===k?"var(--t1)":"var(--t3)",cursor:"pointer",borderRadius:"4px 4px 0 0"}}>{label}</button>
                ))}
              </div>

              {promptRefLoading && <div style={{fontSize:10,color:"var(--t3)",padding:8}}>Loading prompt reference…</div>}

              {/* GUIDE TAB */}
              {promptRefView==="guide" && (
                <div style={{fontSize:10,color:"var(--t2)",lineHeight:1.6}}>
                  <div style={{padding:10,background:"rgba(93,168,122,.06)",border:"1px solid rgba(93,168,122,.25)",borderRadius:6,marginBottom:10}}>
                    <strong style={{color:"var(--grn)"}}>How custom prompts work:</strong> Whatever you write in the textarea below is sent to OpenAI <em>as the system prompt</em>, replacing the default. The user payload (lead info + post text) is sent as the user message in JSON. Your prompt MUST instruct the AI to return the 6-field JSON output (see Output Schema tab) or the backend's sanity checks will cap your scores.
                  </div>

                  <div style={{marginBottom:10,fontSize:11,fontWeight:600,color:"var(--t1)"}}>📝 Writing a good custom prompt:</div>
                  <div style={{paddingLeft:14,marginBottom:10}}>
                    <div style={{marginBottom:6}}>1. <strong style={{color:"var(--t1)"}}>Define WHAT you're scoring</strong> — e.g. "Score posts for buying intent in the e-commerce logistics space" not "Score posts."</div>
                    <div style={{marginBottom:6}}>2. <strong style={{color:"var(--t1)"}}>Provide explicit score tiers</strong> — give the AI 4-5 score bands (e.g. 90-100, 70-89, 50-69, 30-49, 0-29) with concrete examples for each.</div>
                    <div style={{marginBottom:6}}>3. <strong style={{color:"var(--t1)"}}>List false positives explicitly</strong> — "A post about hiring is NOT a buying signal, score below 20." Be aggressive about this.</div>
                    <div style={{marginBottom:6}}>4. <strong style={{color:"var(--t1)"}}>Specify the JSON output format</strong> — paste the schema from the Output Schema tab into your prompt, or the model may invent its own keys.</div>
                    <div style={{marginBottom:6}}>5. <strong style={{color:"var(--t1)"}}>Include "OUTPUT JSON (no other text, no markdown):"</strong> as a header before the schema, so the model doesn't wrap it in code fences.</div>
                    <div style={{marginBottom:6}}>6. <strong style={{color:"var(--t1)"}}>Reference the input fields available</strong> — your prompt receives <code>full_name, title, company, post_text, pre_filter_category</code>. You can reference these in your scoring logic.</div>
                  </div>

                  <div style={{marginBottom:8,fontSize:11,fontWeight:600,color:"var(--t1)"}}>🎯 What the AI receives</div>
                  <div style={{padding:10,background:"var(--card)",borderRadius:6,fontFamily:"'JetBrains Mono',monospace",fontSize:9,marginBottom:10,whiteSpace:"pre-wrap"}}>{`# System message
<your custom prompt OR the default prompt>

# User message (always JSON)
{
  "full_name": "Jane Smith",
  "title": "VP Marketing",
  "company": "Acme Corp",
  "post_text": "<post content, capped at 3000 chars>",
  "pre_filter_category": "genuine_content"
}`}</div>

                  <div style={{padding:10,background:"rgba(245,158,11,.06)",border:"1px solid rgba(245,158,11,.3)",borderRadius:6}}>
                    <strong style={{color:"var(--amb)"}}>⚠️ Important:</strong> Even if your prompt scores a post 100, the backend will <strong>cap the score</strong> based on (a) the pre-filter category and (b) sanity checks on the AI's output. A post categorized as "motivational" cannot exceed 35, no matter what your prompt does. See <strong>Score Caps</strong> tab.
                  </div>
                </div>
              )}

              {/* DEFAULT PROMPT TAB */}
              {promptRefView==="default" && (
                <div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                    <div style={{fontSize:10,color:"var(--t3)"}}>This is the LIVE default prompt being used right now (fetched from backend).</div>
                    <div style={{display:"flex",gap:6}}>
                      <button className="btn btn-s" onClick={()=>{
                        if(promptReference?.defaultPrompt){
                          navigator.clipboard.writeText(promptReference.defaultPrompt);
                        }
                      }} style={{fontSize:9,padding:"3px 8px"}}>📋 Copy</button>
                      <button className="btn btn-s" disabled={!promptReference?.defaultPrompt||systemPromptOverride.trim()===promptReference?.defaultPrompt?.trim()} onClick={()=>{
                        if(promptReference?.defaultPrompt){
                          if(systemPromptOverride.trim() && !confirm("Replace your current custom prompt with the default?")) return;
                          setSystemPromptOverride(promptReference.defaultPrompt);
                        }
                      }} style={{fontSize:9,padding:"3px 8px",background:"rgba(93,168,122,.1)",color:"var(--grn)",borderColor:"rgba(93,168,122,.3)"}}>📥 Load as Custom</button>
                    </div>
                  </div>
                  {promptReference?.defaultPrompt ? (
                    <pre style={{fontSize:9,background:"var(--card)",padding:10,borderRadius:6,maxHeight:400,overflow:"auto",whiteSpace:"pre-wrap",lineHeight:1.5,color:"var(--t2)"}}>{promptReference.defaultPrompt}</pre>
                  ) : (
                    <div style={{fontSize:10,color:"var(--t3)",padding:12,textAlign:"center"}}>{promptRefLoading?"Loading…":"Click to load default prompt"}</div>
                  )}
                </div>
              )}

              {/* OUTPUT SCHEMA TAB */}
              {promptRefView==="schema" && (
                <div>
                  <div style={{fontSize:10,color:"var(--t3)",marginBottom:8}}>The app reads these 6 fields from the AI's JSON response. Missing or wrong fields → silent fallbacks or capped scores.</div>
                  {promptReference?.requiredOutputSchema ? (
                    <div>
                      <pre style={{fontSize:9,background:"var(--card)",padding:10,borderRadius:6,overflow:"auto",lineHeight:1.6,color:"var(--t2)"}}>{`{
${Object.entries(promptReference.requiredOutputSchema).map(([k,v])=>`  "${k}": ${v}`).join(",\n")}
}`}</pre>
                      <div style={{marginTop:10,fontSize:11,fontWeight:600,color:"var(--t1)",marginBottom:6}}>📋 Copy-paste this into your custom prompt:</div>
                      <pre style={{fontSize:9,background:"var(--card)",padding:10,borderRadius:6,overflow:"auto",lineHeight:1.5,color:"var(--t2)"}}>{`OUTPUT JSON (no other text, no markdown):
{
  "post_type": "holiday|anniversary|birthday|award|gratitude|condolence|hiring|farewell|self_promo|content_promo|motivational|reshare|thought_leadership|industry_news|event_announcement|pain_point|project_announcement|question_to_network|personal|other",
  "relevance_score": <integer 1-100>,
  "evidence_quote": "<exact sentence from post, ≤25 words. If no substantive content: 'NO_SPECIFIC_EVIDENCE' and score ≤25>",
  "relevance_rationale": "<≤40 words on why this score>",
  "structured_sentence": "<{name}, {title} at {company} posted about {15-word summary}>",
  "suggested_comment": "<≤20 words, starts with 'You could comment' or 'You could highlight'>"
}`}</pre>
                      <button className="btn btn-s" onClick={()=>{
                        navigator.clipboard.writeText(`OUTPUT JSON (no other text, no markdown):
{
  "post_type": "holiday|anniversary|birthday|award|gratitude|condolence|hiring|farewell|self_promo|content_promo|motivational|reshare|thought_leadership|industry_news|event_announcement|pain_point|project_announcement|question_to_network|personal|other",
  "relevance_score": <integer 1-100>,
  "evidence_quote": "<exact sentence from post, ≤25 words. If no substantive content: 'NO_SPECIFIC_EVIDENCE' and score ≤25>",
  "relevance_rationale": "<≤40 words on why this score>",
  "structured_sentence": "<{name}, {title} at {company} posted about {15-word summary}>",
  "suggested_comment": "<≤20 words, starts with 'You could comment' or 'You could highlight'>"
}`);
                      }} style={{fontSize:9,padding:"3px 8px",marginTop:6}}>📋 Copy schema</button>
                    </div>
                  ) : (
                    <div style={{fontSize:10,color:"var(--t3)",padding:12,textAlign:"center"}}>{promptRefLoading?"Loading…":"Click tab to load"}</div>
                  )}
                </div>
              )}

              {/* SANITY CAPS TAB */}
              {promptRefView==="sanity" && (
                <div>
                  <div style={{padding:10,background:"rgba(245,158,11,.08)",border:"1px solid rgba(245,158,11,.3)",borderRadius:6,marginBottom:10,fontSize:10,color:"var(--t2)"}}>
                    <strong style={{color:"var(--amb)"}}>Why scores get capped:</strong> Even with the most well-tuned prompts, AI models sometimes overscore (a "Happy Birthday Sarah!" post somehow gets a 75). The backend applies hard ceilings to prevent these false positives from polluting your task list. <strong>These caps run AFTER the AI scores</strong> — so your custom prompt cannot bypass them.
                  </div>

                  <div style={{marginBottom:10,fontSize:11,fontWeight:600,color:"var(--t1)"}}>1️⃣ Sanity Rules (applied to AI output)</div>
                  {promptReference?.sanityRules ? (
                    <ul style={{fontSize:10,color:"var(--t2)",lineHeight:1.7,paddingLeft:18,marginBottom:14}}>
                      {promptReference.sanityRules.map((rule,i)=>(
                        <li key={i} style={{marginBottom:3}}>{rule}</li>
                      ))}
                    </ul>
                  ) : (
                    <div style={{fontSize:10,color:"var(--t3)",padding:8}}>{promptRefLoading?"Loading…":"Click tab to load"}</div>
                  )}

                  <div style={{marginBottom:10,fontSize:11,fontWeight:600,color:"var(--t1)"}}>2️⃣ Pre-Filter Category Ceilings (applied BEFORE AI based on regex)</div>
                  {promptReference?.categoryCeilings && (
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:6,fontSize:10,marginBottom:10}}>
                      {Object.entries(promptReference.categoryCeilings).sort((a,b)=>a[1]-b[1]).map(([cat,cap])=>(
                        <div key={cat} style={{padding:"4px 8px",background:"var(--card)",borderRadius:4,display:"flex",justifyContent:"space-between"}}>
                          <span style={{color:"var(--t2)"}}>{cat}</span>
                          <span style={{color:cap>=80?"var(--grn)":cap>=50?"var(--amb)":"var(--red)",fontFamily:"'JetBrains Mono',monospace",fontWeight:600}}>{cap}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{padding:10,background:"rgba(91,143,212,.06)",border:"1px solid rgba(91,143,212,.25)",borderRadius:6,fontSize:10,color:"var(--t2)"}}>
                    <strong style={{color:"var(--blu)"}}>How to debug a low score:</strong> When a task is created, the score field is the FINAL score (post-cap). If a post you expected to score 90 is showing 35, check: (a) what was its <code>post_type</code> from the AI output? (b) was it pre-filter-categorized as something low-ceiling? Use the test_profile action or check the scan logs to see the raw AI score vs the capped score.
                  </div>
                </div>
              )}

              {/* ─── SAVED PROMPTS LIBRARY ─── */}
              <div style={{marginTop:14,padding:10,background:"rgba(155,126,216,.05)",border:"1px solid rgba(155,126,216,.25)",borderRadius:6}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
                  <div style={{fontSize:11,fontWeight:600,color:"var(--pur)"}}>📚 Saved Prompts <span style={{color:"var(--t3)",fontWeight:400,fontSize:10,marginLeft:6}}>· {savedPrompts.length} saved · scoped to this campaign</span></div>
                  <button className="btn btn-s" onClick={()=>loadSavedPrompts()} disabled={savedPromptsLoading} style={{fontSize:9,padding:"3px 8px"}} title="Refresh from Airtable">{savedPromptsLoading?"⟳":"↻"}</button>
                </div>
                {savedPromptsError && <div style={{fontSize:10,color:"var(--red)",marginBottom:8,padding:6,background:"rgba(232,107,107,.08)",borderRadius:4}}>{savedPromptsError}</div>}
                {savedPrompts.length === 0 && !savedPromptsLoading && !savedPromptsError && (
                  <div style={{fontSize:10,color:"var(--t3)",fontStyle:"italic",padding:6}}>No saved prompts yet. Write a prompt below and click 💾 Save to add one to the library.</div>
                )}
                {savedPrompts.length > 0 && (
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {savedPrompts.map(p => {
                      const isLoaded = loadedPromptId === p.id;
                      return (
                        <div key={p.id} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 8px",background:isLoaded?"rgba(155,126,216,.15)":"var(--card)",borderRadius:4,border:isLoaded?"1px solid rgba(155,126,216,.4)":"1px solid transparent"}}>
                          <div style={{flex:1,fontSize:11,color:"var(--t1)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={p.prompt.slice(0,500)}>
                            {isLoaded && <span style={{color:"var(--pur)",marginRight:4}}>●</span>}
                            <strong>{p.name}</strong>
                            <span style={{color:"var(--t3)",marginLeft:8,fontSize:9}}>{p.prompt.length} chars</span>
                          </div>
                          <button className="btn btn-s" onClick={()=>handleLoadPrompt(p.id)} disabled={isLoaded&&systemPromptOverride===loadedPromptOriginal} style={{fontSize:9,padding:"3px 8px"}} title={isLoaded&&systemPromptOverride===loadedPromptOriginal?"Already loaded":"Load this prompt into the editor"}>{isLoaded&&systemPromptOverride===loadedPromptOriginal?"✓ Loaded":"📥 Load"}</button>
                          <button className="btn btn-s" onClick={()=>handleDeletePrompt(p.id)} style={{fontSize:9,padding:"3px 6px",color:"var(--red)"}} title="Delete this saved prompt">✕</button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* The actual textarea — always visible */}
              <div style={{marginTop:14,padding:10,background:"var(--card)",borderRadius:6}}>
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6,flexWrap:"wrap",gap:6}}>
                  <div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>
                    ✏️ Your Custom Prompt
                    {loadedPromptId && (() => {
                      const loaded = savedPrompts.find(p=>p.id===loadedPromptId);
                      if (!loaded) return null;
                      const isModified = systemPromptOverride !== loadedPromptOriginal;
                      return <span style={{fontSize:9,fontWeight:400,marginLeft:8,color:isModified?"var(--amb)":"var(--grn)"}}>{isModified ? `· editing "${loaded.name}" (unsaved)` : `· loaded from "${loaded.name}"`}</span>;
                    })()}
                  </div>
                  <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                    {/* Update button — only shown when there's a loaded prompt with unsaved edits */}
                    {loadedPromptId && systemPromptOverride !== loadedPromptOriginal && systemPromptOverride.trim() && (
                      <button className="btn btn-s" onClick={handleUpdateLoadedPrompt} disabled={promptSaving} style={{fontSize:9,padding:"3px 8px",background:"rgba(245,158,11,.1)",color:"var(--amb)",borderColor:"rgba(245,158,11,.3)"}} title="Overwrite the loaded saved prompt with current edits">{promptSaving?"⏳":"⟳ Update"}</button>
                    )}
                    {/* Save button — primary save action */}
                    {systemPromptOverride.trim() && !loadedPromptId && (
                      <button className="btn btn-s" onClick={()=>setSavePromptModal({mode:"save",name:""})} disabled={promptSaving} style={{fontSize:9,padding:"3px 8px",background:"rgba(93,168,122,.1)",color:"var(--grn)",borderColor:"rgba(93,168,122,.3)"}} title="Save current prompt to library">{promptSaving?"⏳":"💾 Save"}</button>
                    )}
                    {/* Save As — when a prompt is loaded, lets user save edits as a NEW prompt */}
                    {systemPromptOverride.trim() && loadedPromptId && (
                      <button className="btn btn-s" onClick={()=>{
                        const loaded = savedPrompts.find(p=>p.id===loadedPromptId);
                        setSavePromptModal({mode:"save_as",name:loaded?`${loaded.name} (copy)`:""});
                      }} style={{fontSize:9,padding:"3px 8px"}} title="Save current prompt as a NEW saved prompt">💾 Save As…</button>
                    )}
                    {systemPromptOverride.trim() && (
                      <button className="btn btn-s" onClick={()=>{if(confirm("Clear custom prompt and use default?")){setSystemPromptOverride("");setLoadedPromptId(null);setLoadedPromptOriginal("");}}} style={{fontSize:9,padding:"3px 8px",color:"var(--red)"}}>✕ Clear</button>
                    )}
                  </div>
                </div>
                <textarea className="inp" rows="10" placeholder="Leave blank to use default. Switch to '📖 Default Prompt' tab above and click '📥 Load as Custom' to start from the default and edit. Or load a saved prompt from the library above. Make sure your prompt instructs the AI to return all 6 JSON fields shown in the '🔧 Output Schema' tab." value={systemPromptOverride} onChange={e=>setSystemPromptOverride(e.target.value)} style={{fontSize:11,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.5}}/>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"var(--t3)",marginTop:4}}>
                  <span>{systemPromptOverride.length} chars</span>
                  <span>{systemPromptOverride.trim() ? "✓ Custom prompt active" : "⚪ Default prompt active"}</span>
                </div>
              </div>
            </div>
          )}
        </div>


        {/* Auto-cleanup settings — prevents Airtable Tasks table from piling up */}
        <div style={{marginTop:14,padding:12,background:"var(--hover)",borderRadius:6}}>
          <div style={{fontSize:11,fontWeight:600,color:"var(--t1)",marginBottom:8}}>🧹 Task Cleanup</div>
          <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:8}}>
            <input type="checkbox" id="auto-cleanup-toggle" checked={autoCleanup} onChange={e=>setAutoCleanup(e.target.checked)} style={{marginTop:3}}/>
            <label htmlFor="auto-cleanup-toggle" style={{flex:1,cursor:"pointer"}}>
              <div style={{fontSize:11,color:"var(--t1)",fontWeight:500}}>Auto-delete old tasks before each scan</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:2,lineHeight:1.5}}>Deletes LinkedIn post tasks older than <input type="number" min="1" max="180" value={autoCleanupDays} onChange={e=>setAutoCleanupDays(parseInt(e.target.value)||14)} style={{width:40,padding:"1px 4px",margin:"0 3px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:3,color:"var(--t1)",fontSize:10}}/>days before starting. Prevents the Tasks table from piling up weekly.</div>
            </label>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:8,marginLeft:24,marginBottom:10}}>
            <input type="checkbox" id="exclude-pushed" checked={autoCleanupExcludePushed} onChange={e=>setAutoCleanupExcludePushed(e.target.checked)}/>
            <label htmlFor="exclude-pushed" style={{fontSize:10,color:"var(--t2)",cursor:"pointer"}}>Skip tasks already pushed to HubSpot (recommended — preserves records you're still acting on)</label>
          </div>
          <div style={{display:"flex",gap:6,paddingTop:8,borderTop:"1px solid var(--bdr)"}}>
            <button className="btn btn-s" onClick={openCleanupModal} disabled={scanning}>🗑 Preview / Run Cleanup Now</button>
            <div style={{fontSize:10,color:"var(--t3)",alignSelf:"center"}}>Also: duplicate posts (same URL within {Math.min(autoCleanupDays, 14)} days) are auto-skipped during every scan regardless of this setting.</div>
          </div>
        </div>

        {/* Action buttons */}
        <div style={{display:"flex",gap:8,marginTop:16,flexWrap:"wrap"}}>
          <button className="btn btn-p" onClick={()=>startScan(false)} disabled={isRunning}>
            {isRunning ? "⏳ Scanning..." : `🚀 Start Scan`}
          </button>
          {isResumable && (
            <button className="btn btn-s" onClick={()=>startScan(true)} disabled={scanning} style={{background:"rgba(245,158,11,.1)",color:"var(--amb)",borderColor:"var(--amb)"}}>
              ↺ Resume ({progress.leads_remaining} leads left)
            </button>
          )}
          {(isRunning || isResumable) && (
            <button className="btn btn-s" onClick={stopScan} style={{background:"rgba(239,68,68,.1)",color:"var(--red)",borderColor:"var(--red)"}}>
              ⛔ Stop Scan
            </button>
          )}
          {progress && <button className="btn btn-s" onClick={clearProgress} disabled={scanning}>🗑 Clear State</button>}
        </div>

        {err && <div style={{marginTop:12,padding:10,background:"var(--red-d)",color:"var(--red)",borderRadius:6,fontSize:11}}>❌ {err}</div>}
      </div>

      {/* Cleanup preview modal */}
      {cleanupModal && (
        <div onClick={e=>e.target===e.currentTarget&&!cleanupModal.running&&setCleanupModal(null)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,padding:24,width:"100%",maxWidth:560,maxHeight:"90vh",overflow:"auto"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div style={{fontSize:15,fontWeight:600,color:"var(--t1)"}}>🗑 Clean Up Old LinkedIn Post Tasks</div>
              <button onClick={()=>!cleanupModal.running&&setCleanupModal(null)} style={{background:"transparent",border:"none",color:"var(--t3)",cursor:"pointer",fontSize:20,padding:0,lineHeight:1}}>×</button>
            </div>
            <div style={{fontSize:11,color:"var(--t2)",marginBottom:14,lineHeight:1.6}}>
              This will DELETE tasks from your Airtable Tasks table where <code style={{background:"var(--hover)",padding:"1px 4px",borderRadius:3}}>Task Rule = "{taskRuleName}"</code> AND created more than {cleanupModal.days} days ago.
              <br/><br/>
              <strong style={{color:"var(--t1)"}}>HubSpot records are untouched</strong> — only local Airtable records.
            </div>
            {cleanupModal.loading && <div style={{padding:20,textAlign:"center",color:"var(--t3)",fontSize:11}}>⏳ Looking up stale tasks...</div>}
            {cleanupModal.preview && !cleanupModal.loading && (
              <div>
                <div style={{padding:14,background:"var(--hover)",borderRadius:6,marginBottom:14}}>
                  <div style={{fontSize:24,fontWeight:600,color:cleanupModal.preview.total > 0 ? "var(--red)" : "var(--grn)"}}>{cleanupModal.preview.total}</div>
                  <div style={{fontSize:10,color:"var(--t3)"}}>tasks would be deleted</div>
                  {cleanupModal.preview.pushed_to_hubspot > 0 && (
                    <div style={{marginTop:8,fontSize:10,color:"var(--t2)"}}>
                      • {cleanupModal.preview.pushed_to_hubspot} already pushed to HubSpot
                      <br/>• {cleanupModal.preview.not_pushed} not yet pushed
                    </div>
                  )}
                </div>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:14}}>
                  <input type="checkbox" id="modal-exclude-pushed" checked={cleanupModal.excludePushed} onChange={e=>setCleanupModal(m=>({...m,excludePushed:e.target.checked}))}/>
                  <label htmlFor="modal-exclude-pushed" style={{fontSize:11,color:"var(--t2)",cursor:"pointer"}}>Only delete tasks NOT yet pushed to HubSpot {cleanupModal.preview.pushed_to_hubspot > 0 && `(will keep ${cleanupModal.preview.pushed_to_hubspot} pushed tasks)`}</label>
                </div>
                {cleanupModal.preview.sample?.length > 0 && (
                  <div>
                    <div style={{fontSize:10,color:"var(--t3)",marginBottom:6,fontWeight:500}}>Sample (first {cleanupModal.preview.sample.length}):</div>
                    <div style={{maxHeight:200,overflowY:"auto",border:"1px solid var(--bdr)",borderRadius:6}}>
                      {cleanupModal.preview.sample.map(s => (
                        <div key={s.id} style={{padding:"6px 10px",borderBottom:"1px solid var(--bdr)",fontSize:10,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div>
                            <div style={{color:"var(--t1)",fontWeight:500}}>{s.lead} {s.company && <span style={{color:"var(--t3)",fontWeight:400}}>· {s.company}</span>}</div>
                            <div style={{color:"var(--t3)",fontSize:9,marginTop:2}}>Created: {s.created?.slice(0,10)} · Score: {s.score}</div>
                          </div>
                          {s.pushed && <span style={{padding:"2px 6px",fontSize:9,background:"var(--amb-d)",color:"var(--amb)",borderRadius:3}}>pushed</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div style={{display:"flex",gap:8,justifyContent:"flex-end",marginTop:14}}>
              <button className="btn btn-s" onClick={()=>setCleanupModal(null)} disabled={cleanupModal.running}>Cancel</button>
              <button className="btn btn-p btn-s" onClick={runCleanup} disabled={cleanupModal.running || cleanupModal.loading || !cleanupModal.preview?.total} style={{background:"var(--red)",borderColor:"var(--red)"}}>
                {cleanupModal.running ? "⏳ Deleting..." : `🗑 Delete ${cleanupModal.preview?.total || 0} tasks`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PROGRESS PANEL ── */}
      {progress && (
        <div style={{padding:20,background:"var(--card)",border:"1px solid "+(progress.status==="complete"?"var(--grn)":progress.status==="running"?"var(--blu)":"var(--bdr)"),borderRadius:10,marginBottom:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>
                {progress.status==="complete" ? "✅ Scan Complete" : progress.status==="running" ? "⏳ Scan Running" : "🔄 Scan Status"}
                {progress.campaign && <span style={{color:"var(--t3)",fontWeight:400,marginLeft:8}}>· {progress.campaign}</span>}
              </div>
              {progress.started_at && <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>Started: {new Date(progress.started_at).toLocaleString()}{progress.ended_at?" · Ended: "+new Date(progress.ended_at).toLocaleString():""}</div>}
            </div>
            {isRunning && <div style={{fontSize:10,color:"var(--blu)",fontWeight:500}}>● polling every 2s</div>}
          </div>

          {/* Progress bar */}
          {progress.total_leads > 0 && (
            <div style={{marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:4,fontSize:10,color:"var(--t2)"}}>
                <span><strong style={{color:"var(--t1)"}}>{progress.leads_done}</strong> / {progress.total_leads} leads processed</span>
                <span>{Math.round((progress.leads_done/progress.total_leads)*100)}%</span>
              </div>
              <div style={{height:8,background:"var(--hover)",borderRadius:4,overflow:"hidden"}}>
                <div style={{height:"100%",background:progress.status==="complete"?"var(--grn)":"var(--blu)",width:`${Math.round((progress.leads_done/progress.total_leads)*100)}%`,transition:"width .3s"}}/>
              </div>
            </div>
          )}

          {/* Current step + log */}
          {progress.last_log && (
            <div style={{padding:10,background:"var(--hover)",borderRadius:6,fontSize:10,color:"var(--t2)",marginBottom:12,fontFamily:"'JetBrains Mono',monospace",lineHeight:1.6}}>
              {progress.last_log}
              {progress.current_lead_step && <span style={{color:"var(--blu)",marginLeft:6}}>[{progress.current_lead_step}]</span>}
            </div>
          )}

          {/* Stats grid */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(140px, 1fr))",gap:8,marginBottom:12}}>
            <div style={{padding:10,background:"var(--hover)",borderRadius:6}}>
              <div style={{fontSize:9,color:"var(--t3)",marginBottom:2}}>POSTS FETCHED</div>
              <div style={{fontSize:18,fontWeight:600,color:"var(--t1)"}}>{progress.posts_fetched || 0}</div>
            </div>
            <div style={{padding:10,background:"var(--hover)",borderRadius:6}}>
              <div style={{fontSize:9,color:"var(--t3)",marginBottom:2}}>FILTERED OUT (junk)</div>
              <div style={{fontSize:18,fontWeight:600,color:"var(--amb)"}}>{progress.posts_filtered_out || 0}</div>
            </div>
            <div style={{padding:10,background:"var(--hover)",borderRadius:6}}>
              <div style={{fontSize:9,color:"var(--t3)",marginBottom:2}}>AI-SCORED</div>
              <div style={{fontSize:18,fontWeight:600,color:"var(--blu)"}}>{progress.posts_scored || 0}</div>
            </div>
            <div style={{padding:10,background:"var(--hover)",borderRadius:6}}>
              <div style={{fontSize:9,color:"var(--t3)",marginBottom:2}}>TASKS CREATED</div>
              <div style={{fontSize:18,fontWeight:600,color:"var(--grn)"}}>{progress.tasks_created || 0}</div>
            </div>
          </div>

          {/* Category breakdown */}
          {progress.category_counts && Object.keys(progress.category_counts).length > 0 && (
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,color:"var(--t3)",marginBottom:6,fontWeight:500}}>Posts by pre-filter category:</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,fontSize:10}}>
                {Object.entries(progress.category_counts).sort((a,b)=>b[1]-a[1]).map(([cat,n])=>{
                  const meta = {
                    genuine_content: { emoji: "✨", color: "var(--grn)" },
                    event_promo: { emoji: "📅", color: "var(--amb)" },
                    engagement_bait: { emoji: "🎣", color: "var(--amb)" },
                    thin_content: { emoji: "📏", color: "var(--t3)" },
                    short_content: { emoji: "📝", color: "var(--t3)" },
                    self_promo: { emoji: "🎉", color: "var(--t3)" },
                    farewell: { emoji: "👋", color: "var(--t3)" },
                    linkedin_spam: { emoji: "🏆", color: "var(--t3)" },
                    hiring: { emoji: "💼", color: "var(--t3)" },
                    holiday: { emoji: "🎄", color: "var(--t3)" },
                    anniversary: { emoji: "🎂", color: "var(--t3)" },
                    birthday: { emoji: "🎈", color: "var(--t3)" },
                    condolence: { emoji: "🕊", color: "var(--t3)" },
                    award: { emoji: "🏅", color: "var(--t3)" },
                    gratitude: { emoji: "🙏", color: "var(--t3)" },
                    content_promo: { emoji: "📚", color: "var(--t3)" },
                    motivational: { emoji: "💪", color: "var(--t3)" },
                    reshare_minimal: { emoji: "🔁", color: "var(--t3)" },
                    funding_announcement: { emoji: "💰", color: "var(--t3)" },
                    unknown: { emoji: "❓", color: "var(--t3)" },
                  }[cat] || { emoji: "•", color: "var(--t3)" };
                  return <span key={cat} style={{padding:"3px 8px",background:"var(--hover)",borderRadius:3,color:meta.color}}>{meta.emoji} {cat.replace(/_/g," ")}: <strong>{n}</strong></span>;
                })}
              </div>
            </div>
          )}

          {/* Rejection reasons — shows WHY posts didn't become tasks */}
          {progress.rejection_reasons && Object.keys(progress.rejection_reasons).length > 0 && (
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,color:"var(--t3)",marginBottom:6,fontWeight:500}}>Scoring outcomes (after AI + sanity checks):</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:6,fontSize:10}}>
                {Object.entries(progress.rejection_reasons).sort((a,b)=>b[1]-a[1]).map(([reason,n])=>{
                  const isPassed = reason === "passed";
                  const isCapped = reason.includes("capped");
                  const color = isPassed ? "var(--grn)" : isCapped ? "var(--amb)" : "var(--t3)";
                  const emoji = isPassed ? "✅" : isCapped ? "⚠️" : "⬇";
                  return <span key={reason} style={{padding:"3px 8px",background:"var(--hover)",borderRadius:3,color}} title={reason}>{emoji} {reason.replace(/_/g," ").slice(0,50)}: <strong>{n}</strong></span>;
                })}
              </div>
            </div>
          )}

          {/* Errors (collapsed) */}
          {progress.errors?.length > 0 && (
            <details style={{marginTop:10}}>
              <summary style={{cursor:"pointer",fontSize:10,color:"var(--red)"}}>⚠️ {progress.errors.length} error{progress.errors.length!==1?"s":""} during scan (click to view)</summary>
              <div style={{padding:10,background:"var(--red-d)",borderRadius:6,fontSize:10,color:"var(--red)",marginTop:6,maxHeight:180,overflowY:"auto",fontFamily:"'JetBrains Mono',monospace",lineHeight:1.5}}>
                {progress.errors.slice(0, 50).map((e, i) => <div key={i}>• {e}</div>)}
                {progress.errors.length > 50 && <div style={{color:"var(--t3)",marginTop:6}}>... and {progress.errors.length - 50} more</div>}
              </div>
            </details>
          )}
          {/* Recent scored samples — audit what AI is deciding */}
          {progress.recent_samples?.length > 0 && (
            <details style={{marginTop:10}} open={progress.tasks_created === 0 && progress.posts_scored > 0}>
              <summary style={{cursor:"pointer",fontSize:10,color:"var(--t2)",fontWeight:500}}>🔍 Recent scored posts ({progress.recent_samples.length}) — click to audit</summary>
              <div style={{marginTop:8,maxHeight:400,overflowY:"auto",display:"flex",flexDirection:"column",gap:8}}>
                {progress.recent_samples.map((s, i) => {
                  const isTask = s.outcome === "task_created";
                  const isPending = s.outcome === "pending_task_creation";
                  const isFailed = s.outcome === "task_creation_failed";
                  const badge = isTask ? "✓ TASK" : isPending ? "⏳ PENDING" : isFailed ? "⚠ FAILED" : "✗ DROPPED";
                  const badgeColor = isTask ? "var(--grn)" : isPending ? "var(--amb)" : isFailed ? "var(--red)" : "var(--t3)";
                  const bg = isTask ? "rgba(93,168,122,.08)" : isFailed ? "rgba(239,68,68,.08)" : "var(--hover)";
                  const border = isTask ? "var(--grn)" : isFailed ? "var(--red)" : "var(--bdr)";
                  return (
                  <div key={i} style={{padding:10,background:bg,border:"1px solid "+border,borderRadius:6,fontSize:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:4}}>
                      <div style={{color:"var(--t1)",fontWeight:500}}>{s.lead} {s.company && <span style={{color:"var(--t3)",fontWeight:400}}>· {s.company}</span>}</div>
                      <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                        <span style={{color:badgeColor,fontWeight:600}}>{badge}</span>
                        <span style={{padding:"1px 6px",background:"var(--card)",borderRadius:3,color:"var(--t1)",fontWeight:600,fontFamily:"'JetBrains Mono',monospace"}}>{s.final_score}</span>
                      </div>
                    </div>
                    <div style={{color:"var(--t2)",marginBottom:4,fontStyle:"italic",lineHeight:1.5}}>"{s.post_text}{s.post_text?.length >= 280 ? "..." : ""}"</div>
                    {isFailed && s.error && <div style={{color:"var(--red)",marginBottom:4,fontSize:9,fontFamily:"'JetBrains Mono',monospace"}}>Airtable error: {String(s.error).slice(0,200)}</div>}
                    <div style={{display:"flex",flexWrap:"wrap",gap:8,fontSize:9,color:"var(--t3)"}}>
                      <span>type: <strong style={{color:"var(--t2)"}}>{s.post_type}</strong></span>
                      <span>category: <strong style={{color:"var(--t2)"}}>{s.category}</strong>{s.penalty !== 0 ? ` (${s.penalty})` : ""}</span>
                      <span>AI: <strong style={{color:"var(--t2)"}}>{s.ai_score}</strong> → final: <strong style={{color:s.final_score>=70?"var(--grn)":"var(--amb)"}}>{s.final_score}</strong></span>
                      {s.post_url && <a href={s.post_url} target="_blank" rel="noreferrer" onClick={e=>e.stopPropagation()} style={{color:"var(--blu)"}}>view post →</a>}
                    </div>
                    {s.evidence && s.evidence !== "NO_SPECIFIC_EVIDENCE" && (
                      <div style={{marginTop:4,fontSize:9,color:"var(--t3)"}}>evidence: <span style={{color:"var(--t2)"}}>"{s.evidence}"</span></div>
                    )}
                    {s.rationale && (
                      <div style={{marginTop:3,fontSize:9,color:"var(--t3)"}}>reason: <span style={{color:"var(--t2)"}}>{s.rationale}</span></div>
                    )}
                  </div>
                  );
                })}
              </div>
            </details>
          )}
        </div>
      )}

      {/* ── INFO PANEL ── */}
      <div style={{padding:16,background:"var(--hover)",borderRadius:8,fontSize:10,color:"var(--t2)",lineHeight:1.6}}>
        <div style={{fontSize:11,fontWeight:600,color:"var(--t1)",marginBottom:6}}>How it works</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div>
            <div style={{color:"var(--t1)",fontWeight:500,marginBottom:4}}>1. Fetch</div>
            Hits Fresh LinkedIn Scraper (RapidAPI) per lead. Caches URN on the Lead record so repeat scans don't re-fetch profile. Only returns posts from the last {daysBack} days.
          </div>
          <div>
            <div style={{color:"var(--t1)",fontWeight:500,marginBottom:4}}>2. Pre-filter</div>
            Before hitting OpenAI, posts are classified by keyword rules (hiring, farewell, course completion spam, etc.). Junk categories are skipped — no AI cost spent on them.
          </div>
          <div>
            <div style={{color:"var(--t1)",fontWeight:500,marginBottom:4}}>3. Score</div>
            Remaining posts go to gpt-5.4-mini with an engagement-quality prompt (campaign-agnostic — scores post substance, not sales intent). Returns score 1-100, evidence quote, rationale, neutral summary, and a suggested non-salesy comment.
          </div>
          <div>
            <div style={{color:"var(--t1)",fontWeight:500,marginBottom:4}}>4. Create tasks</div>
            Score is adjusted down based on category (event_promo -15, thin_content -35, etc.). If final score ≥ threshold, a task is created with the suggested comment ready to copy.
          </div>
        </div>
        <div style={{marginTop:10,paddingTop:10,borderTop:"1px solid var(--bdr)"}}>
          <strong style={{color:"var(--t1)"}}>Resumable:</strong> progress is saved to Airtable after every lead. If the function times out or crashes mid-scan, hit <em>Resume</em> to continue from where it stopped. No duplicate work, no lost data.
        </div>
      </div>

      {/* Save Prompt modal */}
      {savePromptModal && (
        <div onClick={e=>e.target===e.currentTarget&&!promptSaving&&setSavePromptModal(null)} style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,0.75)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
          <div style={{background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,padding:24,width:"100%",maxWidth:480}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
              <div style={{fontSize:15,fontWeight:600,color:"var(--t1)"}}>💾 {savePromptModal.mode==="save_as"?"Save Prompt As…":"Save Prompt"}</div>
              <button onClick={()=>!promptSaving&&setSavePromptModal(null)} disabled={promptSaving} style={{background:"transparent",border:"none",color:"var(--t3)",cursor:promptSaving?"not-allowed":"pointer",fontSize:20,padding:0,lineHeight:1}}>×</button>
            </div>
            <div style={{fontSize:11,color:"var(--t2)",marginBottom:12,lineHeight:1.6}}>
              Saving to <strong style={{color:"var(--t1)"}}>Prompts</strong> table in this campaign's base, with Task Rule = <code style={{background:"var(--hover)",padding:"1px 4px",borderRadius:3}}>"LinkedIn Posts"</code>. Available across all sessions and devices on this campaign.
            </div>
            <div style={{marginBottom:8}}>
              <label style={{fontSize:10,color:"var(--t3)",display:"block",marginBottom:4}}>Prompt Name</label>
              <input
                type="text"
                className="inp"
                value={savePromptModal.name}
                onChange={e=>setSavePromptModal(m=>({...m,name:e.target.value}))}
                placeholder="e.g. Material — Buying Intent · v2"
                autoFocus
                onKeyDown={e=>{
                  if(e.key==="Enter" && savePromptModal.name.trim() && !promptSaving){
                    handleSavePrompt(savePromptModal.name).then(success=>{ if(success) setSavePromptModal(null); });
                  } else if(e.key==="Escape" && !promptSaving){
                    setSavePromptModal(null);
                  }
                }}
                style={{fontSize:12}}
              />
              {savedPrompts.find(p=>p.name.toLowerCase()===savePromptModal.name.trim().toLowerCase()) && (
                <div style={{fontSize:9,color:"var(--amb)",marginTop:4}}>⚠ A prompt with this name already exists. Saving will overwrite it.</div>
              )}
            </div>
            <div style={{display:"flex",justifyContent:"flex-end",gap:6,marginTop:14}}>
              <button className="btn btn-s" onClick={()=>setSavePromptModal(null)} disabled={promptSaving}>Cancel</button>
              <button className="btn btn-s btn-p" onClick={async()=>{
                const success = await handleSavePrompt(savePromptModal.name);
                if(success) setSavePromptModal(null);
              }} disabled={!savePromptModal.name.trim()||promptSaving}>{promptSaving?"⏳ Saving…":"💾 Save"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// TRIGGERS TAB — Unified view of GA + Unipile + LinkedIn Posts triggers
// ═══════════════════════════════════════════════════════════════
function TriggersTab({ baseId, campaign }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState(null);
  const [triggers, setTriggers] = useState([]);
  const [sourceFilter, setSourceFilter] = useState("all"); // all | Unipile | GA | LinkedIn Posts (RapidAPI)
  const [accountFilter, setAccountFilter] = useState("all"); // all | <account_id> — narrows feed to a single account
  const [windowDays, setWindowDays] = useState(7);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState(null);
  const [lastRefreshed, setLastRefreshed] = useState(null);
  const [err, setErr] = useState("");

  // Routing state — for the per-account "which campaign does this LinkedIn account belong to" UI
  const [routingExpanded, setRoutingExpanded] = useState(false);
  const [routingData, setRoutingData] = useState(null); // { accounts, campaigns }
  const [routingLoading, setRoutingLoading] = useState(false);
  const [routingSavingAcct, setRoutingSavingAcct] = useState(null); // account_id being saved
  const [unroutedExpanded, setUnroutedExpanded] = useState(false);
  const [unroutedData, setUnroutedData] = useState(null);

  const upiAPI = async (action, body = {}) => {
    const r = await fetch(`/api/unipile-triggers?action=${action}&base=${baseId}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body }),
    });
    return r.json();
  };

  const loadStatus = async () => {
    try {
      const r = await fetch(`/api/unipile-triggers?action=status&base=${baseId}`);
      const d = await r.json();
      setStatus(d);
    } catch (e) { setErr(e.message); }
  };

  const loadTriggers = async () => {
    setLoading(true);
    setErr("");
    try {
      const since = new Date(Date.now() - windowDays * 86400000).toISOString();
      const r = await fetch(`/api/unipile-triggers?action=list_triggers&base=${baseId}&since=${encodeURIComponent(since)}`);
      const d = await r.json();
      if (d.ok) setTriggers(d.triggers || []);
      else setErr(d.error || "Failed to load triggers");
    } catch (e) { setErr(e.message); }
    setLoading(false);
  };

  useEffect(() => {
    loadStatus();
    loadTriggers();
    // Also load routing data (silently) so we have account_id → name lookup
    // for the breakdown widget. Doesn't depend on user expanding the routing panel.
    loadRouting().catch(() => {});
  }, [baseId, windowDays]); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual refresh — pulls fresh data from Unipile (profile views, reactions),
  // creates tasks for any new events, then reloads the triggers list.
  // No cron polling — this only runs when user clicks the button.
  const refreshFromUnipile = async () => {
    setRefreshing(true); setRefreshResult(null); setErr("");
    try {
      const r = await upiAPI("manual_poll");
      setRefreshResult(r);
      setLastRefreshed(new Date());
      await loadTriggers();
    } catch (e) { setErr(e.message); }
    setRefreshing(false);
  };

  // ─── Account Routing helpers ───
  // Load list of LinkedIn accounts + their current routing + available campaigns
  const loadRouting = async () => {
    setRoutingLoading(true);
    try {
      // First-time setup — auto-create the master tables if they don't exist yet.
      // Idempotent — does nothing if tables already exist.
      await upiAPI("ensure_routing_tables").catch(() => null);
      const r = await upiAPI("list_routing");
      if (r.ok) setRoutingData(r);
      else setErr(r.error || "Failed to load routing");
    } catch (e) { setErr(e.message); }
    setRoutingLoading(false);
  };

  // Save a single account's routing — called from the per-account dropdown
  const saveRouting = async (account_id, account_name, campaign) => {
    setRoutingSavingAcct(account_id);
    try {
      const r = await upiAPI("set_routing", {
        account_id,
        account_name,
        campaign_base_id: campaign.baseId,
        client_name: campaign.name,
      });
      if (r.ok) await loadRouting(); // refresh display
      else setErr(r.error || "Failed to save routing");
    } catch (e) { setErr(e.message); }
    setRoutingSavingAcct(null);
  };

  // Remove a routing entry — events from this account will go to Unrouted Triggers
  const deleteRouting = async (recordId) => {
    if (!confirm("Remove routing for this account? Future events will be logged to Unrouted Triggers instead of creating tasks.")) return;
    try {
      const r = await upiAPI("delete_routing", { record_id: recordId });
      if (r.ok) await loadRouting();
      else setErr(r.error || "Failed to delete routing");
    } catch (e) { setErr(e.message); }
  };

  // Load unrouted events (events that came in for accounts without a routing entry)
  const loadUnrouted = async () => {
    try {
      const r = await upiAPI("list_unrouted");
      if (r.ok) setUnroutedData(r);
      else setErr(r.error || "Failed to load unrouted");
    } catch (e) { setErr(e.message); }
  };

  // Auto-load routing when section is expanded
  useEffect(() => {
    if (routingExpanded && !routingData) loadRouting();
  }, [routingExpanded]);
  useEffect(() => {
    if (unroutedExpanded && !unroutedData) loadUnrouted();
  }, [unroutedExpanded]);

  // Group triggers by source for the dashboard cards
  // Step 1: apply source filter
  const sourceFiltered = sourceFilter === "all"
    ? triggers
    : triggers.filter(t => t.task_type?.startsWith(sourceFilter.toLowerCase()));
  // Step 2: apply account filter
  const filteredTriggers = accountFilter === "all"
    ? sourceFiltered
    : sourceFiltered.filter(t => (t.account_id || "(none)") === accountFilter);

  const counts = {
    all: triggers.length,
    unipile: triggers.filter(t => t.task_type?.startsWith("unipile_")).length,
    ga: triggers.filter(t => t.task_type?.startsWith("ga_") || t.task_type?.includes("page_view")).length,
    posts: triggers.filter(t => t.task_type === "linkedin_engagement").length,
  };

  // ─── Per-account breakdown ────────────────────────────────────
  // Build a lookup: account_id → human-readable name (from routing data we
  // silently loaded). Falls back to a truncated account_id if not mapped yet.
  const accountNameById = {};
  if (routingData?.accounts) {
    for (const a of routingData.accounts) {
      if (a.account_id) accountNameById[a.account_id] = a.name || a.account_id;
    }
  }
  const labelForAccountId = (id) => {
    if (!id) return "(no account_id)";
    if (accountNameById[id]) return accountNameById[id];
    // Unmapped — show truncated ID so user can still distinguish accounts
    return `Unmapped · ${id.slice(0, 8)}…`;
  };

  // Group sourceFiltered (NOT filteredTriggers — we want full per-account view,
  // not narrowed-by-current-account) by account_id, then by event type.
  // Result: [{ accountId, name, total, byType: {dm:N, conn:N, react:N, ...} }, ...]
  const accountBreakdown = (() => {
    const m = {};
    for (const t of sourceFiltered) {
      const id = t.account_id || "(none)";
      if (!m[id]) m[id] = { accountId: id, name: labelForAccountId(id), total: 0, byType: {} };
      m[id].total++;
      const tt = t.task_type || "unknown";
      m[id].byType[tt] = (m[id].byType[tt] || 0) + 1;
    }
    return Object.values(m).sort((a, b) => b.total - a.total);
  })();

  const triggerTypeLabels = {
    unipile_message_reply: "📬 DM Reply",
    unipile_connection_accepted: "🤝 Connection Accepted",
    unipile_message_reaction: "😊 DM Reaction",
    unipile_post_comment_on_yours: "💬 Comment on your Post",
    unipile_post_reaction_on_yours: "👍 Reaction on your Post",
    unipile_profile_view: "👀 Profile View",
    linkedin_engagement: "📝 LinkedIn Post Score",
  };

  // Format "X min ago" for the last refresh timestamp
  const formatAgo = (date) => {
    if (!date) return null;
    const sec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (sec < 10) return "just now";
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    return `${Math.floor(sec / 3600)}h ago`;
  };

  return (<div>
    <div className="ph">
      <div>
        <div className="pt">🔥 Triggers</div>
        <div className="pd">Buying signals from Unipile, GA, and LinkedIn Posts. Webhooks fire automatically — refresh manually for profile views & reactions.</div>
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        {lastRefreshed && <span style={{fontSize:10,color:"var(--t3)"}}>Refreshed {formatAgo(lastRefreshed)}</span>}
        <button className="btn btn-s" onClick={loadTriggers} disabled={loading}>{loading ? "..." : "↻ Reload feed"}</button>
        <button className="btn btn-p" onClick={refreshFromUnipile} disabled={refreshing}>{refreshing ? "⏳ Pulling from Unipile..." : "🔄 Refresh from Unipile"}</button>
      </div>
    </div>

    {err && <div style={{padding:12,background:"rgba(239,68,68,.08)",border:"1px solid var(--red)",borderRadius:6,color:"var(--red)",marginBottom:12,fontSize:11}}>❌ {err}</div>}

    {/* Status row: account count, lead index size, webhook URL */}
    {status && (
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:14}}>
        <div style={{display:"flex",gap:24,flexWrap:"wrap",alignItems:"center",fontSize:11,color:"var(--t2)"}}>
          <div><span style={{color:"var(--t3)"}}>Unipile:</span> <strong style={{color:status.unipile_connected?"var(--grn)":"var(--red)"}}>{status.unipile_connected ? "✓ Connected" : "✗ Not connected"}</strong></div>
          <div><span style={{color:"var(--t3)"}}>LinkedIn accounts:</span> <strong style={{color:"var(--t1)"}}>{status.accounts_count || 0}</strong></div>
          <div><span style={{color:"var(--t3)"}}>Leads indexed:</span> <strong style={{color:"var(--t1)"}}>{status.leads_indexed || 0}</strong></div>
        </div>
        {status.webhook_url && (
          <details style={{marginTop:10,fontSize:10,color:"var(--t3)"}}>
            <summary style={{cursor:"pointer",fontWeight:600,color:"var(--t2)"}}>📡 Unipile webhook setup (do this once per webhook type)</summary>
            <div style={{marginTop:10,padding:12,background:"var(--hover)",borderRadius:6,lineHeight:1.6}}>
              <div style={{marginBottom:8,color:"var(--t1)",fontWeight:600,fontSize:11}}>One URL handles everything:</div>
              <div style={{padding:8,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:4,fontFamily:"'JetBrains Mono',monospace",wordBreak:"break-all",color:"var(--t1)",fontSize:10,marginBottom:10}}>
                {(status.webhook_url || "").replace(/&base=[^&]+/, "")}
              </div>
              <div style={{marginBottom:10,color:"var(--t2)"}}>
                Replace <code style={{background:"var(--card)",padding:"1px 4px",borderRadius:2}}>YOUR_CRON_SECRET</code> with your <code style={{background:"var(--card)",padding:"1px 4px",borderRadius:2}}>CRON_SECRET</code> env var value (set in Vercel).
              </div>

              <div style={{marginTop:14,marginBottom:6,color:"var(--t1)",fontWeight:600,fontSize:11}}>Step-by-step in Unipile dashboard:</div>
              <ol style={{paddingLeft:16,margin:0,color:"var(--t2)"}}>
                <li style={{marginBottom:6}}>Go to <a href="https://dashboard.unipile.com/webhooks" target="_blank" rel="noopener noreferrer" style={{color:"var(--blu)"}}>Unipile Dashboard → Webhooks</a> → <strong>Create a webhook</strong></li>
                <li style={{marginBottom:6}}>For <strong>name</strong>, use something like "SignalScope Messaging" so you can identify it later</li>
                <li style={{marginBottom:6}}>Pick category <strong style={{color:"var(--t1)"}}>Messaging</strong> → Continue</li>
                <li style={{marginBottom:6}}>Paste the URL above into the webhook URL field</li>
                <li style={{marginBottom:6}}>Enable event: <code style={{background:"var(--card)",padding:"1px 4px",borderRadius:2}}>message_received</code> (and <code style={{background:"var(--card)",padding:"1px 4px",borderRadius:2}}>message_reaction</code> if shown)</li>
                <li style={{marginBottom:6}}>Save</li>
                <li style={{marginBottom:6}}>Repeat: <strong>Create a webhook</strong> → name "SignalScope Connections" → category <strong style={{color:"var(--t1)"}}>Users</strong> → same URL → enable <code style={{background:"var(--card)",padding:"1px 4px",borderRadius:2}}>new_relation</code> (or <code style={{background:"var(--card)",padding:"1px 4px",borderRadius:2}}>users.relations.created</code>)</li>
                <li style={{marginBottom:6}}>Optional: 3rd webhook for post comments — IF Unipile lists <code style={{background:"var(--card)",padding:"1px 4px",borderRadius:2}}>post_comment</code> as an event. As of writing, this isn't visible in Unipile's UI categories. Skip if not available — manual <strong>🔄 Refresh from Unipile</strong> still pulls reactions and views.</li>
              </ol>

              <div style={{marginTop:12,padding:8,background:"rgba(91,143,212,.08)",border:"1px solid rgba(91,143,212,.3)",borderRadius:4,color:"var(--t2)",fontSize:10}}>
                <strong style={{color:"var(--blu)"}}>One URL, all clients.</strong> Routing happens internally based on which LinkedIn account fired the event — set up <strong>🔀 Account Routing</strong> below. Don't add a <code>&base=</code> parameter unless you want to override routing for a specific webhook (legacy mode).
              </div>

              <div style={{marginTop:10,padding:8,background:"rgba(191,163,90,.08)",border:"1px solid rgba(191,163,90,.3)",borderRadius:4,color:"var(--t2)",fontSize:10}}>
                <strong style={{color:"var(--amb)"}}>Test it:</strong> after saving, send yourself a LinkedIn DM from another account → check the 🔥 Triggers feed → a task should appear within ~5 seconds. If nothing shows, check 🚧 Unrouted Triggers below — the LinkedIn account_id may not be mapped yet.
              </div>
            </div>
          </details>
        )}
      </div>
    )}

    {/* ─── ACCOUNT ROUTING SECTION ─── */}
    {status?.accounts_count > 0 && (
      <div style={{marginBottom:14,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
        <button onClick={()=>setRoutingExpanded(e=>!e)} style={{width:"100%",padding:14,background:"transparent",border:"none",textAlign:"left",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",color:"var(--t1)"}}>
          <span style={{fontSize:12,fontWeight:600}}>🔀 Account Routing <span style={{color:"var(--t3)",fontWeight:400,marginLeft:6}}>— map each LinkedIn account to a client campaign</span></span>
          <span style={{color:"var(--t3)",fontSize:11}}>{routingExpanded ? "▾" : "▸"}</span>
        </button>
        {routingExpanded && (
          <div style={{padding:"0 14px 14px",borderTop:"1px solid var(--bdr)"}}>
            {routingLoading && !routingData && <div style={{padding:20,textAlign:"center",color:"var(--t3)",fontSize:11}}>Loading...</div>}
            {routingData && (
              <div>
                <div style={{fontSize:10,color:"var(--t3)",marginBottom:10,marginTop:10,lineHeight:1.5}}>
                  Each LinkedIn account connected to Unipile needs to be mapped to a campaign. Webhook events from that account will create tasks in the mapped campaign's base.
                  {routingData.campaigns.length === 0 && <div style={{color:"var(--amb)",marginTop:6}}>⚠️ No campaigns found in master base. Create campaigns first via SignalScope's main page.</div>}
                </div>
                <div style={{display:"flex",flexDirection:"column",gap:8}}>
                  {routingData.accounts.map(a => {
                    const isCurrent = !!a.routed_to_base_id;
                    const isSaving = routingSavingAcct === a.account_id;
                    return (
                      <div key={a.account_id} style={{padding:10,background:"var(--hover)",borderRadius:4,display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
                        <div style={{flex:1,minWidth:200}}>
                          <div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>{a.name}</div>
                          <div style={{fontSize:9,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace"}}>
                            {a.provider} · {a.account_id?.slice(0, 16)}{a.account_id?.length > 16 ? "..." : ""} · {a.status === "OK" || a.status === "active" ? <span style={{color:"var(--grn)"}}>active</span> : <span style={{color:"var(--amb)"}}>{a.status || "unknown"}</span>}
                          </div>
                        </div>
                        <div style={{display:"flex",gap:6,alignItems:"center"}}>
                          <select
                            value={a.routed_to_base_id || ""}
                            onChange={e => {
                              const v = e.target.value;
                              if (!v) return;
                              const camp = routingData.campaigns.find(c => c.baseId === v);
                              if (camp) saveRouting(a.account_id, a.name, camp);
                            }}
                            disabled={isSaving || routingData.campaigns.length === 0}
                            style={{padding:"5px 8px",background:"var(--card)",border:"1px solid var(--bdr)",color:"var(--t1)",borderRadius:4,fontSize:11,minWidth:160}}>
                            <option value="">{isSaving ? "Saving..." : isCurrent ? `→ ${a.routed_to_client || a.routed_to_base_id.slice(0,12)}` : "(unmapped — select campaign)"}</option>
                            {routingData.campaigns.map(c => (
                              <option key={c.baseId} value={c.baseId}>→ {c.name}</option>
                            ))}
                          </select>
                          {isCurrent && a.routing_record_id && (
                            <button className="btn btn-s btn-d" onClick={()=>deleteRouting(a.routing_record_id)} title="Remove routing">✕</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{marginTop:10,fontSize:10,color:"var(--t3)"}}>
                  💡 Edit <code>Account Routing</code> table directly in your master Airtable base ({routingData.accounts.length} accounts, {routingData.total_routed} mapped). Changes propagate within 2 minutes (cache TTL).
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )}

    {/* ─── UNROUTED EVENTS SECTION ─── */}
    <div style={{marginBottom:14,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
      <button onClick={()=>setUnroutedExpanded(e=>!e)} style={{width:"100%",padding:14,background:"transparent",border:"none",textAlign:"left",cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",color:"var(--t1)"}}>
        <span style={{fontSize:12,fontWeight:600}}>🚧 Unrouted Triggers <span style={{color:"var(--t3)",fontWeight:400,marginLeft:6}}>— events from accounts not yet mapped</span></span>
        <span style={{color:"var(--t3)",fontSize:11}}>{unroutedExpanded ? "▾" : "▸"}</span>
      </button>
      {unroutedExpanded && (
        <div style={{padding:"0 14px 14px",borderTop:"1px solid var(--bdr)"}}>
          {!unroutedData && <div style={{padding:20,textAlign:"center",color:"var(--t3)",fontSize:11}}>Loading...</div>}
          {unroutedData && unroutedData.unrouted?.length === 0 && (
            <div style={{padding:20,textAlign:"center",color:"var(--t3)",fontSize:11,marginTop:10}}>
              <div style={{fontSize:24,marginBottom:6}}>✓</div>
              No unrouted events. Either all your accounts are mapped, or no events have come in yet.
            </div>
          )}
          {unroutedData && unroutedData.unrouted?.length > 0 && (
            <div style={{marginTop:10}}>
              <div style={{fontSize:10,color:"var(--amb)",marginBottom:10}}>
                ⚠️ {unroutedData.unrouted.length} event{unroutedData.unrouted.length===1?"":"s"} dropped because the LinkedIn account_id wasn't found in your routing table. Add routing above to capture future events.
              </div>
              {unroutedData.by_account?.length > 0 && (
                <div style={{marginBottom:10,padding:10,background:"var(--hover)",borderRadius:4}}>
                  <div style={{fontSize:10,fontWeight:600,color:"var(--t2)",marginBottom:4}}>By account:</div>
                  {unroutedData.by_account.slice(0, 5).map(b => (
                    <div key={b.account_id} style={{fontSize:10,color:"var(--t3)",fontFamily:"'JetBrains Mono',monospace",marginBottom:2}}>
                      {b.account_id?.slice(0, 24) || "(no id)"}: <strong style={{color:"var(--t2)"}}>{b.count} events</strong>
                    </div>
                  ))}
                </div>
              )}
              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:240,overflowY:"auto"}}>
                {unroutedData.unrouted.slice(0, 30).map(u => (
                  <div key={u.id} style={{padding:8,background:"var(--hover)",borderRadius:4,fontSize:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",color:"var(--t2)"}}>
                      <span><strong>{u.event_type}</strong> · {u.lead_name || "(no lead name)"}</span>
                      <span style={{color:"var(--t3)"}}>{u.received ? new Date(u.received).toLocaleString() : ""}</span>
                    </div>
                    {u.signal_text && <div style={{color:"var(--t3)",marginTop:2,fontStyle:"italic"}}>"{u.signal_text.slice(0, 120)}"</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>

    {refreshResult && (
      <div style={{padding:12,background:refreshResult.ok?"rgba(93,168,122,.08)":"rgba(239,68,68,.08)",border:"1px solid "+(refreshResult.ok?"var(--grn)":"var(--red)"),borderRadius:6,marginBottom:14,fontSize:11,color:"var(--t2)"}}>
        {refreshResult.ok ? (
          <div>
            ✅ Refreshed — {refreshResult.accounts_checked} accounts checked, {refreshResult.profile_views_processed} profile views and {refreshResult.reactions_processed} reactions seen, {refreshResult.tasks_created} new triggers ({refreshResult.skipped_dupes} dupes skipped).
            {refreshResult.errors?.length > 0 && <div style={{marginTop:6,color:"var(--amb)"}}>⚠ {refreshResult.errors.length} errors during refresh — check Vercel logs</div>}
          </div>
        ) : (
          <div>❌ {refreshResult.error || "Refresh failed"}</div>
        )}
      </div>
    )}

    {/* Source filter pills + window selector */}
    <div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
      {[
        {id:"all",label:"All",count:counts.all},
        {id:"unipile",label:"🔗 Unipile",count:counts.unipile},
        {id:"ga",label:"📊 GA",count:counts.ga},
        {id:"posts",label:"📝 Posts",count:counts.posts},
      ].map(p => (
        <button key={p.id} onClick={()=>setSourceFilter(p.id)} className="btn btn-s" style={sourceFilter===p.id ? {background:"var(--amb)",color:"var(--bg)",borderColor:"var(--amb)"} : {}}>
          {p.label} <span style={{opacity:0.6,marginLeft:4}}>({p.count})</span>
        </button>
      ))}
      <div style={{marginLeft:"auto",fontSize:11,color:"var(--t3)"}}>
        Window: 
        <select value={windowDays} onChange={e=>setWindowDays(Number(e.target.value))} style={{marginLeft:6,padding:"4px 8px",background:"var(--card)",border:"1px solid var(--bdr)",color:"var(--t1)",borderRadius:4,fontSize:11}}>
          <option value={1}>Last 24h</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>
    </div>

    {/* ─── PER-ACCOUNT BREAKDOWN ───────────────────────────────
        Shows event volume by LinkedIn account so you can see at a glance
        which account is generating engagement. Click an account to filter
        the feed below to just that account's events. */}
    {accountBreakdown.length > 0 && (
      <div style={{marginBottom:14,padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div style={{fontSize:12,fontWeight:600,color:"var(--t1)"}}>👥 Activity by Account <span style={{color:"var(--t3)",fontWeight:400,marginLeft:6,fontSize:10}}>— click to filter feed</span></div>
          {accountFilter !== "all" && (
            <button className="btn btn-s" onClick={()=>setAccountFilter("all")} style={{fontSize:10}}>✕ Clear filter</button>
          )}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:8}}>
          {accountBreakdown.map(a => {
            const isSelected = accountFilter === a.accountId;
            const unmapped = a.name.startsWith("Unmapped ·");
            return (
              <button
                key={a.accountId}
                onClick={()=>setAccountFilter(isSelected ? "all" : a.accountId)}
                style={{
                  textAlign:"left",
                  padding:"10px 12px",
                  background: isSelected ? "var(--amb)" : "var(--hover)",
                  color: isSelected ? "var(--bg)" : "var(--t1)",
                  border: `1px solid ${isSelected ? "var(--amb)" : "var(--bdr)"}`,
                  borderRadius:6,
                  cursor:"pointer",
                  display:"flex",
                  flexDirection:"column",
                  gap:4,
                }}
                title={`account_id: ${a.accountId}`}
              >
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",gap:8}}>
                  <strong style={{fontSize:12,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {unmapped ? "⚠ " : ""}{a.name}
                  </strong>
                  <span style={{fontSize:16,fontWeight:700}}>{a.total}</span>
                </div>
                <div style={{fontSize:10,color:isSelected?"var(--bg)":"var(--t3)",display:"flex",flexWrap:"wrap",gap:6}}>
                  {Object.entries(a.byType)
                    .sort((x,y)=>y[1]-x[1])
                    .slice(0,4)
                    .map(([type, count]) => {
                      const lbl = triggerTypeLabels[type] || type.replace(/^unipile_/, "").replace(/_/g, " ");
                      return <span key={type} style={{opacity:0.85}}>{lbl}: <strong>{count}</strong></span>;
                    })}
                </div>
              </button>
            );
          })}
        </div>
        {accountBreakdown.some(a => a.name.startsWith("Unmapped ·")) && (
          <div style={{marginTop:10,fontSize:10,color:"var(--amb)"}}>
            ⚠ Some accounts aren't mapped to campaigns yet — open the 🔀 Account Routing panel above to assign them.
          </div>
        )}
      </div>
    )}

    {/* Triggers feed */}
    {loading ? (
      <div style={{padding:40,textAlign:"center",color:"var(--t3)"}}>Loading triggers...</div>
    ) : filteredTriggers.length === 0 ? (
      <div style={{padding:40,textAlign:"center",color:"var(--t3)",border:"1px dashed var(--bdr)",borderRadius:8}}>
        <div style={{fontSize:24,marginBottom:8}}>🤷</div>
        <div>No triggers in this window.</div>
        <div style={{fontSize:10,marginTop:6}}>Try clicking <strong>Poll Unipile Now</strong> or extend the time window above.</div>
      </div>
    ) : (
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {filteredTriggers.map(t => (
          <div key={t.id} style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:8}}>
              <div>
                <div style={{fontSize:13,fontWeight:600,color:"var(--t1)"}}>{t.name || "Unknown lead"}</div>
                <div style={{fontSize:11,color:"var(--t3)"}}>
                  {t.company || ""}{t.created ? ` · ${new Date(t.created).toLocaleString()}` : ""}
                  {t.account_id && <> · via <strong style={{color:"var(--t2)"}}>{labelForAccountId(t.account_id)}</strong></>}
                </div>
              </div>
              <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                <span style={{padding:"3px 8px",background:"var(--hover)",borderRadius:4,fontSize:10,color:"var(--t2)"}}>{triggerTypeLabels[t.task_type] || t.task_type}</span>
                <span style={{padding:"3px 8px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:4,fontSize:11,fontWeight:600,color:t.score >= 80 ? "var(--grn)" : t.score >= 50 ? "var(--amb)" : "var(--t2)",fontFamily:"'JetBrains Mono',monospace"}}>{t.score || 0}</span>
              </div>
            </div>
            {t.signal && (
              <div style={{padding:10,background:"var(--hover)",borderRadius:4,fontSize:10,color:"var(--t2)",whiteSpace:"pre-wrap",lineHeight:1.5,maxHeight:140,overflow:"auto"}}>{t.signal.slice(0, 600)}{t.signal.length > 600 ? "..." : ""}</div>
            )}
            {t.url && (
              <div style={{marginTop:8,fontSize:10}}>
                <a href={t.url} target="_blank" rel="noreferrer" style={{color:"var(--blu)"}}>🔗 view source →</a>
              </div>
            )}
          </div>
        ))}
      </div>
    )}
  </div>);
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// EMAIL CAMPAIGN TAB — Sender Profile + Offers Library + AI Generation
// ═══════════════════════════════════════════════════════════════
function EmailCampaignTab({ baseId, campaign, leads, prefilledLeadId }) {
  const [step, setStep] = useState(1); // 1=leads, 2=context, 3=generate, 4=review, 5=smartlead, 6=launch
  const [tags, setTags] = useState([]);
  const [selectedTag, setSelectedTag] = useState("");
  const [tagLeads, setTagLeads] = useState([]);
  const [selectedLeadIds, setSelectedLeadIds] = useState(new Set());
  const [prefilledNotice, setPrefilledNotice] = useState("");

  // Sender Profile (one per campaign, on Campaigns master table)
  const [senderProfile, setSenderProfile] = useState("");
  const [senderEditing, setSenderEditing] = useState(false);
  const [senderDraft, setSenderDraft] = useState("");
  const [senderSaving, setSenderSaving] = useState(false);

  // Offers library (per-campaign Email Offers table)
  const [offers, setOffers] = useState([]);
  const [selectedOfferId, setSelectedOfferId] = useState(null);
  const [offerForm, setOfferForm] = useState({ name: "", offerDescription: "", ctaLink: "", ctaPurpose: "" });
  const [showOfferModal, setShowOfferModal] = useState(false); // for creating/editing
  const [offerModalMode, setOfferModalMode] = useState("create"); // create | edit
  const [savingOffer, setSavingOffer] = useState(false);

  // Advanced (collapsed by default)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [referenceEmail, setReferenceEmail] = useState("");
  const [factors, setFactors] = useState({ name: true, title: true, company: true, industry: true, signals: true, companySize: true, location: false, linkedin: false, bio: false });

  // Sequence
  const [sequenceLength, setSequenceLength] = useState(1);
  const [delays] = useState([0, 3, 5, 7]);

  // Generation
  const [generating, setGenerating] = useState(false);
  const [generated, setGenerated] = useState([]);
  const [bulkFeedback, setBulkFeedback] = useState("");
  const [perLeadFeedback, setPerLeadFeedback] = useState({});

  // Smartlead
  const [slKey, setSlKey] = useState("");
  const [slMasked, setSlMasked] = useState("");
  const slKeyRef = useRef("");
  const [slCampaigns, setSlCampaigns] = useState([]);
  const [slMailboxes, setSlMailboxes] = useState([]);
  const [slMode, setSlMode] = useState("new");
  const [slCampaignName, setSlCampaignName] = useState("");
  const [slExistingCampaign, setSlExistingCampaign] = useState("");
  const [slMailboxIds, setSlMailboxIds] = useState(new Set());
  const [slSchedule, setSlSchedule] = useState({
    timezone: "America/New_York",
    days_of_the_week: [1,2,3,4,5],
    start_hour: "09:00",
    end_hour: "17:00",
    min_time_btw_emails: 10,
    max_new_leads_per_day: 20,
  });
  const [slSettings, setSlSettings] = useState({ stop_lead_settings: "REPLY_TO_AN_EMAIL", track_settings: ["DONT_TRACK_EMAIL_OPEN"], send_as_plain_text: false });
  const [activateOnLaunch, setActivateOnLaunch] = useState(false);

  const [launching, setLaunching] = useState(false);
  const [launchResult, setLaunchResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const ec = async (action, data = {}) => {
    const res = await fetch("/api/email-campaign", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, baseId, campaignId: campaign?.airtableId, ...data }),
    });
    return res.json();
  };

  // Load on mount: tags, sender profile, offers, smartlead key
  useEffect(() => {
    if (!baseId || !campaign?.airtableId) return;
    (async () => {
      try {
        const [t, sp, os, k] = await Promise.all([
          ec("list_campaign_tags"),
          ec("get_sender_profile"),
          ec("list_offers"),
          ec("get_smartlead_key"),
        ]);
        setTags(t.tags || []);
        setSenderProfile(sp.senderProfile || "");
        setSenderDraft(sp.senderProfile || "");
        setOffers(os.offers || []);
        if (k.hasKey) { setSlMasked(k.masked || ""); if (k.rawKey) slKeyRef.current = k.rawKey; }
      } catch (e) { console.error(e); }
    })();
  }, [baseId, campaign?.airtableId]);

  // Auto-select a specific lead when navigated here from "Send Email" button (GA tab)
  // IMPORTANT: only run once per prefilledLeadId. Don't re-fire when leads array updates
  // (which would reset the wizard while user is mid-flow).
  const prefillProcessedRef = useRef(null);
  useEffect(() => {
    if (!prefilledLeadId || !leads?.length) return;
    if (prefillProcessedRef.current === prefilledLeadId) return; // already processed this ID
    const lead = leads.find(l => l.id === prefilledLeadId);
    if (!lead) {
      setPrefilledNotice(`⚠️ Couldn't find the lead you selected — they may not have a Campaign Tag. Pick leads below.`);
      prefillProcessedRef.current = prefilledLeadId;
      return;
    }
    if (!lead.fields?.Email) {
      setPrefilledNotice(`⚠️ ${lead.fields?.Name || "Lead"} has no email address on file.`);
      prefillProcessedRef.current = prefilledLeadId;
      return;
    }
    // Bypass tag filter, set this lead as the only lead in the pool
    setTagLeads([lead]);
    setSelectedLeadIds(new Set([lead.id]));
    setSelectedTag(""); // Clear tag filter
    setStep(1); // Ensure we're on the leads step
    setPrefilledNotice(`✨ Prefilled from Google Analytics — sending to ${lead.fields?.Name || "lead"}. Continue with the flow below.`);
    prefillProcessedRef.current = prefilledLeadId;
  }, [prefilledLeadId, leads]);

  const loadTagLeads = async (tag) => {
    setBusy(true); setErr("");
    try {
      const r = await ec("list_leads_by_tag", { campaignTag: tag });
      setTagLeads(r.leads || []);
      setSelectedLeadIds(new Set((r.leads || []).map(l => l.id)));
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const saveSenderProfile = async () => {
    if (!senderDraft.trim()) { setErr("Sender profile cannot be empty"); return; }
    setSenderSaving(true); setErr("");
    try {
      const r = await ec("save_sender_profile", { senderProfile: senderDraft.trim() });
      if (r.ok) { setSenderProfile(senderDraft.trim()); setSenderEditing(false); }
      else setErr(r.error || "Save failed");
    } catch (e) { setErr(e.message); }
    setSenderSaving(false);
  };

  const openCreateOffer = () => {
    setOfferForm({ name: "", offerDescription: "", ctaLink: "", ctaPurpose: "" });
    setOfferModalMode("create");
    setShowOfferModal(true);
  };

  const openEditOffer = (o) => {
    const f = o.fields || {};
    setOfferForm({
      id: o.id,
      name: f.Name || "",
      offerDescription: f["Offer Description"] || "",
      ctaLink: f["CTA Link"] || "",
      ctaPurpose: f["CTA Purpose"] || "",
    });
    setOfferModalMode("edit");
    setShowOfferModal(true);
  };

  const saveOffer = async () => {
    if (!offerForm.name.trim()) { setErr("Offer name required"); return; }
    if (!offerForm.offerDescription.trim()) { setErr("What this offers is required"); return; }
    setSavingOffer(true); setErr("");
    try {
      const action = offerModalMode === "edit" ? "update_offer" : "save_offer";
      const payload = offerModalMode === "edit"
        ? { offerId: offerForm.id, name: offerForm.name, offerDescription: offerForm.offerDescription, ctaLink: offerForm.ctaLink, ctaPurpose: offerForm.ctaPurpose }
        : offerForm;
      const r = await ec(action, payload);
      if (r.ok) {
        const refresh = await ec("list_offers");
        setOffers(refresh.offers || []);
        setShowOfferModal(false);
        // If create, auto-select the new offer
        if (offerModalMode === "create") {
          const newest = (refresh.offers || []).find(o => o.fields?.Name === offerForm.name);
          if (newest) setSelectedOfferId(newest.id);
        }
      } else setErr(r.error || "Save failed");
    } catch (e) { setErr(e.message); }
    setSavingOffer(false);
  };

  const deleteOffer = async (offerId, name) => {
    if (!confirm(`Delete offer "${name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await ec("delete_offer", { offerId });
      const refresh = await ec("list_offers");
      setOffers(refresh.offers || []);
      if (selectedOfferId === offerId) setSelectedOfferId(null);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  // Get the active offer (for generating)
  const activeOffer = offers.find(o => o.id === selectedOfferId);
  const offerReady = !!activeOffer && !!senderProfile;

  const generateAll = async () => {
    if (selectedLeadIds.size === 0) { setErr("Select leads first"); return; }
    if (!senderProfile) { setErr("Sender profile is required — set it in Step 2"); setStep(2); return; }
    if (!activeOffer) { setErr("Pick or create an offer in Step 2"); setStep(2); return; }

    setGenerating(true); setErr(""); setGenerated([]);
    try {
      const f = activeOffer.fields || {};
      const config = {
        senderProfile,
        purpose: f["Offer Description"] || "",
        ctaLink: f["CTA Link"] || "",
        ctaPurpose: f["CTA Purpose"] || "",
        referenceEmail: referenceEmail || "",
        sequenceLength,
      };
      const r = await ec("generate_emails", {
        leadIds: [...selectedLeadIds],
        config,
        factors,
      });
      if (r.error) { setErr(r.error); setGenerating(false); return; }
      setGenerated(r.results || []);
      // Mark offer as used
      try { await ec("update_offer", { offerId: activeOffer.id, markUsed: true }); } catch {}
      setStep(4);
    } catch (e) { setErr(e.message); }
    setGenerating(false);
  };

  const regenerateSingle = async (leadId) => {
    if (!activeOffer) { setErr("Active offer is missing — go back to Step 2 and pick one"); return; }
    if (!senderProfile) { setErr("Sender profile is missing — set it in Step 2"); return; }
    const fb = perLeadFeedback[leadId] || "";
    setBusy(true); setErr("");
    try {
      const f = activeOffer.fields || {};
      const config = {
        senderProfile,
        purpose: f["Offer Description"] || "",
        ctaLink: f["CTA Link"] || "",
        ctaPurpose: f["CTA Purpose"] || "",
        referenceEmail: referenceEmail || "",
        sequenceLength,
      };
      const r = await ec("regenerate_email", { leadId, config, factors, feedback: fb });
      if (r.ok) {
        setGenerated(p => p.map(g => g.leadId === leadId ? r : g));
        setPerLeadFeedback(p => ({ ...p, [leadId]: "" }));
      } else setErr(r.error || "Regen failed");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const regenerateAll = async () => {
    if (!bulkFeedback.trim()) { setErr("Write some feedback first (e.g. 'make it shorter', 'less salesy')"); return; }
    if (!activeOffer) { setErr("Active offer is missing — go back to Step 2 and pick one"); return; }
    if (!senderProfile) { setErr("Sender profile is missing — set it in Step 2"); return; }
    // Cost guard: regenerating all leads costs money. Warn for large batches.
    const count = generated.length;
    const seqLen = sequenceLength || 1;
    // Rough estimate: ~1500 input tokens (cached) + ~500 output per email × seqLen
    // Sonnet 4.6: $3/M input, $15/M output. With caching, input ~$0.30/M effective.
    const estInputTokens = count * 1500;
    const estOutputTokens = count * 500 * seqLen;
    const estCost = (estInputTokens / 1_000_000 * 0.30) + (estOutputTokens / 1_000_000 * 15);
    if (count > 10) {
      if (!confirm(`Regenerate ALL ${count} email${count === 1 ? "" : "s"} with this feedback?\n\nFeedback: "${bulkFeedback.slice(0, 100)}${bulkFeedback.length > 100 ? "..." : ""}"\n\nEstimated cost: ~$${estCost.toFixed(2)}\n\nIf you only want to apply feedback to specific leads, use the per-lead "Regenerate" button instead.`)) return;
    }
    setGenerating(true); setErr("");
    try {
      const f = activeOffer.fields || {};
      const config = {
        senderProfile,
        purpose: f["Offer Description"] || "",
        ctaLink: f["CTA Link"] || "",
        ctaPurpose: f["CTA Purpose"] || "",
        referenceEmail: referenceEmail || "",
        sequenceLength,
      };
      const out = [];
      let regenFailed = 0;
      for (const g of generated) {
        const r2 = await ec("regenerate_email", { leadId: g.leadId, config, factors, feedback: bulkFeedback });
        if (r2.ok) {
          out.push(r2);
        } else {
          regenFailed++;
          out.push(g); // keep original on failure
        }
      }
      setGenerated(out);
      setBulkFeedback("");
      if (regenFailed > 0) setErr(`⚠️ ${regenFailed} of ${generated.length} regenerations failed — those kept their previous version`);
    } catch (e) { setErr(e.message); }
    setGenerating(false);
  };

  const connectSmartlead = async () => {
    if (!slKey) { setErr("Enter API key"); return; }
    setBusy(true); setErr("");
    try {
      const r = await ec("save_smartlead_key", { apiKey: slKey });
      if (r.ok) { slKeyRef.current = slKey; setSlMasked(r.masked); setSlKey(""); await loadSlData(); }
      else setErr(r.error || "Failed");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const loadSlData = async () => {
    if (!slKeyRef.current) return;
    setBusy(true);
    try {
      const [c, a] = await Promise.all([
        ec("list_smartlead_campaigns", { apiKey: slKeyRef.current }),
        ec("list_smartlead_email_accounts", { apiKey: slKeyRef.current }),
      ]);
      setSlCampaigns(c.campaigns || []);
      setSlMailboxes(a.accounts || []);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  useEffect(() => { if (slKeyRef.current && step === 5) loadSlData(); }, [step]);

  const launchCampaign = async (overrides = {}) => {
    const validEmails = generated.filter(g => g.ok && g.email);
    const failedGen = generated.filter(g => !g.ok);
    const noEmail = generated.filter(g => g.ok && !g.email);
    if (validEmails.length === 0) { setErr("No valid emails to launch"); return; }
    if (slMode === "new" && !slCampaignName) { setErr("Campaign name required"); return; }
    if (slMode === "new" && slMailboxIds.size === 0) { setErr("Pick at least one mailbox"); return; }

    // Build a transparent pre-launch summary
    const droppedNote = (failedGen.length || noEmail.length)
      ? `\n\n⚠️ DROPPED (won't be sent):\n• ${failedGen.length} generation failure${failedGen.length === 1 ? "" : "s"}\n• ${noEmail.length} missing email address${noEmail.length === 1 ? "" : "es"}`
      : "";
    const confirmMsg = `Launch ${validEmails.length} of ${generated.length} emails via Smartlead?\n\nMode: ${slMode === "new" ? `New campaign "${slCampaignName}"` : `Add to existing campaign ${slExistingCampaign}`}\nMailboxes: ${slMailboxIds.size}\nSequence: ${sequenceLength} step${sequenceLength !== 1 ? "s" : ""}\n${activateOnLaunch ? "⚠️ Will ACTIVATE & start sending" : "Will create as DRAFT (you must activate manually in Smartlead)"}${droppedNote}`;
    if (!overrides.skipConfirm && !confirm(confirmMsg)) return;

    setLaunching(true); setErr(""); setLaunchResult(null);
    try {
      const r = await ec("launch_smartlead_campaign", {
        apiKey: slKeyRef.current,
        mode: slMode,
        existingCampaignId: slMode === "existing" ? slExistingCampaign : null,
        campaignName: slCampaignName,
        emailAccountIds: [...slMailboxIds],
        schedule: slSchedule,
        settings: slSettings,
        generatedEmails: validEmails,
        sequenceConfig: { length: sequenceLength, delays },
        activate: activateOnLaunch,
        allowSequenceMismatch: overrides.allowSequenceMismatch || false,
        allowPlaceholderMismatch: overrides.allowPlaceholderMismatch || false,
      });

      // Backend may return requiresConfirmation when launching into existing campaign with mismatches
      if (r.requiresConfirmation) {
        const proceed = confirm(`⚠️ ${r.error}\n\nProceed anyway? (Some emails may not send correctly.)`);
        setLaunching(false);
        if (proceed) {
          // Re-launch with the appropriate override flag
          const newOverrides = { ...overrides, skipConfirm: true };
          if (r.placeholderIssues) newOverrides.allowPlaceholderMismatch = true;
          if (typeof r.existingSeqCount === "number") newOverrides.allowSequenceMismatch = true;
          return launchCampaign(newOverrides);
        }
        setErr("Launch cancelled");
        return;
      }

      setLaunchResult(r);
      if (r.ok) {
        setStep(6);
        if (r.warning) setErr(r.warning); // surface activation warnings prominently
      } else {
        setErr(r.error || "Launch failed");
      }
    } catch (e) { setErr(e.message); }
    setLaunching(false);
  };

  const toggleLead = (id) => setSelectedLeadIds(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleMailbox = (id) => setSlMailboxIds(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const stepLabels = ["Pick Leads", "Set Context", "Generate", "Review", "Smartlead", "Launch"];

  // Step 2 readiness check — must have sender profile + offer selected
  const canAdvanceFromStep2 = !!senderProfile && !!selectedOfferId;

  return (<div>
    <div className="ph"><div><div className="pt">📧 Email Campaign</div><div className="pd">AI-personalized cold email campaigns via Smartlead</div></div></div>

    {/* Step indicator */}
    <div style={{display:"flex",gap:4,marginBottom:24,padding:12,background:"var(--card)",borderRadius:10}}>
      {stepLabels.map((label, i) => {
        const num = i + 1;
        const isActive = step === num;
        const isDone = step > num;
        return (
          <div key={i} style={{flex:1,padding:"8px 10px",borderRadius:6,background:isActive?"var(--acc-d)":isDone?"var(--grn-d)":"var(--hover)",cursor:isDone?"pointer":"default"}} onClick={()=>{if(isDone)setStep(num)}}>
            <div style={{fontSize:9,color:isActive?"var(--acc)":isDone?"var(--grn)":"var(--t3)",fontWeight:600}}>{isDone?"✓":num}. {label}</div>
          </div>
        );
      })}
    </div>

    {err && <div style={{padding:"10px 14px",background:"var(--red-d)",color:"var(--red)",borderRadius:8,marginBottom:16,fontSize:11,whiteSpace:"pre-wrap"}}>{err}</div>}

    {/* ───────────────── STEP 1: PICK LEADS ───────────────── */}
    {step===1 && (<div>
      {prefilledNotice && (
        <div style={{padding:12,background:prefilledNotice.startsWith("✨")?"var(--acc-d)":"var(--red-d)",border:"1px solid "+(prefilledNotice.startsWith("✨")?"var(--acc)":"var(--red)"),borderRadius:8,marginBottom:14,fontSize:12,color:prefilledNotice.startsWith("✨")?"var(--acc)":"var(--red)",lineHeight:1.5}}>
          {prefilledNotice}
        </div>
      )}
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>👋 Welcome — let's send some emails</div>
        <div style={{fontSize:11,color:"var(--t2)",lineHeight:1.6}}>This wizard takes you through 6 steps. First, pick which group of leads to email — these are your imported lead lists tagged by Campaign Tag (set when you uploaded the CSV).</div>
      </div>

      <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:"var(--t1)"}}>Step 1 · Which list do you want to email?</div>
      {tags.length === 0 ? (
        <div className="empty"><div className="em">📭</div><p>No campaign tags found. Upload leads from the Leads tab first — make sure to add a Campaign Tag while importing.</p></div>
      ) : (
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10,marginBottom:20}}>
          {tags.map(t => (
            <div key={t.tag} onClick={()=>{setSelectedTag(t.tag);loadTagLeads(t.tag)}} style={{padding:"14px 16px",border:"1px solid "+(selectedTag===t.tag?"var(--acc)":"var(--bdr)"),background:selectedTag===t.tag?"var(--acc-d)":"var(--card)",borderRadius:8,cursor:"pointer"}}>
              <div style={{fontSize:13,fontWeight:600,color:selectedTag===t.tag?"var(--acc)":"var(--t1)"}}>{t.tag}</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>{t.count} lead{t.count!==1?"s":""}</div>
            </div>
          ))}
        </div>
      )}

      {tagLeads.length > 0 && (<div>
        <div style={{padding:10,background:"var(--hover)",borderRadius:6,marginBottom:10,fontSize:11,color:"var(--t2)"}}>
          ✓ Loaded <strong>{tagLeads.length} leads</strong> with email addresses · {selectedLeadIds.size} selected · uncheck any you want to skip
        </div>
        <div style={{display:"flex",gap:8,marginBottom:8}}>
          <button className="btn btn-s" onClick={()=>setSelectedLeadIds(new Set(tagLeads.map(l=>l.id)))}>Select All</button>
          <button className="btn btn-s" onClick={()=>setSelectedLeadIds(new Set())}>Clear</button>
        </div>
        <div style={{maxHeight:300,overflowY:"auto",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
          <table><thead><tr><th style={{width:32}}></th><th>Name</th><th>Email</th><th>Title</th><th>Company</th></tr></thead>
          <tbody>{tagLeads.slice(0,500).map(l=>{const f=l.fields||{};const sel=selectedLeadIds.has(l.id);return (<tr key={l.id} onClick={()=>toggleLead(l.id)} style={{cursor:"pointer",background:sel?"var(--acc-d)":""}}>
            <td><input type="checkbox" checked={sel} onChange={()=>toggleLead(l.id)} onClick={e=>e.stopPropagation()}/></td>
            <td style={{color:"var(--t1)"}}>{f.Name}</td><td style={{fontSize:10,color:"var(--blu)"}}>{f.Email}</td><td style={{fontSize:10}}>{f.Title}</td><td style={{fontSize:10}}>{f.Company}</td>
          </tr>);})}</tbody></table>
        </div>
        <button className="btn btn-p" disabled={selectedLeadIds.size===0} onClick={()=>setStep(2)}>Next: Set Context →</button>
      </div>)}
    </div>)}

    {/* ───────────────── STEP 2: CONTEXT (Sender + Offer) ───────────────── */}
    {step===2 && (<div>
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>📝 Set the email context</div>
        <div style={{fontSize:11,color:"var(--t2)",lineHeight:1.6}}>Two things are needed: <strong>who you are</strong> (set once, reused forever) and <strong>what this campaign offers</strong> (pick a saved offer or create a new one). The AI uses both to personalize emails.</div>
      </div>

      {/* ──────── SENDER PROFILE ──────── */}
      <div style={{padding:16,background:senderProfile?"var(--card)":"var(--amb-d)",border:"1px solid "+(senderProfile?"var(--bdr)":"rgba(212,165,89,.4)"),borderRadius:10,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <div>
            <div style={{fontSize:12,fontWeight:600,color:senderProfile?"var(--t1)":"var(--amb)"}}>👤 Who you are</div>
            <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>One sentence about your company. Set once per campaign — the AI uses this in every email.</div>
          </div>
          {senderProfile && !senderEditing && (
            <button className="btn btn-s" onClick={()=>{setSenderEditing(true);setSenderDraft(senderProfile)}}>✏️ Edit</button>
          )}
        </div>

        {!senderProfile && !senderEditing && (
          <div>
            <div style={{padding:10,background:"var(--card)",borderRadius:6,fontSize:11,color:"var(--t3)",fontStyle:"italic",marginBottom:8}}>
              <strong>Example:</strong> "Side Kick — AI-powered SDR infrastructure for B2B SaaS founders who want pipeline without hiring SDRs"
            </div>
            <textarea className="inp" value={senderDraft} onChange={e=>setSenderDraft(e.target.value)} placeholder="e.g. Volopay — corporate cards built for field-based businesses (construction, logistics, facilities)" style={{minHeight:60}}/>
            <button className="btn btn-p btn-s" disabled={senderSaving||!senderDraft.trim()} onClick={saveSenderProfile} style={{marginTop:8}}>{senderSaving?"⏳ Saving…":"💾 Save Sender Profile"}</button>
          </div>
        )}

        {senderProfile && !senderEditing && (
          <div style={{padding:10,background:"var(--hover)",borderRadius:6,fontSize:11,color:"var(--t1)",lineHeight:1.5}}>
            ✓ {senderProfile}
          </div>
        )}

        {senderEditing && (
          <div>
            <textarea className="inp" value={senderDraft} onChange={e=>setSenderDraft(e.target.value)} style={{minHeight:60}}/>
            <div style={{display:"flex",gap:6,marginTop:8}}>
              <button className="btn btn-p btn-s" disabled={senderSaving} onClick={saveSenderProfile}>{senderSaving?"⏳":"💾 Save"}</button>
              <button className="btn btn-s" onClick={()=>{setSenderEditing(false);setSenderDraft(senderProfile)}}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* ──────── OFFER LIBRARY ──────── */}
      <div style={{padding:16,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
          <div>
            <div style={{fontSize:12,fontWeight:600,color:"var(--t1)"}}>🎯 Pick a campaign offer</div>
            <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>What you're pitching with this email batch. Reusable — saved offers can be picked instantly next time.</div>
          </div>
          <button className="btn btn-p btn-s" onClick={openCreateOffer}>+ New Offer</button>
        </div>

        {offers.length === 0 ? (
          <div style={{padding:14,background:"var(--hover)",borderRadius:8,textAlign:"center"}}>
            <div style={{fontSize:11,color:"var(--t2)",marginBottom:8}}>No offers saved yet. Create your first one — it'll be saved for future use.</div>
            <button className="btn btn-p btn-s" onClick={openCreateOffer}>+ Create First Offer</button>
          </div>
        ) : (
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:8}}>
            {offers.map(o => {
              const f = o.fields || {};
              const isSelected = selectedOfferId === o.id;
              return (
                <div key={o.id} style={{position:"relative",border:"1px solid "+(isSelected?"var(--acc)":"var(--bdr)"),background:isSelected?"var(--acc-d)":"var(--hover)",borderRadius:8,padding:"8px 12px",cursor:"pointer",minWidth:140,maxWidth:200}} onClick={()=>setSelectedOfferId(o.id)}>
                  <div style={{fontSize:11,fontWeight:600,color:isSelected?"var(--acc)":"var(--t1)",marginBottom:2}}>{f.Name || "Untitled"}</div>
                  <div style={{fontSize:9,color:"var(--t3)",lineHeight:1.4,maxHeight:30,overflow:"hidden"}}>{(f["Offer Description"] || "").slice(0,60)}{(f["Offer Description"]||"").length>60?"…":""}</div>
                  <div style={{display:"flex",gap:4,marginTop:6,opacity:isSelected?1:0.6}}>
                    <button className="btn btn-s" style={{fontSize:9,padding:"2px 6px"}} onClick={e=>{e.stopPropagation();openEditOffer(o)}}>✏️</button>
                    <button className="btn btn-s" style={{fontSize:9,padding:"2px 6px"}} onClick={e=>{e.stopPropagation();deleteOffer(o.id, f.Name)}}>🗑️</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeOffer && (
          <div style={{marginTop:10,padding:12,background:"var(--hover)",borderRadius:8}}>
            <div style={{fontSize:10,color:"var(--acc)",fontWeight:600,marginBottom:4}}>USING: {activeOffer.fields?.Name}</div>
            <div style={{fontSize:11,color:"var(--t1)",lineHeight:1.5,marginBottom:6}}>{activeOffer.fields?.["Offer Description"]}</div>
            <div style={{fontSize:10,color:"var(--t2)"}}>CTA: <a href={activeOffer.fields?.["CTA Link"]} target="_blank" rel="noopener" style={{color:"var(--blu)"}}>{activeOffer.fields?.["CTA Link"]}</a> — {activeOffer.fields?.["CTA Purpose"]}</div>
          </div>
        )}
      </div>

      {/* ──────── SEQUENCE LENGTH ──────── */}
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:14}}>
        <div style={{fontSize:12,fontWeight:600,marginBottom:6}}>📨 Sequence length</div>
        <div style={{fontSize:10,color:"var(--t3)",marginBottom:8}}>1 = single email · 2-4 = initial + follow-ups generated together (each follow-up references previous)</div>
        <div style={{display:"flex",gap:6}}>
          {[1,2,3,4].map(n => (
            <button key={n} className={"btn btn-s"+(sequenceLength===n?" btn-p":"")} onClick={()=>setSequenceLength(n)}>{n} email{n!==1?"s":""}</button>
          ))}
        </div>
      </div>

      {/* ──────── ADVANCED (collapsed) ──────── */}
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
        <div onClick={()=>setShowAdvanced(!showAdvanced)} style={{cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <div>
            <div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>{showAdvanced?"▾":"▸"} Advanced (optional)</div>
            <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>Reference email & personalization factor controls — most users can skip</div>
          </div>
        </div>
        {showAdvanced && (
          <div style={{marginTop:14,paddingTop:14,borderTop:"1px solid var(--bdr)"}}>
            <div className="ig">
              <div className="il">Reference Email <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— optional, AI matches its tone/structure</span></div>
              <textarea className="inp" value={referenceEmail} onChange={e=>setReferenceEmail(e.target.value)} style={{minHeight:80}} placeholder="Paste a past email that worked well — leave blank if you don't have one"/>
            </div>
            <div className="ig">
              <div className="il">Personalization Factors <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— what AI uses about each lead</span></div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(140px,1fr))",gap:6,padding:10,background:"var(--hover)",borderRadius:6}}>
                {Object.keys(factors).map(k => (
                  <label key={k} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,cursor:"pointer"}}>
                    <input type="checkbox" checked={factors[k]} onChange={e=>setFactors(p=>({...p,[k]:e.target.checked}))}/>
                    <span style={{color:factors[k]?"var(--t1)":"var(--t3)"}}>{k.replace(/([A-Z])/g," $1").toLowerCase()}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={{display:"flex",gap:8}}>
        <button className="btn" onClick={()=>setStep(1)}>← Back</button>
        <button className="btn btn-p" disabled={!canAdvanceFromStep2} onClick={()=>setStep(3)}>{!canAdvanceFromStep2?(senderProfile?"Pick or create an offer ↑":"Set sender profile ↑"):"Next: Generate →"}</button>
      </div>
    </div>)}

    {/* ───────────────── STEP 3: GENERATE (confirmation) ───────────────── */}
    {step===3 && (<div>
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>✨ Ready to generate</div>
        <div style={{fontSize:11,color:"var(--t2)",lineHeight:1.6}}>Claude (Sonnet 4.6) will write {sequenceLength === 1 ? "one personalized email" : `${sequenceLength} emails (initial + ${sequenceLength - 1} follow-ups)`} for each lead, using the sender profile and offer you set. Takes about {Math.ceil(selectedLeadIds.size * 2 / 60)} minute{Math.ceil(selectedLeadIds.size * 2 / 60)!==1?"s":""}.</div>
      </div>

      <div style={{padding:16,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginBottom:16}}>
        <div style={{fontSize:11,marginBottom:8}}><strong style={{color:"var(--t3)"}}>List:</strong> {selectedTag} · {selectedLeadIds.size} leads</div>
        <div style={{fontSize:11,marginBottom:8}}><strong style={{color:"var(--t3)"}}>Sender:</strong> {senderProfile.slice(0,80)}{senderProfile.length>80?"…":""}</div>
        <div style={{fontSize:11,marginBottom:8}}><strong style={{color:"var(--t3)"}}>Offer:</strong> {activeOffer?.fields?.Name}</div>
        <div style={{fontSize:11,marginBottom:8}}><strong style={{color:"var(--t3)"}}>Sequence:</strong> {sequenceLength} email{sequenceLength!==1?"s":""}</div>
        <div style={{fontSize:11}}><strong style={{color:"var(--t3)"}}>Personalization:</strong> {Object.keys(factors).filter(k=>factors[k]).join(", ")}</div>
      </div>

      <div style={{display:"flex",gap:8}}>
        <button className="btn" onClick={()=>setStep(2)}>← Back</button>
        <button className="btn btn-p" disabled={generating} onClick={generateAll}>{generating?`⏳ Generating ${selectedLeadIds.size} email${selectedLeadIds.size!==1?"s":""}…`:`✨ Generate ${selectedLeadIds.size} email${selectedLeadIds.size!==1?"s":""}`}</button>
      </div>
    </div>)}

    {/* ───────────────── STEP 4: REVIEW ───────────────── */}
    {step===4 && (<div>
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>👀 Review the emails</div>
        <div style={{fontSize:11,color:"var(--t2)",lineHeight:1.6}}>Each lead got a personalized email. To improve all of them at once, write feedback below and click Regenerate All. To improve just one, use the per-lead feedback box.</div>
      </div>

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <div style={{fontSize:11,color:"var(--t2)"}}>
          <strong style={{color:"var(--grn)"}}>{generated.filter(g=>g.ok&&g.email).length}</strong> ready
          {generated.filter(g=>!g.ok).length > 0 && <> · <strong style={{color:"var(--red)"}}>{generated.filter(g=>!g.ok).length}</strong> failed</>}
          {generated.filter(g=>g.ok&&!g.email).length > 0 && <> · <strong style={{color:"var(--amb)"}}>{generated.filter(g=>g.ok&&!g.email).length}</strong> no email</>}
          <> / {generated.length} total</>
        </div>
        {generated.filter(g=>!g.ok).length > 0 && (
          <button className="btn btn-s" disabled={generating} onClick={async()=>{
            const failed = generated.filter(g=>!g.ok);
            if (!confirm(`Retry generation for ${failed.length} failed lead${failed.length===1?"":"s"}?`)) return;
            setGenerating(true);
            try {
              const f = activeOffer.fields || {};
              const config = { senderProfile, purpose: f["Offer Description"] || "", ctaLink: f["CTA Link"] || "", ctaPurpose: f["CTA Purpose"] || "", referenceEmail: referenceEmail || "", sequenceLength };
              const out = [...generated];
              for (const g of failed) {
                const r2 = await ec("regenerate_email", { leadId: g.leadId, config, factors, feedback: "" });
                if (r2.ok) {
                  const idx = out.findIndex(x => x.leadId === g.leadId);
                  if (idx >= 0) out[idx] = r2;
                }
              }
              setGenerated(out);
            } catch (e) { setErr(e.message); }
            setGenerating(false);
          }}>{generating?"⏳":"🔁 Retry Failed"}</button>
        )}
      </div>

      {/* Bulk regen */}
      <div style={{padding:12,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:600,marginBottom:6}}>🔄 Improve all emails with feedback</div>
        <div style={{display:"flex",gap:8}}>
          <input className="inp" placeholder="e.g. make them shorter, less salesy, mention their funding round…" value={bulkFeedback} onChange={e=>setBulkFeedback(e.target.value)} style={{flex:1}}/>
          <button className="btn btn-s" disabled={generating||!bulkFeedback} onClick={regenerateAll}>{generating?"⏳":"Regenerate All"}</button>
        </div>
      </div>

      <div style={{maxHeight:500,overflowY:"auto",display:"flex",flexDirection:"column",gap:10,marginBottom:16}}>
        {generated.map(g => (
          <div key={g.leadId} style={{padding:14,background:"var(--card)",border:"1px solid "+(g.ok?"var(--bdr)":"rgba(196,92,92,.4)"),borderRadius:8}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:8}}>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:"var(--t1)"}}>{g.name}</div>
                <div style={{fontSize:10,color:"var(--t3)"}}>{g.email} · {g.title} @ {g.company}</div>
              </div>
              {!g.ok && <span style={{fontSize:10,color:"var(--red)"}}>❌ {g.error}</span>}
            </div>
            {g.ok && g.emails && g.emails.map((e, i) => (
              <div key={i} style={{padding:10,background:"var(--hover)",borderRadius:6,marginBottom:6}}>
                {g.emails.length > 1 && <div style={{fontSize:9,color:"var(--acc)",fontWeight:600,marginBottom:4}}>{i===0?"INITIAL":`FOLLOW-UP ${i}`} {i>0&&`· Day ${delays.slice(1,i+1).reduce((a,b)=>a+b,0)}`}</div>}
                <div style={{fontSize:11,fontWeight:600,marginBottom:4}}>Subject: {e.subject}</div>
                <div style={{fontSize:11,color:"var(--t2)",whiteSpace:"pre-wrap",lineHeight:1.5}}>{e.body}</div>
              </div>
            ))}
            {g.ok && (
              <div style={{display:"flex",gap:6,marginTop:8}}>
                <input className="inp" placeholder="Feedback for just this lead's email…" value={perLeadFeedback[g.leadId]||""} onChange={e=>setPerLeadFeedback(p=>({...p,[g.leadId]:e.target.value}))} style={{flex:1,fontSize:10}}/>
                <button className="btn btn-s" disabled={busy} onClick={()=>regenerateSingle(g.leadId)}>{busy?"⏳":"🔄"}</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{display:"flex",gap:8}}>
        <button className="btn" onClick={()=>setStep(3)}>← Back</button>
        <button className="btn btn-p" disabled={generated.filter(g=>g.ok).length===0} onClick={()=>setStep(5)}>Approve {generated.filter(g=>g.ok).length} & Continue →</button>
      </div>
    </div>)}

    {/* ───────────────── STEP 5: SMARTLEAD ───────────────── */}
    {step===5 && (<div>
      <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
        <div style={{fontSize:13,fontWeight:600,marginBottom:6}}>📤 Smartlead Setup</div>
        <div style={{fontSize:11,color:"var(--t2)",lineHeight:1.6}}>Smartlead handles the actual sending — mailbox rotation, scheduling, deliverability. Connect once and it's saved for future campaigns.</div>
      </div>

      {!slMasked ? (
        <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:16}}>
          <div style={{fontSize:12,fontWeight:600,marginBottom:8}}>1. Connect Smartlead</div>
          <div style={{fontSize:11,marginBottom:8,color:"var(--t3)"}}>Get your API key from <a href="https://app.smartlead.ai/app/settings/profile" target="_blank" rel="noopener" style={{color:"var(--blu)"}}>app.smartlead.ai/app/settings/profile</a></div>
          <div style={{display:"flex",gap:8}}>
            <input className="inp" type="password" placeholder="Paste Smartlead API key" value={slKey} onChange={e=>setSlKey(e.target.value)} style={{flex:1}}/>
            <button className="btn btn-p btn-s" disabled={busy||!slKey} onClick={connectSmartlead}>{busy?"⏳":"Connect"}</button>
          </div>
        </div>
      ) : (
        <div style={{padding:10,background:"var(--grn-d)",color:"var(--grn)",borderRadius:8,marginBottom:16,fontSize:11,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span>✅ Smartlead connected: {slMasked}</span>
          <button className="btn btn-s" onClick={loadSlData} disabled={busy}>{busy?"⏳":"↻ Refresh"}</button>
        </div>
      )}

      {slMasked && (<div>
        {/* Mode */}
        <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:14}}>
          <div style={{fontSize:11,fontWeight:600,marginBottom:6}}>2. Campaign Mode</div>
          <div style={{fontSize:10,color:"var(--t3)",marginBottom:8}}>Create a brand new Smartlead campaign or add these leads to one that already exists</div>
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            <button className={"btn btn-s"+(slMode==="new"?" btn-p":"")} onClick={()=>setSlMode("new")}>➕ Create New</button>
            <button className={"btn btn-s"+(slMode==="existing"?" btn-p":"")} onClick={()=>setSlMode("existing")}>📂 Add to Existing</button>
          </div>

          {slMode === "new" ? (
            <input className="inp" placeholder="Campaign name (e.g. Q2 Construction Outreach)" value={slCampaignName} onChange={e=>setSlCampaignName(e.target.value)}/>
          ) : (
            <select className="inp" value={slExistingCampaign} onChange={e=>setSlExistingCampaign(e.target.value)}>
              <option value="">Pick a Smartlead campaign…</option>
              {slCampaigns.map(c => <option key={c.id} value={c.id}>{c.name} ({c.status})</option>)}
            </select>
          )}
        </div>

        {slMode === "new" && (<>
          {/* Mailboxes */}
          <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:600,marginBottom:6}}>3. Pick Mailboxes ({slMailboxIds.size} selected)</div>
            <div style={{fontSize:10,color:"var(--t3)",marginBottom:8}}>These email accounts will rotate sending. Pick warmed-up accounts only.</div>
            <div style={{maxHeight:160,overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
              {slMailboxes.map(m => (
                <label key={m.id} style={{display:"flex",alignItems:"center",gap:8,padding:6,borderRadius:4,background:slMailboxIds.has(m.id)?"var(--acc-d)":"transparent",cursor:"pointer"}}>
                  <input type="checkbox" checked={slMailboxIds.has(m.id)} onChange={()=>toggleMailbox(m.id)}/>
                  <span style={{fontSize:11,flex:1}}>{m.from_email || m.from_name || m.email} <span style={{color:"var(--t3)",fontSize:9}}>· {m.warmup_details?.status || ""}</span></span>
                </label>
              ))}
              {slMailboxes.length === 0 && <div style={{fontSize:10,color:"var(--t3)"}}>No mailboxes found in Smartlead — add some at app.smartlead.ai first</div>}
            </div>
          </div>

          {/* Schedule */}
          <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:600,marginBottom:6}}>4. Schedule</div>
            <div style={{fontSize:10,color:"var(--t3)",marginBottom:8}}>When and how fast Smartlead will send. Defaults are safe.</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
              <div>
                <div style={{fontSize:10,color:"var(--t3)",marginBottom:2}}>Timezone</div>
                <select className="inp" value={slSchedule.timezone} onChange={e=>setSlSchedule(p=>({...p,timezone:e.target.value}))}>
                  <option value="America/New_York">ET (New York)</option>
                  <option value="America/Los_Angeles">PT (Los Angeles)</option>
                  <option value="America/Chicago">CT (Chicago)</option>
                  <option value="Europe/London">UK</option>
                  <option value="Asia/Kolkata">IST</option>
                </select>
              </div>
              <div>
                <div style={{fontSize:10,color:"var(--t3)",marginBottom:2}}>Days/Week</div>
                <select className="inp" value={slSchedule.days_of_the_week.join(",")} onChange={e=>setSlSchedule(p=>({...p,days_of_the_week:e.target.value.split(",").map(Number)}))}>
                  <option value="1,2,3,4,5">Mon-Fri</option>
                  <option value="0,1,2,3,4,5,6">All days</option>
                  <option value="1,2,3,4">Mon-Thu</option>
                </select>
              </div>
              <div>
                <div style={{fontSize:10,color:"var(--t3)",marginBottom:2}}>Start hour</div>
                <input className="inp" type="time" value={slSchedule.start_hour} onChange={e=>setSlSchedule(p=>({...p,start_hour:e.target.value}))}/>
              </div>
              <div>
                <div style={{fontSize:10,color:"var(--t3)",marginBottom:2}}>End hour</div>
                <input className="inp" type="time" value={slSchedule.end_hour} onChange={e=>setSlSchedule(p=>({...p,end_hour:e.target.value}))}/>
              </div>
              <div>
                <div style={{fontSize:10,color:"var(--t3)",marginBottom:2}}>Min minutes between emails (per mailbox)</div>
                <input className="inp" type="number" value={slSchedule.min_time_btw_emails} onChange={e=>setSlSchedule(p=>({...p,min_time_btw_emails:parseInt(e.target.value)||10}))}/>
              </div>
              <div>
                <div style={{fontSize:10,color:"var(--t3)",marginBottom:2}}>Max new leads/day (per mailbox)</div>
                <input className="inp" type="number" value={slSchedule.max_new_leads_per_day} onChange={e=>setSlSchedule(p=>({...p,max_new_leads_per_day:parseInt(e.target.value)||20}))}/>
              </div>
            </div>
          </div>

          {/* Settings */}
          <div style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,marginBottom:14}}>
            <div style={{fontSize:11,fontWeight:600,marginBottom:6}}>5. Tracking & Behavior</div>
            <label style={{display:"flex",alignItems:"center",gap:8,fontSize:11,cursor:"pointer",marginBottom:6}}>
              <input type="checkbox" checked={slSettings.stop_lead_settings === "REPLY_TO_AN_EMAIL"} onChange={e=>setSlSettings(p=>({...p,stop_lead_settings:e.target.checked?"REPLY_TO_AN_EMAIL":"CLICK_ON_A_LINK"}))}/>
              Stop sequence when lead replies (recommended)
            </label>
            <label style={{display:"flex",alignItems:"center",gap:8,fontSize:11,cursor:"pointer",marginBottom:6}}>
              <input type="checkbox" checked={!slSettings.track_settings.includes("DONT_TRACK_EMAIL_OPEN")} onChange={e=>setSlSettings(p=>({...p,track_settings:e.target.checked?[]:["DONT_TRACK_EMAIL_OPEN"]}))}/>
              Track opens (may hurt deliverability)
            </label>
            <label style={{display:"flex",alignItems:"center",gap:8,fontSize:11,cursor:"pointer"}}>
              <input type="checkbox" checked={slSettings.send_as_plain_text} onChange={e=>setSlSettings(p=>({...p,send_as_plain_text:e.target.checked}))}/>
              Send as plain text (better deliverability)
            </label>
          </div>
        </>)}

        {/* Activate */}
        <div style={{padding:14,background:activateOnLaunch?"var(--grn-d)":"var(--card)",border:"1px solid "+(activateOnLaunch?"rgba(93,168,122,.4)":"var(--bdr)"),borderRadius:8,marginBottom:14}}>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:12,cursor:"pointer"}}>
            <input type="checkbox" checked={activateOnLaunch} onChange={e=>setActivateOnLaunch(e.target.checked)}/>
            <strong style={{color:activateOnLaunch?"var(--grn)":"var(--t1)"}}>Activate immediately</strong>
          </label>
          <div style={{fontSize:10,color:"var(--t3)",marginTop:4,marginLeft:24}}>{activateOnLaunch ? "⚠️ Emails will start sending right away per your schedule" : "Will create as DRAFT — review in Smartlead before activating"}</div>
        </div>
      </div>)}

      <div style={{display:"flex",gap:8}}>
        <button className="btn" onClick={()=>setStep(4)}>← Back</button>
        <button className="btn btn-p" disabled={launching||!slMasked||(slMode==="new"&&(!slCampaignName||slMailboxIds.size===0))||(slMode==="existing"&&!slExistingCampaign)} onClick={launchCampaign}>{launching?"⏳ Launching…":`🚀 Launch ${generated.filter(g=>g.ok).length} email${generated.filter(g=>g.ok).length!==1?"s":""}`}</button>
      </div>
    </div>)}

    {/* ───────────────── STEP 6: RESULT ───────────────── */}
    {step===6 && launchResult && (<div>
      <div style={{padding:20,background:launchResult.ok?"var(--grn-d)":"var(--red-d)",border:"1px solid "+(launchResult.ok?"rgba(93,168,122,.4)":"rgba(196,92,92,.4)"),borderRadius:10,marginBottom:16}}>
        <div style={{fontSize:18,fontWeight:700,color:launchResult.ok?"var(--grn)":"var(--red)",marginBottom:8}}>{launchResult.ok ? "🚀 Campaign launched!" : "❌ Launch failed"}</div>
        {launchResult.ok && (<>
          <div style={{fontSize:12,color:"var(--t1)",marginBottom:4}}>Smartlead campaign ID: <span style={{fontFamily:"'JetBrains Mono',monospace"}}>{launchResult.smartleadCampaignId}</span></div>
          <div style={{fontSize:12,color:"var(--t1)",marginBottom:8}}>Added {launchResult.added} leads {launchResult.skipped > 0 && `(${launchResult.skipped} skipped)`}</div>
          {launchResult.smartleadUrl && <a href={launchResult.smartleadUrl} target="_blank" rel="noopener" style={{color:"var(--blu)",fontSize:12}}>→ Open in Smartlead</a>}
        </>)}
      </div>
      {launchResult.log && (
        <div style={{padding:12,background:"var(--card)",borderRadius:8,marginBottom:16}}>
          <div style={{fontSize:10,fontWeight:600,color:"var(--t2)",marginBottom:6}}>Launch Log</div>
          {launchResult.log.map((l,i)=><div key={i} style={{fontSize:10,color:"var(--t2)",fontFamily:"'JetBrains Mono',monospace",lineHeight:1.6}}>{l}</div>)}
        </div>
      )}
      <button className="btn" onClick={()=>{setStep(1);setGenerated([]);setSelectedTag("");setLaunchResult(null);}}>+ New Email Campaign</button>
    </div>)}

    {/* ───────────────── OFFER MODAL ───────────────── */}
    {showOfferModal && (
      <div className="modal-o" onClick={e=>e.target===e.currentTarget&&setShowOfferModal(false)}>
        <div className="modal" style={{maxWidth:600}}>
          <div className="modal-h"><div style={{fontSize:14,fontWeight:600}}>{offerModalMode==="edit"?"✏️ Edit Offer":"➕ New Offer"}</div><button className="btn btn-s" onClick={()=>setShowOfferModal(false)}>✕</button></div>
          <div style={{padding:16}}>
            <div style={{padding:10,background:"var(--hover)",borderRadius:6,fontSize:10,color:"var(--t2)",marginBottom:14,lineHeight:1.5}}>
              💡 <strong>Tip:</strong> The "What this offers" field is the most important — be specific about who it helps and what changes for them. Avoid vague phrases like "we help businesses grow."
            </div>

            <div className="ig">
              <div className="il">Offer Name <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— short label, just for you</span></div>
              <input className="inp" value={offerForm.name} onChange={e=>setOfferForm(p=>({...p,name:e.target.value}))} placeholder="e.g. Q2 Construction Outbound, Capital One Displacement"/>
            </div>

            <div className="ig">
              <div className="il">What this offers <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— 2-3 sentences, AI uses this heavily</span></div>
              <textarea className="inp" value={offerForm.offerDescription} onChange={e=>setOfferForm(p=>({...p,offerDescription:e.target.value}))} style={{minHeight:100}} placeholder="e.g. We help construction & logistics CFOs replace their existing corporate cards with Volopay's field-team-friendly product. Our customers cut expense reimbursement time by 70% and gain real-time spend visibility across distributed teams."/>
            </div>

            <div className="ig">
              <div className="il">CTA Link</div>
              <input className="inp" value={offerForm.ctaLink} onChange={e=>setOfferForm(p=>({...p,ctaLink:e.target.value}))} placeholder="https://cal.com/yourname/15min"/>
            </div>

            <div className="ig">
              <div className="il">CTA Purpose <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— what they get if they click</span></div>
              <input className="inp" value={offerForm.ctaPurpose} onChange={e=>setOfferForm(p=>({...p,ctaPurpose:e.target.value}))} placeholder="15-min call to walk through how it fits your AP workflow"/>
            </div>

            <div style={{display:"flex",gap:8,marginTop:14}}>
              <button className="btn btn-p" disabled={savingOffer||!offerForm.name||!offerForm.offerDescription} onClick={saveOffer}>{savingOffer?"⏳ Saving…":(offerModalMode==="edit"?"💾 Update Offer":"💾 Save Offer")}</button>
              <button className="btn" onClick={()=>setShowOfferModal(false)}>Cancel</button>
            </div>
          </div>
        </div>
      </div>
    )}
  </div>);
}

// ═══════════════════════════════════════════════════════════════
function ManualOutreachModal({ leads, rules, linkedinAccount, outreachAPI, onClose, baseId }) {
  const [step, setStep] = useState("choose"); // choose | select_new | review_queue | send_connections | mark_connected | trigger_dms
  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [selected, setSelected] = useState(new Set());
  const [selectedRule, setSelectedRule] = useState("");
  const [count, setCount] = useState(10);
  const [companyFilter, setCompanyFilter] = useState("");
  const [connectionMessage, setConnectionMessage] = useState("Hey {first_name}, came across your profile and would love to connect.");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [previews, setPreviews] = useState(null);

  const outreachRules = rules.filter(r => {
    const c = r.fields?.["Outreach Config"];
    return c && c.length > 5;
  });

  // Load queue on demand
  const loadQueue = async () => {
    setQueueLoading(true);
    try {
      const d = await outreachAPI("list_queue", {});
      setQueue(d.items || []);
    } catch (e) { console.error(e); }
    setQueueLoading(false);
  };

  // Available leads (not already in outreach)
  const inOutreachLinkedIns = new Set(queue.map(q => (q.fields?.["LinkedIn URL"] || "").toLowerCase().trim()).filter(Boolean));
  const availableLeads = leads.filter(l => {
    const f = l.fields || {};
    const li = (f["LinkedIn URL"] || "").toLowerCase().trim();
    if (!li) return false;
    if (inOutreachLinkedIns.has(li)) return false;
    if (companyFilter && !(f.Company || "").toLowerCase().includes(companyFilter.toLowerCase())) return false;
    return true;
  });

  // Queue filtered by status
  const queueQueued = queue.filter(q => (q.fields?.Status || "queued") === "queued" && (q.fields?.Mode || "auto") === "manual");
  const queueConnSent = queue.filter(q => (q.fields?.Status || "") === "connection_sent" && (q.fields?.Mode || "auto") === "manual");
  const queueConnected = queue.filter(q => {
    const s = (q.fields?.Status || "");
    return (s === "connected" || s.startsWith("dm_")) && (q.fields?.Mode || "auto") === "manual";
  });

  const ruleConfig = (() => {
    if (!selectedRule) return { name: "Manual Outreach", connectionMessage, dmSequence: [] };
    const r = rules.find(x => x.id === selectedRule);
    try {
      const cfg = JSON.parse(r?.fields?.["Outreach Config"] || "{}");
      return { ...cfg, name: r?.fields?.Name || "Manual", connectionMessage: connectionMessage || cfg.connectionMessage };
    } catch { return { name: "Manual", connectionMessage, dmSequence: [] }; }
  })();

  // ─── Actions ───
  const previewMessages = async (template, context = "connection_note") => {
    if (selected.size === 0) { setResult({ error: "Select some leads first to preview" }); return; }
    setBusy(true); setResult(null); setPreviews(null);
    try {
      const ids = [...selected].slice(0, 5);
      const d = await outreachAPI("preview_batch", { template, leadIds: ids, context, signal: ruleConfig.signal || "", aiGenerate: false });
      setPreviews(d.previews || []);
      if (d.issues > 0) setResult({ error: `⚠️ ${d.issues}/${d.total} previews have issues — fix template before sending.` });
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const enqueueManual = async () => {
    if (!connectionMessage || connectionMessage.length > 300) { setResult({ error: "Connection note must be 1-300 characters" }); return; }
    if (!confirm(`Add ${selected.size} lead${selected.size!==1?"s":""} to queue and send connection request${selected.size!==1?"s":""} now?\n\nThis uses your LinkedIn account. Hard cap: 30 per batch.`)) return;
    setBusy(true); setResult(null);
    try {
      const ids = [...selected];
      // Step 1: enqueue
      const eq = await outreachAPI("enqueue_leads", { ruleConfig, mode: "manual", selectedIds: ids, count: ids.length });

      // Detect missing Outreach table on BOTH error paths
      const airErr = eq.airtableErrors?.[0]?.body || eq.error || "";
      const isMissingTable = airErr.includes("INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND") || airErr.includes("NOT_FOUND");

      if (eq.error && !isMissingTable) {
        setResult({ error: eq.error + (eq.airtableErrors ? "\n\nAirtable: " + JSON.stringify(eq.airtableErrors[0]).slice(0,200) : "") });
        setBusy(false); return;
      }
      if (eq.enqueued === 0 || isMissingTable) {
        if (isMissingTable) {
          // Auto-run setup to create the Outreach table, then retry
          setResult({ ok: true, message: "⚙️ Outreach table missing — running Setup to create it. This takes ~10 seconds..." });
          try {
            const setupRes = await fetch("/api/airtable", {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "setup", baseId }),
            });
            const setupBody = await setupRes.json().catch(() => ({}));
            const setupErrMsgs = (setupBody.errors || []).join("; ");
            const setupFailedBadly = !setupRes.ok || (setupBody.errors?.length > 0 && !setupBody.tables_created?.includes("Outreach"));

            // Detect PAT permission issues specifically
            const isPATError = setupErrMsgs.includes("401") || setupErrMsgs.includes("403") || setupErrMsgs.includes("Auth") || setupErrMsgs.includes("scope") || setupErrMsgs.includes("PERMISSION") || setupErrMsgs.includes("permission");

            if (isPATError || setupFailedBadly) {
              // Auto-run the diagnostic to figure out EXACTLY what's wrong
              setResult({ ok: true, message: "🔍 Setup failed — running deep diagnostic..." });
              try {
                const diagRes = await fetch("/api/airtable", {
                  method: "POST", headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "diagnose", baseId }),
                });
                const diag = await diagRes.json();
                const stepsStr = (diag.steps || []).map(s => `  • ${s.step}: ${s.ok?"✓":"✗"} (status ${s.status||"n/a"})${s.bodyPreview?" → "+s.bodyPreview.slice(0,150):""}`).join("\n");
                const tablesStr = (diag.existingTables || []).map(t => t.name).join(", ") || "none";
                setResult({ error: `🔍 DIAGNOSTIC RESULT\n\n${diag.conclusion || "No conclusion returned"}\n\nTables currently in base: ${tablesStr}\nOutreach table exists: ${diag.hasOutreachTable ? "YES" : "NO"}\n\nSteps:\n${stepsStr}\n\nSetup errors: ${setupErrMsgs || "(none)"}` });
              } catch (diagErr) {
                setResult({ error: `🛑 Setup failed AND diagnostic also failed.\n\nSetup errors: ${setupErrMsgs || "HTTP " + setupRes.status}\nDiagnostic error: ${diagErr.message}\n\nTry these manually:\n1. https://airtable.com/create/tokens → verify schema.bases:write scope\n2. Make sure base ${baseId} is in token's allowed bases\n3. Try regenerating the token from scratch` });
              }
              setBusy(false); return;
            }

            setResult({ ok: true, message: `✅ Outreach table created (${setupBody.tables_created?.join(", ") || "Outreach"}). Retrying send...` });
            const eq2 = await outreachAPI("enqueue_leads", { ruleConfig, mode: "manual", selectedIds: ids, count: ids.length });
            if (eq2.enqueued > 0) {
              const q2 = await outreachAPI("list_queue", { campaign: ruleConfig.name, status: "queued" });
              const newItems2 = (q2.items || []).filter(i => (i.fields?.Mode || "auto") === "manual");
              const sortedNew2 = [...newItems2].sort((a,b) => (b.fields?.["Created At"] || "").localeCompare(a.fields?.["Created At"] || "")).slice(0, eq2.enqueued);
              const sendRes2 = await outreachAPI("send_manual_connections", {
                accountId: linkedinAccount.id,
                outreachItemIds: sortedNew2.map(i => i.id),
                ruleConfig,
              });
              if (sendRes2.error) setResult({ error: sendRes2.error });
              else setResult({ ok: true, message: `✅ Created Outreach table, added ${eq2.enqueued}, sent ${sendRes2.sent} connection request${sendRes2.sent!==1?"s":""}.`, details: sendRes2.results });
              await loadQueue(); setSelected(new Set()); setBusy(false); return;
            } else {
              const e2Err = eq2.airtableErrors?.[0]?.body || eq2.error || "unknown";
              setResult({ error: `Setup completed but retry still fails. Airtable says: ${e2Err.slice(0, 400)}` });
              setBusy(false); return;
            }
          } catch (setupErr) {
            setResult({ error: `🛑 Auto-setup crashed: ${setupErr.message}\n\n👉 Go to https://airtable.com/create/tokens and verify your token has schema.bases:write scope + access to base ${baseId}.` });
            setBusy(false); return;
          }
        } else {
          setResult({ error: `Could not add any leads to Airtable. Skipped as dupes: ${eq.skippedDupes||0}. ${airErr ? "\n\nAirtable error: " + airErr.slice(0, 300) : "Check Airtable permissions and field schema on the Outreach table."}` });
          setBusy(false); return;
        }
      }
      // Step 2: find the newly-enqueued items — the records just created are Mode=manual, Status=queued
      const q = await outreachAPI("list_queue", { campaign: ruleConfig.name, status: "queued" });
      const newItems = (q.items || []).filter(i => (i.fields?.Mode || "auto") === "manual");
      if (newItems.length === 0) {
        setResult({ error: `Enqueued ${eq.enqueued} to Airtable, but couldn't locate them for sending. Try clicking Refresh.` });
        setBusy(false); await loadQueue(); return;
      }
      // Take only the most recently created — sorted by Created At desc
      const sortedNew = [...newItems].sort((a,b) => (b.fields?.["Created At"] || "").localeCompare(a.fields?.["Created At"] || "")).slice(0, eq.enqueued);
      const sendRes = await outreachAPI("send_manual_connections", {
        accountId: linkedinAccount.id,
        outreachItemIds: sortedNew.map(i => i.id),
        ruleConfig,
      });
      if (sendRes.aborted && sendRes.validationFailures) {
        const preview = sendRes.validationFailures.slice(0, 3).map(f => `• ${f.name}: ${f.error}`).join("\n");
        setResult({ error: `🛑 ${sendRes.error}\n\n${preview}${sendRes.validationFailures.length > 3 ? `\n…and ${sendRes.validationFailures.length - 3} more` : ""}` });
      } else if (sendRes.error) {
        setResult({ error: sendRes.error });
      } else {
        setResult({ ok: true, message: `✅ Added ${eq.enqueued}, sent ${sendRes.sent} connection request${sendRes.sent!==1?"s":""}, ${sendRes.errors||0} error${sendRes.errors!==1?"s":""}. ${eq.skippedDupes||0} dupes skipped.`, details: sendRes.results });
      }
      await loadQueue();
      setSelected(new Set());
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const sendConnections = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Send ${selected.size} connection request${selected.size !== 1 ? "s" : ""}?\n\nThis will use your LinkedIn account. You'll hit LinkedIn's rate limits if you send too many per day — we cap at 30 per batch.`)) return;
    setBusy(true); setResult(null);
    try {
      const d = await outreachAPI("send_manual_connections", { accountId: linkedinAccount.id, outreachItemIds: [...selected], ruleConfig });
      if (d.error) setResult({ error: d.error });
      else setResult({ ok: true, message: `Sent ${d.sent}, errors: ${d.errors}`, details: d.results });
      await loadQueue();
      setSelected(new Set());
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const markConnected = async () => {
    if (selected.size === 0) return;
    setBusy(true); setResult(null);
    try {
      const d = await outreachAPI("mark_connected", { outreachItemIds: [...selected] });
      setResult({ ok: true, message: `Marked ${d.marked} as connected. Now you can trigger DMs.` });
      await loadQueue();
      setSelected(new Set());
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const triggerDMs = async () => {
    if (selected.size === 0) return;
    if (!selectedRule) { alert("Select a Task Rule to get the DM sequence"); return; }
    if (!confirm(`Send DM to ${selected.size} lead${selected.size !== 1 ? "s" : ""}?\n\nReplied leads will be skipped automatically.`)) return;
    setBusy(true); setResult(null);
    try {
      const d = await outreachAPI("trigger_manual_dms", { accountId: linkedinAccount.id, outreachItemIds: [...selected], ruleConfig });
      if (d.aborted && d.validationFailures) {
        const preview = d.validationFailures.slice(0, 3).map(f => `• ${f.name}: ${f.error}`).join("\n");
        setResult({ error: `🛑 ${d.error}\n\n${preview}${d.validationFailures.length > 3 ? `\n…and ${d.validationFailures.length - 3} more` : ""}` });
      } else if (d.error) {
        setResult({ error: d.error });
      } else {
        setResult({ ok: true, message: `Sent ${d.sent} DMs, ${d.skippedReplied} skipped (already replied), ${d.errors} errors.`, details: d.results });
      }
      await loadQueue();
      setSelected(new Set());
    } catch (e) { setResult({ error: e.message }); }
    setBusy(false);
  };

  const toggle = (id) => { setSelected(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };
  const selectAll = (items, limit = 30) => setSelected(new Set(items.slice(0, limit).map(i => i.id)));

  return (<div className="modal-o" onClick={e=>e.target===e.currentTarget&&onClose()}><div className="modal" style={{maxWidth:900,maxHeight:"90vh"}}>
    <div className="modal-h">
      <span style={{fontWeight:600}}>✋ Manual Outreach</span>
      <button className="btn btn-s" onClick={onClose}>✕</button>
    </div>
    <div className="modal-b" style={{maxHeight:"calc(90vh - 140px)",overflowY:"auto"}}>

    {/* ─── CHOOSE STEP ─── */}
    {step==="choose"&&(<div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:16,lineHeight:1.6}}>Manual mode gives you full control. Unlike auto mode, <strong>you</strong> decide which leads get connection requests and when to send follow-up DMs.</div>

      <div className="ig"><div className="il">Task Rule (for DM sequence & messages)</div>
        <select className="inp" value={selectedRule} onChange={e=>{setSelectedRule(e.target.value);const r=rules.find(x=>x.id===e.target.value);if(r){try{const c=JSON.parse(r.fields?.["Outreach Config"]||"{}");if(c.connectionMessage)setConnectionMessage(c.connectionMessage);}catch{}}}}>
          <option value="">Custom (no pre-defined sequence)</option>
          {outreachRules.map(r => <option key={r.id} value={r.id}>{r.fields?.Name || "Rule"}</option>)}
        </select>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:16}}>
        <div onClick={async()=>{await loadQueue();setStep("select_new")}} style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,cursor:"pointer"}}>
          <div style={{fontSize:20,marginBottom:8}}>📤</div>
          <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:6}}>1. Send Connection Requests</div>
          <div style={{fontSize:10,color:"var(--t3)",lineHeight:1.5}}>Pick leads, write a custom connection note, and send invites. Preview the DM sequence that will trigger after acceptance.</div>
        </div>
        <div onClick={async()=>{await loadQueue();setStep("review_queue")}} style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,cursor:"pointer"}}>
          <div style={{fontSize:20,marginBottom:8}}>📋</div>
          <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:6}}>2. Review Queue & Trigger DMs</div>
          <div style={{fontSize:10,color:"var(--t3)",lineHeight:1.5}}>Track sent requests, mark accepted ones as connected, then trigger your DM sequence to connected leads.</div>
        </div>
      </div>
    </div>)}

    {/* ─── SELECT NEW LEADS ─── */}
    {step==="select_new"&&(<div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12}}>Pick leads and set your connection note. Only leads with LinkedIn URLs not already in outreach are shown.</div>

      {/* Connection Message */}
      <div className="ig">
        <div className="il">Connection Note <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— sent with the invite. Merge fields: {"{first_name}"}, {"{company}"}, {"{title}"}</span></div>
        <textarea className="inp" value={connectionMessage} onChange={e=>{setConnectionMessage(e.target.value);setPreviews(null)}} style={{minHeight:60}} maxLength={300} placeholder="Hey {first_name}, came across your profile and would love to connect."/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:4}}>
          <div style={{fontSize:9,color:connectionMessage.length>300?"var(--red)":"var(--t3)"}}>{connectionMessage.length}/300 chars · LinkedIn free-tier limit</div>
          <button className="btn btn-s" disabled={busy||selected.size===0} onClick={()=>previewMessages(connectionMessage,"connection_note")} style={{fontSize:10}}>{busy?"⏳":"👁 Preview on "+Math.min(selected.size,5)+" sample"+(Math.min(selected.size,5)!==1?"s":"")}</button>
        </div>
      </div>

      {/* Preview panel */}
      {previews && previews.length > 0 && (
        <div style={{padding:12,background:"var(--hover)",borderRadius:8,marginBottom:14}}>
          <div style={{fontSize:10,color:"var(--t2)",fontWeight:600,marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span>🔍 Rendered Preview ({previews.length} sample{previews.length!==1?"s":""})</span>
            <button className="btn btn-s" style={{fontSize:9,padding:"2px 6px"}} onClick={()=>setPreviews(null)}>✕ Close</button>
          </div>
          {previews.map((p, i) => (
            <div key={i} style={{padding:"8px 10px",background:p.valid?"var(--card)":"var(--red-d)",borderRadius:6,marginBottom:6,border:"1px solid "+(p.valid?"var(--bdr)":"rgba(196,92,92,.4)")}}>
              <div style={{fontSize:10,color:p.valid?"var(--t2)":"var(--red)",fontWeight:600,marginBottom:2}}>{p.valid?"✅":"❌"} {p.name || "Unknown"}</div>
              <div style={{fontSize:10,color:"var(--t1)",whiteSpace:"pre-wrap",lineHeight:1.5}}>{p.message}</div>
              {p.error && <div style={{fontSize:9,color:"var(--red)",marginTop:4,fontStyle:"italic"}}>⚠ {p.error}</div>}
            </div>
          ))}
          <div style={{fontSize:9,color:"var(--t3)",fontStyle:"italic",marginTop:4}}>If any preview has ❌, the batch will be blocked. Fix merge fields first.</div>
        </div>
      )}

      {/* DM Sequence Preview */}
      {ruleConfig.dmSequence?.length > 0 ? (
        <div style={{padding:12,background:"var(--hover)",borderRadius:8,marginBottom:14}}>
          <div style={{fontSize:10,color:"var(--t2)",fontWeight:600,marginBottom:6}}>📨 DM Sequence (from "{rules.find(r=>r.id===selectedRule)?.fields?.Name}") — triggers after connection accepted:</div>
          {ruleConfig.dmSequence.map((s, i) => (
            <div key={i} style={{padding:"6px 0",borderBottom:i<ruleConfig.dmSequence.length-1?"1px solid var(--bdr)":"none"}}>
              <div style={{fontSize:10,color:"var(--t3)",marginBottom:2}}>Step {i + 1}{s.daysAfterPrev ? ` · ${s.daysAfterPrev} day${s.daysAfterPrev!==1?"s":""} after previous` : i === 0 ? " · immediately after acceptance" : ""}{s.aiGenerate ? " · AI-personalized" : ""}</div>
              <div style={{fontSize:10,color:"var(--t2)",lineHeight:1.4}}>{(s.message || "").slice(0, 120)}{(s.message||"").length > 120 ? "…" : ""}</div>
            </div>
          ))}
          <div style={{fontSize:9,color:"var(--t3)",marginTop:8,fontStyle:"italic"}}>💡 You'll trigger DMs manually from Review Queue once LinkedIn shows the connection was accepted.</div>
        </div>
      ) : (
        <div style={{padding:12,background:"var(--hover)",borderRadius:8,marginBottom:14,fontSize:11,color:"var(--t3)"}}>
          ⚠️ No DM sequence configured. {selectedRule ? "This rule has no DMs set up." : "Pick a Task Rule on the previous screen to use its DM sequence, or you'll only send the connection request."}
        </div>
      )}

      <div style={{display:"flex",gap:8,marginBottom:12}}>
        <input className="inp" placeholder="Filter by company…" value={companyFilter} onChange={e=>setCompanyFilter(e.target.value)} style={{flex:1}}/>
        <button className="btn btn-s" onClick={()=>selectAll(availableLeads, 30)}>Select top 30</button>
        <button className="btn btn-s" onClick={()=>setSelected(new Set())}>Clear</button>
      </div>

      <div style={{fontSize:10,color:"var(--t3)",marginBottom:8}}>{availableLeads.length} available · {selected.size} selected · 30 max per batch (safety cap)</div>

      <div style={{maxHeight:280,overflowY:"auto",border:"1px solid var(--bdr)",borderRadius:8}}>
        {availableLeads.length === 0 ? <div style={{padding:40,textAlign:"center",color:"var(--t3)",fontSize:11}}>No available leads. Upload leads with LinkedIn URLs, or they're all in outreach already.</div> :
        <table><thead><tr><th style={{width:32}}></th><th>Name</th><th>Title</th><th>Company</th></tr></thead>
        <tbody>{availableLeads.slice(0, 200).map(l => { const f = l.fields || {}; const isSel = selected.has(l.id); return (
          <tr key={l.id} onClick={()=>toggle(l.id)} style={{cursor:"pointer",background:isSel?"var(--acc-d)":""}}>
            <td><input type="checkbox" checked={isSel} onChange={()=>toggle(l.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"var(--acc)"}}/></td>
            <td style={{color:"var(--t1)",fontWeight:500}}>{f.Name}</td><td style={{fontSize:10}}>{f.Title}</td><td style={{fontSize:10}}>{f.Company}</td>
          </tr>
        );})}</tbody></table>}
      </div>
      {result && <div style={{marginTop:12,padding:10,borderRadius:6,background:result.error?"var(--red-d)":"var(--grn-d)",color:result.error?"var(--red)":"var(--grn)",fontSize:11,whiteSpace:"pre-wrap"}}>{result.error || result.message}</div>}
    </div>)}

    {/* ─── REVIEW QUEUE ─── */}
    {step==="review_queue"&&(<div>
      <div style={{display:"flex",gap:10,marginBottom:14}}>
        <div style={{flex:1,padding:"10px 14px",background:"var(--hover)",borderRadius:8,cursor:"pointer",border:"1px solid "+(step==="send_connections"?"var(--acc)":"transparent")}} onClick={()=>{setSelected(new Set());setStep("send_connections")}}>
          <div style={{fontSize:18,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--amb)"}}>{queueQueued.length}</div>
          <div style={{fontSize:9,color:"var(--t3)"}}>In Queue (not sent)</div>
        </div>
        <div style={{flex:1,padding:"10px 14px",background:"var(--hover)",borderRadius:8,cursor:"pointer"}} onClick={()=>{setSelected(new Set());setStep("mark_connected")}}>
          <div style={{fontSize:18,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--blu)"}}>{queueConnSent.length}</div>
          <div style={{fontSize:9,color:"var(--t3)"}}>Request Sent</div>
        </div>
        <div style={{flex:1,padding:"10px 14px",background:"var(--hover)",borderRadius:8,cursor:"pointer"}} onClick={()=>{setSelected(new Set());setStep("trigger_dms")}}>
          <div style={{fontSize:18,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--grn)"}}>{queueConnected.length}</div>
          <div style={{fontSize:9,color:"var(--t3)"}}>Connected (ready for DM)</div>
        </div>
      </div>
      <div style={{fontSize:11,color:"var(--t3)",lineHeight:1.6}}>Click a card above to act on that group. The flow is: <strong>Queue</strong> → Send Connection → <strong>Request Sent</strong> → Mark as Connected when they accept → <strong>Connected</strong> → Trigger DM sequence.</div>
    </div>)}

    {/* ─── SEND CONNECTIONS ─── */}
    {step==="send_connections"&&(<div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12}}>Select leads from the queue to send connection requests to. <strong style={{color:"var(--amb)"}}>Safety cap: 30 per batch.</strong></div>
      <div className="ig"><div className="il">Connection Message <span style={{fontWeight:400,textTransform:"none",color:"var(--t3)"}}>— {"{first_name}"}, {"{company}"} merge fields supported</span></div>
        <textarea className="inp" value={connectionMessage} onChange={e=>setConnectionMessage(e.target.value)} style={{minHeight:60}} maxLength={300}/>
        <div style={{fontSize:9,color:"var(--t3)",marginTop:2}}>{connectionMessage.length}/300 chars · LinkedIn limit</div>
      </div>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <button className="btn btn-s" onClick={()=>selectAll(queueQueued, 30)}>Select 30</button>
        <button className="btn btn-s" onClick={()=>setSelected(new Set())}>Clear</button>
        <span style={{fontSize:10,color:"var(--t3)",marginLeft:"auto",alignSelf:"center"}}>{selected.size}/30 selected · {queueQueued.length} in queue</span>
      </div>
      <div style={{maxHeight:260,overflowY:"auto",border:"1px solid var(--bdr)",borderRadius:8}}>
        {queueQueued.length===0?<div style={{padding:30,textAlign:"center",color:"var(--t3)",fontSize:11}}>Queue empty. Add leads first.</div>:
        <table><thead><tr><th style={{width:32}}></th><th>Name</th><th>Title</th><th>Company</th></tr></thead>
        <tbody>{queueQueued.map(q=>{const f=q.fields||{};const isSel=selected.has(q.id);return (<tr key={q.id} onClick={()=>selected.size<30||isSel?toggle(q.id):null} style={{cursor:"pointer",background:isSel?"var(--acc-d)":""}}>
          <td><input type="checkbox" checked={isSel} disabled={!isSel&&selected.size>=30} onChange={()=>toggle(q.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"var(--acc)"}}/></td>
          <td style={{color:"var(--t1)",fontWeight:500}}>{f["Lead Name"]}</td><td style={{fontSize:10}}>{f.Title}</td><td style={{fontSize:10}}>{f.Company}</td>
        </tr>);})}</tbody></table>}
      </div>
      {result && <div style={{marginTop:12,padding:10,borderRadius:6,background:result.error?"var(--red-d)":"var(--grn-d)",color:result.error?"var(--red)":"var(--grn)",fontSize:11,whiteSpace:"pre-wrap"}}>{result.error || result.message}</div>}
    </div>)}

    {/* ─── MARK CONNECTED ─── */}
    {step==="mark_connected"&&(<div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,lineHeight:1.6}}>Check LinkedIn for accepted connections, then select them here to move into the DM-ready group. <strong>This doesn't send anything</strong> — just updates status.</div>
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <button className="btn btn-s" onClick={()=>selectAll(queueConnSent, 100)}>Select All</button>
        <button className="btn btn-s" onClick={()=>setSelected(new Set())}>Clear</button>
        <span style={{fontSize:10,color:"var(--t3)",marginLeft:"auto",alignSelf:"center"}}>{selected.size} selected · {queueConnSent.length} pending</span>
      </div>
      <div style={{maxHeight:300,overflowY:"auto",border:"1px solid var(--bdr)",borderRadius:8}}>
        {queueConnSent.length===0?<div style={{padding:30,textAlign:"center",color:"var(--t3)",fontSize:11}}>No pending connection requests.</div>:
        <table><thead><tr><th style={{width:32}}></th><th>Name</th><th>Company</th><th>Sent</th></tr></thead>
        <tbody>{queueConnSent.map(q=>{const f=q.fields||{};const isSel=selected.has(q.id);return (<tr key={q.id} onClick={()=>toggle(q.id)} style={{cursor:"pointer",background:isSel?"var(--acc-d)":""}}>
          <td><input type="checkbox" checked={isSel} onChange={()=>toggle(q.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"var(--acc)"}}/></td>
          <td style={{color:"var(--t1)",fontWeight:500}}>{f["Lead Name"]}</td><td style={{fontSize:10}}>{f.Company}</td>
          <td style={{fontSize:10,color:"var(--t3)"}}>{f["Connection Sent At"]?.slice(0,10)||"—"}</td>
        </tr>);})}</tbody></table>}
      </div>
      {result && <div style={{marginTop:12,padding:10,borderRadius:6,background:result.error?"var(--red-d)":"var(--grn-d)",color:result.error?"var(--red)":"var(--grn)",fontSize:11,whiteSpace:"pre-wrap"}}>{result.error || result.message}</div>}
    </div>)}

    {/* ─── TRIGGER DMS ─── */}
    {step==="trigger_dms"&&(<div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,lineHeight:1.6}}>Send the next DM in the sequence to connected leads. Replied leads will be auto-skipped.</div>
      {!selectedRule && <div style={{padding:10,background:"var(--red-d)",color:"var(--red)",borderRadius:6,fontSize:11,marginBottom:12}}>⚠️ Select a Task Rule on the first screen to use its DM sequence.</div>}
      <div style={{display:"flex",gap:8,marginBottom:8}}>
        <button className="btn btn-s" onClick={()=>selectAll(queueConnected, 50)}>Select 50</button>
        <button className="btn btn-s" onClick={()=>setSelected(new Set())}>Clear</button>
        <span style={{fontSize:10,color:"var(--t3)",marginLeft:"auto",alignSelf:"center"}}>{selected.size}/50 · {queueConnected.length} connected</span>
      </div>
      <div style={{maxHeight:300,overflowY:"auto",border:"1px solid var(--bdr)",borderRadius:8}}>
        {queueConnected.length===0?<div style={{padding:30,textAlign:"center",color:"var(--t3)",fontSize:11}}>No connected leads yet. Mark some as connected first.</div>:
        <table><thead><tr><th style={{width:32}}></th><th>Name</th><th>Company</th><th>DM Step</th></tr></thead>
        <tbody>{queueConnected.map(q=>{const f=q.fields||{};const isSel=selected.has(q.id);return (<tr key={q.id} onClick={()=>selected.size<50||isSel?toggle(q.id):null} style={{cursor:"pointer",background:isSel?"var(--acc-d)":""}}>
          <td><input type="checkbox" checked={isSel} disabled={!isSel&&selected.size>=50} onChange={()=>toggle(q.id)} onClick={e=>e.stopPropagation()} style={{accentColor:"var(--acc)"}}/></td>
          <td style={{color:"var(--t1)",fontWeight:500}}>{f["Lead Name"]}</td><td style={{fontSize:10}}>{f.Company}</td>
          <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f["DM Step"]||0}</td>
        </tr>);})}</tbody></table>}
      </div>
      {result && <div style={{marginTop:12,padding:10,borderRadius:6,background:result.error?"var(--red-d)":"var(--grn-d)",color:result.error?"var(--red)":"var(--grn)",fontSize:11,whiteSpace:"pre-wrap"}}>{result.error || result.message}</div>}
    </div>)}

    </div>
    <div className="modal-f">
      {step==="choose"&&<button className="btn" onClick={onClose}>Close</button>}
      {step==="select_new"&&<><button className="btn" onClick={()=>setStep("choose")}>← Back</button><button className="btn btn-p" disabled={busy||selected.size===0||!linkedinAccount} onClick={enqueueManual}>{busy?"⏳ Sending…":`Send ${selected.size} Connection Request${selected.size!==1?"s":""}`}</button></>}
      {step==="review_queue"&&<button className="btn" onClick={()=>setStep("choose")}>← Back</button>}
      {step==="send_connections"&&<><button className="btn" onClick={()=>setStep("review_queue")}>← Back</button><button className="btn btn-p" disabled={busy||selected.size===0||!linkedinAccount} onClick={sendConnections}>{busy?"⏳ Sending…":`Send ${selected.size} Connection Request${selected.size!==1?"s":""}`}</button></>}
      {step==="mark_connected"&&<><button className="btn" onClick={()=>setStep("review_queue")}>← Back</button><button className="btn btn-p" disabled={busy||selected.size===0} onClick={markConnected}>{busy?"⏳":`Mark ${selected.size} as Connected`}</button></>}
      {step==="trigger_dms"&&<><button className="btn" onClick={()=>setStep("review_queue")}>← Back</button><button className="btn btn-p" disabled={busy||selected.size===0||!linkedinAccount||!selectedRule} onClick={triggerDMs}>{busy?"⏳ Sending…":`Send DM to ${selected.size}`}</button></>}
    </div>
  </div></div>);
}

// ═══════════════════════════════════════════════════════════════
function LeadsToHubSpotForm({ leads, owners, onPush, loading }) {
  const [ownerId, setOwnerId] = useState("");
  const [lifecycle, setLifecycle] = useState("lead");
  const [leadStatus, setLeadStatus] = useState("NEW");
  const [filterCompany, setFilterCompany] = useState("");
  const [onlyWithEmail, setOnlyWithEmail] = useState(true);

  const filtered = leads.filter(l => {
    const f = l.fields || {};
    if (onlyWithEmail && !f.Email) return false;
    if (filterCompany && !(f.Company || "").toLowerCase().includes(filterCompany.toLowerCase())) return false;
    return true;
  });

  return (<div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Assign To</div>
        <select className="inp" value={ownerId} onChange={e=>setOwnerId(e.target.value)}>
          <option value="">Unassigned</option>
          {owners.map(o => <option key={o.id} value={o.id}>{o.label} ({o.email})</option>)}
        </select>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Filter by Company</div>
        <input className="inp" placeholder="Type to filter..." value={filterCompany} onChange={e=>setFilterCompany(e.target.value)}/>
      </div>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:14}}>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Lifecycle Stage</div>
        <select className="inp" value={lifecycle} onChange={e=>setLifecycle(e.target.value)}>
          <option value="subscriber">Subscriber</option>
          <option value="lead">Lead</option>
          <option value="marketingqualifiedlead">Marketing Qualified</option>
          <option value="salesqualifiedlead">Sales Qualified</option>
          <option value="opportunity">Opportunity</option>
          <option value="customer">Customer</option>
        </select>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Lead Status</div>
        <select className="inp" value={leadStatus} onChange={e=>setLeadStatus(e.target.value)}>
          <option value="NEW">New</option>
          <option value="OPEN">Open</option>
          <option value="IN_PROGRESS">In Progress</option>
          <option value="ATTEMPTED_TO_CONTACT">Attempted</option>
          <option value="CONNECTED">Connected</option>
        </select>
      </div>
      <div className="ig" style={{marginBottom:0}}>
        <div className="il">Email Filter</div>
        <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"var(--t2)",cursor:"pointer",paddingTop:6}}>
          <input type="checkbox" checked={onlyWithEmail} onChange={e=>setOnlyWithEmail(e.target.checked)} style={{accentColor:"var(--acc)"}}/>
          Only leads with email
        </label>
      </div>
    </div>
    <div style={{display:"flex",alignItems:"center",gap:12}}>
      <button className="btn btn-p btn-s" disabled={loading || !filtered.length} onClick={() => onPush(filtered, { ownerId, lifecycleStage: lifecycle, leadStatus })}>
        {loading ? "⏳ Pushing..." : `Upload ${filtered.length} Lead${filtered.length !== 1 ? "s" : ""} to HubSpot`}
      </button>
      <span style={{fontSize:10,color:"var(--t3)"}}>{filtered.length} of {leads.length} leads{onlyWithEmail ? " (with email)" : ""}</span>
    </div>
  </div>);
}

// ═══════════════════════════════════════════════════════════════
// ENRICH MODAL — select tasks, enrich phones, push to HubSpot
// ═══════════════════════════════════════════════════════════════
function EnrichModal({ mode, tasks, rules, fTasks, selectedTasks, onEnrich, onPush, enrichResults, enrichLoading, hsConnected, hsOwners, hsLoading, onClose }) {
  const [step, setStep] = useState(mode === "push" ? "push" : "select"); // select → enriching → results → push
  const [ruleFilter, setRuleFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [scoreMin, setScoreMin] = useState(0);
  const [ownerId, setOwnerId] = useState("");
  const [priority, setPriority] = useState("MEDIUM");

  const ruleNames = [...new Set(tasks.map(t => (t.fields || {})["Task Rule"]).filter(Boolean))];

  const getFilteredTasks = () => {
    // If tasks are selected on the main page, use those
    if (selectedTasks.size > 0) return tasks.filter(t => selectedTasks.has(t.id));
    return tasks.filter(t => {
      const f = t.fields || {};
      if (ruleFilter !== "all" && f["Task Rule"] !== ruleFilter) return false;
      if (dateFrom && (f.Date || "") < dateFrom) return false;
      if (dateTo && (f.Date || "") > dateTo) return false;
      if (scoreMin > 0 && (f.Score || 0) < scoreMin) return false;
      return true;
    });
  };

  const filtered = getFilteredTasks();
  const enrichedWithPhone = enrichResults.filter(r => r.phone || r.mobile);

  return (<div className="modal-o" onClick={e=>e.target===e.currentTarget&&onClose()}><div className="modal" style={{maxWidth:720}}>
    <div className="modal-h">
      <span style={{fontWeight:600}}>{step==="select"?"📞 Enrich Phone Numbers":step==="enriching"?"⏳ Enriching...":step==="results"?"📞 Enrichment Results":"📤 Push to HubSpot"}</span>
      <button className="btn btn-s" onClick={onClose}>✕</button>
    </div>
    <div className="modal-b">

    {/* ─── SELECT ─── */}
    {step==="select"&&(<div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:14,lineHeight:1.5}}>
        Select which tasks to enrich with phone numbers via Apollo.
        {selectedTasks.size > 0 && <span style={{color:"var(--acc)"}}> Using {selectedTasks.size} selected tasks from the Tasks tab.</span>}
      </div>

      {selectedTasks.size === 0 && (<>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <div className="ig" style={{marginBottom:0}}>
          <div className="il">Task Rule</div>
          <select className="inp" value={ruleFilter} onChange={e=>setRuleFilter(e.target.value)}>
            <option value="all">All Rules</option>
            {ruleNames.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="ig" style={{marginBottom:0}}>
          <div className="il">Min Score</div>
          <input type="number" className="inp" value={scoreMin} onChange={e=>setScoreMin(+e.target.value)} min={0} max={100} placeholder="0"/>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div className="ig" style={{marginBottom:0}}>
          <div className="il">Date From</div>
          <input type="date" className="inp" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/>
        </div>
        <div className="ig" style={{marginBottom:0}}>
          <div className="il">Date To</div>
          <input type="date" className="inp" value={dateTo} onChange={e=>setDateTo(e.target.value)}/>
        </div>
      </div>
      </>)}

      <div style={{padding:12,background:"var(--hover)",borderRadius:8,marginBottom:14,fontSize:11,color:"var(--t2)"}}>
        📋 {filtered.length} tasks will be enriched. Each task costs ~1 Apollo credit.
      </div>
    </div>)}

    {/* ─── ENRICHING ─── */}
    {step==="enriching"&&(<div style={{textAlign:"center",padding:30}}>
      <div style={{fontSize:32,marginBottom:12}}>⏳</div>
      <div style={{fontSize:13,color:"var(--t1)",marginBottom:6}}>Enriching {filtered.length} tasks...</div>
      <div style={{fontSize:11,color:"var(--t3)"}}>Looking up phone numbers via Apollo. This may take a minute.</div>
    </div>)}

    {/* ─── RESULTS ─── */}
    {step==="results"&&(<div>
      <div style={{display:"flex",gap:10,marginBottom:16}}>
        <div style={{padding:"10px 14px",background:"var(--hover)",borderRadius:8,flex:1}}>
          <div style={{fontSize:18,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--t1)"}}>{enrichResults.length}</div>
          <div style={{fontSize:9,color:"var(--t3)"}}>Processed</div>
        </div>
        <div style={{padding:"10px 14px",background:"var(--hover)",borderRadius:8,flex:1}}>
          <div style={{fontSize:18,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--grn)"}}>{enrichedWithPhone.length}</div>
          <div style={{fontSize:9,color:"var(--t3)"}}>Phone Found</div>
        </div>
        <div style={{padding:"10px 14px",background:"var(--hover)",borderRadius:8,flex:1}}>
          <div style={{fontSize:18,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:"var(--red)"}}>{enrichResults.length - enrichResults.filter(r=>r.found).length}</div>
          <div style={{fontSize:9,color:"var(--t3)"}}>Not Found</div>
        </div>
      </div>

      {enrichedWithPhone.length > 0 && (<div style={{maxHeight:300,overflowY:"auto",marginBottom:14}}>
        <table><thead><tr><th>Name</th><th>Company</th><th>Phone</th><th>Status</th></tr></thead>
        <tbody>{enrichResults.map((r, i) => (
          <tr key={i}><td style={{color:"var(--t1)",fontWeight:500}}>{r.name}</td><td>{r.company}</td>
          <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color:r.phone?"var(--grn)":"var(--t3)"}}>{r.phone || r.mobile || "—"}</td>
          <td><span className={"chip "+(r.found?"cg":"cr")}>{r.found?(r.phone?"Phone found":"Found, no phone"):"Not found"}</span></td></tr>
        ))}</tbody></table>
      </div>)}

      <div style={{fontSize:10,color:"var(--grn)",marginBottom:8}}>✅ Phone numbers saved to Airtable tasks</div>
    </div>)}

    {/* ─── PUSH TO HUBSPOT ─── */}
    {step==="push"&&(<div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:14,lineHeight:1.5}}>
        Push {selectedTasks.size > 0 ? selectedTasks.size + " selected" : "filtered"} tasks to HubSpot as activities.
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <div className="ig" style={{marginBottom:0}}>
          <div className="il">Task Rule</div>
          <select className="inp" value={ruleFilter} onChange={e=>setRuleFilter(e.target.value)}>
            <option value="all">All Rules</option>
            {ruleNames.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="ig" style={{marginBottom:0}}>
          <div className="il">Assign To</div>
          <select className="inp" value={ownerId} onChange={e=>setOwnerId(e.target.value)}>
            <option value="">Unassigned</option>
            {hsOwners.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12,marginBottom:14}}>
        <div className="ig" style={{marginBottom:0}}><div className="il">Priority</div>
          <select className="inp" value={priority} onChange={e=>setPriority(e.target.value)}>
            <option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
          </select>
        </div>
        <div className="ig" style={{marginBottom:0}}><div className="il">Min Score</div>
          <input type="number" className="inp" value={scoreMin} onChange={e=>setScoreMin(+e.target.value)} min={0} max={100}/>
        </div>
        <div className="ig" style={{marginBottom:0}}><div className="il">From</div>
          <input type="date" className="inp" value={dateFrom} onChange={e=>setDateFrom(e.target.value)}/>
        </div>
        <div className="ig" style={{marginBottom:0}}><div className="il">To</div>
          <input type="date" className="inp" value={dateTo} onChange={e=>setDateTo(e.target.value)}/>
        </div>
      </div>
      <div style={{padding:10,background:"var(--hover)",borderRadius:8,marginBottom:14,fontSize:11,color:"var(--t2)"}}>
        📋 {filtered.length} tasks will be pushed to HubSpot
      </div>
    </div>)}

    </div>
    <div className="modal-f">
      {step==="select"&&<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={enrichLoading||!filtered.length} onClick={async()=>{setStep("enriching");const r=await onEnrich(filtered);if(r)setStep("results");else setStep("select")}}><I.Sparkle/> Enrich {filtered.length} Tasks</button></>}
      {step==="results"&&<><button className="btn" onClick={onClose}>Done</button>{hsConnected&&enrichedWithPhone.length>0&&<button className="btn btn-p" onClick={()=>setStep("push")}>Push to HubSpot →</button>}</>}
      {step==="push"&&<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={hsLoading||!filtered.length} onClick={async()=>{await onPush(filtered,{ownerId,priority,status:"NOT_STARTED",mode:"smart"});onClose()}}>{hsLoading?"⏳":"📤 Push "+filtered.length+" Tasks"}</button></>}
      {step==="enriching"&&<button className="btn" disabled>⏳ Processing...</button>}
    </div>
  </div></div>);
}

// ═══════════════════════════════════════════════════════════════
// ADD CAMPAIGN — URL → discover → name + features → save
// ═══════════════════════════════════════════════════════════════
function AddCampaignModal({ onSave, onClose }) {
  const [step, setStep] = useState("url");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [disc, setDisc] = useState(null);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("📊");
  const [desc, setDesc] = useState("");
  const [feats, setFeats] = useState([]);

  const discover = async () => {
    setBusy(true); setErr("");
    try {
      const res = await fetch("/api/airtable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "discover", baseUrl: url }) });
      const d = await res.json();
      if (d.error) { setErr(d.error); setBusy(false); return; }
      setDisc(d); setStep("config");
    } catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try { await onSave({ name: name.trim(), baseId: disc.baseId, features: feats, emoji, desc, tables: disc.tableNames.join(", ") }); onClose(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const toggleFeat = (id) => setFeats(p => p.includes(id) ? p.filter(f => f !== id) : [...p, id]);

  return (<div className="modal-o" onClick={e => e.target === e.currentTarget && onClose()}><div className="modal" style={{ maxWidth: 540 }}>
    <div className="modal-h"><span style={{ fontWeight: 600 }}>Add Campaign</span><button className="btn btn-s" onClick={onClose}>✕</button></div>
    <div className="modal-b">
      {step === "url" && (<>
        <div className="ig"><div className="il">Airtable Base URL or ID</div>
          <input className="inp" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://airtable.com/appXXXXXXXXXXX" onKeyDown={e => { if (e.key === "Enter" && url.trim()) discover(); }} autoFocus />
          <div style={{ fontSize: 10, color: "var(--t3)", marginTop: 6 }}>Paste your Airtable base URL. We'll auto-detect the tables.</div>
        </div>
      </>)}

      {step === "config" && disc && (<>
        <div style={{ padding: 12, background: "var(--grn-d)", borderRadius: 8, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "var(--grn)", marginBottom: 4 }}>✅ Connected</div>
          <div style={{ fontSize: 10, color: "var(--t2)", fontFamily: "'JetBrains Mono',monospace" }}>{disc.baseId}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>{disc.tableNames.map(t => (<span key={t} style={{ padding: "2px 8px", borderRadius: 4, fontSize: 10, background: "var(--hover)", color: "var(--t2)", border: "1px solid var(--bdr)" }}>{t}</span>))}</div>
        </div>
        <div className="ig"><div className="il">Campaign Name</div><input className="inp" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sprinto Outbound" autoFocus /></div>
        <div className="ig"><div className="il">Description</div><input className="inp" value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional" /></div>
        <div className="ig"><div className="il">Icon</div><div style={{ display: "flex", gap: 4 }}>{["📊","📡","🎯","🚀","💼","🔍","📈","⚡","🏢","🎪"].map(em => (
            <button key={em} style={{ fontSize: 18, padding: "4px 6px", background: emoji === em ? "var(--acc-d)" : "transparent", border: "1px solid " + (emoji === em ? "var(--acc)" : "var(--bdr)"), borderRadius: 6, cursor: "pointer" }} onClick={() => setEmoji(em)}>{em}</button>
          ))}</div></div>
        <div className="ig"><div className="il">Starting Task Types (optional)</div><div style={{ fontSize: 10, color: "var(--t3)", marginBottom: 8 }}>Select which task types you plan to use first. This personalizes your Task Rules page with relevant guides. You can always add any task type later.</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{ALL_FEATURES.map(f => (
            <div key={f.id} onClick={() => toggleFeat(f.id)} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", border: "1px solid " + (feats.includes(f.id) ? "var(--acc)" : "var(--bdr)"), borderRadius: 8, background: feats.includes(f.id) ? "var(--acc-d)" : "var(--card)", cursor: "pointer", transition: "all .15s" }}>
              <span style={{ fontSize: 20 }}>{f.emoji}</span>
              <div style={{ flex: 1 }}><div style={{ fontSize: 12, fontWeight: 600, color: feats.includes(f.id) ? "var(--acc)" : "var(--t1)" }}>{f.label}</div><div style={{ fontSize: 10, color: "var(--t3)", marginTop: 2 }}>{f.desc}</div></div>
              <div style={{ width: 20, height: 20, borderRadius: 4, border: "2px solid " + (feats.includes(f.id) ? "var(--acc)" : "var(--bdr)"), display: "flex", alignItems: "center", justifyContent: "center", background: feats.includes(f.id) ? "var(--acc)" : "transparent" }}>{feats.includes(f.id) && <I.Check />}</div>
            </div>
          ))}</div>
        </div>
      </>)}
      {err && <div style={{ padding: 10, background: "var(--red-d)", borderRadius: 6, fontSize: 11, color: "var(--red)", marginTop: 8 }}>{err}</div>}
    </div>
    <div className="modal-f">
      <button className="btn" onClick={onClose}>Cancel</button>
      {step === "url" && <button className="btn btn-p" onClick={discover} disabled={!url.trim() || busy}>{busy ? "Connecting…" : <><I.Link /> Connect</>}</button>}
      {step === "config" && <button className="btn btn-p" onClick={save} disabled={!name.trim() || busy}>{busy ? "Saving…" : <><I.Check /> Create</>}</button>}
    </div>
  </div></div>);
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED RULE EDITOR — task type picker at top, form adapts
// ═══════════════════════════════════════════════════════════════
function RuleEditor({rule,onSave,onClose,availableFields,baseId}){
  const isTopX = rule.taskType === "top_x";
  const isOutreach = rule.taskType === "linkedin_outreach";
  const [mode, setMode] = useState(isOutreach ? "outreach" : isTopX ? "top_x" : "signal");

  // Signal + Top X fields
  const [f,sF]=useState({airtableId:rule.airtableId||null,name:rule.name||"",description:rule.description||"",taskType:rule.taskType||"news",scanTarget:rule.scanTarget||(isTopX?"leads":"accounts"),ease:rule.ease||"Medium",strength:rule.strength||"Medium",sources:rule.sources||["News"],keywords:rule.keywords||[],jobTitleKeywords:rule.jobTitleKeywords||[],scoringPrompt:rule.scoringPrompt||"",
    topN:rule.topN||10,scoringFields:rule.scoringFields||[],
    smartCompile:rule.smartCompile||false,compiledRules:rule.compiledRules||null,compiledAt:rule.compiledAt||null,compileStatus:rule.compileStatus||"missing"});

  // Smart Compile UI state
  const [compiling, setCompiling] = useState(false);
  const [compileErr, setCompileErr] = useState("");
  const [compileWarnings, setCompileWarnings] = useState([]);
  const [showCompiledJSON, setShowCompiledJSON] = useState(false);
  const [editedJSON, setEditedJSON] = useState(""); // raw text in the JSON editor
  const [jsonParseErr, setJsonParseErr] = useState("");
  // When prompt changes after compile, mark stale
  const [lastCompiledPrompt, setLastCompiledPrompt] = useState(rule.scoringPrompt || "");
  const promptIsStale = f.smartCompile && f.compiledRules && f.scoringPrompt.trim() !== lastCompiledPrompt.trim();

  // Outreach config
  const [oc, setOc] = useState(rule.outreachConfig || {
    leadsPerBatch: 10, connectionsPerDay: 5, connectionMessage: "",
    daysAfterConnect: 2, leadPrompt: "", active: true,
    dmSequence: [{ step: 1, daysAfterConnect: 2, daysAfterPrev: 0, message: "Hi {first_name}, thanks for connecting!", aiGenerate: false }],
  });

  const [ki,sKi]=useState("");const [ji,sJi]=useState("");const [aiL,sAiL]=useState(false);

  // Top X helpers
  const tbl = f.scanTarget === "accounts" ? "Accounts" : "Leads";
  const allFlds = (availableFields[tbl]||[]);
  const addSF = (n) => { if (!f.scoringFields.some(s => s.field === n)) sF(p => ({...p, scoringFields: [...p.scoringFields, {field: n, weight: 20}]})); };
  const remSF = (n) => sF(p => ({...p, scoringFields: p.scoringFields.filter(s => s.field !== n)}));
  const updSF = (n, w) => sF(p => ({...p, scoringFields: p.scoringFields.map(s => s.field === n ? {...s, weight: Math.max(0, Math.min(100, w))} : s)}));
  const tw = f.scoringFields.reduce((s, x) => s + x.weight, 0);

  // Outreach DM sequence helpers
  const addDmStep = () => setOc(p => ({...p, dmSequence: [...p.dmSequence, { step: p.dmSequence.length + 1, daysAfterPrev: 3, message: "", aiGenerate: false }]}));
  const removeDmStep = (i) => setOc(p => ({...p, dmSequence: p.dmSequence.filter((_, idx) => idx !== i).map((s, idx) => ({...s, step: idx + 1}))}));
  const updateDmStep = (i, updates) => setOc(p => ({...p, dmSequence: p.dmSequence.map((s, idx) => idx === i ? {...s, ...updates} : s)}));

  const canSave = mode === "outreach"
    ? f.name.trim() && oc.dmSequence.length > 0
    : mode === "top_x"
      ? f.name.trim() && (f.scoringFields.length > 0 || f.scoringPrompt.trim())
      : f.name.trim();

  const handleSave = () => {
    if (mode === "outreach") {
      onSave({...f, taskType: "linkedin_outreach", outreachConfig: oc});
    } else if (mode === "top_x") {
      onSave({...f, taskType: "top_x"});
    } else {
      const hJP = f.sources.includes("Job Posts");
      const hN = f.sources.some(s => ["News","New Hires","Social","Exits / Promotions","Custom","Earnings","SEC Filings"].includes(s));
      onSave({...f, taskType: hJP && hN ? "both" : hJP ? "job_post" : "news"});
    }
  };

  return(<div className="modal-o" onClick={e=>e.target===e.currentTarget&&onClose()}><div className="modal" style={{maxWidth:mode==="outreach"?700:mode==="top_x"?620:560}}><div className="modal-h"><span style={{fontWeight:600}}>{f.airtableId?"Edit Rule":"New Rule"}</span><button className="btn btn-s" onClick={onClose}>✕</button></div>
  <div className="modal-b">

  {/* Task Type Picker */}
  <div className="ig">
    <div className="il">Task Type</div>
    <div style={{display:"flex",gap:6}}>
      <button className={"btn btn-s"+(mode==="signal"?" btn-p":"")} onClick={()=>setMode("signal")} style={{flex:1,justifyContent:"center",fontSize:10}}>📰 Signal</button>
      <button className={"btn btn-s"+(mode==="top_x"?" btn-p":"")} onClick={()=>setMode("top_x")} style={{flex:1,justifyContent:"center",fontSize:10}}>🎯 Top X</button>
      <button className={"btn btn-s"+(mode==="outreach"?" btn-p":"")} onClick={()=>setMode("outreach")} style={{flex:1,justifyContent:"center",fontSize:10}}>💬 Outreach</button>
    </div>
  </div>

  {/* Shared fields */}
  <div className="ig"><div className="il">Name</div><input className="inp" value={f.name} onChange={e=>sF(p=>({...p,name:e.target.value}))} placeholder={mode==="outreach"?"e.g. Q1 LinkedIn outreach":mode==="top_x"?"e.g. Top 50 most engaged leads":"e.g. CMO / CGO opening"}/></div>
  <div className="ig"><div className="il">Description</div><textarea className="inp ta" value={f.description} onChange={e=>sF(p=>({...p,description:e.target.value}))} style={{minHeight:40}}/></div>

  {/* ──── SIGNAL MODE ──── */}
  {mode==="signal"&&(<>
  <div className="ig"><div className="il">Scan Target</div><div style={{display:"flex",gap:6}}>{[{v:"accounts",l:"🏢 Accounts"},{v:"leads",l:"👤 Leads"},{v:"both",l:"🏢👤 Both"}].map(o=>(<button key={o.v} className={"btn btn-s"+(f.scanTarget===o.v?" btn-p":"")} onClick={()=>sF(p=>({...p,scanTarget:o.v}))}>{o.l}</button>))}</div></div>
  <div className="ig"><div className="il">Signal Sources</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{SRC_OPTS.map(s=>(<button key={s} className={"stag"+(f.sources.includes(s)?" sel":"")} onClick={()=>sF(p=>({...p,sources:p.sources.includes(s)?p.sources.filter(x=>x!==s):[...p.sources,s]}))}>{s}</button>))}</div></div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
  <div className="ig"><div className="il">Ease</div><div style={{display:"flex",gap:6}}>{["Easy","Medium","Hard"].map(v=>(<button key={v} className={"btn btn-s"+(f.ease===v?" btn-p":"")} onClick={()=>sF(p=>({...p,ease:v}))}>{v}</button>))}</div></div>
  <div className="ig"><div className="il">Strength</div><div style={{display:"flex",gap:6}}>{["Strong","Medium","Weak"].map(v=>(<button key={v} className={"btn btn-s"+(f.strength===v?" btn-p":"")} onClick={()=>sF(p=>({...p,strength:v}))}>{v}</button>))}</div></div></div>
  {f.sources.some(s=>["News","New Hires","Social","Exits / Promotions","Custom","Earnings","SEC Filings"].includes(s))&&<div className="ig"><div className="il">Keywords</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>{f.keywords.map((k,i)=>(<span key={i} className="kt" onClick={()=>sF(p=>({...p,keywords:p.keywords.filter(x=>x!==k)}))}>{k} ×</span>))}</div>
  <div style={{display:"flex",gap:6}}><input className="inp" placeholder="Add keywords (comma separated)…" value={ki} onChange={e=>sKi(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&ki.trim()){e.preventDefault();const nk=ki.split(",").map(k=>k.trim()).filter(Boolean);sF(p=>({...p,keywords:[...p.keywords,...nk.filter(k=>!p.keywords.includes(k))]}));sKi("")}}} style={{flex:1}}/><button className="btn btn-s" onClick={()=>{if(ki.trim()){const nk=ki.split(",").map(k=>k.trim()).filter(Boolean);sF(p=>({...p,keywords:[...p.keywords,...nk.filter(k=>!p.keywords.includes(k))]}));sKi("")}}}><I.Plus/></button></div></div>}
  {f.sources.includes("Job Posts")&&<div className="ig"><div className="il">Job Title Keywords</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>{f.jobTitleKeywords.map((k,i)=>(<span key={i} className="kt" style={{background:"var(--blu-d)",color:"var(--blu)"}} onClick={()=>sF(p=>({...p,jobTitleKeywords:p.jobTitleKeywords.filter(x=>x!==k)}))}>{k} ×</span>))}</div>
  <div style={{display:"flex",gap:6}}><input className="inp" placeholder="e.g. CMO, VP Marketing, Head of Growth…" value={ji} onChange={e=>sJi(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&ji.trim()){e.preventDefault();const nk=ji.split(",").map(k=>k.trim()).filter(Boolean);sF(p=>({...p,jobTitleKeywords:[...p.jobTitleKeywords,...nk.filter(k=>!p.jobTitleKeywords.includes(k))]}));sJi("")}}} style={{flex:1}}/><button className="btn btn-s" onClick={()=>{if(ji.trim()){const nk=ji.split(",").map(k=>k.trim()).filter(Boolean);sF(p=>({...p,jobTitleKeywords:[...p.jobTitleKeywords,...nk.filter(k=>!p.jobTitleKeywords.includes(k))]}));sJi("")}}}><I.Plus/></button></div></div>}
  <div style={{padding:14,border:"1px solid rgba(191,163,90,.3)",borderRadius:8,background:"rgba(191,163,90,.05)"}}>
  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span>🎯</span><span style={{fontSize:11,fontWeight:600,color:"var(--acc)"}}>SCORING PROMPT</span></div>
  <div style={{fontSize:10,color:"var(--t3)",marginBottom:8,lineHeight:1.6,padding:10,background:"var(--card)",borderRadius:6}}>
    <div style={{fontWeight:600,color:"var(--t2)",marginBottom:4}}>📋 Prompt format guide <span style={{fontWeight:400,color:"var(--t3)",fontSize:9}}>· See full contract in Prompts tab</span></div>
    <div style={{marginBottom:3}}>Your prompt is <strong style={{color:"var(--t2)"}}>the single source of truth</strong> for scoring. No hardcoded rules compete with it.</div>
    <div style={{marginBottom:3}}>Define 4 tiers: <strong style={{color:"var(--t2)"}}>90-100</strong> (exact match with examples), <strong style={{color:"var(--t2)"}}>70-89</strong> (strong but incomplete), <strong style={{color:"var(--t2)"}}>50-69</strong> (tangential), <strong style={{color:"var(--t2)"}}>&lt;50</strong> (reject — most important tier).</div>
    <div style={{marginBottom:3}}>✅ Include concrete examples: <em>"CMO steps down after 10 months" scores 95, "Company hires new CMO" scores 45</em></div>
    <div style={{marginBottom:3}}>❌ List <strong style={{color:"var(--t2)"}}>false positives to reject</strong>: e.g. for "Senior marketer exits" — <em>"a robotics leader leaving is NOT a marketer, score below 30"</em></div>
    <div style={{marginTop:6,fontSize:9,color:"var(--t3)",fontStyle:"italic"}}>The AI returns: <code>&#123;matches:[&#123;idx, score, reason&#125;]&#125;</code> — score &amp; reason saved to each task.</div>
  </div>
  <textarea className="inp ta" value={f.scoringPrompt} onChange={e=>sF(p=>({...p,scoringPrompt:e.target.value}))} placeholder={"Rate this signal on how directly it [describes the event].\n\nAssign 90-100 if [exact match criteria with example].\nScore 70-89 if [strong but incomplete match].\nAssign 50-69 if [tangential mention].\nScore below 50 if [rejection criteria — be specific].\n\nFalse positives to reject: [list what does NOT count].\nExamples: \"[example A]\" scores 95, \"[example B]\" scores 40."} style={{minHeight:120,fontSize:11,background:"var(--card)"}}/>
  <button className="btn btn-ai btn-s" style={{marginTop:6}} disabled={aiL||!f.name} onClick={async()=>{sAiL(true);try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.name,taskDescription:f.description,taskKeywords:f.keywords,taskJobTitleKeywords:f.jobTitleKeywords,taskSources:f.sources})});if(res.ok){const d=await res.json();if(d.scoringPrompt)sF(p=>({...p,scoringPrompt:d.scoringPrompt}))}}catch(e){console.error(e)}sAiL(false)}}>{aiL?"Generating…":<><I.Sparkle/> Auto-Generate</>}</button></div>
  </>)}

  {/* ──── TOP X MODE ──── */}
  {mode==="top_x"&&(<>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
    <div className="ig"><div className="il">Scan Target</div><div style={{display:"flex",gap:6}}>{[{v:"leads",l:"👤 Leads"},{v:"accounts",l:"🏢 Accounts"}].map(o=>(<button key={o.v} className={"btn btn-s"+(f.scanTarget===o.v?" btn-p":"")} onClick={()=>sF(p=>({...p,scanTarget:o.v,scoringFields:[]}))}>{o.l}</button>))}</div></div>
    <div className="ig"><div className="il">Top N</div><input type="number" className="inp" value={f.topN} onChange={e=>sF(p=>({...p,topN:parseInt(e.target.value)||10}))} min={1} max={500} style={{width:100}}/></div>
  </div>

  {/* Scoring Fields & Weights */}
  <div className="ig">
    <div className="il">Scoring Fields & Weights <span style={{fontSize:9,color:"var(--t3)",fontWeight:400}}>— optional if using AI prompt</span></div>
    {f.scoringFields.length>0&&<div style={{marginBottom:10}}>{f.scoringFields.map(sf=>(<div key={sf.field} className="wt-row"><span className="wt-name">{sf.field}</span><input type="range" className="sld" style={{width:120}} min="0" max="100" value={sf.weight} onChange={e=>updSF(sf.field,parseInt(e.target.value))}/><span className="wt-pct">{sf.weight}%</span><button style={{background:"none",border:"none",color:"var(--red)",cursor:"pointer",padding:"0 4px"}} onClick={()=>remSF(sf.field)}>×</button></div>))}<div style={{fontSize:10,color:tw===100?"var(--grn)":"var(--amb)"}}>Total: {tw}%{tw!==100?" (normalized)":""}</div></div>}
    <select className="inp" onChange={e=>{if(e.target.value)addSF(e.target.value);e.target.value=""}} defaultValue=""><option value="" disabled>+ Add field…</option>{allFlds.filter(fd=>!f.scoringFields.some(s=>s.field===fd.name)).map(fd=>(<option key={fd.name} value={fd.name}>{fd.name} ({fd.type})</option>))}</select>
    {allFlds.length===0&&<div style={{marginTop:6,fontSize:10,color:"var(--amb)"}}>⚠️ No fields in {tbl}. Upload a CSV first.</div>}
  </div>

  {/* Preview */}
  {(f.scoringFields.length>0||f.scoringPrompt.trim())&&<div style={{padding:12,border:"1px solid rgba(155,126,216,.3)",borderRadius:8,background:"rgba(155,126,216,.05)",fontSize:11}}>
    <span style={{fontWeight:600,color:"var(--pur)"}}>🎯 Preview:</span> Read all {tbl.toLowerCase()}
    {f.scoringFields.length>0&&<>, numeric score by {f.scoringFields.map(s=>s.field+" ("+s.weight+"%)").join(", ")}</>}
    {f.scoringPrompt.trim()&&<>{f.scoringFields.length>0?" + ":" "}AI scores using all record data + your prompt</>}
    , return top {f.topN}.
  </div>}

  {/* AI Scoring Prompt */}
  <div style={{padding:14,border:"1px solid rgba(191,163,90,.2)",borderRadius:8,background:"rgba(191,163,90,.03)"}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span>🧠</span><span style={{fontSize:11,fontWeight:600,color:"var(--acc)"}}>AI SCORING PROMPT</span><span style={{fontSize:9,color:"var(--t3)",fontWeight:400}}>{f.scoringFields.length>0?"(optional)":"(required without scoring fields)"}</span></div>
    <div style={{fontSize:10,color:"var(--t3)",marginBottom:8,lineHeight:1.6}}>
      Describe your scoring criteria in plain language. AI reads ALL fields on each record and scores 0-100. You can use this alone (pure AI scoring) or alongside weighted fields (blended 40% numeric + 60% AI).
    </div>
    <div style={{fontSize:10,color:"var(--t3)",marginBottom:10,lineHeight:1.6,padding:10,background:"var(--hover)",borderRadius:6}}>
      <div style={{fontWeight:600,color:"var(--t2)",marginBottom:4}}>📋 Prompt format guide</div>
      <div style={{marginBottom:4}}>Your prompt should describe <strong style={{color:"var(--t2)"}}>what makes a lead/account high-priority vs low-priority</strong>. The AI will return a score (0-100) and a short reason for each record.</div>
      <div style={{marginBottom:4}}>✅ <strong style={{color:"var(--t2)"}}>Do:</strong> Define scoring tiers (e.g. 80-100 = hot, 60-79 = warm), reference specific fields (e.g. "prioritize marketing team size &gt; 50"), include override rules.</div>
      <div style={{marginBottom:4}}>❌ <strong style={{color:"var(--t2)"}}>Don't:</strong> Ask AI to return custom JSON, custom formatting, or multi-field outputs. The system handles the output format — just describe your criteria.</div>
      <div>💡 <strong style={{color:"var(--t2)"}}>Tip:</strong> The more specific you are about thresholds and weights, the more consistent the scores. E.g. "Score 90+ if ACV &gt; 8 AND relevance &gt; 7" beats "score high if they look good".</div>
    </div>
    <textarea className="inp ta" value={f.scoringPrompt} onChange={e=>sF(p=>({...p,scoringPrompt:e.target.value}))} placeholder={"Score leads 0-100 based on fit for our product.\n\nScoring tiers:\n• 80-100: High ACV (7+), strong relevance (7+), large teams\n• 60-79: Moderate ACV, good relevance, mid-size teams\n• 40-59: Mixed signals, worth nurturing\n• Below 40: Weak fit, deprioritize\n\nOverride: If relevance < 3, cap at 30. If ACV > 8 AND relevance > 7, add +10 bonus."} style={{minHeight:100,fontSize:11,background:"var(--card)"}}/>
  </div>

  {/* ─── SMART COMPILE PANEL ───
      Lets the user opt into the rules-extraction flow. AI reads the prompt once,
      extracts deterministic rules, then JS scores all records without further AI calls.
      Vastly cheaper and faster for large lead lists, especially when criteria are pattern-based.
   */}
  <div style={{padding:14,border:"1px solid rgba(93,168,122,.25)",borderRadius:8,background:"rgba(93,168,122,.04)",marginTop:14}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}>
        <span>⚡</span>
        <span style={{fontSize:11,fontWeight:600,color:"var(--grn)"}}>SMART COMPILE</span>
        <span style={{fontSize:9,color:"var(--t3)",fontWeight:400,padding:"2px 6px",background:"var(--hover)",borderRadius:3}}>BETA</span>
      </div>
      <label style={{display:"flex",alignItems:"center",gap:6,cursor:"pointer",fontSize:11,color:"var(--t2)"}}>
        <input type="checkbox" checked={f.smartCompile} onChange={e=>sF(p=>({...p,smartCompile:e.target.checked}))}/>
        Enable for this rule
      </label>
    </div>
    <div style={{fontSize:10,color:"var(--t3)",marginBottom:10,lineHeight:1.5}}>
      Instead of calling AI on every record, AI reads your prompt <strong>once</strong> and extracts deterministic rules. JS scores all records in milliseconds.
      Best for large lists (500+) where prompt is mostly pattern-matching. AI fallback handles fuzzy criteria.
    </div>

    {f.smartCompile && (<>
      {!f.scoringPrompt.trim() ? (
        <div style={{fontSize:10,color:"var(--amb)",padding:8,background:"rgba(191,163,90,.08)",borderRadius:4}}>
          ⚠️ Write your scoring prompt above first, then click Compile.
        </div>
      ) : (<>
        {/* Compile / Recompile button */}
        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
          <button className="btn btn-ai btn-s" disabled={compiling||!f.scoringPrompt.trim()} onClick={async()=>{
            setCompiling(true); setCompileErr(""); setCompileWarnings([]);
            try {
              const res = await fetch("/api/airtable", {
                method:"POST", headers:{"Content-Type":"application/json"},
                body: JSON.stringify({ action:"compile_topx_rules", baseId: baseId || rule.baseId || undefined, prompt: f.scoringPrompt, scanTarget: f.scanTarget }),
              });
              const d = await res.json();
              if (d.error) { setCompileErr(d.error); }
              else if (d.ok && d.compiled) {
                sF(p => ({...p, compiledRules: d.compiled, compiledAt: d.compiled.compiled_at, compileStatus: "fresh"}));
                setLastCompiledPrompt(f.scoringPrompt);
                setEditedJSON(JSON.stringify(d.compiled, null, 2));
                setShowCompiledJSON(true);
                if (d.warnings?.length) setCompileWarnings(d.warnings);
              }
            } catch (e) { setCompileErr(e.message); }
            setCompiling(false);
          }}>
            {compiling ? "⏳ Compiling..." : f.compiledRules ? <><I.Sparkle/> Recompile</> : <><I.Sparkle/> Compile to Rules</>}
          </button>
          {f.compiledRules && (
            <button className="btn btn-s" onClick={()=>{
              setEditedJSON(JSON.stringify(f.compiledRules, null, 2));
              setShowCompiledJSON(s=>!s);
            }}>
              {showCompiledJSON ? "Hide" : "View"} compiled rules ({f.compiledRules.rules?.length || 0})
            </button>
          )}
          {f.compiledAt && (
            <span style={{fontSize:9,color:"var(--t3)"}}>Compiled {new Date(f.compiledAt).toLocaleString()}</span>
          )}
        </div>

        {compileErr && (
          <div style={{fontSize:10,color:"var(--red)",padding:8,background:"rgba(239,68,68,.08)",borderRadius:4,marginBottom:8}}>
            ❌ {compileErr}
          </div>
        )}

        {compileWarnings.length > 0 && (
          <div style={{fontSize:10,color:"var(--amb)",padding:8,background:"rgba(191,163,90,.08)",borderRadius:4,marginBottom:8}}>
            ⚠️ Compile warnings:
            {compileWarnings.map((w,i)=><div key={i} style={{marginTop:2}}>• {w}</div>)}
          </div>
        )}

        {promptIsStale && f.compiledRules && (
          <div style={{fontSize:10,color:"var(--amb)",padding:8,background:"rgba(191,163,90,.08)",borderRadius:4,marginBottom:8}}>
            ⚠️ Prompt has changed since last compile. Click Recompile to refresh rules, or run with stale rules.
          </div>
        )}

        {/* Compiled rules JSON editor */}
        {showCompiledJSON && f.compiledRules && (
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:"var(--t2)",marginBottom:6,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span>📜 Compiled rules — edit if needed, then save</span>
              <div style={{display:"flex",gap:6}}>
                <button className="btn btn-s" onClick={()=>{
                  try {
                    const parsed = JSON.parse(editedJSON);
                    if (!Array.isArray(parsed.rules)) throw new Error("Missing 'rules' array");
                    sF(p=>({...p, compiledRules: parsed}));
                    setJsonParseErr("");
                  } catch (e) { setJsonParseErr(e.message); }
                }}>Save edits</button>
                <button className="btn btn-s" onClick={()=>{
                  setEditedJSON(JSON.stringify(f.compiledRules, null, 2));
                  setJsonParseErr("");
                }}>Reset</button>
              </div>
            </div>
            <textarea
              className="inp ta"
              value={editedJSON}
              onChange={e=>setEditedJSON(e.target.value)}
              style={{minHeight:200,fontSize:10,fontFamily:"'JetBrains Mono',monospace",background:"var(--card)"}}
              spellCheck={false}
            />
            {jsonParseErr && <div style={{fontSize:10,color:"var(--red)",marginTop:4}}>JSON error: {jsonParseErr}</div>}

            {/* Quick rule summary for non-JSON-readers */}
            <div style={{marginTop:10,padding:10,background:"var(--hover)",borderRadius:4,fontSize:10,color:"var(--t2)",lineHeight:1.6}}>
              <div style={{fontWeight:600,marginBottom:4,color:"var(--t1)"}}>📊 Rule summary</div>
              {(() => {
                const rules = f.compiledRules.rules || [];
                const hasAccountRules = rules.some(r => r.field?.startsWith("Account."));
                return (<>
                  {hasAccountRules && (
                    <div style={{marginBottom:8,padding:6,background:"rgba(91,143,212,.08)",borderRadius:3,fontSize:10,color:"var(--blu)"}}>
                      🔗 This rule cross-references Accounts. Leads will be matched to accounts by domain → website → company LinkedIn. Match coverage shown in scan result.
                    </div>
                  )}
                  {rules.map((r,i)=>{
                    const isAccount = r.field?.startsWith("Account.");
                    return (
                      <div key={i} style={{marginBottom:3}}>
                        <span style={{color:r.score_contribution >= 0 ? "var(--grn)" : "var(--red)"}}>
                          {r.score_contribution >= 0 ? "+" : ""}{r.score_contribution}
                        </span>
                        {" "}<span style={{color:"var(--t3)"}}>if</span>{" "}
                        {isAccount && <span style={{padding:"1px 4px",background:"rgba(91,143,212,.15)",color:"var(--blu)",borderRadius:2,fontSize:9,marginRight:3}}>ACCT</span>}
                        <strong>{isAccount ? r.field.slice("Account.".length) : r.field}</strong>{" "}
                        {r.operator}{" "}
                        {r.values ? r.values.slice(0,3).join(", ") + (r.values.length>3?"...":"") : r.value || (r.min!==undefined?`${r.min}-${r.max}`:"")}
                        {r.partial_credit && <span style={{color:"var(--t3)"}}> (partial: {Object.entries(r.partial_credit).map(([k,v])=>`${k}=${v}`).join(", ")})</span>}
                      </div>
                    );
                  })}
                </>);
              })()}
              {f.compiledRules.fuzzy_check?.enabled && (
                <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid var(--bdr)"}}>
                  <span style={{color:"var(--pur)"}}>🤖 Fuzzy AI check</span> on borderline candidates ({f.compiledRules.fuzzy_check.trigger_when_deterministic_score_between?.[0] || 40}-{f.compiledRules.fuzzy_check.trigger_when_deterministic_score_between?.[1] || 80}): {f.compiledRules.fuzzy_check.criterion?.slice(0,120)}
                </div>
              )}
              {f.compiledRules.notes && (
                <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid var(--bdr)",fontStyle:"italic",color:"var(--t3)"}}>
                  📝 {f.compiledRules.notes}
                </div>
              )}
            </div>
          </div>
        )}
      </>)}
    </>)}
  </div>
  </>)}

  {/* ──── OUTREACH MODE ──── */}
  {mode==="outreach"&&(<>
  <div style={{padding:14,border:"1px solid rgba(91,143,212,.3)",borderRadius:8,background:"rgba(91,143,212,.05)",marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span>🎯</span><span style={{fontSize:11,fontWeight:600,color:"var(--blu)"}}>LEAD SELECTION</span></div>
    <div className="ig"><div className="il">AI Lead Prompt <span style={{fontSize:9,color:"var(--t3)",fontWeight:400}}>— which leads should be targeted?</span></div>
      <textarea className="inp ta" value={oc.leadPrompt} onChange={e=>setOc(p=>({...p,leadPrompt:e.target.value}))} placeholder="e.g. Select VP+ in marketing at 200-5000 employee SaaS companies." style={{minHeight:50,fontSize:11}}/>
    </div>
    <CampaignTagPicker
      baseId={baseId}
      selected={oc.campaignTags || []}
      onChange={tags=>setOc(p=>({...p,campaignTags:tags}))}
    />
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
      <div className="ig"><div className="il">Leads per Batch</div><input type="number" className="inp" value={oc.leadsPerBatch} onChange={e=>setOc(p=>({...p,leadsPerBatch:parseInt(e.target.value)||10}))} min={1} max={100}/></div>
      <div className="ig"><div className="il">Connections / Day</div><input type="number" className="inp" value={oc.connectionsPerDay} onChange={e=>setOc(p=>({...p,connectionsPerDay:parseInt(e.target.value)||5}))} min={1} max={50}/></div>
    </div>
  </div>
  <div style={{padding:14,border:"1px solid rgba(155,126,216,.3)",borderRadius:8,background:"rgba(155,126,216,.05)",marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span>🔗</span><span style={{fontSize:11,fontWeight:600,color:"var(--pur)"}}>CONNECTION REQUEST</span></div>
    <div className="ig"><div className="il">Connection Note <span style={{fontSize:9,color:"var(--t3)",fontWeight:400}}>— leave empty for no note (300 chars max)</span></div>
      <textarea className="inp ta" value={oc.connectionMessage} onChange={e=>setOc(p=>({...p,connectionMessage:e.target.value.slice(0,300)}))} placeholder="Hi {first_name}, I noticed you're {title} at {company}. Would love to connect!" style={{minHeight:50,fontSize:11}} maxLength={300}/>
      <div style={{fontSize:9,color:"var(--t3)",marginTop:4,display:"flex",justifyContent:"space-between"}}><span>Merge: {"{first_name}"}, {"{company}"}, {"{title}"}, {"{signal}"}</span><span>{(oc.connectionMessage||"").length}/300</span></div>
    </div>
    <div className="ig"><div className="il">Days After Accept Before First DM</div>
      <input type="number" className="inp" value={oc.daysAfterConnect} onChange={e=>setOc(p=>({...p,daysAfterConnect:parseInt(e.target.value)||2}))} min={0} max={30} style={{width:100}}/>
    </div>
  </div>
  <div style={{padding:14,border:"1px solid rgba(191,163,90,.3)",borderRadius:8,background:"rgba(191,163,90,.05)"}}>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
      <div style={{display:"flex",alignItems:"center",gap:8}}><span>💬</span><span style={{fontSize:11,fontWeight:600,color:"var(--acc)"}}>DM SEQUENCE</span><span style={{fontSize:9,color:"var(--t3)"}}>({oc.dmSequence.length} step{oc.dmSequence.length!==1?"s":""})</span></div>
      <button className="btn btn-s" onClick={addDmStep} style={{fontSize:9}}><I.Plus/> Add Step</button>
    </div>
    {oc.dmSequence.map((step, i) => (
      <div key={i} style={{padding:12,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)",marginBottom:8}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
          <span style={{fontSize:11,fontWeight:600,color:"var(--acc)"}}>Step {i + 1}</span>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <label style={{display:"flex",alignItems:"center",gap:4,fontSize:10,color:"var(--t2)",cursor:"pointer"}}>
              <input type="checkbox" checked={step.aiGenerate||false} onChange={e=>updateDmStep(i,{aiGenerate:e.target.checked})} style={{accentColor:"var(--acc)",width:12,height:12}}/>
              🧠 AI Personalize
            </label>
            {oc.dmSequence.length > 1 && <button style={{background:"none",border:"none",color:"var(--red)",cursor:"pointer",fontSize:14,padding:"0 4px"}} onClick={()=>removeDmStep(i)}>×</button>}
          </div>
        </div>
        <div className="ig" style={{marginBottom:8}}>
          <div className="il">{i === 0 ? "Days After Connection Accepted" : "Days After Previous DM"}</div>
          <input type="number" className="inp" value={i===0?(step.daysAfterConnect??oc.daysAfterConnect??2):(step.daysAfterPrev??3)} onChange={e=>updateDmStep(i,i===0?{daysAfterConnect:parseInt(e.target.value)||0}:{daysAfterPrev:parseInt(e.target.value)||1})} min={0} max={60} style={{width:100}}/>
        </div>
        <div className="ig" style={{marginBottom:0}}>
          <div className="il">Message {step.aiGenerate?"(AI will personalize)":"(merge fields replaced)"}</div>
          <textarea className="inp ta" value={step.message} onChange={e=>updateDmStep(i,{message:e.target.value})} placeholder={i===0?"Hi {first_name}, thanks for connecting! I noticed {signal} at {company}...":"Hi {first_name}, following up..."} style={{minHeight:70,fontSize:11}}/>
          <div style={{fontSize:9,color:"var(--t3)",marginTop:4}}>Merge: {"{first_name}"}, {"{name}"}, {"{company}"}, {"{title}"}, {"{signal}"}</div>
        </div>
      </div>
    ))}
    <div style={{padding:10,background:"var(--hover)",borderRadius:6,fontSize:10,color:"var(--t2)",marginTop:8}}>
      📋 {oc.leadsPerBatch} leads → {oc.connectionsPerDay}/day connections{oc.connectionMessage?" with note":""} → {oc.daysAfterConnect}d wait → {oc.dmSequence.length} DM{oc.dmSequence.length!==1?"s":""}
    </div>
  </div>
  </>)}

  </div>
  <div className="modal-f"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={!canSave} onClick={handleSave}><I.Check/> {f.airtableId?"Save":"Add Rule"}</button></div>
  </div></div>);
}

// ═══════════════════════════════════════════════════════════════
// EXPORT MODAL
// ═══════════════════════════════════════════════════════════════
function ExportModal({ tasks, accounts, leads, onClose }) {
  // Task columns
  const defaultCols = ["Company","Task Rule","Score","Score Reason","Scan Target","Signal","Source","Task Type","Date","URL"];
  // Union of fields seen on existing tasks AND the default column list, so columns
  // like "Score Reason" appear as selectable even when no current task has the
  // field populated yet (Airtable strips empty-string fields from API responses).
  const seenCols = [...new Set(tasks.flatMap(t => Object.keys(t.fields || {})))];
  const allTaskCols = [...new Set([...seenCols, ...defaultCols])];
  const [selectedCols, setSelectedCols] = useState(() => allTaskCols.filter(c => defaultCols.includes(c)));

  // Enrichment columns from Accounts/Leads (exclude join keys)
  const acctCols = [...new Set((accounts || []).flatMap(a => Object.keys(a.fields || {})))].filter(c => c !== "Name");
  const leadCols = [...new Set((leads || []).flatMap(l => Object.keys(l.fields || {})))].filter(c => c !== "Name" && c !== "Company");
  const [enrichAcct, setEnrichAcct] = useState([]);
  const [enrichLead, setEnrichLead] = useState([]);

  const taskTypes = [...new Set(tasks.map(t => (t.fields || {})["Task Type"]).filter(Boolean))];
  const [exportTypes, setExportTypes] = useState(new Set(taskTypes));
  const [exportDatePreset, setExportDatePreset] = useState("all");
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");

  const toggleCol = (c) => setSelectedCols(p => p.includes(c) ? p.filter(x => x !== c) : [...p, c]);
  const toggleType = (t) => setExportTypes(p => { const n = new Set(p); if (n.has(t)) n.delete(t); else n.add(t); return n; });
  const toggleEA = (c) => setEnrichAcct(p => p.includes(c) ? p.filter(x => x !== c) : [...p, c]);
  const toggleEL = (c) => setEnrichLead(p => p.includes(c) ? p.filter(x => x !== c) : [...p, c]);

  const applyDatePreset = (preset) => {
    setExportDatePreset(preset);
    const now = new Date();
    const fmt = (d) => d.toISOString().slice(0, 10);
    switch (preset) {
      case "24h": setExportFrom(fmt(new Date(now - 86400000))); setExportTo(fmt(now)); break;
      case "7d": setExportFrom(fmt(new Date(now - 7*86400000))); setExportTo(fmt(now)); break;
      case "14d": setExportFrom(fmt(new Date(now - 14*86400000))); setExportTo(fmt(now)); break;
      case "30d": setExportFrom(fmt(new Date(now - 30*86400000))); setExportTo(fmt(now)); break;
      case "90d": setExportFrom(fmt(new Date(now - 90*86400000))); setExportTo(fmt(now)); break;
      default: setExportFrom(""); setExportTo(""); break;
    }
  };

  const filteredTasks = tasks.filter(t => {
    const f = t.fields || {};
    const tt = f["Task Type"] || "news";
    if (exportTypes.size > 0 && !exportTypes.has(tt)) return false;
    if (exportFrom && (f.Date || "") < exportFrom) return false;
    if (exportTo && (f.Date || "") > exportTo) return false;
    return true;
  });

  // Lookup maps for enrichment — multi-key to handle both account and lead-targeted tasks
  // For lead-targeted Top X: task.Company = lead's Company name (the company the lead works at)
  // For account-targeted scans: task.Company = account's Name (the company itself)
  // Some legacy tasks may have task.Company = lead's name (older bug). We index by all keys
  // to handle every case.
  //
  // Normalization helpers — same as cross-ref matching for consistency
  const normalizeMatch = (v) => {
    if (v === null || v === undefined) return "";
    let s = Array.isArray(v) ? v.join(",") : (typeof v === "object" ? (v.id || v.name || "") : String(v));
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  };
  const normalizeDomain = (v) => {
    if (!v) return "";
    let s = String(v).toLowerCase().trim();
    s = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
    s = s.split("/")[0].split("?")[0].split("#")[0].split(":")[0];
    return s.replace(/\.$/, "");
  };

  // Account index — by name AND by domain/website
  const acctMap = {};
  const acctByDomain = {};
  (accounts || []).forEach(a => {
    const n = normalizeMatch(a.fields?.Name);
    if (n) acctMap[n] = a.fields;
    const dom = normalizeDomain(a.fields?.Domain || a.fields?.["Company Domain"] || a.fields?.Website || a.fields?.["Company website"] || a.fields?.["Company Website"]);
    if (dom && !acctByDomain[dom]) acctByDomain[dom] = a.fields;
  });

  // Lead index — by Name (person), by Company (their employer), by Email domain, by LinkedIn URL.
  // Field name detection is permissive because real-world Airtable schemas vary:
  //   - "Company" vs "Company Name" vs "Account"
  //   - "Domain" vs "Company Domain" vs "Website" vs "Company website"
  //   - "LinkedIn URL" vs "Linkedin URL" vs "Lead Linkedin"
  const leadByName = {};
  const leadByCompany = {};
  const leadByDomain = {};
  const leadByLinkedIn = {};
  (leads || []).forEach(l => {
    const f = l.fields || {};
    const name = normalizeMatch(f.Name || f["Full Name"] || f["Lead: Full Name"]);
    const company = normalizeMatch(f.Company || f["Company Name"] || f.Account);
    if (name) leadByName[name] = f;
    if (company && !leadByCompany[company]) leadByCompany[company] = f;
    // Domain index — try several common field names AND email fallback
    const domSrc = f.Domain || f["Company Domain"] || f.Website || f["Company website"] || f["Company Website"] || (f.Email ? f.Email.split("@")[1] : "");
    const dom = normalizeDomain(domSrc);
    if (dom && !leadByDomain[dom]) leadByDomain[dom] = f;
    const li = normalizeMatch(f["LinkedIn URL"] || f["Linkedin URL"] || f["Lead Linkedin"] || f["Lead LinkedIn"]);
    if (li) leadByLinkedIn[li] = f;
  });

  // Coverage stats — show before export so user can see if enrichment is going to work
  const enrichmentCoverage = (() => {
    if (!leads.length && !accounts.length) return { leadHits: 0, acctHits: 0, total: tasks.length };
    let leadHits = 0, acctHits = 0;
    tasks.forEach(t => {
      const f = t.fields || {};
      const co = normalizeMatch(f.Company);
      const nm = normalizeMatch(f.Name);
      const li = normalizeMatch(f["LinkedIn URL"] || f.URL);
      const em = f.Email || "";
      const emDom = em ? normalizeDomain(em.split("@")[1] || "") : "";
      if (leadByName[nm] || leadByCompany[co] || leadByName[co] || (li && leadByLinkedIn[li]) || (emDom && leadByDomain[emDom])) leadHits++;
      if (acctMap[co] || (emDom && acctByDomain[emDom])) acctHits++;
    });
    return { leadHits, acctHits, total: tasks.length };
  })();

  const allExportCols = [...selectedCols, ...enrichAcct.map(c => "Acct: " + c), ...enrichLead.map(c => "Lead: " + c)];
  const enrichCount = enrichAcct.length + enrichLead.length;

  const doExport = () => {
    if (!filteredTasks.length || !allExportCols.length) return;
    const csvRows = [allExportCols.map(c => '"' + c.replace(/"/g, '""') + '"').join(",")];
    let leadEnriched = 0, acctEnriched = 0;
    filteredTasks.forEach(t => {
      const f = t.fields || {};
      const co = normalizeMatch(f.Company);
      const nm = normalizeMatch(f.Name);
      const li = normalizeMatch(f["LinkedIn URL"] || f.URL);
      const emDom = f.Email ? normalizeDomain(f.Email.split("@")[1] || "") : "";

      // Try multiple match strategies in priority order:
      // 1. By task.Name → leadByName (most direct — task created from this lead)
      // 2. By task.Company → leadByCompany (lead works at this company)
      // 3. By task.Company → leadByName (legacy bug where company field had lead's name)
      // 4. By LinkedIn URL → leadByLinkedIn
      // 5. By Email domain → leadByDomain
      const ld = leadByName[nm] || leadByCompany[co] || leadByName[co] || leadByLinkedIn[li] || leadByDomain[emDom] || {};
      if (Object.keys(ld).length > 0) leadEnriched++;

      // For account match: try task.Company → acctMap, then domain match,
      // then chain via lead's Company field
      const leadCompany = normalizeMatch(ld.Company);
      const ad = acctMap[co] || acctByDomain[emDom] || (leadCompany ? acctMap[leadCompany] : {}) || {};
      if (Object.keys(ad).length > 0) acctEnriched++;

      const row = allExportCols.map(c => {
        if (c.startsWith("Acct: ")) return String(ad[c.slice(6)] || "");
        if (c.startsWith("Lead: ")) return String(ld[c.slice(6)] || "");
        const v = f[c];
        return v === null || v === undefined ? "" : (Array.isArray(v) ? v.join(", ") : String(v));
      });
      csvRows.push(row.map(v => '"' + v.replace(/"/g, '""') + '"').join(","));
    });
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "signalscope-tasks-" + new Date().toISOString().slice(0, 10) + ".csv"; a.click();
    URL.revokeObjectURL(url);
    // Tell user how enrichment did, especially when it FAILED
    const enrichSummary = (enrichLead.length > 0 || enrichAcct.length > 0)
      ? ` (lead enriched: ${leadEnriched}/${filteredTasks.length}${enrichAcct.length > 0 ? `, account enriched: ${acctEnriched}/${filteredTasks.length}` : ""})`
      : "";
    if (enrichLead.length > 0 && leadEnriched === 0) {
      alert(`Export downloaded but ALL Lead enrichment columns came back empty.\n\nThis usually means the current campaign's Leads table doesn't contain the leads referenced by your tasks. Switch to the campaign that has the matching Leads, then re-export, OR uncheck the "Lead: ..." columns and rely on the direct task fields (Name, Lead Title, Email, etc.) instead.`);
    } else if (enrichSummary) {
      console.log(`[Export] Downloaded${enrichSummary}`);
    }
    onClose();
  };

  const chipStyle = (on, color) => ({ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", borderRadius: 4, border: "1px solid " + (on ? `var(--${color})` : "var(--bdr)"), background: on ? `var(--${color}-d)` : "var(--card)", cursor: "pointer", fontSize: 11, color: on ? `var(--${color})` : "var(--t2)", transition: "all .15s" });

  return (<div className="modal-o" onClick={e => e.target === e.currentTarget && onClose()}><div className="modal" style={{ maxWidth: 680 }}>
    <div className="modal-h"><span style={{ fontWeight: 600 }}>Export Tasks</span><button className="btn btn-s" onClick={onClose}>✕</button></div>
    <div className="modal-b">

      {/* Task Types */}
      <div className="ig">
        <div className="il">Task Types to Include</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {taskTypes.length === 0 ? <span style={{ fontSize: 11, color: "var(--t3)" }}>No tasks to export</span> :
            taskTypes.map(t => (<button key={t} className={"stag" + (exportTypes.has(t) ? " sel" : "")} onClick={() => toggleType(t)}>{t.replace(/_/g, " ")}</button>))}
          {taskTypes.length > 1 && <>
            <button className="btn btn-s" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setExportTypes(new Set(taskTypes))}>All</button>
            <button className="btn btn-s" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setExportTypes(new Set())}>None</button>
          </>}
        </div>
      </div>

      {/* Date Range */}
      <div className="ig">
        <div className="il">Date Range</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
          {[{l:"Past 24h",v:"24h"},{l:"7 days",v:"7d"},{l:"14 days",v:"14d"},{l:"30 days",v:"30d"},{l:"90 days",v:"90d"},{l:"All time",v:"all"}].map(p => (
            <button key={p.v} className={"stag" + (exportDatePreset === p.v ? " sel" : "")} onClick={() => applyDatePreset(p.v)}>{p.l}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="date" className="inp" style={{ width: 140, fontSize: 11, padding: "5px 8px" }} value={exportFrom} onChange={e => { setExportFrom(e.target.value); setExportDatePreset("custom"); }} />
          <span style={{ color: "var(--t3)", fontSize: 10 }}>to</span>
          <input type="date" className="inp" style={{ width: 140, fontSize: 11, padding: "5px 8px" }} value={exportTo} onChange={e => { setExportTo(e.target.value); setExportDatePreset("custom"); }} />
        </div>
      </div>

      {/* Task Columns */}
      <div className="ig">
        <div className="il">Task Columns</div>
        <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
          <button className="btn btn-s" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setSelectedCols([...allTaskCols])}>All</button>
          <button className="btn btn-s" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setSelectedCols([])}>Clear</button>
          <button className="btn btn-s" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setSelectedCols(allTaskCols.filter(c => defaultCols.includes(c)))}>Defaults</button>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {allTaskCols.map(c => (<label key={c} style={chipStyle(selectedCols.includes(c), "acc")}><input type="checkbox" checked={selectedCols.includes(c)} onChange={() => toggleCol(c)} style={{ accentColor: "var(--acc)", width: 12, height: 12 }} />{c}</label>))}
        </div>
      </div>

      {/* Enrich from Accounts */}
      {acctCols.length > 0 && (<div className="ig">
        <div className="il">Enrich from Accounts <span style={{ fontSize: 9, color: "var(--t3)", fontWeight: 400 }}>— joined by Company name or Domain</span></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {acctCols.map(c => (<label key={c} style={chipStyle(enrichAcct.includes(c), "grn")}><input type="checkbox" checked={enrichAcct.includes(c)} onChange={() => toggleEA(c)} style={{ accentColor: "var(--grn)", width: 12, height: 12 }} />{c}</label>))}
        </div>
        {enrichAcct.length > 0 && (
          <div style={{ marginTop: 6, padding: 8, fontSize: 10, borderRadius: 4,
            background: enrichmentCoverage.acctHits === 0 ? "rgba(239,68,68,.08)" : enrichmentCoverage.acctHits / enrichmentCoverage.total < 0.3 ? "rgba(191,163,90,.08)" : "rgba(93,168,122,.08)",
            border: "1px solid " + (enrichmentCoverage.acctHits === 0 ? "var(--red)" : enrichmentCoverage.acctHits / enrichmentCoverage.total < 0.3 ? "var(--amb)" : "rgba(93,168,122,.3)"),
            color: enrichmentCoverage.acctHits === 0 ? "var(--red)" : "var(--t2)" }}>
            🔍 Account enrichment coverage: <strong>{enrichmentCoverage.acctHits} / {enrichmentCoverage.total}</strong> tasks will get enriched from the {accounts.length} accounts in this campaign.
            {enrichmentCoverage.acctHits === 0 && enrichmentCoverage.total > 0 && (
              <div style={{ marginTop: 4 }}>⚠️ ZERO matches. Tasks reference accounts not in this campaign's Accounts table.</div>
            )}
          </div>
        )}
      </div>)}

      {/* Enrich from Leads */}
      {leadCols.length > 0 && (<div className="ig">
        <div className="il">Enrich from Leads <span style={{ fontSize: 9, color: "var(--t3)", fontWeight: 400 }}>— joined by Name, Company, Email domain, or LinkedIn URL</span></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {leadCols.map(c => (<label key={c} style={chipStyle(enrichLead.includes(c), "blu")}><input type="checkbox" checked={enrichLead.includes(c)} onChange={() => toggleEL(c)} style={{ accentColor: "var(--blu)", width: 12, height: 12 }} />{c}</label>))}
        </div>
        {enrichLead.length > 0 && (
          <div style={{ marginTop: 6, padding: 8, fontSize: 10, borderRadius: 4,
            background: enrichmentCoverage.leadHits === 0 ? "rgba(239,68,68,.08)" : enrichmentCoverage.leadHits / enrichmentCoverage.total < 0.3 ? "rgba(191,163,90,.08)" : "rgba(93,168,122,.08)",
            border: "1px solid " + (enrichmentCoverage.leadHits === 0 ? "var(--red)" : enrichmentCoverage.leadHits / enrichmentCoverage.total < 0.3 ? "var(--amb)" : "rgba(93,168,122,.3)"),
            color: enrichmentCoverage.leadHits === 0 ? "var(--red)" : "var(--t2)" }}>
            🔍 Lead enrichment coverage: <strong>{enrichmentCoverage.leadHits} / {enrichmentCoverage.total}</strong> tasks will get enriched from the {leads.length} leads in this campaign.
            {enrichmentCoverage.leadHits === 0 && (
              <div style={{ marginTop: 4 }}>
                ⚠️ ZERO matches. Tasks reference leads not in this campaign's Leads table. Either: (1) switch to the campaign that has those leads, OR (2) uncheck Lead enrichment columns and use the direct task fields (Name, Lead Title, Email, LinkedIn URL, Phone) which are saved with each task.
              </div>
            )}
          </div>
        )}
      </div>)}

      {/* Preview */}
      <div style={{ padding: 12, background: "var(--hover)", borderRadius: 8, fontSize: 11 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ color: "var(--t2)" }}>
            <strong style={{ color: "var(--t1)" }}>{filteredTasks.length}</strong> tasks · <strong style={{ color: "var(--t1)" }}>{allExportCols.length}</strong> columns
            {enrichCount > 0 && <span style={{ color: "var(--grn)", marginLeft: 6 }}>+ {enrichCount} enriched</span>}
          </span>
          {filteredTasks.length > 0 && allExportCols.length > 0 && (<span style={{ fontSize: 10, color: "var(--grn)" }}>Ready to export</span>)}
        </div>
        {exportTypes.size > 0 && exportTypes.size < taskTypes.length && (<div style={{ fontSize: 10, color: "var(--t3)", marginTop: 4 }}>Types: {[...exportTypes].map(t => t.replace(/_/g, " ")).join(", ")}</div>)}
        {(exportFrom || exportTo) && (<div style={{ fontSize: 10, color: "var(--t3)", marginTop: 2 }}>Date: {exportFrom || "…"} → {exportTo || "…"}</div>)}
      </div>
    </div>
    <div className="modal-f">
      <button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn btn-p" disabled={!filteredTasks.length || !allExportCols.length} onClick={doExport}>
        <I.Download /> Export {filteredTasks.length} Tasks
      </button>
    </div>
  </div></div>);
}
// ═══════════════════════════════════════════════════════════════
// CAMPAIGN TAG PICKER
// Multi-select dropdown for filtering leads by Campaign Tag in outreach
// rule editor. Loads tags via /api/outreach list_campaign_tags on mount.
// ═══════════════════════════════════════════════════════════════
function CampaignTagPicker({ baseId, selected, onChange }) {
  const [tags, setTags] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [meta, setMeta] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true); setErr("");
      try {
        const r = await fetch("/api/outreach", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list_campaign_tags", baseId }),
        });
        const d = await r.json();
        if (cancelled) return;
        if (d.ok) {
          setTags(d.tags || []);
          setMeta({ totalLeads: d.totalLeads, leadsWithTags: d.leadsWithTags });
        } else {
          setErr(d.error || "Failed to load tags");
        }
      } catch (e) { if (!cancelled) setErr(e.message); }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [baseId]);

  const toggle = (tag) => {
    if (selected.includes(tag)) onChange(selected.filter(t => t !== tag));
    else onChange([...selected, tag]);
  };

  if (loading) return <div style={{fontSize:10,color:"var(--t3)",padding:6}}>Loading Campaign Tags…</div>;
  if (err) return <div style={{fontSize:10,color:"var(--red)",padding:6}}>Tag load error: {err}</div>;
  if (tags.length === 0) {
    return (
      <div className="ig">
        <div className="il">Campaign Tag Filter <span style={{fontSize:9,color:"var(--t3)",fontWeight:400}}>— optional</span></div>
        <div style={{fontSize:10,color:"var(--t3)",padding:8,background:"var(--hover)",borderRadius:4}}>
          No "Campaign Tag" values found in the Leads table. Add a Campaign Tag field on your leads (single or multi-select) and tag them, then this picker will populate.
        </div>
      </div>
    );
  }

  return (
    <div className="ig">
      <div className="il">
        Campaign Tag Filter <span style={{fontSize:9,color:"var(--t3)",fontWeight:400}}>— optional; restrict AI to leads with selected tags only ({meta?.leadsWithTags}/{meta?.totalLeads} leads tagged)</span>
      </div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",padding:8,background:"var(--hover)",borderRadius:4,maxHeight:140,overflowY:"auto"}}>
        {tags.map(({tag, count}) => {
          const isSel = selected.includes(tag);
          return (
            <button
              key={tag}
              type="button"
              onClick={()=>toggle(tag)}
              style={{
                padding:"4px 8px",fontSize:10,borderRadius:4,cursor:"pointer",
                background: isSel ? "var(--blu)" : "var(--card)",
                color: isSel ? "var(--bg)" : "var(--t1)",
                border: `1px solid ${isSel ? "var(--blu)" : "var(--bdr)"}`,
              }}
            >
              {isSel ? "✓ " : ""}{tag} <span style={{opacity:0.6,marginLeft:3}}>({count})</span>
            </button>
          );
        })}
      </div>
      {selected.length > 0 && (
        <div style={{fontSize:10,color:"var(--blu)",marginTop:4}}>
          Will limit AI selection to leads tagged with: <strong>{selected.join(", ")}</strong>. Leave empty to consider all leads.
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// REVIEW NOTIFICATION BOX
// Floating badge + modal showing AI-generated messages awaiting review.
// Polls every 60s for new items. Displays the lead, the template that
// was used, the AI output that was sent, and an Approve/Flag action.
// Mounted at the top level of SignalScope so the badge is always visible.
// ═══════════════════════════════════════════════════════════════
function ReviewNotificationBox({ baseId }) {
  const [pendingCount, setPendingCount] = useState(0);
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("needs_review"); // needs_review | approved | flagged | all

  const load = async () => {
    if (!baseId) return;
    setLoading(true);
    try {
      const r = await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "list_review", baseId, status: filter }),
      });
      const d = await r.json();
      if (d.ok) { setItems(d.items || []); setPendingCount(d.pendingCount || 0); }
    } catch {}
    setLoading(false);
  };

  // Initial load + poll every 60s
  useEffect(() => {
    if (!baseId) return;
    load();
    const id = setInterval(load, 60000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseId, filter]);

  const act = async (itemId, action) => {
    try {
      await fetch("/api/outreach", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review_action", baseId, itemId, action }),
      });
      await load();
    } catch {}
  };

  if (!baseId) return null;

  return (<>
    {/* Floating badge — sits in lower right */}
    <button
      onClick={()=>setOpen(o=>!o)}
      style={{
        position:"fixed", bottom:20, right:20, zIndex:99,
        padding:"10px 14px", borderRadius:24, border:"1px solid var(--bdr)",
        background: pendingCount > 0 ? "var(--amb)" : "var(--card)",
        color: pendingCount > 0 ? "var(--bg)" : "var(--t1)",
        cursor:"pointer", fontSize:12, fontWeight:600,
        boxShadow:"0 4px 16px rgba(0,0,0,0.3)",
        display:"flex", alignItems:"center", gap:8,
      }}
      title="AI message review queue"
    >
      📬 AI Reviews
      {pendingCount > 0 && (
        <span style={{
          background:"var(--bg)", color:"var(--amb)",
          padding:"2px 8px", borderRadius:12, fontSize:11, fontWeight:700,
        }}>{pendingCount}</span>
      )}
    </button>

    {open && (
      <div
        onClick={()=>setOpen(false)}
        style={{
          position:"fixed", top:0, left:0, right:0, bottom:0,
          background:"rgba(0,0,0,0.5)", zIndex:100,
          display:"flex", alignItems:"center", justifyContent:"center", padding:20,
        }}
      >
        <div
          onClick={e=>e.stopPropagation()}
          style={{
            background:"var(--bg)", border:"1px solid var(--bdr)", borderRadius:12,
            width:"100%", maxWidth:920, maxHeight:"80vh", display:"flex", flexDirection:"column",
            boxShadow:"0 8px 32px rgba(0,0,0,0.5)",
          }}
        >
          <div style={{padding:"14px 18px",borderBottom:"1px solid var(--bdr)",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:14,fontWeight:600,color:"var(--t1)"}}>📬 AI Message Reviews</div>
              <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>Audit AI-personalised DMs and connection notes. Approve good ones; flag bad ones with notes so they don't repeat.</div>
            </div>
            <button className="btn btn-s" onClick={()=>setOpen(false)}>✕</button>
          </div>

          {/* Filter pills */}
          <div style={{padding:"10px 18px",borderBottom:"1px solid var(--bdr)",display:"flex",gap:6,alignItems:"center"}}>
            {[
              {id:"needs_review",label:"Needs Review",count:pendingCount},
              {id:"approved",label:"Approved"},
              {id:"flagged",label:"Flagged"},
              {id:"all",label:"All"},
            ].map(f=>(
              <button key={f.id} className="btn btn-s" onClick={()=>setFilter(f.id)}
                style={filter===f.id?{background:"var(--amb)",color:"var(--bg)",borderColor:"var(--amb)"}:{}}>
                {f.label}{f.count!=null && f.count>0 ? ` (${f.count})` : ""}
              </button>
            ))}
            <button className="btn btn-s" onClick={load} disabled={loading} style={{marginLeft:"auto"}}>{loading?"...":"↻"}</button>
          </div>

          <div style={{flex:1,overflowY:"auto",padding:18}}>
            {items.length === 0 ? (
              <div style={{padding:40,textAlign:"center",color:"var(--t3)"}}>
                <div style={{fontSize:24,marginBottom:8}}>📭</div>
                <div>No items in this view.</div>
                <div style={{fontSize:10,marginTop:6}}>AI-personalised messages will appear here after they're sent.</div>
              </div>
            ) : (
              <div style={{display:"flex",flexDirection:"column",gap:10}}>
                {items.map(it => {
                  const f = it.fields || {};
                  const status = f.Status || "needs_review";
                  const statusColor = status === "approved" ? "var(--grn)" : status === "flagged" ? "var(--red)" : "var(--amb)";
                  return (
                    <div key={it.id} style={{padding:14,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:12,marginBottom:8}}>
                        <div>
                          <div style={{fontSize:12,fontWeight:600,color:"var(--t1)"}}>
                            {f["Lead Name"]} <span style={{fontWeight:400,color:"var(--t3)"}}>· {f.Company} · {f.Title}</span>
                          </div>
                          <div style={{fontSize:10,color:"var(--t3)",marginTop:2}}>
                            <strong>{f["Message Type"]}</strong> · {f.Campaign} · {f["Sent At"] ? new Date(f["Sent At"]).toLocaleString() : ""}
                          </div>
                        </div>
                        <span style={{padding:"3px 8px",fontSize:9,fontWeight:600,borderRadius:4,background:"var(--hover)",color:statusColor,border:`1px solid ${statusColor}`}}>{status.replace("_", " ")}</span>
                      </div>
                      <div style={{marginBottom:8,padding:10,background:"var(--hover)",borderRadius:4,fontSize:11,color:"var(--t1)",whiteSpace:"pre-wrap"}}>
                        <div style={{fontSize:9,color:"var(--t3)",marginBottom:4}}>📤 SENT MESSAGE</div>
                        {f["AI Output (Sent)"]}
                      </div>
                      <details style={{marginBottom:8}}>
                        <summary style={{fontSize:10,color:"var(--t3)",cursor:"pointer"}}>Show template + AI input context</summary>
                        <div style={{marginTop:6,padding:8,background:"var(--hover)",borderRadius:4,fontSize:10,color:"var(--t2)",whiteSpace:"pre-wrap"}}>
                          <div style={{fontSize:9,color:"var(--t3)",marginBottom:4}}>📝 TEMPLATE USED</div>
                          {f["Template Used"] || "(none)"}
                          <div style={{fontSize:9,color:"var(--t3)",margin:"10px 0 4px"}}>🧠 AI INPUT CONTEXT</div>
                          {f["AI Input Context"] || "(none)"}
                        </div>
                      </details>
                      {status === "needs_review" && (
                        <div style={{display:"flex",gap:6,alignItems:"center"}}>
                          <button className="btn btn-s" style={{borderColor:"var(--grn)",color:"var(--grn)"}} onClick={()=>act(it.id, "approve")}>✓ Approve</button>
                          <button className="btn btn-s" style={{borderColor:"var(--red)",color:"var(--red)"}} onClick={async()=>{
                            const notes = prompt("Why is this message problematic? (Optional — helps improve the AI prompt over time)");
                            if (notes !== null) {
                              await fetch("/api/outreach", {
                                method:"POST", headers:{"Content-Type":"application/json"},
                                body: JSON.stringify({ action:"review_action", baseId, itemId: it.id, action:"flag", notes }),
                              });
                              await load();
                            }
                          }}>⚠ Flag</button>
                          {f["LinkedIn URL"] && <a href={f["LinkedIn URL"]} target="_blank" rel="noreferrer" style={{fontSize:10,color:"var(--blu)",marginLeft:"auto"}}>open LinkedIn ↗</a>}
                        </div>
                      )}
                      {f["Reviewer Notes"] && (
                        <div style={{marginTop:6,padding:8,background:"rgba(239,68,68,.06)",borderLeft:"3px solid var(--red)",fontSize:10,color:"var(--t2)"}}>
                          <strong>Reviewer notes:</strong> {f["Reviewer Notes"]}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    )}
  </>);
}
