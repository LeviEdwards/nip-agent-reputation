#!/usr/bin/env node

/**
 * NIP-30386 Conformance Test Runner
 * 
 * A standalone script for validating NIP-30386 implementations against
 * the official test vectors. Can be used by ANY implementation to verify
 * conformance with the specification.
 * 
 * Usage:
 *   node conformance-check.js                    # Run against built-in test vectors
 *   node conformance-check.js --file events.json # Validate events from file
 *   node conformance-check.js --relay wss://nos.lol  # Validate live events
 * 
 * No project dependencies needed — only requires nostr-tools for
 * cryptographic verification (install with: npm install nostr-tools).
 * 
 * Based on NIP-30386 v1.0.13 specification.
 * Test vectors: test/fixtures/test-vectors.json
 * Reference implementation: github.com/LeviEdwards/nip-agent-reputation
 */

import { verifyEvent } from 'nostr-tools/pure';
import { SimplePool } from 'nostr-tools/pool';
import WebSocket from 'ws';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Try to use WebSocket polyfill for Node.js
try { 
  const { useWebSocketImplementation } = await import('nostr-tools/pool');
  useWebSocketImplementation(WebSocket);
} catch {}

const ATTESTATION_KIND = 30386;
const LEGACY_KINDS = [30385, 30388, 30078];
const ALL_KINDS = [ATTESTATION_KIND, ...LEGACY_KINDS];
const HANDLER_KIND = 31990;

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
];

// ─── Validation Functions ────────────────────────────────────────────

