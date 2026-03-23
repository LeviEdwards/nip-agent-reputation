/**
 * Bilateral attestation builder for NIP Agent Reputation.
 * 
 * After a transaction between two agents, each party publishes
 * a kind 30385 attestation of the other's behavior.
 * 
 * Usage:
 *   import { buildBilateralAttestation, TransactionRecord } from './bilateral.js';
 *   
 *   const tx = new TransactionRecord({
 *     counterpartyNodePubkey: '03abc...',      // LND pubkey (66 hex)
 *     counterpartyNostrPubkey: '1bb7ae...',     // Nostr pubkey (64 hex, optional)
 *     serviceType: 'lightning-node',
 *     invoiceAmountSats: 1000,
 *     settled: true,
 *     responseTimeMs: 450,
 *     disputeOccurred: false,
 *   });
 *   
 *   const event = buildBilateralAttestation(tx, secretKey, txHistory);
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { ATTESTATION_KIND } from './constants.js';

const DEFAULT_HALF_LIFE_HOURS = 720; // 30 days

/**
 * Represents a completed transaction for bilateral attestation.
 */
export class TransactionRecord {
  constructor(opts) {
    this.counterpartyNodePubkey = opts.counterpartyNodePubkey;     // 66 hex LND pubkey
    this.counterpartyNostrPubkey = opts.counterpartyNostrPubkey;   // 64 hex Nostr pubkey (optional)
    this.serviceType = opts.serviceType || 'lightning-node';
    this.invoiceAmountSats = opts.invoiceAmountSats || 0;
    this.settled = opts.settled !== undefined ? opts.settled : true;
    this.responseTimeMs = opts.responseTimeMs || null;
    this.disputeOccurred = opts.disputeOccurred || false;
    this.timestamp = opts.timestamp || Math.floor(Date.now() / 1000);
    this.memo = opts.memo || '';
  }
}

/**
 * Transaction history tracker. Maintains a rolling window of
 * transactions with a counterparty for computing bilateral metrics.
 */
export class TransactionHistory {
  constructor() {
    this.transactions = [];
  }

  add(tx) {
    if (!(tx instanceof TransactionRecord)) {
      tx = new TransactionRecord(tx);
    }
    this.transactions.push(tx);
    return this;
  }

  /**
   * Get transactions for a specific counterparty within a time window.
   */
  getForCounterparty(nodePubkey, windowHours = 168) {
    const cutoff = Math.floor(Date.now() / 1000) - (windowHours * 3600);
    return this.transactions.filter(tx =>
      tx.counterpartyNodePubkey === nodePubkey &&
      tx.timestamp >= cutoff
    );
  }

  /**
   * Compute bilateral dimensions from transaction history with a counterparty.
   */
  computeDimensions(nodePubkey, windowHours = 168) {
    const txs = this.getForCounterparty(nodePubkey, windowHours);
    if (txs.length === 0) return null;

    const settled = txs.filter(tx => tx.settled);
    const disputed = txs.filter(tx => tx.disputeOccurred);
    const withResponseTime = txs.filter(tx => tx.responseTimeMs !== null);

    const settlementRate = txs.length > 0 ? settled.length / txs.length : 0;
    const disputeRate = txs.length > 0 ? disputed.length / txs.length : 0;
    const avgResponseTime = withResponseTime.length > 0
      ? withResponseTime.reduce((sum, tx) => sum + tx.responseTimeMs, 0) / withResponseTime.length
      : null;
    const totalVolumeSats = settled.reduce((sum, tx) => sum + tx.invoiceAmountSats, 0);

    const dimensions = {
      settlement_rate: {
        value: settlementRate.toFixed(4),
        sampleSize: txs.length,
      },
      dispute_rate: {
        value: disputeRate.toFixed(4),
        sampleSize: txs.length,
      },
      transaction_volume_sats: {
        value: String(totalVolumeSats),
        sampleSize: settled.length,
      },
    };

    if (avgResponseTime !== null) {
      dimensions.response_time_ms = {
        value: avgResponseTime.toFixed(0),
        sampleSize: withResponseTime.length,
      };
    }

    return dimensions;
  }

