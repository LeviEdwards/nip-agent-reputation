#!/bin/bash
# smoke-test.sh — Validate all NIP-30386 API endpoints (local + public proxy)
# Run: bash scripts/smoke-test.sh [--public]
# Exit code: 0 = all pass, 1 = failures

set -euo pipefail

LOCAL="http://10.21.0.3:3386"
PUBLIC="https://dispatches.mystere.me/api/reputation"
ACINQ="03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f"
OUR_NOSTR="1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead"

PASSED=0
FAILED=0
WARNINGS=0

pass() { echo "  ✓ $1"; PASSED=$((PASSED+1)); }
fail() { echo "  ✗ $1"; FAILED=$((FAILED+1)); }
warn() { echo "  ⚠ $1"; WARNINGS=$((WARNINGS+1)); }

test_endpoint() {
  local name="$1" url="$2" check="$3"
  local response
  response=$(timeout 15 curl -sf --max-time 12 "$url" 2>/dev/null) || { fail "$name — connection failed"; return; }
  if echo "$response" | python3 -c "$check" 2>/dev/null; then
    pass "$name"
  else
    fail "$name — check failed"
    echo "    Response: $(echo "$response" | head -c 200)"
  fi
}

echo "========================================"
echo "  NIP-30386 API Smoke Test"
echo "  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "========================================"
echo

# --- Local API ---
echo "--- Local API ($LOCAL) ---"

test_endpoint "Root endpoint" "$LOCAL/" "
import json,sys
d=json.load(sys.stdin)
assert d['kind']==30386, 'wrong kind'
assert 'version' in d, 'no version'
"

test_endpoint "Reputation query (ACINQ)" "$LOCAL/reputation/$ACINQ" "
import json,sys
d=json.load(sys.stdin)
assert d.get('attestationCount',0) > 0, 'no attestations'
assert d.get('trustLevel') in ('low','moderate','verified'), 'bad trust'
assert len(d.get('dimensions',{})) > 0, 'no dimensions'
"

test_endpoint "Reputation query (Nostr pubkey)" "$LOCAL/reputation/$OUR_NOSTR" "
import json,sys
d=json.load(sys.stdin)
assert d.get('attestationCount',0) > 0, 'no attestations'
"

test_endpoint "Discover services" "$LOCAL/discover" "
import json,sys
d=json.load(sys.stdin)
assert d.get('serviceCount',0) > 0, 'no services'
assert len(d.get('services',[])) > 0, 'empty services array'
"

test_endpoint "Discover with reputation" "$LOCAL/discover?reputation=true" "
import json,sys
d=json.load(sys.stdin)
assert d.get('serviceCount',0) > 0, 'no services'
"

test_endpoint "Badge SVG (ACINQ)" "$LOCAL/reputation/badge/$ACINQ" "
import sys
data=sys.stdin.read()
assert '<svg' in data, 'not SVG'
assert 'reputation' in data.lower() or 'trust' in data.lower() or 'verified' in data.lower(), 'no reputation info'
"

# Test invalid pubkey — expect 400 or 404
RESP_CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$LOCAL/reputation/invalid" 2>/dev/null || echo "000")
if [ "$RESP_CODE" = "400" ]; then
  pass "Invalid pubkey returns 400"
elif [ "$RESP_CODE" = "404" ]; then
  pass "Invalid pubkey returns 404 (acceptable)"
else
  fail "Invalid pubkey returns $RESP_CODE (expected 400 or 404)"
fi

echo

# --- Public Proxy (optional) ---
if [[ "${1:-}" == "--public" ]] || [[ "${1:-}" == "-p" ]]; then
  echo "--- Public Proxy ($PUBLIC) ---"
  
  test_endpoint "Public: reputation query" "$PUBLIC/$ACINQ" "
import json,sys
d=json.load(sys.stdin)
assert d.get('attestationCount',0) > 0, 'no attestations'
"

  test_endpoint "Public: discover" "${PUBLIC}/discover" "
import json,sys
d=json.load(sys.stdin)
assert d.get('serviceCount',0) >= 0, 'bad response'
"

  test_endpoint "Public: badge" "${PUBLIC}/badge/$ACINQ" "
import sys
data=sys.stdin.read()
assert '<svg' in data, 'not SVG'
"
  echo
fi

# --- Summary ---
echo "========================================"
TOTAL=$((PASSED+FAILED))
echo "  Results: $PASSED/$TOTAL passed, $FAILED failed, $WARNINGS warnings"
echo "========================================"

[ "$FAILED" -eq 0 ] && exit 0 || exit 1
