#!/usr/bin/env node

/**
 * Quick example: Observe a Lightning node and publish an observer attestation.
 * 
 * This creates your own Nostr keypair (stored locally in .nostr-nsec),
 * fetches the target node's graph data from your LND, and publishes
 * an observer attestation to major Nostr relays.
 * 
 * Requirements:
 *   - Node.js >= 18
 *   - LND REST API access (set LND_HOST, LND_MACAROON_PATH, LND_CERT_PATH env vars)
 * 
 * Usage:
 *   # Set up LND connection
 *   export LND_HOST=https://localhost:8080
 *   export LND_MACAROON_PATH=/path/to/readonly.macaroon
 *   export LND_CERT_PATH=/path/to/tls.cert
 * 
 *   # Observe Satoshi's node and publish attestation
 *   node examples/observe-and-attest.js 03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8
 * 
 *   # Or any other Lightning node
 *   node examples/observe-and-attest.js <node_pubkey>
 */

import { observeNodeFromGraph, buildObserverAttestation } from '../src/observer.js';
import { publishToRelays, DEFAULT_RELAYS } from '../src/attestation.js';
import { getKeypair } from '../src/keys.js';
import { readFileSync } from 'fs';
import https from 'https';

const nodePubkey = process.argv[2];
if (!nodePubkey || nodePubkey.length !== 66) {
  console.error('Usage: node examples/observe-and-attest.js <66-char-node-pubkey>');
  console.error('');
  console.error('Example (Satoshi\'s node):');
  console.error('  node examples/observe-and-attest.js 03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8');
  process.exit(1);
}

// LND connection from environment
const LND_HOST = process.env.LND_HOST || 'https://localhost:8080';
const LND_MACAROON_PATH = process.env.LND_MACAROON_PATH;
const LND_CERT_PATH = process.env.LND_CERT_PATH;

if (!LND_MACAROON_PATH) {
  console.error('Error: Set LND_MACAROON_PATH environment variable');
  console.error('  export LND_MACAROON_PATH=/path/to/readonly.macaroon');
  process.exit(1);
}

async function lndFetch(endpoint) {
  const macaroon = readFileSync(LND_MACAROON_PATH).toString('hex');
  const options = {
    headers: { 'Grpc-Metadata-macaroon': macaroon },
    rejectUnauthorized: false,
  };
  if (LND_CERT_PATH) {
    options.ca = readFileSync(LND_CERT_PATH);
    options.rejectUnauthorized = true;
  }
  
  return new Promise((resolve, reject) => {
    const url = `${LND_HOST}${endpoint}`;
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Invalid JSON from ${endpoint}`)); }
      });
    }).on('error', reject);
  });
}

console.log(`Observing node ${nodePubkey.slice(0, 20)}...`);
console.log(`LND: ${LND_HOST}\n`);

const session = await observeNodeFromGraph(lndFetch, nodePubkey);
const dims = session.computeDimensions();

console.log('Observed dimensions:');
for (const [name, data] of Object.entries(dims)) {
  console.log(`  ${name}: ${data.value} (n=${data.sampleSize})`);
}

const keys = getKeypair();
console.log(`\nYour Nostr pubkey: ${keys.publicKey}`);

const event = buildObserverAttestation(session, keys.secretKey, {
  halfLifeHours: 720,
  nostrPubkey: keys.publicKey,
});

console.log(`\nPublishing kind ${event.kind} observer attestation...`);
const results = await publishToRelays(event, DEFAULT_RELAYS);
console.log(`  Accepted: ${results.accepted.length} relay(s)`);
if (results.rejected.length > 0) {
  console.log(`  Rejected: ${results.rejected.length} relay(s)`);
}
console.log(`\nEvent ID: ${event.id}`);
console.log(`\nDone! Your observer attestation is live on Nostr.`);
console.log(`Verify: node src/cli.js query ${nodePubkey}`);
process.exit(0);