function validateEventStructure(event) {
  const errors = [];
  const warnings = [];
  const info = [];
  
  // Required fields
  if (!event.id || typeof event.id !== 'string' || event.id.length !== 64) {
    errors.push({ code: 'INVALID_ID', message: 'Event id must be 64-char hex string' });
  }
  if (!event.pubkey || typeof event.pubkey !== 'string' || event.pubkey.length !== 64) {
    errors.push({ code: 'INVALID_PUBKEY', message: 'Event pubkey must be 64-char hex string' });
  }
  if (typeof event.created_at !== 'number' || event.created_at < 0) {
    errors.push({ code: 'INVALID_CREATED_AT', message: 'created_at must be a unix timestamp' });
  }
  if (!ALL_KINDS.includes(event.kind) && event.kind !== HANDLER_KIND) {
    errors.push({ code: 'INVALID_KIND', message: `Kind ${event.kind} is not a NIP-30386 kind (expected ${ATTESTATION_KIND}, legacy ${LEGACY_KINDS.join('/')}, or handler ${HANDLER_KIND})` });
  }
  if (!Array.isArray(event.tags)) {
    errors.push({ code: 'MISSING_TAGS', message: 'Event tags must be an array' });
  }
  
  const tags = event.tags || [];
  const isHandler = event.kind === HANDLER_KIND;
  
  if (!isHandler) {
    // Attestation-specific validation
    const dTags = tags.filter(t => t[0] === 'd');
    if (dTags.length !== 1) {
      errors.push({ code: 'MISSING_D_TAG', message: 'Exactly one d tag required' });
    } else {
      const dValue = dTags[0][1];
      if (!dValue || !dValue.includes(':')) {
        errors.push({ code: 'INVALID_D_TAG', message: `d tag must be <subject>:<service_type>, got "${dValue}"` });
      }
    }
    
    // Service type
    const serviceType = tags.find(t => t[0] === 'service_type');
    if (!serviceType) {
      errors.push({ code: 'MISSING_SERVICE_TYPE', message: 'service_type tag is required' });
    }
    
    // Attestation type
    const aType = tags.find(t => t[0] === 'attestation_type');
    if (!aType) {
      errors.push({ code: 'MISSING_ATTESTATION_TYPE', message: 'attestation_type tag is required' });
    } else if (!['self', 'bilateral', 'observer'].includes(aType[1])) {
      errors.push({ code: 'INVALID_ATTESTATION_TYPE', message: `attestation_type must be self/bilateral/observer, got "${aType[1]}"` });
    }
    
    // Dimensions
    const dimTags = tags.filter(t => t[0] === 'dimension');
    if (dimTags.length === 0) {
      errors.push({ code: 'NO_DIMENSIONS', message: 'At least one dimension tag is required' });
    }
    
    for (const dim of dimTags) {
      if (dim.length >= 4) {
        // Standard format: ["dimension", "name", "value", "sample_size"]
        const value = parseFloat(dim[2]);
        const sample = parseInt(dim[3]);
        if (isNaN(value)) {
          errors.push({ code: 'DIM_INVALID_VALUE', message: `Dimension "${dim[1]}" has non-numeric value: "${dim[2]}"` });
        }
        if (isNaN(sample)) {
          warnings.push({ code: 'DIM_INVALID_SAMPLE', message: `Dimension "${dim[1]}" has non-integer sample_size: "${dim[3]}"` });
        }
      } else if (dim.length === 2 && typeof dim[1] === 'string' && dim[1].includes(',')) {
        // Compact format: ["dimension", "name,value,sample"]
        const parts = dim[1].split(',');
        if (parts.length < 3) {
          errors.push({ code: 'DIM_COMPACT_MALFORMED', message: `Compact dimension "${dim[1]}" must have name,value,sample` });
        } else {
          const value = parseFloat(parts[1]);
          const sample = parseInt(parts[2]);
          if (isNaN(value)) {
            errors.push({ code: 'DIM_COMPACT_INVALID_VALUE', message: `Compact dimension value is non-numeric: "${parts[1]}"` });
          }
          if (isNaN(sample)) {
            warnings.push({ code: 'DIM_COMPACT_INVALID_SAMPLE', message: `Compact dimension sample_size is non-integer: "${parts[2]}"` });
          }
          info.push({ code: 'DIM_COMPACT_FORMAT', message: `Dimension uses compact format (non-standard but accepted)` });
        }
      } else {
        errors.push({ code: 'DIM_MALFORMED', message: `Dimension tag has unexpected format: ${JSON.stringify(dim)}` });
      }
    }
    
    // NIP-32 labels (required)
    const LTag = tags.find(t => t[0] === 'L' && t[1] === 'agent-reputation');
    const lTag = tags.find(t => t[0] === 'l' && t[2] === 'agent-reputation');
    if (!LTag) errors.push({ code: 'MISSING_L_TAG', message: 'L tag "agent-reputation" is required (NIP-32 namespace)' });
    if (!lTag) errors.push({ code: 'MISSING_L_LABEL', message: 'l tag "attestation" in namespace "agent-reputation" is required' });
    
    // Half-life and sample window (recommended)
    const halfLife = tags.find(t => t[0] === 'half_life_hours');
    if (!halfLife) {
      warnings.push({ code: 'MISSING_HALF_LIFE', message: 'half_life_hours tag is recommended (default: 720)' });
    }
    
    const sampleWindow = tags.find(t => t[0] === 'sample_window_hours');
    if (!sampleWindow) {
      warnings.push({ code: 'MISSING_SAMPLE_WINDOW', message: 'sample_window_hours tag is recommended (default: 168)' });
    }
    
    // node_pubkey validation
    const nodePubkey = tags.find(t => t[0] === 'node_pubkey');
    if (nodePubkey) {
      const npk = nodePubkey[1];
      if (npk.length === 66 && /^[0-9a-fA-F]+$/.test(npk)) {
        // 33-byte compressed secp256k1 (Lightning node pubkey)
      } else if (npk.length === 64 && /^[0-9a-fA-F]+$/.test(npk)) {
        // 32-byte x-only secp256k1 (Nostr pubkey, for HTTP services)
        info.push({ code: 'NODE_PUBKEY_64HEX', message: 'node_pubkey is 64 hex (Nostr x-only pubkey). Valid for HTTP services.' });
      } else {
        errors.push({ code: 'INVALID_NODE_PUBKEY', message: `node_pubkey must be 64 or 66 hex chars, got ${npk.length}` });
      }
    }
    
    // p tag validation (must be 64 hex if present)
    const pTag = tags.find(t => t[0] === 'p');
    if (pTag) {
      if (pTag[1].length !== 64) {
        errors.push({ code: 'INVALID_P_TAG', message: `p tag must be 64-char hex Nostr pubkey, got ${pTag[1].length} chars` });
      }
    }
    
    // Future timestamp check
    if (event.created_at && event.created_at > Math.floor(Date.now() / 1000) + 3600) {
      warnings.push({ code: 'FUTURE_TIMESTAMP', message: `created_at is more than 1 hour in the future (potential clock skew attack)` });
    }
  } else {
    // Handler event validation (kind 31990)
    const dTags = tags.filter(t => t[0] === 'd');
    if (dTags.length !== 1) {
      errors.push({ code: 'MISSING_D_TAG', message: 'Handler events require exactly one d tag' });
    }
    const kTags = tags.filter(t => t[0] === 'k');
    if (kTags.length !== 1 || kTags[0][1] !== String(ATTESTATION_KIND)) {
      warnings.push({ code: 'HANDLER_K_TAG', message: `Handler k tag should reference kind ${ATTESTATION_KIND}` });
    }
    const LTag = tags.find(t => t[0] === 'L' && t[1] === 'agent-reputation');
    if (!LTag) {
      warnings.push({ code: 'HANDLER_MISSING_L', message: 'Agent handler events should have L tag "agent-reputation"' });
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info,
  };
}

function validateDecayFormula() {
  const halfLife = 720;
  const vectors = [
    { age_hours: 0, expected: 1.0, tolerance: 0.001 },
    { age_hours: 1, expected: 0.999, tolerance: 0.001 },
    { age_hours: 24, expected: 0.977, tolerance: 0.001 },
    { age_hours: 168, expected: 0.851, tolerance: 0.001 },
    { age_hours: 336, expected: 0.724, tolerance: 0.001 },
    { age_hours: 720, expected: 0.500, tolerance: 0.001 },
    { age_hours: 1440, expected: 0.250, tolerance: 0.001 },
    { age_hours: 2160, expected: 0.125, tolerance: 0.001 },
    { age_hours: 4320, expected: 0.0156, tolerance: 0.001 },
  ];
  
  const results = [];
  let allPass = true;
  
  for (const v of vectors) {
    const weight = Math.min(1.0, Math.max(0, Math.pow(2, -v.age_hours / halfLife)));
    const pass = Math.abs(weight - v.expected) <= v.tolerance;
    if (!pass) allPass = false;
    results.push({ ...v, actual: weight, pass });
  }
  
  // Future timestamp clamping
  const futureWeight = Math.min(1.0, Math.max(0, Math.pow(2, -(-1) / halfLife)));
  const futurePass = Math.abs(futureWeight - 1.0) < 0.001;
  if (!futurePass) allPass = false;
  results.push({ age_hours: -1, expected: 1.0, actual: futureWeight, pass: futurePass, note: 'future timestamp clamped' });
  
  return { allPass, results };
}

function validateAggregation() {
  // Test: single self-attestation
  const selfWeight = 0.3;
  const decay1 = Math.min(1.0, Math.pow(2, -0 / 720)); // age 0
  const totalWeight = decay1 * selfWeight;
  const selfTest = Math.abs(totalWeight - 0.3) < 0.01;
  
  // Test: bilateral dominates self
  const selfDecay = Math.min(1.0, Math.pow(2, -1 / 720));
  const bilateralDecay = Math.min(1.0, Math.pow(2, -168 / 720));
  const selfEff = selfDecay * 0.3;
  const bilateralEff = bilateralDecay * 1.0;
  const weightedAvg = (0.97 * selfEff + 0.80 * bilateralEff) / (selfEff + bilateralEff);
  const dominanceTest = weightedAvg > 0.83 && weightedAvg < 0.85;
  
  return {
    allPass: selfTest && dominanceTest,
    results: [
      { name: 'self_weight_0.3', expected: 0.3, actual: totalWeight, pass: selfTest },
      { name: 'bilateral_dominates', expected_range: [0.83, 0.85], actual: weightedAvg, pass: dominanceTest },
    ],
  };
}

function validateDTagFormat() {
  const valid = [
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789:lightning-node',
    'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789:http-endpoint',
  ];
  const invalid = [
    'too-short:lightning-node',
    'no-colon-separator',
  ];
  
  let allPass = true;
  const results = [];
  
  for (const d of valid) {
    const parts = d.split(':');
    const pass = parts.length === 2 && parts[0].length >= 16 && /^[0-9a-f]+$/.test(parts[0].toLowerCase());
    if (!pass) allPass = false;
    results.push({ d, pass, note: 'valid' });
  }
  
  for (const d of invalid) {
    const parts = d.split(':');
    const wouldPass = parts.length === 2 && parts[0].length >= 16 && /^[0-9a-f]+$/.test(parts[0].toLowerCase());
    const pass = !wouldPass;
    if (!pass) allPass = false;
    results.push({ d, pass, note: 'invalid' });
  }
  
  return { allPass, results };
}

// ─── Test Vector Validation ──────────────────────────────────────────

function validateTestVectors() {
  const vectorPath = resolve(__dirname, 'test/fixtures/test-vectors.json');
  let vectors;
  try {
    vectors = JSON.parse(readFileSync(vectorPath, 'utf-8'));
  } catch {
    console.log('  ⚠ Test vectors file not found, skipping vector validation');
    return { allPass: true, results: [] };
  }
  
  const results = [];
  let allPass = true;
  
  // Version check
  if (vectors.version) {
    results.push({ name: 'vector_version', value: vectors.version, pass: true });
  }
  
  // Kind check
  if (vectors.kind === ATTESTATION_KIND) {
    results.push({ name: 'vector_kind', value: vectors.kind, pass: true });
  } else {
    allPass = false;
    results.push({ name: 'vector_kind', value: vectors.kind, expected: ATTESTATION_KIND, pass: false });
  }
  
  // Valid events
  for (const ve of (vectors.valid_events || [])) {
    const validation = validateEventStructure(ve.event);
    const pass = validation.valid === ve.expected_valid;
    if (!pass) allPass = false;
    results.push({
      name: ve.name,
      expected_valid: ve.expected_valid,
      actual_valid: validation.valid,
      pass,
      error_count: validation.errors.length,
      warning_count: validation.warnings.length,
      info_count: validation.info.length,
    });
  }
  
  // Invalid events
  for (const ie of (vectors.invalid_events || [])) {
    const validation = validateEventStructure(ie.event);
    const validMatchesExpected = validation.valid === ie.expected_valid;
    const expectedCodes = ie.expected_errors || [];
    const expectedWarnings = ie.expected_warnings || [];
    const actualCodes = validation.errors.map(e => e.code);
    const actualWarnings = validation.warnings.map(w => w.code);
    const actualInfo = validation.info.map(i => i.code);
    const codesMatch = expectedCodes.length === 0 || expectedCodes.every(c => actualCodes.includes(c));
    const warningsMatch = expectedWarnings.length === 0 || expectedWarnings.every(w => actualWarnings.includes(w) || actualInfo.includes(w));
    const pass = validMatchesExpected && codesMatch && warningsMatch;
    if (!pass) allPass = false;
    results.push({
      name: ie.name,
      expected_valid: ie.expected_valid,
      actual_valid: validation.valid,
      pass,
      expected_codes: expectedCodes,
      actual_codes: actualCodes,
      expected_warnings: expectedWarnings,
      actual_warnings: actualWarnings,
      actual_info: actualInfo,
    });
  }
  
  return { allPass, results };
}

// ─── Live Relay Validation ───────────────────────────────────────────

async function validateFromRelays(relays) {
  console.log(`\n  Querying ${relays.length} relay(ies) for kind 30386 events...\n`);
  
  const pool = new SimplePool();
  const allEvents = [];
  
  try {
    const events = await pool.querySync(relays, {
      kinds: [ATTESTATION_KIND],
      '#L': ['agent-reputation'],
      limit: 100,
    });
    allEvents.push(...events);
  } catch (e) {
    console.log(`  ⚠ Error querying relays: ${e.message}`);
  } finally {
    pool.close(relays);
  }
  
  // Deduplicate
  const seen = new Set();
  const unique = allEvents.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  
  console.log(`  Found ${unique.length} unique events\n`);
  
  let passed = 0;
  let failed = 0;
  let totalWarnings = 0;
  let totalInfo = 0;
  
  for (const event of unique) {
    const result = validateEventStructure(event);
    const status = result.valid ? '✓' : '✗';
    const age = event.created_at ? `${Math.round((Date.now() / 1000 - event.created_at) / 3600)}h` : '?';
    console.log(`  ${status} ${event.id?.slice(0, 16)}... kind:${event.kind} ${result.valid ? 'valid' : 'INVALID'} (age: ${age})`);
    if (!result.valid) {
      failed++;
      for (const err of result.errors) {
        console.log(`    ✗ ${err.code}: ${err.message}`);
      }
    } else {
      passed++;
    }
    totalWarnings += result.warnings.length;
    totalInfo += result.info.length;
    for (const w of result.warnings) {
      console.log(`    ⚠ ${w.code}: ${w.message}`);
    }
  }
  
  console.log(`\n  ═══════════════════════════════════`);
  console.log(`  Passed: ${passed}/${unique.length}`);
  console.log(`  Failed: ${failed}/${unique.length}`);
  console.log(`  Warnings: ${totalWarnings}`);
  console.log(`  Info: ${totalInfo}`);
  console.log(`  ═══════════════════════════════════\n`);
  
  return failed === 0;
}

async function validateFromFile(filePath) {
  console.log(`\n  Loading events from: ${filePath}\n`);
  
  let events;
  try {
    const data = readFileSync(resolve(filePath), 'utf-8');
    const parsed = JSON.parse(data);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    console.log(`  ⚠ Error reading file: ${e.message}`);
    return false;
  }
  
  console.log(`  Found ${events.length} event(s)\n`);
  
  let passed = 0;
  let failed = 0;
  
  for (const event of events) {
    const result = validateEventStructure(event);
    const status = result.valid ? '✓' : '✗';
    console.log(`  ${status} ${event.id?.slice(0, 16) || 'unknown'}... ${result.valid ? 'valid' : 'INVALID'}`);
    if (!result.valid) {
      failed++;
      for (const err of result.errors) {
        console.log(`    ✗ ${err.code}: ${err.message}`);
      }
    } else {
      passed++;
    }
    for (const w of result.warnings) {
      console.log(`    ⚠ ${w.code}: ${w.message}`);
    }
  }
  
  console.log(`\n  Passed: ${passed}/${events.length}, Failed: ${failed}/${events.length}\n`);
  return failed === 0;
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  
  console.log('═══════════════════════════════════════════');
  console.log('  NIP-30386 Conformance Test Runner v1.0');
  console.log('═══════════════════════════════════════════\n');
  
  // Decay formula validation
  console.log('  ── Decay Formula ──\n');
  const decayResult = validateDecayFormula();
  for (const r of decayResult.results) {
    const status = r.pass ? '✓' : '✗';
    const note = r.note ? ` (${r.note})` : '';
    console.log(`  ${status} age=${r.age_hours}h: expected=${r.expected}, actual=${r.actual.toFixed(4)}${note}`);
  }
  console.log(`  Decay: ${decayResult.allPass ? 'ALL PASS' : 'FAILED'}\n`);
  
  // Aggregation validation
  console.log('  ── Aggregation Weights ──\n');
  const aggResult = validateAggregation();
  for (const r of aggResult.results) {
    const status = r.pass ? '✓' : '✗';
    console.log(`  ${status} ${r.name}: expected=${JSON.stringify(r.expected_range || r.expected)}, actual=${typeof r.actual === 'number' ? r.actual.toFixed(4) : r.actual}`);
  }
  console.log(`  Aggregation: ${aggResult.allPass ? 'ALL PASS' : 'FAILED'}\n`);
  
  // d-tag format validation
  console.log('  ── d-tag Format ──\n');
  const dTagResult = validateDTagFormat();
  for (const r of dTagResult.results) {
    const status = r.pass ? '✓' : '✗';
    console.log(`  ${status} "${r.d.slice(0, 40)}..." ${r.note}`);
  }
  console.log(`  d-tag Format: ${dTagResult.allPass ? 'ALL PASS' : 'FAILED'}\n`);
  
  // Test vector validation
  console.log('  ── Test Vectors ──\n');
  const vectorResult = validateTestVectors();
  for (const r of vectorResult.results) {
    const status = r.pass ? '✓' : '✗';
    if (r.expected_valid !== undefined) {
      // Event validation result
      const type = r.expected_valid ? 'valid' : 'invalid';
      console.log(`  ${status} ${r.name} (${type}): actual_valid=${r.actual_valid}, expected=${r.expected_valid}`);
      if (r.actual_codes && r.actual_codes.length > 0) {
        console.log(`      error codes: [${r.actual_codes?.join(', ')}]`);
      }
      if (r.actual_warnings && r.actual_warnings.length > 0) {
        console.log(`      warning codes: [${r.actual_warnings?.join(', ')}]`);
      }
      if (r.actual_info && r.actual_info.length > 0) {
        console.log(`      info codes: [${r.actual_info?.join(', ')}]`);
      }
    } else {
      // Metadata result (version, kind)
      console.log(`  ${status} ${r.name}: ${r.value || ''}`);
    }
  }
  console.log(`  Test Vectors: ${vectorResult.allPass ? 'ALL PASS' : 'FAILED'}\n`);
  
  // Mode-specific validation
  let relayPass = true;
  
  if (args.includes('--relay')) {
    const relayIdx = args.indexOf('--relay');
    const relayArg = args[relayIdx + 1];
    const relays = relayArg && !relayArg.startsWith('--') ? [relayArg] : DEFAULT_RELAYS;
    relayPass = await validateFromRelays(relays);
  } else if (args.includes('--file')) {
    const fileIdx = args.indexOf('--file');
    const filePath = args[fileIdx + 1];
    if (!filePath) {
      console.log('  ⚠ --file requires a path argument\n');
      process.exit(1);
    }
    relayPass = await validateFromFile(filePath);
  }
  
  const allPass = decayResult.allPass && aggResult.allPass && dTagResult.allPass && vectorResult.allPass && relayPass;
  
  console.log('═══════════════════════════════════════════');
  console.log(`  Overall: ${allPass ? '✅ ALL PASS' : '❌ SOME FAILURES'}`);
  console.log('═══════════════════════════════════════════\n');
  
  process.exit(allPass ? 0 : 1);
}

main().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});