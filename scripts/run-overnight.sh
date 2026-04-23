#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# run-overnight.sh — Drive the LinkedIn Posts scan to completion overnight
# ═══════════════════════════════════════════════════════════════════════════
#
# Usage:
#   export VERCEL_URL="https://your-app.vercel.app"
#   export CRON_SECRET="your-secret"
#   export BASE_ID="appXXX"
#   export CAMPAIGN_ID="recYYY"
#   ./run-overnight.sh
#
# Or call directly:
#   VERCEL_URL=... CRON_SECRET=... BASE_ID=... CAMPAIGN_ID=... ./run-overnight.sh
#
# What it does:
#   - Calls the cron endpoint every 90 seconds
#   - Prints progress after each call
#   - Stops automatically when scan returns "DONE"
#   - Keeps running if errors occur (network blips, etc.) — never gives up
#
# Safe to leave running overnight. Uses ~1 curl call/90s = ~40 calls/hour.

if [ -z "$VERCEL_URL" ] || [ -z "$CRON_SECRET" ] || [ -z "$BASE_ID" ] || [ -z "$CAMPAIGN_ID" ]; then
  echo "❌ Missing required env vars. Set:"
  echo "   VERCEL_URL, CRON_SECRET, BASE_ID, CAMPAIGN_ID"
  exit 1
fi

URL="${VERCEL_URL}/api/linkedin-posts?key=${CRON_SECRET}&base=${BASE_ID}&campaign=${CAMPAIGN_ID}"
INTERVAL=90
ITERATION=0

echo "🚀 Starting overnight scan loop"
echo "   URL: ${VERCEL_URL}/api/linkedin-posts?key=***&base=${BASE_ID}&campaign=${CAMPAIGN_ID}"
echo "   Interval: ${INTERVAL}s"
echo "   Press Ctrl+C to stop"
echo ""

while true; do
  ITERATION=$((ITERATION + 1))
  TS=$(date "+%H:%M:%S")

  RESPONSE=$(curl -sS -m 70 "$URL" 2>&1)
  CURL_EXIT=$?

  if [ $CURL_EXIT -ne 0 ]; then
    echo "[$TS] #$ITERATION ⚠️  curl error (code $CURL_EXIT): $RESPONSE — retrying in ${INTERVAL}s"
    sleep $INTERVAL
    continue
  fi

  # Check for completion
  STATUS=$(echo "$RESPONSE" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  LEADS_DONE=$(echo "$RESPONSE" | grep -o '"leads_done":[0-9]*' | head -1 | cut -d':' -f2)
  LEADS_REMAINING=$(echo "$RESPONSE" | grep -o '"leads_remaining":[0-9]*' | head -1 | cut -d':' -f2)
  TASKS=$(echo "$RESPONSE" | grep -o '"tasks_created":[0-9]*' | head -1 | cut -d':' -f2)

  echo "[$TS] #$ITERATION status=$STATUS leads_done=$LEADS_DONE remaining=$LEADS_REMAINING tasks=$TASKS"

  if [ "$STATUS" = "DONE" ]; then
    echo ""
    echo "🎉 Scan complete!"
    echo "   Total leads processed: $LEADS_DONE"
    echo "   Total tasks created: $TASKS"
    echo "   Iterations: $ITERATION"
    exit 0
  fi

  if [ "$STATUS" = "IDLE" ]; then
    echo "⚠️  No scan state exists. Start one from the UI first."
    exit 1
  fi

  if [ "$STATUS" = "ERROR" ]; then
    echo "⚠️  Server returned error — will retry in ${INTERVAL}s"
  fi

  sleep $INTERVAL
done
