#!/usr/bin/env node
/**
 * NIP-30386 Conformance Test Suite
 * 
 * Validates that attestation events conform to the NIP-30386 specification.
 * This suite is implementation-agnostic — it tests events, not code.
 * 
 * Usage:
 *   node test/conformance.js                    # Run against built-in test vectors
 *   node test/conformance.js --relay wss://...  # Fetch and validate live events from relay
 *   node test/conformance.js --file events.json # Validate events from a JSON file
 * 
 * Exit code: 0 if all pass, 1 if any fail.
 */

import { verifyEvent } from 'nostr-tools/pure';

const ATTESTATION_KIND = 30386;
const HANDLER_KIND = 31990;

let passed = 0;
let failed = 0;
let warned = 0;

function pass(msg) { console.log(`  ✓ ${msg}`); passed++; }
function fail(msg) { console.log(`  ✗ FAIL: ${msg}`); failed++; }
function warn(msg) { console.log(`  ⚠ WARN: ${msg}`); warned++; }
function check(cond, passMsg, failMsg) { cond ? pass(passMsg) : fail(failMsg || passMsg); }

// ─── Spec requirement validators ────────────────────────────────

function validateEventStructure(event) {
  console.log('\n── Event Structure (NIP-01 compliance) ──');
  check(typeof event.id === 'string' && /^[0-9a-f]{64}$/.test(event.id),
    'id is 64-char lowercase hex',
    `id is invalid: "${event.id}"`);
  check(typeof event.pubkey === 'string' && /^[0-9a-f]{64}$/.test(event.pubkey),
    'pubkey is 64-char lowercase hex',
    `pubkey is invalid: "${event.pubkey}"`);
  check(typeof event.created_at === 'number' && event.created_at > 0,
    `created_at is positive integer (${event.created_at})`,
    'created_at is missing or invalid');
  check(typeof event.kind === 'number',
    `kind is number (${event.kind})`,
    'kind is not a number');
  check(Array.isArray(event.tags),
    'tags is an array',
    'tags is not an array');
  check(typeof event.content === 'string',
    'content is a string',
    'content is not a string');
  check(typeof event.sig === 'string' && /^[0-9a-f]{128}$/.test(event.sig),
    'sig is 128-char lowercase hex',
    `sig is invalid format`);
}

function validateSignature(event) {
  console.log('\n── Cryptographic Verification ──');
  try {
    const valid = verifyEvent(event);
    check(valid, 'Event signature is valid', 'Event signature is INVALID');
  } catch (err) {
    fail(`Signature verification threw: ${err.message}`);
  }
}

