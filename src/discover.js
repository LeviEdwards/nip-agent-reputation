/**
 * Service Discovery for NIP Agent Reputation.
 * 
 * Queries Nostr relays for kind 31990 handler declarations with
 * agent-reputation labels, cross-references with attestation data
 * to produce enriched service listings.
 */

import { ATTESTATION_KIND, HANDLER_KIND, LEGACY_KINDS } from './constants.js';

/**
 * @typedef {object} DiscoveredService
 * @property {string} pubkey - Publisher's Nostr pubkey
 * @property {string} serviceId - Service identifier (d tag)
 * @property {string} description - Human-readable description
 * @property {object|null} price - Price info {amount, unit, per}
 * @property {string|null} protocol - Payment protocol
 * @property {string|null} endpoint - Service endpoint URL
 * @property {string|null} nodePubkey - LND node pubkey if declared
 * @property {number} createdAt - Unix timestamp of handler event
 * @property {number} ageHours - Hours since declaration
 * @property {object|null} reputation - Reputation summary if attestations exist
 */

/**
 * Discover agent services from relays.
 * 
 * Queries for kind 31990 handler declarations with agent-reputation labels,
 * then optionally enriches each with reputation data from attestations.
 * 
 * @param {object} pool - SimplePool instance (nostr-tools)
 * @param {string[]} relays - Relay URLs to query
 * @param {object} opts
 * @param {string} [opts.serviceType] - Filter by service type (d tag substring match)
 * @param {string} [opts.protocol] - Filter by payment protocol
 * @param {number} [opts.maxAgeDays] - Max age in days for handler declaration
 * @param {boolean} [opts.withReputation=false] - Enrich with reputation data
 * @param {number} [opts.minTrustWeight] - Minimum trust weight to include
 * @returns {Promise<DiscoveredService[]>}
 */
export async function discoverServices(pool, relays, opts = {}) {
  const {
    serviceType,
    protocol,
    maxAgeDays,
    withReputation = false,
    minTrustWeight,
  } = opts;

  // Query for handler declarations with agent-reputation label
  const filter = {
    kinds: [HANDLER_KIND],
    '#L': ['agent-reputation'],
  };

  const events = await pool.querySync(relays, filter);
  const now = Math.floor(Date.now() / 1000);

  // Parse and filter handlers
  let services = events.map(event => {
    const tags = event.tags || [];
    const getTag = (name) => {
      const tag = tags.find(t => t[0] === name);
      return tag ? tag.slice(1) : null;
    };

    const priceTag = getTag('price');
    const ageHours = (now - event.created_at) / 3600;

    return {
      pubkey: event.pubkey,
      serviceId: getTag('d')?.[0] || 'unknown',
      description: getTag('description')?.[0] || '',
      price: priceTag ? {
        amount: priceTag[0],
        unit: priceTag[1] || 'sats',
        per: priceTag[2] || 'per-request',
      } : null,
      protocol: getTag('protocol')?.[0] || null,
      endpoint: getTag('endpoint')?.[0] || null,
      nodePubkey: getTag('node_pubkey')?.[0] || null,
      handlerKinds: tags.filter(t => t[0] === 'k').map(t => t[1]),
      createdAt: event.created_at,
      ageHours: Math.round(ageHours * 10) / 10,
      reputation: null,
      raw: event,
    };
  });

  // Deduplicate: for same pubkey+serviceId, keep newest
  const seen = new Map();
  for (const svc of services) {
    const key = `${svc.pubkey}:${svc.serviceId}`;
    const existing = seen.get(key);
    if (!existing || svc.createdAt > existing.createdAt) {
      seen.set(key, svc);
    }
  }
  services = Array.from(seen.values());

  // Apply filters
  if (serviceType) {
    const lower = serviceType.toLowerCase();
    services = services.filter(s =>
      s.serviceId.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower)
    );
  }

  if (protocol) {
    const lower = protocol.toLowerCase();
    services = services.filter(s =>
      s.protocol && s.protocol.toLowerCase() === lower
    );
  }

  if (maxAgeDays) {
    const maxAgeHours = maxAgeDays * 24;
    services = services.filter(s => s.ageHours <= maxAgeHours);
  }

  // Enrich with reputation data
  if (withReputation) {
    services = await enrichWithReputation(pool, relays, services);

    if (minTrustWeight !== undefined) {
      services = services.filter(s =>
        s.reputation && s.reputation.totalWeight >= minTrustWeight
      );
    }
  }

  // Sort by recency (newest first)
  services.sort((a, b) => b.createdAt - a.createdAt);

  return services;
}

/**
 * Enrich discovered services with reputation data from attestations.
 * 
 * For each service's pubkey, queries attestations and computes
 * a lightweight reputation summary.
 */
