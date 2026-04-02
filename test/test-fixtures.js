#!/usr/bin/env node
/**
 * NIP-30386 Test Fixtures
 * Validates the reference implementation against machine-readable test vectors.
 * Other implementations can use test/fixtures/test-vectors.json with their own test runner.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'test-vectors.json'), 'utf-8'));

// Import modules under test
import { parseAttestation, aggregateAttestations } from '../src/attestation.js';

function decayWeight(ageHours, halfLife) {
  return Math.min(1.0, Math.max(0, Math.pow(2, -ageHours / halfLife)));
}
import { validateAttestation, validateHandler } from '../src/validate.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// === Decay Formula Tests ===
console.log('\n=== Decay Formula (from fixtures) ===');
for (const v of vectors.decay.vectors) {
  test(`age=${v.age_hours}h → ${v.expected}`, () => {
    const result = decayWeight(v.age_hours, vectors.decay.half_life_hours);
    const clamped = Math.min(Math.max(result, 0), 1); // clamp for future timestamps
    assert(Math.abs(clamped - v.expected) <= (v.tolerance || 0.001),
      `expected ${v.expected} ± ${v.tolerance || 0.001}, got ${clamped}`);
  });
}

// === D-Tag Format Tests ===
console.log('\n=== D-Tag Format (from fixtures) ===');
for (const d of vectors.d_tag.valid) {
  test(`valid d-tag: ${d.slice(0, 20)}...`, () => {
    const parts = d.split(':');
    assert(parts.length >= 2, 'should have colon');
    assert(/^[a-f0-9]{64}$/.test(parts[0]), 'subject should be 64 lowercase hex');
    assert(parts[1].length > 0, 'service_type should be non-empty');
  });
}
for (const d of vectors.d_tag.invalid) {
  test(`invalid d-tag: ${d.slice(0, 30)}...`, () => {
    const parts = d.split(':');
    const isValid = parts.length >= 2 && /^[a-f0-9]{64}$/.test(parts[0]) && parts[1].length > 0;
    assert(!isValid, 'should be invalid');
  });
}

// === Dimension Format Tests ===
console.log('\n=== Dimension Format (from fixtures) ===');
test('standard dimension has 4 elements', () => {
  const dim = vectors.dimension_formats.standard;
  assert.strictEqual(dim.length, 4);
  assert.strictEqual(dim[0], 'dimension');
  assert(!isNaN(parseFloat(dim[2])), 'value should be numeric');
  assert(!isNaN(parseInt(dim[3])), 'sample_size should be numeric');
});

test('compact dimension has 2 elements', () => {
  const dim = vectors.dimension_formats.compact;
  assert.strictEqual(dim.length, 2);
  assert.strictEqual(dim[0], 'dimension');
  const parts = dim[1].split(',');
  assert(parts.length >= 2, 'compact format should have comma-separated values');
});

test('standard dimensions list is non-empty', () => {
  assert(vectors.dimension_formats.standard_dimensions.length >= 5);
  assert(vectors.dimension_formats.standard_dimensions.includes('payment_success_rate'));
  assert(vectors.dimension_formats.standard_dimensions.includes('uptime_percent'));
});

// === Valid Event Tests ===
console.log('\n=== Valid Events (from fixtures) ===');
for (const v of vectors.valid_events) {
  test(`${v.name} validates`, () => {
    const result = validateAttestation(v.event);
    assert(result.valid, `expected valid but got errors: ${result.errors.map(e => e.code || e.message).join(', ')}`);
  });

  test(`${v.name} parses correctly`, () => {
    const parsed = parseAttestation(v.event);
    assert.strictEqual(parsed.attestationType, v.expected_type, `type: expected ${v.expected_type}, got ${parsed.attestationType}`);
    assert.strictEqual(parsed.serviceType, v.expected_service, `service: expected ${v.expected_service}, got ${parsed.serviceType}`);
  });
}

// === Invalid Event Tests ===
console.log('\n=== Invalid Events (from fixtures) ===');
for (const v of vectors.invalid_events) {
  test(`${v.name} fails validation`, () => {
    const result = validateAttestation(v.event);
    assert(!result.valid, 'expected invalid');
  });

  if (v.expected_errors) {
    test(`${v.name} has expected error codes`, () => {
      const result = validateAttestation(v.event);
      for (const code of v.expected_errors) {
        const found = result.errors.some(e => e.code === code) || result.warnings.some(e => e.code === code);
        assert(found, `expected error/warning code ${code}, got: ${[...result.errors, ...result.warnings].map(e => e.code).join(', ')}`);
      }
    });
  }
}

// === Handler Event Tests ===
console.log('\n=== Handler Event (from fixtures) ===');
test('handler event validates', () => {
  const result = validateHandler(vectors.handler_event.event);
  assert(result.valid, `expected valid but got errors: ${result.errors.map(e => e.code || e.message).join(', ')}`);
});

// === Aggregation Tests ===
console.log('\n=== Aggregation (from fixtures) ===');
for (const v of vectors.aggregation.vectors) {
  test(`aggregation: ${v.name}`, () => {
    const now = Math.floor(Date.now() / 1000);
    const events = v.attestations.map((a, i) => ({
      kind: 30386,
      pubkey: String.fromCharCode(97 + i).repeat(64),
      created_at: now - (a.age_hours * 3600),
      tags: [
        ['d', 'test:test'],
        ['attestation_type', a.type],
        ['service_type', 'test'],
        ['half_life_hours', '720'],
        ['L', 'agent-reputation'],
        ['l', 'attestation', 'agent-reputation'],
        ...Object.entries(a.dimensions).map(([name, val]) => ['dimension', name, String(val), '10']),
      ],
      content: '{}',
    }));

    const parsed = events.map(e => parseAttestation(e));
    const agg = aggregateAttestations(parsed);

    for (const [dim, expected] of Object.entries(v.expected)) {
      assert(agg[dim] !== undefined, `missing dimension ${dim} in aggregation result`);

      if (expected.value !== undefined) {
        assert(Math.abs(agg[dim].weightedAvg - expected.value) < 0.01,
          `${dim}: expected value ${expected.value}, got ${agg[dim].weightedAvg}`);
      }
      if (expected.value_range) {
        assert(agg[dim].weightedAvg >= expected.value_range[0] && agg[dim].weightedAvg <= expected.value_range[1],
          `${dim}: expected value in [${expected.value_range}], got ${agg[dim].weightedAvg}`);
      }
      if (expected.total_weight !== undefined) {
        assert(Math.abs(agg[dim].totalWeight - expected.total_weight) < 0.01,
          `${dim}: expected weight ${expected.total_weight}, got ${agg[dim].totalWeight}`);
      }
      if (expected.total_weight_range) {
        assert(agg[dim].totalWeight >= expected.total_weight_range[0] && agg[dim].totalWeight <= expected.total_weight_range[1],
          `${dim}: expected weight in [${expected.total_weight_range}], got ${agg[dim].totalWeight}`);
      }
      if (expected.num_attesters !== undefined) {
        assert.strictEqual(agg[dim].numAttesters, expected.num_attesters,
          `${dim}: expected ${expected.num_attesters} attesters, got ${agg[dim].numAttesters}`);
      }
    }
  });
}

// === Type Weight Tests ===
console.log('\n=== Type Weights (from fixtures) ===');
test('type weights applied in aggregation', () => {
  const now = Math.floor(Date.now() / 1000);
  for (const [type, expectedWeight] of Object.entries(vectors.type_weights)) {
    if (type === 'description') continue;
    const event = {
      kind: 30386, pubkey: type.repeat(10).slice(0, 64), created_at: now,
      tags: [
        ['d', 'test:test'], ['attestation_type', type], ['service_type', 'test'],
        ['half_life_hours', '720'], ['dimension', 'x', '1.0', '10'],
        ['L', 'agent-reputation'], ['l', 'attestation', 'agent-reputation'],
      ],
      content: '{}',
    };
    const parsed = parseAttestation(event);
    const agg = aggregateAttestations([parsed]);
    // totalWeight should be ~expectedWeight * decayWeight(~0h) ≈ expectedWeight
    assert(Math.abs(agg.x.totalWeight - expectedWeight) < 0.01,
      `${type}: expected totalWeight ~${expectedWeight}, got ${agg.x.totalWeight}`);
  }
});

// === Meta ===
console.log('\n=== Meta ===');
test('fixtures version matches package', () => {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  // Just check major.minor match
  const fv = vectors.version.split('.').slice(0, 2).join('.');
  const pv = pkg.version.split('.').slice(0, 2).join('.');
  assert.strictEqual(fv, pv, `fixture version ${vectors.version} doesn't match package ${pkg.version}`);
});

test('kind number is 30386', () => {
  assert.strictEqual(vectors.kind, 30386);
});

test('legacy kinds include all known', () => {
  assert(vectors.legacy_kinds.includes(30385));
  assert(vectors.legacy_kinds.includes(30388));
  assert(vectors.legacy_kinds.includes(30078));
});

// === Summary ===
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
