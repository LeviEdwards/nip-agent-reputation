/**
 * Tests for the validation module.
 */

import { validateAttestation, validateHandler, validateBatch } from './validate.js';
import { ATTESTATION_KIND, LEGACY_KINDS, HANDLER_KIND } from './constants.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function test(name, fn) {
  console.log(`  ${name}`);
  fn();
}

// Helper: build a valid attestation event
function validAttestation(overrides = {}) {
  const event = {
    id: 'a'.repeat(64),
    kind: ATTESTATION_KIND,
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
    tags: [
      ['d', 'c'.repeat(66) + ':lightning-node'],
      ['service_type', 'lightning-node'],
      ['node_pubkey', '03' + 'c'.repeat(64)],
      ['p', 'b'.repeat(64)],
      ['attestation_type', 'self'],
      ['dimension', 'payment_success_rate', '0.97', '47'],
      ['dimension', 'capacity_sats', '500000', '1'],
      ['half_life_hours', '720'],
      ['sample_window_hours', '168'],
      ['L', 'agent-reputation'],
      ['l', 'attestation', 'agent-reputation'],
    ],
    content: JSON.stringify({ version: '0.3' }),
    ...overrides,
  };
  return event;
}

function validHandler(overrides = {}) {
  return {
    id: 'd'.repeat(64),
    kind: HANDLER_KIND,
    pubkey: 'e'.repeat(64),
    created_at: Math.floor(Date.now() / 1000) - 3600,
    tags: [
      ['d', 'my-service'],
      ['k', String(ATTESTATION_KIND)],
      ['description', 'A test service'],
      ['L', 'agent-reputation'],
      ['l', 'handler', 'agent-reputation'],
    ],
    content: '',
    ...overrides,
  };
}

// ========== ATTESTATION VALIDATION ==========

console.log('\n=== Attestation Validation ===');

test('valid attestation passes', () => {
  const r = validateAttestation(validAttestation());
  assert(r.valid, 'should be valid');
  assert(r.errors.length === 0, 'no errors');
});

test('null event fails', () => {
  const r = validateAttestation(null);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'INVALID_EVENT'), 'has INVALID_EVENT error');
});

test('string event fails', () => {
  const r = validateAttestation('not an event');
  assert(!r.valid, 'should be invalid');
});

// --- Kind ---

test('wrong kind fails', () => {
  const r = validateAttestation(validAttestation({ kind: 1 }));
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'WRONG_KIND'), 'has WRONG_KIND error');
});

test('legacy kind 30078 passes with info note', () => {
  const r = validateAttestation(validAttestation({ kind: LEGACY_KINDS[0] }));
  assert(r.valid, 'should be valid');
  assert(r.info.some(i => i.code === 'LEGACY_KIND'), 'has LEGACY_KIND info');
});

// --- Pubkey ---

test('missing pubkey fails', () => {
  const r = validateAttestation(validAttestation({ pubkey: undefined }));
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'MISSING_PUBKEY'), 'has MISSING_PUBKEY');
});

test('66-hex pubkey fails', () => {
  const r = validateAttestation(validAttestation({ pubkey: '03' + 'b'.repeat(64) }));
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'INVALID_PUBKEY'), 'has INVALID_PUBKEY');
});

test('uppercase pubkey fails', () => {
  const r = validateAttestation(validAttestation({ pubkey: 'B'.repeat(64) }));
  assert(!r.valid, 'should be invalid');
});

// --- Timestamp ---

test('missing timestamp fails', () => {
  const r = validateAttestation(validAttestation({ created_at: undefined }));
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'MISSING_TIMESTAMP'), 'has MISSING_TIMESTAMP');
});

test('future timestamp beyond tolerance fails', () => {
  const future = Math.floor(Date.now() / 1000) + 600; // 10 min in future
  const r = validateAttestation(validAttestation({ created_at: future }));
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'FUTURE_TIMESTAMP'), 'has FUTURE_TIMESTAMP');
});

test('slight future timestamp warns', () => {
  const future = Math.floor(Date.now() / 1000) + 60; // 1 min in future
  const r = validateAttestation(validAttestation({ created_at: future }));
  assert(r.valid, 'should be valid (within tolerance)');
  assert(r.warnings.some(w => w.code === 'SLIGHT_FUTURE'), 'has SLIGHT_FUTURE warning');
});

