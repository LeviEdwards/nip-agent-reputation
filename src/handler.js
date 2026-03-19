/**
 * Service Handler Declaration (kind 31990) for NIP Agent Reputation.
 * 
 * Agents publish a handler event to advertise what services they offer,
 * enabling discovery before reputation queries.
 * 
 * NIP-89 compatible: kind 31990 is "Handler recommendation" in the Nostr
 * ecosystem. We add agent-reputation labels for discoverability.
 */

import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';

/**
 * Build a kind 31990 service handler declaration event.
 * 
 * @param {object} opts
 * @param {string} opts.serviceId - Unique service identifier (used as d tag)
 * @param {string} opts.description - Human-readable description
 * @param {string} opts.price - Price per unit (e.g. "10")
 * @param {string} opts.priceUnit - Unit of price (e.g. "sats")
 * @param {string} opts.pricePer - Billing granularity (e.g. "per-request")
 * @param {string} opts.protocol - Payment protocol (e.g. "L402", "keysend", "bolt11")
 * @param {string} opts.endpoint - Service endpoint URL
 * @param {string} opts.nodePubkey - LND node pubkey (66 hex, optional)
 * @param {string[]} opts.handlerKinds - Nostr event kinds this handler serves (optional)
 * @param {Uint8Array} secretKey - Nostr secret key for signing
 * @returns {object} Signed Nostr event
 */
export function buildServiceHandler(opts, secretKey) {
  const {
    serviceId,
    description,
    price,
    priceUnit = 'sats',
    pricePer = 'per-request',
    protocol = 'L402',
    endpoint,
    nodePubkey,
    handlerKinds = [],
  } = opts;

  if (!serviceId) throw new Error('serviceId is required');
  if (!description) throw new Error('description is required');

  const tags = [
    ['d', serviceId],
    ['description', description],
  ];

  // Handler kinds (NIP-89 compatible)
  for (const k of handlerKinds) {
    tags.push(['k', String(k)]);
  }

  if (price) {
    tags.push(['price', String(price), priceUnit, pricePer]);
  }
  if (protocol) {
    tags.push(['protocol', protocol]);
  }
  if (endpoint) {
    tags.push(['endpoint', endpoint]);
  }
  if (nodePubkey) {
    tags.push(['node_pubkey', nodePubkey]);
  }

  // Agent reputation labels for discoverability
  tags.push(['L', 'agent-reputation']);
  tags.push(['l', 'handler', 'agent-reputation']);

  const eventTemplate = {
    kind: 31990,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify({
      version: '0.1',
      service_type: serviceId,
    }),
  };

  const signedEvent = finalizeEvent(eventTemplate, secretKey);
  if (!verifyEvent(signedEvent)) throw new Error('Self-verification failed on handler event');

  return signedEvent;
}

/**
 * Parse a kind 31990 handler event into a structured object.
 */
export function parseServiceHandler(event) {
  if (event.kind !== 31990) throw new Error(`Expected kind 31990, got ${event.kind}`);

  const tags = event.tags || [];
  const getTag = (name) => {
    const tag = tags.find(t => t[0] === name);
    return tag ? tag.slice(1) : null;
  };

  const priceTag = getTag('price');

  let content = {};
  try { content = JSON.parse(event.content); } catch {}

  return {
    id: event.id,
    pubkey: event.pubkey,
    serviceId: getTag('d')?.[0],
    description: getTag('description')?.[0],
    price: priceTag ? {
      amount: priceTag[0],
      unit: priceTag[1] || 'sats',
      per: priceTag[2] || 'per-request',
    } : null,
    protocol: getTag('protocol')?.[0],
    endpoint: getTag('endpoint')?.[0],
    nodePubkey: getTag('node_pubkey')?.[0],
    handlerKinds: tags.filter(t => t[0] === 'k').map(t => t[1]),
    labels: tags.filter(t => t[0] === 'L' || t[0] === 'l'),
    createdAt: event.created_at,
    content,
    raw: event,
  };
}

/**
 * Query service handlers from relays.
 */
export async function queryServiceHandlers(pool, relays, opts = {}) {
  const filter = { kinds: [31990], '#L': ['agent-reputation'] };
  if (opts.pubkey) filter.authors = [opts.pubkey];
  if (opts.serviceId) filter['#d'] = [opts.serviceId];

  const events = await pool.querySync(relays, filter);
  return events.map(e => parseServiceHandler(e));
}