async function enrichWithReputation(pool, relays, services) {
  // Collect unique pubkeys to query
  const pubkeys = [...new Set(services.map(s => s.pubkey))];

  // Batch query attestations for all pubkeys
  const reputationMap = new Map();

  for (const pubkey of pubkeys) {
    try {
      const filter = {
        kinds: [ATTESTATION_KIND, ...LEGACY_KINDS],
        '#p': [pubkey],
      };
      const events = await pool.querySync(relays, filter);

      if (events.length === 0) {
        reputationMap.set(pubkey, null);
        continue;
      }

      // Compute lightweight reputation summary
      const now = Math.floor(Date.now() / 1000);
      let totalWeight = 0;
      let attestationCount = events.length;
      let uniqueAttesters = new Set();
      let hasExternal = false;
      const dimensions = {};

      for (const event of events) {
        const tags = event.tags || [];
        const typeTag = tags.find(t => t[0] === 'attestation_type');
        const type = typeTag ? typeTag[1] : 'self';
        const halfLifeTag = tags.find(t => t[0] === 'half_life_hours');
        const halfLife = halfLifeTag ? parseFloat(halfLifeTag[1]) : 720;

        const ageHours = (now - event.created_at) / 3600;
        const decayWeight = Math.min(Math.pow(2, -ageHours / halfLife), 1.0);
        const typeWeight = type === 'bilateral' ? 1.0 : type === 'observer' ? 0.7 : 0.3;
        const effectiveWeight = decayWeight * typeWeight;

        totalWeight += effectiveWeight;
        uniqueAttesters.add(event.pubkey);
        if (event.pubkey !== pubkey) hasExternal = true;

        // Extract dimensions
        for (const tag of tags) {
          if (tag[0] === 'dimension') {
            const [, name, value, sampleSize] = tag;
            if (!dimensions[name]) {
              dimensions[name] = { weightedSum: 0, weightSum: 0 };
            }
            dimensions[name].weightedSum += parseFloat(value) * effectiveWeight;
            dimensions[name].weightSum += effectiveWeight;
          }
        }
      }

      // Compute weighted averages per dimension
      const aggregated = {};
      for (const [name, data] of Object.entries(dimensions)) {
        if (data.weightSum > 0) {
          aggregated[name] = Math.round((data.weightedSum / data.weightSum) * 10000) / 10000;
        }
      }

      const trustLevel = totalWeight >= 1.0 ? 'verified'
        : totalWeight >= 0.5 ? 'moderate'
        : 'low';

      reputationMap.set(pubkey, {
        totalWeight: Math.round(totalWeight * 1000) / 1000,
        trustLevel,
        attestationCount,
        uniqueAttesters: uniqueAttesters.size,
        hasExternalAttestations: hasExternal,
        dimensions: aggregated,
      });
    } catch (err) {
      reputationMap.set(pubkey, null);
    }
  }

  // Attach reputation to services
  return services.map(svc => ({
    ...svc,
    reputation: reputationMap.get(svc.pubkey) || null,
  }));
}

/**
 * Format discovered services for display.
 * 
 * @param {DiscoveredService[]} services
 * @returns {string} Formatted text output
 */
export function formatDiscoveryResults(services) {
  if (services.length === 0) {
    return 'No agent services found matching your criteria.';
  }

  const lines = [`Found ${services.length} agent service${services.length > 1 ? 's' : ''}:\n`];

  for (const svc of services) {
    lines.push(`┌─ ${svc.serviceId}`);
    lines.push(`│  ${svc.description || '(no description)'}`);
    lines.push(`│  pubkey: ${svc.pubkey.slice(0, 16)}...`);

    if (svc.price) {
      lines.push(`│  price: ${svc.price.amount} ${svc.price.unit} ${svc.price.per}`);
    }
    if (svc.protocol) {
      lines.push(`│  protocol: ${svc.protocol}`);
    }
    if (svc.endpoint) {
      lines.push(`│  endpoint: ${svc.endpoint}`);
    }
    if (svc.nodePubkey) {
      lines.push(`│  node: ${svc.nodePubkey.slice(0, 16)}...`);
    }

    const ageDays = Math.round(svc.ageHours / 24 * 10) / 10;
    lines.push(`│  declared: ${ageDays < 1 ? Math.round(svc.ageHours) + 'h ago' : ageDays + 'd ago'}`);

    if (svc.reputation) {
      const r = svc.reputation;
      const trustIcon = r.trustLevel === 'verified' ? '✅' :
        r.trustLevel === 'moderate' ? '⚠️' : '🔴';
      lines.push(`│  reputation: ${trustIcon} ${r.trustLevel} (weight: ${r.totalWeight}, ${r.attestationCount} attestation${r.attestationCount > 1 ? 's' : ''}, ${r.uniqueAttesters} attester${r.uniqueAttesters > 1 ? 's' : ''})`);
      if (r.hasExternalAttestations) {
        lines.push(`│  ✓ has external attestations`);
      } else {
        lines.push(`│  ⚠ self-reported only`);
      }

      // Show key dimensions
      const dimEntries = Object.entries(r.dimensions);
      if (dimEntries.length > 0) {
        const dimParts = dimEntries
          .slice(0, 4)
          .map(([name, value]) => `${name}=${value}`);
        lines.push(`│  metrics: ${dimParts.join(', ')}`);
      }
    } else {
      lines.push(`│  reputation: (none found)`);
    }

    lines.push('└───');
    lines.push('');
  }

  return lines.join('\n');
}
