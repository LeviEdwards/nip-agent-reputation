#!/usr/bin/env node

/**
 * Decay math validation — tests exponential decay against real attestation timestamps.
 * 
 * Validates:
 * 1. Decay formula: weight = 2^(-age_hours / half_life_hours)
 * 2. Known checkpoints: 50% at 1 half-life, 25% at 2, ~3% at 5
 * 3. Aggregation with mixed ages and attestation types
 * 4. Edge cases: zero age, very old, negative age (future timestamp)
 */

import { parseAttestation, aggregateAttestations } from './attestation.js';

const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

function makeEvent(overrides = {}) {
  return {
    id: overrides.id || 'deadbeef'.repeat(8),
    pubkey: overrides.pubkey || 'aa'.repeat(32),
    created_at: overrides.created_at || NOW,
    kind: 30078,
    tags: [
      ['d', 'test:lightning-node'],
      ['service_type', 'lightning-node'],
      ['node_pubkey', '03' + 'bb'.repeat(32)],
      ['dimension', 'payment_success_rate', overrides.psr || '0.95', '100'],
      ['dimension', 'uptime_percent', overrides.uptime || '99.0', '10'],
      ['half_life_hours', overrides.halfLife || '720'],
      ['attestation_type', overrides.type || 'self'],
      ['L', 'agent-reputation'],
      ['l', 'attestation', 'agent-reputation'],
      ...(overrides.extraTags || []),
    ],
    content: '{}',
    sig: 'ff'.repeat(32), // dummy sig — parseAttestation doesn't verify
  };
}

function assertClose(actual, expected, tolerance, label) {
  const diff = Math.abs(actual - expected);
  const ok = diff <= tolerance;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${actual.toFixed(6)} (expected ${expected.toFixed(6)}, diff ${diff.toFixed(6)})`);
  if (!ok) process.exitCode = 1;
}

console.log('=== Decay Formula Checkpoints ===\n');

// Test: brand new attestation (0 age) → weight ≈ 1.0
{
  const att = parseAttestation(makeEvent({ created_at: NOW }));
  assertClose(att.decayWeight, 1.0, 0.01, 'Zero age → weight ~1.0');
}

// Test: exactly 1 half-life old (720h = 30 days) → weight = 0.5
{
  const att = parseAttestation(makeEvent({ created_at: NOW - 720 * HOUR }));
  assertClose(att.decayWeight, 0.5, 0.01, '1 half-life (720h) → weight ~0.5');
}

// Test: exactly 2 half-lives (1440h = 60 days) → weight = 0.25
{
  const att = parseAttestation(makeEvent({ created_at: NOW - 1440 * HOUR }));
  assertClose(att.decayWeight, 0.25, 0.01, '2 half-lives (1440h) → weight ~0.25');
}

// Test: 5 half-lives (3600h = 150 days) → weight ≈ 0.03125
{
  const att = parseAttestation(makeEvent({ created_at: NOW - 3600 * HOUR }));
  assertClose(att.decayWeight, 0.03125, 0.005, '5 half-lives (3600h) → weight ~0.031');
}

// Test: 10 half-lives → weight ≈ 0.001
{
  const att = parseAttestation(makeEvent({ created_at: NOW - 7200 * HOUR }));
  assertClose(att.decayWeight, 1 / 1024, 0.001, '10 half-lives → weight ~0.001');
}

// Test: custom half-life (168h = 7 days)
{
  const att = parseAttestation(makeEvent({ created_at: NOW - 168 * HOUR, halfLife: '168' }));
  assertClose(att.decayWeight, 0.5, 0.01, 'Custom half-life 168h at 168h → weight ~0.5');
}

console.log('\n=== Edge Cases ===\n');

// Future timestamp (created_at in the future) → weight > 1.0 (spec doesn't clamp)
{
  const att = parseAttestation(makeEvent({ created_at: NOW + 100 * HOUR }));
  console.log(`  ⚠ Future timestamp: decayWeight = ${att.decayWeight.toFixed(4)} (age: ${att.ageHours}h)`);
  console.log(`    Note: Spec doesn't prescribe clamping. Queriers SHOULD treat weight > 1.0 as suspicious.`);
}