test('very old event warns', () => {
  const old = Math.floor(Date.now() / 1000) - 86400 * 400; // 400 days ago
  const r = validateAttestation(validAttestation({ created_at: old }));
  assert(r.valid, 'should be valid');
  assert(r.warnings.some(w => w.code === 'VERY_OLD'), 'has VERY_OLD warning');
});

test('custom maxAgeDays', () => {
  const old = Math.floor(Date.now() / 1000) - 86400 * 40; // 40 days ago
  const r = validateAttestation(validAttestation({ created_at: old }), { maxAgeDays: 30 });
  assert(r.warnings.some(w => w.code === 'VERY_OLD'), 'has VERY_OLD at 40 days with max 30');
});

// --- Tags ---

test('no tags array fails', () => {
  const evt = validAttestation();
  delete evt.tags;
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'MISSING_TAGS'), 'has MISSING_TAGS');
});

// --- d tag ---

test('missing d tag fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => t[0] !== 'd');
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'MISSING_D_TAG'), 'has MISSING_D_TAG');
});

test('d tag without colon warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'd' ? ['d', 'justapubkey'] : t);
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'D_TAG_FORMAT'), 'has D_TAG_FORMAT warning');
});

// --- service_type ---

test('missing service_type fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => t[0] !== 'service_type');
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'MISSING_SERVICE_TYPE'), 'has MISSING_SERVICE_TYPE');
});

test('uppercase service_type warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'service_type' ? ['service_type', 'Lightning-Node'] : t);
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'SERVICE_TYPE_CASE'), 'has SERVICE_TYPE_CASE warning');
});

// --- attestation_type ---

test('missing attestation_type fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => t[0] !== 'attestation_type');
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'MISSING_ATTESTATION_TYPE'), 'has MISSING_ATTESTATION_TYPE');
});

test('unknown attestation_type warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'attestation_type' ? ['attestation_type', 'peer-review'] : t);
  const r = validateAttestation(evt);
  assert(r.valid, 'should be valid (unknown types allowed)');
  assert(r.warnings.some(w => w.code === 'UNKNOWN_ATTESTATION_TYPE'), 'has UNKNOWN_ATTESTATION_TYPE');
});

// --- NIP-32 labels ---

test('missing L tag fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => t[0] !== 'L');
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'MISSING_L_LABEL'), 'has MISSING_L_LABEL');
});

test('missing l attestation label warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => !(t[0] === 'l' && t[1] === 'attestation'));
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'MISSING_L_VALUE'), 'has MISSING_L_VALUE');
});

// --- node_pubkey and p tags ---

test('node_pubkey 64 hex (Nostr pubkey) is valid with note', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'node_pubkey' ? ['node_pubkey', 'f'.repeat(64)] : t);
  const r = validateAttestation(evt);
  assert(r.valid, 'should be valid (64-hex is a Nostr x-only pubkey)');
  assert(r.info.some(e => e.code === 'NODE_PUBKEY_64HEX'), 'has NODE_PUBKEY_64HEX note');
});

test('node_pubkey invalid length fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'node_pubkey' ? ['node_pubkey', 'f'.repeat(50)] : t);
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid (50 hex is neither 64 nor 66)');
  assert(r.errors.some(e => e.code === 'INVALID_NODE_PUBKEY'), 'has INVALID_NODE_PUBKEY');
});

test('p tag with 66-hex LND pubkey fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'p' ? ['p', '03' + 'a'.repeat(64)] : t);
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'P_TAG_NODE_PUBKEY'), 'has P_TAG_NODE_PUBKEY');
});

test('self-attestation with mismatched attester/subject warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'p' ? ['p', 'a'.repeat(64)] : t);
  // pubkey is 'b'.repeat(64), p tag is 'a'.repeat(64)
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'SELF_MISMATCH'), 'has SELF_MISMATCH warning');
});

