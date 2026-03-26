#!/bin/bash
# scan-orders.sh — Scan dispatch server attestation-orders/ for unfulfilled paid orders.
# Designed to run from cron every ~30 minutes.
#
# This runs from within the Satoshi container (10.21.0.3) where the nip-reputation
# code lives. The attestation-orders/ directory is on the Umbrel host, so we
# first copy any new paid-but-unfulfilled orders locally, fulfill them,
# then write results back.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOCAL_ORDERS="$PROJECT_DIR/data/pending-orders"

mkdir -p "$LOCAL_ORDERS"

# The dispatch server orders directory is on the Umbrel host.
# From inside the container, we can access it via SSH or if it's mounted.
# Since dispatch-server runs on the host, we need SSH.
SSH_KEY="/data/.openclaw/workspace/.ssh/umbrel-host-key"
SSH_HOST="umbrel@172.17.0.1"
REMOTE_ORDERS="/home/umbrel/dispatch-server/attestation-orders"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Scanning for unfulfilled orders..."

# Find paid but unfulfilled orders on host
PAID_UNFULFILLED=$(ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" "$SSH_HOST" "
  cd $REMOTE_ORDERS 2>/dev/null || exit 0
  for f in *.json; do
    [ -f \"\$f\" ] || continue
    paid=\$(node -e \"const o=JSON.parse(require('fs').readFileSync('\$f','utf8')); console.log(o.paid ? 'yes' : 'no')\" 2>/dev/null)
    fulfilled=\$(node -e \"const o=JSON.parse(require('fs').readFileSync('\$f','utf8')); console.log(o.monitoring_started ? 'yes' : 'no')\" 2>/dev/null)
    if [ \"\$paid\" = 'yes' ] && [ \"\$fulfilled\" != 'yes' ]; then
      echo \"\$f\"
    fi
  done
" 2>/dev/null)

if [ -z "$PAID_UNFULFILLED" ]; then
  echo "  No unfulfilled paid orders found."
  exit 0
fi

echo "  Found unfulfilled orders:"
echo "$PAID_UNFULFILLED" | while read f; do echo "    - $f"; done

# Copy each to local, fulfill, write back
echo "$PAID_UNFULFILLED" | while read f; do
  echo ""
  echo "--- Processing: $f ---"
  
  # Copy from host
  scp -o StrictHostKeyChecking=no -i "$SSH_KEY" "$SSH_HOST:$REMOTE_ORDERS/$f" "$LOCAL_ORDERS/$f"
  
  # Fulfill
  cd "$PROJECT_DIR"
  node src/fulfill.js "$LOCAL_ORDERS/$f" 2>&1 || echo "  WARNING: Fulfillment had errors"
  
  # Copy updated order back to host
  scp -o StrictHostKeyChecking=no -i "$SSH_KEY" "$LOCAL_ORDERS/$f" "$SSH_HOST:$REMOTE_ORDERS/$f"
  
  echo "--- Done: $f ---"
done

echo ""
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Scan complete."
