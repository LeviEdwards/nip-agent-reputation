#!/usr/bin/env node
/**
 * Example: Payment gate using NIP-30386 reputation
 *
 * Checks an agent's reputation before paying a Lightning invoice.
 * Uses the SDK's checkAndDecide() for a single-call decision.
 *
 * Usage:
 *   node examples/payment-gate.js <agent_pubkey> <amount_sats>
 *
 * Requires: Node.js 18+, no other dependencies (SDK is zero-dep).
 */

import { ReputationClient } from '../sdk/reputation-client.js';

const API = 'https://dispatches.mystere.me/api/reputation';

async function main() {
  const [pubkey, amountStr] = process.argv.slice(2);

  if (!pubkey || !amountStr) {
    console.log('Usage: node examples/payment-gate.js <agent_pubkey> <amount_sats>');
    console.log('');
    console.log('Example:');
    console.log('  node examples/payment-gate.js 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f 50000');
    process.exit(1);
  }

  const amount = parseInt(amountStr, 10);
  const client = new ReputationClient(API);

  console.log(`Checking reputation for ${pubkey.slice(0, 16)}...`);
  console.log(`Payment amount: ${amount.toLocaleString()} sats`);
  console.log('');

  const decision = await client.checkAndDecide(pubkey, amount);

  console.log('Decision:', decision.allow ? '✅ ALLOW' : '❌ DENY');
  console.log('Trust level:', decision.trustLevel);
  console.log('Reasons:', decision.reasons.join(', ') || 'none');
  console.log('');

  if (decision.reputation && decision.reputation.attestationCount > 0) {
    const rep = decision.reputation;
    console.log('Reputation data:');
    console.log('  Attestations:', rep.attestationCount);
    console.log('  Total weight:', rep.totalWeight?.toFixed(2));

    const dims = rep.dimensions || {};
    if (Object.keys(dims).length > 0) {
      console.log('  Dimensions:');
      for (const [name, data] of Object.entries(dims)) {
        const val = typeof data === 'object' ? data.weightedAvg?.toFixed(2) : data;
        const atts = typeof data === 'object' ? data.numAttesters : '?';
        console.log(`    ${name}: ${val} (${atts} attester(s))`);
      }
    }
  } else {
    console.log('No attestations found — agent has no reputation history.');
  }

  console.log('');
  if (decision.allow) {
    console.log('→ Safe to pay this invoice. Proceed with Lightning payment.');
  } else {
    console.log('→ Payment blocked by reputation policy. Review manually or adjust thresholds.');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
