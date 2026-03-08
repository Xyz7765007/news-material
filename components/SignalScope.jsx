"use client";
import { useState, useEffect, useRef, useCallback } from "react";

// Airtable helper
async function at(action, table, data = {}) {
  const res = await fetch("/api/airtable", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, table, ...data }) });
  if (!res.ok) throw new Error("Airtable " + action + " failed: " + res.status);
  return res.json();
}
const uid = () => Math.random().toString(36).slice(2, 10);
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

const CAMPAIGNS = [
  { id:"material", name:"Material Signals Campaign", emoji:"📡", desc:"Track news, job posts, and market intelligence.", badge:"Active", active:true },
  { id:"veloka", name:"Veloka", emoji:"🎯", desc:"Outbound prospecting signals for Side Kick.", badge:"Coming Soon", active:false },
  { id:"digests", name:"Material Automated Digests", emoji:"📨", desc:"Automated weekly signal digests.", badge:"Coming Soon", active:false },
  { id:"add", name:"Add More", emoji:"➕", desc:"Create a custom campaign with personalized features.", badge:"Custom", active:false },
];

const I = {
  Plus:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Trash:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>,
  Upload:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  Play:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  Check:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  Back:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>,
  Sparkle:()=><svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8z"/></svg>,
  Search:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  Filter:()=><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>,
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');
:root{--bg:#0a0a0c;--card:#111114;--hover:#1a1a1e;--input:#141418;--bdr:#222228;--bdr2:#333338;--t1:#e8e6e0;--t2:#9a9890;--t3:#5c5a55;--acc:#bfa35a;--acc-d:rgba(191,163,90,0.12);--grn:#5da87a;--grn-d:rgba(93,168,122,0.12);--blu:#5b8fd4;--blu-d:rgba(91,143,212,0.12);--red:#c45c5c;--red-d:rgba(196,92,92,0.12);--amb:#c9a84c}
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
.cg{background:var(--grn-d);color:var(--grn)}.cb{background:var(--blu-d);color:var(--blu)}.ca{background:var(--acc-d);color:var(--acc)}.cr{background:var(--red-d);color:var(--red)}.cp{background:rgba(155,126,216,0.12);color:#9b7ed8}
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
`;

export default function SignalScope() {
  const [campaign, setCampaign] = useState(null);
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
  const [filter, setFilter] = useState({src:"all",target:"all",q:"",from:"",to:""});

  const setupDone = useRef(false);
  useEffect(() => { if (campaign) loadAll(); }, [campaign]);

  const loadAll = async () => {
    setLoading(true);
    try {
      // Auto-setup schema on first load
      if (!setupDone.current) {
        setupDone.current = true;
        try {
          const setup = await at("setup", "", {});
          if (setup.created?.length > 0) console.log("[Airtable] Created fields:", setup.created);
          if (setup.errors?.length > 0) console.warn("[Airtable] Setup errors:", setup.errors);
        } catch (e) { console.warn("Schema setup skipped:", e.message); }
      }
      const [a,l,r,t] = await Promise.all([at("list","Accounts"),at("list","Leads"),at("list","Task Rules"),at("list","Tasks",{params:{sort:[{field:"Created",direction:"desc"}]}})]);
      setAccounts(a.records||[]);setLeads(l.records||[]);setRules(r.records||[]);setTasks(t.records||[]);
    } catch(e){console.error("Load failed:",e)}
    setLoading(false);
  };

  const del = async (table, ids, setter) => { try{await at("delete",table,{recordIds:ids});setter(p=>p.filter(r=>!ids.includes(r.id)))} catch(e){console.error(e)} };

  const uploadCSV = async (file, table, setter) => {
    const text = await file.text();
    const lines = text.split("\n").filter(Boolean);
    if (lines.length < 2) return;
    // Parse CSV properly — handles commas inside quoted fields
    const parseCSVLine = (line) => {
      const result = []; let cur = ""; let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQuotes && line[i+1] === '"') { cur += '"'; i++; } else { inQuotes = !inQuotes; } }
        else if (ch === ',' && !inQuotes) { result.push(cur.trim()); cur = ""; }
        else { cur += ch; }
      }
      result.push(cur.trim());
      return result;
    };
    const hdrs = parseCSVLine(lines[0]);
    const recs = lines.slice(1).map(line => {
      const cols = parseCSVLine(line);
      const o = {};
      hdrs.forEach((h, i) => { if (cols[i]) o[h] = cols[i]; });
      return o;
    }).filter(r => Object.keys(r).length > 0);
    if(!recs.length)return;
    try{setLoading(true);const res=await at("create",table,{records:recs});setter(p=>[...p,...(res.records||[])]);setLoading(false)}catch(e){console.error(e);setLoading(false)}
  };

  const saveRule = async (rule) => {
    const fields={Name:rule.name,Description:rule.description||"","Signal Source":rule.signalSource||"news","Scan Target":rule.scanTarget||"accounts",Ease:rule.ease||"Medium",Strength:rule.strength||"Medium",Sources:(rule.sources||[]).join(", "),Keywords:(rule.keywords||[]).join(", "),"Job Title Keywords":(rule.jobTitleKeywords||[]).join(", "),"Scoring Prompt":rule.scoringPrompt||""};
    try{
      if(rule.airtableId){await at("update","Task Rules",{records:[{id:rule.airtableId,fields}]});setRules(p=>p.map(r=>r.id===rule.airtableId?{...r,fields}:r))}
      else{const res=await at("create","Task Rules",{records:[fields]});setRules(p=>[...p,...(res.records||[])])}
    }catch(e){console.error(e)}
    setEditRule(null);
  };

  const startScan = useCallback(async()=>{
    if(scanning||!accounts.length||!rules.length)return;
    setScanning(true);scanRef.current=true;setScanProg(0);
    const taskDefs=rules.map(r=>{const f=r.fields||{};const kws=(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean);const jtk=(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean);let sp=f["Scoring Prompt"]||"";if(!sp){const ak=[...kws,...jtk].slice(0,5).join(", ");sp="Rate this signal for \""+f.Name+"\". Score 90-100 for exact matches ("+ak+"). 70-89 strong. 50-69 partial. Below 50 unrelated."}return{id:r.id,name:f.Name||"",description:f.Description||"",signalSource:f["Signal Source"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease||"Medium",strength:f.Strength||"Medium",sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:kws,jobTitleKeywords:jtk,scoringPrompt:sp}});
    const companies=accounts.map(a=>{const f=a.fields||{};const li=f["LinkedIn URL"]||f.LinkedIn||f.linkedin||"";return{name:f.Name||f.Company||f["Company Name"]||"",domain:f.Domain||f.Website||"",linkedinSlug:extractLinkedInSlug(li),linkedinCompanyId:extractLinkedInId(li)}}).filter(c=>c.name);
    const newsTasks=taskDefs.filter(t=>t.signalSource==="news"||t.signalSource==="both");
    const jobTasks=taskDefs.filter(t=>t.signalSource==="job_post"||t.signalSource==="both");
    const total=companies.length;
    // PHASE 1: NEWS
    if(newsTasks.length>0){for(let i=0;i<companies.length;i++){if(!scanRef.current)break;setScanText("📰 "+companies[i].name+" — News");setScanProg(Math.round(i/total*50));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({company:companies[i],taskDefs:newsTasks,mode:"news"})});if(res.ok){const data=await res.json();await processSignals(data.news||[],companies[i],taskDefs)}}catch(e){console.error(e)}await sleep(100)}}
    // PHASE 2: RESOLVE + JOBS BATCH
    if(scanRef.current&&jobTasks.length>0){const need=companies.filter(c=>c.linkedinSlug&&!c.linkedinCompanyId);if(need.length>0){setScanText("🔗 Resolving LinkedIn IDs...");try{const res=await fetch("/api/resolve-linkedin",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slugs:need.map(c=>c.linkedinSlug)})});if(res.ok){const{ids}=await res.json();for(const c of companies){if(c.linkedinSlug&&!c.linkedinCompanyId&&ids[c.linkedinSlug.toLowerCase()])c.linkedinCompanyId=ids[c.linkedinSlug.toLowerCase()]}}}catch(e){console.error(e)}}
    const BS=5;for(let b=0;b<companies.length;b+=BS){if(!scanRef.current)break;const batch=companies.slice(b,b+BS);setScanText("📋 Jobs — Batch "+(Math.floor(b/BS)+1));setScanProg(50+Math.round(b/companies.length*50));try{const res=await fetch("/api/scan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({companies:batch,taskDefs:jobTasks,mode:"jobs-batch"})});if(res.ok){const data=await res.json();for(const result of(data.results||[])){const co=batch.find(c=>c.name===result.company);if(co)await processSignals(result.signals||[],co,taskDefs)}}}catch(e){console.error(e)}await sleep(200)}}
    setScanProg(100);setScanText("Scan complete");setScanning(false);scanRef.current=false;
  },[accounts,rules,threshold,scanning]);

  const processSignals = async(signals, company, taskDefs)=>{
    const newTasks=[];
    for(const sig of signals){const scores=sig.relevanceScores||{};for(const tid of(sig.matchedTaskIds||[])){const td=taskDefs.find(t=>t.id===tid);if(!td)continue;const score=scores[tid]||Math.round((sig.confidence||0.7)*100)||50;if(score<threshold)continue;
    newTasks.push({Company:company.name,"Task Rule":td.name,Score:score,"Scan Target":td.scanTarget||"accounts",Signal:sig.headline||"",Source:sig.source||"",URL:sig.url||"","Signal Type":sig.signalType||"news",Date:sig.date?sig.date.slice(0,10):new Date().toISOString().slice(0,10),Created:new Date().toISOString()})}}
    if(newTasks.length>0){try{const res=await at("create","Tasks",{records:newTasks});setTasks(p=>[...(res.records||[]),...p])}catch(e){console.error(e)}}
  };

  // LANDING
  if(!campaign){return(<><style>{CSS}</style><div className="landing"><h1>SignalScope</h1><div className="sub">B2B Signal Intelligence Platform</div><div className="cgrid">{CAMPAIGNS.map(c=>(<div key={c.id} className={"ccard"+(c.active?"":" off")} onClick={()=>c.active&&setCampaign(c.id)}><div className="em">{c.emoji}</div><div className="nm">{c.name}</div><div className="ds">{c.desc}</div><div className="bdg" style={{background:c.active?"var(--grn-d)":"var(--hover)",color:c.active?"var(--grn)":"var(--t3)"}}>{c.badge}</div></div>))}</div></div></>)}

  // DASHBOARD
  const camp=CAMPAIGNS.find(c=>c.id===campaign);
  const navs=[{id:"accounts",label:"Accounts",count:accounts.length},{id:"leads",label:"Leads",count:leads.length},{id:"rules",label:"Task Rules",count:rules.length},{id:"prompts",label:"Prompts",count:rules.length},{id:"threshold",label:"Scoring",count:null},{id:"tasks",label:"Tasks",count:tasks.length}];
  const fTasks=tasks.filter(t=>{const f=t.fields||{};if(filter.src!=="all"&&f["Signal Type"]!==filter.src)return false;if(filter.target!=="all"&&f["Scan Target"]!==filter.target)return false;if(filter.q&&!(f.Company||"").toLowerCase().includes(filter.q.toLowerCase())&&!(f["Task Rule"]||"").toLowerCase().includes(filter.q.toLowerCase()))return false;if(filter.from&&(f.Date||"")<filter.from)return false;if(filter.to&&(f.Date||"")>filter.to)return false;return true});

  return(<><style>{CSS}</style><div className="dash">
  <div className="side"><div className="side-hd"><div className="side-brand">SignalScope</div><div className="side-camp">{camp?.name}</div><div className="side-back" onClick={()=>setCampaign(null)}><I.Back/> All Campaigns</div></div>
  <div className="side-nav">{navs.map(n=>(<div key={n.id} className={"nav-i"+(tab===n.id?" on":"")} onClick={()=>setTab(n.id)}><span>{n.label}</span>{n.count!==null&&<span className="cnt">{n.count}</span>}</div>))}</div></div>

  <div className="main">{loading&&<div style={{textAlign:"center",padding:40,color:"var(--t3)"}}>Loading from Airtable...</div>}

  {/* ACCOUNTS */}
  {tab==="accounts"&&!loading&&(<div><div className="ph"><div><div className="pt">Accounts</div><div className="pd">{accounts.length} target companies</div></div><label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])uploadCSV(e.target.files[0],"Accounts",setAccounts)}}/></label></div>
  {accounts.length===0?<div className="empty"><div className="em">🏢</div><p>No accounts yet. Upload a CSV to get started.</p></div>:
  <div className="tw"><table><thead><tr>{Object.keys(accounts[0]?.fields||{}).slice(0,6).map(k=><th key={k}>{k}</th>)}<th>Actions</th></tr></thead><tbody>{accounts.map(a=>(<tr key={a.id}>{Object.values(a.fields||{}).slice(0,6).map((v,i)=><td key={i}>{String(v).slice(0,50)}</td>)}<td><button className="btn btn-d btn-s" onClick={()=>del("Accounts",[a.id],setAccounts)}><I.Trash/></button></td></tr>))}</tbody></table></div>}</div>)}

  {/* LEADS */}
  {tab==="leads"&&!loading&&(<div><div className="ph"><div><div className="pt">Leads</div><div className="pd">{leads.length} contacts</div></div><label className="btn btn-s" style={{cursor:"pointer"}}><I.Upload/> Upload CSV<input type="file" accept=".csv" hidden onChange={e=>{if(e.target.files[0])uploadCSV(e.target.files[0],"Leads",setLeads)}}/></label></div>
  {leads.length===0?<div className="empty"><div className="em">👤</div><p>No leads yet. Upload a CSV.</p></div>:
  <div className="tw"><table><thead><tr>{Object.keys(leads[0]?.fields||{}).slice(0,6).map(k=><th key={k}>{k}</th>)}<th>Actions</th></tr></thead><tbody>{leads.map(l=>(<tr key={l.id}>{Object.values(l.fields||{}).slice(0,6).map((v,i)=><td key={i}>{String(v).slice(0,50)}</td>)}<td><button className="btn btn-d btn-s" onClick={()=>del("Leads",[l.id],setLeads)}><I.Trash/></button></td></tr>))}</tbody></table></div>}</div>)}

  {/* TASK RULES */}
  {tab==="rules"&&!loading&&(<div><div className="ph"><div><div className="pt">Task Rules</div><div className="pd">{rules.length} signal detection rules</div></div><div style={{display:"flex",gap:8}}><button className="btn btn-s btn-p" onClick={()=>setEditRule({})}><I.Plus/> Add Rule</button></div></div>
  {rules.length===0?<div className="empty"><div className="em">🎯</div><p>No task rules yet.</p></div>:
  <div className="tw"><table><thead><tr><th>Name</th><th>Source</th><th>Scan Target</th><th>Ease</th><th>Strength</th><th>Keywords</th><th>Actions</th></tr></thead><tbody>{rules.map(r=>{const f=r.fields||{};return(<tr key={r.id}><td style={{color:"var(--t1)",fontWeight:500}}>{f.Name}</td><td><span className={"chip "+(f["Signal Source"]==="job_post"?"cb":f["Signal Source"]==="both"?"ca":"cg")}>{f["Signal Source"]||"news"}</span></td><td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":f["Scan Target"]==="both"?"ca":"cg")}>{f["Scan Target"]||"accounts"}</span></td><td>{f.Ease}</td><td>{f.Strength}</td><td style={{fontSize:10,color:"var(--t3)"}}>{(f.Keywords||"").slice(0,40)}...</td><td><div style={{display:"flex",gap:4}}><button className="btn btn-s" onClick={()=>setEditRule({airtableId:r.id,name:f.Name,description:f.Description,signalSource:f["Signal Source"]||"news",scanTarget:f["Scan Target"]||"accounts",ease:f.Ease,strength:f.Strength,sources:(f.Sources||"").split(",").map(s=>s.trim()).filter(Boolean),keywords:(f.Keywords||"").split(",").map(k=>k.trim()).filter(Boolean),jobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()).filter(Boolean),scoringPrompt:f["Scoring Prompt"]||""})}>Edit</button><button className="btn btn-d btn-s" onClick={()=>del("Task Rules",[r.id],setRules)}><I.Trash/></button></div></td></tr>)})}</tbody></table></div>}</div>)}

  {/* PROMPTS */}
  {tab==="prompts"&&!loading&&(<div><div className="ph"><div><div className="pt">Scoring Prompts</div><div className="pd">AI uses these to score signal relevance (0-100)</div></div><button className="btn btn-ai btn-s" onClick={async()=>{const empty=rules.filter(r=>!(r.fields||{})["Scoring Prompt"]);for(const rule of empty){const f=rule.fields||{};try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const data=await res.json();if(data.scoringPrompt){await at("update","Task Rules",{records:[{id:rule.id,fields:{"Scoring Prompt":data.scoringPrompt}}]});setRules(p=>p.map(x=>x.id===rule.id?{...x,fields:{...x.fields,"Scoring Prompt":data.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}}><I.Sparkle/> Generate All Missing</button></div>
  <div style={{display:"flex",flexDirection:"column",gap:12}}>{rules.map(r=>{const f=r.fields||{};return(<div key={r.id} style={{padding:14,border:"1px solid var(--bdr)",borderRadius:8,background:"var(--card)"}}>
  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}><div style={{display:"flex",alignItems:"center",gap:8}}><span className={"chip "+(f["Signal Source"]==="job_post"?"cb":"cg")}>{f["Signal Source"]||"news"}</span><span className={"chip "+(f["Scan Target"]==="leads"?"cp":f["Scan Target"]==="both"?"ca":"cg")}>{f["Scan Target"]||"accounts"}</span><span style={{fontSize:13,fontWeight:600}}>{f.Name}</span></div>
  <button className="btn btn-ai btn-s" onClick={async()=>{try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.Name,taskDescription:f.Description,taskKeywords:(f.Keywords||"").split(",").map(k=>k.trim()),taskJobTitleKeywords:(f["Job Title Keywords"]||"").split(",").map(k=>k.trim()),taskSources:(f.Sources||"").split(",").map(s=>s.trim())})});if(res.ok){const data=await res.json();if(data.scoringPrompt){await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":data.scoringPrompt}}]});setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":data.scoringPrompt}}:x))}}}catch(e){console.error(e)}}}><I.Sparkle/> Regenerate</button></div>
  <textarea className="inp ta" value={f["Scoring Prompt"]||""} placeholder="No prompt — click Regenerate" style={{minHeight:70,fontSize:11,background:"var(--bg)"}} onChange={e=>{const v=e.target.value;setRules(p=>p.map(x=>x.id===r.id?{...x,fields:{...x.fields,"Scoring Prompt":v}}:x))}} onBlur={async e=>{try{await at("update","Task Rules",{records:[{id:r.id,fields:{"Scoring Prompt":e.target.value}}]})}catch(e2){console.error(e2)}}}/>
  <div style={{fontSize:9,color:"var(--t3)",marginTop:4}}>{f["Scoring Prompt"]?f["Scoring Prompt"].length+" chars":"⚠️ Empty"}</div></div>)})}</div></div>)}

  {/* THRESHOLD */}
  {tab==="threshold"&&!loading&&(<div><div className="ph"><div><div className="pt">Scoring Threshold</div><div className="pd">Minimum AI relevance score for a signal to become a task</div></div></div>
  <div style={{padding:24,background:"var(--card)",border:"1px solid var(--bdr)",borderRadius:12,maxWidth:500}}>
  <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}><span style={{fontSize:12,color:"var(--t2)"}}>Threshold</span><input type="range" className="sld" min="0" max="100" value={threshold} onChange={e=>setThreshold(+e.target.value)}/><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:14,fontWeight:600,color:"var(--acc)",minWidth:30,textAlign:"center"}}>{threshold}</span></div>
  <div style={{display:"flex",gap:16,fontSize:10,color:"var(--t3)"}}><span>0-49: Weak</span><span>50-69: Partial</span><span style={{color:"var(--acc)"}}>70-89: Strong</span><span style={{color:"var(--grn)"}}>90-100: Exact</span></div></div></div>)}

  {/* TASKS */}
  {tab==="tasks"&&!loading&&(<div><div className="ph"><div><div className="pt">Tasks</div><div className="pd">{fTasks.length} signal tasks</div></div><button className="btn btn-p btn-s" onClick={startScan} disabled={scanning||!accounts.length||!rules.length}>{scanning?"Scanning... "+Math.round(scanProg)+"%":<><I.Play/> Run Scan</>}</button></div>
  {scanning&&<div className="scan-s"><div className="scan-d"/><span style={{fontSize:12,flex:1}}>{scanText}</span><span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:11,color:"var(--acc)"}}>{Math.round(scanProg)}%</span><button className="btn btn-d btn-s" onClick={()=>{scanRef.current=false;setScanning(false)}}>Stop</button></div>}
  <div className="fb"><input className="inp" placeholder="Search..." value={filter.q} onChange={e=>setFilter(f=>({...f,q:e.target.value}))} style={{maxWidth:250}}/>
  <select className="inp" style={{width:140}} value={filter.src} onChange={e=>setFilter(f=>({...f,src:e.target.value}))}><option value="all">All Sources</option><option value="news">News</option><option value="job_post">Job Posts</option></select>
  <select className="inp" style={{width:150}} value={filter.target} onChange={e=>setFilter(f=>({...f,target:e.target.value}))}><option value="all">All Targets</option><option value="accounts">Accounts</option><option value="leads">Leads</option><option value="both">Both</option></select>
  <input type="date" className="inp" style={{width:140}} value={filter.from} onChange={e=>setFilter(f=>({...f,from:e.target.value}))}/>
  <span style={{color:"var(--t3)",fontSize:11}}>to</span>
  <input type="date" className="inp" style={{width:140}} value={filter.to} onChange={e=>setFilter(f=>({...f,to:e.target.value}))}/>
  </div>
  {fTasks.length===0?<div className="empty"><div className="em">📡</div><p>{tasks.length===0?"No tasks yet. Upload accounts, define rules, and run a scan.":"No tasks match your filters."}</p></div>:
  <div className="tw"><table><thead><tr><th>Company</th><th>Task Rule</th><th>Score</th><th>Scan Target</th><th>Signal</th><th>Source</th><th>Date</th><th>Link</th><th></th></tr></thead><tbody>{fTasks.map(t=>{const f=t.fields||{};const sc=f.Score||0;return(<tr key={t.id}><td style={{color:"var(--t1)",fontWeight:500}}>{f.Company}</td><td>{f["Task Rule"]}</td><td><div className="sb" style={{width:80}}><div className="st"><div className="sf" style={{width:sc+"%",background:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}/></div><span className="sv" style={{color:sc>=80?"var(--grn)":sc>=60?"var(--amb)":"var(--red)"}}>{sc}</span></div></td>
  <td><span className={"chip "+(f["Scan Target"]==="leads"?"cp":f["Scan Target"]==="both"?"ca":"cg")}>{f["Scan Target"]||"accounts"}</span></td>
  <td style={{maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{f.Signal}</td>
  <td><span className={"chip "+(f["Signal Type"]==="job_post"?"cb":"cg")}>{f["Signal Type"]==="job_post"?"JOB":"NEWS"}</span></td>
  <td style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10}}>{f.Date}</td>
  <td>{f.URL?<a href={f.URL} target="_blank" rel="noopener" style={{color:"var(--blu)",fontSize:10}}>View ↗</a>:"—"}</td>
  <td><button className="btn btn-d btn-s" onClick={()=>del("Tasks",[t.id],setTasks)}><I.Trash/></button></td></tr>)})}</tbody></table></div>}</div>)}

  </div></div>

  {editRule!==null&&<RuleEditor rule={editRule} onSave={saveRule} onClose={()=>setEditRule(null)}/>}
  </>);
}

function RuleEditor({rule,onSave,onClose}){
  const [f,sF]=useState({airtableId:rule.airtableId||null,name:rule.name||"",description:rule.description||"",signalSource:rule.signalSource||"news",scanTarget:rule.scanTarget||"accounts",ease:rule.ease||"Medium",strength:rule.strength||"Medium",sources:rule.sources||["News"],keywords:rule.keywords||[],jobTitleKeywords:rule.jobTitleKeywords||[],scoringPrompt:rule.scoringPrompt||""});
  const [ki,sKi]=useState("");const [ji,sJi]=useState("");const [aiL,sAiL]=useState(false);
  return(<div className="modal-o" onClick={e=>e.target===e.currentTarget&&onClose()}><div className="modal"><div className="modal-h"><span style={{fontWeight:600}}>{f.airtableId?"Edit Rule":"New Rule"}</span><button className="btn btn-s" onClick={onClose}>✕</button></div>
  <div className="modal-b">
  <div className="ig"><div className="il">Name</div><input className="inp" value={f.name} onChange={e=>sF(p=>({...p,name:e.target.value}))} placeholder="e.g. CMO / CGO opening"/></div>
  <div className="ig"><div className="il">Description</div><textarea className="inp ta" value={f.description} onChange={e=>sF(p=>({...p,description:e.target.value}))}/></div>
  <div className="ig"><div className="il">Scan Target</div><div style={{display:"flex",gap:6}}>{[{v:"accounts",l:"🏢 Accounts"},{v:"leads",l:"👤 Leads"},{v:"both",l:"🏢👤 Both"}].map(o=>(<button key={o.v} className={"btn btn-s"+(f.scanTarget===o.v?" btn-p":"")} onClick={()=>sF(p=>({...p,scanTarget:o.v}))}>{o.l}</button>))}</div><div style={{fontSize:10,color:"var(--t3)",marginTop:4}}>{f.scanTarget==="accounts"?"Scans company-level signals (news, job posts)":f.scanTarget==="leads"?"Scans person-level signals (role changes, promotions)":"Scans both company and person signals"}</div></div>
  <div className="ig"><div className="il">Signal Sources</div><div style={{display:"flex",gap:6,flexWrap:"wrap"}}>{SRC_OPTS.map(s=>(<button key={s} className={"stag"+(f.sources.includes(s)?" sel":"")} onClick={()=>sF(p=>({...p,sources:p.sources.includes(s)?p.sources.filter(x=>x!==s):[...p.sources,s]}))}>{s}</button>))}</div></div>
  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
  <div className="ig"><div className="il">Ease</div><div style={{display:"flex",gap:6}}>{["Easy","Medium","Hard"].map(v=>(<button key={v} className={"btn btn-s"+(f.ease===v?" btn-p":"")} onClick={()=>sF(p=>({...p,ease:v}))}>{v}</button>))}</div></div>
  <div className="ig"><div className="il">Strength</div><div style={{display:"flex",gap:6}}>{["Strong","Medium","Weak"].map(v=>(<button key={v} className={"btn btn-s"+(f.strength===v?" btn-p":"")} onClick={()=>sF(p=>({...p,strength:v}))}>{v}</button>))}</div></div></div>
  <div className="ig"><div className="il">Keywords</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>{f.keywords.map((k,i)=>(<span key={i} className="kt" onClick={()=>sF(p=>({...p,keywords:p.keywords.filter(x=>x!==k)}))}>{k} ×</span>))}</div>
  <div style={{display:"flex",gap:6}}><input className="inp" placeholder="Add keyword..." value={ki} onChange={e=>sKi(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&ki.trim()){e.preventDefault();sF(p=>({...p,keywords:[...p.keywords,ki.trim()]}));sKi("")}}} style={{flex:1}}/><button className="btn btn-s" onClick={()=>{if(ki.trim()){sF(p=>({...p,keywords:[...p.keywords,ki.trim()]}));sKi("")}}}><I.Plus/></button></div></div>
  {f.sources.includes("Job Posts")&&<div className="ig"><div className="il">Job Title Keywords</div><div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:6}}>{f.jobTitleKeywords.map((k,i)=>(<span key={i} className="kt" style={{background:"var(--blu-d)",color:"var(--blu)"}} onClick={()=>sF(p=>({...p,jobTitleKeywords:p.jobTitleKeywords.filter(x=>x!==k)}))}>{k} ×</span>))}</div>
  <div style={{display:"flex",gap:6}}><input className="inp" placeholder="e.g. CMO, VP Marketing..." value={ji} onChange={e=>sJi(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&ji.trim()){e.preventDefault();sF(p=>({...p,jobTitleKeywords:[...p.jobTitleKeywords,ji.trim()]}));sJi("")}}} style={{flex:1}}/><button className="btn btn-s" onClick={()=>{if(ji.trim()){sF(p=>({...p,jobTitleKeywords:[...p.jobTitleKeywords,ji.trim()]}));sJi("")}}}><I.Plus/></button></div></div>}
  <div style={{padding:14,border:"1px solid rgba(191,163,90,.3)",borderRadius:8,background:"rgba(191,163,90,.05)"}}>
  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}><span>🎯</span><span style={{fontSize:11,fontWeight:600,color:"var(--acc)"}}>SCORING PROMPT</span></div>
  <textarea className="inp ta" value={f.scoringPrompt} onChange={e=>sF(p=>({...p,scoringPrompt:e.target.value}))} placeholder="How should AI evaluate signals? Auto-generated if empty." style={{minHeight:80,fontSize:11,background:"var(--card)"}}/>
  <button className="btn btn-ai btn-s" style={{marginTop:6}} disabled={aiL||!f.name} onClick={async()=>{sAiL(true);try{const res=await fetch("/api/classify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"generate_scoring_prompt",taskName:f.name,taskDescription:f.description,taskKeywords:f.keywords,taskJobTitleKeywords:f.jobTitleKeywords,taskSources:f.sources})});if(res.ok){const data=await res.json();if(data.scoringPrompt)sF(p=>({...p,scoringPrompt:data.scoringPrompt}))}}catch(e){console.error(e)}sAiL(false)}}>{aiL?"Generating...":<><I.Sparkle/> Auto-Generate</>}</button></div>
  </div><div className="modal-f"><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-p" disabled={!f.name.trim()} onClick={()=>{const hJP=f.sources.includes("Job Posts");const hN=f.sources.some(s=>["News","New Hires","Social","Exits / Promotions","Custom","Earnings","SEC Filings"].includes(s));onSave({...f,signalSource:hJP&&hN?"both":hJP?"job_post":"news",scanTarget:f.scanTarget||"accounts"})}}><I.Check/> {f.airtableId?"Save":"Add Rule"}</button></div></div></div>);
}
