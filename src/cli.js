#!/usr/bin/env node

/**
 * NIP Agent Reputation — CLI Tool
 * 
 * Usage:
 *   node src/cli.js collect          — Gather LND metrics (dry run, no publish)
 *   node src/cli.js publish          — Collect metrics and publish self-attestation
 *   node src/cli.js publish --auto   — Auto-publish if metrics changed or interval exceeded
 *   node src/cli.js publish --force  — Force publish regardless of state
 *   node src/cli.js query <pubkey>   — Query attestations for a pubkey
 *   node src/cli.js verify <event_json> — Verify and parse an attestation event
 *   node src/cli.js attest <node_pubkey> [--nostr <nostr_pubkey>] [--service <type>]
 *                                    — Publish bilateral attestation from tx history
 *   node src/cli.js record <node_pubkey> <amount_sats> [settled|failed] [--time <ms>] [--dispute]
 *                                    — Record a transaction for bilateral attestation
 *   node src/cli.js history [node_pubkey] — Show transaction history
 *   node src/cli.js observe <node_pubkey> [--publish] [--nostr <nostr_pubkey>] [--service <type>]
 *                                    — Observe a node via LND graph + build observer attestation
 *   node src/cli.js trust <pubkey>   — Web-of-trust scoring (recursive attester reputation)
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
import {
  buildServiceHandler,
  parseServiceHandler,
} from './handler.js';
import {
  ObservationSession,
  buildObserverAttestation,
  observeNodeFromGraph,
} from './observer.js';
import { WebOfTrust } from './web-of-trust.js';
import {
  shouldPublish,
  recordPublish,
  loadState,
} from './auto-publish.js';
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
    case 'handler':
      return cmdHandler();
    case 'observe':
      return cmdObserve();
    case 'trust':
      return cmdTrust();
    default:
      console.log(`NIP Agent Reputation — Reference Implementation v0.4

Usage:
  node src/cli.js collect              Gather LND metrics (dry run)
  node src/cli.js publish              Publish self-attestation to relays
  node src/cli.js publish --auto       Auto-publish (skip if no meaningful change)
  node src/cli.js publish --force      Force publish regardless of state
  node src/cli.js publish --auto --json  Auto-publish with JSON output (for cron)
  node src/cli.js query <pubkey>       Query attestations for a pubkey
  node src/cli.js verify '<event_json>' Verify and parse an event

Bilateral attestations:
  node src/cli.js record <node_pubkey> <amount_sats> [settled|failed] [--time <ms>] [--dispute]
                                       Record a transaction
  node src/cli.js history [node_pubkey] Show transaction history
  node src/cli.js attest <node_pubkey> [--nostr <npub>] [--service <type>]
                                       Build & publish bilateral attestation

Observer attestations:
  node src/cli.js observe <node_pubkey> [--publish] [--nostr <npub>] [--service <type>]
                                       Observe node via LND graph + build observer attestation

Service handlers:
  node src/cli.js handler --id <service_id> --desc <description> [--price <sats>] [--protocol <L402|bolt11>] [--endpoint <url>]
                                       Publish service handler declaration (kind 31990)

Web-of-trust scoring:
  node src/cli.js trust <pubkey> [--depth <n>] [--graph]
                                       Recursive trust-weighted reputation scoring
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
  const args = process.argv.slice(3);
  const autoMode = args.includes('--auto');
  const forceMode = args.includes('--force');
  const jsonOutput = args.includes('--json');
  
  console.log('Collecting LND metrics...');
  const metrics = await collectLndMetrics();
  
  // Auto mode: check if we should publish
  if (autoMode && !forceMode) {
    const decision = shouldPublish(metrics, { force: false });
    if (!decision.shouldPublish) {
      const msg = `[auto] Skipped: ${decision.reason}`;
      if (jsonOutput) {
        console.log(JSON.stringify({ action: 'skipped', reason: decision.reason, timestamp: new Date().toISOString() }));
      } else {
        console.log(msg);
      }
      return null;
    }
    console.log(`[auto] Publishing: ${decision.reason}`);
  }
  
  if (forceMode) console.log('[force] Publishing regardless of state');
  
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
  
  // Record successful publish for auto mode tracking
  if (results.accepted.length > 0) {
    recordPublish(metrics, event.id);
    console.log('\n[state] Publish state saved for auto-mode tracking');
  }
  
  if (jsonOutput) {
    console.log(JSON.stringify({
      action: 'published',
      eventId: event.id,
      accepted: results.accepted.length,
      rejected: results.rejected.length,
      timestamp: new Date().toISOString(),
      dimensions: Object.fromEntries(
        Object.entries(metrics.dimensions).map(([k, v]) => [k, { value: v.value, sampleSize: v.sampleSize }])
      ),
    }));
  }
  
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

async function cmdHandler() {
  const args = process.argv.slice(3);
  
  const getArg = (flag) => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  
  const serviceId = getArg('--id');
  const description = getArg('--desc');
  if (!serviceId || !description) {
    console.error('Usage: node src/cli.js handler --id <service_id> --desc <description> [--price <sats>] [--protocol <L402|bolt11>] [--endpoint <url>]');
    process.exit(1);
  }
  
  const price = getArg('--price');
  const protocol = getArg('--protocol') || 'L402';
  const endpoint = getArg('--endpoint');
  
  // Get our node pubkey from LND
  let nodePubkey;
  try {
    const metrics = await collectLndMetrics();
    nodePubkey = metrics.pubkey;
    console.log(`Node: ${nodePubkey.slice(0, 16)}...`);
  } catch {
    console.log('Warning: Could not reach LND. Publishing without node_pubkey.');
  }
  
  const kp = getKeypair();
  console.log(`Publishing as: ${kp.npub}\n`);
  
  const event = buildServiceHandler({
    serviceId,
    description,
    price,
    protocol,
    endpoint,
    nodePubkey,
  }, kp.secretKey);
  
  console.log(`Event ID: ${event.id}`);
  console.log(`Kind: ${event.kind}`);
  console.log(`Service: ${serviceId}`);
  console.log(`Description: ${description}`);
  if (price) console.log(`Price: ${price} sats`);
  if (endpoint) console.log(`Endpoint: ${endpoint}`);
  
  console.log(`\nPublishing to ${DEFAULT_RELAYS.length} relays...`);
  const results = await publishToRelays(event);
  
  console.log(`\nResults:`);
  console.log(`  Accepted: ${results.accepted.length}`);
  for (const r of results.accepted) console.log(`    ✓ ${r}`);
  console.log(`  Rejected: ${results.rejected.length}`);
  for (const r of results.rejected) console.log(`    ✗ ${r.relay}: ${r.error}`);
}

async function cmdObserve() {
  const nodePubkey = process.argv[3];
  if (!nodePubkey) {
    console.error('Usage: node src/cli.js observe <node_pubkey> [--publish] [--nostr <nostr_pubkey>] [--service <type>]');
    process.exit(1);
  }

  const args = process.argv.slice(4);
  const doPublish = args.includes('--publish');
  const nostrIdx = args.indexOf('--nostr');
  const nostrPubkey = nostrIdx >= 0 ? args[nostrIdx + 1] : undefined;
  const serviceIdx = args.indexOf('--service');
  const serviceType = serviceIdx >= 0 ? args[serviceIdx + 1] : 'lightning-node';

  console.log(`Observing node ${nodePubkey.slice(0, 16)}... via LND graph\n`);

  // Create a fetch function that uses our LND REST API
  const { execSync } = await import('child_process');
  const lndFetch = async (endpoint) => {
    try {
      const result = execSync(
        `bash /data/.openclaw/workspace/lncli.sh ${endpoint}`,
        { encoding: 'utf8', timeout: 15000 }
      );
      return JSON.parse(result);
    } catch (e) {
      throw new Error(`LND fetch failed for ${endpoint}: ${e.message}`);
    }
  };

  // Observe via graph
  const session = new ObservationSession(nodePubkey, serviceType, {
    subjectNostrPubkey: nostrPubkey,
    observerNote: 'Observation via LND network graph query',
  });

  try {
    const { observeNodeFromGraph: observeGraph } = await import('./observer.js');
    const channelSnap = await observeGraph(lndFetch, nodePubkey);
    session.recordChannelState(channelSnap);
    console.log(`Graph data:`);
    console.log(`  Channels: ${channelSnap.numChannels}`);
    console.log(`  Capacity: ${channelSnap.totalCapacitySats} sats`);
    console.log(`  Addresses: ${channelSnap.peers}`);
  } catch (e) {
    console.log(`⚠ Graph query failed: ${e.message}`);
  }

  // Peer-check probe: if we're directly connected, that's a strong reachability signal.
  // If not connected, infer reachability from graph data (active channels = node is up).
  try {
    const peers = await lndFetch('/v1/peers');
    const isPeer = (peers.peers || []).some(p => p.pub_key === nodePubkey);
    if (isPeer) {
      // Direct connection = definitely reachable
      session.recordProbe({ reachable: true, method: 'peer-check', latencyMs: null });
      console.log(`  Peer status: connected (direct reachability confirmed)`);
    } else if (session.channelSnapshots.length > 0 && session.channelSnapshots[0].activeChannels > 0) {
      // Not our peer, but graph shows active channels = node is reachable on network
      session.recordProbe({ reachable: true, method: 'graph-inferred', latencyMs: null });
      console.log(`  Peer status: not connected (but ${session.channelSnapshots[0].activeChannels} active channels in graph → inferred reachable)`);
    } else {
      // Not connected and no graph evidence of activity
      session.recordProbe({ reachable: false, method: 'peer-check', latencyMs: null });
      console.log(`  Peer status: not connected (no active channels found)`);
    }
  } catch (e) {
    console.log(`  ⚠ Peer check failed: ${e.message}`);
  }

  // Compute dimensions
  const dims = session.computeDimensions();
  console.log(`\nComputed dimensions:`);
  for (const [name, data] of Object.entries(dims)) {
    console.log(`  ${name}: ${data.value} (n=${data.sampleSize})`);
  }

  if (!doPublish) {
    // Dry run: build but don't publish
    const kp = getKeypair();
    const event = buildObserverAttestation(session, kp.secretKey, {
      observerDescription: 'Satoshi node — automated graph observer',
    });
    console.log(`\nEvent (dry run — use --publish to send to relays):`);
    console.log(`  ID: ${event.id}`);
    console.log(`  Kind: ${event.kind}`);
    console.log(`  Type: observer`);
    console.log(`  Dimensions: ${event.tags.filter(t => t[0] === 'dimension').length}`);
    return;
  }

  // Publish
  const kp = getKeypair();
  const event = buildObserverAttestation(session, kp.secretKey, {
    observerDescription: 'Satoshi node — automated graph observer',
  });

  console.log(`\nEvent ID: ${event.id}`);
  console.log(`Publishing to ${DEFAULT_RELAYS.length} relays...`);
  const results = await publishToRelays(event);

  console.log(`\nResults:`);
  console.log(`  Accepted: ${results.accepted.length}`);
  for (const r of results.accepted) console.log(`    ✓ ${r}`);
  console.log(`  Rejected: ${results.rejected.length}`);
  for (const r of results.rejected) console.log(`    ✗ ${r.relay}: ${r.error}`);
}

async function cmdTrust() {
  const pubkey = process.argv[3];
  if (!pubkey) {
    console.error('Usage: node src/cli.js trust <pubkey_hex> [--depth <n>] [--graph]');
    process.exit(1);
  }

  const args = process.argv.slice(4);
  const depthIdx = args.indexOf('--depth');
  const maxDepth = depthIdx >= 0 ? parseInt(args[depthIdx + 1]) : 2;
  const useGraph = args.includes('--graph');

  console.log(`Web-of-Trust scoring for ${pubkey.slice(0, 16)}...`);
  console.log(`Max depth: ${maxDepth}, Graph data: ${useGraph ? 'yes' : 'no'}\n`);

  // Build graph function if requested
  let graphFn = null;
  if (useGraph) {
    const { execSync } = await import('child_process');
    graphFn = async (nodePub) => {
      try {
        const result = execSync(
          `bash /data/.openclaw/workspace/lncli.sh /v1/graph/node/${nodePub}`,
          { encoding: 'utf8', timeout: 15000 }
        );
        const nodeInfo = JSON.parse(result);
        if (!nodeInfo || !nodeInfo.node) return null;
        return {
          channels: nodeInfo.num_channels || 0,
          capacity: parseInt(nodeInfo.total_capacity || '0'),
        };
      } catch {
        return null;
      }
    };
  }

  const wot = new WebOfTrust({
    queryFn: queryAttestations,
    graphFn,
    maxDepth,
  });

  const result = await wot.score(pubkey);

  if (result.rawAttestations.length === 0) {
    console.log('No attestations found for this pubkey.');
    return;
  }

  console.log(`Found ${result.rawAttestations.length} attestation(s)\n`);

  // Trust graph
  console.log('=== Trust Graph ===');
  for (const entry of result.trustGraph) {
    const trustBar = '█'.repeat(Math.round(entry.trustScore * 20)).padEnd(20, '░');
    console.log(`  ${entry.attester.slice(0, 16)}... [${entry.attestationType}]`);
    console.log(`    Trust: ${trustBar} ${(entry.trustScore * 100).toFixed(1)}%`);
    console.log(`    Effective weight: ${entry.effectiveWeight.toFixed(4)} (decay: ${entry.decayWeight}, type: ${entry.typeWeight}, trust: ${entry.trustScore})`);
    if (entry.sources.length > 0) {
      const sourceStr = entry.sources
        .filter(s => s.contribution > 0)
        .map(s => `${s.type}(+${s.contribution.toFixed(3)})`)
        .join(', ');
      if (sourceStr) console.log(`    Sources: ${sourceStr}`);
    }
  }

  // Aggregated dimensions
  console.log('\n=== Trust-Weighted Dimensions ===');
  for (const [name, data] of Object.entries(result.dimensions)) {
    console.log(`  ${name}: ${data.weightedAvg.toFixed(4)} (${data.numAttesters} attester(s), weight: ${data.totalWeight})`);
  }

  // Summary
  console.log('\n=== Summary ===');
  console.log(`  Confidence: ${result.confidence.toFixed(4)}`);
  console.log(`  Sybil risk: ${result.sybilRisk}`);
  if (result.meta.sybilFlags.length > 0) {
    console.log(`  ⚠ Flags: ${result.meta.sybilFlags.join(', ')}`);
  }
  console.log(`  Queries: ${result.meta.queriesMade} (${result.meta.cacheHits} cache hits)`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
