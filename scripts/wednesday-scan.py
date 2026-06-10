#!/usr/bin/env python3
"""Wednesday scan driver — Material news + job posts + LinkedIn posts.

Runs from GitHub Actions (.github/workflows/wednesday-scan.yml, Wed 06:00 UTC).

v2 (2026-06-10): news + jobs now run through the RESUMABLE /api/scan-run
orchestrator (the LinkedIn-posts pattern: progress state on the Campaigns row,
time-budgeted ticks, resume until complete). This script is just a thin driver:
start the scan, call resume until it reports complete. If this runner dies
mid-scan, ANY driver (re-run, cron-job.org hitting ?mode=resume, a UI resume
button) continues from the saved cursor — nothing is lost. Standing rule:
wherever the Vercel 300s timeout is a bottleneck, use this pattern.

Flow:
  0. AI health probe (diagnose-ai) — abort LOUDLY on a quota outage instead of
     burning hours producing zero tasks (2026-06-10 incident).
  1. POST /api/scan-run action=start (news phase -> jobs phase, server-side
     Tasks + Signal Archive writes, dedup, AI-outage abort in the route).
  2. Loop: POST /api/scan-run action=resume until status complete/error.
  3. LinkedIn posts: start the resumable scan, poll ?mode=resume to completion.

Env: SIGNALSCOPE_URL (default prod), CRON_SECRET, MATERIAL_BASE_ID /
     MATERIAL_CAMPAIGN_ID (default Material).
Exit codes: 0 ok, 1 hard failure (AI outage / scan-run error state).
"""
import json, os, sys, time, urllib.request

BASE_URL = os.environ.get("SIGNALSCOPE_URL", "https://news-material-two.vercel.app")
CRON_SECRET = os.environ.get("CRON_SECRET", "")
BASE = os.environ.get("MATERIAL_BASE_ID", "appIaff6DEzgkpVJb")
CAMP = os.environ.get("MATERIAL_CAMPAIGN_ID", "recnRZO0HTX8Pvksy")
THRESHOLD = int(os.environ.get("SCAN_THRESHOLD", "70"))


def post(url, payload, timeout=290):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def get(url, timeout=60):
    return json.loads(urllib.request.urlopen(url, timeout=timeout).read())


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

# ── 1+2. News + jobs via the resumable orchestrator ────────────────
RUN = f"{BASE_URL}/api/scan-run"
log("starting /api/scan-run (news -> jobs, resumable)")
try:
    r = post(RUN, {"action": "start", "baseId": BASE, "campaignAirtableId": CAMP,
                   "threshold": THRESHOLD}, 295)
except Exception as e:
    # 409 = already running (e.g. a prior tick is mid-flight) — fall through to resume
    log(f"start: {str(e)[:120]} — attempting resume of existing state")
    r = {"progress": None}

deadline = time.time() + 4 * 3600
while time.time() < deadline:
    prog = (r or {}).get("progress") or {}
    log(f"scan-run: status={prog.get('status')} phase={prog.get('phase')} "
        f"news={prog.get('news_idx')}/{prog.get('accounts_total')} jobs_batch={prog.get('jobs_idx')} "
        f"totals={json.dumps(prog.get('totals') or {})} failures={len(prog.get('failures') or [])}")
    if prog.get("status") == "complete":
        break
    if prog.get("status") == "error":
        log(f"ABORT: scan-run error — {prog.get('error')}")
        sys.exit(1)
    if prog.get("status") == "stopped":
        log("scan-run was stopped externally")
        break
    try:
        r = post(RUN, {"action": "resume", "campaignAirtableId": CAMP}, 295)
    except Exception as e:
        log(f"resume error: {str(e)[:120]} — retrying in 30s")
        time.sleep(30)
        try:
            r = {"progress": post(RUN, {"action": "get_progress", "campaignAirtableId": CAMP}, 60).get("progress")}
        except Exception:
            r = {"progress": None}
else:
    log("ABORT: news/jobs scan did not complete within 4h")
    sys.exit(1)

totals = ((r or {}).get("progress") or {}).get("totals") or {}
log(f"NEWS+JOBS done: {json.dumps(totals)}")

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
                # Resume is a GET with key/base/campaign — the POST switch has
                # no resume mode (doc error caused a 6h stall on 2026-06-10).
                get(f"{LI}?key={CRON_SECRET}&base={BASE}&campaign={CAMP}", 320)
            except Exception as e:
                log(f"resume tick error: {str(e)[:100]}")
    except Exception as e:
        log(f"progress poll error: {str(e)[:100]}")
    time.sleep(60)

log(f"=== WEDNESDAY SCAN COMPLETE === news+jobs totals={json.dumps(totals)}")
