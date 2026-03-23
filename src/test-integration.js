#!/usr/bin/env node

/**
 * Integration Test: Full Attestation Lifecycle
 * 
 * Tests the complete cycle:
 *   1. Declare service handler (kind 31990)
 *   2. Record transactions
 *   3. Build bilateral attestation (kind 30385)
 *   4. Build self-attestation (kind 30385)
 *   5. Parse all events back
 *   6. Aggregate attestations with decay weighting
 *   7. Validate edge cases (self-only, stale services)
 * 
 * This test runs entirely locally — no relay connections.
 * All events are built, signed, verified, and parsed in-memory.
 */

import { generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import {
  buildSelfAttestation,
  parseAttestation,
  aggregateAttestations,
} from './attestation.js';
import {
  TransactionRecord,
  TransactionHistory,
  buildBilateralAttestation,
  buildBilateralFromHistory,
} from './bilateral.js';
import {
  buildServiceHandler,
  parseServiceHandler,
} from './handler.js';
import { ATTESTATION_KIND } from './constants.js';

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

function assertClose(a, b, tolerance, msg) {
  const diff = Math.abs(a - b);
  if (diff <= tolerance) {
    passed++;
    console.log(`  ✓ ${msg} (${a} ≈ ${b})`);
  } else {
    failed++;
    console.error(`  ✗ ${msg} — expected ${b} ± ${tolerance}, got ${a}`);
  }
}

// === Simulated agents ===

// Agent A: a service provider (e.g., Bitcoin data API)
const agentA_sk = generateSecretKey();
const agentA_pk = getPublicKey(agentA_sk);

// Agent B: a service consumer + bilateral attester
const agentB_sk = generateSecretKey();
const agentB_pk = getPublicKey(agentB_sk);

// Agent C: another bilateral attester
const agentC_sk = generateSecretKey();
const agentC_pk = getPublicKey(agentC_sk);

// Simulated LND pubkey for Agent A (66 hex)
const agentA_lnd = '03' + agentA_pk; // Fake but correct length

// =========================================================
// PHASE 1: Service Handler Declaration
// =========================================================

console.log('\n=== Phase 1: Service Handler Declaration ===\n');

const handlerEvent = buildServiceHandler({
  serviceId: 'btc-network-api',
  description: 'Real-time Bitcoin network statistics and mempool data',
  price: '10',
  priceUnit: 'sats',
  pricePer: 'per-request',
  protocol: 'L402',
  endpoint: 'https://example.com/api/v1/network',
  nodePubkey: agentA_lnd,
  handlerKinds: ['5600'],
}, agentA_sk);

assert(handlerEvent.kind === 31990, 'Handler event is kind 31990');
assert(verifyEvent(handlerEvent), 'Handler event signature is valid');
assert(handlerEvent.pubkey === agentA_pk, 'Handler pubkey matches Agent A');

const parsedHandler = parseServiceHandler(handlerEvent);
assert(parsedHandler.serviceId === 'btc-network-api', 'Parsed service ID correct');
assert(parsedHandler.description === 'Real-time Bitcoin network statistics and mempool data', 'Parsed description correct');
assert(parsedHandler.price.amount === '10', 'Parsed price amount correct');
assert(parsedHandler.price.unit === 'sats', 'Parsed price unit correct');
assert(parsedHandler.protocol === 'L402', 'Parsed protocol correct');
assert(parsedHandler.endpoint === 'https://example.com/api/v1/network', 'Parsed endpoint correct');
assert(parsedHandler.nodePubkey === agentA_lnd, 'Parsed node pubkey correct');
assert(parsedHandler.handlerKinds.includes('5600'), 'Parsed handler kinds include 5600');

// Check agent-reputation labels
const hasLLabel = handlerEvent.tags.some(t => t[0] === 'L' && t[1] === 'agent-reputation');
const haslLabel = handlerEvent.tags.some(t => t[0] === 'l' && t[1] === 'handler' && t[2] === 'agent-reputation');
assert(hasLLabel, 'Has L label for agent-reputation');
assert(haslLabel, 'Has l handler label for agent-reputation');

// =========================================================
// PHASE 2: Record Transactions
// =========================================================

console.log('\n=== Phase 2: Record Transactions ===\n');

const history = new TransactionHistory();

// Agent B transacts with Agent A: 8 settled, 2 failed, 1 dispute
const txData = [
  { settled: true, amount: 100, time: 450 },
  { settled: true, amount: 200, time: 380 },
  { settled: true, amount: 150, time: 520 },
  { settled: false, amount: 100, time: null },
  { settled: true, amount: 300, time: 410 },
  { settled: true, amount: 50, time: 290 },
  { settled: true, amount: 500, time: 600 },
  { settled: false, amount: 200, time: null },
  { settled: true, amount: 100, time: 350, dispute: true },
  { settled: true, amount: 250, time: 440 },
];

for (const tx of txData) {
  history.add(new TransactionRecord({
    counterpartyNodePubkey: agentA_lnd,
    counterpartyNostrPubkey: agentA_pk,
    serviceType: 'btc-network-api',
    invoiceAmountSats: tx.amount,
    settled: tx.settled,
    responseTimeMs: tx.time,
    disputeOccurred: tx.dispute || false,
  }));
}

assert(history.transactions.length === 10, 'All 10 transactions recorded');

const txsForA = history.getForCounterparty(agentA_lnd);
assert(txsForA.length === 10, 'All 10 transactions found for Agent A LND pubkey');

const dims = history.computeDimensions(agentA_lnd);
assert(dims !== null, 'Dimensions computed successfully');
assertClose(parseFloat(dims.settlement_rate.value), 0.8, 0.001, 'Settlement rate = 0.8 (8/10)');
assertClose(parseFloat(dims.dispute_rate.value), 0.1, 0.001, 'Dispute rate = 0.1 (1/10)');
assert(parseInt(dims.transaction_volume_sats.value) === 1650, 'Volume = 1650 sats (settled only)');
assert(dims.response_time_ms !== undefined, 'Response time dimension present');

// Average response: (450+380+520+410+290+600+350+440)/8 = 430ms
assertClose(parseFloat(dims.response_time_ms.value), 430, 1, 'Avg response time ≈ 430ms');

// =========================================================
// PHASE 3: Build Bilateral Attestation
// =========================================================

console.log('\n=== Phase 3: Build Bilateral Attestation (Agent B → Agent A) ===\n');

const bilateralEvent = buildBilateralFromHistory(history, agentA_lnd, agentB_sk, {
  counterpartyNostrPubkey: agentA_pk,
  serviceType: 'btc-network-api',
});

assert(bilateralEvent.kind === ATTESTATION_KIND, `Bilateral event is kind ${ATTESTATION_KIND}`);
assert(verifyEvent(bilateralEvent), 'Bilateral event signature is valid');
assert(bilateralEvent.pubkey === agentB_pk, 'Bilateral attester is Agent B');

const parsedBilateral = parseAttestation(bilateralEvent);
assert(parsedBilateral.attestationType === 'bilateral', 'Attestation type is bilateral');
assert(parsedBilateral.nodePubkey === agentA_lnd, 'Subject is Agent A (by LND pubkey)');
assert(parsedBilateral.serviceType === 'btc-network-api', 'Service type matches');
assert(parsedBilateral.dimensions.length >= 3, 'At least 3 dimensions present');

const settDim = parsedBilateral.dimensions.find(d => d.name === 'settlement_rate');
assertClose(settDim.value, 0.8, 0.001, 'Bilateral settlement_rate = 0.8');

// =========================================================
// PHASE 4: Build Self-Attestation (Agent A about itself)
// =========================================================

console.log('\n=== Phase 4: Build Self-Attestation (Agent A) ===\n');

// Simulate LND metrics for Agent A
const mockMetrics = {
  pubkey: agentA_lnd,
  alias: 'TestAgentA',
  version: '0.19.2-beta',
  syncedToChain: true,
  syncedToGraph: true,
  blockHeight: 885000,
  dimensions: {
    payment_success_rate: { value: '0.9500', sampleSize: 100 },
    settlement_rate: { value: '0.9700', sampleSize: 100 },
    uptime_percent: { value: '99.5', sampleSize: 3 },
    capacity_sats: { value: '2000000', sampleSize: 3 },
    num_channels: { value: '3', sampleSize: 1 },
    num_forwards: { value: '42', sampleSize: 1 },
  },
  _meta: { totalPayments: 100, succeeded: 95, failed: 5, numChannels: 3, numActiveChannels: 3, totalCapacity: 2000000, forwardingEvents: 42 },
};

const selfEvent = buildSelfAttestation(mockMetrics, agentA_sk, { nostrPubkey: agentA_pk });

assert(selfEvent.kind === ATTESTATION_KIND, `Self event is kind ${ATTESTATION_KIND}`);
assert(verifyEvent(selfEvent), 'Self event signature is valid');
assert(selfEvent.pubkey === agentA_pk, 'Self attester is Agent A');

const parsedSelf = parseAttestation(selfEvent);
assert(parsedSelf.attestationType === 'self', 'Attestation type is self');
assert(parsedSelf.nodePubkey === agentA_lnd, 'Self-attested node pubkey matches');

// =========================================================
// PHASE 5: Aggregation with Type Weighting
// =========================================================

console.log('\n=== Phase 5: Aggregation (bilateral + self, decay-weighted) ===\n');

// Both events are fresh (created_at ≈ now), so decay ≈ 1.0
const allAttestations = [parsedSelf, parsedBilateral];
const agg = aggregateAttestations(allAttestations);

assert(agg.settlement_rate !== undefined, 'settlement_rate aggregated');
assert(agg.settlement_rate.numAttesters === 2, 'Two attesters for settlement_rate');

// Self: value=0.97, weight=1.0*0.3=0.3
// Bilateral: value=0.8, weight=1.0*1.0=1.0
// Weighted avg = (0.97*0.3 + 0.8*1.0) / (0.3+1.0) = (0.291+0.8)/1.3 = 0.8392
assertClose(agg.settlement_rate.weightedAvg, 0.8392, 0.01, 'Weighted settlement_rate ≈ 0.84 (bilateral dominates)');

// Verify bilateral dominance: if only bilateral existed, value would be 0.8
// With self added (0.97 at 0.3 weight), it shifts slightly toward self but bilateral still dominates
assert(agg.settlement_rate.weightedAvg < 0.97, 'Self-attested 0.97 pulled down by bilateral 0.8');
assert(agg.settlement_rate.weightedAvg > 0.8, 'Bilateral 0.8 pulled up slightly by self 0.97');

// =========================================================
// PHASE 6: Edge Case — Self-Attestation Only
// =========================================================

console.log('\n=== Phase 6: Edge Case — Self-Attestation Only ===\n');

const selfOnlyAgg = aggregateAttestations([parsedSelf]);

assert(selfOnlyAgg.settlement_rate !== undefined, 'Self-only: settlement_rate present');
assert(selfOnlyAgg.settlement_rate.numAttesters === 1, 'Self-only: single attester');
assertClose(selfOnlyAgg.settlement_rate.totalWeight, 0.3, 0.01, 'Self-only: total weight = 0.3 (low confidence)');
assertClose(selfOnlyAgg.settlement_rate.weightedAvg, 0.97, 0.001, 'Self-only: value equals self-reported (0.97)');

// Recommended querier behavior for self-only:
// - totalWeight < 0.5 indicates LOW CONFIDENCE (no external validation)
// - numAttesters === 1 + attestationType === 'self' → treat as unverified
// - Querier should require minimum totalWeight threshold (e.g., 0.5) for trust decisions
const selfOnlyTrustworthy = selfOnlyAgg.settlement_rate.totalWeight >= 0.5;
assert(!selfOnlyTrustworthy, 'Self-only: totalWeight < 0.5 → below minimum trust threshold');

// =========================================================
// PHASE 7: Edge Case — Stale Service Detection
// =========================================================

console.log('\n=== Phase 7: Edge Case — Stale Service Detection ===\n');

// Simulate an old attestation (180 days ago) by overriding created_at
const staleEvent = { ...selfEvent, created_at: Math.floor(Date.now() / 1000) - (180 * 24 * 3600) };
// Re-parse to get updated decay
const parsedStale = parseAttestation(staleEvent);

assert(parsedStale.ageHours > 4000, `Stale attestation age = ${parsedStale.ageHours}h (> 4000h)`);
assert(parsedStale.decayWeight < 0.1, `Stale decay weight = ${parsedStale.decayWeight} (< 0.1)`);

// A 180-day-old self-attestation should be nearly worthless
const staleAgg = aggregateAttestations([parsedStale]);
const staleWeight = staleAgg.settlement_rate.totalWeight;
assert(staleWeight < 0.03, `Stale self-attestation effective weight = ${staleWeight} (< 0.03)`);

// Stale service detection heuristic:
// If all attestations for a service have effective weight < threshold, service may be dead
const STALE_THRESHOLD = 0.05;
const allStale = Object.values(staleAgg).every(d => d.totalWeight < STALE_THRESHOLD);
assert(allStale, `All dimensions below stale threshold (${STALE_THRESHOLD}) → service likely inactive`);

// Mix stale + fresh: fresh bilateral should dominate
const mixedAgg = aggregateAttestations([parsedStale, parsedBilateral]);
assert(mixedAgg.settlement_rate.weightedAvg !== undefined, 'Mixed aggregation works');
// Fresh bilateral (weight≈1.0) should overwhelm stale self (weight≈0.01)
assertClose(mixedAgg.settlement_rate.weightedAvg, 0.8, 0.02, 'Fresh bilateral dominates stale self');

// =========================================================
// PHASE 8: Edge Case — Future Timestamp Clamping
// =========================================================

console.log('\n=== Phase 8: Edge Case — Future Timestamp ===\n');

const futureEvent = { ...selfEvent, created_at: Math.floor(Date.now() / 1000) + 3600 };
const parsedFuture = parseAttestation(futureEvent);

assert(parsedFuture.decayWeight <= 1.0, `Future timestamp: decay clamped to ${parsedFuture.decayWeight} (≤ 1.0)`);
assert(parsedFuture.ageHours < 0, `Future timestamp: negative age (${parsedFuture.ageHours}h)`);

// =========================================================
// PHASE 9: Multi-Attester Aggregation
// =========================================================

console.log('\n=== Phase 9: Multi-Attester Aggregation ===\n');

// Agent C also attests Agent A (different metrics)
const historyC = new TransactionHistory();
for (let i = 0; i < 5; i++) {
  historyC.add(new TransactionRecord({
    counterpartyNodePubkey: agentA_lnd,
    serviceType: 'btc-network-api',
    invoiceAmountSats: 500,
    settled: true,
    responseTimeMs: 200 + i * 50,
  }));
}

const bilateralC = buildBilateralFromHistory(historyC, agentA_lnd, agentC_sk, {
  serviceType: 'btc-network-api',
});
const parsedBilateralC = parseAttestation(bilateralC);

const multiAgg = aggregateAttestations([parsedSelf, parsedBilateral, parsedBilateralC]);

assert(multiAgg.settlement_rate.numAttesters === 3, 'Three attesters for settlement_rate');
// Agent C has 100% settlement (5/5), Agent B has 80% (8/10), Self reports 97%
// Weights: self=0.3, bilateral_B=1.0, bilateral_C=1.0
// Weighted avg = (0.97*0.3 + 0.8*1.0 + 1.0*1.0) / (0.3+1.0+1.0) = (0.291+0.8+1.0)/2.3 = 0.909
assertClose(multiAgg.settlement_rate.weightedAvg, 0.909, 0.02, 'Multi-attester weighted avg ≈ 0.91');

// Dispute rate: only Agent B reported disputes
assert(multiAgg.dispute_rate !== undefined, 'Dispute rate aggregated');
assert(multiAgg.dispute_rate.numAttesters >= 2, 'Multiple attesters for dispute_rate');

// Response time: Agent B avg=430ms, Agent C avg=300ms
assert(multiAgg.response_time_ms !== undefined, 'Response time aggregated');
assert(multiAgg.response_time_ms.numAttesters >= 2, 'Multiple attesters for response_time');

// =========================================================
// PHASE 10: Serialization Round-Trip
// =========================================================

console.log('\n=== Phase 10: Serialization Round-Trip ===\n');

// Serialize handler + attestation events to JSON and back
const handlerJson = JSON.stringify(handlerEvent);
const handlerRoundTrip = JSON.parse(handlerJson);
const reParsedHandler = parseServiceHandler(handlerRoundTrip);
assert(reParsedHandler.serviceId === 'btc-network-api', 'Handler survives JSON round-trip');

const bilateralJson = JSON.stringify(bilateralEvent);
const bilateralRoundTrip = JSON.parse(bilateralJson);
assert(verifyEvent(bilateralRoundTrip), 'Bilateral event signature survives JSON round-trip');
const reParsedBilateral = parseAttestation(bilateralRoundTrip);
assert(reParsedBilateral.attestationType === 'bilateral', 'Bilateral type survives round-trip');
assertClose(
  reParsedBilateral.dimensions.find(d => d.name === 'settlement_rate').value,
  0.8, 0.001,
  'Settlement rate value survives round-trip'
);

// Transaction history round-trip
const histJson = JSON.stringify(history.toJSON());
const histRoundTrip = TransactionHistory.fromJSON(JSON.parse(histJson));
assert(histRoundTrip.transactions.length === 10, 'Transaction history survives JSON round-trip');
const reDims = histRoundTrip.computeDimensions(agentA_lnd);
assertClose(parseFloat(reDims.settlement_rate.value), 0.8, 0.001, 'Recomputed settlement rate matches');

// =========================================================
// RESULTS
// =========================================================

console.log(`\n${'='.repeat(50)}`);
console.log(`Integration test results: ${passed} passed, ${failed} failed`);
console.log(`${'='.repeat(50)}\n`);

if (failed > 0) process.exit(1);
