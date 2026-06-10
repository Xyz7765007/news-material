#!/usr/bin/env python3
"""Wednesday scan orchestrator — Material news + job posts + LinkedIn posts.

Runs from GitHub Actions (.github/workflows/wednesday-scan.yml, Wed 06:00 UTC).
Mirrors the browser runScan -> bufferSignals path server-side so scans no longer
depend on someone opening the UI. History: the "Wednesday scan" was documented
as automation but never existed — task volume weeks were exactly the weeks
someone ran it manually (123 tasks -> 5 -> 1 -> 0, audited 2026-06-10).

Flow:
  0. AI health probe (diagnose-ai) — abort LOUDLY on quota outage instead of
     burning 3h producing zero tasks (2026-06-10 incident).
  1. News: every account through /api/scan mode=news (sequential — keeps the
     Google decode pacing happy). Matched -> Tasks (deduped); retain band ->
     Signal Archive (status=unqualified).
  2. Jobs: accounts in batches of 5 through mode=jobs-batch. Apify failures
     are logged and skipped (the account can be over its monthly cap).
  3. LinkedIn posts: start the resumable scan, then poll ?mode=resume every
     5 min until complete (cron-job.org, if configured, also drives this).

Env: SIGNALSCOPE_URL (default prod), CRON_SECRET (LinkedIn resume + AI probe),
     MATERIAL_BASE_ID / MATERIAL_CAMPAIGN_ID (default Material).
Exit codes: 0 ok, 1 hard failure (AI outage / >30% account scan errors).
"""
import json, os, sys, time, urllib.request

BASE_URL = os.environ.get("SIGNALSCOPE_URL", "https://news-material-two.vercel.app")
CRON_SECRET = os.environ.get("CRON_SECRET", "")
BASE = os.environ.get("MATERIAL_BASE_ID", "appIaff6DEzgkpVJb")
CAMP = os.environ.get("MATERIAL_CAMPAIGN_ID", "recnRZO0HTX8Pvksy")
THRESHOLD = int(os.environ.get("SCAN_THRESHOLD", "70"))
API = f"{BASE_URL}/api/airtable"
SCAN = f"{BASE_URL}/api/scan"


def post(url, payload, timeout=290):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def get(url, timeout=60):
    return json.loads(urllib.request.urlopen(url, timeout=timeout).read())


def split(s):
    return [x.strip() for x in (s or "").split(",") if x.strip()]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ── 0. AI health probe ─────────────────────────────────────────────
if CRON_SECRET:
    probe = get(f"{BASE_URL}/api/sidekick/diagnose-ai?key={CRON_SECRET}&model=gpt-5.4")
    if not probe.get("ok"):
        log(f"ABORT: OpenAI scoring is down — {str(probe.get('rawError'))[:160]}")
        log("Fix billing/quota, then re-run via workflow_dispatch.")
        sys.exit(1)
    log("AI probe ok")

# ── rules + accounts ───────────────────────────────────────────────
rules = post(API, {"action": "list", "baseId": BASE, "table": "Task Rules",
                   "params": {"pageSize": 100}}, 60)["records"]


def build_defs(task_type):
    defs = []
    for r in rules:
        f = r["fields"]
        tt = f.get("Task Type") or "news"
        if tt not in (task_type, "both"):
            continue
        kws, jtk = split(f.get("Keywords")), split(f.get("Job Title Keywords"))
        sp = f.get("Scoring Prompt") or ""
        if not sp:
            ak = ", ".join((kws + jtk)[:5])
            sp = (f'Rate this signal for "{f.get("Name","")}". Score 90-100 for exact '
                  f'matches ({ak}). 70-89 strong. 50-69 partial. Below 50 unrelated.')
        defs.append({"id": r["id"], "name": f.get("Name", ""), "description": f.get("Description", ""),
                     "taskType": tt, "scanTarget": f.get("Scan Target") or "accounts",
                     "ease": f.get("Ease") or "Medium", "strength": f.get("Strength") or "Medium",
                     "sources": split(f.get("Sources")), "keywords": kws,
                     "jobTitleKeywords": jtk, "scoringPrompt": sp})
    return defs


news_defs, job_defs = build_defs("news"), build_defs("job_post")
log(f"rules: news={len(news_defs)} job_post={len(job_defs)}")

