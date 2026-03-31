#!/usr/bin/env node
/**
 * Tests for the NIP-30386 Reputation Client SDK
 */

import { ReputationClient } from '../sdk/reputation-client.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.log(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

// ─── Unit tests (no network) ───────────────────────────────────────

console.log('=== ReputationClient constructor ===');
{
  const client = new ReputationClient();
  assert(client.apiBase === 'https://dispatches.mystere.me/api/reputation', 'default API base');
  assert(client.timeoutMs === 10000, 'default timeout');
  assert(client.policy.minSettlementRate === 0.90, 'default policy minSettlementRate');
}
{
  const client = new ReputationClient({ apiBase: 'http://localhost:3386', timeoutMs: 5000 });
  assert(client.apiBase === 'http://localhost:3386', 'custom API base');
  assert(client.timeoutMs === 5000, 'custom timeout');
}
{
  const client = new ReputationClient({ policy: { maxBlindPaymentSats: 500 } });
  assert(client.policy.maxBlindPaymentSats === 500, 'custom policy override');
  assert(client.policy.minSettlementRate === 0.90, 'default policy preserved');
}
{
  // String shorthand constructor
  const client = new ReputationClient('http://localhost:3386');
  assert(client.apiBase === 'http://localhost:3386', 'string constructor sets apiBase');
  assert(client.timeoutMs === 10000, 'string constructor uses default timeout');
}

console.log('\n=== badgeUrl ===');
{
  const client = new ReputationClient();
  const hex = 'ab'.repeat(32);
  assert(client.badgeUrl(hex).includes('/badge/' + hex), 'badge URL contains pubkey');
  assert(client.badgeUrl(hex).startsWith('https://dispatches.mystere.me'), 'badge URL uses default base');
}

console.log('\n=== evaluate — no attestations ===');
{
  const client = new ReputationClient();
  const noRep = { attestationCount: 0, dimensions: {}, trustLevel: 'none' };
  
  const small = client.evaluate(noRep, 50);
  assert(small.allow === true, 'allow small blind payment (50 sats)');
  assert(small.reasons[0].includes('blind payment'), 'reason mentions blind payment');
  
  const large = client.evaluate(noRep, 5000);
  assert(large.allow === false, 'deny larger blind payment (5000 sats)');
  assert(large.reasons[0].includes('no reputation'), 'reason mentions no reputation');
}

console.log('\n=== evaluate — good reputation ===');
{
  const client = new ReputationClient();
  const goodRep = {
    attestationCount: 5,
    trustLevel: 'verified',
    selfOnly: false,
    dimensions: {
      settlement_rate: { weightedAvg: 0.98, totalWeight: 1.5, numAttesters: 3 },
      payment_success_rate: { weightedAvg: 0.99, totalWeight: 1.5, numAttesters: 3 },
    },
  };
  
  const r1 = client.evaluate(goodRep, 1000);
  assert(r1.allow === true, 'allow normal payment with good reputation');
  
  const r2 = client.evaluate(goodRep, 100000);
  assert(r2.allow === true, 'allow large payment with strong weight');
}

console.log('\n=== evaluate — weak reputation ===');
{
  const client = new ReputationClient();
  const weakRep = {
    attestationCount: 1,
    trustLevel: 'low',
    selfOnly: true,
    dimensions: {
      settlement_rate: { weightedAvg: 0.95, totalWeight: 0.3, numAttesters: 1 },
    },
  };
  
  const r1 = client.evaluate(weakRep, 1000);
  assert(r1.allow === true, 'allow small payment with weak-but-passing reputation');
  
  const r2 = client.evaluate(weakRep, 100000);
  assert(r2.allow === false, 'deny large payment with self-only attestation');
  assert(r2.reasons.some(r => r.includes('self-attestations') || r.includes('weight')), 'reason explains why');
}

console.log('\n=== evaluate — bad reputation ===');
{
  const client = new ReputationClient();
  const badRep = {
    attestationCount: 3,
    trustLevel: 'moderate',
    selfOnly: false,
    dimensions: {
      settlement_rate: { weightedAvg: 0.70, totalWeight: 1.0, numAttesters: 2 },
      dispute_rate: { weightedAvg: 0.15, totalWeight: 1.0, numAttesters: 2 },
    },
  };
  
  const r = client.evaluate(badRep, 1000);
  assert(r.allow === false, 'deny payment with bad settlement rate');
  assert(r.reasons.some(r => r.includes('settlement_rate')), 'cites settlement_rate');
  assert(r.reasons.some(r => r.includes('dispute_rate')), 'cites dispute_rate');
}

console.log('\n=== shouldPay shorthand ===');
{
  const client = new ReputationClient();
  const good = { attestationCount: 5, trustLevel: 'verified', dimensions: { settlement_rate: { weightedAvg: 0.99, totalWeight: 2.0 } } };
  assert(client.shouldPay(good, 1000) === true, 'shouldPay returns true for good rep');
  assert(client.shouldPay({ attestationCount: 0 }, 5000) === false, 'shouldPay returns false for no rep + large amount');
}

console.log('\n=== evaluate with custom policy ===');
{
  const strict = new ReputationClient({ policy: { minSettlementRate: 0.99, maxBlindPaymentSats: 0 } });
  const rep = {
    attestationCount: 2,
    trustLevel: 'moderate',
    dimensions: { settlement_rate: { weightedAvg: 0.95, totalWeight: 0.5 } },
  };
  assert(strict.evaluate(rep, 100).allow === false, 'strict policy rejects 0.95 settlement rate');
  assert(strict.evaluate({ attestationCount: 0 }, 1).allow === false, 'strict policy rejects all blind payments');
}

// ─── Live API tests (requires network + running server) ────────────

console.log('\n=== Live API query (public API) ===');
{
  const client = new ReputationClient({ timeoutMs: 15000 });
  try {
    const rep = await client.query('1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead');
    assert(rep.attestationCount > 0, `live query returned ${rep.attestationCount} attestations`);
    assert(rep.trustLevel === 'verified', `trust level is ${rep.trustLevel}`);
    assert(rep.dimensions !== undefined, 'has dimensions');
    
    const decision = client.evaluate(rep, 1000);
    assert(decision.allow === true, 'live reputation passes 1000 sat payment gate');
  } catch (err) {
    console.log(`  ⚠ Live test skipped: ${err.message}`);
  }
}

console.log('\n=== Live checkAndDecide ===');
{
  const client = new ReputationClient({ timeoutMs: 15000 });
  try {
    const result = await client.checkAndDecide('1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead', 500);
    assert(result.allow === true, 'checkAndDecide allows payment to verified agent');
    assert(result.reputation !== null, 'includes reputation data');
  } catch (err) {
    console.log(`  ⚠ Live test skipped: ${err.message}`);
  }
}

console.log('\n=== Live query — unknown pubkey ===');
{
  const client = new ReputationClient({ timeoutMs: 15000 });
  try {
    const rep = await client.query('00'.repeat(32));
    assert(rep.attestationCount === 0, 'unknown pubkey has 0 attestations');
    assert(rep.trustLevel === 'none', 'trust level is none');
    assert(client.shouldPay(rep, 5000) === false, 'should not pay unknown agent 5000 sats');
    assert(client.shouldPay(rep, 50) === true, 'ok to pay unknown agent 50 sats (blind limit)');
  } catch (err) {
    console.log(`  ⚠ Live test skipped: ${err.message}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) process.exit(1);
