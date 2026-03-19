#!/usr/bin/env node

/**
 * Tests for bilateral attestation builder.
 * 
 * Run: node src/test-bilateral.js
 */

import { verifyEvent } from 'nostr-tools/pure';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  TransactionRecord,
  TransactionHistory,
  buildBilateralAttestation,
  buildBilateralFromHistory,
} from './bilateral.js';
import { parseAttestation, aggregateAttestations } from './attestation.js';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertApprox(actual, expected, epsilon, msg) {
  assert(Math.abs(actual - expected) < epsilon, `${msg} (${actual} ≈ ${expected})`);
}

// =====================================================
// Test 1: TransactionRecord construction
// =====================================================
console.log('\n=== TransactionRecord ===');
{
  const tx = new TransactionRecord({
    counterpartyNodePubkey: '03' + 'a'.repeat(64),
    serviceType: 'data-api',
    invoiceAmountSats: 500,
    settled: true,
    responseTimeMs: 320,
    disputeOccurred: false,
  });
  assert(tx.counterpartyNodePubkey === '03' + 'a'.repeat(64), 'stores node pubkey');
  assert(tx.serviceType === 'data-api', 'stores service type');
  assert(tx.invoiceAmountSats === 500, 'stores amount');
  assert(tx.settled === true, 'stores settlement status');
  assert(tx.responseTimeMs === 320, 'stores response time');
  assert(tx.disputeOccurred === false, 'stores dispute flag');
  assert(tx.timestamp > 0, 'auto-generates timestamp');
}

// =====================================================
// Test 2: TransactionHistory basic operations
// =====================================================
console.log('\n=== TransactionHistory ===');
{
  const history = new TransactionHistory();
  const nodePub = '03' + 'b'.repeat(64);
  const otherPub = '03' + 'c'.repeat(64);

  history.add({
    counterpartyNodePubkey: nodePub,
    invoiceAmountSats: 1000,
    settled: true,
    responseTimeMs: 200,
  });
  history.add({
    counterpartyNodePubkey: nodePub,
    invoiceAmountSats: 500,
    settled: true,
    responseTimeMs: 350,
  });
  history.add({
    counterpartyNodePubkey: nodePub,
    invoiceAmountSats: 200,
    settled: false,
    disputeOccurred: true,
  });
  history.add({
    counterpartyNodePubkey: otherPub,
    invoiceAmountSats: 100,
    settled: true,
  });

  const txs = history.getForCounterparty(nodePub);
  assert(txs.length === 3, 'filters by counterparty');
  
  const otherTxs = history.getForCounterparty(otherPub);
  assert(otherTxs.length === 1, 'isolates different counterparties');
}

// =====================================================
// Test 3: Dimension computation
// =====================================================
console.log('\n=== Dimension Computation ===');
{
  const history = new TransactionHistory();
  const nodePub = '03' + 'd'.repeat(64);

  // 8 settled, 2 failed, 1 disputed
  for (let i = 0; i < 8; i++) {
    history.add({
      counterpartyNodePubkey: nodePub,
      invoiceAmountSats: 100,
      settled: true,
      responseTimeMs: 200 + (i * 50),
    });
  }
  history.add({
    counterpartyNodePubkey: nodePub,
    invoiceAmountSats: 100,
    settled: false,
  });
  history.add({
    counterpartyNodePubkey: nodePub,
    invoiceAmountSats: 100,
    settled: false,
    disputeOccurred: true,
  });

  const dims = history.computeDimensions(nodePub);
  assert(dims !== null, 'computes dimensions');
  assertApprox(parseFloat(dims.settlement_rate.value), 0.8, 0.001, 'settlement rate 8/10');
  assertApprox(parseFloat(dims.dispute_rate.value), 0.1, 0.001, 'dispute rate 1/10');
  assert(dims.settlement_rate.sampleSize === 10, 'sample size correct');
  assert(parseInt(dims.transaction_volume_sats.value) === 800, 'volume = 800 sats (8×100)');
  assert(dims.response_time_ms !== undefined, 'has response time');
  // Average of 200, 250, 300, 350, 400, 450, 500, 550 = 375
  assertApprox(parseFloat(dims.response_time_ms.value), 375, 1, 'avg response time');
}

