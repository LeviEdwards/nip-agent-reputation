/**
 * Automated Endpoint Monitoring Service for NIP Agent Reputation.
 * 
 * Reads a registry of endpoints, probes each, and publishes kind 30386
 * observer attestations. Designed to run on a cron (e.g. every 6 hours).
 * 
 * Registry format (JSON):
 *   {
 *     "endpoints": [
 *       {
 *         "url": "https://utilshed.com",
 *         "subjectPubkey": "c82ba636...",
 *         "serviceType": "http-endpoint",
 *         "probeCount": 5,
 *         "enabled": true,
 *         "label": "UtilShed (karl_bott)",
 *         "tier": "free"
 *       }
 *     ]
 *   }
 * 
 * Usage:
 *   node src/monitor.js                    # Run full monitoring cycle
 *   node src/monitor.js --dry-run          # Probe but don't publish
 *   node src/monitor.js --registry <path>  # Use custom registry file
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ObservationSession, buildObserverAttestation } from './observer.js';
import { publishToRelays, DEFAULT_RELAYS } from './attestation.js';
import { getKeypair } from './keys.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = join(__dirname, '..', 'data', 'monitor-registry.json');
const LOG_DIR = join(__dirname, '..', 'data', 'monitor-logs');

/**
 * Probe a single HTTP endpoint multiple times.
 * Returns array of probe results.
 */
async function probeEndpoint(url, count = 5, delayMs = 2000) {
  const results = [];
  
  for (let i = 0; i < count; i++) {
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'NIP-30386-Monitor/1.0' },
        redirect: 'follow',
      });
      clearTimeout(timeout);
      
      const latencyMs = Date.now() - start;
      results.push({
        reachable: resp.status >= 200 && resp.status < 500,
        latencyMs,
        statusCode: resp.status,
        timestamp: Math.floor(Date.now() / 1000),
      });
    } catch (err) {
      results.push({
        reachable: false,
        latencyMs: null,
        statusCode: null,
        error: err.message,
        timestamp: Math.floor(Date.now() / 1000),
      });
    }
    
    // Delay between probes (except last)
    if (i < count - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  
  return results;
}

/**
 * Check security headers for an endpoint.
 * Returns object with header presence info.
 */
async function checkSecurityHeaders(url) {
  const SECURITY_HEADERS = [
    'strict-transport-security',
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'permissions-policy',
    'x-xss-protection',
  ];
  
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    clearTimeout(timeout);
    
    const present = SECURITY_HEADERS.filter(h => resp.headers.has(h));
    return {
      score: present.length / SECURITY_HEADERS.length,
      present,
      missing: SECURITY_HEADERS.filter(h => !present.includes(h)),
      total: SECURITY_HEADERS.length,
    };
  } catch (err) {
    return { score: 0, present: [], missing: SECURITY_HEADERS, total: SECURITY_HEADERS.length, error: err.message };
  }
}

/**
 * Run full monitoring cycle for all enabled endpoints.
 */