  /**
   * Serialize to JSON for persistence.
   */
  toJSON() {
    return this.transactions.map(tx => ({
      counterpartyNodePubkey: tx.counterpartyNodePubkey,
      counterpartyNostrPubkey: tx.counterpartyNostrPubkey,
      serviceType: tx.serviceType,
      invoiceAmountSats: tx.invoiceAmountSats,
      settled: tx.settled,
      responseTimeMs: tx.responseTimeMs,
      disputeOccurred: tx.disputeOccurred,
      timestamp: tx.timestamp,
      memo: tx.memo,
    }));
  }

  /**
   * Load from JSON.
   */
  static fromJSON(data) {
    const history = new TransactionHistory();
    for (const item of data) {
      history.add(new TransactionRecord(item));
    }
    return history;
  }
}

/**
 * Build a bilateral attestation event (kind 30385).
 * 
 * This is published by the attester after transacting with the subject.
 * The attestation type is 'bilateral', carrying higher trust weight
 * than self-attestations.
 * 
 * @param {object} opts - Options
 * @param {string} opts.counterpartyNodePubkey - LND pubkey (66 hex) of the subject
 * @param {string} opts.counterpartyNostrPubkey - Nostr pubkey (64 hex) of the subject (optional)
 * @param {string} opts.serviceType - Service type being attested
 * @param {object} opts.dimensions - { name: { value, sampleSize } }
 * @param {number} opts.halfLifeHours - Decay half-life (default 720)
 * @param {number} opts.sampleWindowHours - Window over which metrics were measured
 * @param {Uint8Array} secretKey - Attester's Nostr secret key
 */
export function buildBilateralAttestation(opts, secretKey) {
  const {
    counterpartyNodePubkey,
    counterpartyNostrPubkey,
    serviceType = 'lightning-node',
    dimensions,
    halfLifeHours = DEFAULT_HALF_LIFE_HOURS,
    sampleWindowHours = 168,
  } = opts;

  if (!counterpartyNodePubkey && !counterpartyNostrPubkey) {
    throw new Error('At least one of counterpartyNodePubkey or counterpartyNostrPubkey is required');
  }
  if (!dimensions || Object.keys(dimensions).length === 0) {
    throw new Error('At least one dimension is required');
  }

  const dTag = `${counterpartyNodePubkey || counterpartyNostrPubkey}:${serviceType}`;

  const tags = [
    ['d', dTag],
    ['service_type', serviceType],
  ];

  if (counterpartyNodePubkey) {
    tags.push(['node_pubkey', counterpartyNodePubkey]);
  }
  if (counterpartyNostrPubkey) {
    tags.push(['p', counterpartyNostrPubkey]);
  }

  // Add dimension tags
  for (const [name, data] of Object.entries(dimensions)) {
    tags.push(['dimension', name, String(data.value), String(data.sampleSize)]);
  }

  tags.push(['half_life_hours', String(halfLifeHours)]);
  tags.push(['sample_window_hours', String(sampleWindowHours)]);
  tags.push(['attestation_type', 'bilateral']);
  tags.push(['L', 'agent-reputation']);
  tags.push(['l', 'attestation', 'agent-reputation']);

  const eventTemplate = {
    kind: ATTESTATION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      version: '0.3',
      attestation_type: 'bilateral',
      note: 'Published after direct transaction(s) with the subject agent.',
    }),
  };

  const signedEvent = finalizeEvent(eventTemplate, secretKey);
  if (!verifyEvent(signedEvent)) throw new Error('Self-verification failed');

  return signedEvent;
}

/**
 * Build a bilateral attestation from transaction history.
 * Convenience wrapper: computes dimensions from history, then builds the event.
 */
export function buildBilateralFromHistory(history, counterpartyNodePubkey, secretKey, opts = {}) {
  const windowHours = opts.sampleWindowHours || 168;
  const dimensions = history.computeDimensions(counterpartyNodePubkey, windowHours);

  if (!dimensions) {
    throw new Error(`No transactions found with ${counterpartyNodePubkey} in the last ${windowHours} hours`);
  }

  return buildBilateralAttestation({
    counterpartyNodePubkey,
    counterpartyNostrPubkey: opts.counterpartyNostrPubkey,
    serviceType: opts.serviceType || 'lightning-node',
    dimensions,
    halfLifeHours: opts.halfLifeHours,
    sampleWindowHours: windowHours,
  }, secretKey);
}