// =====================================================
// Test 4: No transactions returns null
// =====================================================
console.log('\n=== Empty History ===');
{
  const history = new TransactionHistory();
  const dims = history.computeDimensions('03' + 'e'.repeat(64));
  assert(dims === null, 'returns null for no transactions');
}

// =====================================================
// Test 5: Build bilateral attestation event
// =====================================================
console.log('\n=== Build Bilateral Event ===');
{
  const sk = generateSecretKey();
  const pk = getPublicKey(sk);
  const counterpartyNode = '03' + 'f'.repeat(64);
  const counterpartyNostr = 'a'.repeat(64);

  const event = buildBilateralAttestation({
    counterpartyNodePubkey: counterpartyNode,
    counterpartyNostrPubkey: counterpartyNostr,
    serviceType: 'data-api',
    dimensions: {
      settlement_rate: { value: '0.95', sampleSize: 20 },
      response_time_ms: { value: '450', sampleSize: 18 },
    },
    halfLifeHours: 360,
    sampleWindowHours: 72,
  }, sk);

  assert(event.kind === 30078, 'kind 30078');
  assert(event.pubkey === pk, 'signed by attester');
  assert(verifyEvent(event), 'signature valid');

  // Check tags
  const tags = Object.fromEntries(event.tags.filter(t => typeof t[1] === 'string').map(t => [t[0], t]));
  assert(tags.node_pubkey[1] === counterpartyNode, 'has node_pubkey tag');
  assert(tags.p[1] === counterpartyNostr, 'has p tag with Nostr pubkey');
  assert(tags.attestation_type[1] === 'bilateral', 'type is bilateral');
  assert(tags.service_type[1] === 'data-api', 'service type correct');
  assert(tags.half_life_hours[1] === '360', 'custom half-life');
  assert(tags.sample_window_hours[1] === '72', 'custom sample window');

  // Check dimension tags
  const dimTags = event.tags.filter(t => t[0] === 'dimension');
  assert(dimTags.length === 2, 'two dimension tags');
  const settlementDim = dimTags.find(t => t[1] === 'settlement_rate');
  assert(settlementDim[2] === '0.95', 'settlement rate value');
  assert(settlementDim[3] === '20', 'settlement rate sample size');
}

// =====================================================
// Test 6: Build from history (convenience wrapper)
// =====================================================
console.log('\n=== Build From History ===');
{
  const sk = generateSecretKey();
  const nodePub = '03' + '1'.repeat(64);
  const history = new TransactionHistory();

  for (let i = 0; i < 5; i++) {
    history.add({
      counterpartyNodePubkey: nodePub,
      invoiceAmountSats: 200,
      settled: true,
      responseTimeMs: 100 + (i * 10),
    });
  }

  const event = buildBilateralFromHistory(history, nodePub, sk);
  assert(event.kind === 30078, 'builds valid event from history');
  assert(verifyEvent(event), 'signature valid');

  const dimTags = event.tags.filter(t => t[0] === 'dimension');
  assert(dimTags.length >= 3, 'has multiple dimensions');
  
  const settlementTag = dimTags.find(t => t[1] === 'settlement_rate');
  assert(settlementTag[2] === '1.0000', 'all settled = 100%');
}

// =====================================================
// Test 7: Parse bilateral through existing parser
// =====================================================
console.log('\n=== Parse Through attestation.js ===');
{
  const sk = generateSecretKey();
  const counterpartyNode = '03' + '2'.repeat(64);

  const event = buildBilateralAttestation({
    counterpartyNodePubkey: counterpartyNode,
    serviceType: 'lightning-node',
    dimensions: {
      settlement_rate: { value: '0.98', sampleSize: 50 },
      payment_success_rate: { value: '0.97', sampleSize: 50 },
    },
  }, sk);

  const parsed = parseAttestation(event);
  assert(parsed.attestationType === 'bilateral', 'parsed as bilateral');
  assert(parsed.nodePubkey === counterpartyNode, 'parsed node pubkey');
  assert(parsed.dimensions.length === 2, 'parsed dimensions');
  assert(parsed.decayWeight > 0.99, 'fresh event has ~1.0 decay weight');
}

