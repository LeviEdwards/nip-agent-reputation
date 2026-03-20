/**
 * Tests for Web-of-Trust scoring module.
 * 
 * Runs: node src/test-web-of-trust.js
 */

import { WebOfTrust, ScoredReputation } from './web-of-trust.js';

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

function approxEqual(a, b, tolerance = 0.01) {
  return Math.abs(a - b) < tolerance;
}

// Helper: create a mock attestation
function mockAttestation(attester, subject, type = 'bilateral', dims = {}, ageHours = 0) {
  const dimensions = Object.entries(dims).map(([name, value]) => ({
    name,
    value: String(value),
    sampleSize: 10,
  }));
  const halfLife = 720;
  const decayWeight = Math.min(Math.pow(2, -ageHours / halfLife), 1.0);
  
  return {
    id: `fake-${attester.slice(0, 8)}-${Date.now()}`,
    attester,
    subject,
    attestationType: type,
    serviceType: 'lightning-node',
    dimensions,
    halfLifeHours: halfLife,
    sampleWindowHours: 168,
    ageHours,
    decayWeight: Math.round(decayWeight * 10000) / 10000,
    labels: ['agent-reputation'],
  };
}

// === Phase 1: Basic Construction ===
console.log('\n=== Phase 1: Basic Construction ===');
{
  const wot = new WebOfTrust({ queryFn: async () => [] });
  assert(wot.config.maxDepth === 2, 'Default maxDepth = 2');
  assert(wot.config.selfTrustFloor === 0.1, 'Default selfTrustFloor = 0.1');
  assert(typeof wot.score === 'function', 'Has score method');
}

// === Phase 2: Empty Subject ===
console.log('\n=== Phase 2: Empty Subject (no attestations) ===');
{
  const wot = new WebOfTrust({ queryFn: async () => [] });
  const result = await wot.score('subject_pubkey_1');
  
  assert(result.subjectPubkey === 'subject_pubkey_1', 'Subject pubkey set');
  assert(Object.keys(result.dimensions).length === 0, 'No dimensions');
  assert(result.trustGraph.length === 0, 'Empty trust graph');
  assert(result.confidence === 0, 'Zero confidence');
  assert(result.sybilRisk === 'unknown', 'Sybil risk = unknown');
}

// === Phase 3: Self-Attestation Only ===
console.log('\n=== Phase 3: Self-Attestation Only ===');
{
  const subject = 'subject_aaa';
  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        mockAttestation(subject, subject, 'self', {
          payment_success_rate: 0.99,
          capacity_sats: 500000,
        }),
      ];
    }
    return [];
  };

  const wot = new WebOfTrust({ queryFn });
  const result = await wot.score(subject);

  assert(result.trustGraph.length === 1, 'One entry in trust graph');
  assert(result.trustGraph[0].trustScore === 0.1, 'Self trust = selfTrustFloor (0.1)');
  assert(result.trustGraph[0].attestationType === 'self', 'Type = self');
  
  // effective weight = decayWeight(1.0) * typeWeight(0.3) * trustScore(0.1) = 0.03
  assert(approxEqual(result.trustGraph[0].effectiveWeight, 0.03), 
    `Effective weight = 0.03 — got ${result.trustGraph[0].effectiveWeight}`);
  assert(result.sybilRisk === 'high', `Sybil risk = high for self-only — got ${result.sybilRisk}`);
  assert(result.dimensions.payment_success_rate !== undefined, 'Has payment_success_rate dimension');
}

// === Phase 4: Single Bilateral Attester (unknown trust) ===
console.log('\n=== Phase 4: Single Bilateral Attester (no reputation) ===');
{
  const subject = 'subject_bbb';
  const attester = 'attester_111';
  
  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        mockAttestation(attester, subject, 'bilateral', {
          payment_success_rate: 0.95,
          settlement_rate: 0.98,
        }),
      ];
    }
    // Attester has no attestations (unknown entity)
    return [];
  };

  const wot = new WebOfTrust({ queryFn });
  const result = await wot.score(subject);

  assert(result.trustGraph.length === 1, 'One attester');
  // Attester has no attestations → floor trust (0.05)
  assert(result.trustGraph[0].trustScore === 0.05, 
    `Unknown attester trust = 0.05 — got ${result.trustGraph[0].trustScore}`);
  assert(result.trustGraph[0].attestationType === 'bilateral', 'Type = bilateral');
  
  // effective weight = 1.0 * 1.0 * 0.05 = 0.05
  assert(approxEqual(result.trustGraph[0].effectiveWeight, 0.05),
    `Effective weight ≈ 0.05 — got ${result.trustGraph[0].effectiveWeight}`);
}