function validateAttestationKind(event) {
  console.log('\n── Kind 30386 Attestation Requirements ──');
  check(event.kind === ATTESTATION_KIND,
    `kind is ${ATTESTATION_KIND}`,
    `kind is ${event.kind}, expected ${ATTESTATION_KIND}`);

  // d tag (REQUIRED — replaceable parameterized event)
  const dTags = event.tags.filter(t => t[0] === 'd');
  check(dTags.length === 1,
    `exactly one d tag (found ${dTags.length})`,
    `expected exactly one d tag, found ${dTags.length}`);
  if (dTags.length >= 1) {
    const dVal = dTags[0][1];
    check(typeof dVal === 'string' && dVal.length > 0,
      `d tag has value: "${dVal.slice(0, 40)}${dVal.length > 40 ? '...' : ''}"`,
      'd tag value is empty');
    // d tag format: pubkey:service_type
    const parts = dVal.split(':');
    if (parts.length >= 2) {
      pass(`d tag uses subject:service_type format`);
      if (/^[0-9a-f]{64,66}$/.test(parts[0])) {
        pass(`d tag subject is hex pubkey (${parts[0].slice(0,16)}...)`);
      } else if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(parts[0])) {
        pass(`d tag subject is domain name: ${parts[0]} (valid for web agents)`);
      } else {
        warn(`d tag subject "${parts[0]}" is neither hex pubkey nor domain`);
      }
    } else {
      warn(`d tag "${dVal}" doesn't use subject:service_type format (RECOMMENDED)`);
    }
  }

  // L namespace tag (REQUIRED)
  const lTags = event.tags.filter(t => t[0] === 'L');
  check(lTags.some(t => t[1] === 'agent-reputation'),
    'L tag with "agent-reputation" namespace present',
    'missing L tag with "agent-reputation" namespace');

  // l label tag (REQUIRED)
  const llTags = event.tags.filter(t => t[0] === 'l');
  const hasLabel = llTags.some(t => t[2] === 'agent-reputation');
  check(hasLabel,
    'l tag referencing agent-reputation namespace present',
    'missing l tag with agent-reputation namespace reference');

  // p tag (SHOULD for subject identification)
  const pTags = event.tags.filter(t => t[0] === 'p');
  if (pTags.length > 0) {
    pass(`p tag present (${pTags.length} total)`);
    check(/^[0-9a-f]{64}$/.test(pTags[0][1]),
      `p tag value is 64-hex pubkey`,
      `p tag value "${pTags[0][1]}" is not 64-hex`);
  } else {
    warn('no p tag — SHOULD include subject Nostr pubkey for queryability');
  }

  // attestation_type tag (REQUIRED)
  const atypeTags = event.tags.filter(t => t[0] === 'attestation_type');
  check(atypeTags.length >= 1,
    `attestation_type tag present: "${atypeTags[0]?.[1]}"`,
    'missing attestation_type tag');
  if (atypeTags.length >= 1) {
    const atype = atypeTags[0][1];
    const validTypes = ['self', 'observer', 'bilateral'];
    check(validTypes.includes(atype),
      `attestation_type "${atype}" is a recognized type`,
      `attestation_type "${atype}" not in [${validTypes}]`);
  }

  // node_pubkey tag (REQUIRED for Lightning agents, OPTIONAL for web-only agents)
  const npTags = event.tags.filter(t => t[0] === 'node_pubkey');
  const serviceType = event.tags.find(t => t[0] === 'service_type')?.[1] || '';
  const isLightningAgent = serviceType.includes('lightning') || serviceType === '';
  if (npTags.length >= 1) {
    pass(`node_pubkey tag present`);
    const npVal = npTags[0][1];
    if (/^[0-9a-f]{66}$/.test(npVal)) {
      pass(`node_pubkey is 66-char hex (LN compressed pubkey)`);
    } else if (/^[0-9a-f]{64}$/.test(npVal)) {
      warn(`node_pubkey is 64-char hex (Nostr pubkey, not LN compressed pubkey) — acceptable for non-LN agents`);
    } else {
      fail(`node_pubkey "${npVal}" is not valid hex pubkey`);
    }
  } else if (isLightningAgent) {
    warn('no node_pubkey tag — REQUIRED for Lightning Network agents');
  } else {
    pass('no node_pubkey tag (acceptable for non-Lightning agent)');
  }

  // service_type tag
  const stTags = event.tags.filter(t => t[0] === 'service_type');
  if (stTags.length >= 1) {
    pass(`service_type tag present: "${stTags[0][1]}"`);
  } else {
    warn('no service_type tag');
  }

  // dimension tags (SHOULD have at least one)
  const dimTags = event.tags.filter(t => t[0] === 'dimension');
  check(dimTags.length > 0,
    `${dimTags.length} dimension tag(s) present`,
    'no dimension tags — attestation has no measurable data');

  for (const dt of dimTags) {
    // Standard format: ["dimension", "name", "value", "sample_count"]
    // Compact format: ["dimension", "name,value,sample_count"]
    if (dt.length >= 4) {
      const [, name, value, samples] = dt;
      const numVal = parseFloat(value);
      const numSamp = parseInt(samples);
      check(!isNaN(numVal), `dimension "${name}" has numeric value (${value})`, `dimension "${name}" value "${value}" is not numeric`);
      check(!isNaN(numSamp) && numSamp > 0, `dimension "${name}" has positive sample count (${samples})`, `dimension "${name}" sample count "${samples}" is invalid`);
    } else if (dt.length === 2 && dt[1].includes(',')) {
      // Compact comma-separated format
      const parts = dt[1].split(',');
      if (parts.length >= 3) {
        pass(`dimension "${parts[0]}" uses compact format (interop)`);
      } else {
        warn(`dimension tag "${dt[1]}" has fewer than 3 comma-separated fields`);
      }
    } else {
      warn(`dimension tag has unexpected structure: ${JSON.stringify(dt)}`);
    }
  }

  // half_life_hours tag (RECOMMENDED)
  const hlTags = event.tags.filter(t => t[0] === 'half_life_hours');
  if (hlTags.length >= 1) {
    const hl = parseFloat(hlTags[0][1]);
    check(!isNaN(hl) && hl > 0, `half_life_hours is positive number (${hl})`, `half_life_hours "${hlTags[0][1]}" is invalid`);
  } else {
    warn('no half_life_hours tag — RECOMMENDED for decay computation');
  }

  // sample_window_hours tag
  const swTags = event.tags.filter(t => t[0] === 'sample_window_hours');
  if (swTags.length >= 1) {
    pass(`sample_window_hours present: ${swTags[0][1]}`);
  }

  // content (SHOULD be JSON with human-readable summary)
  try {
    const content = JSON.parse(event.content);
    pass('content is valid JSON');
    if (content.summary) pass(`content has summary field`);
  } catch {
    if (event.content.length > 0) {
      warn('content is not JSON (SHOULD be JSON with optional summary)');
    }
  }
}

function validateHandlerEvent(event) {
  console.log('\n── Kind 31990 Handler Requirements (NIP-89) ──');
  check(event.kind === HANDLER_KIND, `kind is ${HANDLER_KIND}`, `kind is ${event.kind}`);

  const dTags = event.tags.filter(t => t[0] === 'd');
  check(dTags.length === 1, 'd tag present', 'missing d tag');

  const kTags = event.tags.filter(t => t[0] === 'k');
  check(kTags.some(t => t[1] === String(ATTESTATION_KIND)),
    `k tag references kind ${ATTESTATION_KIND}`,
    `no k tag referencing ${ATTESTATION_KIND}`);
}

