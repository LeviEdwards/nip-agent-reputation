/**
 * Attestation Order Fulfillment
 * 
 * When a paid order is detected:
 * 1. Adds endpoint to monitor registry
 * 2. Runs immediate probe + publishes first attestation
 * 3. Updates order file with attestation event ID
 * 4. Logs fulfillment for audit trail
 * 
 * Usage:
 *   node src/fulfill.js <order-json-path>
 *   node src/fulfill.js --scan <orders-dir>   # Scan for unfulfilled paid orders
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { probeEndpoint, checkSecurityHeaders } from './monitor.js';
import { ObservationSession, buildObserverAttestation } from './observer.js';
import { publishToRelays, DEFAULT_RELAYS } from './attestation.js';
import { getKeypair } from './keys.js';
import { addToBilling } from './billing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const REGISTRY_PATH = join(DATA_DIR, 'monitor-registry.json');
const FULFILL_LOG = join(DATA_DIR, 'fulfillment-log.json');

// Moltbook DM config for partner notifications
const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';
const MOLTBOOK_API_KEY = 'moltbook_sk_4AQK9KbEL-ypTRPr3w20HYhU4DwgQxV_';
// karl_bott conversation ID on Moltbook
const KARL_CONVERSATION_ID = process.env.KARL_DM_CONVERSATION_ID || '987483e9-c316-4a4f-9b1c-8b396501eac9';

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Add an endpoint to the monitor registry (idempotent).
 */
function addToRegistry(endpointUrl, nostrPubkey, orderId, contact, label) {
  ensureDir(DATA_DIR);
  
  let registry;
  if (existsSync(REGISTRY_PATH)) {
    registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } else {
    registry = { version: 1, description: 'NIP-30386 Endpoint Monitoring Registry', endpoints: [] };
  }
  
  // Check if already registered
  const existing = registry.endpoints.find(e => e.url === endpointUrl);
  if (existing) {
    console.log(`  Endpoint already in registry: ${endpointUrl}`);
    return { added: false, existing: true };
  }
  
  registry.endpoints.push({
    url: endpointUrl,
    subjectPubkey: nostrPubkey || 'unknown',
    subjectNostrPubkey: nostrPubkey || null,
    serviceType: 'http-endpoint',
    probeCount: 5,
    enabled: true,
    label: label || `${endpointUrl} (order ${orderId})`,
    tier: 'paid',
    addedAt: new Date().toISOString().split('T')[0],
    orderId,
    contact: contact || null,
  });
  
  registry.updatedAt = new Date().toISOString();
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`  Added to registry (${registry.endpoints.length} endpoints total)`);
  return { added: true, total: registry.endpoints.length };
}

/**
 * Probe an endpoint and publish an observer attestation.
 * Returns { eventId, probeResults, securityResults } or { error }.
 */
async function probeAndPublish(endpointUrl, subjectPubkey, opts = {}) {
  const probeCount = opts.probeCount || 5;
  const relays = opts.relays || DEFAULT_RELAYS;
  const dryRun = opts.dryRun || false;
  
  console.log(`  Probing ${endpointUrl} (${probeCount} samples)...`);
  const probes = await probeEndpoint(endpointUrl, probeCount);
  
  const reachable = probes.filter(p => p.reachable).length;
  const latencies = probes.filter(p => p.latencyMs).map(p => p.latencyMs);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  
  console.log(`  Results: ${reachable}/${probeCount} reachable, avg ${avgLatency.toFixed(0)}ms`);
  
  // Security headers
  console.log(`  Checking security headers...`);
  const security = await checkSecurityHeaders(endpointUrl);
  console.log(`  Security: ${security.present.length}/${security.total} headers`);
  
  // Build observation session
  const session = new ObservationSession(
    subjectPubkey || 'unknown',
    'http-endpoint',
    {
      subjectNostrPubkey: subjectPubkey || null,
      observerNote: `Paid attestation service. ${probeCount} HTTP probes. ${endpointUrl}`,
    }
  );
  
  for (const probe of probes) {
    session.recordProbe(probe);
  }
  
  const dims = session.computeDimensions();
  if (security.score !== undefined && !security.error) {
    dims.security_score = { value: security.score.toFixed(4), sampleSize: 1 };
  }
  
  if (dryRun) {
    console.log(`  [DRY RUN] Would publish with ${Object.keys(dims).length} dimensions`);
    return { dryRun: true, dimensions: dims, probeResults: { reachable, total: probeCount, avgLatencyMs: Math.round(avgLatency) } };
  }
  
  // Publish
  const { secretKey } = getKeypair();
  const event = buildObserverAttestation(session, secretKey, {
    extraDimensions: { security_score: dims.security_score },
  });
  
  console.log(`  Event ID: ${event.id}`);
  console.log(`  Publishing to ${relays.length} relays...`);
  
  const publishResult = await publishToRelays(event, relays);
  console.log(`  Accepted: ${publishResult.accepted.length}/${relays.length}`);
  
  return {
    eventId: event.id,
    dimensions: dims,
    probeResults: { reachable, total: probeCount, avgLatencyMs: Math.round(avgLatency) },
    securityResults: security,
    relaysAccepted: publishResult.accepted.length,
  };
}

