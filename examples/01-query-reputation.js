#!/usr/bin/env node
/**
 * Example 1: Query an agent's reputation before transacting
 * 
 * The most common use case — you want to check if a Lightning node
 * or agent is trustworthy before sending a payment or opening a channel.
 * 
 * Usage:
 *   node examples/01-query-reputation.js <pubkey>
 *   node examples/01-query-reputation.js 03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8
 */

import {
  queryAttestations,
  aggregateAttestations,
  DEFAULT_RELAYS,
} from '../index.js';

const pubkey = process.argv[2];
if (!pubkey) {
  console.error('Usage: node 01-query-reputation.js <pubkey>');
  console.error('  pubkey: 64-hex Nostr pubkey or 66-hex LND node pubkey');
  process.exit(1);
}

console.log(`\n🔍 Querying reputation for ${pubkey.slice(0, 16)}...`);
console.log(`   Relays: ${DEFAULT_RELAYS.join(', ')}\n`);

try {
  // Step 1: Fetch all attestations for this pubkey
  const attestations = await queryAttestations(pubkey);

  if (attestations.length === 0) {
    console.log('❌ No attestations found. This agent has no reputation history.');
    console.log('   This is itself a signal — proceed with caution for large transactions.');
    process.exit(0);
  }

  console.log(`✅ Found ${attestations.length} attestation(s):\n`);

  // Step 2: Show individual attestations
  for (const att of attestations) {
    const age = att.ageHours < 24
      ? `${att.ageHours.toFixed(1)}h ago`
      : `${(att.ageHours / 24).toFixed(1)}d ago`;
    
    console.log(`  📋 ${att.attestationType.toUpperCase()} from ${att.attester.slice(0, 12)}...`);
    console.log(`     Service: ${att.serviceType} | Age: ${age} | Decay: ${att.decayWeight}`);
    
    for (const dim of att.dimensions) {
      const label = dim.name.padEnd(25);
      console.log(`     ${label} ${dim.value} (n=${dim.sampleSize})`);
    }
    console.log();
  }

  // Step 3: Aggregate across all attesters
  const aggregated = aggregateAttestations(attestations);

  console.log('📊 Aggregated reputation (decay-weighted, type-weighted):');
  console.log('─'.repeat(60));

  for (const [name, data] of Object.entries(aggregated)) {
    const val = typeof data.weightedAvg === 'number' && data.weightedAvg < 10
      ? data.weightedAvg.toFixed(4)
      : Math.round(data.weightedAvg).toLocaleString();
    
    console.log(`  ${name.padEnd(28)} ${val.padStart(12)}  (${data.numAttesters} attester(s), weight: ${data.totalWeight})`);
  }

  // Step 4: Trust assessment
  console.log('\n💡 Trust assessment:');
  const totalWeight = Object.values(aggregated).reduce((max, d) => Math.max(max, d.totalWeight), 0);
  
  if (totalWeight >= 1.0) {
    console.log('   ✅ Sufficient confidence — externally validated reputation');
  } else if (totalWeight >= 0.5) {
    console.log('   ⚠️  Moderate confidence — may need additional signals');
  } else {
    console.log('   🔴 Low confidence — self-reported only, treat as unverified');
  }

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
