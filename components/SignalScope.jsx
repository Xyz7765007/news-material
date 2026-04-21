"use client";
import { useState, useEffect, useRef, useCallback } from "react";

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
  const [campaigns, setCampaigns] = useState(DEFAULT_CAMPAIGNS);
  const [tab, setTab] = useState("dashboard");
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
  const [outreachItems, setOutreachItems] = useState([]);
  const [outreachLoading, setOutreachLoading] = useState(false);
  // HubSpot
  const [hsConnected, setHsConnected] = useState(false);
  const [hsKey, setHsKey] = useState(""); // input field
  const hsApiKeyRef = useRef(""); // actual stored key
  const [hsMasked, setHsMasked] = useState("");
  const [hsOwners, setHsOwners] = useState([]);
  const [hsLoading, setHsLoading] = useState(false);
  const [hsMsg, setHsMsg] = useState("");
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
    if (d.valid) { setClientAuth("ok"); setCamp(window.__pendingCamp || null); }
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
      setAvailableFields({ Accounts: af.fields || [], Leads: lf.fields || [] });
    } catch (e) { console.error(e); }
  };

  const del = async (table, ids, setter) => { try{await at("delete",table,{recordIds:ids},bid);setter(p=>p.filter(r=>!ids.includes(r.id)))} catch(e){console.error(e)} };

  // ─── Outreach helpers ──────────────────────────────────────
  const outreachAPI = async (action, data = {}) => {
    const res = await fetch("/api/outreach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, baseId: bid, ...data }) });
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
  };

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
    setHsLoading(true); setHsMsg("");
    try {
      const mapped = tasksToPush.map(t => { const f = t.fields || t; return { Company: f.Company, "Task Rule": f["Task Rule"], Score: f.Score, Signal: f.Signal, URL: f.URL, Date: f.Date, "Lead Name": f["Lead Name"], Phone: f.Phone || "" }; });
      const d = await hsAPI("push_tasks", { tasks: mapped, config });
      setHsMsg(d.created > 0 ? `✅ ${d.created} tasks pushed` : "❌ " + (d.errors?.[0] || "Failed"));
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

  const autoDetect = (headers, table) => {
    const aliases = FIELD_ALIASES[table] || {};
    // Get fields from Airtable metadata
    const metaFields = (availableFields[table] || []).map(f => f.name || f);
    // Also get fields from loaded records as fallback (always up-to-date)
    const recordSource = table === "Accounts" ? accounts : table === "Leads" ? leads : [];
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

  const handleCSVFile = (file, table, setter) => {
    fetchAvailableFields();
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
      if (allRows.length < 2) return;
      const headers = allRows[0];
      const dataRows = allRows.slice(1).filter(r => r.length >= 2 && r.some(c => c)); // need at least 2 non-empty cells
      setCsvModal({ table, setter, headers, rows: dataRows, mappings: autoDetect(headers, table), mode: "create", matchField: "Name", campaignTag: camp?.name || "", newCampaignTag: "" });
    };
    reader.readAsText(file);
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

    try {
      setLoading(true); setCsvModal(null);

      if (mode === "update" && matchField) {
        // ─── Partial update: match by field, update existing records ───
        const existing = table === "Accounts" ? accounts : leads;
        const matched = [];
        const unmatched = [];

        for (const rec of recs) {
          const matchVal = (rec[matchField] || "").toLowerCase().trim();
          if (!matchVal) { unmatched.push(rec); continue; }
          const found = existing.find(e => {
            const existVal = (e.fields?.[matchField] || "").toLowerCase().trim();
            return existVal === matchVal;
          });
          if (found) {
            // Build update payload — only include non-match fields (new data)
            const updates = {};
            for (const [k, v] of Object.entries(rec)) {
              if (k !== matchField && v) updates[k] = v;
            }
            if (Object.keys(updates).length > 0) {
              matched.push({ id: found.id, fields: updates });
            }
          } else {
            unmatched.push(rec);
          }
        }

        // Update matched records
        if (matched.length > 0) {
          const res = await at("update", table, { records: matched }, bid);
          // Merge updated fields into local state
          const updatedMap = {};
          (res.records || []).forEach(r => { updatedMap[r.id] = r; });
          setter(p => p.map(r => updatedMap[r.id] ? { ...r, fields: { ...r.fields, ...updatedMap[r.id].fields } } : r));
        }

        // Create unmatched as new records (if any)
        if (unmatched.length > 0) {
          const res = await at("create", table, { records: unmatched }, bid);
          setter(p => [...p, ...(res.records || [])]);
        }

        console.log(`[CSV Update] ${matched.length} updated, ${unmatched.length} created new`);
      } else {
        // ─── Normal create ───
        const res = await at("create", table, { records: recs }, bid);
        setter(p => [...p, ...(res.records || [])]);
      }

      fetchAvailableFields();
    } catch (e) { console.error("Upload failed:", e); }
    setLoading(false);
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
      const res = await fetch("/api/classify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "dedup_tasks", taskGroups: toDedup }) });
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
      fields = { Name: rule.name, Description: rule.description || "", "Task Type": "linkedin_outreach", "Outreach Config": JSON.stringify(rule.outreachConfig || {}) };
    } else if (rule.taskType === "top_x") {
      fields = { Name: rule.name, Description: rule.description || "", "Task Type": "top_x", "Scan Target": rule.scanTarget || "leads", "Top N": rule.topN || 10, "Scoring Fields": JSON.stringify(rule.scoringFields || []), "Scoring Prompt": rule.scoringPrompt || "", Ease: rule.ease || "Medium", Strength: rule.strength || "Strong" };
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
    const hasPrompt = !!(rule.fields?.["Scoring Prompt"] || "").trim();
    setScanning(true); setScanText(hasPrompt ? "🧠 Running Top X + AI scoring..." : "🎯 Running Top X scoring..."); setScanProg(30);
    buildSeenSet();
    try {
      const sf = JSON.parse(rule.fields?.["Scoring Fields"] || "[]");
      const res = await at("run_topx", "", { rule: { name: rule.fields?.Name, scanTarget: rule.fields?.["Scan Target"] || "leads", topN: rule.fields?.["Top N"] || 10, scoringFields: sf, scoringPrompt: rule.fields?.["Scoring Prompt"] || "" } }, bid);
      setScanProg(70);
      const aiLabel = res.aiScored ? " (AI scored)" : "";
      if (res.tasks?.length > 0) {
        const unique = res.tasks.filter(t => !isDuplicate(t, tasks));
        const duped = res.tasks.length - unique.length;
        setScanText(`🔍 ${duped > 0 ? duped + " duplicates removed, " : ""}creating ${unique.length} tasks...`);
        setScanProg(85);
        if (unique.length > 0) {
          unique.forEach(t => taskSeenRef.current.add(taskFingerprint(t)));
          const cr = await at("create", "Tasks", { records: unique }, bid);
          setTasks(p => [...(cr.records || []), ...p]);
          setScanText(`✅ ${unique.length} tasks${aiLabel} from top ${res.topN}/${res.totalRecords}${duped > 0 ? ` (${duped} dupes skipped)` : ""}`);
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

  const startScan = useCallback(async()=>{
    const sigRules=rules.filter(r=>{const tt=(r.fields||{})["Task Type"]||"news";return tt==="news"||tt==="job_post"||tt==="both"});
    if(scanning||!accounts.length||!sigRules.length)return;
    setScanning(true);scanRef.current=true;setScanProg(0);
    buildSeenSet(); scanBufferRef.current = []; dupCountRef.current = 0;
    const taskDefs=rules.filter(r=>{const tt=(r.fields||{})["Task Type"]||"news";return tt==="news"||tt==="job_post"||tt==="both"}).map(r=>{const f=r.fields||{};const kws=(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean);const jtk=(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean);let sp=f["Scoring Prompt"]||"";if(!sp){const ak=[...kws,...jtk].slice(0,5).join(", ");sp="Rate this signal for \""+f.Name+"\". Score 90-100 for exact matches ("+ak+"). 70-89 strong. 50-69 partial. Below 50 unrelated."}return{id:r.id,name:f.Name||"",description:f.Description||"",taskType:f["Task Type"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease||"Medium",strength:f.Strength||"Medium",sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:kws,jobTitleKeywords:jtk,scoringPrompt:sp}});
    const companies=accounts.map(a=>{const f=a.fields||{};const li=f["LinkedIn URL"]||f.LinkedIn||"";return{name:f.Name||f.Company||"",domain:f.Domain||f.Website||"",linkedinSlug:extractLinkedInSlug(li),linkedinCompanyId:extractLinkedInId(li)}}).filter(c=>c.name);
    const nT=taskDefs.filter(t=>t.taskType==="news"||t.taskType==="both");
    const jT=taskDefs.filter(t=>t.taskType==="job_post"||t.taskType==="both");
    const total=companies.length;
    if(nT.length>0){for(let i=0;i<companies.length;i++){if(!scanRef.current)break;setScanText("📰 "+companies[i].name);setScanProg(Math.round(i/total*50));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({company:companies[i],taskDefs:nT,mode:"news"})});if(res.ok){const d=await res.json();bufferSignals(d.news||[],companies[i],taskDefs)}}catch(e){console.error(e)}await sleep(100)}}
    if(scanRef.current&&jT.length>0){const need=companies.filter(c=>c.linkedinSlug&&!c.linkedinCompanyId);if(need.length>0){setScanText("🔗 Resolving LinkedIn IDs...");try{const res=await fetch("/api/resolve-linkedin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slugs:need.map(c=>c.linkedinSlug)})});if(res.ok){const{ids}=await res.json();for(const c of companies){if(c.linkedinSlug&&!c.linkedinCompanyId&&ids[c.linkedinSlug.toLowerCase()])c.linkedinCompanyId=ids[c.linkedinSlug.toLowerCase()]}}}catch(e){console.error(e)}}
    const BS=5;for(let b=0;b<companies.length;b+=BS){if(!scanRef.current)break;const batch=companies.slice(b,b+BS);setScanText("📋 Jobs — Batch "+(Math.floor(b/BS)+1));setScanProg(50+Math.round(b/companies.length*50));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({companies:batch,taskDefs:jT,mode:"jobs-batch"})});if(res.ok){const d=await res.json();for(const result of(d.results||[])){const co=batch.find(c=>c.name===result.company);if(co)bufferSignals(result.signals||[],co,taskDefs)}}}catch(e){console.error(e)}await sleep(200)}}

    // ─── Post-scan: AI dedup + save ───────────────────────────
    const buffered = scanBufferRef.current;
    const exactDupes = dupCountRef.current;
    if(buffered.length>0){
      setScanText(`🔍 AI dedup on ${buffered.length} tasks…`);setScanProg(90);
      const deduped = await aiDedupBatch(buffered);
      const aiRemoved = buffered.length - deduped.length;
      setScanText(`💾 Saving ${deduped.length} tasks…`);setScanProg(95);
      if(deduped.length>0){
        try{const res=await at("create","Tasks",{records:deduped},bid);setTasks(p=>[...(res.records||[]),...p])}catch(e){console.error(e)}
      }
      const totalDupes = exactDupes + aiRemoved;
      setScanText(`✅ ${deduped.length} tasks created${totalDupes>0?` (${totalDupes} duplicates removed${aiRemoved>0?`, ${aiRemoved} by AI`:""})`:""}`);
    } else {
      setScanText(exactDupes > 0 ? `✅ Scan complete — ${exactDupes} duplicates skipped, no new tasks` : "✅ Scan complete — no signals found");
    }
    setScanProg(100);setScanning(false);scanRef.current=false;
  },[accounts,rules,threshold,scanning,bid,tasks]);

  // Buffer signals with instant dedup (layers 1-3), defer AI dedup to post-scan
  const bufferSignals = (signals, company, taskDefs)=>{
    for(const sig of signals){
      const scores=sig.relevanceScores||{};
      for(const tid of(sig.matchedTaskIds||[])){
        const td=taskDefs.find(t=>t.id===tid);if(!td)continue;
        const score=Math.max(0,Math.min(100,parseInt(scores[tid]||Math.round((sig.confidence||0.7)*100))||50));
        if(score<threshold)continue;
        const newTask={Company:company.name,"Task Rule":td.name,Score:score,"Scan Target":td.scanTarget||"accounts",Signal:sig.headline||"",Source:sig.source||"",URL:sig.url||"","Task Type":sig.taskType||"news",Date:sig.date?sig.date.slice(0,10):new Date().toISOString().slice(0,10),Created:new Date().toISOString()};
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
  const topXRules = rules.filter(r => (r.fields||{})["Task Type"] === "top_x");

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
    {id:"email_campaign",label:"📧 Email Campaign",count:null},
    {id:"google_analytics",label:"📊 Google Analytics",count:null},
    {id:"hubspot",label:"🔗 HubSpot",count:null},
    {id:"post_demo",label:"🤖 Post-Demo Auto",count:null},
    ...(!clientMode ? [{id:"coming_soon",label:"🚀 Coming Soon",count:null}] : []),
  ];

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
    <div className="ph"><div><div className="pt">{clientMode ? `${camp.emoji||"📊"} ${camp.name}` : "Dashboard"}</div><div className="pd">{clientMode ? "Your campaign workspace — everything you need is here" : `${camp.name} — Overview`}</div></div>
      <div style={{display:"flex",gap:6}}>
        {hasSignals&&<button className="btn btn-s btn-p" onClick={startScan} disabled={scanning||!accounts.length||!signalRules.length}>{scanning?"⏳ "+Math.round(scanProg)+"%":<>▶ Run Scan</>}</button>}
      </div>
    </div>

    {/* Stats Grid */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:12,marginBottom:24}}>
      {[
        {l:"Accounts",v:accounts.length,e:"🏢",c:"var(--acc)",t:"accounts"},
        {l:"Leads",v:leads.length,e:"👤",c:"var(--blu)",t:"leads"},
        {l:"Task Rules",v:rules.length,e:"⚙️",c:"var(--pur)",t:"rules"},
        {l:"Tasks",v:tasks.length,e:"📋",c:"var(--grn)",t:"tasks"},
        {l:"Signal Rules",v:signalRules.length,e:"📰",c:"var(--amb)"},
        {l:"Top X Rules",v:topXRules.length,e:"🎯",c:"var(--pur)"},
      ].map(s=>(
        <div key={s.l} onClick={()=>s.t&&setTab(s.t)} style={{padding:"16px 18px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,cursor:s.t?"pointer":"default",transition:"border-color .2s"}} onMouseOver={e=>{if(s.t)e.currentTarget.style.borderColor="var(--acc)"}} onMouseOut={e=>e.currentTarget.style.borderColor="var(--bdr)"}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <span style={{fontSize:24}}>{s.e}</span>
            <span style={{fontSize:26,fontWeight:700,fontFamily:"'JetBrains Mono',monospace",color:s.c}}>{s.v}</span>
          </div>
          <div style={{fontSize:10,color:"var(--t3)",marginTop:6}}>{s.l}</div>
        </div>
      ))}
    </div>

    {/* Active Features */}
    <div style={{marginBottom:24}}>
      <div style={{fontSize:12,fontWeight:600,marginBottom:10,color:"var(--t2)"}}>Active Features</div>
      <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
        {activeFeatures.map(f=>{const ft=ALL_FEATURES.find(a=>a.id===f);return ft?<div key={f} style={{padding:"10px 14px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontSize:18}}>{ft.emoji}</span><div><div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>{ft.label}</div><div style={{fontSize:9,color:"var(--t3)"}}>{ft.desc}</div></div>
        </div>:null})}
        {activeFeatures.length===0&&<div style={{fontSize:11,color:"var(--t3)"}}>No features active — create a Task Rule to get started</div>}
      </div>
    </div>

    {/* Integrations */}
    <div style={{marginBottom:24}}>
      <div style={{fontSize:12,fontWeight:600,marginBottom:10,color:"var(--t2)"}}>Integrations</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:10}}>
        {[
          {n:"Airtable",ok:!!bid,sub:bid?"Connected":"Not connected"},
          {n:"LinkedIn (Unipile)",ok:!!linkedinAccount,sub:linkedinAccount?linkedinAccount.name:"Not connected"},
          {n:"HubSpot",ok:hsConnected,sub:hsConnected?"Connected":"Not connected",onClick:()=>setTab("hubspot")},
          {n:"Google Analytics",ok:false,sub:"Coming Soon",dim:true},
          {n:"Smartlead",ok:false,sub:"Coming Soon",dim:true},
        ].map(ig=>(
          <div key={ig.n} onClick={ig.onClick} style={{padding:"12px 14px",background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:8,display:"flex",alignItems:"center",gap:10,opacity:ig.dim?.5:1,cursor:ig.onClick?"pointer":"default"}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:ig.ok?"var(--grn)":"var(--t3)",flexShrink:0}}/>
            <div><div style={{fontSize:11,fontWeight:600,color:"var(--t1)"}}>{ig.n}</div><div style={{fontSize:9,color:"var(--t3)"}}>{ig.sub}</div></div>
          </div>
        ))}
      </div>
    </div>

    {/* Recent Tasks */}
    {tasks.length>0&&(<div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <span style={{fontSize:12,fontWeight:600,color:"var(--t2)"}}>Recent Tasks</span>
        <button className="btn btn-s" style={{fontSize:9}} onClick={()=>setTab("tasks")}>View All →</button>
      </div>
      <div className="tw"><table><thead><tr><th>Company</th><th>Rule</th><th>Score</th><th>Type</th><th>Date</th></tr></thead>
      <tbody>{tasks.slice(0,6).map(t=>{const f=t.fields||{};return(<tr key={t.id} style={{cursor:"pointer"}} onClick={()=>setTab("tasks")}>
        <td style={{color:"var(--t1)",fontWeight:500}}>{f.Company}</td>
        <td style={{fontSize:10}}>{f["Task Rule"]}</td>
        <td><div className="sb"><div className="st"><div className="sf" style={{width:Math.min(100,f.Score||0)+"%",background:f.Score>=80?"var(--grn)":f.Score>=60?"var(--acc)":"var(--red)"}}/></div><span className="sv">{f.Score}</span></div></td>
        <td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="top_x"?"cp":"cg")}>{(f["Task Type"]||"news").replace(/_/g," ")}</span></td>
        <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f.Date}</td>
      </tr>)})}</tbody></table></div>
    </div>)}

    {tasks.length===0&&accounts.length===0&&!clientMode&&(<div className="empty"><div className="em">📡</div><p>Upload accounts & leads, create task rules, and run your first scan</p>
      <button className="btn btn-p" onClick={()=>setTab("accounts")}><I.Plus/> Start with Accounts</button>
    </div>)}

    {/* Client mode: Setup Guide */}
    {clientMode&&(<div style={{marginTop:24}}>
      <div style={{fontSize:14,fontWeight:700,color:"var(--t1)",marginBottom:4}}>🚀 Getting Started</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:16}}>Follow these steps to set up your campaign. Each step unlocks the next.</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {[
          {n:"Upload Accounts",d:"Upload your target company list (CSV). These are the companies you want to track signals for.",done:accounts.length>0,act:()=>setTab("accounts"),btn:"Upload Accounts"},
          {n:"Upload Leads",d:"Upload your contact list (CSV). Leads are the people at those companies you'll reach out to.",done:leads.length>0,act:()=>setTab("leads"),btn:"Upload Leads"},
          {n:"Create Task Rules",d:"Define what signals to watch for — news mentions, job posts, or score your leads with Top X. Each rule tells the AI what to look for.",done:rules.length>0,act:()=>setTab("rules"),btn:"Create Rule"},
          {n:"Run a Scan",d:"Execute your task rules against your accounts. The AI scans RSS feeds, job boards, and scores leads to create actionable tasks.",done:tasks.length>0,act:()=>setTab("tasks"),btn:"Go to Tasks"},
          {n:"Connect HubSpot",d:"Connect your HubSpot CRM to push tasks and leads directly. You can also run Post-Demo automation from your deal pipeline.",done:hsConnected,act:()=>setTab("hubspot"),btn:"Connect HubSpot"},
          {n:"Enrich & Push",d:"Enrich leads with phone numbers via Apollo, push tasks and leads to HubSpot, or run Post-Demo automation on your deal stages.",done:tasks.some(t=>(t.fields||{}).Phone),act:()=>setTab("tasks"),btn:"Go to Tasks"},
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

    {/* Admin mode: empty state */}
    {!clientMode&&tasks.length===0&&accounts.length>0&&(<div className="empty" style={{marginTop:20}}><div className="em">⚙️</div><p>Create task rules and run a scan to generate tasks</p>
      <button className="btn btn-p" onClick={()=>setTab("rules")}><I.Plus/> Create Task Rule</button>
    </div>)}

    {/* Admin mode: Client Portal Link */}
    {!clientMode && camp?.airtableId && (<div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10,marginTop:24}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:8}}>🔗 Client Portal</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:14,lineHeight:1.5}}>Share this link with your client. They get the full SignalScope experience — upload data, create rules, run scans, HubSpot, enrichment, post-demo automation — without Airtable config or campaign switching.</div>
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

  {/* ════ GOOGLE ANALYTICS ════ */}
  {tab==="google_analytics"&&!loading&&(<div>
    <div className="ph"><div><div className="pt">📊 Google Analytics</div><div className="pd">Connect GA4 to enrich leads with website engagement data — sliding 7-day window</div></div></div>
    <GoogleAnalyticsCard baseId={bid} campaign={camp} onSyncComplete={()=>at("list","Leads",{},bid).then(r=>setLeads(r.records||[]))} />
  </div>)}

  {/* ════ HUBSPOT ════ */}
  {tab==="hubspot"&&!loading&&(<div>
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
      {hsMsg && <div style={{marginTop:8,fontSize:11,color:hsMsg.startsWith("✅")?"var(--grn)":"var(--red)"}}>{hsMsg}</div>}
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
    <div style={{padding:20,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:10}}>
      <div style={{fontSize:13,fontWeight:600,color:"var(--t1)",marginBottom:8}}>👤 Upload Leads to HubSpot</div>
      <div style={{fontSize:11,color:"var(--t3)",marginBottom:12,lineHeight:1.5}}>Push your SignalScope leads directly to HubSpot as contacts. Existing contacts (matched by email) will be updated, new ones created.</div>
      {leads.length === 0 ? <div style={{fontSize:11,color:"var(--t3)"}}>No leads loaded. Upload leads on the Leads tab first.</div> : (
        <LeadsToHubSpotForm leads={leads} owners={hsOwners} onPush={pushLeadsToHS} loading={hsLoading}/>
      )}
    </div>
    </>)}
  </div>)}

  {/* ════ POST-DEMO AUTOMATION ════ */}
  {tab==="post_demo"&&!loading&&(<div>
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

  {/* ════ EMAIL CAMPAIGN ════ */}
  {tab==="email_campaign"&&!loading&&(<EmailCampaignTab baseId={bid} campaign={camp} leads={leads} />)}

  {/* ════ COMING SOON ════ */}
  {tab==="coming_soon"&&(<div>
    <div className="ph"><div><div className="pt">🚀 Coming Soon</div><div className="pd">Features in development & planned</div></div></div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:14}}>
      {[
        {e:"🔗",n:"HubSpot Integration",s:"Live",d:"Connect HubSpot CRM, push tasks, assign to reps. API key stored per campaign.",f:["Push tasks to HubSpot","Assignee selection from HubSpot owners","Phone enrichment via Apollo","Enriched task push"]},
        {e:"📊",n:"Google Analytics Integration",s:"Planned",d:"Pull GA4 data into dashboards — traffic, conversions, channel performance. Correlate web analytics with signal data.",f:["GA4 property connection","Traffic & conversion dashboards","Channel attribution reports","Signal-to-web-visit correlation"]},
        {e:"📧",n:"Smartlead Integration",s:"Planned",d:"Connect Smartlead for email campaign tracking — opens, replies, bounces alongside LinkedIn outreach data.",f:["Campaign sync & status tracking","Reply & bounce monitoring","Email + LinkedIn sequence coordination","Deliverability analytics"]},
        {e:"🤖",n:"Post-Demo Automation",s:"Live",d:"When a lead's status changes, AI analyzes their profile + engagement history and creates personalized SDR follow-up tasks.",f:["Trigger on any field value change","AI generates 1-3 tasks per lead","References engagement history","Dedup — won't re-process leads"]},
        {e:"📰",n:"LinkedIn Post Monitoring",s:"In Testing",d:"Monitor leads' LinkedIn posts weekly. AI scores relevance, generates structured summaries and suggested comments for engagement.",f:["Auto-fetch posts via Apify (last 7 days)","AI relevance scoring with custom prompts","Structured sentence + suggested comment output","Engagement opportunity tasks"]},
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
        <label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])handleCSVFile(e.target.files[0],"Accounts",setAccounts)}}/></label>
      </div></div>
    {filteredAccts.length===0?<div className="empty"><div className="em">🏢</div><p>{accounts.length>0?"No accounts match this campaign filter.":"Upload a CSV to get started."}</p></div>:
    <div className="tw"><table><thead><tr>{cols.map(k=><th key={k}>{k}</th>)}<th></th></tr></thead><tbody>{filteredAccts.map(a=>{const f=a.fields||{};return(<tr key={a.id}>{cols.map(k=><td key={k} style={k==="Name"?{color:"var(--t1)",fontWeight:500}:k==="Campaign Tag"?{fontSize:10,color:"var(--acc)"}:{}}>{fmt(f[k])}</td>)}<td><button className="btn btn-d btn-s" onClick={()=>del("Accounts",[a.id],setAccounts)}><I.Trash/></button></td></tr>)})}</tbody></table></div>}</div>);
  })()}

  {/* LEADS */}
  {tab==="leads"&&!loading&&(()=>{
    const prefCols = ["Name","Email","Title","Company","Custom Code","GA Engagement Score","GA Last Visit","Campaign Tag"];
    const allCols = leads.length ? [...new Set(leads.flatMap(l => Object.keys(l.fields || {})))] : [];
    // Always show preferred GA columns even if currently empty (Airtable omits empty fields from records)
    const ALWAYS_SHOW = ["Custom Code","GA Engagement Score","GA Last Visit"];
    const effectiveCols = [...new Set([...allCols, ...ALWAYS_SHOW])];
    const cols = [...prefCols.filter(c => effectiveCols.includes(c)), ...effectiveCols.filter(c => !prefCols.includes(c) && c !== "Campaign Tag" && !c.startsWith("GA "))].slice(0, 9);
    if (effectiveCols.includes("Campaign Tag") && !cols.includes("Campaign Tag")) cols.push("Campaign Tag");
    const fmt = v => { if (v === null || v === undefined) return ""; if (typeof v === "object") return JSON.stringify(v).slice(0, 50); return String(v).slice(0, 60); };
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
        <label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])handleCSVFile(e.target.files[0],"Leads",setLeads)}}/></label>
      </div></div>

    {filteredLeads.length===0?<div className="empty"><div className="em">👤</div><p>{leads.length>0?"No leads match this campaign filter.":"Upload a CSV."}</p></div>:
    <div className="tw"><table><thead><tr>{cols.map(k=><th key={k}>{k}</th>)}<th></th></tr></thead><tbody>{filteredLeads.map(l=>{const f=l.fields||{};return(<tr key={l.id}>{cols.map(k=><td key={k} style={k==="Name"?{color:"var(--t1)",fontWeight:500}:k==="Email"?{fontSize:10}:k==="Campaign Tag"?{fontSize:10,color:"var(--acc)"}:k==="Custom Code"?{fontSize:10,fontFamily:"'JetBrains Mono',monospace",color:"var(--t3)"}:k==="GA Engagement Score"?{fontWeight:600,color:f[k]>50?"var(--grn)":f[k]>20?"var(--amb)":"var(--t3)"}:k==="GA Last Visit"?{fontSize:10,color:f[k]?"var(--blu)":"var(--t3)"}:{}}>{fmt(f[k])}</td>)}<td><button className="btn btn-d btn-s" onClick={()=>del("Leads",[l.id],setLeads)}><I.Trash/></button></td></tr>)})}</tbody></table></div>}</div>);
  })()}

  {/* TASK RULES (unified — signal + top_x) */}
  {tab==="rules"&&!loading&&(<div><div className="ph"><div><div className="pt">Task Rules</div><div className="pd">{rules.length} rules</div></div><button className="btn btn-s btn-p" onClick={()=>setEditRule({})}><I.Plus/> Add Rule</button></div>

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
      {signalRules.filter(r=>{const tt=(r.fields||{})["Task Type"];return tt==="news"||tt==="both"}).length===0&&(
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
      {signalRules.filter(r=>{const tt=(r.fields||{})["Task Type"];return tt==="job_post"||tt==="both"}).length===0&&(
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
      {topXRules.length===0&&(
        <button className="btn btn-s btn-ai" style={{marginTop:10}} onClick={()=>setEditRule({taskType:"top_x"})}><I.Plus/> Create Top X Rule</button>
      )}
    </div>)}
  </div>

  {rules.length===0?null:<>

  {/* Signal rules table */}
  {signalRules.length>0&&(<div style={{marginBottom:topXRules.length?20:0}}>
  <div style={{fontSize:11,fontWeight:600,color:"var(--t2)",marginBottom:8}}>📰 Signal Rules</div>
  <div className="tw"><table><thead><tr><th>Name</th><th>Task Type</th><th>Scan Target</th><th>Ease</th><th>Strength</th><th>Keywords</th><th></th></tr></thead><tbody>{signalRules.map(r=>{const f=r.fields||{};const isJobOnly=f["Task Type"]==="job_post";return(<tr key={r.id}><td style={{color:"var(--t1)",fontWeight:500}}>{f.Name}</td><td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="both"?"ca":"cg")}>{f["Task Type"]||"news"}</span></td><td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":f["Scan Target"]==="both"?"ca":"cg")}>{f["Scan Target"]||"accounts"}</span></td><td>{f.Ease}</td><td>{f.Strength}</td><td style={{fontSize:10,color:"var(--t3)"}}>{(isJobOnly?(f["Job Title Keywords"]||""):(f.Keywords||"")).slice(0,40)}</td><td><div style={{display:"flex",gap:4}}><button className="btn btn-s" onClick={()=>setEditRule({airtableId:r.id,name:f.Name,description:f.Description,taskType:f["Task Type"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease,strength:f.Strength,sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean),jobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean),scoringPrompt:f["Scoring Prompt"]||""})}>Edit</button><button className="btn btn-s" onClick={()=>duplicateRule(r)} title="Duplicate"><I.Copy/></button><button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button></div></td></tr>)})}</tbody></table></div>
  </div>)}

  {/* Top X rules cards */}
  {topXRules.length>0&&(<div>
  <div style={{fontSize:11,fontWeight:600,color:"var(--t2)",marginBottom:8}}>🎯 Top X Rules</div>
  <div style={{display:"flex",flexDirection:"column",gap:12}}>{topXRules.map(r=>{const f=r.fields||{};const sf=JSON.parse(f["Scoring Fields"]||"[]");return(
    <div key={r.id} style={{padding:16,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}><div><div style={{fontSize:14,fontWeight:600}}>{f.Name}</div>{f.Description&&<div style={{fontSize:11,color:"var(--t3)",marginTop:2}}>{f.Description}</div>}</div><div style={{display:"flex",gap:6}}><span className={"chip "+(f["Scan Target"]==="accounts"?"cg":"cp")}>{f["Scan Target"]||"leads"}</span><span className="chip ca">TOP {f["Top N"]||10}</span></div></div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>{sf.map((s,i)=>(<div key={i} style={{padding:"4px 10px",background:"var(--hover)",borderRadius:4,fontSize:10}}><span style={{color:"var(--t1)"}}>{s.field}</span><span style={{color:"var(--acc)",marginLeft:6}}>{s.weight}%</span></div>))}</div>
      <div style={{display:"flex",gap:6}}><button className="btn btn-p btn-s" onClick={()=>runTopX(r)} disabled={scanning}>{scanning?"Running…":"▶ Run"}</button><button className="btn btn-s" onClick={()=>setEditRule({airtableId:r.id,taskType:"top_x",name:f.Name,description:f.Description||"",scanTarget:f["Scan Target"]||"leads",topN:f["Top N"]||10,scoringFields:sf,ease:f.Ease||"Medium",strength:f.Strength||"Strong",scoringPrompt:f["Scoring Prompt"]||""})}>Edit</button><button className="btn btn-s" onClick={()=>duplicateRule(r)} title="Duplicate"><I.Copy/></button><button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button></div>
    </div>)})}</div>
  </div>)}
  </>}</div>)}

  {/* PROMPTS */}
  {tab==="prompts"&&!loading&&(<div><div className="ph"><div><div className="pt">Scoring Prompts</div><div className="pd">AI scoring criteria (0-100)</div></div><button className="btn btn-ai btn-s" onClick={async()=>{const empty=rules.filter(r=>!(r.fields||{})["Scoring Prompt"]);for(const rule of empty){const f=rule.fields||{};try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const d=await res.json();if(d.scoringPrompt){await at("update","Task Rules",{records:[{id:rule.id,fields:{"Scoring Prompt":d.scoringPrompt}}]},bid);setRules(p=>p.map(x=>x.id===rule.id?{...x,fields:{...x.fields,"Scoring Prompt":d.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}}><I.Sparkle/> Generate Missing</button></div>
  <div style={{display:"flex",flexDirection:"column",gap:12}}>{rules.map(r=>{const f=r.fields||{};const tt=f["Task Type"]||"news";return(<div key={r.id} style={{padding:14,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:8}}><span className={"chip "+(tt==="job_post"?"cb":tt==="top_x"?"cp":"cg")}>{tt.replace(/_/g," ")}</span><span style={{fontSize:13,fontWeight:600}}>{f.Name}</span></div>
  <button className="btn btn-ai btn-s" onClick={async()=>{try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const d=await res.json();if(d.scoringPrompt){await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":d.scoringPrompt}}]},bid);setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":d.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}><I.Sparkle/> Regen</button></div>
  <textarea className="inp ta" value={f["Scoring Prompt"]||""} placeholder="No prompt — click Regen" style={{minHeight:70,fontSize:11,background:"var(--bg)"}} onChange={e=>{const v=e.target.value;setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":v}}:x))}} onBlur={async e=>{try{await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":e.target.value}}]},bid)}catch{}}}/>
  <div style={{fontSize:9,color:"var(--t3)",marginTop:4}}>{f["Scoring Prompt"]?f["Scoring Prompt"].length+" chars":"⚠️ Empty"}</div></div>)})}</div></div>)}

  {/* THRESHOLD */}
  {tab==="threshold"&&!loading&&(<div><div className="ph"><div><div className="pt">Scoring Threshold</div><div className="pd">Minimum score for signals to become tasks</div></div></div>
  <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,maxWidth:500}}>
  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}><span style={{fontSize:12,color:"var(--t2)"}}>Threshold</span><input type="range" className="sld" min="0" max="100" value={threshold} onChange={e=>setThreshold(+e.target.value)}/><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,fontWeight:600,color:"var(--acc)",minWidth:30,textAlign:"center"}}>{threshold}</span></div>
  <div style={{display:"flex",gap:16,fontSize:10,color:"var(--t3)"}}><span>0-49: Weak</span><span>50-69: Partial</span><span style={{color:"var(--acc)"}}>70-89: Strong</span><span style={{color:"var(--grn)"}}>90-100: Exact</span></div></div></div>)}

  {/* TASKS */}
  {tab==="tasks"&&!loading&&(<div>
    <div className="ph"><div><div className="pt">Tasks</div><div className="pd">{fTasks.length} tasks{selCount>0&&<span style={{color:"var(--acc)",marginLeft:6}}>· {selCount} selected</span>}</div></div>
    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
      <button className="btn btn-s" onClick={()=>setShowExportModal(true)} disabled={!tasks.length}><I.Download/> Export{selCount>0?` (${selCount})`:""}</button>
      <button className="btn btn-s" style={{color:"var(--pur)",borderColor:"rgba(155,126,216,.3)"}} disabled={!tasks.length} onClick={()=>setEnrichModal({mode:"select"})}><I.Sparkle/> Enrich Phones</button>
      {hsConnected && <button className="btn btn-s" style={{color:"var(--grn)",borderColor:"rgba(93,168,122,.3)"}} disabled={!tasks.length} onClick={()=>setEnrichModal({mode:"push"})}><I.Upload/> Push to HubSpot{selCount>0?` (${selCount})`:""}</button>}
      {hasSignals&&<button className="btn btn-p btn-s" onClick={startScan} disabled={scanning||!accounts.length||!signalRules.length}>{scanning?"Scanning "+Math.round(scanProg)+"%":<><I.Play/> Run Scan</>}</button>}
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
      <th>Company</th><th>Task Rule</th><th>Score</th><th>Target</th><th>Signal</th><th>Type</th><th>Date</th><th>Link</th><th></th>
    </tr></thead><tbody>{fTasks.map(t=>{const f=t.fields||{};const sc=f.Score||0;const sel=selectedTasks.has(t.id);return(<tr key={t.id} style={{background:sel?"rgba(191,163,90,.06)":"transparent"}}>
      <td style={{padding:"10px 8px"}}><input type="checkbox" checked={sel} onChange={()=>toggleTask(t.id)} style={{cursor:"pointer",accentColor:"var(--acc)"}}/></td>
      <td style={{color:"var(--t1)",fontWeight:500}}>{f.Company}</td>
      <td>{f["Task Rule"]}</td>
      <td><div className="sb" style={{width:80}}><div className="st"><div className="sf" style={{width:sc+"%",background:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}/></div><span className="sv" style={{color:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}>{sc}</span></div></td>
      <td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":"cg")}>{f["Scan Target"]||"accounts"}</span></td>
      <td style={{maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.Signal}</td>
      <td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="top_x"?"cp":"cg")}>{(f["Task Type"]||"news").replace(/_/g," ").toUpperCase()}</span></td>
      <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f.Date}</td>
      <td>{f.URL?<a href={f.URL} target="_blank" rel="noopener" style={{color:"var(--blu)",fontSize:10}}>↗</a>:"—"}</td>
      <td><button className="btn btn-d btn-s" onClick={()=>del("Tasks",[t.id],setTasks)}><I.Trash/></button></td>
    </tr>)})}</tbody></table></div>}
  </div>)}

  {/* ════ LINKEDIN AUTOMATION ════ */}
  {tab==="outreach"&&!loading&&(<div>
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
                const data = await outreachAPI("get_auth_link",{callbackUrl:window.location.href});
                if(data.url){navigator.clipboard.writeText(data.url);alert("Auth link copied! Paste it in an email to your client.\n\nLink: "+data.url.slice(0,60)+"...")}
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
      const outRules = rules.filter(r => (r.fields || {})["Task Type"] === "linkedin_outreach");
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
      <div style={{fontSize:12,fontWeight:600,marginBottom:8,color:"var(--t2)"}}>Outreach Queue ({outreachItems.length})</div>
      <div className="tw"><table><thead><tr><th>Lead</th><th>Company</th><th>Campaign</th><th>Status</th><th>DM Step</th><th>Next Action</th></tr></thead>
      <tbody>{outreachItems.slice(0,50).map(q => {
        const f = q.fields || {};
        const status = f.Status || "queued";
        const statusColor = status==="replied"?"cg":status==="completed"?"cg":status==="error"?"cr":status==="connected"||status.startsWith("dm_")?"cp":status==="connection_sent"?"cb":"ca";
        return (<tr key={q.id} style={status==="replied"?{background:"var(--grn-d)"}:{}}>
          <td style={{color:"var(--t1)",fontWeight:500}}>{f["Lead Name"]}</td>
          <td>{f.Company}</td>
          <td style={{fontSize:10}}>{f.Campaign}</td>
          <td><span className={"chip "+statusColor}>{status==="replied"?"✋ replied":status.replace(/_/g," ")}</span></td>
          <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f["DM Step"]||0}</td>
          <td style={{fontSize:10}}>{status==="replied"?"—":(f["Next Action Date"]||"—")}</td>
        </tr>);
      })}</tbody></table></div>
    </div>)}

    </>)}
  </div>)}

  </div></div>

  {editRule!==null&&<RuleEditor rule={editRule} onSave={saveRule} onClose={()=>setEditRule(null)} availableFields={availableFields}/>}
  {showExportModal&&<ExportModal tasks={selCount>0?fTasks.filter(t=>selectedTasks.has(t.id)):fTasks} accounts={accounts} leads={leads} onClose={()=>setShowExportModal(false)}/>}
  {enrichModal&&<EnrichModal mode={enrichModal.mode} tasks={tasks} rules={rules} fTasks={fTasks} selectedTasks={selectedTasks} onEnrich={enrichTasks} onPush={pushToHubSpot} enrichResults={enrichResults} enrichLoading={enrichLoading} hsConnected={hsConnected} hsOwners={hsOwners} hsLoading={hsLoading} onClose={()=>{setEnrichModal(null);setEnrichResults([])}}/>}
  {manualModal&&<ManualOutreachModal leads={leads} rules={rules} linkedinAccount={linkedinAccount} outreachAPI={outreachAPI} onClose={()=>setManualModal(null)} baseId={bid}/>}

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

  const ruleNames = [...new Set(tasks.map(t => (t.fields || {})["Task Rule"]).filter(Boolean))];
  const filtered = tasks.filter(t => {
    const f = t.fields || {};
    if (ruleFilter !== "all" && f["Task Rule"] !== ruleFilter) return false;
    if (dateFrom && (f.Date || "") < dateFrom) return false;
    if (dateTo && (f.Date || "") > dateTo) return false;
    return true;
  });

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
    <div style={{display:"flex",alignItems:"center",gap:12}}>
      <button className="btn btn-p btn-s" disabled={loading || !filtered.length} onClick={() => onPush(filtered, { ownerId, priority, status })}>
        {loading ? "⏳ Pushing..." : `Push ${filtered.length} Task${filtered.length !== 1 ? "s" : ""} to HubSpot`}
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
          setMsg(`✅ Sync complete! ${r.activeThisWeek} leads active this week, ${r.inactive} inactive (zeroed out). ${r.updatesSucceeded||0} leads updated.${r.unmatchedCodes > 0 ? ` ${r.unmatchedCodes} GA codes had no matching lead.` : ""}`);
        }
        if (onSyncComplete) onSyncComplete();
        await loadConfig();
      } else {
        setMsg("❌ " + (r.error || "Sync failed"));
      }
    } catch (e) { setMsg("❌ " + e.message); }
    setBusy(false);
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
                {syncResult.totalLeads} total leads · {syncResult.leadsTracked} have Custom Codes · <span style={{color:"var(--grn)",fontWeight:600}}>{syncResult.activeThisWeek} active this week</span> · <span style={{color:"var(--t3)"}}>{syncResult.inactive} inactive</span>
                {syncResult.unmatchedCodes > 0 && <> · <span style={{color:"var(--amb)"}}>{syncResult.unmatchedCodes} GA codes don't match any lead</span></>}
              </div>
            </div>
          )}
        </div>
      )}

      {/* STATUS MESSAGE */}
      {msg && <div style={{marginTop:14,padding:10,background:msg.startsWith("✅")?"var(--grn-d)":msg.startsWith("⏳")||msg.startsWith("🔗")?"var(--hover)":"var(--red-d)",color:msg.startsWith("✅")?"var(--grn)":msg.startsWith("⏳")||msg.startsWith("🔗")?"var(--t2)":"var(--red)",borderRadius:6,fontSize:11,whiteSpace:"pre-wrap"}}>{msg}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// EMAIL CAMPAIGN TAB — Sender Profile + Offers Library + AI Generation
// ═══════════════════════════════════════════════════════════════
function EmailCampaignTab({ baseId, campaign, leads }) {
  const [step, setStep] = useState(1); // 1=leads, 2=context, 3=generate, 4=review, 5=smartlead, 6=launch
  const [tags, setTags] = useState([]);
  const [selectedTag, setSelectedTag] = useState("");
  const [tagLeads, setTagLeads] = useState([]);
  const [selectedLeadIds, setSelectedLeadIds] = useState(new Set());

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
      for (const g of generated) {
        const r2 = await ec("regenerate_email", { leadId: g.leadId, config, factors, feedback: bulkFeedback });
        out.push(r2.ok ? r2 : g);
      }
      setGenerated(out);
      setBulkFeedback("");
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

  const launchCampaign = async () => {
    const validEmails = generated.filter(g => g.ok && g.email);
    if (validEmails.length === 0) { setErr("No valid emails to launch"); return; }
    if (slMode === "new" && !slCampaignName) { setErr("Campaign name required"); return; }
    if (slMode === "new" && slMailboxIds.size === 0) { setErr("Pick at least one mailbox"); return; }
    if (!confirm(`Launch ${validEmails.length} emails via Smartlead?\n\nMode: ${slMode === "new" ? `New campaign "${slCampaignName}"` : "Add to existing"}\nMailboxes: ${slMailboxIds.size}\nSequence: ${sequenceLength} step${sequenceLength!==1?"s":""}\n${activateOnLaunch ? "⚠️ Will ACTIVATE & start sending" : "Will create as DRAFT"}`)) return;

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
      });
      setLaunchResult(r);
      if (r.ok) setStep(6);
      else setErr(r.error || "Launch failed");
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

      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <div style={{fontSize:11,color:"var(--t2)"}}>{generated.filter(g=>g.ok).length}/{generated.length} successful</div>
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
      {step==="push"&&<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={hsLoading||!filtered.length} onClick={async()=>{await onPush(filtered,{ownerId,priority,status:"NOT_STARTED"});onClose()}}>{hsLoading?"⏳":"📤 Push "+filtered.length+" Tasks"}</button></>}
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
function RuleEditor({rule,onSave,onClose,availableFields}){
  const isTopX = rule.taskType === "top_x";
  const isOutreach = rule.taskType === "linkedin_outreach";
  const [mode, setMode] = useState(isOutreach ? "outreach" : isTopX ? "top_x" : "signal");

  // Signal + Top X fields
  const [f,sF]=useState({airtableId:rule.airtableId||null,name:rule.name||"",description:rule.description||"",taskType:rule.taskType||"news",scanTarget:rule.scanTarget||(isTopX?"leads":"accounts"),ease:rule.ease||"Medium",strength:rule.strength||"Medium",sources:rule.sources||["News"],keywords:rule.keywords||[],jobTitleKeywords:rule.jobTitleKeywords||[],scoringPrompt:rule.scoringPrompt||"",
    topN:rule.topN||10,scoringFields:rule.scoringFields||[]});

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
    <div style={{fontWeight:600,color:"var(--t2)",marginBottom:4}}>📋 Prompt format guide</div>
    <div style={{marginBottom:3}}>Start with: <em>"Rate this signal on how directly it [describes what the signal must show]."</em></div>
    <div style={{marginBottom:3}}>Define 4 tiers: <strong style={{color:"var(--t2)"}}>90-100</strong> (exact match with examples), <strong style={{color:"var(--t2)"}}>70-89</strong> (strong but incomplete), <strong style={{color:"var(--t2)"}}>50-69</strong> (tangential), <strong style={{color:"var(--t2)"}}>&lt;50</strong> (reject — most important tier).</div>
    <div style={{marginBottom:3}}>✅ Include concrete examples: <em>"CMO steps down after 10 months" scores 95, "Company hires new CMO" scores 45</em></div>
    <div>❌ Include <strong style={{color:"var(--t2)"}}>false positives to reject</strong>: e.g. for "Senior marketer exits" — <em>"a robotics leader leaving is NOT a marketer, score below 30"</em></div>
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
  </>)}

  {/* ──── OUTREACH MODE ──── */}
  {mode==="outreach"&&(<>
  <div style={{padding:14,border:"1px solid rgba(91,143,212,.3)",borderRadius:8,background:"rgba(91,143,212,.05)",marginBottom:14}}>
    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span>🎯</span><span style={{fontSize:11,fontWeight:600,color:"var(--blu)"}}>LEAD SELECTION</span></div>
    <div className="ig"><div className="il">AI Lead Prompt <span style={{fontSize:9,color:"var(--t3)",fontWeight:400}}>— which leads should be targeted?</span></div>
      <textarea className="inp ta" value={oc.leadPrompt} onChange={e=>setOc(p=>({...p,leadPrompt:e.target.value}))} placeholder="e.g. Select VP+ in marketing at 200-5000 employee SaaS companies." style={{minHeight:50,fontSize:11}}/>
    </div>
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
  const allTaskCols = [...new Set(tasks.flatMap(t => Object.keys(t.fields || {})))];
  const defaultCols = ["Company","Task Rule","Score","Scan Target","Signal","Source","Task Type","Date","URL"];
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
  // For lead-targeted Top X: task.Company = lead's Name (person name)
  // For account-targeted scans: task.Company = account's Name (company name)
  const acctMap = {};
  (accounts || []).forEach(a => {
    const n = (a.fields?.Name || "").toLowerCase().trim();
    if (n) acctMap[n] = a.fields;
  });

  // Lead lookup by BOTH Name (person) and Company - so we match regardless of what task.Company contains
  const leadByName = {};
  const leadByCompany = {};
  (leads || []).forEach(l => {
    const name = (l.fields?.Name || "").toLowerCase().trim();
    const company = (l.fields?.Company || "").toLowerCase().trim();
    if (name) leadByName[name] = l.fields;
    if (company && !leadByCompany[company]) leadByCompany[company] = l.fields;
  });

  const allExportCols = [...selectedCols, ...enrichAcct.map(c => "Acct: " + c), ...enrichLead.map(c => "Lead: " + c)];
  const enrichCount = enrichAcct.length + enrichLead.length;

  const doExport = () => {
    if (!filteredTasks.length || !allExportCols.length) return;
    const csvRows = [allExportCols.map(c => '"' + c.replace(/"/g, '""') + '"').join(",")];
    filteredTasks.forEach(t => {
      const f = t.fields || {};
      const co = (f.Company || "").toLowerCase().trim();

      // Try matching lead by name first (Top X on leads), then by company
      const ld = leadByName[co] || leadByCompany[co] || {};

      // Try matching account directly, or chain via lead's Company field
      const leadCompany = (ld.Company || "").toLowerCase().trim();
      const ad = acctMap[co] || (leadCompany ? acctMap[leadCompany] : {}) || {};

      const row = allExportCols.map(c => {
        if (c.startsWith("Acct: ")) return String(ad[c.slice(6)] || "");
        if (c.startsWith("Lead: ")) return String(ld[c.slice(6)] || "");
        return String(f[c] || "");
      });
      csvRows.push(row.map(v => '"' + v.replace(/"/g, '""') + '"').join(","));
    });
    const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "signalscope-tasks-" + new Date().toISOString().slice(0, 10) + ".csv"; a.click();
    URL.revokeObjectURL(url); onClose();
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
        <div className="il">Enrich from Accounts <span style={{ fontSize: 9, color: "var(--t3)", fontWeight: 400 }}>— joined by Company name</span></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {acctCols.map(c => (<label key={c} style={chipStyle(enrichAcct.includes(c), "grn")}><input type="checkbox" checked={enrichAcct.includes(c)} onChange={() => toggleEA(c)} style={{ accentColor: "var(--grn)", width: 12, height: 12 }} />{c}</label>))}
        </div>
      </div>)}

      {/* Enrich from Leads */}
      {leadCols.length > 0 && (<div className="ig">
        <div className="il">Enrich from Leads <span style={{ fontSize: 9, color: "var(--t3)", fontWeight: 400 }}>— joined by Company name</span></div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {leadCols.map(c => (<label key={c} style={chipStyle(enrichLead.includes(c), "blu")}><input type="checkbox" checked={enrichLead.includes(c)} onChange={() => toggleEL(c)} style={{ accentColor: "var(--blu)", width: 12, height: 12 }} />{c}</label>))}
        </div>
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