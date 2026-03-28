/**
 * Reputation HTTP API Server
 * 
 * Lightweight HTTP server exposing the NIP Agent Reputation query, discovery,
 * and validation endpoints. Zero additional dependencies — uses Node.js built-in http.
 * 
 * Any agent can query reputation over HTTP without installing the npm package.
 * 
 * Endpoints:
 *   GET  /reputation/:pubkey           — Query aggregated reputation for a pubkey
 *   GET  /discover                     — Discover available agent services
 *   POST /validate                     — Validate an attestation event
 *   GET  /health                       — Server health check
 *   GET  /                             — API documentation
 * 
 * Usage:
 *   node src/server.js [--port 3386] [--relays relay1,relay2]
 *   
 * Environment:
 *   PORT=3386                          — Server port (default: 3385)
 *   RELAYS=wss://relay1,wss://relay2   — Comma-separated relay URLs
 * 
 * @module server
 */

import http from 'node:http';
import { URL } from 'node:url';
import { queryAttestations, parseAttestation, aggregateAttestations, DEFAULT_RELAYS } from './attestation.js';
import { discoverServices } from './discover.js';
import { validateAttestation, validateHandler, validateBatch } from './validate.js';
import { WebOfTrust } from './web-of-trust.js';
import { ATTESTATION_KIND, HANDLER_KIND } from './constants.js';

// --- Configuration ---

const DEFAULT_PORT = 3386; // 3-386 → kind 30386
const MAX_BODY_SIZE = 64 * 1024; // 64KB max POST body
const QUERY_TIMEOUT_MS = parseInt(process.env.QUERY_TIMEOUT_MS, 10) || 15000;
const CACHE_TTL_MS = 60000; // 1 minute cache for reputation queries

// --- Simple in-memory cache ---

class QueryCache {
  constructor(ttlMs = CACHE_TTL_MS) {
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key, data) {
    // Evict old entries if cache gets too big
    if (this.cache.size > 200) {
      const cutoff = Date.now() - this.ttlMs;
      for (const [k, v] of this.cache) {
        if (v.ts < cutoff) this.cache.delete(k);
      }
    }
    this.cache.set(key, { data, ts: Date.now() });
  }
}

const reputationCache = new QueryCache();
const discoveryCache = new QueryCache(120000); // 2 min for discovery

// --- Request helpers ---

function parseQuery(url) {
  const parsed = new URL(url, 'http://localhost');
  const params = {};
  for (const [k, v] of parsed.searchParams) {
    params[k] = v;
  }
  return { pathname: parsed.pathname, params };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function respond(res, status, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'X-Powered-By': 'nip-agent-reputation',
  });
  res.end(body);
}

// --- Route: GET /reputation/:pubkey ---

