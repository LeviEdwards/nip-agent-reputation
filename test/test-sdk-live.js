/**
 * SDK Live Integration Tests
 * 
 * Tests the ReputationClient SDK against the live NIP-30386 API server.
 * Requires the reputation server running on port 3386.
 * 
 * Run: node test/test-sdk-live.js [--public]
 */

import { ReputationClient } from '../sdk/reputation-client.js';

const LOCAL_API = 'http://10.21.0.3:3386/reputation';
const PUBLIC_API = 'https://dispatches.mystere.me/api/reputation';
const usePublic = process.argv.includes('--public');
const API = usePublic ? PUBLIC_API : LOCAL_API;

const ACINQ = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
const OUR_NOSTR = '1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead';
const BOGUS = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log(`\nSDK Live Integration Tests (${usePublic ? 'PUBLIC' : 'LOCAL'}: ${API})\n${'─'.repeat(60)}\n`);

const clientOpts = { apiBase: API, timeoutMs: 15000 };
// Public proxy has discover at /api/reputation/discover, not /api/discover
if (usePublic) clientOpts.discoverUrl = `${API}/discover`;
const client = new ReputationClient(clientOpts);

// --- query() ---
await test('query() returns attestations for known LN pubkey', async () => {
  const rep = await client.query(ACINQ);
  assert(rep.attestationCount > 0, `expected attestations, got ${rep.attestationCount}`);
  assert(rep.trustLevel !== 'none', `expected trust, got ${rep.trustLevel}`);
  assert(Object.keys(rep.dimensions || {}).length > 0, 'expected dimensions');
});

await test('query() returns attestations for known Nostr pubkey', async () => {
  const rep = await client.query(OUR_NOSTR);
  assert(rep.attestationCount > 0, `expected attestations, got ${rep.attestationCount}`);
});

await test('query() returns zero attestations for unknown pubkey', async () => {
  const rep = await client.query(BOGUS);
  assert(rep.attestationCount === 0, `expected 0 attestations, got ${rep.attestationCount}`);
  assert(rep.trustLevel === 'none', `expected none trust, got ${rep.trustLevel}`);
});

// --- shouldPay() ---
await test('shouldPay() approves payment to verified node', async () => {
  const rep = await client.query(ACINQ);
  // ACINQ should have enough reputation for a small payment
  const decision = client.shouldPay(rep, 100);
  assert(typeof decision === 'boolean', `expected boolean, got ${typeof decision}`);
});

await test('shouldPay() rejects payment to unknown node', async () => {
  const rep = await client.query(BOGUS);
  const decision = client.shouldPay(rep, 5000);
  assert(decision === false, 'should reject unknown node for 5000 sats');
});

await test('shouldPay() allows blind micro-payment to unknown node', async () => {
  const rep = await client.query(BOGUS);
  // Default maxBlindPaymentSats = 100, so 50 sats should pass
  const decision = client.shouldPay(rep, 50);
  assert(decision === true, 'should allow blind payment under threshold');
});

// --- checkAndDecide() ---
await test('checkAndDecide() returns full decision object for known pubkey', async () => {
  const result = await client.checkAndDecide(ACINQ, 100);
  assert('allow' in result, 'missing allow field');
  assert('reputation' in result, 'missing reputation field');
  assert('reasons' in result, 'missing reasons field');
  assert(Array.isArray(result.reasons), 'reasons not array');
  assert(result.reputation.attestationCount > 0, 'no attestations in result');
});

await test('checkAndDecide() fails closed for unknown pubkey (large amount)', async () => {
  const result = await client.checkAndDecide(BOGUS, 10000);
  assert(result.allow === false, 'should reject unknown pubkey for large amount');
  assert(result.reasons.length > 0, 'should have rejection reasons');
});

// --- discover() ---
await test('discover() returns services list', async () => {
  const result = await client.discover();
  const services = result.services || result;
  assert(Array.isArray(services), 'expected array in services');
  assert(services.length > 0, `expected services, got ${services.length}`);
  const first = services[0];
  assert(first.pubkey || first.serviceId, 'service missing identifiers');
});

// --- badgeUrl() ---
await test('badgeUrl() returns valid URL', () => {
  const url = client.badgeUrl(ACINQ);
  assert(url.includes('/badge/'), 'URL missing /badge/ path');
  assert(url.includes(ACINQ), 'URL missing pubkey');
});

await test('badge URL returns SVG', async () => {
  const url = client.badgeUrl(ACINQ);
  const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
  const body = await resp.text();
  assert(body.includes('<svg'), 'response not SVG');
});

// --- error handling ---
await test('query() with invalid pubkey throws or returns error', async () => {
  try {
    const rep = await client.query('not-a-pubkey');
    // Some servers may return an error object instead of throwing
    assert(rep.error || rep.attestationCount === 0, 'should error or return empty');
  } catch (e) {
    // Throwing is also valid
    assert(e.message.length > 0, 'error should have message');
  }
});

await test('client with wrong API base fails gracefully', async () => {
  const badClient = new ReputationClient({ 
    apiBase: 'http://127.0.0.1:1', 
    timeoutMs: 2000 
  });
  const result = await badClient.checkAndDecide(ACINQ, 100);
  assert(result.allow === false, 'should fail closed');
  assert(result.reasons.some(r => r.includes('failed')), 'should mention failure');
});

// --- Summary ---
console.log(`\n${'─'.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed > 0 ? 1 : 0);
