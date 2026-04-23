# Overnight LinkedIn Posts Scan — Setup Guide (verified April 2026)

## The numbers

- **1055 leads** to scan
- **~12 seconds per lead** (profile fetch + posts fetch + AI scoring + Airtable writes)
- **Vercel Hobby (Fluid Compute, default):** 300s (5 min) max duration per function invocation
- **~22 leads per invocation** (conservative — leaves 30s safety margin for final writes)
- **Total invocations needed:** ~48

## Plan: cron-job.org triggers Vercel every 1 minute

- **cron-job.org free tier** allows 1-per-minute scheduling, unlimited jobs
- **cron-job.org 30s HTTP timeout** is fine — our scan runs in background on Vercel side, cron doesn't need to wait for completion
- Each cron tick either resumes an active scan OR gets a 409 lock if the prior scan is still writing progress (auto-retries next minute)
- **Total wall-clock time: ~50-60 minutes** for 1055 leads

This is way faster than an overnight scan. You could kick it off after dinner and be done before bed.

---

## Step 1: Enable Fluid Compute on Vercel (probably already on)

Fluid Compute is the feature that gives Hobby plan 300s max duration. It's been the default for projects since June 2025, but verify:

1. Vercel Dashboard → your project → **Settings** → **Functions**
2. Look for "Fluid Compute" section
3. If it says "Enabled" — ✅ nothing to do
4. If it says "Disabled" — click Enable and redeploy

**Verify by checking the max duration:** same Settings → Functions page should show "Function max duration: 300s" (not 60s).

## Step 2: Set the `CRON_SECRET` environment variable

Any random string, but use a long one. Example: `sk_lnkedin_scan_xK3mP9qR2vLnY8sT`

1. Vercel Dashboard → your project → **Settings** → **Environment Variables**
2. Add new variable:
   - Name: `CRON_SECRET`
   - Value: (your random string, save it)
   - Environment: Production (at minimum)
3. **Redeploy** — env vars only take effect on new deploys

## Step 3: Grab the IDs you need

You need three things:

1. **Vercel production URL** — e.g. `https://news-material-abc123.vercel.app` (or your custom domain)
2. **Base ID** — visible bottom-left of SignalScope sidebar ("AIRTABLE BASE"), format `app...`
3. **Campaign Airtable ID** — format `rec...`

For #3, the easiest way: start a scan once from the UI (auto-provisions the Campaigns record), then open your **master Airtable base** → Campaigns table → find the row → record ID shown when you click the expanded view, OR pull it from the URL.

## Step 4: Start scan from UI (once)

This auto-provisions the Airtable Campaign record AND persists the scan config so cron triggers know what settings to resume with.

1. LinkedIn Posts tab
2. Configure everything: lead selection, threshold, days back, task rule name, cleanup settings
3. Click **Start Scan**
4. Wait until either (a) the progress bar appears and starts moving, or (b) you see "Paused at X/1055" with a Resume button
5. Either state means: progress is saved, config is persisted, cron can now take over

You can close the browser now.

## Step 5: Set up cron-job.org

1. Go to https://cron-job.org and sign up (free, email only, ~30 seconds)
2. Click **Create cronjob**
3. Fill in:
   - **Title:** `SignalScope LinkedIn resume`
   - **URL:**
     ```
     https://YOUR-VERCEL-APP.vercel.app/api/linkedin-posts?key=YOUR_CRON_SECRET&base=appXXX&campaign=recYYY
     ```
     (replace the 3 uppercase placeholders with your actual values)
   - **Schedule:** click the "Every minute" preset
   - **Request method:** GET (default)
   - **Advanced → Notifications:** enable "Notify on failures" so you know if something breaks
4. Click **Create**
5. Job starts running immediately

## Step 6: Monitor (optional)

cron-job.org shows a live log of each trigger. You'll see things like:

| Time | Status | Duration | Response |
|---|---|---|---|
| 22:15:02 | OK (200) | 30s | (timeout — scan still running in background) |
| 22:16:02 | OK (200) | 30s | (timeout — scan continues) |
| 22:17:02 | OK (200) | 2.3s | `{"status":"RESUMED","leads_done":45,...}` |
| ... | ... | ... | ... |
| 23:08:02 | OK (200) | 0.4s | `{"status":"DONE","leads_done":1055,"tasks_created":73}` |

The ~30s timeouts are normal and expected — they just mean the Vercel function is still processing leads. Don't panic.

Also monitor from your SignalScope UI — go to LinkedIn Posts tab, the progress bar updates live.

## Step 7: Disable cron when done

Once you see `"status":"DONE"` in cron-job.org logs:
1. Go back to cron-job.org
2. **Disable** (toggle off) or **Delete** the cronjob
3. Check SignalScope Tasks tab for the results

---

## What if something breaks?

### "Another scan is actively running" (409 lock)
**Not a problem.** Cron-job.org tries again next minute. The lock only holds for 30 seconds after the last progress write. This happens when cron ticks while a Vercel function is mid-lead.

### 401 Unauthorized
`CRON_SECRET` env var doesn't match the `key=` query param. Check spelling, confirm you redeployed Vercel after adding the env var.

### 400 "base and campaign query params required"
Missing `base=` or `campaign=` in the URL. Double-check you copied the full URL.

### 500 errors repeatedly
Something real is broken. Open Vercel dashboard → Logs → filter by `/api/linkedin-posts`. The error will be in the log. Common causes:
- `RAPIDAPI_KEY` env var not set → profile fetches fail
- `OPENAI_API_KEY` missing or invalid → scoring fails
- RapidAPI rate limit hit → 429 errors in log
- Airtable field auto-create failing → check the master base has write access

### Scan looks stuck
Check SignalScope UI progress panel:
- **`last_log` not updating:** Vercel function died mid-lead. Next cron tick will pick up.
- **`errors` array growing:** individual leads failing (bad LinkedIn URLs etc.) — check the error messages
- **`leads_done` not increasing over 5 min:** cron-job.org might be disabled or key mismatch

### Ran out of Vercel free-tier quota
Hobby plan gives 4 CPU-hrs/month and 100 GB-Hours function duration. Network waits (RapidAPI, OpenAI) don't count toward CPU time on Fluid Compute, but total function duration does count. A full 1055-lead scan should stay well under quotas, but back-to-back scans of large lead sets could burn through your allowance. Check Vercel dashboard → Usage to see current consumption.

---

## Alternative: Laptop loop (no signup needed)

If you don't want to sign up for cron-job.org, run this on your laptop instead:

```bash
# In one terminal, set env vars
export VERCEL_URL="https://YOUR-APP.vercel.app"
export CRON_SECRET="your-secret"
export BASE_ID="appXXX"
export CAMPAIGN_ID="recYYY"

# Then run:
cd signalscope-vercel/scripts
./run-overnight.sh
```

The script pings every 90s (gives more breathing room than 60s), survives network blips, auto-stops when done. Needs laptop awake — on macOS use `caffeinate -i ./run-overnight.sh` to prevent sleep.

---

## The key insight

What made this fast was Fluid Compute becoming the Hobby default in mid-2025. Before that, Hobby was stuck at 60s per function. Now you get 300s on free tier, same as the old Pro ceiling. For a batch job like this, that's a 5x speedup per invocation.

1055 leads / 48 invocations / 1 minute per cron tick = **under an hour to complete**. This was unthinkable a year ago on free tier.
