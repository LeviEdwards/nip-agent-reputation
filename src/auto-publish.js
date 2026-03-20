/**
 * Auto-publish module for periodic self-attestation updates.
 * 
 * Tracks last published state and determines whether a new attestation
 * should be published based on:
 * 1. Time elapsed since last publish (minimum interval)
 * 2. Meaningful change in metrics (change threshold)
 * 3. Force flag override
 * 
 * Designed for cron integration: exit code 0 = published, 1 = skipped, 2 = error.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', '.auto-publish-state.json');

// Default: publish at most every 6 hours, unless metrics changed significantly
const DEFAULT_MIN_INTERVAL_HOURS = 6;
// Meaningful change thresholds per dimension type
const CHANGE_THRESHOLDS = {
  payment_success_rate: 0.02,   // 2% change
  settlement_rate: 0.02,        // 2% change
  uptime_percent: 1.0,          // 1% point change
  capacity_sats: 50000,         // 50k sats change
  num_channels: 1,              // any channel change
  num_forwards: 5,              // 5+ new forwards
  response_time_ms: 200,        // 200ms change
  dispute_rate: 0.01,           // 1% change
};

/**
 * Load last publish state from disk.
 */
export function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  }
  return null;
}

/**
 * Save publish state to disk.
 */
export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Determine if metrics have changed meaningfully since last publish.
 * Returns { changed: boolean, reasons: string[] }
 */
export function detectMeaningfulChange(currentDimensions, lastDimensions) {
  if (!lastDimensions) return { changed: true, reasons: ['no previous state'] };

  const reasons = [];

  for (const [name, current] of Object.entries(currentDimensions)) {
    const last = lastDimensions[name];
    if (!last) {
      reasons.push(`new dimension: ${name}`);
      continue;
    }

    const currentVal = parseFloat(current.value);
    const lastVal = parseFloat(last.value);
    const threshold = CHANGE_THRESHOLDS[name] || 0;

    if (threshold > 0 && Math.abs(currentVal - lastVal) >= threshold) {
      reasons.push(`${name}: ${lastVal} → ${currentVal} (threshold: ${threshold})`);
    }
  }

  // Check for removed dimensions
  for (const name of Object.keys(lastDimensions)) {
    if (!currentDimensions[name]) {
      reasons.push(`removed dimension: ${name}`);
    }
  }

  return { changed: reasons.length > 0, reasons };
}

/**
 * Determine whether to publish based on state + options.
 * Returns { shouldPublish: boolean, reason: string }
 */
export function shouldPublish(currentMetrics, opts = {}) {
  const force = opts.force || false;
  const minIntervalHours = opts.minIntervalHours || DEFAULT_MIN_INTERVAL_HOURS;
  const maxIntervalHours = opts.maxIntervalHours || 168; // 7 days max staleness

  if (force) return { shouldPublish: true, reason: 'forced' };

  const state = loadState();

  if (!state) {
    return { shouldPublish: true, reason: 'no previous publish state' };
  }

  const hoursSinceLast = (Date.now() - state.publishedAt) / (1000 * 3600);

  // Always publish if over max interval (prevents staleness)
  if (hoursSinceLast >= maxIntervalHours) {
    return { shouldPublish: true, reason: `max interval exceeded (${Math.round(hoursSinceLast)}h > ${maxIntervalHours}h)` };
  }

  // Don't publish if under minimum interval (rate limiting)
  if (hoursSinceLast < minIntervalHours) {
    return { shouldPublish: false, reason: `too soon (${Math.round(hoursSinceLast * 10) / 10}h < ${minIntervalHours}h minimum)` };
  }

  // Between min and max: publish only if metrics changed meaningfully
  const { changed, reasons } = detectMeaningfulChange(
    currentMetrics.dimensions,
    state.dimensions
  );

  if (changed) {
    return { shouldPublish: true, reason: `metrics changed: ${reasons.join('; ')}` };
  }

  return { shouldPublish: false, reason: `no meaningful change (last publish ${Math.round(hoursSinceLast)}h ago)` };
}

/**
 * Record a successful publish.
 */
export function recordPublish(metrics, eventId) {
  saveState({
    publishedAt: Date.now(),
    publishedAtISO: new Date().toISOString(),
    eventId,
    dimensions: metrics.dimensions,
    pubkey: metrics.pubkey,
    meta: {
      numChannels: metrics._meta?.numActiveChannels,
      totalCapacity: metrics._meta?.totalCapacity,
      totalPayments: metrics._meta?.totalPayments,
    },
  });
}
