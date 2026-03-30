#!/usr/bin/env bash
# Run all unit tests (excludes live integration tests that need a running server)
set -e
cd "$(dirname "$0")/.."

TOTAL_PASS=0
TOTAL_FAIL=0
SUITES=0

run_suite() {
  local name="$1" file="$2"
  echo ""
  echo "━━━ $name ━━━"
  if node "$file" 2>&1; then
    SUITES=$((SUITES + 1))
  else
    echo "FAILED: $name"
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    return 1
  fi
}

# Core tests (src/)
run_suite "Decay"          src/test-decay.js
run_suite "Bilateral"      src/test-bilateral.js
run_suite "Auto-publish"   src/test-auto-publish.js
run_suite "Integration"    src/test-integration.js
run_suite "Observer"       src/test-observer.js
run_suite "Web of Trust"   src/test-web-of-trust.js
run_suite "Discover"       src/test-discover.js
run_suite "Validate"       src/test-validate.js
run_suite "Server"         src/test-server.js

# Test dir tests
run_suite "Fulfillment"    test/test-fulfill.js
run_suite "Billing"        test/test-billing.js
run_suite "SDK"            test/test-sdk.js
run_suite "Conformance"    test/conformance.js

echo ""
echo "════════════════════════════════════"
echo "  All $SUITES test suites passed"
echo "════════════════════════════════════"
