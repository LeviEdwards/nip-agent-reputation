/**
 * Validation module for NIP Agent Reputation attestation events.
 * 
 * Validates that attestation events (kind 30386/30078) conform to the spec
 * before they're processed by the aggregation pipeline. Returns structured
 * validation results with severity levels (error/warning/info).
 * 
 * Usage:
 *   import { validateAttestation, validateHandler } from './validate.js';
 *   const result = validateAttestation(event);
 *   if (!result.valid) console.error(result.errors);
 */

import { ATTESTATION_KIND, LEGACY_KINDS, HANDLER_KIND } from './constants.js';

// Known attestation types and their expected weights
const VALID_ATTESTATION_TYPES = ['self', 'bilateral', 'observer'];

// Standard dimensions from the spec
const STANDARD_DIMENSIONS = new Set([
  'payment_success_rate',
  'response_time_ms',
  'settlement_rate',
  'uptime_percent',
  'dispute_rate',
  'capacity_sats',
  'transaction_volume_sats',
]);

// Dimensions that should be in 0.0-1.0 range
const RATE_DIMENSIONS = new Set([
  'payment_success_rate',
  'settlement_rate',
  'dispute_rate',
]);

// Dimensions that should be in 0.0-100.0 range
const PERCENT_DIMENSIONS = new Set([
  'uptime_percent',
]);

// Minimum sample sizes per spec
const MIN_SAMPLE_SIZES = {
  payment_success_rate: 5,
  settlement_rate: 5,
  response_time_ms: 3,
  uptime_percent: 1,
  dispute_rate: 5,
  capacity_sats: 1,
  transaction_volume_sats: 1,
};

/**
 * Validation result builder.
 */
class ValidationResult {
  constructor() {
    this.errors = [];   // MUST-level violations — event should be rejected
    this.warnings = []; // SHOULD-level issues — event is processable but suspicious
    this.info = [];     // Informational notes — non-standard but allowed
  }

  error(code, message) {
    this.errors.push({ code, message });
  }

  warn(code, message) {
    this.warnings.push({ code, message });
  }

  note(code, message) {
    this.info.push({ code, message });
  }

  get valid() {
    return this.errors.length === 0;
  }

  toJSON() {
    return {
      valid: this.valid,
      errors: this.errors,
      warnings: this.warnings,
      info: this.info,
    };
  }
}

/**
 * Get all values for a tag name from an event's tags array.
 */
function getTags(tags, name) {
  return tags.filter(t => t[0] === name);
}

/**
 * Get the first matching tag value.
 */
function getTag(tags, name) {
  const tag = tags.find(t => t[0] === name);
  return tag ? tag[1] : null;
}

/**
 * Validate a kind 30386 (or legacy 30078) attestation event.
 * 
 * @param {Object} event - Raw Nostr event object
 * @param {Object} opts - Validation options
 * @param {number} opts.maxAgeDays - Flag events older than this (default: 365)
 * @param {number} opts.maxFutureSeconds - Max allowed future timestamp (default: 300 = 5 min clock skew)
 * @param {boolean} opts.strict - If true, warnings become errors (default: false)
 * @returns {ValidationResult}
 */
