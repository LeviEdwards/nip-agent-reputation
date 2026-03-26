#!/bin/bash
# fulfill-order.sh — Called when an attestation order is paid.
# Adds endpoint to monitor registry + runs immediate first probe.
#
# Usage: bash scripts/fulfill-order.sh <order-json-path>
#
# The order JSON must have: endpoint_url, nostr_pubkey (optional), contact (optional)
# This script:
#   1. Adds endpoint to data/monitor-registry.json
#   2. Runs a single-endpoint monitoring cycle (probes + publishes attestation)
#   3. Writes the attestation event ID back to the order file
#   4. Logs the fulfillment

set -euo pipefail

ORDER_FILE="${1:?Usage: fulfill-order.sh <order-json-path>}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REGISTRY="$PROJECT_DIR/data/monitor-registry.json"

if [ ! -f "$ORDER_FILE" ]; then
  echo "ERROR: Order file not found: $ORDER_FILE"
  exit 1
fi

# Parse order
ENDPOINT_URL=$(node -e "const o=JSON.parse(require('fs').readFileSync('$ORDER_FILE','utf8')); console.log(o.endpoint_url)")
NOSTR_PUBKEY=$(node -e "const o=JSON.parse(require('fs').readFileSync('$ORDER_FILE','utf8')); console.log(o.nostr_pubkey || '')")
ORDER_ID=$(node -e "const o=JSON.parse(require('fs').readFileSync('$ORDER_FILE','utf8')); console.log(o.orderId || '')")
CONTACT=$(node -e "const o=JSON.parse(require('fs').readFileSync('$ORDER_FILE','utf8')); console.log(o.contact || '')")

echo "=== Fulfilling attestation order ==="
echo "  Order: $ORDER_ID"
echo "  Endpoint: $ENDPOINT_URL"
echo "  Nostr pubkey: ${NOSTR_PUBKEY:-none}"
echo "  Contact: ${CONTACT:-none}"

# Ensure registry exists
if [ ! -f "$REGISTRY" ]; then
  echo "  Initializing registry..."
  cd "$PROJECT_DIR" && node src/monitor.js --init
fi

# Add endpoint to registry (idempotent — skip if URL already present)
node -e "
const fs = require('fs');
const reg = JSON.parse(fs.readFileSync('$REGISTRY', 'utf8'));
const exists = reg.endpoints.some(e => e.url === '$ENDPOINT_URL');
if (exists) {
  console.log('  Endpoint already in registry, skipping add.');
} else {
  reg.endpoints.push({
    url: '$ENDPOINT_URL',
    subjectPubkey: '${NOSTR_PUBKEY}' || 'unknown',
    subjectNostrPubkey: '${NOSTR_PUBKEY}' || null,
    serviceType: 'http-endpoint',
    probeCount: 5,
    enabled: true,
    label: '$ENDPOINT_URL (paid order $ORDER_ID)',
    tier: 'paid',
    addedAt: new Date().toISOString().split('T')[0],
    orderId: '$ORDER_ID',
    contact: '$CONTACT' || null,
  });
  reg.updatedAt = new Date().toISOString();
  fs.writeFileSync('$REGISTRY', JSON.stringify(reg, null, 2));
  console.log('  Added to registry (' + reg.endpoints.length + ' endpoints total)');
}
"

# Run immediate probe for just this endpoint
echo "  Running first probe..."
cd "$PROJECT_DIR"

RESULT=$(node -e "
import { probeEndpoint, checkSecurityHeaders, runMonitoringCycle } from './src/monitor.js';

// Run full cycle but it will include the new endpoint
const result = await runMonitoringCycle({ dryRun: false });
const match = result.endpoints?.find(e => e.label?.includes('$ORDER_ID'));
if (match) {
  console.log(JSON.stringify({ eventId: match.eventId, uptime: match.uptime, avgMs: match.avgMs }));
} else {
  // Fallback — find by URL
  const urlMatch = result.endpoints?.find(e => e.label?.includes('$ENDPOINT_URL'));
  if (urlMatch) {
    console.log(JSON.stringify({ eventId: urlMatch.eventId, uptime: urlMatch.uptime, avgMs: urlMatch.avgMs }));
  } else {
    console.log(JSON.stringify({ error: 'endpoint_not_found_in_results', allEndpoints: result.endpoints }));
  }
}
" 2>/dev/null || echo '{"error":"probe_failed"}')

echo "  Probe result: $RESULT"

# Write attestation event ID back to order file
EVENT_ID=$(echo "$RESULT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.eventId || '')" 2>/dev/null || echo "")

if [ -n "$EVENT_ID" ]; then
  node -e "
    const fs = require('fs');
    const order = JSON.parse(fs.readFileSync('$ORDER_FILE', 'utf8'));
    order.first_attestation_event = '$EVENT_ID';
    order.monitoring_started = true;
    order.monitoring_started_at = new Date().toISOString();
    fs.writeFileSync('$ORDER_FILE', JSON.stringify(order, null, 2));
    console.log('  Order updated with event ID: $EVENT_ID');
  "
  echo "=== Fulfillment complete — event $EVENT_ID ==="
else
  echo "WARNING: Probe may have failed. Event ID not captured."
  echo "  Raw result: $RESULT"
fi