/**
 * Log a fulfillment event for audit trail.
 */
function logFulfillment(orderId, endpointUrl, result) {
  ensureDir(DATA_DIR);
  
  let log = [];
  if (existsSync(FULFILL_LOG)) {
    try { log = JSON.parse(readFileSync(FULFILL_LOG, 'utf8')); } catch {}
  }
  if (!Array.isArray(log)) log = [];
  
  log.push({
    timestamp: new Date().toISOString(),
    orderId,
    endpointUrl,
    eventId: result.eventId || null,
    probeResults: result.probeResults || null,
    error: result.error || null,
  });
  
  writeFileSync(FULFILL_LOG, JSON.stringify(log, null, 2));
}

/**
 * Fulfill a single order: add to registry, probe, publish, update order file.
 */
export async function fulfillOrder(orderFilePath, opts = {}) {
  console.log(`\n=== Fulfilling order: ${orderFilePath} ===`);
  
  const order = JSON.parse(readFileSync(orderFilePath, 'utf8'));
  
  if (!order.paid) {
    console.log('  Order not paid, skipping.');
    return { skipped: true, reason: 'not_paid' };
  }
  
  if (order.monitoring_started && order.first_attestation_event) {
    console.log(`  Already fulfilled (event ${order.first_attestation_event}), skipping.`);
    return { skipped: true, reason: 'already_fulfilled' };
  }
  
  const { endpoint_url, nostr_pubkey, orderId, contact } = order;
  
  if (!endpoint_url) {
    console.log('  No endpoint_url in order, skipping.');
    return { skipped: true, reason: 'no_endpoint' };
  }
  
  // Step 1: Add to registry
  addToRegistry(endpoint_url, nostr_pubkey, orderId, contact);
  
  // Step 2: Probe and publish
  const result = await probeAndPublish(endpoint_url, nostr_pubkey, opts);
  
  // Step 3: Update order file
  if (result.eventId) {
    order.first_attestation_event = result.eventId;
    order.monitoring_started = true;
    order.monitoring_started_at = new Date().toISOString();
    order.first_probe_results = result.probeResults;
    writeFileSync(orderFilePath, JSON.stringify(order, null, 2));
    console.log(`  Order updated: monitoring_started=true, event=${result.eventId}`);
  }
  
  // Step 4: Add to recurring billing cycle
  if (result.eventId) {
    try {
      addToBilling(order);
    } catch (err) {
      console.log(`  Billing registration error (non-fatal): ${err.message}`);
    }
  }
  
  // Step 5: Notify monitoring partner
  if (result.eventId) {
    await notifyPartner(order, result);
  }
  
  // Step 6: Log
  logFulfillment(orderId, endpoint_url, result);
  
  console.log(`=== Fulfillment complete ===\n`);
  return result;
}

/**
 * Notify monitoring partner (karl_bott) about a newly fulfilled order.
 * Uses Moltbook DM API. Non-fatal — logs errors but doesn't fail fulfillment.
 */
