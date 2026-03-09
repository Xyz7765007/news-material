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

export default function SignalScope() {
  const [camp, setCamp] = useState(null); // active campaign object
  const [campaigns, setCampaigns] = useState(DEFAULT_CAMPAIGNS);
  const [tab, setTab] = useState("accounts");
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
  const [editRule, setEditRule] = useState(null);
  const [editTopX, setEditTopX] = useState(null);
  const [filter, setFilter] = useState({src:"all",target:"all",q:"",from:"",to:""});
  const [csvModal, setCsvModal] = useState(null);
  const [setupStatus, setSetupStatus] = useState(null);
  const [availableFields, setAvailableFields] = useState({ Accounts: [], Leads: [] });
  const [showAddCampaign, setShowAddCampaign] = useState(false);
  const [editingBase, setEditingBase] = useState(false);
  const [baseInput, setBaseInput] = useState("");
  const [baseConnecting, setBaseConnecting] = useState(false);
  const [baseError, setBaseError] = useState("");

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
  const hasSignals = hasNews || hasJobs;
  // Combined active features (for display in sidebar)
  const activeFeatures = [...new Set([
    ...configFeatures,
    ...(ruleTaskTypes.some(t => t === "news" || t === "both") ? ["news"] : []),
    ...(ruleTaskTypes.some(t => t === "job_post" || t === "both") ? ["job_posts"] : []),
    ...(ruleTaskTypes.includes("top_x") ? ["top_x"] : []),
  ])];

  // ─── Load campaign registry from master base ──────────────
  useEffect(() => {
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
        setCampaigns([...DEFAULT_CAMPAIGNS, ...userCamps]);
      } catch (e) { console.log("Could not load campaigns:", e.message); }
    })();
  }, []);

  useEffect(() => {
    if (camp) {
      // Reset state for new campaign
      setAccounts([]); setLeads([]); setRules([]); setTasks([]);
      setFilter({src:"all",target:"all",q:"",from:"",to:""});
      setSetupStatus(null); setAvailableFields({ Accounts: [], Leads: [] });
      setEditingBase(false); setBaseInput(""); setBaseError("");
      setTab("accounts");
      loadAll();
      fetchAvailableFields();
    }
  }, [camp]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [a,l,r,t] = await Promise.all([at("list","Accounts",{},bid),at("list","Leads",{},bid),at("list","Task Rules",{},bid),at("list","Tasks",{params:{sort:[{field:"Created",direction:"desc"}]}},bid)]);
      setAccounts(a.records||[]);setLeads(l.records||[]);setRules(r.records||[]);setTasks(t.records||[]);
    } catch(e){console.error("Load failed:",e)}
    setLoading(false);
  };

  const fetchAvailableFields = async () => {
    try {
      const [af, lf] = await Promise.all([at("get_fields","Accounts",{},bid),at("get_fields","Leads",{},bid)]);
      setAvailableFields({ Accounts: af.fields || [], Leads: lf.fields || [] });
    } catch (e) { console.error(e); }
  };

  const del = async (table, ids, setter) => { try{await at("delete",table,{recordIds:ids},bid);setter(p=>p.filter(r=>!ids.includes(r.id)))} catch(e){console.error(e)} };

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
    Accounts: { Name:["name","company","company name","account","account name","organization","org name","business name"],Domain:["domain","website","company website","url","company url","company domain"],Industry:["industry","vertical","sector","category"],Size:["size","employees","employee count","company size","headcount","num employees","number of employees"],"LinkedIn URL":["linkedin","linkedin url","linkedin company","company linkedin","linkedin link"],Country:["country","location","hq","headquarters","region","geography","city","state"] },
    Leads: { Name:["name","full name","contact name","contact","person","lead name"],Email:["email","email address","work email","business email","e-mail","mail"],Title:["title","job title","position","role","designation","current title"],Company:["company","organization","employer","company name","org","account name"],"LinkedIn URL":["linkedin","linkedin url","linkedin profile","profile url","li url"],Phone:["phone","phone number","direct phone","mobile","cell","telephone","work phone"] },
  };

  const autoDetect = (headers, table) => {
    const aliases = FIELD_ALIASES[table] || {};
    const m = {};
    for (const h of headers) {
      const l = h.toLowerCase().trim();
      let hit = false;
      for (const [f, alts] of Object.entries(aliases)) { if (alts.includes(l) || l === f.toLowerCase()) { m[h] = f; hit = true; break; } }
      if (!hit) m[h] = h;
    }
    return m;
  };

  const handleCSVFile = (file, table, setter) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const lines = e.target.result.split("\n").filter(l => l.trim());
      if (lines.length < 2) return;
      const headers = parseCSVLine(lines[0]);
      const rows = lines.slice(1).map(l => parseCSVLine(l)).filter(r => r.some(c => c));
      setCsvModal({ table, setter, headers, rows, mappings: autoDetect(headers, table) });
    };
    reader.readAsText(file);
  };

  const uploadMappedCSV = async () => {
    if (!csvModal) return;
    const { table, setter, headers, rows, mappings } = csvModal;
    const active = Object.entries(mappings).filter(([_, v]) => v !== "__skip__");
    const known = Object.keys(FIELD_ALIASES[table] || {});
    const custom = active.map(([_, f]) => f).filter(f => !known.includes(f));
    if (custom.length > 0) { try { await at("ensure_fields", table, { fieldNames: custom }, bid); } catch (e) { console.error(e); } }
    const recs = rows.map(row => {
      const obj = {};
      active.forEach(([csv, field]) => { const idx = headers.indexOf(csv); if (idx >= 0 && row[idx]) obj[field] = row[idx]; });
      return obj;
    }).filter(r => Object.keys(r).length > 0);
    if (!recs.length) { setCsvModal(null); return; }
    try {
      setLoading(true); setCsvModal(null);
      const res = await at("create", table, { records: recs }, bid);
      setter(p => [...p, ...(res.records || [])]);
      fetchAvailableFields(); // always refresh — user might add Top X later
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  // ─── Filtered tasks (used by export + task tab) ─────────────
  const fTasks=tasks.filter(t=>{const f=t.fields||{};if(filter.src!=="all"&&f["Task Type"]!==filter.src)return false;if(filter.target!=="all"&&f["Scan Target"]!==filter.target)return false;if(filter.q&&!(f.Company||"").toLowerCase().includes(filter.q.toLowerCase())&&!(f["Task Rule"]||"").toLowerCase().includes(filter.q.toLowerCase()))return false;if(filter.from&&(f.Date||"")<filter.from)return false;if(filter.to&&(f.Date||"")>filter.to)return false;return true});

  const exportTasksCSV = () => {
    const data = fTasks.length ? fTasks : tasks;
    if (!data.length) return;
    const allF = new Set(); data.forEach(t => Object.keys(t.fields || {}).forEach(k => allF.add(k)));
    const cols = Array.from(allF);
    const csv = [cols.map(c => '"' + c.replace(/"/g, '""') + '"').join(","), ...data.map(t => { const f = t.fields || {}; return cols.map(c => '"' + String(f[c] || "").replace(/"/g, '""') + '"').join(","); })];
    const blob = new Blob([csv.join("\n")], { type: "text/csv" });
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = u; a.download = "tasks-" + new Date().toISOString().slice(0, 10) + ".csv"; a.click(); URL.revokeObjectURL(u);
  };

  // ─── Save signal rule (news/job_posts) ─────────────────────
  const saveRule = async (rule) => {
    const fields={Name:rule.name,Description:rule.description||"","Task Type":rule.taskType||"news","Scan Target":rule.scanTarget||"accounts",Ease:rule.ease||"Medium",Strength:rule.strength||"Medium",Sources:(rule.sources||[]).join(", "),Keywords:(rule.keywords||[]).join(", "),"Job Title Keywords":(rule.jobTitleKeywords||[]).join(", "),"Scoring Prompt":rule.scoringPrompt||""};
    try{
      if(rule.airtableId){await at("update","Task Rules",{records:[{id:rule.airtableId,fields}]},bid);setRules(p=>p.map(r=>r.id===rule.airtableId?{...r,fields}:r))}
      else{const res=await at("create","Task Rules",{records:[fields]},bid);setRules(p=>[...p,...(res.records||[])])}
    }catch(e){console.error(e)}
    setEditRule(null);
  };

  // ─── Save Top X rule ───────────────────────────────────────
  const saveTopXRule = async (rule) => {
    const fields = { Name: rule.name, Description: rule.description || "", "Task Type": "top_x", "Scan Target": rule.scanTarget || "leads", "Top N": rule.topN || 10, "Scoring Fields": JSON.stringify(rule.scoringFields || []), Ease: "Medium", Strength: "Strong" };
    try {
      await at("ensure_fields", "Task Rules", { fieldNames: [{ name: "Top N", type: "number", options: { precision: 0 } }, { name: "Scoring Fields", type: "multilineText" }] }, bid);
      if (rule.airtableId) { await at("update", "Task Rules", { records: [{ id: rule.airtableId, fields }] }, bid); setRules(p => p.map(r => r.id === rule.airtableId ? { ...r, fields } : r)); }
      else { const res = await at("create", "Task Rules", { records: [fields] }, bid); setRules(p => [...p, ...(res.records || [])]); }
    } catch (e) { console.error(e); }
    setEditTopX(null);
  };

  // ─── Run Top X ─────────────────────────────────────────────
  const runTopX = async (rule) => {
    setScanning(true); setScanText("🎯 Running Top X scoring..."); setScanProg(30);
    try {
      const sf = JSON.parse(rule.fields?.["Scoring Fields"] || "[]");
      const res = await at("run_topx", "", { rule: { name: rule.fields?.Name, scanTarget: rule.fields?.["Scan Target"] || "leads", topN: rule.fields?.["Top N"] || 10, scoringFields: sf } }, bid);
      setScanProg(80);
      if (res.tasks?.length > 0) { const cr = await at("create", "Tasks", { records: res.tasks }, bid); setTasks(p => [...(cr.records || []), ...p]); setScanText(`✅ ${res.tasks.length} tasks from top ${res.topN}/${res.totalRecords}`); }
      else setScanText(res.error || "No results");
    } catch (e) { setScanText("❌ " + e.message); }
    setScanProg(100); setTimeout(() => setScanning(false), 2000);
  };

  // ─── Run Signal Scan (news + jobs) ─────────────────────────
  const startScan = useCallback(async()=>{
    const sigRules=rules.filter(r=>{const tt=(r.fields||{})["Task Type"]||"news";return tt==="news"||tt==="job_post"||tt==="both"});
    if(scanning||!accounts.length||!sigRules.length)return;
    setScanning(true);scanRef.current=true;setScanProg(0);
    const taskDefs=rules.filter(r=>{const tt=(r.fields||{})["Task Type"]||"news";return tt==="news"||tt==="job_post"||tt==="both"}).map(r=>{const f=r.fields||{};const kws=(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean);const jtk=(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean);let sp=f["Scoring Prompt"]||"";if(!sp){const ak=[...kws,...jtk].slice(0,5).join(", ");sp="Rate this signal for \""+f.Name+"\". Score 90-100 for exact matches ("+ak+"). 70-89 strong. 50-69 partial. Below 50 unrelated."}return{id:r.id,name:f.Name||"",description:f.Description||"",taskType:f["Task Type"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease||"Medium",strength:f.Strength||"Medium",sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:kws,jobTitleKeywords:jtk,scoringPrompt:sp}});
    const companies=accounts.map(a=>{const f=a.fields||{};const li=f["LinkedIn URL"]||f.LinkedIn||"";return{name:f.Name||f.Company||"",domain:f.Domain||f.Website||"",linkedinSlug:extractLinkedInSlug(li),linkedinCompanyId:extractLinkedInId(li)}}).filter(c=>c.name);
    const nT=taskDefs.filter(t=>t.taskType==="news"||t.taskType==="both");
    const jT=taskDefs.filter(t=>t.taskType==="job_post"||t.taskType==="both");
    const total=companies.length;
    if(nT.length>0){for(let i=0;i<companies.length;i++){if(!scanRef.current)break;setScanText("📰 "+companies[i].name);setScanProg(Math.round(i/total*50));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({company:companies[i],taskDefs:nT,mode:"news"})});if(res.ok){const d=await res.json();await processSignals(d.news||[],companies[i],taskDefs)}}catch(e){console.error(e)}await sleep(100)}}
    if(scanRef.current&&jT.length>0){const need=companies.filter(c=>c.linkedinSlug&&!c.linkedinCompanyId);if(need.length>0){setScanText("🔗 Resolving LinkedIn IDs...");try{const res=await fetch("/api/resolve-linkedin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slugs:need.map(c=>c.linkedinSlug)})});if(res.ok){const{ids}=await res.json();for(const c of companies){if(c.linkedinSlug&&!c.linkedinCompanyId&&ids[c.linkedinSlug.toLowerCase()])c.linkedinCompanyId=ids[c.linkedinSlug.toLowerCase()]}}}catch(e){console.error(e)}}
    const BS=5;for(let b=0;b<companies.length;b+=BS){if(!scanRef.current)break;const batch=companies.slice(b,b+BS);setScanText("📋 Jobs — Batch "+(Math.floor(b/BS)+1));setScanProg(50+Math.round(b/companies.length*50));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({companies:batch,taskDefs:jT,mode:"jobs-batch"})});if(res.ok){const d=await res.json();for(const result of(d.results||[])){const co=batch.find(c=>c.name===result.company);if(co)await processSignals(result.signals||[],co,taskDefs)}}}catch(e){console.error(e)}await sleep(200)}}
    setScanProg(100);setScanText("Scan complete");setScanning(false);scanRef.current=false;
  },[accounts,rules,threshold,scanning,bid]);

  const processSignals = async(signals, company, taskDefs)=>{
    const newT=[];
    for(const sig of signals){const scores=sig.relevanceScores||{};for(const tid of(sig.matchedTaskIds||[])){const td=taskDefs.find(t=>t.id===tid);if(!td)continue;const score=scores[tid]||Math.round((sig.confidence||0.7)*100)||50;if(score<threshold)continue;
    newT.push({Company:company.name,"Task Rule":td.name,Score:score,"Scan Target":td.scanTarget||"accounts",Signal:sig.headline||"",Source:sig.source||"",URL:sig.url||"","Task Type":sig.taskType||"news",Date:sig.date?sig.date.slice(0,10):new Date().toISOString().slice(0,10),Created:new Date().toISOString()})}}
    if(newT.length>0){try{const res=await at("create","Tasks",{records:newT},bid);setTasks(p=>[...(res.records||[]),...p])}catch(e){console.error(e)}}
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
      <div className="em">➕</div><div className="nm">Add Campaign</div><div className="ds">Connect an Airtable base and pick which features to enable.</div>
      <div className="bdg" style={{background:"var(--pur-d)",color:"var(--pur)"}}>New</div>
    </div>
  </div></div>
  {showAddCampaign&&<AddCampaignModal onSave={saveCampaign} onClose={()=>setShowAddCampaign(false)}/>}
  </>)}

  // ═══ DASHBOARD ═════════════════════════════════════════════
  // Nav always shows both rule tabs — users can add any rule type anytime.
  // Feature flags derived from rules, so UI adapts as rules are added.
  const signalRules = rules.filter(r => { const tt = (r.fields||{})["Task Type"]; return !tt || tt==="news" || tt==="job_post" || tt==="both"; });
  const topXRules = rules.filter(r => (r.fields||{})["Task Type"] === "top_x");

  const navs = [
    {id:"accounts",label:"Accounts",count:accounts.length},
    {id:"leads",label:"Leads",count:leads.length},
    {id:"rules",label:"Signal Rules",count:signalRules.length},
    {id:"topx_rules",label:"Top X Rules",count:topXRules.length},
    ...(hasSignals ? [{id:"prompts",label:"Prompts",count:signalRules.length},{id:"threshold",label:"Scoring",count:null}] : []),
    {id:"tasks",label:"Tasks",count:tasks.length},
  ];

  return(<><style>{CSS}</style><div className="dash">
  <div className="side"><div className="side-hd"><div className="side-brand">SignalScope</div><div className="side-camp">{camp.name}</div><div className="side-back" onClick={()=>setCamp(null)}><I.Back/> All Campaigns</div></div>
  <div className="side-nav">{navs.map(n=>(<div key={n.id} className={"nav-i"+(tab===n.id?" on":"")} onClick={()=>setTab(n.id)}><span>{n.label}</span>{n.count!==null&&<span className="cnt">{n.count}</span>}</div>))}</div>
  <div style={{padding:"12px 16px",borderTop:"1px solid var(--bdr)"}}>
    {/* Airtable Base */}
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
  </div>
  </div>

  <div className="main">{loading&&<div style={{textAlign:"center",padding:40,color:"var(--t3)"}}>Loading…</div>}

  {/* ACCOUNTS */}
  {tab==="accounts"&&!loading&&(<div><div className="ph"><div><div className="pt">Accounts</div><div className="pd">{accounts.length} companies</div></div><label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])handleCSVFile(e.target.files[0],"Accounts",setAccounts)}}/></label></div>
  {accounts.length===0?<div className="empty"><div className="em">🏢</div><p>Upload a CSV to get started.</p></div>:
  <div className="tw"><table><thead><tr>{Object.keys(accounts[0]?.fields||{}).slice(0,6).map(k=><th key={k}>{k}</th>)}<th></th></tr></thead><tbody>{accounts.map(a=>(<tr key={a.id}>{Object.values(a.fields||{}).slice(0,6).map((v,i)=><td key={i}>{String(v).slice(0,50)}</td>)}<td><button className="btn btn-d btn-s" onClick={()=>del("Accounts",[a.id],setAccounts)}><I.Trash/></button></td></tr>))}</tbody></table></div>}</div>)}

  {/* LEADS */}
  {tab==="leads"&&!loading&&(<div><div className="ph"><div><div className="pt">Leads</div><div className="pd">{leads.length} contacts</div></div><label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])handleCSVFile(e.target.files[0],"Leads",setLeads)}}/></label></div>
  {leads.length===0?<div className="empty"><div className="em">👤</div><p>Upload a CSV.</p></div>:
  <div className="tw"><table><thead><tr>{Object.keys(leads[0]?.fields||{}).slice(0,6).map(k=><th key={k}>{k}</th>)}<th></th></tr></thead><tbody>{leads.map(l=>(<tr key={l.id}>{Object.values(l.fields||{}).slice(0,6).map((v,i)=><td key={i}>{String(v).slice(0,50)}</td>)}<td><button className="btn btn-d btn-s" onClick={()=>del("Leads",[l.id],setLeads)}><I.Trash/></button></td></tr>))}</tbody></table></div>}</div>)}

  {/* SIGNAL TASK RULES (news/job_posts) */}
  {tab==="rules"&&!loading&&(<div><div className="ph"><div><div className="pt">Signal Rules</div><div className="pd">{signalRules.length} signal rules</div></div><button className="btn btn-s btn-p" onClick={()=>setEditRule({})}><I.Plus/> Add Rule</button></div>
  {signalRules.length===0?<div className="empty"><div className="em">🎯</div><p>No rules yet.</p></div>:
  <div className="tw"><table><thead><tr><th>Name</th><th>Task Type</th><th>Scan Target</th><th>Ease</th><th>Strength</th><th>Keywords</th><th></th></tr></thead><tbody>{signalRules.map(r=>{const f=r.fields||{};return(<tr key={r.id}><td style={{color:"var(--t1)",fontWeight:500}}>{f.Name}</td><td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="both"?"ca":"cg")}>{f["Task Type"]||"news"}</span></td><td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":f["Scan Target"]==="both"?"ca":"cg")}>{f["Scan Target"]||"accounts"}</span></td><td>{f.Ease}</td><td>{f.Strength}</td><td style={{fontSize:10,color:"var(--t3)"}}>{(f.Keywords||"").slice(0,40)}</td><td><div style={{display:"flex",gap:4}}><button className="btn btn-s" onClick={()=>setEditRule({airtableId:r.id,name:f.Name,description:f.Description,taskType:f["Task Type"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease,strength:f.Strength,sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean),jobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean),scoringPrompt:f["Scoring Prompt"]||""})}>Edit</button><button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button></div></td></tr>)})}</tbody></table></div>}</div>)}

  {/* TOP X RULES */}
  {tab==="topx_rules"&&!loading&&(<div><div className="ph"><div><div className="pt">Top X Rules</div><div className="pd">{topXRules.length} scoring rules</div></div><button className="btn btn-s btn-p" onClick={()=>setEditTopX({})}><I.Plus/> New Top X Rule</button></div>
  {topXRules.length===0?<div className="empty"><div className="em">🎯</div><p>Create a Top X rule to rank your leads or accounts.</p></div>:
  <div style={{display:"flex",flexDirection:"column",gap:12}}>{topXRules.map(r=>{const f=r.fields||{};const sf=JSON.parse(f["Scoring Fields"]||"[]");return(
    <div key={r.id} style={{padding:16,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}><div><div style={{fontSize:14,fontWeight:600}}>{f.Name}</div>{f.Description&&<div style={{fontSize:11,color:"var(--t3)",marginTop:2}}>{f.Description}</div>}</div><div style={{display:"flex",gap:6}}><span className={"chip "+(f["Scan Target"]==="accounts"?"cg":"cp")}>{f["Scan Target"]||"leads"}</span><span className="chip ca">TOP {f["Top N"]||10}</span></div></div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>{sf.map((s,i)=>(<div key={i} style={{padding:"4px 10px",background:"var(--hover)",borderRadius:4,fontSize:10}}><span style={{color:"var(--t1)"}}>{s.field}</span><span style={{color:"var(--acc)",marginLeft:6}}>{s.weight}%</span></div>))}</div>
      <div style={{display:"flex",gap:6}}><button className="btn btn-p btn-s" onClick={()=>runTopX(r)} disabled={scanning}>{scanning?"Running…":"▶ Run"}</button><button className="btn btn-s" onClick={()=>setEditTopX({airtableId:r.id,name:f.Name,description:f.Description||"",scanTarget:f["Scan Target"]||"leads",topN:f["Top N"]||10,scoringFields:sf})}>Edit</button><button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button></div>
    </div>)})}</div>}
  </div>)}

  {/* PROMPTS */}
  {tab==="prompts"&&hasSignals&&!loading&&(<div><div className="ph"><div><div className="pt">Scoring Prompts</div><div className="pd">AI scoring criteria (0-100)</div></div><button className="btn btn-ai btn-s" onClick={async()=>{const empty=signalRules.filter(r=>!(r.fields||{})["Scoring Prompt"]);for(const rule of empty){const f=rule.fields||{};try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const d=await res.json();if(d.scoringPrompt){await at("update","Task Rules",{records:[{id:rule.id,fields:{"Scoring Prompt":d.scoringPrompt}}]},bid);setRules(p=>p.map(x=>x.id===rule.id?{...x,fields:{...x.fields,"Scoring Prompt":d.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}}><I.Sparkle/> Generate Missing</button></div>
  <div style={{display:"flex",flexDirection:"column",gap:12}}>{signalRules.map(r=>{const f=r.fields||{};return(<div key={r.id} style={{padding:14,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:8}}><span className={"chip "+(f["Task Type"]==="job_post"?"cb":"cg")}>{f["Task Type"]||"news"}</span><span style={{fontSize:13,fontWeight:600}}>{f.Name}</span></div>
  <button className="btn btn-ai btn-s" onClick={async()=>{try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const d=await res.json();if(d.scoringPrompt){await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":d.scoringPrompt}}]},bid);setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":d.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}><I.Sparkle/> Regen</button></div>
  <textarea className="inp ta" value={f["Scoring Prompt"]||""} placeholder="No prompt — click Regen" style={{minHeight:70,fontSize:11,background:"var(--bg)"}} onChange={e=>{const v=e.target.value;setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":v}}:x))}} onBlur={async e=>{try{await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":e.target.value}}]},bid)}catch{}}}/>
  <div style={{fontSize:9,color:"var(--t3)",marginTop:4}}>{f["Scoring Prompt"]?f["Scoring Prompt"].length+" chars":"⚠️ Empty"}</div></div>)})}</div></div>)}

  {/* THRESHOLD */}
  {tab==="threshold"&&hasSignals&&!loading&&(<div><div className="ph"><div><div className="pt">Scoring Threshold</div><div className="pd">Minimum score for signals to become tasks</div></div></div>
  <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,maxWidth:500}}>
  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}><span style={{fontSize:12,color:"var(--t2)"}}>Threshold</span><input type="range" className="sld" min="0" max="100" value={threshold} onChange={e=>setThreshold(+e.target.value)}/><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,fontWeight:600,color:"var(--acc)",minWidth:30,textAlign:"center"}}>{threshold}</span></div>
  <div style={{display:"flex",gap:16,fontSize:10,color:"var(--t3)"}}><span>0-49: Weak</span><span>50-69: Partial</span><span style={{color:"var(--acc)"}}>70-89: Strong</span><span style={{color:"var(--grn)"}}>90-100: Exact</span></div></div></div>)}

  {/* TASKS */}
  {tab==="tasks"&&!loading&&(<div><div className="ph"><div><div className="pt">Tasks</div><div className="pd">{fTasks.length} tasks</div></div><div style={{display:"flex",gap:8}}>
    <button className="btn btn-s" onClick={exportTasksCSV} disabled={!tasks.length}><I.Download/> Export</button>
    {hasSignals&&<button className="btn btn-p btn-s" onClick={startScan} disabled={scanning||!accounts.length||!signalRules.length}>{scanning?"Scanning "+Math.round(scanProg)+"%":<><I.Play/> Run Scan</>}</button>}
  </div></div>
  {scanning&&<div className="scan-s"><div className="scan-d"/><span style={{fontSize:12,flex:1}}>{scanText}</span><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--acc)"}}>{Math.round(scanProg)}%</span>{hasSignals&&<button className="btn btn-d btn-s" onClick={()=>{scanRef.current=false;setScanning(false)}}>Stop</button>}</div>}
  <div className="fb"><input className="inp" placeholder="Search…" value={filter.q} onChange={e=>setFilter(f=>({...f,q:e.target.value}))} style={{maxWidth:250}}/>
  <select className="inp" style={{width:150}} value={filter.src} onChange={e=>setFilter(f=>({...f,src:e.target.value}))}><option value="all">All Task Types</option><option value="news">News</option><option value="job_post">Job Posts</option><option value="top_x">Top X</option>{[...new Set(tasks.map(t=>(t.fields||{})["Task Type"]).filter(Boolean))].filter(t=>!["news","job_post","top_x"].includes(t)).map(t=><option key={t} value={t}>{t}</option>)}</select>
  <select className="inp" style={{width:150}} value={filter.target} onChange={e=>setFilter(f=>({...f,target:e.target.value}))}><option value="all">All Targets</option><option value="accounts">Accounts</option><option value="leads">Leads</option></select>
  <input type="date" className="inp" style={{width:140}} value={filter.from} onChange={e=>setFilter(f=>({...f,from:e.target.value}))}/>
  <span style={{color:"var(--t3)",fontSize:11}}>to</span>
  <input type="date" className="inp" style={{width:140}} value={filter.to} onChange={e=>setFilter(f=>({...f,to:e.target.value}))}/>
  </div>
  {fTasks.length===0?<div className="empty"><div className="em">📡</div><p>{tasks.length===0?"No tasks yet.":"No matches."}</p></div>:
  <div className="tw"><table><thead><tr><th>Company</th><th>Task Rule</th><th>Score</th><th>Target</th><th>Signal</th><th>Type</th><th>Date</th><th>Link</th><th></th></tr></thead><tbody>{fTasks.map(t=>{const f=t.fields||{};const sc=f.Score||0;return(<tr key={t.id}><td style={{color:"var(--t1)",fontWeight:500}}>{f.Company}</td><td>{f["Task Rule"]}</td><td><div className="sb" style={{width:80}}><div className="st"><div className="sf" style={{width:sc+"%",background:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}/></div><span className="sv" style={{color:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}>{sc}</span></div></td>
  <td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":"cg")}>{f["Scan Target"]||"accounts"}</span></td>
  <td style={{maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.Signal}</td>
  <td><span className={"chip "+(f["Task Type"]==="job_post"?"cb":f["Task Type"]==="top_x"?"cp":"cg")}>{(f["Task Type"]||"news").replace(/_/g," ").toUpperCase()}</span></td>
  <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f.Date}</td>
  <td>{f.URL?<a href={f.URL} target="_blank" rel="noopener" style={{color:"var(--blu)",fontSize:10}}>↗</a>:"—"}</td>
  <td><button className="btn btn-d btn-s" onClick={()=>del("Tasks",[t.id],setTasks)}><I.Trash/></button></td></tr>)})}</tbody></table></div>}</div>)}

  </div></div>

  {editRule!==null&&<RuleEditor rule={editRule} onSave={saveRule} onClose={()=>setEditRule(null)}/>}
  {editTopX!==null&&<TopXEditor rule={editTopX} onSave={saveTopXRule} onClose={()=>setEditTopX(null)} fields={availableFields}/>}

  {/* CSV MODAL */}
  {csvModal&&(<div className="modal-o" onClick={e=>e.target===e.currentTarget&&setCsvModal(null)}><div className="modal" style={{maxWidth:700}}>
  <div className="modal-h"><span style={{fontWeight:600}}>Map CSV → {csvModal.table}</span><button className="btn btn-s" onClick={()=>setCsvModal(null)}>✕</button></div>
  <div className="modal-b">
  <div style={{fontSize:11,color:"var(--t3)",marginBottom:12}}>{csvModal.rows.length} rows · Custom columns auto-created on Airtable</div>
  <div style={{display:"flex",flexDirection:"column",gap:8}}>
  {csvModal.headers.map((h,i)=>{
    const m = csvModal.mappings[h] || "__skip__";
    const std = csvModal.table === "Accounts" ? ["Name","Domain","Industry","Size","LinkedIn URL","Country"] : ["Name","Email","Title","Company","LinkedIn URL","Phone"];
    const isCustom = m !== "__skip__" && !std.includes(m);
    const sample = csvModal.rows.slice(0,3).map(r=>r[i]).filter(Boolean).join(", ");
    return (<div key={h} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",border:"1px solid "+(isCustom?"rgba(155,126,216,.3)":"var(--bdr)"),borderRadius:6,background:m==="__skip__"?"transparent":"var(--card)"}}>
      <div style={{flex:1,minWidth:0}}><div style={{fontSize:12,fontWeight:500,color:m==="__skip__"?"var(--t3)":"var(--t1)"}}>{h}</div><div style={{fontSize:9,color:"var(--t3)",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{sample||"(empty)"}</div></div>
      <span style={{fontSize:10,color:"var(--t3)"}}>→</span>
      <select className="inp" style={{width:180,padding:"5px 8px",fontSize:11}} value={m} onChange={e=>setCsvModal(p=>({...p,mappings:{...p.mappings,[h]:e.target.value}}))}>
        <option value="__skip__">⊘ Skip</option>
        <optgroup label="Standard">{std.map(f=>(<option key={f} value={f}>{f}</option>))}</optgroup>
        <optgroup label="Custom"><option value={h}>✦ Keep as "{h}"</option></optgroup>
      </select>
      {isCustom&&<span style={{fontSize:8,color:"var(--pur)",fontWeight:600}}>CUSTOM</span>}
    </div>);
  })}
  </div></div>
  <div className="modal-f"><button className="btn" onClick={()=>setCsvModal(null)}>Cancel</button><button className="btn btn-p" onClick={uploadMappedCSV} disabled={!Object.values(csvModal.mappings).some(v=>v!=="__skip__")}><I.Upload/> Import {csvModal.rows.length} rows</button></div>
  </div></div>)}
  </>);
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
    if (!name.trim() || !feats.length) return;
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
        <div className="ig"><div className="il">Features</div><div style={{ fontSize: 10, color: "var(--t3)", marginBottom: 8 }}>Pick which features this campaign uses. You can change this later.</div>
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
      {step === "config" && <button className="btn btn-p" onClick={save} disabled={!name.trim() || !feats.length || busy}>{busy ? "Saving…" : <><I.Check /> Create</>}</button>}
    </div>
  </div></div>);
}

// ═══════════════════════════════════════════════════════════════
// SIGNAL RULE EDITOR
// ═══════════════════════════════════════════════════════════════
function RuleEditor({rule,onSave,onClose}){
  const [f,sF]=useState({airtableId:rule.airtableId||null,name:rule.name||"",description:rule.description||"",taskType:rule.taskType||"news",scanTarget:rule.scanTarget||"accounts",ease:rule.ease||"Medium",strength:rule.strength||"Medium",sources:rule.sources||["News"],keywords:rule.keywords||[],jobTitleKeywords:rule.jobTitleKeywords||[],scoringPrompt:rule.scoringPrompt||""});
  const [ki,sKi]=useState("");const [ji,sJi]=useState("");const [aiL,sAiL]=useState(false);
  return(<div className="modal-o" onClick={e=>e.target===e.currentTarget&&onClose()}><div className="modal"><div className="modal-h"><span style={{fontWeight:600}}>{f.airtableId?"Edit Rule":"New Rule"}</span><button className="btn btn-s" onClick={onClose}>✕</button></div>
  <div className="modal-b">
  <div className="ig"><div className="il">Name</div><input className="inp" value={f.name} onChange={e=>sF(p=>({...p,name:e.target.value}))} placeholder="e.g. CMO / CGO opening"/></div>
  <div className="ig"><div className="il">Description</div><textarea className="inp ta" value={f.description} onChange={e=>sF(p=>({...p,description:e.target.value}))}/></div>
  <div className="ig"><div className="il">Scan Target</div><div style={{display:"flex",gap:6}}>{[{v:"accounts",l:"🏢 Accounts"},{v:"leads",l:"👤 Leads"},{v:"both",l:"🏢👤 Both"}].map(o=>(<button key={o.v} className={"btn btn-s"+(f.scanTarget===o.v?" btn-p":"")} onClick={()=>sF(p=>({...p,scanTarget:o.v}))}>{o.l}</button>))}</div></div>
  <div className="ig"><div className="il">Signal Sources</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{SRC_OPTS.map(s=>(<button key={s} className={"stag"+(f.sources.includes(s)?" sel":"")} onClick={()=>sF(p=>({...p,sources:p.sources.includes(s)?p.sources.filter(x=>x!==s):[...p.sources,s]}))}>{s}</button>))}</div></div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
  <div className="ig"><div className="il">Ease</div><div style={{display:"flex",gap:6}}>{["Easy","Medium","Hard"].map(v=>(<button key={v} className={"btn btn-s"+(f.ease===v?" btn-p":"")} onClick={()=>sF(p=>({...p,ease:v}))}>{v}</button>))}</div></div>
  <div className="ig"><div className="il">Strength</div><div style={{display:"flex",gap:6}}>{["Strong","Medium","Weak"].map(v=>(<button key={v} className={"btn btn-s"+(f.strength===v?" btn-p":"")} onClick={()=>sF(p=>({...p,strength:v}))}>{v}</button>))}</div></div></div>
  <div className="ig"><div className="il">Keywords</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>{f.keywords.map((k,i)=>(<span key={i} className="kt" onClick={()=>sF(p=>({...p,keywords:p.keywords.filter(x=>x!==k)}))}>{k} ×</span>))}</div>
  <div style={{display:"flex",gap:6}}><input className="inp" placeholder="Add keyword…" value={ki} onChange={e=>sKi(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&ki.trim()){e.preventDefault();sF(p=>({...p,keywords:[...p.keywords,ki.trim()]}));sKi("")}}} style={{flex:1}}/><button className="btn btn-s" onClick={()=>{if(ki.trim()){sF(p=>({...p,keywords:[...p.keywords,ki.trim()]}));sKi("")}}}><I.Plus/></button></div></div>
  {f.sources.includes("Job Posts")&&<div className="ig"><div className="il">Job Title Keywords</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>{f.jobTitleKeywords.map((k,i)=>(<span key={i} className="kt" style={{background:"var(--blu-d)",color:"var(--blu)"}} onClick={()=>sF(p=>({...p,jobTitleKeywords:p.jobTitleKeywords.filter(x=>x!==k)}))}>{k} ×</span>))}</div>
  <div style={{display:"flex",gap:6}}><input className="inp" placeholder="e.g. CMO, VP Marketing…" value={ji} onChange={e=>sJi(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&ji.trim()){e.preventDefault();sF(p=>({...p,jobTitleKeywords:[...p.jobTitleKeywords,ji.trim()]}));sJi("")}}} style={{flex:1}}/><button className="btn btn-s" onClick={()=>{if(ji.trim()){sF(p=>({...p,jobTitleKeywords:[...p.jobTitleKeywords,ji.trim()]}));sJi("")}}}><I.Plus/></button></div></div>}
  <div style={{padding:14,border:"1px solid rgba(191,163,90,.3)",borderRadius:8,background:"rgba(191,163,90,.05)"}}>
  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span>🎯</span><span style={{fontSize:11,fontWeight:600,color:"var(--acc)"}}>SCORING PROMPT</span></div>
  <textarea className="inp ta" value={f.scoringPrompt} onChange={e=>sF(p=>({...p,scoringPrompt:e.target.value}))} placeholder="How should AI evaluate signals?" style={{minHeight:80,fontSize:11,background:"var(--card)"}}/>
  <button className="btn btn-ai btn-s" style={{marginTop:6}} disabled={aiL||!f.name} onClick={async()=>{sAiL(true);try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.name,taskDescription:f.description,taskKeywords:f.keywords,taskJobTitleKeywords:f.jobTitleKeywords,taskSources:f.sources})});if(res.ok){const d=await res.json();if(d.scoringPrompt)sF(p=>({...p,scoringPrompt:d.scoringPrompt}))}}catch(e){console.error(e)}sAiL(false)}}>{aiL?"…":<><I.Sparkle/> Auto-Generate</>}</button></div>
  </div><div className="modal-f"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={!f.name.trim()} onClick={()=>{const hJP=f.sources.includes("Job Posts");const hN=f.sources.some(s=>["News","New Hires","Social","Exits / Promotions","Custom","Earnings","SEC Filings"].includes(s));onSave({...f,taskType:hJP&&hN?"both":hJP?"job_post":"news"})}}><I.Check/> {f.airtableId?"Save":"Add Rule"}</button></div></div></div>);
}