accounts, offset = [], None
while True:
    params = {"pageSize": 100}
    if offset:
        params["offset"] = offset
    r = post(API, {"action": "list", "baseId": BASE, "table": "Accounts", "params": params}, 60)
    accounts += r.get("records", [])
    offset = r.get("offset")
    if not offset:
        break
companies = [{"name": a["fields"].get("Name", ""), "domain": a["fields"].get("Domain", "")}
             for a in accounts if a["fields"].get("Name")]
log(f"accounts: {len(companies)}")

# ── dedup sets ─────────────────────────────────────────────────────
existing = post(API, {"action": "list", "baseId": BASE, "table": "Tasks"}, 120)
seen = set()
for t in existing.get("records", []):
    f = t.get("fields", {})
    seen.add((f.get("Company", "").lower(), (f.get("Task Rule", "") or "").lower(),
              (f.get("URL", "") or "").lower()))
log(f"existing tasks: {len(existing.get('records', []))}")

try:
    arch_existing = post(API, {"action": "list", "baseId": BASE, "table": "Signal Archive"}, 120)
    arch_seen = {((t["fields"].get("Company", "") or "").lower(),
                  (t["fields"].get("Task Rule", "") or "").lower(),
                  (t["fields"].get("URL", "") or "").lower())
                 for t in arch_existing.get("records", [])}
except Exception:
    arch_seen = set()  # archive table absent on this base -> archiving no-ops


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())


def buffer(signals, company, defs):
    """signals (classified) -> (task_records, archive_records), deduped."""
    tasks, archive = [], []
    for sig in signals or []:
        scores = sig.get("relevanceScores", {}) or {}
        reasons = sig.get("scoreReasons", {}) or {}
        url = sig.get("url", "") or ""
        for tid in (sig.get("matchedTaskIds") or []):
            td = next((t for t in defs if t["id"] == tid), None)
            if not td:
                continue
            raw = scores.get(tid)
            if raw is None:
                raw = round((sig.get("confidence", 0.7)) * 100)
            score = max(0, min(100, int(raw or 0)))
            if score < THRESHOLD:
                continue
            fp = (company.lower(), td["name"].lower(), url.lower())
            if fp in seen:
                continue
            seen.add(fp)
            tasks.append({"Company": company, "Task Rule": td["name"], "Score": score,
                          "Score Reason": reasons.get(tid, ""), "Scan Target": td.get("scanTarget") or "accounts",
                          "Signal": sig.get("headline", "") or sig.get("jobTitle", ""),
                          "Source": sig.get("source", "") or "Google News", "URL": url,
                          "Task Type": sig.get("taskType", "news"),
                          "Date": (sig.get("date") or "")[:10] or time.strftime("%Y-%m-%d"),
                          "Created": now_iso()})
        for tid in (sig.get("subThresholdTaskIds") or []):
            td = next((t for t in defs if t["id"] == tid), None)
            if not td:
                continue
            fp = (company.lower(), td["name"].lower(), url.lower())
            if fp in arch_seen:
                continue
            arch_seen.add(fp)
            archive.append({"Company": company, "Signal Status": "unqualified",
                            "Score": (sig.get("subThresholdScores") or {}).get(tid, 0),
                            "Score Reason": (sig.get("subThresholdReasons") or {}).get(tid, ""),
                            "Signal": sig.get("headline", "") or sig.get("jobTitle", ""),
                            "Task Rule": td["name"], "Task Type": sig.get("taskType", "news"),
                            "Source": sig.get("source", "") or "Google News", "URL": url,
                            "Scan Target": td.get("scanTarget") or "accounts",
                            "Date": (sig.get("date") or "")[:10] or time.strftime("%Y-%m-%d"),
                            "Created": now_iso()})
    return tasks, archive


def write(table, records):
    if not records:
        return 0
    written = 0
    for i in range(0, len(records), 10):
        try:
            # /api/airtable create takes FLAT records (no {fields:{}} wrapper)
            res = post(API, {"action": "create", "baseId": BASE, "table": table,
                             "records": records[i:i + 10]})
            written += len(res.get("records", []))
        except Exception as e:
            log(f"  !! {table} write failed: {str(e)[:120]}")
    return written