test('bilateral with same attester/subject warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => {
    if (t[0] === 'attestation_type') return ['attestation_type', 'bilateral'];
    return t;
  });
  // pubkey === p tag (both 'b'.repeat(64))
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'BILATERAL_SELF'), 'has BILATERAL_SELF warning');
});

// --- Dimension tags ---

test('no dimensions fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => t[0] !== 'dimension');
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'NO_DIMENSIONS'), 'has NO_DIMENSIONS');
});

test('dimension with no name fails', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', '', '0.5', '10']);
  const r = validateAttestation(evt);
  assert(r.errors.some(e => e.code === 'DIM_NO_NAME'), 'has DIM_NO_NAME');
});

test('dimension with NaN value fails', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'test_dim', 'not-a-number', '10']);
  const r = validateAttestation(evt);
  assert(r.errors.some(e => e.code === 'DIM_VALUE_NAN'), 'has DIM_VALUE_NAN');
});

test('dimension missing value fails', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'test_dim']);
  const r = validateAttestation(evt);
  assert(r.errors.some(e => e.code === 'DIM_NO_VALUE'), 'has DIM_NO_VALUE');
});

test('rate dimension out of range warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => {
    if (t[0] === 'dimension' && t[1] === 'payment_success_rate') {
      return ['dimension', 'payment_success_rate', '1.5', '47']; // > 1.0
    }
    return t;
  });
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'DIM_OUT_OF_RANGE'), 'has DIM_OUT_OF_RANGE for rate > 1.0');
});

test('negative rate dimension warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => {
    if (t[0] === 'dimension' && t[1] === 'payment_success_rate') {
      return ['dimension', 'payment_success_rate', '-0.1', '47'];
    }
    return t;
  });
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'DIM_OUT_OF_RANGE'), 'has DIM_OUT_OF_RANGE for rate < 0');
});

test('uptime > 100 warns', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'uptime_percent', '105.0', '1']);
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'DIM_OUT_OF_RANGE'), 'has DIM_OUT_OF_RANGE for uptime > 100');
});

test('negative capacity warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => {
    if (t[0] === 'dimension' && t[1] === 'capacity_sats') {
      return ['dimension', 'capacity_sats', '-1000', '1'];
    }
    return t;
  });
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'DIM_NEGATIVE'), 'has DIM_NEGATIVE');
});

test('duplicate dimension warns', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'payment_success_rate', '0.95', '10']);
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'DIM_DUPLICATE'), 'has DIM_DUPLICATE');
});

test('zero sample_size noted', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'dispute_rate', '0.01', '0']);
  const r = validateAttestation(evt);
  assert(r.info.some(i => i.code === 'DIM_ZERO_SAMPLE'), 'has DIM_ZERO_SAMPLE info');
});

test('low sample_size noted', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => {
    if (t[0] === 'dimension' && t[1] === 'payment_success_rate') {
      return ['dimension', 'payment_success_rate', '0.97', '2']; // min is 5
    }
    return t;
  });
  const r = validateAttestation(evt);
  assert(r.info.some(i => i.code === 'DIM_LOW_SAMPLE'), 'has DIM_LOW_SAMPLE info');
});

test('missing sample_size warns', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'response_time_ms', '1200']);
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'DIM_NO_SAMPLE'), 'has DIM_NO_SAMPLE');
});

test('negative sample_size fails', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'response_time_ms', '1200', '-5']);
  const r = validateAttestation(evt);
  assert(r.errors.some(e => e.code === 'DIM_SAMPLE_INVALID'), 'has DIM_SAMPLE_INVALID');
});

test('custom dimension noted', () => {
  const evt = validAttestation();
  evt.tags.push(['dimension', 'my_custom_metric', '42', '10']);
  const r = validateAttestation(evt);
  assert(r.info.some(i => i.code === 'CUSTOM_DIMENSION'), 'has CUSTOM_DIMENSION info');
});

// --- Half-life ---

test('missing half_life warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => t[0] !== 'half_life_hours');
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'MISSING_HALF_LIFE'), 'has MISSING_HALF_LIFE');
});

test('negative half_life fails', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'half_life_hours' ? ['half_life_hours', '-100'] : t);
  const r = validateAttestation(evt);
  assert(!r.valid, 'should be invalid');
  assert(r.errors.some(e => e.code === 'INVALID_HALF_LIFE'), 'has INVALID_HALF_LIFE');
});

