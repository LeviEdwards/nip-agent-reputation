#!/usr/bin/env node
/**
 * Example 2: Publish a self-attestation from your LND node
 * 
 * Self-attestations carry the lowest trust weight (0.3) but establish
 * your presence in the reputation network. Other agents can see your
 * self-reported metrics and decide whether to transact.
 * 
 * Prerequisites:
 *   - LND node running with REST API accessible
 *   - Environment variables: LND_REST_URL, LND_MACAROON_PATH, LND_TLS_CERT_PATH
 *   - A Nostr keypair (generated automatically if not present)
 * 
 * Usage:
 *   LND_REST_URL=https://localhost:8080 \
 *   LND_MACAROON_PATH=/path/to/admin.macaroon \
 *   LND_TLS_CERT_PATH=/path/to/tls.cert \
 *   node examples/02-publish-self-attestation.js
 */

import {
  buildSelfAttestation,
  publishToRelays,
  DEFAULT_RELAYS,
} from '../index.js';
import { collectLndMetrics } from '../src/lnd.js';
import { getKeypair } from '../src/keys.js';

// Configuration
const LND_REST_URL = process.env.LND_REST_URL || 'https://localhost:8080';
const MACAROON_PATH = process.env.LND_MACAROON_PATH;
const TLS_CERT_PATH = process.env.LND_TLS_CERT_PATH;

if (!MACAROON_PATH || !TLS_CERT_PATH) {
  console.error('Required environment variables:');
  console.error('  LND_REST_URL      - LND REST API URL (default: https://localhost:8080)');
  console.error('  LND_MACAROON_PATH - Path to admin.macaroon');
  console.error('  LND_TLS_CERT_PATH - Path to tls.cert');
  process.exit(1);
}

try {
  // Step 1: Get or generate Nostr keypair
  console.log('\n🔑 Loading Nostr keypair...');
  const { secretKey, publicKey } = getKeypair();
  console.log(`   Pubkey: ${publicKey.slice(0, 16)}...`);

  // Step 2: Collect metrics from LND
  console.log('\n📡 Collecting metrics from LND...');
  const metrics = await collectLndMetrics({
    restUrl: LND_REST_URL,
    macaroonPath: MACAROON_PATH,
    tlsCertPath: TLS_CERT_PATH,
  });
  
  console.log(`   Node: ${metrics.alias || 'unnamed'} (${metrics.pubkey.slice(0, 16)}...)`);
  console.log(`   Channels: ${metrics.dimensions.num_channels?.value || 0}`);
  console.log(`   Capacity: ${Number(metrics.dimensions.capacity_sats?.value || 0).toLocaleString()} sats`);

  // Step 3: Build the attestation event
  console.log('\n📝 Building self-attestation...');
  const event = buildSelfAttestation(metrics, secretKey, {
    serviceType: 'lightning-node',
    nostrPubkey: publicKey,
  });
  
  console.log(`   Event ID: ${event.id}`);
  console.log(`   Kind: ${event.kind}`);
  console.log(`   Dimensions: ${event.tags.filter(t => t[0] === 'dimension').length}`);

  // Step 4: Publish to relays
  console.log('\n📤 Publishing to relays...');
  const results = await publishToRelays(event, DEFAULT_RELAYS);
  
  for (const relay of results.accepted) {
    console.log(`   ✅ ${relay}`);
  }
  for (const { relay, error } of results.rejected) {
    console.log(`   ❌ ${relay}: ${error}`);
  }

  console.log(`\n🎉 Self-attestation published! (${results.accepted.length}/${DEFAULT_RELAYS.length} relays)`);
  console.log(`   Event ID: ${event.id}`);
  console.log(`   Note: Self-attestations carry 0.3 type weight.`);
  console.log(`   To increase trust, get bilateral attestations from transaction partners.\n`);

} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
