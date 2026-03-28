#!/usr/bin/env node
/**
 * run-billing.js — Run the recurring billing cycle.
 *
 * Checks for accounts due for monthly invoices, creates LND invoices,
 * checks settled invoices, and advances billing state machine.
 *
 * Usage:
 *   node scripts/run-billing.js             # Live cycle
 *   node scripts/run-billing.js --dry-run   # No LND calls
 *   node scripts/run-billing.js --status    # Print billing status only
 */

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  runBillingCycle,
  loadBillingAccounts,
  markPaid,
  getBillingStatus,
} from '../src/billing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LNCLI = join(__dirname, '../../..', 'lncli.sh'); // /data/.openclaw/workspace/lncli.sh

const DRY_RUN = process.argv.includes('--dry-run');
const STATUS_ONLY = process.argv.includes('--status');

console.log(`\n=== NIP-30386 Billing Cycle — ${new Date().toISOString()} ===`);

// Status-only mode
if (STATUS_ONLY) {
  const status = getBillingStatus();
  console.log(`Accounts:   ${status.totalAccounts} total`);
  console.log(`  Active:   ${status.active}`);
  console.log(`  Invoiced: ${status.invoiced}`);
  console.log(`  Suspended:${status.suspended}`);
  console.log(`Revenue:    ${status.totalRevenue} sats total`);
  console.log(`MRR:        ${status.monthlyRecurring} sats/month`);
  process.exit(0);
}

// Create LND invoice via lncli.sh
async function createInvoiceFn(amountSats, memo) {
  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would create invoice: ${memo} (${amountSats} sats)`);
    return null;
  }
  
  const payload = JSON.stringify({ value: String(amountSats), memo });
  const escapedPayload = payload.replace(/'/g, "'\"'\"'");
  const cmd = `bash '${LNCLI}' /v1/invoices -X POST -d '${escapedPayload}'`;
  
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: 15000 });
    const parsed = JSON.parse(result);
    return {
      paymentHash: parsed.r_hash,
      bolt11: parsed.payment_request,
      amountSats,
      memo,
    };
  } catch (err) {
    console.error(`  LND invoice creation failed: ${err.message}`);
    return null;
  }
}

// Check if outstanding invoices have been settled
async function checkSettledInvoices() {
  if (DRY_RUN) return;
  
  const data = loadBillingAccounts();
  const invoicedAccounts = data.accounts.filter(
    a => a.status === 'invoiced' && a.currentInvoice?.paymentHash
  );
  
  if (invoicedAccounts.length === 0) return;
  
  console.log(`\nChecking ${invoicedAccounts.length} outstanding invoice(s)...`);
  
  for (const account of invoicedAccounts) {
    const hash = account.currentInvoice.paymentHash;
    try {
      // LND expects URL-safe base64 for r_hash lookup
      const urlSafeHash = hash.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const cmd = `bash '${LNCLI}' /v1/invoice/${urlSafeHash}`;
      const result = execSync(cmd, { encoding: 'utf8', timeout: 10000 });
      const invoice = JSON.parse(result);
      
      if (invoice.settled || invoice.state === 'SETTLED') {
        console.log(`  ✓ Payment received: ${account.endpointUrl}`);
        markPaid(account.orderId);
      } else {
        console.log(`  ⏳ Pending: ${account.endpointUrl} (${invoice.state || 'OPEN'})`);
      }
    } catch (err) {
      // Invoice lookup failed — may be using hex hash, try alternate format
      console.log(`  ? Lookup failed for ${account.endpointUrl}: ${err.message.slice(0, 60)}`);
    }
  }
}

// Show current status
const status = getBillingStatus();
if (status.totalAccounts === 0) {
  console.log('No billing accounts yet. (Accounts are added when orders are fulfilled.)');
  process.exit(0);
}

console.log(`\nBilling accounts: ${status.totalAccounts} (${status.active} active, MRR: ${status.monthlyRecurring} sats)`);

// Step 1: Check for settled invoices
await checkSettledInvoices();

// Step 2: Run billing cycle (issue new invoices for due accounts)
console.log('\nRunning billing cycle...');
const result = await runBillingCycle({
  createInvoiceFn,
  dryRun: DRY_RUN,
});

console.log(`\nBilling complete:`);
console.log(`  Invoices generated: ${result.invoicesGenerated}`);
console.log(`  Accounts suspended: ${result.accountsSuspended}`);
if (result.skipped > 0) console.log(`  Skipped (not due): ${result.skipped}`);

console.log(`=== Done ===\n`);