export function validateAttestation(event, opts = {}) {
  const result = new ValidationResult();
  const maxAgeDays = opts.maxAgeDays || 365;
  const maxFutureSeconds = opts.maxFutureSeconds || 300;
  const strict = opts.strict || false;

  // --- Event structure ---

  if (!event || typeof event !== 'object') {
    result.error('INVALID_EVENT', 'Event is not an object');
    return result;
  }

  // Kind check
  if (event.kind !== ATTESTATION_KIND && !LEGACY_KINDS.includes(event.kind)) {
    result.error('WRONG_KIND', `Expected kind ${ATTESTATION_KIND} or legacy kind, , got ${event.kind}`);
  }

  if (LEGACY_KINDS.includes(event.kind)) {
    result.note('LEGACY_KIND', `Using legacy kind ${event.kind}; should migrate to ${ATTESTATION_KIND}`);
  }

  // Pubkey (attester)
  if (!event.pubkey || typeof event.pubkey !== 'string') {
    result.error('MISSING_PUBKEY', 'Event missing pubkey (attester identity)');
  } else if (event.pubkey.length !== 64 || !/^[0-9a-f]{64}$/.test(event.pubkey)) {
    result.error('INVALID_PUBKEY', `Event pubkey must be 64 hex chars, got ${event.pubkey.length}`);
  }

  // Timestamp
  if (!event.created_at || typeof event.created_at !== 'number') {
    result.error('MISSING_TIMESTAMP', 'Event missing created_at timestamp');
  } else {
    const now = Math.floor(Date.now() / 1000);
    const ageDays = (now - event.created_at) / 86400;

    if (event.created_at > now + maxFutureSeconds) {
      result.error('FUTURE_TIMESTAMP', `Event timestamp is ${event.created_at - now}s in the future (max allowed: ${maxFutureSeconds}s)`);
    } else if (event.created_at > now) {
      result.warn('SLIGHT_FUTURE', `Event timestamp is ${event.created_at - now}s in the future (within tolerance)`);
    }

    if (ageDays > maxAgeDays) {
      result.warn('VERY_OLD', `Event is ${Math.round(ageDays)} days old (max recommended: ${maxAgeDays})`);
    }
  }

  // Tags array
  if (!Array.isArray(event.tags)) {
    result.error('MISSING_TAGS', 'Event has no tags array');
    return result; // Can't validate further without tags
  }

  const tags = event.tags;

  // --- Required tags ---

  // d tag (parameterized replaceable event identifier)
  const dTag = getTag(tags, 'd');
  if (!dTag) {
    result.error('MISSING_D_TAG', 'Missing d tag (required for parameterized replaceable events)');
  } else {
    const parts = dTag.split(':');
    if (parts.length < 2) {
      result.warn('D_TAG_FORMAT', `d tag should be "<pubkey>:<service_type>", got "${dTag}"`);
    }
  }

  // service_type tag
  const serviceType = getTag(tags, 'service_type');
  if (!serviceType) {
    result.error('MISSING_SERVICE_TYPE', 'Missing service_type tag');
  } else if (serviceType !== serviceType.toLowerCase()) {
    result.warn('SERVICE_TYPE_CASE', `Service type should be lowercase: "${serviceType}"`);
  }

  // attestation_type tag
  const attType = getTag(tags, 'attestation_type');
  if (!attType) {
    result.error('MISSING_ATTESTATION_TYPE', 'Missing attestation_type tag');
  } else if (!VALID_ATTESTATION_TYPES.includes(attType)) {
    result.warn('UNKNOWN_ATTESTATION_TYPE', `Unknown attestation_type "${attType}"; expected one of: ${VALID_ATTESTATION_TYPES.join(', ')}`);
  }

  // NIP-32 labels
  const lLabel = getTag(tags, 'L');
  if (lLabel !== 'agent-reputation') {
    result.error('MISSING_L_LABEL', 'Missing L tag with value "agent-reputation" (NIP-32 label namespace)');
  }
  const lValues = getTags(tags, 'l');
  const hasAttestationLabel = lValues.some(t => t[1] === 'attestation' && t[2] === 'agent-reputation');
  if (!hasAttestationLabel) {
    result.warn('MISSING_L_VALUE', 'Missing l tag ["l", "attestation", "agent-reputation"] (NIP-32 label)');
  }

  // --- Pubkey tags ---

  // node_pubkey tag (66-hex LN compressed pubkey or 64-hex Nostr/secp256k1 pubkey)
  const nodePubkey = getTag(tags, 'node_pubkey');
  if (nodePubkey) {
    if (nodePubkey.length === 66 && /^[0-9a-f]{66}$/.test(nodePubkey)) {
      // Valid 33-byte compressed secp256k1 (Lightning node pubkey)
    } else if (nodePubkey.length === 64 && /^[0-9a-f]{64}$/.test(nodePubkey)) {
      // Valid 32-byte x-only pubkey (Nostr pubkey, used for non-LN services)
      result.note('NODE_PUBKEY_64HEX', 'node_pubkey is 64-hex (Nostr x-only pubkey); 66-hex preferred for Lightning nodes');
    } else {
      result.error('INVALID_NODE_PUBKEY', `node_pubkey must be 64 or 66 hex chars, got ${nodePubkey.length}`);
    }
  }

  // p tag (Nostr 32-byte x-only pubkey)
  const pTags = getTags(tags, 'p');
  for (const pTag of pTags) {
    const pVal = pTag[1];
    if (!pVal) continue;
    if (pVal.length === 66) {
      result.error('P_TAG_NODE_PUBKEY', `p tag contains 66-hex LND node pubkey — use node_pubkey tag instead. p tag MUST be 64-hex Nostr pubkey`);
    } else if (pVal.length !== 64 || !/^[0-9a-f]{64}$/.test(pVal)) {
      result.error('INVALID_P_TAG', `p tag must be 64 hex chars (32-byte x-only pubkey), got ${pVal.length}`);
    }
  }

  // Cross-check: self-attestation should have attester == subject
  if (attType === 'self' && event.pubkey && pTags.length > 0) {
    const subjectPubkey = pTags[0][1];
    if (subjectPubkey && subjectPubkey !== event.pubkey) {
      result.warn('SELF_MISMATCH', `Self-attestation but attester pubkey (${event.pubkey.slice(0, 8)}...) differs from subject p tag (${subjectPubkey.slice(0, 8)}...)`);
    }
  }

  // Cross-check: bilateral should have attester != subject
  if (attType === 'bilateral' && event.pubkey && pTags.length > 0) {
    const subjectPubkey = pTags[0][1];
    if (subjectPubkey && subjectPubkey === event.pubkey) {
      result.warn('BILATERAL_SELF', 'Bilateral attestation but attester == subject — this should be type "self"');
    }
  }

  // --- Dimension tags ---

  const dimensions = getTags(tags, 'dimension');
  if (dimensions.length === 0) {
    result.error('NO_DIMENSIONS', 'Attestation has no dimension tags — no reputation data to process');
  }

  const seenDimensions = new Set();
  for (const dim of dimensions) {
    const name = dim[1];
    const valueStr = dim[2];
    const sampleStr = dim[3];

    if (!name) {
      result.error('DIM_NO_NAME', 'Dimension tag missing name (index 1)');
      continue;
    }

    // Duplicate check
    if (seenDimensions.has(name)) {
      result.warn('DIM_DUPLICATE', `Duplicate dimension "${name}" — last value wins in most parsers`);
    }
    seenDimensions.add(name);

    // Value check
    if (valueStr === undefined || valueStr === '') {
      result.error('DIM_NO_VALUE', `Dimension "${name}" missing value (index 2)`);
      continue;
    }
    const value = parseFloat(valueStr);
    if (isNaN(value)) {
      result.error('DIM_VALUE_NAN', `Dimension "${name}" value "${valueStr}" is not a valid number`);
      continue;
    }

    // Range checks for known dimensions
    if (RATE_DIMENSIONS.has(name)) {
      if (value < 0 || value > 1.0) {
        result.warn('DIM_OUT_OF_RANGE', `Dimension "${name}" value ${value} outside expected range [0.0, 1.0]`);
      }
    }
    if (PERCENT_DIMENSIONS.has(name)) {
      if (value < 0 || value > 100.0) {
        result.warn('DIM_OUT_OF_RANGE', `Dimension "${name}" value ${value} outside expected range [0.0, 100.0]`);
      }
    }
    if (name === 'capacity_sats' || name === 'transaction_volume_sats') {
      if (value < 0) {
        result.warn('DIM_NEGATIVE', `Dimension "${name}" has negative value ${value}`);
      }
    }

    // Sample size check
    if (sampleStr === undefined || sampleStr === '') {
      result.warn('DIM_NO_SAMPLE', `Dimension "${name}" missing sample_size (index 3) — defaults to 0`);
    } else {
      const sample = parseInt(sampleStr);
      if (isNaN(sample) || sample < 0) {
        result.error('DIM_SAMPLE_INVALID', `Dimension "${name}" sample_size "${sampleStr}" is not a valid non-negative integer`);
      } else if (sample === 0) {
        result.note('DIM_ZERO_SAMPLE', `Dimension "${name}" has sample_size 0 — queriers MUST ignore`);
      } else {
        const min = MIN_SAMPLE_SIZES[name];
        if (min && sample < min) {
          result.note('DIM_LOW_SAMPLE', `Dimension "${name}" sample_size ${sample} below recommended minimum ${min}`);
        }
      }
    }

    // Non-standard dimension
    if (!STANDARD_DIMENSIONS.has(name)) {
      result.note('CUSTOM_DIMENSION', `Non-standard dimension "${name}" — queriers may ignore`);
    }
  }

  // --- Half-life ---

  const halfLife = getTag(tags, 'half_life_hours');
  if (!halfLife) {
    result.warn('MISSING_HALF_LIFE', 'Missing half_life_hours tag — queriers will assume default 720h');
  } else {
    const hl = parseFloat(halfLife);
    if (isNaN(hl) || hl <= 0) {
      result.error('INVALID_HALF_LIFE', `half_life_hours "${halfLife}" must be a positive number`);
    } else if (hl < 24) {
      result.warn('SHORT_HALF_LIFE', `half_life_hours ${hl} is very short — attestation decays to <1% in ~${Math.round(hl * 7 / 24)} days`);
    }
  }

  // --- Content ---

  if (event.content) {
    try {
      JSON.parse(event.content);
    } catch {
      result.warn('CONTENT_NOT_JSON', 'Content is not valid JSON — spec recommends JSON content');
    }
  }

  // --- Promote warnings to errors in strict mode ---

  if (strict) {
    for (const w of result.warnings) {
      result.errors.push(w);
    }
    result.warnings = [];
  }

  return result;
}

