/**
 * Observer attestation builder for NIP Agent Reputation.
 * 
 * An observer is a third-party monitoring service that publishes
 * attestations about agents it has monitored — without being a direct
 * transaction counterparty.
 * 
 * Observer attestations carry intermediate trust weight (0.7) — higher
 * than self (0.3) but lower than bilateral (1.0). An observer's own
 * reputation further modulates the effective weight.
 * 
 * Observation methods:
 *   - Probe: HTTP/Lightning endpoint liveness + latency checks
 *   - Channel: On-chain channel state observation via LND graph
 *   - Aggregate: Combine probe + channel data into attestation
 * 
 * Usage:
 *   import { ObservationSession, buildObserverAttestation } from './observer.js';
 *   
 *   const session = new ObservationSession('03abc...', 'lightning-node');
 *   session.recordProbe({ reachable: true, latencyMs: 120 });
 *   session.recordChannelState({ numChannels: 5, totalCapacity: 2000000, active: true });
 *   
 *   const event = buildObserverAttestation(session, secretKey);
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { ATTESTATION_KIND } from './constants.js';

const DEFAULT_HALF_LIFE_HOURS = 720;

/**
 * A single probe result (endpoint check).
 */
export class ProbeResult {
  constructor(opts = {}) {
    this.reachable = opts.reachable !== undefined ? opts.reachable : true;
    this.latencyMs = opts.latencyMs || null;
    this.timestamp = opts.timestamp || Math.floor(Date.now() / 1000);
    this.method = opts.method || 'ping'; // ping, http, lightning, graph
    this.error = opts.error || null;
  }
}

/**
 * Observed channel state snapshot.
 */
export class ChannelSnapshot {
  constructor(opts = {}) {
    this.numChannels = opts.numChannels || 0;
    this.totalCapacitySats = opts.totalCapacitySats || 0;
    this.activeChannels = opts.activeChannels || 0;
    this.timestamp = opts.timestamp || Math.floor(Date.now() / 1000);
    this.peers = opts.peers || 0;
  }
}

/**
 * Tracks a monitoring session for a single subject agent.
 * Accumulates probes and channel snapshots over time, then
 * computes aggregate dimensions for attestation.
 */
export class ObservationSession {
  constructor(subjectNodePubkey, serviceType = 'lightning-node', opts = {}) {
    this.subjectNodePubkey = subjectNodePubkey;
    this.subjectNostrPubkey = opts.subjectNostrPubkey || null;
    this.serviceType = serviceType;
    this.probes = [];
    this.channelSnapshots = [];
    this.startedAt = Math.floor(Date.now() / 1000);
    this.observerNote = opts.observerNote || '';
  }

  /**
   * Record a probe result.
   */
  recordProbe(opts) {
    const probe = opts instanceof ProbeResult ? opts : new ProbeResult(opts);
    this.probes.push(probe);
    return this;
  }

  /**
   * Record a channel state snapshot.
   */
  recordChannelState(opts) {
    const snap = opts instanceof ChannelSnapshot ? opts : new ChannelSnapshot(opts);
    this.channelSnapshots.push(snap);
    return this;
  }

  /**
   * Compute dimensions from accumulated observations.
   */
  computeDimensions() {
    const dimensions = {};

    // Uptime from probe results
    if (this.probes.length > 0) {
      const reachable = this.probes.filter(p => p.reachable).length;
      const uptimePercent = (reachable / this.probes.length) * 100;
      dimensions.uptime_percent = {
        value: uptimePercent.toFixed(1),
        sampleSize: this.probes.length,
      };

      // Response time from successful probes with latency
      const withLatency = this.probes.filter(p => p.reachable && p.latencyMs !== null);
      if (withLatency.length > 0) {
        const avgLatency = withLatency.reduce((s, p) => s + p.latencyMs, 0) / withLatency.length;
        dimensions.response_time_ms = {
          value: avgLatency.toFixed(0),
          sampleSize: withLatency.length,
        };
      }
    }

    // Channel metrics from snapshots
    if (this.channelSnapshots.length > 0) {
      // Use most recent snapshot for capacity
      const latest = this.channelSnapshots[this.channelSnapshots.length - 1];
      dimensions.capacity_sats = {
        value: String(latest.totalCapacitySats),
        sampleSize: this.channelSnapshots.length,
      };
      dimensions.num_channels = {
        value: String(latest.numChannels),
        sampleSize: this.channelSnapshots.length,
      };

      // Channel availability: fraction of snapshots where node had active channels
      const activeSnapshots = this.channelSnapshots.filter(s => s.activeChannels > 0).length;
      const channelAvailability = activeSnapshots / this.channelSnapshots.length;
      dimensions.channel_availability = {
        value: channelAvailability.toFixed(4),
        sampleSize: this.channelSnapshots.length,
      };
    }

    return dimensions;
  }