async function notifyPartner(order, result) {
  if (!KARL_CONVERSATION_ID) {
    console.log('  Partner notification: KARL_DM_CONVERSATION_ID not set, skipping.');
    return { sent: false, reason: 'no_conversation_id' };
  }
  
  const msg = [
    `🔔 New attestation order fulfilled!`,
    ``,
    `**Endpoint:** ${order.endpoint_url}`,
    `**Order ID:** ${order.orderId}`,
    `**Probe results:** ${result.probeResults?.reachable}/${result.probeResults?.total} reachable, ${result.probeResults?.avgLatencyMs}ms avg`,
    `**Security:** ${result.securityResults?.present?.length || 0}/${result.securityResults?.total || 7} headers`,
    `**Event ID:** ${result.eventId}`,
    `**Amount:** ${order.amount_sats} sats`,
    ``,
    `This endpoint is now in the monitoring registry. Your share: ${Math.round((order.amount_sats || 5000) * 0.6)} sats (60%).`,
    `Please add it to your monitoring schedule.`
  ].join('\n');
  
  try {
    const resp = await fetch(`${MOLTBOOK_API}/agents/dm/conversations/${KARL_CONVERSATION_ID}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': MOLTBOOK_API_KEY,
      },
      body: JSON.stringify({ message: msg }),
    });
    
    if (resp.ok) {
      console.log('  Partner notification sent to karl_bott via Moltbook DM. ✓');
      return { sent: true };
    } else {
      const text = await resp.text().catch(() => '');
      console.log(`  Partner notification failed: ${resp.status} ${text}`);
      return { sent: false, reason: `http_${resp.status}` };
    }
  } catch (err) {
    console.log(`  Partner notification error: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}

/**
 * Scan an orders directory for unfulfilled paid orders and fulfill them.
 */
export async function scanAndFulfill(ordersDir, opts = {}) {
  if (!existsSync(ordersDir)) {
    console.log(`Orders directory not found: ${ordersDir}`);
    return { fulfilled: 0, errors: 0 };
  }
  
  const files = readdirSync(ordersDir).filter(f => f.endsWith('.json'));
  console.log(`Scanning ${files.length} order file(s) in ${ordersDir}...`);
  
  let fulfilled = 0;
  let errors = 0;
  let skipped = 0;
  
  for (const file of files) {
    const filePath = join(ordersDir, file);
    try {
      const result = await fulfillOrder(filePath, opts);
      if (result.skipped) {
        skipped++;
      } else if (result.eventId) {
        fulfilled++;
      } else if (result.error) {
        errors++;
      }
    } catch (err) {
      console.error(`  Error fulfilling ${file}: ${err.message}`);
      errors++;
    }
  }
  
  console.log(`\nScan complete: ${fulfilled} fulfilled, ${skipped} skipped, ${errors} errors`);
  return { fulfilled, skipped, errors };
}

// CLI entry point
const isMain = process.argv[1] && (
  process.argv[1].endsWith('/fulfill.js') || 
  process.argv[1] === fileURLToPath(import.meta.url)
);

if (isMain) {
  const args = process.argv.slice(2);
  
  if (args.includes('--scan')) {
    const idx = args.indexOf('--scan');
    const ordersDir = args[idx + 1];
    if (!ordersDir) {
      console.error('Usage: node src/fulfill.js --scan <orders-dir>');
      process.exit(1);
    }
    const dryRun = args.includes('--dry-run');
    scanAndFulfill(ordersDir, { dryRun }).catch(err => {
      console.error('Scan failed:', err);
      process.exit(1);
    });
  } else if (args[0]) {
    const dryRun = args.includes('--dry-run');
    fulfillOrder(args[0], { dryRun }).catch(err => {
      console.error('Fulfillment failed:', err);
      process.exit(1);
    });
  } else {
    console.log('Usage:');
    console.log('  node src/fulfill.js <order-json-path>         # Fulfill single order');
    console.log('  node src/fulfill.js --scan <orders-dir>       # Scan for unfulfilled orders');
    console.log('  node src/fulfill.js --scan <dir> --dry-run    # Dry run');
  }
}
