#!/usr/bin/env node

/**
 * NIP Agent Reputation — CLI Tool
 * 
 * Usage:
 *   node src/cli.js collect          — Gather LND metrics (dry run, no publish)
 *   node src/cli.js publish          — Collect metrics and publish self-attestation
 *   node src/cli.js query <pubkey>   — Query attestations for a pubkey
 *   node src/cli.js verify <event_json> — Verify and parse an attestation event
 *   node src/cli.js attest <node_pubkey> [--nostr <nostr_pubkey>] [--service <type>]
 *                                    — Publish bilateral attestation from tx history
 *   node src/cli.js record <node_pubkey> <amount_sats> [settled|failed] [--time <ms>] [--dispute]
 *                                    — Record a transaction for bilateral attestation
 *   node src/cli.js history [node_pubkey] — Show transaction history
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
import {
  TransactionRecord,
  TransactionHistory,
  buildBilateralFromHistory,
} from './bilateral.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TX_HISTORY_FILE = join(__dirname, '..', '.tx-history.json');

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
    case 'record':
      return cmdRecord();
    case 'history':
      return cmdHistory();
    case 'attest':
      return cmdAttest();
    default:
      console.log(`NIP Agent Reputation — Reference Implementation v0.2

Usage:
  node src/cli.js collect              Gather LND metrics (dry run)
  node src/cli.js publish              Publish self-attestation to relays
  node src/cli.js query <pubkey>       Query attestations for a pubkey
  node src/cli.js verify '<event_json>' Verify and parse an event

Bilateral attestations:
  node src/cli.js record <node_pubkey> <amount_sats> [settled|failed] [--time <ms>] [--dispute]
                                       Record a transaction
  node src/cli.js history [node_pubkey] Show transaction history
  node src/cli.js attest <node_pubkey> [--nostr <npub>] [--service <type>]
                                       Build & publish bilateral attestation
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
  
  const event = buildSelfAttestation(metrics, kp.secretKey, { nostrPubkey: kp.publicKey });
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

// === Transaction history helpers ===

function loadHistory() {
  if (existsSync(TX_HISTORY_FILE)) {
    const data = JSON.parse(readFileSync(TX_HISTORY_FILE, 'utf8'));
    return TransactionHistory.fromJSON(data);
  }
  return new TransactionHistory();
}

function saveHistory(history) {
  writeFileSync(TX_HISTORY_FILE, JSON.stringify(history.toJSON(), null, 2));
}

// === Bilateral attestation commands ===

async function cmdRecord() {
  const nodePubkey = process.argv[3];
  const amountSats = parseInt(process.argv[4]);
  if (!nodePubkey || isNaN(amountSats)) {
    console.error('Usage: node src/cli.js record <node_pubkey> <amount_sats> [settled|failed] [--time <ms>] [--dispute]');
    process.exit(1);
  }

  const args = process.argv.slice(5);
  const settled = !args.includes('failed');
  const dispute = args.includes('--dispute');
  const timeIdx = args.indexOf('--time');
  const responseTimeMs = timeIdx >= 0 ? parseInt(args[timeIdx + 1]) : null;

  const history = loadHistory();
  const tx = new TransactionRecord({
    counterpartyNodePubkey: nodePubkey,
    invoiceAmountSats: amountSats,
    settled,
    responseTimeMs,
    disputeOccurred: dispute,
  });
  history.add(tx);
  saveHistory(history);

  console.log(`Recorded transaction:`);
  console.log(`  Counterparty: ${nodePubkey.slice(0, 16)}...`);
  console.log(`  Amount: ${amountSats} sats`);
  console.log(`  Status: ${settled ? 'settled' : 'failed'}`);
  if (responseTimeMs) console.log(`  Response time: ${responseTimeMs}ms`);
  if (dispute) console.log(`  ⚠ Dispute flagged`);
  console.log(`  Total txs in history: ${history.transactions.length}`);
}

async function cmdHistory() {
  const filterPubkey = process.argv[3];
  const history = loadHistory();

  if (history.transactions.length === 0) {
    console.log('No transactions recorded yet.');
    console.log('Use: node src/cli.js record <node_pubkey> <amount_sats> [settled|failed]');
    return;
  }

  const txs = filterPubkey
    ? history.getForCounterparty(filterPubkey)
    : history.transactions;

  console.log(`Transaction history (${txs.length} total):\n`);

  // Group by counterparty
  const grouped = {};
  for (const tx of txs) {
    const key = tx.counterpartyNodePubkey;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(tx);
  }

  for (const [nodePub, txList] of Object.entries(grouped)) {
    const dims = history.computeDimensions(nodePub);
    console.log(`--- ${nodePub.slice(0, 16)}... (${txList.length} txs) ---`);
    if (dims) {
      console.log(`  Settlement rate: ${dims.settlement_rate.value}`);
      console.log(`  Dispute rate: ${dims.dispute_rate.value}`);
      console.log(`  Volume: ${dims.transaction_volume_sats.value} sats`);
      if (dims.response_time_ms) console.log(`  Avg response: ${dims.response_time_ms.value}ms`);
    }
    console.log();
  }
}

async function cmdAttest() {
  const nodePubkey = process.argv[3];
  if (!nodePubkey) {
    console.error('Usage: node src/cli.js attest <node_pubkey> [--nostr <nostr_pubkey>] [--service <type>]');
    process.exit(1);
  }

  const args = process.argv.slice(4);
  const nostrIdx = args.indexOf('--nostr');
  const nostrPubkey = nostrIdx >= 0 ? args[nostrIdx + 1] : undefined;
  const serviceIdx = args.indexOf('--service');
  const serviceType = serviceIdx >= 0 ? args[serviceIdx + 1] : 'lightning-node';

  const history = loadHistory();
  const txs = history.getForCounterparty(nodePubkey);

  if (txs.length === 0) {
    console.error(`No transactions found with ${nodePubkey.slice(0, 16)}...`);
    console.error('Record transactions first: node src/cli.js record <node_pubkey> <amount_sats>');
    process.exit(1);
  }

  console.log(`Building bilateral attestation for ${nodePubkey.slice(0, 16)}...`);
  console.log(`Based on ${txs.length} transaction(s)\n`);

  const kp = getKeypair();
  const event = buildBilateralFromHistory(history, nodePubkey, kp.secretKey, {
    counterpartyNostrPubkey: nostrPubkey,
    serviceType,
  });

  console.log(`Event ID: ${event.id}`);
  console.log(`Attester: ${kp.npub}`);
  console.log(`Type: bilateral`);

  const dimTags = event.tags.filter(t => t[0] === 'dimension');
  console.log(`Dimensions:`);
  for (const t of dimTags) {
    console.log(`  ${t[1]}: ${t[2]} (n=${t[3]})`);
  }

  console.log(`\nPublishing to ${DEFAULT_RELAYS.length} relays...`);
  const results = await publishToRelays(event);

  console.log(`\nResults:`);
  console.log(`  Accepted: ${results.accepted.length}`);
  for (const r of results.accepted) console.log(`    ✓ ${r}`);
  console.log(`  Rejected: ${results.rejected.length}`);
  for (const r of results.rejected) console.log(`    ✗ ${r.relay}: ${r.error}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