// Very old (1 year) → weight nearly 0
{
  const att = parseAttestation(makeEvent({ created_at: NOW - 8760 * HOUR }));
  assertClose(att.decayWeight, 0.0, 0.001, '1 year old → weight ~0.0');
  console.log(`    Exact: ${att.decayWeight.toExponential(4)}`);
}

console.log('\n=== Aggregation with Mixed Ages & Types ===\n');

{
  // 3 attestations: recent self, week-old bilateral, month-old bilateral
  const attestations = [
    parseAttestation(makeEvent({ 
      id: '01'.repeat(32), pubkey: 'aa'.repeat(32),
      created_at: NOW - 1 * HOUR, type: 'self', psr: '0.95' 
    })),
    parseAttestation(makeEvent({ 
      id: '02'.repeat(32), pubkey: 'bb'.repeat(32),
      created_at: NOW - 168 * HOUR, type: 'bilateral', psr: '0.98' 
    })),
    parseAttestation(makeEvent({ 
      id: '03'.repeat(32), pubkey: 'cc'.repeat(32),
      created_at: NOW - 720 * HOUR, type: 'bilateral', psr: '0.90' 
    })),
  ];
  
  console.log('  Inputs:');
  for (const a of attestations) {
    console.log(`    ${a.attestationType} @ ${a.ageHours}h: psr=${a.dimensions[0].value}, decay=${a.decayWeight}`);
  }
  
  const agg = aggregateAttestations(attestations);
  const psr = agg['payment_success_rate'];
  
  console.log(`\n  Aggregated payment_success_rate: ${psr.weightedAvg.toFixed(4)}`);
  console.log(`  Total weight: ${psr.totalWeight}`);
  console.log(`  Num attesters: ${psr.numAttesters}`);
  
  // Verify manually:
  // self (1h old): type_weight=0.3, decay≈0.999 → total_weight=0.2997, weighted=0.95*0.2997
  // bilateral (168h): type_weight=1.0, decay≈0.8479 → total_weight=0.8479, weighted=0.98*0.8479
  // bilateral (720h): type_weight=1.0, decay≈0.5 → total_weight=0.5, weighted=0.90*0.5
  const w1 = 0.3 * Math.pow(2, -1/720);
  const w2 = 1.0 * Math.pow(2, -168/720);
  const w3 = 1.0 * Math.pow(2, -720/720);
  const expectedAvg = (0.95 * w1 + 0.98 * w2 + 0.90 * w3) / (w1 + w2 + w3);
  
  assertClose(psr.weightedAvg, expectedAvg, 0.01, 'Manual verification of weighted avg');
  
  console.log(`\n  Key insight: The bilateral attestations dominate even though`);
  console.log(`  the self-attestation is newest. Type weighting (bilateral=1.0 vs self=0.3)`);
  console.log(`  is working as designed — bilateral trust > recency for self-reports.`);
}

console.log('\n=== Real Attestation Decay Check ===\n');

// Test with the actual live event we published
{
  const liveEventAge = (Date.now() / 1000 - 1773925985) / 3600; // our published event timestamp
  const decayWeight = Math.pow(2, -liveEventAge / 720);
  console.log(`  Our live attestation (eb12c36d...)`);
  console.log(`    Age: ${liveEventAge.toFixed(1)} hours`);
  console.log(`    Decay weight: ${decayWeight.toFixed(6)} (half-life: 720h)`);
  console.log(`    At 30 days: ${Math.pow(2, -720/720).toFixed(4)}`);
  console.log(`    At 60 days: ${Math.pow(2, -1440/720).toFixed(4)}`);
  console.log(`    At 90 days: ${Math.pow(2, -2160/720).toFixed(4)}`);
}

console.log('\n=== Spec Recommendation: Future Timestamp Handling ===\n');
console.log('  Finding: The decay formula produces weight > 1.0 for future timestamps.');
console.log('  Recommendation: Add to spec that queriers SHOULD clamp weight to [0, 1.0]');
console.log('  and MAY penalize or discard attestations with future timestamps.');

console.log('\nAll tests complete.');
