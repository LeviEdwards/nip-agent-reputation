/**
 * Tests for the billing module.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = join(__dirname, '..');
const DATA_DIR = join(REPO_DIR, 'data');
const TEST_BILLING_FILE = join(DATA_DIR, 'billing-accounts.json');
const TEST_BILLING_LOG = join(DATA_DIR, 'billing-log.json');

// Save originals before tests
let origBilling = null;
let origLog = null;

function backupFiles() {
  if (existsSync(TEST_BILLING_FILE)) {
    origBilling = readFileSync(TEST_BILLING_FILE, 'utf8');
  }
  if (existsSync(TEST_BILLING_LOG)) {
    origLog = readFileSync(TEST_BILLING_LOG, 'utf8');
  }
}

function restoreFiles() {
  if (origBilling !== null) {
    writeFileSync(TEST_BILLING_FILE, origBilling);
  } else if (existsSync(TEST_BILLING_FILE)) {
    rmSync(TEST_BILLING_FILE);
  }
  if (origLog !== null) {
    writeFileSync(TEST_BILLING_LOG, origLog);
  } else if (existsSync(TEST_BILLING_LOG)) {
    rmSync(TEST_BILLING_LOG);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(`FAIL: ${msg}`);
}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

// Clean state for each test
function resetBillingState() {
  if (existsSync(TEST_BILLING_FILE)) rmSync(TEST_BILLING_FILE);
  if (existsSync(TEST_BILLING_LOG)) rmSync(TEST_BILLING_LOG);
}

// Dynamic import to get fresh module state
async function importBilling() {
  // We need fresh reads each time since the module reads from disk
  const mod = await import('../src/billing.js');
  return mod;
}

const sampleOrder = {
  orderId: 'test-billing-001',
  endpoint_url: 'https://example.com',
  nostr_pubkey: '0000000000000000000000000000000000000000000000000000000000000001',
  contact: 'test@example.com',
  amount_sats: 5000,
  monitoring_started_at: '2026-03-01T00:00:00.000Z',
};

console.log('\n=== Billing Module Tests ===\n');

backupFiles();

try {
  // Test: addToBilling creates account
  await test('addToBilling creates new account', async () => {
    resetBillingState();
    const { addToBilling, loadBillingAccounts } = await importBilling();
    
    const result = addToBilling(sampleOrder);
    assert(result.added === true, 'should be added');
    assert(result.nextBillingDate, 'should have next billing date');
    
    const data = loadBillingAccounts();
    assert(data.accounts.length === 1, 'should have 1 account');
    assert(data.accounts[0].orderId === 'test-billing-001', 'correct orderId');
    assert(data.accounts[0].status === 'active', 'status should be active');
    assert(data.accounts[0].totalPaid === 5000, 'totalPaid should be initial amount');
  });

  // Test: addToBilling rejects duplicates
  await test('addToBilling rejects duplicates', async () => {
    resetBillingState();
    const { addToBilling } = await importBilling();
    
    addToBilling(sampleOrder);
    const result = addToBilling(sampleOrder);
    assert(result.added === false, 'should not add duplicate');
    assert(result.reason === 'duplicate', 'reason should be duplicate');
  });

  // Test: billing date is ~30 days from fulfillment
  await test('next billing date is ~30 days from fulfillment', async () => {
    resetBillingState();
    const { addToBilling } = await importBilling();
    
    const result = addToBilling(sampleOrder);
    const nextDate = new Date(result.nextBillingDate);
    const fulfillDate = new Date(sampleOrder.monitoring_started_at);
    const diffDays = (nextDate - fulfillDate) / (24 * 60 * 60 * 1000);
    
    assert(Math.abs(diffDays - 30) < 1, `should be ~30 days, got ${diffDays}`);
  });

  // Test: checkDueAccounts identifies due accounts
  await test('checkDueAccounts identifies due accounts', async () => {
    resetBillingState();
    const { addToBilling, checkDueAccounts } = await importBilling();
    
    // Add account with fulfillment 31 days ago (billing already due)
    const oldOrder = {
      ...sampleOrder,
      monitoring_started_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    };
    addToBilling(oldOrder);
    
    const result = checkDueAccounts();
    assert(result.due.length === 1, 'should have 1 due account');
    assert(result.due[0].orderId === 'test-billing-001', 'correct orderId');
  });

  // Test: checkDueAccounts — not yet due
  await test('checkDueAccounts skips accounts not yet due', async () => {
    resetBillingState();
    const { addToBilling, checkDueAccounts } = await importBilling();
    
    // Add account with recent fulfillment (billing not yet due)
    const recentOrder = {
      ...sampleOrder,
      monitoring_started_at: new Date().toISOString(),
    };
    addToBilling(recentOrder);
    
    const result = checkDueAccounts();
    assert(result.due.length === 0, 'should have 0 due accounts');
  });

  // Test: markInvoiced updates status
  await test('markInvoiced updates account status', async () => {
    resetBillingState();
    const { addToBilling, markInvoiced, loadBillingAccounts } = await importBilling();
    
    addToBilling(sampleOrder);
    markInvoiced('test-billing-001', {
      paymentHash: 'abc123',
      bolt11: 'lnbc1000n1...',
      amountSats: 1000,
      memo: 'test invoice',
    });
    
    const data = loadBillingAccounts();
    const account = data.accounts[0];
    assert(account.status === 'invoiced', 'status should be invoiced');
    assert(account.currentInvoice.paymentHash === 'abc123', 'should have payment hash');
    assert(account.invoiceCount === 1, 'invoice count should be 1');
  });

  // Test: markPaid advances billing cycle
  await test('markPaid advances billing cycle', async () => {
    resetBillingState();
    const { addToBilling, markInvoiced, markPaid, loadBillingAccounts } = await importBilling();
    
    addToBilling(sampleOrder);
    markInvoiced('test-billing-001', { paymentHash: 'abc', bolt11: 'lnbc...', amountSats: 1000, memo: 'test' });
    
    const result = markPaid('test-billing-001');
    assert(result.updated === true, 'should be updated');
    
    const data = loadBillingAccounts();
    const account = data.accounts[0];
    assert(account.status === 'active', 'status should be active after payment');
    assert(account.totalPaid === 6000, 'totalPaid should be 5000 + 1000');
    assert(account.consecutiveMissed === 0, 'missed should reset to 0');
    assert(account.currentInvoice === null, 'current invoice should be cleared');
    assert(account.lastPaidAt !== null, 'lastPaidAt should be set');
    
    // Next billing date should be ~30 days after previous
    const nextDate = new Date(account.nextBillingDate);
    const prevDate = new Date(sampleOrder.monitoring_started_at);
    const diffDays = (nextDate - prevDate) / (24 * 60 * 60 * 1000);
    assert(Math.abs(diffDays - 60) < 2, `next billing ~60 days from start, got ${diffDays}`);
  });

  // Test: suspendAccount
  await test('suspendAccount sets status and increments missed', async () => {
    resetBillingState();
    const { addToBilling, suspendAccount, loadBillingAccounts } = await importBilling();
    
    addToBilling(sampleOrder);
    suspendAccount('test-billing-001');
    
    const data = loadBillingAccounts();
    const account = data.accounts[0];
    assert(account.status === 'suspended', 'status should be suspended');
    assert(account.consecutiveMissed === 1, 'missed should be 1');
    assert(account.suspendedAt !== null, 'suspendedAt should be set');
  });

  // Test: getBillingStatus summary
  await test('getBillingStatus returns correct summary', async () => {
    resetBillingState();
    const { addToBilling, suspendAccount, getBillingStatus } = await importBilling();
    
    addToBilling(sampleOrder);
    addToBilling({ ...sampleOrder, orderId: 'test-billing-002', endpoint_url: 'https://example2.com' });
    suspendAccount('test-billing-002');
    
    const status = getBillingStatus();
    assert(status.totalAccounts === 2, 'should have 2 accounts');
    assert(status.active === 1, 'should have 1 active');
    assert(status.suspended === 1, 'should have 1 suspended');
    assert(status.totalRevenue === 10000, 'total revenue should be 10000 (2x5000)');
    assert(status.monthlyRecurring === 1000, 'MRR should be 1000 (only active)');
  });

  // Test: runBillingCycle dry run
  await test('runBillingCycle dry run processes due accounts', async () => {
    resetBillingState();
    const { addToBilling, runBillingCycle } = await importBilling();
    
    // Add account with billing already due
    const oldOrder = {
      ...sampleOrder,
      monitoring_started_at: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
    };
    addToBilling(oldOrder);
    
    const actions = await runBillingCycle({ dryRun: true });
    assert(actions.invoicesGenerated === 1, 'should generate 1 invoice in dry run');
  });

  // Test: billing log is written
  await test('billing events are logged', async () => {
    resetBillingState();
    const { addToBilling, markInvoiced, markPaid } = await importBilling();
    
    addToBilling(sampleOrder);
    markInvoiced('test-billing-001', { paymentHash: 'abc', bolt11: 'lnbc...', amountSats: 1000, memo: 'test' });
    markPaid('test-billing-001');
    
    const logPath = join(DATA_DIR, 'billing-log.json');
    assert(existsSync(logPath), 'billing log should exist');
    const log = JSON.parse(readFileSync(logPath, 'utf8'));
    assert(log.length >= 1, 'should have at least 1 log entry');
    assert(log.some(e => e.event === 'paid'), 'should have paid event');
  });

  // Test: buildInvoiceMemo format
  await test('buildInvoiceMemo includes endpoint and month', async () => {
    const { buildInvoiceMemo } = await importBilling();
    const memo = buildInvoiceMemo({ endpointUrl: 'https://example.com', amountSats: 1000 });
    assert(memo.includes('example.com'), 'memo should include endpoint');
    assert(memo.includes('NIP-30386'), 'memo should include NIP reference');
    assert(/\d{4}-\d{2}/.test(memo), 'memo should include YYYY-MM date');
  });

} finally {
  // Always restore original files
  restoreFiles();
}

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);
if (failed > 0) process.exit(1);