// ═══════════════════════════════════════════════════════════════
// TOP X RULE EDITOR
// ═══════════════════════════════════════════════════════════════
function TopXEditor({rule,onSave,onClose,fields:avail}){
  const [f,sF]=useState({airtableId:rule.airtableId||null,name:rule.name||"",description:rule.description||"",scanTarget:rule.scanTarget||"leads",topN:rule.topN||10,scoringFields:rule.scoringFields||[]});
  const tbl = f.scanTarget === "accounts" ? "Accounts" : "Leads";
  const flds = (avail[tbl]||[]).filter(fd=>fd.type==="number"||fd.type==="percent"||fd.type==="currency"||fd.type==="rating"||fd.type==="singleLineText");
  const add = (n) => { if (!f.scoringFields.some(s => s.field === n)) sF(p => ({...p, scoringFields: [...p.scoringFields, {field: n, weight: 20}]})); };
  const rem = (n) => sF(p => ({...p, scoringFields: p.scoringFields.filter(s => s.field !== n)}));
  const upd = (n, w) => sF(p => ({...p, scoringFields: p.scoringFields.map(s => s.field === n ? {...s, weight: Math.max(0, Math.min(100, w))} : s)}));
  const tw = f.scoringFields.reduce((s, x) => s + x.weight, 0);
  return(<div className="modal-o" onClick={e=>e.target===e.currentTarget&&onClose()}><div className="modal" style={{maxWidth:620}}><div className="modal-h"><span style={{fontWeight:600}}>{f.airtableId?"Edit":"New"} Top X Rule</span><button className="btn btn-s" onClick={onClose}>✕</button></div>
  <div className="modal-b">
    <div className="ig"><div className="il">Rule Name</div><input className="inp" value={f.name} onChange={e=>sF(p=>({...p,name:e.target.value}))} placeholder="e.g. Top 50 most engaged leads"/></div>
    <div className="ig"><div className="il">Description</div><textarea className="inp ta" value={f.description} onChange={e=>sF(p=>({...p,description:e.target.value}))} style={{minHeight:40}}/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
      <div className="ig"><div className="il">Scan Target</div><div style={{display:"flex",gap:6}}>{[{v:"leads",l:"👤 Leads"},{v:"accounts",l:"🏢 Accounts"}].map(o=>(<button key={o.v} className={"btn btn-s"+(f.scanTarget===o.v?" btn-p":"")} onClick={()=>sF(p=>({...p,scanTarget:o.v,scoringFields:[]}))}>{o.l}</button>))}</div></div>
      <div className="ig"><div className="il">Top N</div><input type="number" className="inp" value={f.topN} onChange={e=>sF(p=>({...p,topN:parseInt(e.target.value)||10}))} min={1} max={500} style={{width:100}}/></div>
    </div>
    <div className="ig"><div className="il">Scoring Fields & Weights</div>
      {f.scoringFields.length>0&&<div style={{marginBottom:10}}>{f.scoringFields.map(sf=>(<div key={sf.field} className="wt-row"><span className="wt-name">{sf.field}</span><input type="range" className="sld" style={{width:120}} min="0" max="100" value={sf.weight} onChange={e=>upd(sf.field,parseInt(e.target.value))}/><span className="wt-pct">{sf.weight}%</span><button style={{background:"none",border:"none",color:"var(--red)",cursor:"pointer",padding:"0 4px"}} onClick={()=>rem(sf.field)}>×</button></div>))}<div style={{fontSize:10,color:tw===100?"var(--grn)":"var(--amb)"}}>Total: {tw}%{tw!==100?" (normalized)":""}</div></div>}
      <select className="inp" onChange={e=>{if(e.target.value)add(e.target.value);e.target.value=""}} defaultValue=""><option value="" disabled>+ Add field…</option>{flds.filter(fd=>!f.scoringFields.some(s=>s.field===fd.name)).map(fd=>(<option key={fd.name} value={fd.name}>{fd.name} ({fd.type})</option>))}</select>
      {flds.length===0&&<div style={{marginTop:8,padding:10,background:"var(--hover)",borderRadius:6,fontSize:10,color:"var(--amb)"}}>⚠️ No fields in {tbl}. Upload CSV with numeric data — fields auto-created.</div>}
    </div>
    {f.scoringFields.length>0&&<div style={{padding:12,border:"1px solid rgba(155,126,216,.3)",borderRadius:8,background:"rgba(155,126,216,.05)",fontSize:11}}><span style={{fontWeight:600,color:"var(--pur)"}}>🎯 Preview:</span> Read all {tbl.toLowerCase()}, score by {f.scoringFields.map(s=>s.field+" ("+s.weight+"%)").join(", ")}, return top {f.topN}.</div>}
  </div>
  <div className="modal-f"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={!f.name.trim()||!f.scoringFields.length} onClick={()=>onSave(f)}><I.Check/> {f.airtableId?"Save":"Create"}</button></div>
  </div></div>);
}