async function handleReputation(pubkey, params, relays) {
  // Validate pubkey format
  if (!/^[0-9a-f]{64}$/.test(pubkey) && !/^[0-9a-f]{66}$/.test(pubkey) && !/^npub1/.test(pubkey)) {
    return { status: 400, data: { error: 'Invalid pubkey format. Accepts: 64-hex Nostr pubkey, 66-hex LND node pubkey, or npub' } };
  }

  // Check cache
  const cacheKey = `rep:${pubkey}`;
  const cached = reputationCache.get(cacheKey);
  if (cached && !params.nocache) {
    return { status: 200, data: { ...cached, cached: true } };
  }

  try {
    // Decode npub if needed
    let queryPubkey = pubkey;
    if (pubkey.startsWith('npub1')) {
      try {
        const { nip19 } = await import('nostr-tools/nip19');
        const decoded = nip19.decode(pubkey);
        queryPubkey = decoded.data;
      } catch (e) {
        return { status: 400, data: { error: `Invalid npub: ${e.message}` } };
      }
    }

    const attestations = await queryAttestations(queryPubkey, relays);

    if (!attestations || attestations.length === 0) {
      const result = {
        pubkey: queryPubkey,
        attestationCount: 0,
        dimensions: {},
        trustLevel: 'none',
        message: 'No attestations found for this pubkey',
      };
      reputationCache.set(cacheKey, result);
      return { status: 200, data: result };
    }

    // queryAttestations() already returns parsed objects
    const parsed = attestations;
    
    // Aggregate
    const aggregated = aggregateAttestations(parsed);

    // Web-of-trust analysis
    const wot = new WebOfTrust();
    let wotScore;
    try {
      wotScore = await wot.score(queryPubkey);
    } catch (e) {
      wotScore = null; // WoT scoring failed, continue without it
    }

    // aggregateAttestations returns flat: { dimName: { weightedAvg, numAttesters, totalWeight, belowMinSample }, ... }
    // Compute overall totalWeight as max across dimensions
    const dimValues = Object.values(aggregated);
    const totalWeight = dimValues.length > 0
      ? Math.max(...dimValues.map(d => d.totalWeight || 0))
      : 0;

    // Determine trust level
    let trustLevel = 'none';
    if (totalWeight >= 1.0) trustLevel = 'verified';
    else if (totalWeight >= 0.5) trustLevel = 'moderate';
    else if (totalWeight > 0) trustLevel = 'low';

    // Check if all self-attested
    const allSelf = parsed.every(p => p.attestationType === 'self');
    const result = {
      pubkey: queryPubkey,
      attestationCount: attestations.length,
      dimensions: aggregated,
      totalWeight,
      trustLevel,
      selfOnly: allSelf,
      wotScore: wotScore || null,
      attesters: [...new Set(parsed.map(p => p.attester).filter(Boolean))],
      latestAttestation: parsed.reduce((max, e) => 
        (e.createdAt || 0) > max ? (e.createdAt || 0) : max, 0),
      queriedAt: Math.floor(Date.now() / 1000),
    };

    reputationCache.set(cacheKey, result);
    return { status: 200, data: result };

  } catch (err) {
    return { status: 500, data: { error: `Query failed: ${err.message}` } };
  }
}

// --- Route: GET /reputation/badge/:pubkey ---

