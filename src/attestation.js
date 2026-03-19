/**
 * Attestation builder and publisher for NIP Agent Reputation.
 * 
 * Builds kind 30078 events from collected metrics and publishes
 * them to Nostr relays.
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';

// Polyfill WebSocket for Node.js
useWebSocketImplementation(WebSocket);

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
];

const DEFAULT_HALF_LIFE_HOURS = 720; // 30 days
const SAMPLE_WINDOW_HOURS = 168;     // 7 days

/**
 * Build a kind 30078 self-attestation event from LND metrics.
 */
export function buildSelfAttestation(metrics, secretKey, opts = {}) {
  const serviceType = opts.serviceType || 'lightning-node';
  const halfLifeHours = opts.halfLifeHours || DEFAULT_HALF_LIFE_HOURS;
  const sampleWindowHours = opts.sampleWindowHours || SAMPLE_WINDOW_HOURS;
  const nostrPubkey = opts.nostrPubkey; // 32-byte hex Nostr pubkey of the subject
  
  // d tag uses LND pubkey as identifier (unique per node+service)
  const dTag = `${metrics.pubkey}:${serviceType}`;
  
  const tags = [
    ['d', dTag],
    ['service_type', serviceType],
    // LND node pubkey (33-byte compressed secp256k1) goes in its own tag
    ['node_pubkey', metrics.pubkey],
  ];
  
  // p tag must be a 32-byte Nostr pubkey (if provided)
  if (nostrPubkey) {
    tags.push(['p', nostrPubkey]);
  }
  
  // Add dimension tags
  for (const [name, data] of Object.entries(metrics.dimensions)) {
    tags.push(['dimension', name, data.value, String(data.sampleSize)]);
  }
  
  // Add metadata tags
  tags.push(['half_life_hours', String(halfLifeHours)]);
  tags.push(['sample_window_hours', String(sampleWindowHours)]);
  tags.push(['attestation_type', 'self']);
  tags.push(['L', 'agent-reputation']);
  tags.push(['l', 'attestation', 'agent-reputation']);
  
  const eventTemplate = {
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      version: '0.1',
      node_alias: metrics.alias,
      block_height: metrics.blockHeight,
      synced: metrics.syncedToChain && metrics.syncedToGraph,
    }),
  };
  
  const signedEvent = finalizeEvent(eventTemplate, secretKey);
  
  // Verify our own event
  const valid = verifyEvent(signedEvent);
  if (!valid) throw new Error('Self-verification failed on signed event');
  
  return signedEvent;
}

/**
 * Publish an event to multiple relays.
 * Returns which relays accepted vs rejected.
 */
export async function publishToRelays(event, relays = DEFAULT_RELAYS) {
  const pool = new SimplePool();
  const results = { accepted: [], rejected: [], errors: [] };
  
  try {
    const promises = relays.map(async (relay) => {
      try {
        await Promise.race([
          pool.publish([relay], event),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
        ]);
        results.accepted.push(relay);
      } catch (err) {
        results.rejected.push({ relay, error: err.message });
      }
    });
    
    await Promise.allSettled(promises);
  } finally {
    pool.close(relays);
  }
  
  return results;
}

/**
 * Query attestations for a given pubkey from relays.
 */