# ── 1. NEWS ────────────────────────────────────────────────────────
log("=== NEWS scan ===")
news_tasks = news_arch = 0
failed, ai_outage_streak = [], 0
for i, co in enumerate(companies, 1):
    try:
        d = post(SCAN, {"company": co, "taskDefs": news_defs, "mode": "news",
                        "threshold": THRESHOLD, "campaignId": CAMP}, 280)
    except Exception as e:
        failed.append(f"{co['name']} ({str(e)[:80]})")
        log(f"[{i}/{len(companies)}] {co['name']}: SCAN FAILED {str(e)[:80]}")
        continue
    guards = ((d.get("fetchStats") or {}).get("funnel") or {}).get("guards") or {}
    if guards.get("aiErrorTasks", 0) >= len(news_defs) and len(news_defs) > 0:
        ai_outage_streak += 1
        if ai_outage_streak >= 3:
            log("ABORT: 3 consecutive accounts with ALL rule scoring calls failed — AI outage mid-run.")
            sys.exit(1)
    else:
        ai_outage_streak = 0
    tasks, archive = buffer(d.get("news", []), co["name"], news_defs)
    news_tasks += write("Tasks", tasks)
    news_arch += write("Signal Archive", archive)
    log(f"[{i}/{len(companies)}] {co['name']}: matched={len(tasks)} retained={len(archive)} "
        f"funnel={json.dumps((d.get('fetchStats') or {}).get('funnel', {}))[:160]}")

log(f"NEWS done: tasks={news_tasks} archived={news_arch} failed={len(failed)}")
if len(failed) > len(companies) * 0.3:
    log("ABORT: >30% of news scans failed")
    for x in failed[:20]:
        log(f"  - {x}")
    sys.exit(1)

# ── 2. JOBS ────────────────────────────────────────────────────────
log("=== JOBS scan ===")
job_tasks = job_arch = 0
for i in range(0, len(companies), 5):
    batch = companies[i:i + 5]
    try:
        d = post(SCAN, {"mode": "jobs-batch", "companies": batch, "taskDefs": job_defs,
                        "threshold": THRESHOLD, "campaignId": CAMP}, 280)
    except Exception as e:
        log(f"jobs batch {i // 5 + 1}: FAILED {str(e)[:100]} (Apify cap?) — continuing")
        continue
    for grp in d.get("results", []) or []:
        tasks, archive = buffer(grp.get("signals", []), grp.get("company", ""), job_defs)
        job_tasks += write("Tasks", tasks)
        job_arch += write("Signal Archive", archive)
    log(f"jobs batch {i // 5 + 1}/{(len(companies) + 4) // 5} done (tasks so far {job_tasks})")
log(f"JOBS done: tasks={job_tasks} archived={job_arch}")

# ── 3. LINKEDIN POSTS ──────────────────────────────────────────────
log("=== LINKEDIN POSTS scan ===")
LI = f"{BASE_URL}/api/linkedin-posts"
try:
    start = post(LI, {"action": "scan", "baseId": BASE, "campaignAirtableId": CAMP}, 290)
    log(f"start: {json.dumps(start)[:200]}")
except Exception as e:
    log(f"start error (may already be running): {str(e)[:120]}")

deadline = time.time() + 2.5 * 3600
while time.time() < deadline:
    try:
        prog = post(LI, {"action": "get_progress", "campaignAirtableId": CAMP}, 60).get("progress") or {}
        log(f"linkedin: {prog.get('phase')}/{prog.get('status')} done={prog.get('leads_done')}/{prog.get('total_leads')} tasks={prog.get('tasks_created')}")
        if prog.get("status") in ("complete", "stopped", "error"):
            break
        if CRON_SECRET:
            try:
                post(f"{LI}?mode=resume&key={CRON_SECRET}", {}, 290)
            except Exception as e:
                log(f"resume tick error: {str(e)[:100]}")
    except Exception as e:
        log(f"progress poll error: {str(e)[:100]}")
    time.sleep(60)

log(f"=== WEDNESDAY SCAN COMPLETE === news_tasks={news_tasks} job_tasks={job_tasks} "
    f"archived={news_arch + job_arch} news_failures={len(failed)}")