function renderBadgeSvg(trustLevel, attestationCount, totalWeight) {
  const colors = {
    verified: '#22c55e',   // green
    moderate: '#eab308',   // yellow
    low: '#f97316',        // orange
    none: '#6b7280',       // gray
  };
  const labels = {
    verified: 'verified',
    moderate: 'moderate',
    low: 'low',
    none: 'unrated',
  };

  const color = colors[trustLevel] || colors.none;
  const label = labels[trustLevel] || 'unrated';
  const leftText = 'NIP-30386';
  const rightText = `${label} · ${attestationCount} attestation${attestationCount !== 1 ? 's' : ''}`;

  // Compute widths (approximate character widths for Verdana 11px)
  const leftW = leftText.length * 7.2 + 12;
  const rightW = rightText.length * 6.5 + 12;
  const totalW = leftW + rightW;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${leftText}: ${rightText}">
  <title>${leftText}: ${rightText}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#555"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="11">
    <text aria-hidden="true" x="${leftW / 2}" y="15" fill="#010101" fill-opacity=".3">${leftText}</text>
    <text x="${leftW / 2}" y="14">${leftText}</text>
    <text aria-hidden="true" x="${leftW + rightW / 2}" y="15" fill="#010101" fill-opacity=".3">${rightText}</text>
    <text x="${leftW + rightW / 2}" y="14">${rightText}</text>
  </g>
</svg>`;
}

async function handleBadge(pubkey, params, relays) {
  // Reuse reputation logic
  const result = await handleReputation(pubkey, params, relays);
  if (result.status !== 200) {
    // Return a gray "error" badge
    return {
      status: 200,
      contentType: 'image/svg+xml',
      data: renderBadgeSvg('none', 0, 0),
    };
  }

  const { trustLevel, attestationCount, totalWeight } = result.data;
  return {
    status: 200,
    contentType: 'image/svg+xml',
    data: renderBadgeSvg(trustLevel || 'none', attestationCount || 0, totalWeight || 0),
  };
}

// --- Route: GET /discover ---

async function handleDiscover(params, relays) {
  const cacheKey = `disc:${params.type || ''}:${params.protocol || ''}`;
  const cached = discoveryCache.get(cacheKey);
  if (cached && !params.nocache) {
    return { status: 200, data: { ...cached, cached: true } };
  }

  try {
    const options = {};
    if (params.type) options.serviceType = params.type;
    if (params.protocol) options.protocol = params.protocol;
    if (params.max_age) options.maxAgeHours = parseInt(params.max_age, 10);
    if (params.reputation === 'true') options.withReputation = true;
    if (params.min_trust) options.minTrustWeight = parseFloat(params.min_trust);

    const services = await discoverServices(relays, options);

    const result = {
      serviceCount: services.length,
      services: services.map(s => ({
        pubkey: s.pubkey,
        serviceId: s.serviceId,
        description: s.description,
        price: s.price,
        protocol: s.protocol,
        endpoint: s.endpoint,
        createdAt: s.createdAt,
        reputation: s.reputation || null,
      })),
      filters: {
        type: params.type || null,
        protocol: params.protocol || null,
        maxAgeHours: params.max_age ? parseInt(params.max_age, 10) : null,
      },
      queriedAt: Math.floor(Date.now() / 1000),
    };

    discoveryCache.set(cacheKey, result);
    return { status: 200, data: result };

  } catch (err) {
    return { status: 500, data: { error: `Discovery failed: ${err.message}` } };
  }
}

// --- Route: POST /validate ---

async function handleValidate(body) {
  try {
    const parsed = JSON.parse(body);

    // Handle single event or batch
    if (Array.isArray(parsed)) {
      const batch = validateBatch(parsed);
      return {
        status: 200,
        data: {
          batchSize: parsed.length,
          summary: batch.summary,
          results: batch.results.map(r => ({
            valid: r.validation.valid,
            kind: r.event?.kind,
            errors: r.validation.errors,
            warnings: r.validation.warnings,
            info: r.validation.info,
          })),
        },
      };
    }

    // Single event — detect type
    const kind = parsed.kind;
    let result;
    if (kind === HANDLER_KIND) {
      result = validateHandler(parsed);
    } else {
      result = validateAttestation(parsed);
    }

    return {
      status: 200,
      data: {
        valid: result.valid,
        kind,
        errors: result.errors,
        warnings: result.warnings,
        info: result.info,
      },
    };

  } catch (err) {
    return { status: 400, data: { error: `Invalid JSON: ${err.message}` } };
  }
}

// --- Route: GET / ---

function handleDocs() {
  return {
    status: 200,
    data: {
      name: 'NIP Agent Reputation API',
      version: '0.9.0',
      spec: 'https://github.com/LeviEdwards/nip-agent-reputation/blob/main/NIP-XX.md',
      kind: ATTESTATION_KIND,
      endpoints: {
        'GET /reputation/:pubkey': {
          description: 'Query aggregated reputation for a Nostr/LND pubkey',
          params: {
            pubkey: '64-hex Nostr pubkey, 66-hex LND node pubkey, or npub',
            nocache: 'Skip cache (optional, any value)',
          },
          response: {
            attestationCount: 'Number of attestations found',
            dimensions: 'Aggregated dimension values with decay weighting',
            trustLevel: 'none | low | moderate | verified',
            selfOnly: 'true if all attestations are self-reported',
            wotScore: 'Web-of-trust analysis',
            attesters: 'List of unique attester pubkeys',
          },
        },
        'GET /discover': {
          description: 'Discover agent services registered on Nostr relays',
          params: {
            type: 'Filter by service type (substring match)',
            protocol: 'Filter by protocol (e.g., L402)',
            max_age: 'Maximum age in hours',
            reputation: 'Include reputation data (true/false)',
            min_trust: 'Minimum trust weight (0.0-1.0)',
            nocache: 'Skip cache (optional)',
          },
        },
        'POST /validate': {
          description: 'Validate attestation or handler events against the spec',
          body: 'Single event JSON or array of events',
          response: {
            valid: 'Whether the event conforms to the spec',
            errors: 'Spec violations (event is non-conformant)',
            warnings: 'Recommendations (event works but could be better)',
            info: 'Informational notes',
          },
        },
        'GET /health': {
          description: 'Server health check',
        },
      },
      examples: {
        queryReputation: 'GET /reputation/1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead',
        queryByNpub: 'GET /reputation/npub1rwm6u3czqv63xzuk2n3uzd3nlyjyd3r306zelq45de3kxyvvd6ksfdw2wu',
        discoverServices: 'GET /discover?type=lightning&reputation=true',
        validateEvent: 'POST /validate (with event JSON body)',
      },
    },
  };
}

// --- Main server ---

export function createServer(options = {}) {
  const port = options.port !== undefined ? options.port : (parseInt(process.env.PORT, 10) || DEFAULT_PORT);
  const relayUrls = options.relays || (process.env.RELAYS ? process.env.RELAYS.split(',') : DEFAULT_RELAYS);

  const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      respond(res, 204, '');
      return;
    }

    const { pathname, params } = parseQuery(req.url);

    try {
      // Route: GET /
      if (pathname === '/' && req.method === 'GET') {
        const result = handleDocs();
        respond(res, result.status, result.data);
        return;
      }

      // Route: GET /health
      if (pathname === '/health' && req.method === 'GET') {
        respond(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          relays: relayUrls,
          cacheSize: reputationCache.cache.size + discoveryCache.cache.size,
          timestamp: Math.floor(Date.now() / 1000),
        });
        return;
      }

      // Route: GET /reputation/badge/:pubkey
      const badgeMatch = pathname.match(/^\/reputation\/badge\/([a-f0-9]{64}|[a-f0-9]{66}|npub1[a-z0-9]+)$/);
      if (badgeMatch && req.method === 'GET') {
        const result = await handleBadge(badgeMatch[1], params, relayUrls);
        if (result.contentType === 'image/svg+xml') {
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=300',
            'Access-Control-Allow-Origin': '*',
          });
          res.end(result.data);
        } else {
          respond(res, result.status, result.data);
        }
        return;
      }

      // Route: GET /reputation/:pubkey
      const repMatch = pathname.match(/^\/reputation\/([a-f0-9]{64}|[a-f0-9]{66}|npub1[a-z0-9]+)$/);
      if (repMatch && req.method === 'GET') {
        const result = await handleReputation(repMatch[1], params, relayUrls);
        respond(res, result.status, result.data);
        return;
      }

      // Route: GET /discover
      if (pathname === '/discover' && req.method === 'GET') {
        const result = await handleDiscover(params, relayUrls);
        respond(res, result.status, result.data);
        return;
      }

      // Route: POST /validate
      if (pathname === '/validate' && req.method === 'POST') {
        const body = await readBody(req);
        const result = await handleValidate(body);
        respond(res, result.status, result.data);
        return;
      }

      // 404
      respond(res, 404, { error: 'Not found', availableEndpoints: ['/', '/health', '/reputation/:pubkey', '/reputation/badge/:pubkey', '/discover', '/validate'] });

    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error:`, err);
      respond(res, 500, { error: 'Internal server error' });
    }
  });

  return { server, port, relayUrls };
}

// --- CLI entrypoint ---

if (process.argv[1]?.match(/(?:^|[/\\])server\.js$/)) {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      options.port = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--relays' && args[i + 1]) {
      options.relays = args[i + 1].split(',');
      i++;
    }
  }

  const { server, port, relayUrls } = createServer(options);

  server.listen(port, () => {
    console.log(`🔍 NIP Agent Reputation API`);
    console.log(`   Port:   ${port}`);
    console.log(`   Relays: ${relayUrls.join(', ')}`);
    console.log(`   Docs:   http://localhost:${port}/`);
    console.log(`   Query:  http://localhost:${port}/reputation/<pubkey>`);
    console.log(`   Find:   http://localhost:${port}/discover`);
    console.log();
  });
}