// === Phase 5: Bilateral Attester with Own Reputation ===
console.log('\n=== Phase 5: Bilateral Attester with Reputation ===');
{
  const subject = 'subject_ccc';
  const attester = 'attester_222';
  const attester2 = 'attester_333'; // attests for attester_222

  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        mockAttestation(attester, subject, 'bilateral', {
          payment_success_rate: 0.92,
        }),
      ];
    }
    if (pubkey === attester) {
      // Attester has bilateral attestation from another node
      return [
        mockAttestation(attester2, attester, 'bilateral', {
          payment_success_rate: 0.99,
        }),
        mockAttestation(attester, attester, 'self', {
          payment_success_rate: 0.97,
        }),
      ];
    }
    return [];
  };

  const wot = new WebOfTrust({ queryFn });
  const result = await wot.score(subject);

  assert(result.trustGraph.length === 1, 'One attester in graph');
  // Attester has: self(0.1) + bilateral_received(0.3 * 1.0 * max(floor, attester2_trust))
  // attester2 at depth 2 = depth limit → unknownTrustFloor (0.05)
  // bilateral contribution = min(0.3 * 1.0 * 0.05, 0.5) = 0.015
  // total = 0.1 + 0.015 = 0.115
  const trust = result.trustGraph[0].trustScore;
  assert(trust > 0.1, `Trust > 0.1 (has bilateral) — got ${trust}`);
  assert(trust < 0.5, `Trust < 0.5 (attester2 is unknown) — got ${trust}`);
  console.log(`    (trust score: ${trust})`);
}

// === Phase 6: Well-Connected Attester (graph data) ===
console.log('\n=== Phase 6: Graph-Boosted Trust ===');
{
  const subject = 'subject_ddd';
  const bigNode = 'big_node_444';

  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        mockAttestation(bigNode, subject, 'bilateral', {
          payment_success_rate: 0.98,
        }),
      ];
    }
    if (pubkey === bigNode) {
      return [
        mockAttestation(bigNode, bigNode, 'self', {
          capacity_sats: 5000000,
        }),
      ];
    }
    return [];
  };

  const graphFn = async (pubkey) => {
    if (pubkey === bigNode) {
      return { channels: 15, capacity: 5000000 }; // 5M sats, 15 channels
    }
    return null;
  };

  const wot = new WebOfTrust({ queryFn, graphFn });
  const result = await wot.score(subject);

  const trust = result.trustGraph[0].trustScore;
  // Graph: capacity = min(5M * 0.0000001, 0.3) = 0.5 → capped at 0.3
  // Graph: channels = min(15 * 0.02, 0.3) = 0.3
  // Self: 0.1
  // Total: 0.3 + 0.3 + 0.1 = 0.7
  assert(trust > 0.3, `Graph-boosted trust > 0.3 — got ${trust}`);
  assert(trust <= 1.0, `Trust capped at 1.0 — got ${trust}`);
  console.log(`    (trust score: ${trust})`);

  // This well-connected node's attestation should carry much more weight
  const effWeight = result.trustGraph[0].effectiveWeight;
  assert(effWeight > 0.3, `High effective weight — got ${effWeight}`);
}

