/**
 * Tests for auto-publish module.
 * Tests change detection, interval logic, and state management.
 */

import { detectMeaningfulChange, shouldPublish, loadState, saveState, recordPublish } from './auto-publish.js';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, '..', '.auto-publish-state.json');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

// Backup and cleanup state file
const hadState = existsSync(STATE_FILE);
let originalState = null;
if (hadState) {
  originalState = readFileSync(STATE_FILE, 'utf8');
}

function cleanup() {
  if (originalState) {
    writeFileSync(STATE_FILE, originalState);
  } else if (existsSync(STATE_FILE)) {
    unlinkSync(STATE_FILE);
  }
}

// Mock metrics
const baseMetrics = {
  pubkey: '03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8',
  alias: 'TestNode',
  dimensions: {
    payment_success_rate: { value: '0.9500', sampleSize: 20 },
    settlement_rate: { value: '0.9500', sampleSize: 20 },
    uptime_percent: { value: '99.5', sampleSize: 2 },
    capacity_sats: { value: '1400000', sampleSize: 2 },
    num_channels: { value: '2', sampleSize: 1 },
    num_forwards: { value: '0', sampleSize: 1 },
  },
  _meta: { numActiveChannels: 2, totalCapacity: 1400000, totalPayments: 20 },
};

try {
  // === Phase 1: Change Detection ===
  console.log('\n=== Phase 1: Change Detection ===');

  // No previous state
  {
    const result = detectMeaningfulChange(baseMetrics.dimensions, null);
    assert(result.changed === true, 'No previous state → changed');
    assert(result.reasons[0] === 'no previous state', 'Reason: no previous state');
  }

  // Identical metrics
  {
    const result = detectMeaningfulChange(baseMetrics.dimensions, baseMetrics.dimensions);
    assert(result.changed === false, 'Identical metrics → no change');
    assert(result.reasons.length === 0, 'No reasons for change');
  }

  // Small change (below threshold)
  {
    const slightly = { ...baseMetrics.dimensions };
    slightly.payment_success_rate = { value: '0.9510', sampleSize: 21 }; // +0.001, threshold is 0.02
    const result = detectMeaningfulChange(slightly, baseMetrics.dimensions);
    assert(result.changed === false, 'Small payment rate change → no meaningful change');
  }

  // Meaningful change in payment rate
  {
    const changed = { ...baseMetrics.dimensions };
    changed.payment_success_rate = { value: '0.9800', sampleSize: 25 }; // +0.03, threshold is 0.02
    const result = detectMeaningfulChange(changed, baseMetrics.dimensions);
    assert(result.changed === true, 'Meaningful payment rate change detected');
    assert(result.reasons[0].includes('payment_success_rate'), 'Reason identifies dimension');
  }

  // New channel opened
  {
    const changed = { ...baseMetrics.dimensions };
    changed.num_channels = { value: '3', sampleSize: 1 }; // +1, threshold is 1
    const result = detectMeaningfulChange(changed, baseMetrics.dimensions);
    assert(result.changed === true, 'New channel detected as change');
  }

  // Capacity change below threshold
  {
    const changed = { ...baseMetrics.dimensions };
    changed.capacity_sats = { value: '1410000', sampleSize: 2 }; // +10k, threshold 50k
    const result = detectMeaningfulChange(changed, baseMetrics.dimensions);
    assert(result.changed === false, 'Small capacity change → no meaningful change');
  }

  // Capacity change above threshold
  {
    const changed = { ...baseMetrics.dimensions };
    changed.capacity_sats = { value: '1500000', sampleSize: 3 }; // +100k, threshold 50k
    const result = detectMeaningfulChange(changed, baseMetrics.dimensions);
    assert(result.changed === true, 'Large capacity change detected');
  }

  // New dimension added
  {
    const changed = { ...baseMetrics.dimensions, response_time_ms: { value: '500', sampleSize: 10 } };
    const result = detectMeaningfulChange(changed, baseMetrics.dimensions);
    assert(result.changed === true, 'New dimension detected');
    assert(result.reasons.some(r => r.includes('new dimension')), 'Reason: new dimension');
  }

  // Dimension removed
  {
    const { num_forwards, ...reduced } = baseMetrics.dimensions;
    const result = detectMeaningfulChange(reduced, baseMetrics.dimensions);
    assert(result.changed === true, 'Removed dimension detected');
    assert(result.reasons.some(r => r.includes('removed dimension')), 'Reason: removed dimension');
  }

  // === Phase 2: shouldPublish Logic ===
  console.log('\n=== Phase 2: shouldPublish Logic ===');

  // Clean state → should publish
  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  {
    const result = shouldPublish(baseMetrics);
    assert(result.shouldPublish === true, 'No state file → should publish');
    assert(result.reason.includes('no previous'), 'Reason: no previous state');
  }

  // Force mode always publishes
  {
    // Save a recent state
    saveState({
      publishedAt: Date.now(),
      publishedAtISO: new Date().toISOString(),
      eventId: 'test123',
      dimensions: baseMetrics.dimensions,
    });
    const result = shouldPublish(baseMetrics, { force: true });
    assert(result.shouldPublish === true, 'Force mode → always publish');
    assert(result.reason === 'forced', 'Reason: forced');
  }

  // Recently published, no change → skip
  {
    saveState({
      publishedAt: Date.now() - (1 * 3600 * 1000), // 1 hour ago
      publishedAtISO: new Date().toISOString(),
      eventId: 'test123',
      dimensions: baseMetrics.dimensions,
    });
    const result = shouldPublish(baseMetrics, { minIntervalHours: 6 });
    assert(result.shouldPublish === false, 'Too recent → skip');
    assert(result.reason.includes('too soon'), 'Reason: too soon');
  }

  // Past min interval, no change → skip
  {
    saveState({
      publishedAt: Date.now() - (12 * 3600 * 1000), // 12 hours ago
      publishedAtISO: new Date().toISOString(),
      eventId: 'test123',
      dimensions: baseMetrics.dimensions,
    });
    const result = shouldPublish(baseMetrics, { minIntervalHours: 6, maxIntervalHours: 168 });
    assert(result.shouldPublish === false, 'Past min interval, no change → skip');
    assert(result.reason.includes('no meaningful change'), 'Reason: no meaningful change');
  }

  // Past min interval, with change → publish
  {
    const changedMetrics = { ...baseMetrics, dimensions: { ...baseMetrics.dimensions } };
    changedMetrics.dimensions.num_channels = { value: '4', sampleSize: 1 };
    saveState({
      publishedAt: Date.now() - (12 * 3600 * 1000), // 12 hours ago
      publishedAtISO: new Date().toISOString(),
      eventId: 'test123',
      dimensions: baseMetrics.dimensions,
    });
    const result = shouldPublish(changedMetrics, { minIntervalHours: 6 });
    assert(result.shouldPublish === true, 'Past min interval + change → publish');
    assert(result.reason.includes('metrics changed'), 'Reason: metrics changed');
  }

  // Past max interval → always publish (prevents staleness)
  {
    saveState({
      publishedAt: Date.now() - (200 * 3600 * 1000), // 200 hours ago (> 168 max)
      publishedAtISO: new Date().toISOString(),
      eventId: 'test123',
      dimensions: baseMetrics.dimensions,
    });
    const result = shouldPublish(baseMetrics, { maxIntervalHours: 168 });
    assert(result.shouldPublish === true, 'Past max interval → publish (anti-stale)');
    assert(result.reason.includes('max interval exceeded'), 'Reason: max interval exceeded');
  }

  // === Phase 3: State Persistence ===
  console.log('\n=== Phase 3: State Persistence ===');

  if (existsSync(STATE_FILE)) unlinkSync(STATE_FILE);
  {
    assert(loadState() === null, 'No state file → returns null');

    recordPublish(baseMetrics, 'event_abc123');
    const state = loadState();
    assert(state !== null, 'State saved after recordPublish');
    assert(state.eventId === 'event_abc123', 'Event ID persisted');
    assert(state.pubkey === baseMetrics.pubkey, 'Pubkey persisted');
    assert(state.dimensions.payment_success_rate.value === '0.9500', 'Dimensions persisted');
    assert(typeof state.publishedAt === 'number', 'publishedAt is a number');
    assert(typeof state.publishedAtISO === 'string', 'publishedAtISO is a string');
    assert(state.meta.numChannels === 2, 'Meta numChannels persisted');
  }

  // === Phase 4: Edge Cases ===
  console.log('\n=== Phase 4: Edge Cases ===');

  // Multiple dimensions change simultaneously
  {
    const bigChange = {
      payment_success_rate: { value: '0.8000', sampleSize: 50 }, // -15%
      settlement_rate: { value: '0.8000', sampleSize: 50 },
      uptime_percent: { value: '90.0', sampleSize: 5 },  // -9.5 points
      capacity_sats: { value: '2000000', sampleSize: 4 }, // +600k
      num_channels: { value: '4', sampleSize: 1 },        // +2
      num_forwards: { value: '50', sampleSize: 1 },       // +50
    };
    const result = detectMeaningfulChange(bigChange, baseMetrics.dimensions);
    assert(result.changed === true, 'Multiple changes detected');
    assert(result.reasons.length >= 4, `Multiple reasons (${result.reasons.length})`);
  }

  // Zero-value dimensions
  {
    const zeroed = { ...baseMetrics.dimensions };
    zeroed.payment_success_rate = { value: '0.0000', sampleSize: 0 };
    const result = detectMeaningfulChange(zeroed, baseMetrics.dimensions);
    assert(result.changed === true, 'Zero payment rate is a meaningful change');
  }

} finally {
  cleanup();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