export async function queryAttestations(subjectPubkey, relays = DEFAULT_RELAYS, opts = {}) {
  const pool = new SimplePool();
  const serviceType = opts.serviceType || null;
  
  const baseFilter = { kinds: [30078] };
  if (opts.since) baseFilter.since = opts.since;
  if (opts.limit) baseFilter.limit = opts.limit;
  
  let allEvents = [];
  
  try {
    if (subjectPubkey.length === 64) {
      // Nostr pubkey: query via #p tag (bilateral attestations) AND via author (self-attestations)
      // Both are valid: self-attesting nodes may or may not include p tag on older events
      const [byP, byAuthor] = await Promise.all([
        pool.querySync(relays, { ...baseFilter, '#p': [subjectPubkey] }),
        pool.querySync(relays, { ...baseFilter, authors: [subjectPubkey] }),
      ]);
      // Merge and deduplicate by event ID
      const seen = new Set();
      for (const e of [...byP, ...byAuthor]) {
        if (!seen.has(e.id)) { seen.add(e.id); allEvents.push(e); }
      }
    } else if (subjectPubkey.length === 66) {
      // LND node pubkey: can't filter by relay tag efficiently; fetch agent-reputation events
      // and post-filter by node_pubkey tag
      allEvents = await pool.querySync(relays, { ...baseFilter, '#L': ['agent-reputation'] });
    } else {
      throw new Error(`Unknown pubkey format (length ${subjectPubkey.length}); expected 64 (Nostr) or 66 (LND)`);
    }
    
    // Parse, verify, and filter
    let parsed = allEvents
      .filter(e => verifyEvent(e))
      .map(e => parseAttestation(e))
      .filter(a => !serviceType || a.serviceType === serviceType);
    
    // Post-filter by LND pubkey if that was the query
    if (subjectPubkey.length === 66) {
      parsed = parsed.filter(a => a.nodePubkey === subjectPubkey);
    }
    
    return parsed;
  } finally {
    pool.close(relays);
  }
}

/**
 * Parse a kind 30078 event into a structured attestation object.
 */
export function parseAttestation(event) {
  const tags = event.tags || [];
  
  const getTag = (name) => {
    const tag = tags.find(t => t[0] === name);
    return tag ? tag[1] : null;
  };
  
  const dimensions = tags
    .filter(t => t[0] === 'dimension')
    .map(t => ({
      name: t[1],
      value: parseFloat(t[2]),
      sampleSize: parseInt(t[3] || '0'),
    }));
  
  const ageHours = (Date.now() / 1000 - event.created_at) / 3600;
  const halfLife = parseFloat(getTag('half_life_hours') || '720');
  const decayWeight = Math.min(1.0, Math.max(0, Math.pow(2, -ageHours / halfLife)));
  
  let content = {};
  try { content = JSON.parse(event.content); } catch {}
  
  return {
    id: event.id,
    attester: event.pubkey,
    subject: getTag('p') || getTag('d')?.split(':')[0],
    nodePubkey: getTag('node_pubkey') || getTag('d')?.split(':')[0],
    serviceType: getTag('service_type'),
    attestationType: getTag('attestation_type') || 'unknown',
    dimensions,
    halfLifeHours: halfLife,
    sampleWindowHours: parseFloat(getTag('sample_window_hours') || '168'),
    createdAt: event.created_at,
    ageHours: Math.round(ageHours * 10) / 10,
    decayWeight: Math.round(decayWeight * 1000) / 1000,
    content,
    raw: event,
  };
}

/**
 * Apply decay-weighted aggregation across multiple attestations.
 */
export function aggregateAttestations(attestations) {
  // Weight by attestation type
  const typeWeights = { bilateral: 1.0, observer: 0.7, self: 0.3, unknown: 0.1 };
  
  const dimensionAgg = {};
  
  for (const att of attestations) {
    const typeWeight = typeWeights[att.attestationType] || 0.1;
    const totalWeight = att.decayWeight * typeWeight;
    
    for (const dim of att.dimensions) {
      if (!dimensionAgg[dim.name]) {
        dimensionAgg[dim.name] = { weightedSum: 0, totalWeight: 0, count: 0 };
      }
      dimensionAgg[dim.name].weightedSum += dim.value * totalWeight;
      dimensionAgg[dim.name].totalWeight += totalWeight;
      dimensionAgg[dim.name].count += 1;
    }
  }
  
  const result = {};
  for (const [name, agg] of Object.entries(dimensionAgg)) {
    result[name] = {
      weightedAvg: agg.totalWeight > 0 ? agg.weightedSum / agg.totalWeight : 0,
      numAttesters: agg.count,
      totalWeight: Math.round(agg.totalWeight * 1000) / 1000,
    };
  }
  
  return result;
}

export { DEFAULT_RELAYS };