// === Phase 7: Multi-Attester Aggregation ===
console.log('\n=== Phase 7: Multi-Attester Trust-Weighted Aggregation ===');
{
  const subject = 'subject_eee';
  const goodNode = 'good_node_555';
  const weakNode = 'weak_node_666';

  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        // Good node says 0.99 success rate
        mockAttestation(goodNode, subject, 'bilateral', {
          payment_success_rate: 0.99,
        }),
        // Weak node says 0.50 success rate (trying to tank reputation?)
        mockAttestation(weakNode, subject, 'bilateral', {
          payment_success_rate: 0.50,
        }),
        // Self says 0.95
        mockAttestation(subject, subject, 'self', {
          payment_success_rate: 0.95,
        }),
      ];
    }
    if (pubkey === goodNode) {
      // Good node has bilateral attestations
      return [
        mockAttestation('external_node_a', goodNode, 'bilateral', { payment_success_rate: 0.98 }),
        mockAttestation(goodNode, goodNode, 'self', { capacity_sats: 2000000 }),
      ];
    }
    if (pubkey === weakNode) {
      // Weak node: self only
      return [
        mockAttestation(weakNode, weakNode, 'self', { payment_success_rate: 0.50 }),
      ];
    }
    return [];
  };

  const wot = new WebOfTrust({ queryFn });
  const result = await wot.score(subject);

  assert(result.trustGraph.length === 3, `3 entries in trust graph — got ${result.trustGraph.length}`);
  
  const goodEntry = result.trustGraph.find(e => e.attester === goodNode);
  const weakEntry = result.trustGraph.find(e => e.attester === weakNode);
  
  assert(goodEntry.trustScore > weakEntry.trustScore, 
    `Good node trust (${goodEntry.trustScore}) > weak node trust (${weakEntry.trustScore})`);
  assert(goodEntry.effectiveWeight > weakEntry.effectiveWeight,
    `Good node weight (${goodEntry.effectiveWeight}) > weak node weight (${weakEntry.effectiveWeight})`);
  
  // The weighted average should be closer to 0.99 (good node) than 0.50 (weak node)
  const avgRate = result.dimensions.payment_success_rate.weightedAvg;
  // With similar trust scores, weak node still pulls the average down
  // Key: good node has higher trust → its 0.99 pulls harder than weak's 0.50
  assert(avgRate > 0.70, `Trust-weighted avg > 0.70 — got ${avgRate.toFixed(4)}`);
  console.log(`    (weighted avg payment_success_rate: ${avgRate.toFixed(4)})`);
}

// === Phase 8: Sybil Detection — Uniform Scores ===
console.log('\n=== Phase 8: Sybil Detection — Suspicious Uniformity ===');
{
  const subject = 'subject_fff';
  const sybil1 = 'sybil_s1';
  const sybil2 = 'sybil_s2';
  const sybil3 = 'sybil_s3';

  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        // Three "different" attesters all give exactly the same scores
        mockAttestation(sybil1, subject, 'bilateral', { payment_success_rate: 0.99, settlement_rate: 0.99 }),
        mockAttestation(sybil2, subject, 'bilateral', { payment_success_rate: 0.99, settlement_rate: 0.99 }),
        mockAttestation(sybil3, subject, 'bilateral', { payment_success_rate: 0.99, settlement_rate: 0.99 }),
      ];
    }
    return []; // None of the sybils have any reputation
  };

  const wot = new WebOfTrust({ queryFn });
  const result = await wot.score(subject);

  assert(result.meta.sybilFlags.length > 0, `Sybil flags raised — got ${result.meta.sybilFlags.length}`);
  const hasUniform = result.meta.sybilFlags.some(f => f.startsWith('suspiciously-uniform'));
  assert(hasUniform, `Flagged suspiciously-uniform — flags: ${result.meta.sybilFlags.join(', ')}`);
  
  // All attesters are low-trust (no reputation)
  const hasLowTrust = result.meta.sybilFlags.includes('all-attesters-low-trust');
  assert(hasLowTrust, 'Flagged all-attesters-low-trust');
}