// ─── Test vectors ───────────────────────────────────────────────

function getTestVectors() {
  // Minimal valid attestation (unsigned — structure only)
  const minimalValid = {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    created_at: Math.floor(Date.now() / 1000),
    kind: 30386,
    tags: [
      ['d', 'c'.repeat(66) + ':lightning-node'],
      ['L', 'agent-reputation'],
      ['l', 'lightning-node', 'agent-reputation'],
      ['p', 'b'.repeat(64)],
      ['attestation_type', 'self'],
      ['node_pubkey', 'c'.repeat(66)],
      ['service_type', 'lightning-node'],
      ['dimension', 'uptime_percent', '99.5', '30'],
      ['dimension', 'payment_success_rate', '0.98', '100'],
      ['half_life_hours', '168'],
      ['sample_window_hours', '24'],
    ],
    content: JSON.stringify({ summary: 'Test self-attestation' }),
    sig: 'd'.repeat(128),
  };

  // Minimal observer attestation
  const observer = {
    ...minimalValid,
    tags: [
      ...minimalValid.tags.filter(t => t[0] !== 'attestation_type'),
      ['attestation_type', 'observer'],
    ],
  };

  // Missing required tags
  const missingLabels = {
    ...minimalValid,
    tags: minimalValid.tags.filter(t => t[0] !== 'L' && t[0] !== 'l'),
  };

  // Compact dimension format (interop)
  const compactDims = {
    ...minimalValid,
    tags: [
      ...minimalValid.tags.filter(t => t[0] !== 'dimension'),
      ['dimension', 'uptime_percent,99.5,30'],
      ['dimension', 'payment_success_rate,0.98,100'],
    ],
  };

  return { minimalValid, observer, missingLabels, compactDims };
}

// ─── Live relay tests ───────────────────────────────────────────

async function fetchFromRelay(relayUrl) {
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  console.log(`\nFetching kind ${ATTESTATION_KIND} events from ${relayUrl}...`);
  const events = await pool.querySync([relayUrl], { kinds: [ATTESTATION_KIND], limit: 20 }, { maxWait: 10000 });
  pool.close([relayUrl]);
  console.log(`Found ${events.length} event(s)`);
  return events;
}

async function loadFromFile(filePath) {
  const { readFileSync } = await import('fs');
  const data = JSON.parse(readFileSync(filePath, 'utf-8'));
  return Array.isArray(data) ? data : [data];
}

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const relayIdx = args.indexOf('--relay');
  const fileIdx = args.indexOf('--file');

  if (relayIdx >= 0 && args[relayIdx + 1]) {
    // Live relay mode
    const events = await fetchFromRelay(args[relayIdx + 1]);
    for (const event of events) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`Event: ${event.id.slice(0, 16)}... by ${event.pubkey.slice(0, 16)}...`);
      console.log(`${'═'.repeat(60)}`);
      validateEventStructure(event);
      validateSignature(event);
      if (event.kind === ATTESTATION_KIND) validateAttestationKind(event);
      else if (event.kind === HANDLER_KIND) validateHandlerEvent(event);
    }
  } else if (fileIdx >= 0 && args[fileIdx + 1]) {
    // File mode
    const events = await loadFromFile(args[fileIdx + 1]);
    for (const event of events) {
      console.log(`\n${'═'.repeat(60)}`);
      console.log(`Event: ${event.id?.slice(0, 16)}...`);
      console.log(`${'═'.repeat(60)}`);
      validateEventStructure(event);
      if (event.sig && event.sig !== 'd'.repeat(128)) validateSignature(event);
      if (event.kind === ATTESTATION_KIND) validateAttestationKind(event);
      else if (event.kind === HANDLER_KIND) validateHandlerEvent(event);
    }
  } else {
    // Test vector mode
    console.log('NIP-30386 Conformance Test Suite');
    console.log('Running against built-in test vectors...\n');

    const vectors = getTestVectors();

    console.log('═'.repeat(50));
    console.log('1. Minimal Valid Self-Attestation');
    console.log('═'.repeat(50));
    validateEventStructure(vectors.minimalValid);
    validateAttestationKind(vectors.minimalValid);

    console.log('\n' + '═'.repeat(50));
    console.log('2. Observer Attestation');
    console.log('═'.repeat(50));
    validateAttestationKind(vectors.observer);

    console.log('\n' + '═'.repeat(50));
    console.log('3. Missing Label Tags (should fail)');
    console.log('═'.repeat(50));
    const saveFailed = failed;
    validateAttestationKind(vectors.missingLabels);
    const expectedFailures = failed - saveFailed;
    if (expectedFailures > 0) {
      // These failures are expected — restore count and count as passes
      failed -= expectedFailures;
      passed += expectedFailures;
      pass(`correctly detected ${expectedFailures} missing-label violation(s)`);
    }

    console.log('\n' + '═'.repeat(50));
    console.log('4. Compact Dimension Format (interop)');
    console.log('═'.repeat(50));
    validateAttestationKind(vectors.compactDims);
  }

  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed, ${warned} warnings`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
