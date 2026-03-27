/**
 * Recurring Billing for Attestation Monitoring Service
 * 
 * Tracks billing cycles for paid attestation customers.
 * Generates Lightning invoices for monthly recurring fees.
 * 
 * Pricing (from karl_bott deal):
 *   - Initial attestation package: 5000 sats (handled by order flow)
 *   - Monthly recurring monitoring: 1000 sats/month
 *   - Revenue split: 60% karl (monitoring), 40% satoshi (directory/protocol)
 * 
 * Usage:
 *   node src/billing.js --check              # Check for due invoices, print summary
 *   node src/billing.js --generate           # Generate invoices for due accounts
 *   node src/billing.js --status             # Show all billing accounts
 *   node src/billing.js --add <orderId>      # Add order to billing cycle
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const BILLING_FILE = join(DATA_DIR, 'billing-accounts.json');
const BILLING_LOG = join(DATA_DIR, 'billing-log.json');

// Billing constants
const MONTHLY_FEE_SATS = 1000;
const BILLING_CYCLE_MS = 30 * 24 * 60 * 60 * 1000; // ~30 days
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;   // 7-day grace before suspension
const FREE_TIER_MONTHS = 0; // First 3 endpoints are free (handled at order level)

// Moltbook DM config for partner notifications
const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';
const MOLTBOOK_API_KEY = 'moltbook_sk_4AQK9KbEL-ypTRPr3w20HYhU4DwgQxV_';
const KARL_CONVERSATION_ID = process.env.KARL_DM_CONVERSATION_ID || '987483e9-c316-4a4f-9b1c-8b396501eac9';

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Load billing accounts from disk.
 */
export function loadBillingAccounts() {
  ensureDir(DATA_DIR);
  if (!existsSync(BILLING_FILE)) {
    return { version: 1, accounts: [], updatedAt: new Date().toISOString() };
  }
  try {
    return JSON.parse(readFileSync(BILLING_FILE, 'utf8'));
  } catch {
    return { version: 1, accounts: [], updatedAt: new Date().toISOString() };
  }
}

/**
 * Save billing accounts to disk.
 */
export function saveBillingAccounts(data) {
  ensureDir(DATA_DIR);
  data.updatedAt = new Date().toISOString();
  writeFileSync(BILLING_FILE, JSON.stringify(data, null, 2));
}

/**
 * Add a fulfilled order to the billing cycle.
 * Called after order fulfillment — the initial 5000-sat payment is already done.
 * First billing cycle starts 30 days from fulfillment.
 */
export function addToBilling(order) {
  const data = loadBillingAccounts();
  
  // Check for duplicate
  const existing = data.accounts.find(a => a.orderId === order.orderId);
  if (existing) {
    console.log(`  Billing: order ${order.orderId} already in billing cycle.`);
    return { added: false, reason: 'duplicate' };
  }
  
  const now = new Date();
  const fulfillmentDate = order.monitoring_started_at || now.toISOString();
  const nextBillingDate = new Date(new Date(fulfillmentDate).getTime() + BILLING_CYCLE_MS);
  
  const account = {
    orderId: order.orderId,
    endpointUrl: order.endpoint_url,
    nostrPubkey: order.nostr_pubkey || null,
    contact: order.contact || null,
    amountSats: MONTHLY_FEE_SATS,
    status: 'active',                         // active | invoiced | grace | suspended
    createdAt: fulfillmentDate,
    nextBillingDate: nextBillingDate.toISOString(),
    lastPaidAt: null,
    totalPaid: order.amount_sats || 5000,     // initial payment
    invoiceCount: 0,
    consecutiveMissed: 0,
  };
  
  data.accounts.push(account);
  saveBillingAccounts(data);
  
  console.log(`  Billing: added ${order.endpoint_url} — next billing ${nextBillingDate.toISOString().slice(0, 10)}`);
  return { added: true, nextBillingDate: account.nextBillingDate };
}

/**
 * Check which accounts have invoices due (billing date passed).
 * Returns list of accounts needing invoices.
 */
export function checkDueAccounts(now = new Date()) {
  const data = loadBillingAccounts();
  const due = [];
  const grace = [];
  const suspended = [];
  
  for (const account of data.accounts) {
    if (account.status === 'suspended') {
      suspended.push(account);
      continue;
    }
    
    const billingDate = new Date(account.nextBillingDate);
    const graceCutoff = new Date(billingDate.getTime() + GRACE_PERIOD_MS);
    
    if (now >= billingDate) {
      if (account.status === 'invoiced' && now >= graceCutoff) {
        // Invoice was generated but not paid within grace period
        grace.push(account);
      } else if (account.status === 'active') {
        // Due for new invoice
        due.push(account);
      } else if (account.status === 'grace') {
        // Already in grace period, check if expired
        if (now >= graceCutoff) {
          suspended.push(account);
        }
      }
    }
  }
  
  return { due, grace, suspended, total: data.accounts.length };
}

/**
 * Generate a Lightning invoice for a billing account.
 * NOTE: This creates the invoice via LND on the Umbrel host.
 * In production, called via SSH bridge from check-billing.sh.
 * 
 * Returns invoice details or null if creation fails.
 */
