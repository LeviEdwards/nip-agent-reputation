/**
 * NIP-30386 Reputation Client SDK
 * 
 * Zero-dependency, single-file client for querying agent reputation.
 * Works in Node.js 18+ and modern browsers (uses native fetch).
 * 
 * Usage:
 *   import { ReputationClient } from './reputation-client.js';
 *   const client = new ReputationClient();
 *   const rep = await client.query('deadbeef...');
 *   if (client.shouldPay(rep, 5000)) { // pay }
 * 
 * @module reputation-client
 * @version 1.0.0
 * @license MIT
 */

const DEFAULT_API = 'https://dispatches.mystere.me/api/reputation';

export class ReputationClient {
  /**
   * @param {object} [options]
   * @param {string} [options.apiBase] - Base URL of a NIP-30386 reputation API
   * @param {number} [options.timeoutMs=10000] - Request timeout
   * @param {object} [options.policy] - Payment policy overrides
   */
  constructor(options = {}) {
    this.apiBase = (options.apiBase || DEFAULT_API).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs || 10000;
    this.policy = {
      minSettlementRate: 0.90,
      maxDisputeRate: 0.10,
      minTotalWeight: 0.3,
      largeThresholdSats: 50000,
      largeMinWeight: 1.0,
      largeMinSettlement: 0.95,
      maxBlindPaymentSats: 100,
      ...options.policy,
    };
  }

  /**
   * Query aggregated reputation for a pubkey.
   * @param {string} pubkey - 64-hex Nostr, 66-hex LND, or npub
   * @returns {Promise<object>} Reputation data
   */
  async query(pubkey) {
    const url = `${this.apiBase}/${encodeURIComponent(pubkey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Discover available agent services.
   * @param {object} [filters] - { type, protocol, max_age, min_trust }
   * @returns {Promise<object>} Discovery results
   */
  async discover(filters = {}) {
    const params = new URLSearchParams();
    if (filters.type) params.set('type', filters.type);
    if (filters.protocol) params.set('protocol', filters.protocol);
    if (filters.max_age) params.set('max_age', String(filters.max_age));
    if (filters.min_trust) params.set('min_trust', String(filters.min_trust));
    params.set('reputation', 'true');
    const qs = params.toString();
    const url = `${this.apiBase.replace(/\/[^/]*$/, '/discover')}${qs ? '?' + qs : ''}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get the SVG badge URL for a pubkey.
   * @param {string} pubkey - 64-hex or 66-hex pubkey
   * @returns {string} Badge image URL
   */
  badgeUrl(pubkey) {
    return `${this.apiBase}/badge/${encodeURIComponent(pubkey)}`;
  }

  /**
   * Evaluate whether to proceed with a payment based on reputation.
   * Returns a decision object with allow/deny and reasons.
   * 
   * @param {object} reputation - Result from query()
   * @param {number} amountSats - Payment amount in satoshis
   * @returns {{ allow: boolean, reasons: string[], trustLevel: string, attestationCount: number }}
   */
  evaluate(reputation, amountSats) {
    const result = {
      allow: false,
      reasons: [],
      trustLevel: reputation.trustLevel || 'none',
      attestationCount: reputation.attestationCount || 0,
    };

    // No attestations at all
    if (!reputation.attestationCount || reputation.attestationCount === 0) {
      if (amountSats <= this.policy.maxBlindPaymentSats) {
        result.allow = true;
        result.reasons.push(`blind payment within limit (${amountSats} <= ${this.policy.maxBlindPaymentSats} sats)`);
      } else {
        result.reasons.push(`no reputation history, amount ${amountSats} exceeds blind limit ${this.policy.maxBlindPaymentSats}`);
      }
      return result;
    }

    const dims = reputation.dimensions || {};
    const isLarge = amountSats > this.policy.largeThresholdSats;
    const reqWeight = isLarge ? this.policy.largeMinWeight : this.policy.minTotalWeight;
    const reqSettlement = isLarge ? this.policy.largeMinSettlement : this.policy.minSettlementRate;
    const issues = [];

    // Check settlement rate
    if (dims.settlement_rate) {
      if (dims.settlement_rate.weightedAvg < reqSettlement) {
        issues.push(`settlement_rate ${dims.settlement_rate.weightedAvg.toFixed(3)} < ${reqSettlement}`);
      }
      if (dims.settlement_rate.totalWeight < reqWeight) {
        issues.push(`weight ${dims.settlement_rate.totalWeight.toFixed(2)} < ${reqWeight} required`);
      }
    }

    // Check payment success
    if (dims.payment_success_rate) {
      if (dims.payment_success_rate.weightedAvg < reqSettlement) {
        issues.push(`payment_success_rate ${dims.payment_success_rate.weightedAvg.toFixed(3)} < ${reqSettlement}`);
      }
    }

    // Check dispute rate
    if (dims.dispute_rate && dims.dispute_rate.weightedAvg > this.policy.maxDisputeRate) {
      issues.push(`dispute_rate ${dims.dispute_rate.weightedAvg.toFixed(3)} > ${this.policy.maxDisputeRate}`);
    }

    // Self-only attestations for large payments
    if (isLarge && reputation.selfOnly) {
      issues.push('large payment but only self-attestations (no external verification)');
    }

    if (issues.length === 0) {
      result.allow = true;
      result.reasons.push(`${reputation.attestationCount} attestation(s), trust: ${reputation.trustLevel}`);
      if (isLarge) result.reasons.push('large transaction policy passed');
    } else {
      result.reasons = issues;
    }

    return result;
  }

  /**
   * Shorthand: should I pay this agent?
   * @param {object} reputation - Result from query()
   * @param {number} amountSats - Payment amount
   * @returns {boolean}
   */
  shouldPay(reputation, amountSats) {
    return this.evaluate(reputation, amountSats).allow;
  }

  /**
   * Full check-then-decide flow in one call.
   * @param {string} pubkey - Counterparty pubkey
   * @param {number} amountSats - Payment amount
   * @returns {Promise<{ allow: boolean, reasons: string[], reputation: object }>}
   */
  async checkAndDecide(pubkey, amountSats) {
    try {
      const reputation = await this.query(pubkey);
      const decision = this.evaluate(reputation, amountSats);
      return { ...decision, reputation };
    } catch (err) {
      return {
        allow: false,
        reasons: [`query failed: ${err.message}`, 'failing closed'],
        trustLevel: 'error',
        attestationCount: 0,
        reputation: null,
      };
    }
  }
}

// Default export for CommonJS-like usage
export default ReputationClient;
