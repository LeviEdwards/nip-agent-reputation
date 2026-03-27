#!/usr/bin/env bash
# check-billing.sh — Run billing cycle from cron
#
# Checks for accounts due for recurring invoices.
# Creates LND invoices via lncli.sh when due.
# Checks for settled invoices and advances billing cycles.
#
# Usage: bash scripts/check-billing.sh [--dry-run]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
LNCLI="/data/.openclaw/workspace/lncli.sh"
SSH_KEY="/data/.openclaw/workspace/.ssh/umbrel-host-key"
SSH_HOST="umbrel@172.17.0.1"

DRY_RUN=""
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN="--dry-run"
  echo "=== Billing check (DRY RUN) ==="
else
  echo "=== Billing check ==="
fi

# Step 1: Check billing status
echo "Checking billing accounts..."
cd "$REPO_DIR"
node src/billing.js --check

# Step 2: Run billing cycle (generates invoices for due accounts)
# The billing module handles the logic; we provide invoice creation via LND
echo ""
echo "Running billing cycle..."

# Use Node.js to run the cycle with LND invoice creation
node -e "
import { runBillingCycle, loadBillingAccounts, markPaid } from './src/billing.js';
import { execSync } from 'child_process';

// Create invoice via lncli.sh
async function createInvoice(amountSats, memo) {
  const payload = JSON.stringify({ value: String(amountSats), memo });
  const cmd = 'bash ${LNCLI} /v1/invoices -X POST -d ' + JSON.stringify(payload);
  const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
  const parsed = JSON.parse(result);
  return {
    paymentHash: parsed.r_hash,
    bolt11: parsed.payment_request,
    amountSats,
    memo,
  };
}

// Check if any outstanding invoices have been paid
async function checkSettledInvoices() {
  const data = loadBillingAccounts();
  for (const account of data.accounts) {
    if (account.status !== 'invoiced' || !account.currentInvoice?.paymentHash) continue;
    
    const hash = account.currentInvoice.paymentHash;
    try {
      // URL-safe base64 for LND lookup
      const urlHash = hash.replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=/g, '');
      const cmd = 'bash ${LNCLI} /v1/invoice/' + urlHash;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
      const invoice = JSON.parse(result);
      
      if (invoice.settled || invoice.state === 'SETTLED') {
        console.log('  Payment received for ' + account.endpointUrl + '!');
        markPaid(account.orderId);
      }
    } catch (err) {
      // Invoice lookup failed — skip (may not exist yet)
    }
  }
}

const dryRun = '${DRY_RUN}' === '--dry-run';

// Check settled first
if (!dryRun) {
  console.log('Checking for settled invoices...');
  await checkSettledInvoices();
}

// Then run billing cycle
await runBillingCycle({
  createInvoiceFn: dryRun ? null : createInvoice,
  dryRun,
});
" 2>&1

echo "=== Billing check complete ==="
