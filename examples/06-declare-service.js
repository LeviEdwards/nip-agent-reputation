#!/usr/bin/env node
/**
 * Example 6: Declare your agent's service (NIP-89 compatible handler)
 * 
 * Publish a kind 31990 event so other agents can discover your service.
 * This is NIP-89 compatible — clients that support NIP-89 handler
 * discovery will find your agent automatically.
 * 
 * Usage:
 *   node examples/06-declare-service.js
 */

import {
  buildServiceHandler,
  publishToRelays,
  DEFAULT_RELAYS,
} from '../index.js';
import { getKeypair } from '../src/keys.js';

const { secretKey } = getKeypair();

// Declare what your agent does
const handler = buildServiceHandler({
  serviceId: 'my-bitcoin-data-api',
  description: 'Real-time Bitcoin network statistics and fee estimates',
  price: '10',
  priceUnit: 'sats',
  pricePer: 'per-request',
  protocol: 'L402',
  endpoint: 'https://api.example.com/v1/bitcoin',
}, secretKey);

console.log('\n📢 Service handler declaration:');
console.log(`   Kind: ${handler.kind} (NIP-89 handler info)`);
console.log(`   Event ID: ${handler.id}`);
console.log(`   Tags:`);

for (const tag of handler.tags) {
  if (['d', 'k', 'description', 'price', 'protocol', 'endpoint'].includes(tag[0])) {
    console.log(`     ${tag[0]}: ${tag.slice(1).join(', ')}`);
  }
}

// Publish (dry run by default)
const PUBLISH = process.env.PUBLISH === 'true';
if (PUBLISH) {
  console.log('\n📤 Publishing...');
  const results = await publishToRelays(handler, DEFAULT_RELAYS);
  console.log(`   ${results.accepted.length}/${DEFAULT_RELAYS.length} relays accepted\n`);
} else {
  console.log('\n💡 Set PUBLISH=true to publish to relays\n');
}