  /**
   * Get observation window in hours.
   */
  get windowHours() {
    if (this.probes.length === 0 && this.channelSnapshots.length === 0) return 0;
    const allTimestamps = [
      ...this.probes.map(p => p.timestamp),
      ...this.channelSnapshots.map(s => s.timestamp),
    ];
    const earliest = Math.min(...allTimestamps);
    const latest = Math.max(...allTimestamps);
    return Math.max(1, Math.round((latest - earliest) / 3600));
  }

  /**
   * Serialize session for persistence.
   */
  toJSON() {
    return {
      subjectNodePubkey: this.subjectNodePubkey,
      subjectNostrPubkey: this.subjectNostrPubkey,
      serviceType: this.serviceType,
      startedAt: this.startedAt,
      observerNote: this.observerNote,
      probes: this.probes.map(p => ({
        reachable: p.reachable,
        latencyMs: p.latencyMs,
        timestamp: p.timestamp,
        method: p.method,
        error: p.error,
      })),
      channelSnapshots: this.channelSnapshots.map(s => ({
        numChannels: s.numChannels,
        totalCapacitySats: s.totalCapacitySats,
        activeChannels: s.activeChannels,
        timestamp: s.timestamp,
        peers: s.peers,
      })),
    };
  }

  /**
   * Load from JSON.
   */
  static fromJSON(data) {
    const session = new ObservationSession(data.subjectNodePubkey, data.serviceType, {
      subjectNostrPubkey: data.subjectNostrPubkey,
      observerNote: data.observerNote,
    });
    session.startedAt = data.startedAt;
    for (const p of data.probes || []) session.recordProbe(p);
    for (const s of data.channelSnapshots || []) session.recordChannelState(s);
    return session;
  }
}

/**
 * Build an observer attestation event (kind 30388).
 * 
 * @param {ObservationSession} session - Accumulated observation data
 * @param {Uint8Array} secretKey - Observer's Nostr secret key
 * @param {object} opts - Options
 * @param {string} opts.observerDescription - Free-text description of the observer
 * @param {number} opts.halfLifeHours - Decay half-life
 */
export function buildObserverAttestation(session, secretKey, opts = {}) {
  const {
    observerDescription = '',
    halfLifeHours = DEFAULT_HALF_LIFE_HOURS,
  } = opts;

  const dimensions = session.computeDimensions();

  if (Object.keys(dimensions).length === 0) {
    throw new Error('No observations recorded — cannot build attestation');
  }

  const dTag = `${session.subjectNodePubkey}:${session.serviceType}`;

  const tags = [
    ['d', dTag],
    ['service_type', session.serviceType],
    ['node_pubkey', session.subjectNodePubkey],
  ];

  if (session.subjectNostrPubkey) {
    tags.push(['p', session.subjectNostrPubkey]);
  }

  // Dimension tags
  for (const [name, data] of Object.entries(dimensions)) {
    tags.push(['dimension', name, String(data.value), String(data.sampleSize)]);
  }

  const windowHours = session.windowHours;

  tags.push(['half_life_hours', String(halfLifeHours)]);
  tags.push(['sample_window_hours', String(windowHours)]);
  tags.push(['attestation_type', 'observer']);
  tags.push(['observation_method', session.probes.length > 0 ? session.probes[0].method : 'graph']);
  tags.push(['L', 'agent-reputation']);
  tags.push(['l', 'attestation', 'agent-reputation']);

  const eventTemplate = {
    kind: ATTESTATION_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      version: '0.3',
      attestation_type: 'observer',
      observation_window_hours: windowHours,
      num_probes: session.probes.length,
      num_channel_snapshots: session.channelSnapshots.length,
      observer_description: observerDescription,
      note: session.observerNote || 'Published by a third-party observer monitoring this agent.',
    }),
  };

  const signedEvent = finalizeEvent(eventTemplate, secretKey);
  if (!verifyEvent(signedEvent)) throw new Error('Self-verification failed');

  return signedEvent;
}

/**
 * Observe a Lightning node via the network graph (LND describeGraph / nodeInfo).
 * Returns a ChannelSnapshot from graph data.
 * 
 * @param {function} lndFetch - Function to call LND REST API: (endpoint) => Promise<json>
 * @param {string} nodePubkey - 66-hex LND pubkey to observe
 */
export async function observeNodeFromGraph(lndFetch, nodePubkey) {
  const nodeInfo = await lndFetch(`/v1/graph/node/${nodePubkey}`);
  
  if (!nodeInfo || !nodeInfo.node) {
    return new ChannelSnapshot({ numChannels: 0, totalCapacitySats: 0, activeChannels: 0 });
  }

  const numChannels = nodeInfo.num_channels || 0;
  const totalCapacity = parseInt(nodeInfo.total_capacity || '0');

  // Channel count from graph is all advertised channels;
  // active vs inactive requires probing or channel-level data
  return new ChannelSnapshot({
    numChannels,
    totalCapacitySats: totalCapacity,
    activeChannels: numChannels, // graph only shows advertised (assumed active)
    peers: (nodeInfo.node.addresses || []).length,
  });
}