/**
 * Validate a kind 31990 handler declaration event.
 * 
 * @param {Object} event - Raw Nostr event object
 * @returns {ValidationResult}
 */
export function validateHandler(event, opts = {}) {
  const result = new ValidationResult();

  if (!event || typeof event !== 'object') {
    result.error('INVALID_EVENT', 'Event is not an object');
    return result;
  }

  if (event.kind !== HANDLER_KIND) {
    result.error('WRONG_KIND', `Expected kind ${HANDLER_KIND}, got ${event.kind}`);
  }

  if (!Array.isArray(event.tags)) {
    result.error('MISSING_TAGS', 'Event has no tags array');
    return result;
  }

  const tags = event.tags;

  // d tag
  if (!getTag(tags, 'd')) {
    result.error('MISSING_D_TAG', 'Missing d tag (service identifier)');
  }

  // k tag should reference attestation kind
  const kTag = getTag(tags, 'k');
  if (!kTag) {
    result.warn('MISSING_K_TAG', 'Missing k tag (NIP-89 handler kind reference)');
  } else if (kTag !== String(ATTESTATION_KIND) && !LEGACY_KINDS.map(String).includes(kTag)) {
    result.note('NONSTANDARD_K', `k tag references kind ${kTag}; expected ${ATTESTATION_KIND}`);
  }

  // NIP-32 labels
  const lLabel = getTag(tags, 'L');
  if (lLabel !== 'agent-reputation') {
    result.warn('MISSING_L_LABEL', 'Missing L tag with value "agent-reputation"');
  }

  // Description
  if (!getTag(tags, 'description')) {
    result.warn('MISSING_DESCRIPTION', 'Missing description tag — service should describe itself');
  }

  return result;
}

/**
 * Validate a batch of events. Returns per-event results plus summary.
 * 
 * @param {Object[]} events - Array of Nostr events
 * @param {Object} opts - Validation options (passed to validateAttestation)
 * @returns {{ results: ValidationResult[], summary: Object }}
 */
export function validateBatch(events, opts = {}) {
  const results = events.map(e => {
    const kind = e?.kind;
    if (kind === HANDLER_KIND) {
      return { event: e, validation: validateHandler(e, opts) };
    } else {
      return { event: e, validation: validateAttestation(e, opts) };
    }
  });

  const valid = results.filter(r => r.validation.valid).length;
  const invalid = results.length - valid;
  const totalErrors = results.reduce((s, r) => s + r.validation.errors.length, 0);
  const totalWarnings = results.reduce((s, r) => s + r.validation.warnings.length, 0);

  return {
    results,
    summary: {
      total: results.length,
      valid,
      invalid,
      totalErrors,
      totalWarnings,
    },
  };
}