test('very short half_life warns', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.map(t => t[0] === 'half_life_hours' ? ['half_life_hours', '12'] : t);
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'SHORT_HALF_LIFE'), 'has SHORT_HALF_LIFE');
});

// --- Content ---

test('non-JSON content warns', () => {
  const evt = validAttestation();
  evt.content = 'just plain text';
  const r = validateAttestation(evt);
  assert(r.warnings.some(w => w.code === 'CONTENT_NOT_JSON'), 'has CONTENT_NOT_JSON');
});

test('empty content is fine', () => {
  const evt = validAttestation();
  evt.content = '';
  const r = validateAttestation(evt);
  assert(!r.warnings.some(w => w.code === 'CONTENT_NOT_JSON'), 'no CONTENT_NOT_JSON');
});

// --- Strict mode ---

test('strict mode promotes warnings to errors', () => {
  const evt = validAttestation();
  evt.tags = evt.tags.filter(t => t[0] !== 'half_life_hours'); // generates a warning
  const r = validateAttestation(evt, { strict: true });
  assert(!r.valid, 'should be invalid in strict mode');
  assert(r.errors.some(e => e.code === 'MISSING_HALF_LIFE'), 'warning promoted to error');
  assert(r.warnings.length === 0, 'no warnings left');
});

// ========== HANDLER VALIDATION ==========

console.log('\n=== Handler Validation ===');

test('valid handler passes', () => {
  const r = validateHandler(validHandler());
  assert(r.valid, 'should be valid');
  assert(r.errors.length === 0, 'no errors');
});

test('wrong kind fails', () => {
  const r = validateHandler(validHandler({ kind: 1 }));
  assert(!r.valid, 'should be invalid');
});

test('missing d tag fails', () => {
  const evt = validHandler();
  evt.tags = evt.tags.filter(t => t[0] !== 'd');
  const r = validateHandler(evt);
  assert(!r.valid, 'should be invalid');
});

test('missing k tag warns', () => {
  const evt = validHandler();
  evt.tags = evt.tags.filter(t => t[0] !== 'k');
  const r = validateHandler(evt);
  assert(r.valid, 'should be valid');
  assert(r.warnings.some(w => w.code === 'MISSING_K_TAG'), 'has MISSING_K_TAG');
});

test('missing description warns', () => {
  const evt = validHandler();
  evt.tags = evt.tags.filter(t => t[0] !== 'description');
  const r = validateHandler(evt);
  assert(r.warnings.some(w => w.code === 'MISSING_DESCRIPTION'), 'has MISSING_DESCRIPTION');
});

test('missing L label warns', () => {
  const evt = validHandler();
  evt.tags = evt.tags.filter(t => t[0] !== 'L');
  const r = validateHandler(evt);
  assert(r.warnings.some(w => w.code === 'MISSING_L_LABEL'), 'has MISSING_L_LABEL');
});

test('non-standard k tag noted', () => {
  const evt = validHandler();
  evt.tags = evt.tags.map(t => t[0] === 'k' ? ['k', '9999'] : t);
  const r = validateHandler(evt);
  assert(r.info.some(i => i.code === 'NONSTANDARD_K'), 'has NONSTANDARD_K');
});

// ========== BATCH VALIDATION ==========

console.log('\n=== Batch Validation ===');

test('batch with mixed events', () => {
  const events = [
    validAttestation(),
    validHandler(),
    validAttestation({ kind: 1 }), // invalid
  ];
  const { results, summary } = validateBatch(events);
  assert(results.length === 3, 'has 3 results');
  assert(summary.valid === 2, '2 valid');
  assert(summary.invalid === 1, '1 invalid');
  assert(summary.total === 3, 'total 3');
  assert(summary.totalErrors >= 1, 'at least 1 error');
});

test('empty batch', () => {
  const { results, summary } = validateBatch([]);
  assert(results.length === 0, 'empty results');
  assert(summary.total === 0, 'total 0');
  assert(summary.valid === 0, 'valid 0');
});

// ========== RESULTS ==========

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