export async function runMonitoringCycle(opts = {}) {
  const registryPath = opts.registryPath || DEFAULT_REGISTRY;
  const dryRun = opts.dryRun || false;
  const relays = opts.relays || DEFAULT_RELAYS;
  
  if (!existsSync(registryPath)) {
    console.error(`Registry not found: ${registryPath}`);
    console.error('Create one with: node src/monitor.js --init');
    return { error: 'registry_not_found', published: 0, probed: 0 };
  }
  
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const endpoints = (registry.endpoints || []).filter(e => e.enabled !== false);
  
  if (endpoints.length === 0) {
    console.log('No enabled endpoints in registry.');
    return { published: 0, probed: 0, endpoints: [] };
  }
  
  const { secretKey } = getKeypair();
  const results = [];
  
  console.log(`Monitoring ${endpoints.length} endpoint(s)...`);
  console.log(dryRun ? '(DRY RUN — no publishing)' : '');
  
  for (const ep of endpoints) {
    console.log(`\n--- ${ep.label || ep.url} ---`);
    
    // Probe endpoint
    const probeCount = ep.probeCount || 5;
    console.log(`  Probing ${ep.url} (${probeCount} samples)...`);
    const probes = await probeEndpoint(ep.url, probeCount);
    
    const reachable = probes.filter(p => p.reachable).length;
    const avgLatency = probes.filter(p => p.latencyMs).reduce((s, p) => s + p.latencyMs, 0) / 
                       (probes.filter(p => p.latencyMs).length || 1);
    console.log(`  Results: ${reachable}/${probeCount} reachable, avg ${avgLatency.toFixed(0)}ms`);
    
    // Check security headers
    console.log(`  Checking security headers...`);
    const security = await checkSecurityHeaders(ep.url);
    console.log(`  Security: ${security.present.length}/${security.total} headers present (${(security.score * 100).toFixed(0)}%)`);
    
    // Build observation session
    const session = new ObservationSession(
      ep.subjectPubkey,
      ep.serviceType || 'http-endpoint',
      {
        subjectNostrPubkey: ep.subjectNostrPubkey || null,
        observerNote: `Automated monitoring by Satoshi node. ${probeCount} HTTP probes. ${ep.label || ep.url}`,
      }
    );
    
    // Record each probe
    for (const probe of probes) {
      session.recordProbe(probe);
    }
    
    // Build attestation event
    const dims = session.computeDimensions();
    
    // Add security dimension
    if (security.score !== undefined && !security.error) {
      dims.security_score = {
        value: security.score.toFixed(4),
        sampleSize: 1,
      };
    }
    
    // Build and optionally publish
    let eventId = null;
    let publishResult = null;
    
    if (!dryRun) {
      try {
        const event = buildObserverAttestation(session, secretKey, {
          extraDimensions: { security_score: dims.security_score },
        });
        eventId = event.id;
        
        console.log(`  Event ID: ${eventId}`);
        console.log(`  Publishing to ${relays.length} relays...`);
        
        publishResult = await publishToRelays(event, relays);
        console.log(`  Accepted: ${publishResult.accepted.length}/${relays.length}`);
      } catch (err) {
        console.error(`  Publish error: ${err.message}`);
      }
    } else {
      console.log(`  [DRY RUN] Would publish attestation with ${Object.keys(dims).length} dimensions`);
    }
    
    results.push({
      url: ep.url,
      label: ep.label,
      subjectPubkey: ep.subjectPubkey,
      tier: ep.tier || 'free',
      probes: { total: probeCount, reachable, avgLatencyMs: Math.round(avgLatency) },
      security,
      dimensions: dims,
      eventId,
      publishResult,
    });
  }
  
  // Write log
  ensureDir(LOG_DIR);
  const logFile = join(LOG_DIR, `${new Date().toISOString().split('T')[0]}.json`);
  const logEntry = {
    timestamp: new Date().toISOString(),
    dryRun,
    endpointsMonitored: endpoints.length,
    results,
  };
  
  let existingLog = [];
  if (existsSync(logFile)) {
    try { existingLog = JSON.parse(readFileSync(logFile, 'utf8')); } catch {}
  }
  if (!Array.isArray(existingLog)) existingLog = [existingLog];
  existingLog.push(logEntry);
  writeFileSync(logFile, JSON.stringify(existingLog, null, 2));
  console.log(`\nLog written to ${logFile}`);
  
  const summary = {
    published: results.filter(r => r.eventId).length,
    probed: results.length,
    endpoints: results.map(r => ({
      label: r.label,
      uptime: `${r.probes.reachable}/${r.probes.total}`,
      avgMs: r.probes.avgLatencyMs,
      security: `${r.security.present.length}/${r.security.total}`,
      eventId: r.eventId,
    })),
  };
  
  console.log(`\n=== Summary: ${summary.published} published, ${summary.probed} probed ===`);
  return summary;
}

/**
 * Initialize a new registry file with example entries.
 */
export function initRegistry(registryPath) {
  const path = registryPath || DEFAULT_REGISTRY;
  ensureDir(dirname(path));
  
  const template = {
    version: 1,
    description: 'NIP-30386 Endpoint Monitoring Registry',
    updatedAt: new Date().toISOString(),
    endpoints: [
      {
        url: 'https://utilshed.com',
        subjectPubkey: 'c82ba63605e4f94647322ab7f26a4bad25c88fe27f87ed8706ca4082e900c158',
        subjectNostrPubkey: 'c82ba63605e4f94647322ab7f26a4bad25c88fe27f87ed8706ca4082e900c158',
        serviceType: 'http-endpoint',
        probeCount: 5,
        enabled: true,
        label: 'UtilShed (karl_bott)',
        tier: 'free',
        addedAt: '2026-03-25',
      },
      {
        url: 'https://dispatches.mystere.me',
        subjectPubkey: '1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead',
        subjectNostrPubkey: '1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead',
        serviceType: 'http-endpoint',
        probeCount: 5,
        enabled: true,
        label: 'Dispatches (self-monitor)',
        tier: 'self',
        addedAt: '2026-03-25',
      },
    ],
  };
  
  writeFileSync(path, JSON.stringify(template, null, 2));
  console.log(`Registry initialized at ${path}`);
  return template;
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// CLI entry point
if (process.argv[1] && (process.argv[1].endsWith('/monitor.js') || process.argv[1] === fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  
  if (args.includes('--init')) {
    const idx = args.indexOf('--registry');
    initRegistry(idx >= 0 ? args[idx + 1] : undefined);
  } else {
    const dryRun = args.includes('--dry-run');
    const idx = args.indexOf('--registry');
    const registryPath = idx >= 0 ? args[idx + 1] : undefined;
    
    runMonitoringCycle({ dryRun, registryPath }).catch(err => {
      console.error('Monitor failed:', err);
      process.exit(1);
    });
  }
}
