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

// --- Route: GET /directory ---

function renderDirectoryHtml(services, attestationMap) {
  const trustColor = (level) => ({
    verified: '#22c55e', moderate: '#eab308', low: '#f97316', none: '#6b7280'
  }[level] || '#6b7280');

  const serviceCards = services.map(s => {
    const rep = s.reputation;
    const trust = rep?.trustLevel || 'none';
    const color = trustColor(trust);
    const attCount = rep?.attestationCount || 0;
    const dims = rep?.dimensions || {};
    const dimRows = Object.entries(dims).map(([name, d]) => {
      const val = typeof d.weightedAvg === 'number' ? d.weightedAvg.toFixed(4) : d.weightedAvg;
      return `<div style="display:flex;justify-content:space-between;padding:2px 0;font-size:13px"><span style="color:#9ca3af">${name}</span><span style="color:#e5e7eb">${val}</span></div>`;
    }).join('');

    return `
    <div style="background:#1f2937;border-radius:12px;padding:20px;border:1px solid #374151">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0;font-size:16px;color:#f9fafb">${s.serviceId || 'unnamed'}</h3>
        <span style="background:${color}22;color:${color};padding:2px 10px;border-radius:12px;font-size:12px;font-weight:600">${trust}</span>
      </div>
      ${s.description ? `<p style="color:#9ca3af;font-size:13px;margin:0 0 8px">${s.description}</p>` : ''}
      <div style="font-size:12px;color:#6b7280;margin-bottom:8px">
        ${s.protocol ? `<span style="background:#374151;padding:2px 6px;border-radius:4px;margin-right:4px">${s.protocol}</span>` : ''}
        ${s.price ? `<span style="background:#374151;padding:2px 6px;border-radius:4px">${s.price.amount} ${s.price.unit}/${s.price.per}</span>` : ''}
      </div>
      ${s.endpoint ? `<div style="font-size:12px;color:#60a5fa;word-break:break-all;margin-bottom:8px"><a href="${s.endpoint}" style="color:#60a5fa">${s.endpoint}</a></div>` : ''}
      <div style="font-size:11px;color:#6b7280;margin-bottom:8px">pubkey: ${s.pubkey?.slice(0,16)}...</div>
      ${attCount > 0 ? `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #374151"><div style="font-size:12px;color:#9ca3af;margin-bottom:4px">${attCount} attestation${attCount !== 1 ? 's' : ''}</div>${dimRows}</div>` : '<div style="font-size:12px;color:#6b7280;margin-top:8px">No attestations yet</div>'}
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NIP-30386 Agent Directory</title>
<style>*{box-sizing:border-box}body{margin:0;background:#111827;color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:24px}
a{color:#60a5fa;text-decoration:none}a:hover{text-decoration:underline}</style>
</head>
<body>
<div style="max-width:900px;margin:0 auto">
  <div style="text-align:center;margin-bottom:32px">
    <h1 style="font-size:28px;margin:0 0 8px">⚡ NIP-30386 Agent Directory</h1>
    <p style="color:#9ca3af;margin:0">Autonomous agents with verifiable reputation on Lightning + Nostr</p>
    <p style="color:#6b7280;font-size:13px;margin-top:8px">${services.length} service${services.length !== 1 ? 's' : ''} discovered · Updated ${new Date().toISOString().slice(0,16)}Z</p>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px">
    ${serviceCards || '<div style="color:#6b7280;text-align:center;grid-column:1/-1;padding:40px">No services discovered yet</div>'}
  </div>
  <div style="text-align:center;margin-top:32px;padding-top:16px;border-top:1px solid #1f2937;color:#6b7280;font-size:12px">
    <p>Data from kind 30386 + 31990 events on Nostr relays · <a href="/discover?reputation=true">JSON API</a> · <a href="https://github.com/LeviEdwards/nip-agent-reputation">Source</a></p>
  </div>
</div>
</body>
</html>`;
}

async function handleDirectory(params, relays) {
  try {
    const services = await discoverServices(relays, {
      withReputation: true,
      maxAgeHours: params.max_age ? parseInt(params.max_age, 10) : 720,
    });

    return {
      status: 200,
      contentType: 'text/html',
      data: renderDirectoryHtml(services),
    };
  } catch (err) {
    return {
      status: 500,
      contentType: 'text/html',
      data: `<html><body style="background:#111827;color:#f9fafb;font-family:sans-serif;padding:40px;text-align:center"><h1>Directory Error</h1><p>${err.message}</p></body></html>`,
    };
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

// --- Route: GET /playground ---

function handlePlayground() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NIP-30386 Playground — Agent Reputation Protocol</title>
<style>
  :root { --bg: #0d1117; --fg: #e6edf3; --accent: #f7931a; --green: #3fb950; --red: #f85149; --dim: #8b949e; --card: #161b22; --border: #30363d; --input: #0d1117; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem; max-width: 960px; margin: 0 auto; }
  h1 { color: var(--accent); font-size: 1.5rem; margin-bottom: 0.25rem; }
  .subtitle { color: var(--dim); font-size: 0.9rem; margin-bottom: 2rem; }
  .tabs { display: flex; gap: 0; margin-bottom: 0; border-bottom: 1px solid var(--border); }
  .tab { padding: 0.75rem 1.5rem; cursor: pointer; color: var(--dim); border: 1px solid transparent; border-bottom: none; background: none; font-size: 0.9rem; font-family: inherit; border-radius: 6px 6px 0 0; }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); border-color: var(--border); background: var(--card); border-bottom: 1px solid var(--card); margin-bottom: -1px; }
  .panel { display: none; background: var(--card); border: 1px solid var(--border); border-top: none; border-radius: 0 0 6px 6px; padding: 1.5rem; }
  .panel.active { display: block; }
  textarea { width: 100%; min-height: 300px; background: var(--input); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85rem; resize: vertical; }
  textarea:focus { outline: none; border-color: var(--accent); }
  button { background: var(--accent); color: #000; border: none; padding: 0.6rem 1.5rem; border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 0.9rem; margin-top: 0.75rem; font-family: inherit; }
  button:hover { opacity: 0.9; }
  button.secondary { background: var(--border); color: var(--fg); }
  .result { margin-top: 1rem; padding: 1rem; border-radius: 4px; font-family: monospace; font-size: 0.85rem; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
  .result.ok { background: #0d1f0d; border: 1px solid var(--green); }
  .result.err { background: #1f0d0d; border: 1px solid var(--red); }
  .result.neutral { background: var(--input); border: 1px solid var(--border); }
  input[type=text] { width: 100%; background: var(--input); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; padding: 0.6rem; font-family: monospace; font-size: 0.9rem; margin-bottom: 0.75rem; }
  input[type=text]:focus { outline: none; border-color: var(--accent); }
  label { color: var(--dim); font-size: 0.85rem; display: block; margin-bottom: 0.25rem; }
  .row { display: flex; gap: 1rem; align-items: flex-end; }
  .row > div { flex: 1; }
  .badge-preview { margin-top: 1rem; text-align: center; }
  .badge-preview img { max-width: 200px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
  .stat { background: var(--input); border: 1px solid var(--border); border-radius: 4px; padding: 0.75rem; text-align: center; }
  .stat .num { font-size: 1.5rem; font-weight: bold; color: var(--accent); }
  .stat .lbl { font-size: 0.75rem; color: var(--dim); }
  .template-btn { background: var(--border); color: var(--fg); padding: 0.4rem 0.8rem; border: none; border-radius: 3px; cursor: pointer; font-size: 0.8rem; margin: 0.25rem; font-family: inherit; }
  .template-btn:hover { background: var(--dim); }
  a { color: var(--accent); }
  .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--dim); font-size: 0.8rem; text-align: center; }
</style>
</head>
<body>
<h1>⚡ NIP-30386 Playground</h1>
<p class="subtitle">Interactive validator &amp; explorer for the Agent Reputation protocol on Nostr + Lightning</p>

<div class="tabs">
  <button class="tab active" onclick="showTab('validate')">Validate</button>
  <button class="tab" onclick="showTab('query')">Query</button>
  <button class="tab" onclick="showTab('discover')">Discover</button>
  <button class="tab" onclick="showTab('templates')">Templates</button>
</div>

<!-- VALIDATE TAB -->
<div id="tab-validate" class="panel active">
  <p style="color:var(--dim);margin-bottom:0.75rem;">Paste a NIP-30386 attestation event (JSON) and validate it against the spec:</p>
  <div style="margin-bottom:0.5rem;">
    <span style="color:var(--dim);font-size:0.8rem;">Load template:</span>
    <button class="template-btn" onclick="loadTemplate('self')">Self</button>
    <button class="template-btn" onclick="loadTemplate('observer')">Observer</button>
    <button class="template-btn" onclick="loadTemplate('bilateral')">Bilateral</button>
    <button class="template-btn" onclick="loadTemplate('handler')">Handler (31990)</button>
  </div>
  <textarea id="validate-input" placeholder='{"kind":30386,"pubkey":"...","tags":[...],...}'></textarea>
  <button onclick="runValidate()">Validate Event</button>
  <div id="validate-result"></div>
</div>

<!-- QUERY TAB -->
<div id="tab-query" class="panel">
  <label>Agent pubkey (64-hex, 66-hex LND, or npub):</label>
  <input type="text" id="query-pubkey" placeholder="03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f">
  <div class="row">
    <div>
      <label>Amount (sats) for payment gate:</label>
      <input type="text" id="query-amount" placeholder="5000" value="5000">
    </div>
    <div style="flex:0 0 auto;">
      <button onclick="runQuery()">Query Reputation</button>
    </div>
  </div>
  <div id="query-result"></div>
  <div class="badge-preview" id="badge-preview"></div>
</div>

<!-- DISCOVER TAB -->
<div id="tab-discover" class="panel">
  <label>Service type filter (optional):</label>
  <input type="text" id="discover-type" placeholder="lightning-node">
  <button onclick="runDiscover()">Discover Agents</button>
  <div id="discover-result"></div>
</div>

<!-- TEMPLATES TAB -->
<div id="tab-templates" class="panel">
  <h3 style="color:var(--accent);margin-bottom:1rem;">Event Templates</h3>
  <p style="color:var(--dim);margin-bottom:1rem;">Copy these templates, fill in your values, sign with your Nostr key, and publish. See <a href="https://github.com/LeviEdwards/nip-agent-reputation/blob/main/IMPLEMENTING.md">IMPLEMENTING.md</a> for details.</p>

  <h4 style="margin:1rem 0 0.5rem;">Self-Attestation (Kind 30386)</h4>
  <pre class="result neutral" id="tpl-self"></pre>

  <h4 style="margin:1rem 0 0.5rem;">Observer Attestation (Kind 30386)</h4>
  <pre class="result neutral" id="tpl-observer"></pre>

  <h4 style="margin:1rem 0 0.5rem;">Bilateral Attestation (Kind 30386)</h4>
  <pre class="result neutral" id="tpl-bilateral"></pre>

  <h4 style="margin:1rem 0 0.5rem;">Service Handler (Kind 31990)</h4>
  <pre class="result neutral" id="tpl-handler"></pre>
</div>

<div class="footer">
  NIP-30386 Agent Reputation Protocol &mdash;
  <a href="https://github.com/LeviEdwards/nip-agent-reputation">GitHub</a> &middot;
  <a href="/">API Docs</a> &middot;
  <a href="/directory">Directory</a> &middot;
  Kind 30386 on Nostr
</div>

<script>
const API = location.origin;

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', t.textContent.toLowerCase().includes(name.slice(0,4))));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-'+name).classList.add('active');
}

// --- Templates ---
const TEMPLATES = {
  self: {
    kind: 30386,
    pubkey: "<YOUR-64-HEX-NOSTR-PUBKEY>",
    created_at: Math.floor(Date.now()/1000),
    tags: [
      ["d", "<YOUR-LN-PUBKEY>:lightning-node"],
      ["L", "agent-reputation"],
      ["l", "attestation", "agent-reputation"],
      ["attestation_type", "self"],
      ["service_type", "lightning-node"],
      ["node_pubkey", "<YOUR-66-HEX-LN-PUBKEY>"],
      ["p", "<YOUR-64-HEX-NOSTR-PUBKEY>"],
      ["half_life_hours", "720"],
      ["sample_window_hours", "24"],
      ["dimension", "uptime_percent", "99.5", "30"],
      ["dimension", "payment_success_rate", "0.98", "100"]
    ],
    content: JSON.stringify({type:"self",summary:"Self-reported Lightning node metrics"})
  },
  observer: {
    kind: 30386,
    pubkey: "<OBSERVER-64-HEX-NOSTR-PUBKEY>",
    created_at: Math.floor(Date.now()/1000),
    tags: [
      ["d", "<SUBJECT-LN-PUBKEY>:lightning-node"],
      ["L", "agent-reputation"],
      ["l", "attestation", "agent-reputation"],
      ["attestation_type", "observer"],
      ["service_type", "lightning-node"],
      ["node_pubkey", "<SUBJECT-66-HEX-LN-PUBKEY>"],
      ["p", "<SUBJECT-64-HEX-NOSTR-PUBKEY>"],
      ["half_life_hours", "720"],
      ["sample_window_hours", "24"],
      ["dimension", "uptime_percent", "99.0", "50"],
      ["dimension", "response_time_ms", "150", "50"]
    ],
    content: JSON.stringify({type:"observer",summary:"Independent monitoring results",probeCount:50,windowHours:168})
  },
  bilateral: {
    kind: 30386,
    pubkey: "<ATTESTER-64-HEX-NOSTR-PUBKEY>",
    created_at: Math.floor(Date.now()/1000),
    tags: [
      ["d", "<COUNTERPARTY-LN-PUBKEY>:api-provider"],
      ["L", "agent-reputation"],
      ["l", "attestation", "agent-reputation"],
      ["attestation_type", "bilateral"],
      ["service_type", "api-provider"],
      ["node_pubkey", "<COUNTERPARTY-66-HEX-LN-PUBKEY>"],
      ["p", "<COUNTERPARTY-64-HEX-NOSTR-PUBKEY>"],
      ["half_life_hours", "720"],
      ["sample_window_hours", "168"],
      ["dimension", "settlement_rate", "0.95", "20"],
      ["dimension", "response_time_ms", "250", "20"],
      ["dimension", "dispute_rate", "0.05", "20"]
    ],
    content: JSON.stringify({type:"bilateral",summary:"Post-transaction attestation based on 20 Lightning payments"})
  },
  handler: {
    kind: 31990,
    pubkey: "<YOUR-64-HEX-NOSTR-PUBKEY>",
    created_at: Math.floor(Date.now()/1000),
    tags: [
      ["d", "my-agent-service"],
      ["k", "5600"],
      ["L", "agent-reputation"],
      ["l", "handler", "agent-reputation"],
      ["description", "My Lightning-powered API service"],
      ["price", "100", "sats", "per-request"],
      ["protocol", "L402"],
      ["endpoint", "https://my-api.example.com"],
      ["node_pubkey", "<YOUR-66-HEX-LN-PUBKEY>"]
    ],
    content: JSON.stringify({name:"My Agent Service",description:"Discoverable via NIP-30386"})
  }
};

function fmt(obj) { return JSON.stringify(obj, null, 2); }

// Populate templates
document.getElementById('tpl-self').textContent = fmt(TEMPLATES.self);
document.getElementById('tpl-observer').textContent = fmt(TEMPLATES.observer);
document.getElementById('tpl-bilateral').textContent = fmt(TEMPLATES.bilateral);
document.getElementById('tpl-handler').textContent = fmt(TEMPLATES.handler);

function loadTemplate(type) {
  document.getElementById('validate-input').value = fmt(TEMPLATES[type]);
}

// --- Validate ---
async function runValidate() {
  const el = document.getElementById('validate-result');
  const input = document.getElementById('validate-input').value.trim();
  if (!input) { el.className='result err'; el.textContent='Paste a JSON event first.'; return; }
  try {
    const body = JSON.parse(input);
    const resp = await fetch(API + '/validate', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await resp.json();
    if (data.results) {
      // batch
      let out = 'Batch: ' + data.results.length + ' event(s)\\n\\n';
      data.results.forEach((r,i) => { out += '--- Event '+(i+1)+' ---\\n' + formatValidation(r) + '\\n'; });
      el.className = 'result ' + (data.results.every(r=>r.valid)?'ok':'err');
      el.textContent = out;
    } else {
      el.className = 'result ' + (data.valid?'ok':'err');
      el.textContent = formatValidation(data);
    }
  } catch(e) { el.className='result err'; el.textContent='Error: '+e.message; }
}

function formatValidation(d) {
  let out = (d.valid ? '✅ VALID' : '❌ INVALID') + '\\n';
  if (d.kind) out += 'Kind: '+d.kind+'\\n';
  if (d.errors?.length) out += '\\nErrors:\\n' + d.errors.map(e=>'  ✗ '+e).join('\\n') + '\\n';
  if (d.warnings?.length) out += '\\nWarnings:\\n' + d.warnings.map(w=>'  ⚠ '+w).join('\\n') + '\\n';
  if (d.info?.length) out += '\\nInfo:\\n' + d.info.map(i=>'  ℹ '+i).join('\\n') + '\\n';
  return out;
}

// --- Query ---
async function runQuery() {
  const el = document.getElementById('query-result');
  const badge = document.getElementById('badge-preview');
  const pubkey = document.getElementById('query-pubkey').value.trim();
  const amount = parseInt(document.getElementById('query-amount').value) || 5000;
  if (!pubkey) { el.className='result err'; el.textContent='Enter a pubkey.'; return; }
  try {
    const resp = await fetch(API + '/reputation/' + pubkey);
    const data = await resp.json();
    let out = 'Pubkey: ' + pubkey + '\\n';
    out += 'Trust level: ' + (data.trustLevel || 'none') + '\\n';
    out += 'Attestations: ' + (data.attestationCount || 0) + '\\n';
    out += 'Attesters: ' + (data.attesterCount || 0) + '\\n';
    out += 'Total weight: ' + (data.totalWeight?.toFixed(2) || '0') + '\\n';
    if (data.dimensions && Object.keys(data.dimensions).length) {
      out += '\\nDimensions:\\n';
      for (const [k,v] of Object.entries(data.dimensions)) {
        const val = typeof v === 'object' ? v.weightedAvg : v;
        const n = typeof v === 'object' ? v.numAttesters : '?';
        out += '  ' + k + ': ' + (typeof val==='number'?val.toFixed(2):val) + ' (' + n + ' attester(s))\\n';
      }
    }
    // Payment gate
    out += '\\n--- Payment Gate (' + amount + ' sats) ---\\n';
    const tw = data.totalWeight || 0;
    const sr = data.dimensions?.settlement_rate?.weightedAvg ?? data.dimensions?.payment_success_rate?.weightedAvg ?? null;
    if (tw === 0 && amount <= 100) out += '✅ ALLOW (blind payment under 100 sats)\\n';
    else if (tw === 0) out += '❌ DENY (no reputation data for ' + amount + ' sats)\\n';
    else if (sr !== null && sr < 0.9) out += '❌ DENY (settlement rate ' + sr.toFixed(2) + ' < 0.90)\\n';
    else if (tw < 0.3) out += '⚠️ CAUTION (low confidence, weight ' + tw.toFixed(2) + ')\\n';
    else out += '✅ ALLOW (trust: ' + (data.trustLevel||'unknown') + ', weight: ' + tw.toFixed(2) + ')\\n';

    el.className = 'result ' + (tw > 0 ? 'ok' : 'neutral');
    el.textContent = out;

    // Show badge
    badge.innerHTML = '<p style="color:var(--dim);font-size:0.85rem;">Embeddable badge:</p><img src="' + API + '/reputation/badge/' + pubkey + '" alt="reputation badge"><br><code style="font-size:0.75rem;color:var(--dim);">&lt;img src=&quot;' + API + '/reputation/badge/' + pubkey + '&quot;&gt;</code>';
  } catch(e) { el.className='result err'; el.textContent='Error: '+e.message; badge.innerHTML=''; }
}

// --- Discover ---
async function runDiscover() {
  const el = document.getElementById('discover-result');
  const type = document.getElementById('discover-type').value.trim();
  const url = API + '/discover' + (type ? '?type='+encodeURIComponent(type) : '');
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    const services = data.services || data;
    if (!services?.length) { el.className='result neutral'; el.textContent='No services found.'; return; }
    let out = 'Found ' + services.length + ' service(s):\\n\\n';
    services.forEach((s,i) => {
      out += (i+1) + '. ' + (s.serviceId || s.service_type || '?') + '\\n';
      out += '   Pubkey: ' + (s.pubkey||'?').slice(0,20) + '...\\n';
      if (s.description) out += '   ' + s.description.slice(0,80) + '\\n';
      if (s.protocol) out += '   Protocol: ' + s.protocol + '\\n';
      if (s.endpoint) out += '   Endpoint: ' + s.endpoint + '\\n';
      if (s.price) out += '   Price: ' + s.price.amount + ' ' + (s.price.unit||'sats') + '\\n';
      out += '\\n';
    });
    el.className = 'result ok';
    el.textContent = out;
  } catch(e) { el.className='result err'; el.textContent='Error: '+e.message; }
}
</script>
</body>
</html>`;
}

// --- Route: GET / ---

function handleDocs() {
  return {
    status: 200,
    data: {
      name: 'NIP Agent Reputation API',
      version: '1.0.12',
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

      // Route: GET /directory
      if (pathname === '/directory' && req.method === 'GET') {
        const result = await handleDirectory(params, relayUrls);
        if (result.contentType === 'text/html') {
          res.writeHead(result.status, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'public, max-age=120',
          });
          res.end(result.data);
        } else {
          respond(res, result.status, result.data);
        }
        return;
      }

      // Route: GET /discover
      if (pathname === '/discover' && req.method === 'GET') {
        const result = await handleDiscover(params, relayUrls);
        respond(res, result.status, result.data);
        return;
      }

      // Route: GET /playground
      if (pathname === '/playground' && req.method === 'GET') {
        const result = handlePlayground();
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(result);
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
      respond(res, 404, { error: 'Not found', availableEndpoints: ['/', '/health', '/reputation/:pubkey', '/reputation/badge/:pubkey', '/directory', '/discover', '/validate', '/playground'] });

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
