#!/bin/bash
# run-monitoring.sh — Re-probe all registered endpoints and publish fresh attestations.
# Designed to run from cron every 6 hours alongside the self-attestation cron.
#
# This is the recurring monitoring that justifies the 1000 sats/month fee.
# Each run probes every endpoint in the registry and publishes updated
# kind 30386 observer attestations to Nostr relays.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting monitoring cycle..."

# Ensure reputation server is running
bash "$SCRIPT_DIR/ensure-server.sh"

# Run monitoring cycle via the Node.js module
cd "$PROJECT_DIR"
node src/run-monitoring.js 2>&1

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Monitoring cycle complete."