export function buildInvoiceMemo(account) {
  const monthStr = new Date().toISOString().slice(0, 7); // YYYY-MM
  return `NIP-30386 monitoring: ${account.endpointUrl} (${monthStr})`;
}

/**
 * Mark an account as invoiced (invoice generated, awaiting payment).
 */
export function markInvoiced(orderId, invoiceData) {
  const data = loadBillingAccounts();
  const account = data.accounts.find(a => a.orderId === orderId);
  if (!account) return { updated: false, reason: 'not_found' };
  
  account.status = 'invoiced';
  account.currentInvoice = {
    paymentHash: invoiceData.paymentHash,
    bolt11: invoiceData.bolt11,
    amountSats: invoiceData.amountSats || MONTHLY_FEE_SATS,
    createdAt: new Date().toISOString(),
    memo: invoiceData.memo,
  };
  account.invoiceCount++;
  
  saveBillingAccounts(data);
  return { updated: true };
}

/**
 * Mark an account as paid (invoice settled).
 * Advances billing cycle to next month.
 */
export function markPaid(orderId) {
  const data = loadBillingAccounts();
  const account = data.accounts.find(a => a.orderId === orderId);
  if (!account) return { updated: false, reason: 'not_found' };
  
  const now = new Date();
  account.status = 'active';
  account.lastPaidAt = now.toISOString();
  account.totalPaid += account.amountSats;
  account.consecutiveMissed = 0;
  account.currentInvoice = null;
  
  // Advance to next billing cycle
  const nextDate = new Date(new Date(account.nextBillingDate).getTime() + BILLING_CYCLE_MS);
  account.nextBillingDate = nextDate.toISOString();
  
  saveBillingAccounts(data);
  logBillingEvent(orderId, 'paid', { amountSats: account.amountSats, nextBillingDate: account.nextBillingDate });
  
  return { updated: true, nextBillingDate: account.nextBillingDate };
}

/**
 * Suspend an account (too many missed payments).
 * Disables monitoring in the registry.
 */
export function suspendAccount(orderId) {
  const data = loadBillingAccounts();
  const account = data.accounts.find(a => a.orderId === orderId);
  if (!account) return { updated: false, reason: 'not_found' };
  
  account.status = 'suspended';
  account.consecutiveMissed++;
  account.suspendedAt = new Date().toISOString();
  account.currentInvoice = null;
  
  saveBillingAccounts(data);
  logBillingEvent(orderId, 'suspended', { consecutiveMissed: account.consecutiveMissed });
  
  return { updated: true };
}

/**
 * Get a summary of all billing accounts.
 */
export function getBillingStatus() {
  const data = loadBillingAccounts();
  const now = new Date();
  
  const summary = {
    totalAccounts: data.accounts.length,
    active: 0,
    invoiced: 0,
    grace: 0,
    suspended: 0,
    totalRevenue: 0,
    monthlyRecurring: 0,
    accounts: [],
  };
  
  for (const account of data.accounts) {
    summary[account.status]++;
    summary.totalRevenue += account.totalPaid;
    
    if (account.status !== 'suspended') {
      summary.monthlyRecurring += account.amountSats;
    }
    
    const daysUntilBilling = Math.round((new Date(account.nextBillingDate) - now) / (24 * 60 * 60 * 1000));
    
    summary.accounts.push({
      orderId: account.orderId,
      endpoint: account.endpointUrl,
      status: account.status,
      daysUntilBilling,
      totalPaid: account.totalPaid,
      invoiceCount: account.invoiceCount,
    });
  }
  
  return summary;
}

/**
 * Log a billing event for audit trail.
 */
function logBillingEvent(orderId, event, details = {}) {
  ensureDir(DATA_DIR);
  
  let log = [];
  if (existsSync(BILLING_LOG)) {
    try { log = JSON.parse(readFileSync(BILLING_LOG, 'utf8')); } catch {}
  }
  if (!Array.isArray(log)) log = [];
  
  log.push({
    timestamp: new Date().toISOString(),
    orderId,
    event,
    ...details,
  });
  
  writeFileSync(BILLING_LOG, JSON.stringify(log, null, 2));
}

/**
 * Notify monitoring partner about billing events.
 */
