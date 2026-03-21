#!/usr/bin/env node
/**
 * Example 5: Pre-payment reputation gate
 * 
 * Real-world pattern: before paying an L402 invoice or opening a channel,
 * check the counterparty's reputation and make a go/no-go decision.
 * 
 * This is the "killer app" — automated trust decisions before payments.
 * 
 * Usage:
 *   node examples/05-pre-payment-gate.js <counterparty_pubkey> <amount_sats>
 *   node examples/05-pre-payment-gate.js 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f 50000
 */

import {
  queryAttestations,
  aggregateAttestations,
} from '../index.js';

const counterparty = process.argv[2];
const amountSats = parseInt(process.argv[3] || '1000');

if (!counterparty) {
  console.error('Usage: node 05-pre-payment-gate.js <counterparty_pubkey> <amount_sats>');
  process.exit(1);
}

/**
 * Reputation policy — customize these thresholds for your risk tolerance.
 * 
 * This is intentionally NOT in the protocol. Each agent sets their own
 * policy based on their risk tolerance and the transaction size.
 */
const POLICY = {
  // Minimum settlement rate (below this, reject)
  minSettlementRate: 0.90,
  
  // Maximum acceptable dispute rate
  maxDisputeRate: 0.10,
  
  // Minimum total attestation weight (below 0.5 = self-only)
  minTotalWeight: 0.3,
  
  // For large transactions (>50k sats), require stronger reputation
  largeTransactionThreshold: 50000,
  largeMinTotalWeight: 1.0,   // Need external attestations
  largeMinSettlementRate: 0.95,
  
  // Maximum amount with zero reputation history
  maxBlindPayment: 100,  // sats — only risk pocket change on unknown agents
};

console.log(`\n🔒 Pre-payment reputation check`);
console.log(`   Counterparty: ${counterparty.slice(0, 20)}...`);
console.log(`   Amount: ${amountSats.toLocaleString()} sats\n`);

try {
  const attestations = await queryAttestations(counterparty);
  
  // ─── No reputation at all ──────────────────────────────────────
  if (attestations.length === 0) {
    if (amountSats <= POLICY.maxBlindPayment) {
      console.log(`⚠️  PROCEED WITH CAUTION — No reputation history`);
      console.log(`   Amount (${amountSats} sats) is within blind payment limit (${POLICY.maxBlindPayment} sats)`);
      console.log(`   Decision: ALLOW (pocket change risk)\n`);
    } else {
      console.log(`🚫 REJECT — No reputation history`);
      console.log(`   Amount (${amountSats.toLocaleString()} sats) exceeds blind payment limit (${POLICY.maxBlindPayment} sats)`);
      console.log(`   Decision: DENY\n`);
    }
    process.exit(0);
  }

  const aggregated = aggregateAttestations(attestations);
  
  // ─── Check individual dimensions ───────────────────────────────
  const issues = [];
  const isLarge = amountSats > POLICY.largeTransactionThreshold;
  const requiredWeight = isLarge ? POLICY.largeMinTotalWeight : POLICY.minTotalWeight;
  const requiredSettlement = isLarge ? POLICY.largeMinSettlementRate : POLICY.minSettlementRate;

  // Settlement rate
  if (aggregated.settlement_rate) {
    const sr = aggregated.settlement_rate;
    if (sr.weightedAvg < requiredSettlement) {
      issues.push(`settlement_rate ${sr.weightedAvg.toFixed(3)} < ${requiredSettlement} required`);
    }
    if (sr.totalWeight < requiredWeight) {
      issues.push(`attestation weight ${sr.totalWeight.toFixed(3)} < ${requiredWeight} required`);
    }
  } else {
    issues.push('no settlement_rate data available');
  }

  // Dispute rate
  if (aggregated.dispute_rate) {
    if (aggregated.dispute_rate.weightedAvg > POLICY.maxDisputeRate) {
      issues.push(`dispute_rate ${aggregated.dispute_rate.weightedAvg.toFixed(3)} > ${POLICY.maxDisputeRate} max`);
    }
  }

  // ─── Decision ──────────────────────────────────────────────────
  console.log('📊 Reputation data:');
  for (const [name, data] of Object.entries(aggregated)) {
    const val = data.weightedAvg < 10
      ? data.weightedAvg.toFixed(4)
      : Math.round(data.weightedAvg).toLocaleString();
    console.log(`   ${name.padEnd(28)} ${val} (weight: ${data.totalWeight})`);
  }
  console.log();

  if (issues.length === 0) {
    console.log(`✅ APPROVED — Reputation meets policy requirements`);
    console.log(`   ${attestations.length} attestation(s) from the network`);
    if (isLarge) console.log(`   Large transaction policy applied (>${POLICY.largeTransactionThreshold.toLocaleString()} sats)`);
  } else {
    console.log(`🚫 REJECTED — Policy violations:`);
    for (const issue of issues) {
      console.log(`   • ${issue}`);
    }
  }

  console.log(`\n   Decision: ${issues.length === 0 ? 'ALLOW' : 'DENY'}\n`);

} catch (err) {
  console.error(`Error: ${err.message}`);
  console.log('   Decision: DENY (query failed — fail closed)\n');
  process.exit(1);
}