// =====================================================
// Test 8: Aggregation with mixed self + bilateral
// =====================================================
console.log('\n=== Mixed Aggregation ===');
{
  const sk1 = generateSecretKey();
  const sk2 = generateSecretKey();
  const counterpartyNode = '03' + '3'.repeat(64);

  // Self attestation (low weight: 0.3)
  const selfEvent = buildBilateralAttestation({
    counterpartyNodePubkey: counterpartyNode,
    serviceType: 'lightning-node',
    dimensions: {
      settlement_rate: { value: '1.0000', sampleSize: 10 },
    },
  }, sk1);
  // Hack the attestation type to self for testing
  selfEvent.tags = selfEvent.tags.map(t =>
    t[0] === 'attestation_type' ? ['attestation_type', 'self'] : t
  );
  const parsedSelf = parseAttestation(selfEvent);

  // Bilateral attestation (high weight: 1.0)
  const bilateralEvent = buildBilateralAttestation({
    counterpartyNodePubkey: counterpartyNode,
    serviceType: 'lightning-node',
    dimensions: {
      settlement_rate: { value: '0.9000', sampleSize: 20 },
    },
  }, sk2);
  const parsedBilateral = parseAttestation(bilateralEvent);

  const agg = aggregateAttestations([parsedSelf, parsedBilateral]);
  const sr = agg.settlement_rate;

  assert(sr.numAttesters === 2, 'two attesters counted');
  // Expected: (1.0 * 1.0 * 0.3 + 0.9 * 1.0 * 1.0) / (1.0 * 0.3 + 1.0 * 1.0)
  //         = (0.3 + 0.9) / (0.3 + 1.0) = 1.2 / 1.3 ≈ 0.923
  assertApprox(sr.weightedAvg, 0.923, 0.01, 'bilateral dominates self in weighted avg');
}

// =====================================================
// Test 9: Serialization round-trip
// =====================================================
console.log('\n=== Serialization ===');
{
  const history = new TransactionHistory();
  history.add({
    counterpartyNodePubkey: '03' + '4'.repeat(64),
    invoiceAmountSats: 777,
    settled: true,
    responseTimeMs: 123,
    memo: 'test payment',
  });

  const json = history.toJSON();
  const restored = TransactionHistory.fromJSON(json);
  const txs = restored.getForCounterparty('03' + '4'.repeat(64));
  assert(txs.length === 1, 'round-trips correctly');
  assert(txs[0].invoiceAmountSats === 777, 'preserves amount');
  assert(txs[0].memo === 'test payment', 'preserves memo');
}

// =====================================================
// Test 10: Validation errors
// =====================================================
console.log('\n=== Validation ===');
{
  const sk = generateSecretKey();
  
  let threw = false;
  try {
    buildBilateralAttestation({ serviceType: 'test', dimensions: { x: { value: '1', sampleSize: 1 } } }, sk);
  } catch (e) {
    threw = true;
    assert(e.message.includes('counterparty'), 'requires counterparty pubkey');
  }
  if (!threw) assert(false, 'should throw without counterparty');

  threw = false;
  try {
    buildBilateralAttestation({ counterpartyNodePubkey: '03' + '5'.repeat(64), dimensions: {} }, sk);
  } catch (e) {
    threw = true;
    assert(e.message.includes('dimension'), 'requires dimensions');
  }
  if (!threw) assert(false, 'should throw without dimensions');
}

// =====================================================
// Summary
// =====================================================
console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All bilateral attestation tests passed! ✅');