async function notifyPartnerBilling(account, event) {
  if (!KARL_CONVERSATION_ID) return;
  
  const messages = {
    invoice_generated: `📋 Monthly invoice generated for ${account.endpointUrl}\n\nAmount: ${account.amountSats} sats\nYour share (60%): ${Math.round(account.amountSats * 0.6)} sats\nOrder: ${account.orderId}`,
    payment_received: `✅ Monthly payment received for ${account.endpointUrl}\n\nAmount: ${account.amountSats} sats\nYour share (60%): ${Math.round(account.amountSats * 0.6)} sats\nTotal revenue from this customer: ${account.totalPaid} sats`,
    suspended: `⚠️ Account suspended for ${account.endpointUrl}\n\nReason: missed payment (${account.consecutiveMissed} consecutive)\nMonitoring paused until payment received.`,
  };
  
  const msg = messages[event];
  if (!msg) return;
  
  try {
    await fetch(`${MOLTBOOK_API}/agents/dm/conversations/${KARL_CONVERSATION_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': MOLTBOOK_API_KEY },
      body: JSON.stringify({ message: msg }),
    });
  } catch (err) {
    console.log(`  Billing notification error: ${err.message}`);
  }
}

/**
 * Run the billing check cycle. Designed to be called from cron.
 * 
 * Steps:
 * 1. Check for accounts with due billing dates
 * 2. For due accounts: create invoice (via callback), mark as invoiced
 * 3. For invoiced accounts past grace period: suspend
 * 4. Return summary of actions taken
 */
export async function runBillingCycle(opts = {}) {
  const { createInvoiceFn, dryRun = false } = opts;
  const now = new Date();
  const { due, grace, suspended } = checkDueAccounts(now);
  
  console.log(`\n=== Billing Cycle ${now.toISOString().slice(0, 10)} ===`);
  console.log(`  Due: ${due.length}, Grace expired: ${grace.length}, Already suspended: ${suspended.length}`);
  
  const actions = { invoicesGenerated: 0, accountsSuspended: 0, errors: 0 };
  
  // Generate invoices for due accounts
  for (const account of due) {
    const memo = buildInvoiceMemo(account);
    console.log(`  Generating invoice: ${account.endpointUrl} — ${account.amountSats} sats`);
    
    if (dryRun) {
      console.log(`    [DRY RUN] Would create invoice: ${memo}`);
      actions.invoicesGenerated++;
      continue;
    }
    
    if (createInvoiceFn) {
      try {
        const invoice = await createInvoiceFn(account.amountSats, memo);
        markInvoiced(account.orderId, {
          paymentHash: invoice.paymentHash || invoice.r_hash,
          bolt11: invoice.bolt11 || invoice.payment_request,
          amountSats: account.amountSats,
          memo,
        });
        await notifyPartnerBilling(account, 'invoice_generated');
        actions.invoicesGenerated++;
        console.log(`    Invoice created: ${(invoice.bolt11 || invoice.payment_request || '').slice(0, 40)}...`);
      } catch (err) {
        console.error(`    Error creating invoice: ${err.message}`);
        actions.errors++;
      }
    } else {
      console.log(`    No createInvoiceFn provided — marking as invoiced with placeholder`);
      markInvoiced(account.orderId, {
        paymentHash: 'pending-' + Date.now(),
        bolt11: null,
        amountSats: account.amountSats,
        memo,
      });
      actions.invoicesGenerated++;
    }
  }
  
  // Suspend grace-expired accounts
  for (const account of grace) {
    console.log(`  Suspending: ${account.endpointUrl} — grace period expired`);
    
    if (dryRun) {
      console.log(`    [DRY RUN] Would suspend`);
      actions.accountsSuspended++;
      continue;
    }
    
    suspendAccount(account.orderId);
    await notifyPartnerBilling(account, 'suspended');
    actions.accountsSuspended++;
  }
  
  console.log(`=== Billing complete: ${actions.invoicesGenerated} invoices, ${actions.accountsSuspended} suspensions ===\n`);
  return actions;
}

// CLI entry point
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/billing.js') ||
  process.argv[1] === fileURLToPath(import.meta.url)
);

if (isMain) {
  const args = process.argv.slice(2);
  
  if (args.includes('--status')) {
    const status = getBillingStatus();
    console.log('\n=== Billing Status ===');
    console.log(`Total accounts: ${status.totalAccounts}`);
    console.log(`Active: ${status.active}, Invoiced: ${status.invoiced}, Grace: ${status.grace}, Suspended: ${status.suspended}`);
    console.log(`Total revenue: ${status.totalRevenue} sats`);
    console.log(`Monthly recurring: ${status.monthlyRecurring} sats`);
    if (status.accounts.length) {
      console.log('\nAccounts:');
      for (const a of status.accounts) {
        console.log(`  ${a.endpoint} — ${a.status} — ${a.daysUntilBilling}d until billing — ${a.totalPaid} sats total`);
      }
    }
  } else if (args.includes('--check')) {
    const { due, grace, suspended, total } = checkDueAccounts();
    console.log(`\nBilling check (${total} accounts):`);
    console.log(`  Due for invoice: ${due.length}`);
    console.log(`  Grace period expired: ${grace.length}`);
    console.log(`  Suspended: ${suspended.length}`);
    for (const a of due) {
      console.log(`  → ${a.endpointUrl} (${a.orderId}) — ${a.amountSats} sats`);
    }
  } else if (args.includes('--generate')) {
    const dryRun = args.includes('--dry-run');
    runBillingCycle({ dryRun }).catch(err => {
      console.error('Billing cycle failed:', err);
      process.exit(1);
    });
  } else {
    console.log('Usage:');
    console.log('  node src/billing.js --status                # Show all accounts');
    console.log('  node src/billing.js --check                 # Check for due invoices');
    console.log('  node src/billing.js --generate              # Generate invoices');
    console.log('  node src/billing.js --generate --dry-run    # Dry run');
  }
}
