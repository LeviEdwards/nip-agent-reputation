#!/usr/bin/env node
/**
 * Example 4: Web-of-trust scoring (sybil-resistant reputation)
 * 
 * Simple query aggregation treats all attesters equally.
 * Web-of-trust scoring weights each attester by THEIR OWN reputation,
 * making it expensive to inflate scores with fake attesters.
 * 
 * Usage:
 *   node examples/04-web-of-trust.js <pubkey>
 *   node examples/04-web-of-trust.js 1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead
 */

import { WebOfTrust, queryAttestations } from '../index.js';

const pubkey = process.argv[2];
if (!pubkey) {
  console.error('Usage: node 04-web-of-trust.js <pubkey>');
  process.exit(1);
}

console.log(`\n🕸️  Web-of-trust scoring for ${pubkey.slice(0, 16)}...\n`);

// Create WoT engine with live relay queries
const wot = new WebOfTrust({
  queryFn: (pk) => queryAttestations(pk),
  maxDepth: 2,  // Look 2 hops deep into the trust graph
});

try {
  const scored = await wot.score(pubkey);

  // Trust graph: who attested and how much their attestation counts
  console.log('🔗 Trust graph:');
  console.log('─'.repeat(80));
  console.log('  Attester          Type        Trust  Decay  TypeW  Effective');
  console.log('─'.repeat(80));
  
  for (const entry of scored.trustGraph) {
    const attester = entry.attester.slice(0, 14) + '..';
    const type = entry.attestationType.padEnd(10);
    const trust = entry.trustScore.toFixed(3).padStart(6);
    const decay = entry.decayWeight.toFixed(3).padStart(6);
    const typeW = entry.typeWeight.toFixed(1).padStart(5);
    const eff = entry.effectiveWeight.toFixed(4).padStart(9);
    console.log(`  ${attester}  ${type}  ${trust}  ${decay}  ${typeW}  ${eff}`);
    
    // Show trust sources
    for (const src of entry.sources) {
      console.log(`    └─ ${src.type}: +${src.contribution.toFixed(3)}`);
    }
  }

  // Aggregated dimensions (trust-weighted)
  console.log('\n📊 Trust-weighted dimensions:');
  console.log('─'.repeat(60));
  
  for (const [name, data] of Object.entries(scored.dimensions)) {
    const val = data.weightedAvg < 10
      ? data.weightedAvg.toFixed(4)
      : Math.round(data.weightedAvg).toLocaleString();
    console.log(`  ${name.padEnd(28)} ${val.padStart(12)}  (weight: ${data.totalWeight.toFixed(4)}, ${data.numAttesters} attester(s))`);
  }

  // Overall assessment
  console.log('\n💡 Assessment:');
  console.log(`   Confidence: ${scored.confidence.toFixed(4)}`);
  console.log(`   Sybil risk: ${scored.sybilRisk}`);
  
  if (scored.meta.sybilFlags.length > 0) {
    console.log(`   ⚠️  Flags: ${scored.meta.sybilFlags.join(', ')}`);
  }
  
  console.log(`   Queries made: ${scored.meta.queriesMade} (${scored.meta.cacheHits} cache hits)`);

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

console.log();
