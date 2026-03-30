/**
 * Tests for the fulfillment module (src/fulfill.js).
 * Tests order fulfillment workflow: registry add, probe, publish, order update.
 */

import { strict as assert } from 'assert';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = join(__dirname, '..');
const TEST_DIR = join(PROJECT_DIR, 'data', 'test-fulfill');
const TEST_REGISTRY = join(TEST_DIR, 'test-registry.json');

// Setup/teardown
function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

function teardown() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
}

// Helper to create test order
function createTestOrder(opts = {}) {
  const order = {
    orderId: opts.orderId || 'testord001',
    endpoint_url: opts.endpoint_url || 'https://httpbin.org/get',
    nostr_pubkey: opts.nostr_pubkey || 'aabbccdd',
    contact: opts.contact || 'test@test.com',
    paid: opts.paid !== undefined ? opts.paid : true,
    paid_at: opts.paid_at || '2026-03-26T00:00:00Z',
    ...(opts.monitoring_started !== undefined && { monitoring_started: opts.monitoring_started }),
    ...(opts.first_attestation_event && { first_attestation_event: opts.first_attestation_event }),
  };
  const path = join(TEST_DIR, `${order.orderId}.json`);
  writeFileSync(path, JSON.stringify(order, null, 2));
  return path;
}

let passed = 0;
let failed = 0;

function test(name, fn) {
  return { name, fn };
}

const tests = [

  test('fulfillOrder skips unpaid orders', async () => {
    const { fulfillOrder } = await import('../src/fulfill.js');
    const orderPath = createTestOrder({ orderId: 'unpaid01', paid: false });
    const result = await fulfillOrder(orderPath, { dryRun: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'not_paid');
  }),

  test('fulfillOrder skips already-fulfilled orders', async () => {
    const { fulfillOrder } = await import('../src/fulfill.js');
    const orderPath = createTestOrder({
      orderId: 'fulfilled01',
      monitoring_started: true,
      first_attestation_event: 'abc123',
    });
    const result = await fulfillOrder(orderPath, { dryRun: true });
    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'already_fulfilled');
  }),

  test('fulfillOrder probes endpoint in dry-run mode', async () => {
    const { fulfillOrder } = await import('../src/fulfill.js');
    const orderPath = createTestOrder({ orderId: 'probe01' });
    const result = await fulfillOrder(orderPath, { dryRun: true });
    assert.ok(!result.skipped, 'Should not be skipped');
    assert.ok(result.dryRun, 'Should be dry run');
    assert.ok(result.probeResults, 'Should have probe results');
    assert.ok(result.probeResults.total > 0, 'Should have probed');
    assert.ok(result.dimensions, 'Should have dimensions');
  }),

  test('fulfillOrder adds endpoint to registry', async () => {
    // Check the default registry was populated
    const registryPath = join(PROJECT_DIR, 'data', 'monitor-registry.json');
    if (existsSync(registryPath)) {
      const reg = JSON.parse(readFileSync(registryPath, 'utf8'));
      const entry = reg.endpoints.find(e => e.orderId === 'probe01');
      assert.ok(entry, 'Should find probe01 in registry');
      assert.equal(entry.tier, 'paid');
      assert.equal(entry.url, 'https://httpbin.org/get');
    }
  }),

  test('scanAndFulfill processes multiple orders', async () => {
    const { scanAndFulfill } = await import('../src/fulfill.js');
    // Use a dedicated subdirectory so prior test artifacts don't interfere
    const scanDir = join(TEST_DIR, 'scan-batch');
    mkdirSync(scanDir, { recursive: true });
    
    // Create a mix: paid, unpaid, already fulfilled
    const mkOrder = (opts) => {
      const o = { orderId: opts.orderId, endpoint_url: opts.endpoint_url || 'https://httpbin.org/get',
        nostr_pubkey: 'aabb', contact: 'test', paid: opts.paid !== undefined ? opts.paid : true,
        ...(opts.monitoring_started !== undefined && { monitoring_started: opts.monitoring_started }),
        ...(opts.first_attestation_event && { first_attestation_event: opts.first_attestation_event }),
      };
      writeFileSync(join(scanDir, `${o.orderId}.json`), JSON.stringify(o, null, 2));
    };
    
    mkOrder({ orderId: 'scan01', paid: true });
    mkOrder({ orderId: 'scan02', paid: false });
    mkOrder({ orderId: 'scan03', paid: true, monitoring_started: true, first_attestation_event: 'xyz' });
    
    const result = await scanAndFulfill(scanDir, { dryRun: true });
    assert.equal(result.skipped, 2, 'Should skip unpaid + already fulfilled');
    // scan01 should have been processed (dry run, so fulfilled=0)
  }),

  test('scanAndFulfill handles empty directory', async () => {
    const { scanAndFulfill } = await import('../src/fulfill.js');
    const emptyDir = join(TEST_DIR, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const result = await scanAndFulfill(emptyDir, { dryRun: true });
    assert.equal(result.fulfilled, 0);
  }),

  test('scanAndFulfill handles missing directory', async () => {
    const { scanAndFulfill } = await import('../src/fulfill.js');
    const result = await scanAndFulfill('/nonexistent/path', { dryRun: true });
    assert.equal(result.fulfilled, 0);
  }),

];

// Run tests
console.log('=== Fulfillment Module Tests ===\n');

setup();

for (const t of tests) {
  try {
    await t.fn();
    console.log(`  ✓ ${t.name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${t.name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

teardown();

// Clean up registry entries from tests
const registryPath = join(PROJECT_DIR, 'data', 'monitor-registry.json');
if (existsSync(registryPath)) {
  try {
    const reg = JSON.parse(readFileSync(registryPath, 'utf8'));
    reg.endpoints = reg.endpoints.filter(e => !['testord001', 'probe01', 'scan01'].includes(e.orderId));
    writeFileSync(registryPath, JSON.stringify(reg, null, 2));
  } catch {}
}

// Clean up fulfillment log from tests
const logPath = join(PROJECT_DIR, 'data', 'fulfillment-log.json');
if (existsSync(logPath)) {
  try {
    const log = JSON.parse(readFileSync(logPath, 'utf8'));
    const cleaned = log.filter(e => !['testord001', 'probe01', 'scan01'].includes(e.orderId));
    writeFileSync(logPath, JSON.stringify(cleaned, null, 2));
  } catch {}
}

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
process.exit(failed > 0 ? 1 : 0);
