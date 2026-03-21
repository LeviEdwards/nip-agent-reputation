#!/usr/bin/env node
/**
 * Example 3: Publish a bilateral attestation after a transaction
 * 
 * Bilateral attestations are the gold standard — they prove you actually
 * transacted with the agent and can report on their real behavior.
 * Weight: 1.0 (highest trust tier).
 * 
 * This example shows two patterns:
 *   A) Manual attestation — you provide the dimensions directly
 *   B) History-based — log transactions, auto-compute dimensions
 * 
 * Usage:
 *   node examples/03-bilateral-attestation.js
 */

import {
  TransactionRecord,
  TransactionHistory,
  buildBilateralAttestation,
  buildBilateralFromHistory,
} from '../index.js';
import { publishToRelays, DEFAULT_RELAYS } from '../index.js';
import { getKeypair } from '../src/keys.js';

const { secretKey, publicKey } = getKeypair();

// ─── Pattern A: Manual bilateral attestation ─────────────────────────

console.log('\n━━━ Pattern A: Manual bilateral attestation ━━━\n');

const manualEvent = buildBilateralAttestation({
  // The agent you're attesting (their LND node pubkey)
  counterpartyNodePubkey: '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f',
  // Optional: their Nostr pubkey (enables #p tag querying)
  counterpartyNostrPubkey: null,
  serviceType: 'lightning-node',
  dimensions: {
    settlement_rate:    { value: '0.95', sampleSize: 20 },
    response_time_ms:   { value: '340',  sampleSize: 20 },
    dispute_rate:       { value: '0.00', sampleSize: 20 },
    transaction_volume_sats: { value: '150000', sampleSize: 19 },
  },
}, secretKey);

console.log(`  Built event: ${manualEvent.id.slice(0, 16)}...`);
console.log(`  Dimensions: ${manualEvent.tags.filter(t => t[0] === 'dimension').length}`);
console.log(`  Type: bilateral (weight 1.0)\n`);

// ─── Pattern B: Transaction history → auto-compute ───────────────────

console.log('━━━ Pattern B: History-based bilateral attestation ━━━\n');

const history = new TransactionHistory();

// Log each transaction as it happens (in your payment flow)
history.add(new TransactionRecord({
  counterpartyNodePubkey: '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f',
  serviceType: 'lightning-node',
  invoiceAmountSats: 5000,
  settled: true,
  responseTimeMs: 280,
  disputeOccurred: false,
}));

history.add(new TransactionRecord({
  counterpartyNodePubkey: '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f',
  serviceType: 'lightning-node',
  invoiceAmountSats: 12000,
  settled: true,
  responseTimeMs: 410,
  disputeOccurred: false,
}));

history.add(new TransactionRecord({
  counterpartyNodePubkey: '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f',
  serviceType: 'lightning-node',
  invoiceAmountSats: 3000,
  settled: false,  // This one failed
  responseTimeMs: null,
  disputeOccurred: false,
}));

// Build bilateral attestation from accumulated history
const historyEvent = buildBilateralFromHistory(
  history,
  '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f',
  secretKey,
  { serviceType: 'lightning-node' }
);

console.log(`  Built event: ${historyEvent.id.slice(0, 16)}...`);
console.log(`  Computed from ${history.transactions.length} transactions:`);

// Show computed dimensions
for (const tag of historyEvent.tags.filter(t => t[0] === 'dimension')) {
  console.log(`    ${tag[1].padEnd(28)} = ${tag[2]} (n=${tag[3]})`);
}

// ─── Persist history for future attestations ─────────────────────────

console.log('\n━━━ Persisting transaction history ━━━\n');

// Save to disk (for accumulating transactions over time)
const serialized = JSON.stringify(history.toJSON(), null, 2);
console.log(`  Serialized ${history.transactions.length} transactions (${serialized.length} bytes)`);

// Load back
const restored = TransactionHistory.fromJSON(JSON.parse(serialized));
console.log(`  Restored ${restored.transactions.length} transactions`);

// ─── Optional: publish to relays ─────────────────────────────────────

const PUBLISH = process.env.PUBLISH === 'true';
if (PUBLISH) {
  console.log('\n📤 Publishing to relays...');
  const results = await publishToRelays(historyEvent, DEFAULT_RELAYS);
  console.log(`   ${results.accepted.length}/${DEFAULT_RELAYS.length} relays accepted`);
} else {
  console.log('\n💡 Set PUBLISH=true to publish to relays (dry run by default)');
}

console.log();
