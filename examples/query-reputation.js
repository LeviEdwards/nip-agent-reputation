#!/usr/bin/env node

/**
 * Quick example: Query an agent's reputation from Nostr relays.
 * No LND needed — reads only from public relay data.
 * 
 * Usage:
 *   node examples/query-reputation.js <pubkey>
 * 
 *   # Query Satoshi's node
 *   node examples/query-reputation.js 03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8
 */

import { queryAttestations, aggregateAttestations, DEFAULT_RELAYS } from '../src/attestation.js';

const pubkey = process.argv[2];
if (!pubkey) {
  console.error('Usage: node examples/query-reputation.js <pubkey>');
  console.error('');
  console.error('Example (Satoshi\'s Lightning node):');
  console.error('  node examples/query-reputation.js 03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8');
  process.exit(1);
}

console.log(`Querying reputation for ${pubkey.slice(0, 20)}...`);
console.log(`Relays: ${DEFAULT_RELAYS.join(', ')}\n`);

const attestations = await queryAttestations(pubkey, DEFAULT_RELAYS, { timeout: 10000 });

if (attestations.length === 0) {
  console.log('No attestations found.');
  process.exit(0);
}

console.log(`Found ${attestations.length} attestation(s):\n`);

for (const a of attestations) {
  const ageHours = ((Date.now() / 1000) - a.createdAt) / 3600;
  console.log(`  [${a.attestationType}] from ${a.attester.slice(0, 16)}... (${ageHours.toFixed(1)}h ago, decay: ${a.decayWeight.toFixed(3)})`);
  for (const d of a.dimensions) {
    console.log(`    ${d.name}: ${d.value} (n=${d.sampleSize})`);
  }
  console.log('');
}

// Aggregate
const agg = aggregateAttestations(attestations);
console.log('=== Aggregated (decay-weighted) ===');
for (const [name, data] of Object.entries(agg)) {
  console.log(`  ${name}: ${data.weightedAvg.toFixed(4)} (${data.numAttesters} attester(s), weight: ${data.totalWeight.toFixed(3)})`);
}

process.exit(0);