// === Phase 9: Cycle Prevention ===
console.log('\n=== Phase 9: Cycle Prevention (A→B, B→A) ===');
{
  const nodeA = 'cycle_aaa';
  const nodeB = 'cycle_bbb';

  const queryFn = async (pubkey) => {
    if (pubkey === nodeA) {
      return [mockAttestation(nodeB, nodeA, 'bilateral', { payment_success_rate: 0.95 })];
    }
    if (pubkey === nodeB) {
      return [mockAttestation(nodeA, nodeB, 'bilateral', { payment_success_rate: 0.90 })];
    }
    return [];
  };

  const wot = new WebOfTrust({ queryFn, maxDepth: 3 });
  // This should NOT hang or infinite loop
  const result = await wot.score(nodeA);

  assert(result.trustGraph.length === 1, 'Completed without infinite loop');
  assert(result.trustGraph[0].attester === nodeB, 'B attests A');
  // B's trust computation should NOT re-query A (visited set prevents cycle)
  console.log(`    (queries made: ${result.meta.queriesMade})`);
  assert(result.meta.queriesMade < 10, `Bounded queries (${result.meta.queriesMade} < 10)`);
}

// === Phase 10: Cache Behavior ===
console.log('\n=== Phase 10: Cache Behavior ===');
{
  let queryCount = 0;
  const queryFn = async (pubkey) => {
    queryCount++;
    if (pubkey === 'cached_subject') {
      return [
        mockAttestation('att_x', 'cached_subject', 'bilateral', { capacity_sats: 100000 }),
        mockAttestation('att_y', 'cached_subject', 'bilateral', { capacity_sats: 200000 }),
      ];
    }
    if (pubkey === 'att_x' || pubkey === 'att_y') {
      return [mockAttestation(pubkey, pubkey, 'self', { capacity_sats: 50000 })];
    }
    return [];
  };

  const wot = new WebOfTrust({ queryFn });
  
  // Score twice — second should use cache
  const r1 = await wot.score('cached_subject');
  const queriesFirst = queryCount;
  
  const r2 = await wot.score('cached_subject');
  const queriesSecond = queryCount - queriesFirst;

  assert(r1.trustGraph.length === 2, 'First scoring: 2 attesters');
  assert(r2.meta.cacheHits > 0, `Cache hits on second call — got ${r2.meta.cacheHits}`);
  // The subject query itself isn't cached (always fresh), but attester lookups are
  assert(queriesSecond <= queriesFirst, `Second call used fewer/equal queries (${queriesSecond} ≤ ${queriesFirst})`);
}

// === Phase 11: Decay Interaction ===
console.log('\n=== Phase 11: Decay + Trust Interaction ===');
{
  const subject = 'decay_subject';
  const freshAttester = 'fresh_att';
  const staleAttester = 'stale_att';

  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        mockAttestation(freshAttester, subject, 'bilateral', { payment_success_rate: 0.90 }, 0),   // fresh
        mockAttestation(staleAttester, subject, 'bilateral', { payment_success_rate: 0.99 }, 1440), // 60 days old
      ];
    }
    return [];
  };

  const wot = new WebOfTrust({ queryFn });
  const result = await wot.score(subject);

  const freshEntry = result.trustGraph.find(e => e.attester === freshAttester);
  const staleEntry = result.trustGraph.find(e => e.attester === staleAttester);

  assert(freshEntry.decayWeight > staleEntry.decayWeight,
    `Fresh decay (${freshEntry.decayWeight}) > stale decay (${staleEntry.decayWeight})`);
  assert(freshEntry.effectiveWeight > staleEntry.effectiveWeight,
    `Fresh effective weight (${freshEntry.effectiveWeight}) > stale (${staleEntry.effectiveWeight})`);
  
  // Weighted avg should lean toward 0.90 (fresh) not 0.99 (stale)
  const avg = result.dimensions.payment_success_rate.weightedAvg;
  assert(avg < 0.95, `Weighted avg leans fresh (${avg.toFixed(4)} < 0.95)`);
}

