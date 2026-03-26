#!/bin/bash
# check-orders.sh — Check for paid unfulfilled attestation orders and fulfill them.
# Designed to run from OpenClaw cron every 30 minutes.
#
# The attestation-orders/ directory is on the Umbrel host (dispatch server).
# We SSH to read order files, identify paid but unfulfilled ones, then
# use the fulfill.js module to probe + publish attestations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SSH_KEY="/data/.openclaw/workspace/.ssh/umbrel-host-key"
SSH_HOST="umbrel@172.17.0.1"
REMOTE_ORDERS="/home/umbrel/dispatch-server/attestation-orders"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Checking for unfulfilled orders..."

# First ensure reputation server is running
bash "$SCRIPT_DIR/ensure-server.sh"

# List order files on host
ORDER_FILES=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$SSH_KEY" "$SSH_HOST" \
  "ls $REMOTE_ORDERS/*.json 2>/dev/null" 2>/dev/null || true)

if [ -z "$ORDER_FILES" ]; then
  echo "  No order files found."
  exit 0
fi

FOUND_UNFULFILLED=0

for REMOTE_PATH in $ORDER_FILES; do
  FILENAME=$(basename "$REMOTE_PATH")
  
  # Read order JSON from host
  ORDER_JSON=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$SSH_KEY" "$SSH_HOST" \
    "cat $REMOTE_PATH" 2>/dev/null || true)
  
  if [ -z "$ORDER_JSON" ]; then
    continue
  fi
  
  # Check if paid but not fulfilled using node
  NEEDS_FULFILL=$(echo "$ORDER_JSON" | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      try { const o=JSON.parse(d); console.log(o.paid && !o.monitoring_started ? 'yes' : 'no'); }
      catch(e) { console.log('no'); }
    })
  " 2>/dev/null)
  
  if [ "$NEEDS_FULFILL" != "yes" ]; then
    continue
  fi
  
  FOUND_UNFULFILLED=$((FOUND_UNFULFILLED + 1))
  echo "  Found unfulfilled paid order: $FILENAME"
  
  # Copy to local temp
  LOCAL_TMP="/tmp/order-$FILENAME"
  echo "$ORDER_JSON" > "$LOCAL_TMP"
  
  # Fulfill using the Node.js module
  echo "  Running fulfillment..."
  cd "$PROJECT_DIR"
  node src/fulfill.js "$LOCAL_TMP" 2>&1 || echo "  WARNING: Fulfillment encountered errors"
  
  # Copy updated order back to host via ssh cat (more reliable than scp under SIGTERM)
  cat "$LOCAL_TMP" | ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$SSH_KEY" "$SSH_HOST" \
    "cat > $REMOTE_PATH" 2>/dev/null
  
  # Verify sync succeeded
  REMOTE_CHECK=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -i "$SSH_KEY" "$SSH_HOST" \
    "python3 -c \"import json; d=json.load(open('$REMOTE_PATH')); print('ok' if d.get('monitoring_started') else 'fail')\"" 2>/dev/null || echo "fail")
  
  # Clean up local temp
  rm -f "$LOCAL_TMP"
  
  if [ "$REMOTE_CHECK" = "ok" ]; then
    echo "  Order $FILENAME fulfilled and synced back to host. ✓"
  else
    echo "  WARNING: Order $FILENAME fulfilled locally but sync-back may have failed!"
  fi
done

if [ "$FOUND_UNFULFILLED" -eq 0 ]; then
  echo "  No unfulfilled paid orders."
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Order check complete. $FOUND_UNFULFILLED fulfilled."
