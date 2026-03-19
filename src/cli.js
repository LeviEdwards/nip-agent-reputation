#!/usr/bin/env node

/**
 * NIP Agent Reputation — CLI Tool
 * 
 * Usage:
 *   node src/cli.js collect          — Gather LND metrics (dry run, no publish)
 *   node src/cli.js publish          — Collect metrics and publish self-attestation
 *   node src/cli.js query <pubkey>   — Query attestations for a pubkey
 *   node src/cli.js verify <event_json> — Verify and parse an attestation event
 */

import { getKeypair } from './keys.js';
import { collectLndMetrics } from './lnd.js';
import {
  buildSelfAttestation,
  publishToRelays,
  queryAttestations,
  aggregateAttestations,
  parseAttestation,
  DEFAULT_RELAYS,
} from './attestation.js';

const command = process.argv[2];

async function main() {
  switch (command) {
    case 'collect':
      return cmdCollect();
    case 'publish':
      return cmdPublish();
    case 'query':
      return cmdQuery();
    case 'verify':
      return cmdVerify();
    default:
      console.log(`NIP Agent Reputation — Reference Implementation v0.1

Usage:
  node src/cli.js collect              Gather LND metrics (dry run)
  node src/cli.js publish              Publish self-attestation to relays
  node src/cli.js query <pubkey>       Query attestations for a pubkey
  node src/cli.js verify '<event_json>' Verify and parse an event
`);
      process.exit(1);
  }
}

async function cmdCollect() {
  console.log('Collecting LND metrics...\n');
  const metrics = await collectLndMetrics();
  
  console.log(`Node: ${metrics.alias} (${metrics.pubkey.slice(0, 16)}...)`);
  console.log(`Version: ${metrics.version}`);
  console.log(`Block height: ${metrics.blockHeight}`);
  console.log(`Synced: chain=${metrics.syncedToChain}, graph=${metrics.syncedToGraph}\n`);
  
  console.log('Dimensions:');
  for (const [name, data] of Object.entries(metrics.dimensions)) {
    console.log(`  ${name}: ${data.value} (n=${data.sampleSize})`);
  }
  
  console.log('\nInternal metrics (not published):');
  console.log(`  Total payments: ${metrics._meta.totalPayments} (${metrics._meta.succeeded} ok, ${metrics._meta.failed} failed)`);
  console.log(`  Channels: ${metrics._meta.numActiveChannels} active / ${metrics._meta.numChannels} total`);
  console.log(`  Total capacity: ${metrics._meta.totalCapacity} sats`);
  console.log(`  Forwarding events: ${metrics._meta.forwardingEvents}`);
  
  // Build event (but don't publish) to show what it looks like
  const kp = getKeypair();
  const event = buildSelfAttestation(metrics, kp.secretKey);
  console.log('\nEvent that would be published:');
  console.log(JSON.stringify(event, null, 2));
}

async function cmdPublish() {
  console.log('Collecting LND metrics...');
  const metrics = await collectLndMetrics();
  
  console.log(`Node: ${metrics.pubkey.slice(0, 16)}...`);
  console.log('Dimensions:');
  for (const [name, data] of Object.entries(metrics.dimensions)) {
    console.log(`  ${name}: ${data.value} (n=${data.sampleSize})`);
  }
  
  const kp = getKeypair();
  console.log(`\nPublishing as: ${kp.npub}`);
  
  const event = buildSelfAttestation(metrics, kp.secretKey);
  console.log(`Event ID: ${event.id}`);
  console.log(`Event kind: ${event.kind}`);
  console.log(`Tags: ${event.tags.length}`);
  
  console.log(`\nPublishing to ${DEFAULT_RELAYS.length} relays...`);
  const results = await publishToRelays(event);
  
  console.log(`\nResults:`);
  console.log(`  Accepted: ${results.accepted.length}`);
  for (const r of results.accepted) console.log(`    ✓ ${r}`);
  console.log(`  Rejected: ${results.rejected.length}`);
  for (const r of results.rejected) console.log(`    ✗ ${r.relay}: ${r.error}`);
  
  return event;
}

async function cmdQuery() {
  const pubkey = process.argv[3];
  if (!pubkey) {
    console.error('Usage: node src/cli.js query <pubkey_hex>');
    process.exit(1);
  }
  
  console.log(`Querying attestations for ${pubkey.slice(0, 16)}...`);
  console.log(`Relays: ${DEFAULT_RELAYS.join(', ')}\n`);
  
  const attestations = await queryAttestations(pubkey);
  
  if (attestations.length === 0) {
    console.log('No attestations found.');
    return;
  }
  
  console.log(`Found ${attestations.length} attestation(s):\n`);
  
  for (const att of attestations) {
    console.log(`--- Attestation ${att.id.slice(0, 12)}... ---`);
    console.log(`  Attester: ${att.attester.slice(0, 16)}...`);
    console.log(`  Type: ${att.attestationType}`);
    console.log(`  Service: ${att.serviceType}`);
    console.log(`  Age: ${att.ageHours}h (decay weight: ${att.decayWeight})`);
    console.log(`  Dimensions:`);
    for (const dim of att.dimensions) {
      console.log(`    ${dim.name}: ${dim.value} (n=${dim.sampleSize})`);
    }
    console.log();
  }
  
  // Aggregate
  const agg = aggregateAttestations(attestations);
  console.log('=== Aggregated (decay-weighted) ===');
  for (const [name, data] of Object.entries(agg)) {
    console.log(`  ${name}: ${data.weightedAvg.toFixed(4)} (${data.numAttesters} attester(s), weight: ${data.totalWeight})`);
  }
}

async function cmdVerify() {
  const eventJson = process.argv[3];
  if (!eventJson) {
    console.error('Usage: node src/cli.js verify \'<event_json>\'');
    process.exit(1);
  }
  
  const event = JSON.parse(eventJson);
  const att = parseAttestation(event);
  
  console.log('Parsed attestation:');
  console.log(JSON.stringify(att, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