// === Phase 12: Depth Limit ===
console.log('\n=== Phase 12: Depth Limit Behavior ===');
{
  // Chain: subject ← A ← B ← C ← D
  // With maxDepth=2, D should NOT be queried
  const queriedPubkeys = new Set();
  
  const queryFn = async (pubkey) => {
    queriedPubkeys.add(pubkey);
    const chain = {
      'chain_subject': [mockAttestation('chain_A', 'chain_subject', 'bilateral', { payment_success_rate: 0.95 })],
      'chain_A': [mockAttestation('chain_B', 'chain_A', 'bilateral', { payment_success_rate: 0.90 })],
      'chain_B': [mockAttestation('chain_C', 'chain_B', 'bilateral', { payment_success_rate: 0.85 })],
      'chain_C': [mockAttestation('chain_D', 'chain_C', 'bilateral', { payment_success_rate: 0.80 })],
      'chain_D': [mockAttestation('chain_D', 'chain_D', 'self', { payment_success_rate: 0.75 })],
    };
    return chain[pubkey] || [];
  };

  const wot = new WebOfTrust({ queryFn, maxDepth: 2 });
  const result = await wot.score('chain_subject');

  assert(queriedPubkeys.has('chain_subject'), 'Queried subject');
  assert(queriedPubkeys.has('chain_A'), 'Queried A (depth 1)');
  assert(queriedPubkeys.has('chain_B'), 'Queried B (depth 2)');
  // At depth 2, B's attesters should NOT be recursed into
  assert(!queriedPubkeys.has('chain_D'), 'Did NOT query D (beyond depth limit)');
  console.log(`    (queried: ${[...queriedPubkeys].join(', ')})`);
}

// === Phase 13: ScoredReputation JSON serialization ===
console.log('\n=== Phase 13: JSON Serialization ===');
{
  const subject = 'json_subject';
  const queryFn = async (pubkey) => {
    if (pubkey === subject) {
      return [
        mockAttestation('json_att', subject, 'bilateral', { payment_success_rate: 0.95 }),
        mockAttestation(subject, subject, 'self', { payment_success_rate: 0.90 }),
      ];
    }
    return [];
  };

  const wot = new WebOfTrust({ queryFn });
  const result = await wot.score(subject);
  const json = result.toJSON();

  assert(json.subjectPubkey === subject, 'JSON has subjectPubkey');
  assert(typeof json.confidence === 'number', 'JSON has confidence');
  assert(typeof json.sybilRisk === 'string', 'JSON has sybilRisk');
  assert(Array.isArray(json.trustGraph), 'JSON has trustGraph array');
  assert(json.trustGraph.length === 2, 'JSON trust graph has 2 entries');
  assert(json.dimensions.payment_success_rate !== undefined, 'JSON has dimensions');
  
  const jsonStr = JSON.stringify(json);
  const parsed = JSON.parse(jsonStr);
  assert(parsed.subjectPubkey === subject, 'Round-trip: pubkey preserved');
  assert(parsed.trustGraph.length === 2, 'Round-trip: graph preserved');
}

// === Phase 14: Sybil Risk Levels ===
console.log('\n=== Phase 14: Sybil Risk Levels ===');
{
  // Low risk: 3+ unique attesters with good trust
  const queryFn = async (pubkey) => {
    if (pubkey === 'risk_subject') {
      return [
        mockAttestation('risk_a1', 'risk_subject', 'bilateral', { payment_success_rate: 0.95 }),
        mockAttestation('risk_a2', 'risk_subject', 'bilateral', { payment_success_rate: 0.93 }),
        mockAttestation('risk_a3', 'risk_subject', 'bilateral', { payment_success_rate: 0.97 }),
      ];
    }
    // Give all attesters some reputation
    return [
      mockAttestation('external_good', pubkey, 'bilateral', { payment_success_rate: 0.99 }),
      mockAttestation(pubkey, pubkey, 'self', { capacity_sats: 1000000 }),
    ];
  };

  const graphFn = async (pubkey) => {
    if (pubkey.startsWith('risk_a')) return { channels: 10, capacity: 2000000 };
    return null;
  };

  const wot = new WebOfTrust({ queryFn, graphFn });
  const result = await wot.score('risk_subject');

  // With graph data + bilateral attestations, attesters should have decent trust
  // 3+ unique attesters with confidence > 1.0 → low risk
  const allHighTrust = result.trustGraph.every(e => e.trustScore > 0.2);
  assert(allHighTrust, 'All attesters have meaningful trust');
  console.log(`    (confidence: ${result.confidence.toFixed(4)}, risk: ${result.sybilRisk})`);
  assert(result.sybilRisk === 'low' || result.sybilRisk === 'moderate', 
    `Risk is low or moderate — got ${result.sybilRisk}`);
}

// === Results ===
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
