#!/usr/bin/env node
/**
 * Example 7: L402 middleware integration
 * 
 * Shows how to integrate reputation checks into an L402 payment flow.
 * Before paying an L402 invoice, check the server's reputation.
 * After successful payment, publish a bilateral attestation.
 * 
 * This is a pattern sketch — adapt to your L402 library.
 * 
 * Usage:
 *   node examples/07-l402-integration.js
 */

import {
  queryAttestations,
  aggregateAttestations,
  TransactionRecord,
  TransactionHistory,
  buildBilateralAttestation,
  publishToRelays,
} from '../index.js';
import { getKeypair } from '../src/keys.js';

const { secretKey } = getKeypair();

/**
 * ReputationGatedL402Client wraps an L402 payment flow with reputation checks.
 * 
 * Integration pattern:
 *   1. Receive 402 response with invoice + server pubkey
 *   2. Check server reputation via Nostr
 *   3. If reputation meets policy → pay invoice
 *   4. After successful service delivery → record transaction
 *   5. Periodically publish bilateral attestation from accumulated history
 */
class ReputationGatedL402Client {
  constructor(opts = {}) {
    this.keypair = opts.keypair || getKeypair();
    this.history = opts.history || new TransactionHistory();
    this.minSettlementRate = opts.minSettlementRate || 0.85;
    this.maxBlindPayment = opts.maxBlindPayment || 50; // sats
    this.attestAfterN = opts.attestAfterN || 5; // attest after every N transactions
    this._txCountSinceAttest = 0;
  }

  /**
   * Check if a server meets reputation requirements for a given payment.
   * Returns { approved, reason, attestations, aggregated }
   */
  async checkReputation(serverPubkey, amountSats) {
    const attestations = await queryAttestations(serverPubkey);
    
    if (attestations.length === 0) {
      return {
        approved: amountSats <= this.maxBlindPayment,
        reason: amountSats <= this.maxBlindPayment
          ? `No reputation — amount within blind limit (${this.maxBlindPayment} sats)`
          : `No reputation — amount exceeds blind limit (${this.maxBlindPayment} sats)`,
        attestations: [],
        aggregated: {},
      };
    }

    const aggregated = aggregateAttestations(attestations);
    
    if (aggregated.settlement_rate?.weightedAvg < this.minSettlementRate) {
      return {
        approved: false,
        reason: `Settlement rate ${aggregated.settlement_rate.weightedAvg.toFixed(3)} below minimum ${this.minSettlementRate}`,
        attestations,
        aggregated,
      };
    }

    return {
      approved: true,
      reason: 'Reputation meets requirements',
      attestations,
      aggregated,
    };
  }

  /**
   * Record a completed transaction. Call after L402 payment + service delivery.
   */
  recordTransaction(serverNodePubkey, amountSats, responseTimeMs, settled = true) {
    this.history.add(new TransactionRecord({
      counterpartyNodePubkey: serverNodePubkey,
      serviceType: 'l402-proxy',
      invoiceAmountSats: amountSats,
      settled,
      responseTimeMs,
      disputeOccurred: false,
    }));
    
    this._txCountSinceAttest++;
    return this._txCountSinceAttest >= this.attestAfterN;
  }

  /**
   * Build + publish bilateral attestation for a server.
   * Call periodically (e.g., every N transactions).
   */
  async publishAttestation(serverNodePubkey) {
    const dims = this.history.computeDimensions(serverNodePubkey);
    if (!dims) return null;

    const event = buildBilateralAttestation({
      counterpartyNodePubkey: serverNodePubkey,
      serviceType: 'l402-proxy',
      dimensions: dims,
    }, this.keypair.secretKey);

    const results = await publishToRelays(event);
    this._txCountSinceAttest = 0;
    
    return { event, results };
  }
}

// ─── Demo flow ───────────────────────────────────────────────────────

console.log('\n━━━ L402 + Reputation Integration Demo ━━━\n');

const client = new ReputationGatedL402Client({
  minSettlementRate: 0.85,
  maxBlindPayment: 50,
  attestAfterN: 3,
});

// Simulate an L402 flow
const serverPubkey = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f';
const paymentAmount = 10; // sats

console.log(`1️⃣  Received 402 from server ${serverPubkey.slice(0, 16)}...`);
console.log(`   Invoice amount: ${paymentAmount} sats\n`);

// Step 1: Check reputation
console.log('2️⃣  Checking server reputation...');
const check = await client.checkReputation(serverPubkey, paymentAmount);
console.log(`   Approved: ${check.approved}`);
console.log(`   Reason: ${check.reason}\n`);

if (!check.approved) {
  console.log('   🚫 Payment blocked by reputation policy\n');
  process.exit(0);
}

// Step 2: Simulate payment + service delivery
console.log('3️⃣  Paying invoice and receiving service...');
const startTime = Date.now();
// ... your L402 payment code here ...
const responseTime = Date.now() - startTime + 250; // simulated
console.log(`   Payment settled, response: ${responseTime}ms\n`);

// Step 3: Record the transaction
const shouldAttest = client.recordTransaction(serverPubkey, paymentAmount, responseTime, true);
console.log(`4️⃣  Transaction recorded (${client.history.transactions.length} total)`);

// Step 4: Auto-attest after N transactions
if (shouldAttest) {
  console.log(`\n5️⃣  Publishing bilateral attestation (every ${client.attestAfterN} transactions)...`);
  // In production, uncomment:
  // const { event, results } = await client.publishAttestation(serverPubkey);
  console.log('   (dry run — uncomment publishAttestation() to publish)\n');
} else {
  console.log(`   ${client.attestAfterN - client._txCountSinceAttest} more transaction(s) until next attestation\n`);
}
