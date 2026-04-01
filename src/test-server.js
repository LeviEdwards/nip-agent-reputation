/**
 * Tests for the HTTP API server.
 * Tests routing, request parsing, validation endpoint, cache behavior,
 * and response formatting. Uses real HTTP requests to a local server instance.
 */

import http from 'node:http';
import { createServer } from './server.js';
import { ATTESTATION_KIND, HANDLER_KIND } from './constants.js';

// Use short timeout for tests to avoid hanging on relay connections
process.env.QUERY_TIMEOUT_MS = '3000';

let server, port;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function fetch(path, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'GET';
    const reqOptions = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: options.headers || {},
    };

    const req = http.request(reqOptions, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(body); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body, json });
      });
    });

    req.on('error', reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

async function runTests() {
  // Start server on random port
  const instance = createServer({ port: 0, relays: ['wss://relay.damus.io', 'wss://nos.lol'] });
  server = instance.server;
  
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      console.log(`Test server on port ${port}`);
      resolve();
    });
  });

  try {
    // === Root endpoint ===
    console.log('\n=== GET / (API docs) ===');
    {
      const res = await fetch('/');
      assert(res.status === 200, 'returns 200');
      assert(res.json.name === 'NIP Agent Reputation API', 'has API name');
      assert(res.json.endpoints, 'has endpoints documentation');
      assert(res.json.endpoints['GET /reputation/:pubkey'], 'documents reputation endpoint');
      assert(res.json.endpoints['GET /discover'], 'documents discover endpoint');
      assert(res.json.endpoints['POST /validate'], 'documents validate endpoint');
      assert(res.json.examples, 'has examples');
      assert(res.json.kind === ATTESTATION_KIND, `kind is ${ATTESTATION_KIND}`);
    }

    // === Health endpoint ===
    console.log('\n=== GET /health ===');
    {
      const res = await fetch('/health');
      assert(res.status === 200, 'returns 200');
      assert(res.json.status === 'ok', 'status is ok');
      assert(typeof res.json.uptime === 'number', 'has uptime');
      assert(Array.isArray(res.json.relays), 'has relays array');
      assert(res.json.relays.length === 2, 'has 2 relays');
      assert(typeof res.json.timestamp === 'number', 'has timestamp');
      assert(typeof res.json.cacheSize === 'number', 'has cache size');
    }

    // === CORS headers ===
    console.log('\n=== CORS headers ===');
    {
      const res = await fetch('/health');
      assert(res.headers['access-control-allow-origin'] === '*', 'CORS allow origin *');
      assert(res.headers['access-control-allow-methods']?.includes('GET'), 'CORS allows GET');
      assert(res.headers['access-control-allow-methods']?.includes('POST'), 'CORS allows POST');
      assert(res.headers['content-type'] === 'application/json', 'content-type is JSON');
    }

    // === OPTIONS preflight ===
    console.log('\n=== OPTIONS preflight ===');
    {
      const res = await fetch('/reputation/abc', { method: 'OPTIONS' });
      assert(res.status === 204, 'returns 204 for OPTIONS');
    }

    // === 404 for unknown routes ===
    console.log('\n=== Unknown routes ===');
    {
      const res = await fetch('/nonexistent');
      assert(res.status === 404, 'returns 404');
      assert(res.json.error === 'Not found', 'has error message');
      assert(Array.isArray(res.json.availableEndpoints), 'lists available endpoints');
    }

    // === Reputation endpoint: invalid pubkey ===
    console.log('\n=== GET /reputation (invalid pubkey) ===');
    {
      const res = await fetch('/reputation/tooshort');
      assert(res.status === 404, 'short pubkey returns 404 (no route match)');
    }
    {
      // Valid-length hex but wrong chars — route matches but validation should catch
      const res = await fetch('/reputation/' + 'g'.repeat(64));
      assert(res.status === 404, 'non-hex chars return 404 (no route match)');
    }

    // === Reputation endpoint: valid pubkey with no attestations ===
    console.log('\n=== GET /reputation (no attestations) ===');
    {
      // Random pubkey unlikely to have attestations
      const fakePubkey = 'aa' + '00'.repeat(31);
      const res = await fetch(`/reputation/${fakePubkey}`);
      // This might timeout or find nothing — both are valid outcomes
      assert(res.status === 200 || res.status === 500, `returns 200 or 500 for empty pubkey (got ${res.status})`);
      if (res.status === 200) {
        assert(res.json.attestationCount === 0, 'zero attestations');
        assert(res.json.trustLevel === 'none', 'trust level is none');
        assert(res.json.message?.includes('No attestations'), 'has no-attestations message');
      }
    }

    // === Validate endpoint: valid attestation ===
    console.log('\n=== POST /validate (valid attestation) ===');
    {
      const validEvent = {
        kind: ATTESTATION_KIND,
        pubkey: 'aa'.repeat(32),
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'aa'.repeat(33) + ':lightning-node'],
          ['node_pubkey', 'aa'.repeat(33)],
          ['service_type', 'lightning-node'],
          ['dimension', 'payment_success_rate', '0.95', '50'],
          ['dimension', 'uptime_percent', '99.5', '168'],
          ['half_life_hours', '720'],
          ['sample_window_hours', '168'],
          ['attestation_type', 'self'],
          ['L', 'agent-reputation'],
          ['l', 'attestation', 'agent-reputation'],
        ],
        content: '',
      };
      const res = await fetch('/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(validEvent),
      });
      assert(res.status === 200, 'returns 200');
      assert(res.json.valid === true, 'valid event passes');
      assert(res.json.kind === ATTESTATION_KIND, `detected kind ${ATTESTATION_KIND}`);
      assert(Array.isArray(res.json.errors), 'has errors array');
      assert(res.json.errors.length === 0, 'no errors');
    }

    // === Validate endpoint: invalid attestation ===
    console.log('\n=== POST /validate (invalid attestation) ===');
    {
      const invalidEvent = {
        kind: ATTESTATION_KIND,
        pubkey: 'aa'.repeat(32),
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          // Missing required tags: d, node_pubkey, attestation_type, etc.
          ['dimension', 'payment_success_rate', 'not-a-number', '50'],
        ],
        content: '',
      };
      const res = await fetch('/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(invalidEvent),
      });
      assert(res.status === 200, 'returns 200 (validation result, not HTTP error)');
      assert(res.json.valid === false, 'invalid event fails');
      assert(res.json.errors.length > 0, 'has errors');
    }

    // === Validate endpoint: handler event ===
    console.log('\n=== POST /validate (handler event) ===');
    {
      const handlerEvent = {
        kind: HANDLER_KIND,
        pubkey: 'bb'.repeat(32),
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', 'test-service'],
          ['k', String(ATTESTATION_KIND)],
          ['description', 'A test service'],
          ['L', 'agent-reputation'],
          ['l', 'handler', 'agent-reputation'],
        ],
        content: '',
      };
      const res = await fetch('/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(handlerEvent),
      });
      assert(res.status === 200, 'returns 200');
      assert(res.json.valid === true, 'valid handler passes');
      assert(res.json.kind === HANDLER_KIND, `detected kind ${HANDLER_KIND}`);
    }

    // === Validate endpoint: batch ===
    console.log('\n=== POST /validate (batch) ===');
    {
      const batch = [
        {
          kind: ATTESTATION_KIND,
          pubkey: 'aa'.repeat(32),
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ['d', 'aa'.repeat(33) + ':lightning-node'],
            ['node_pubkey', 'aa'.repeat(33)],
            ['attestation_type', 'self'],
            ['L', 'agent-reputation'],
            ['l', 'attestation', 'agent-reputation'],
          ],
          content: '',
        },
        {
          kind: 9999, // Wrong kind
          pubkey: 'bb'.repeat(32),
          tags: [],
          content: '',
        },
      ];
      const res = await fetch('/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      });
      assert(res.status === 200, 'returns 200');
      assert(res.json.batchSize === 2, 'batch size 2');
      assert(Array.isArray(res.json.results), 'has results array');
      assert(res.json.results.length === 2, '2 results');
    }

    // === Validate endpoint: invalid JSON ===
    console.log('\n=== POST /validate (invalid JSON) ===');
    {
      const res = await fetch('/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not valid json{{{',
      });
      assert(res.status === 400, 'returns 400 for invalid JSON');
      assert(res.json.error.includes('Invalid JSON'), 'error mentions invalid JSON');
    }

    // === Reputation endpoint: valid format pubkey ===
    console.log('\n=== GET /reputation (66-hex LND pubkey format) ===');
    {
      // 66-hex should route match
      const lndPubkey = '03' + 'ab'.repeat(32);
      const res = await fetch(`/reputation/${lndPubkey}`);
      // Route should match and attempt query
      assert(res.status === 200 || res.status === 500, `66-hex routes correctly (got ${res.status})`);
    }

    // === Badge endpoint ===
    console.log('\n=== Badge endpoint ===');
    {
      // Badge for unknown pubkey — should return SVG with "unrated"
      const unknownHex = '00'.repeat(32);
      const res = await fetch(`/reputation/badge/${unknownHex}`);
      assert(res.status === 200, 'Badge returns 200 for unknown pubkey');
      const ct = res.headers['content-type'];
      assert(ct && ct.includes('image/svg+xml'), `Badge content-type is SVG (got ${ct})`);
      const svg = res.body;
      assert(svg.includes('NIP-30386'), 'Badge SVG contains NIP-30386 label');
      assert(svg.includes('unrated'), 'Unknown pubkey badge shows unrated');
      assert(svg.includes('<svg'), 'Badge is valid SVG');
    }
    {
      // Badge route should not match non-hex
      const res = await fetch('/reputation/badge/not-a-pubkey');
      assert(res.status === 404, 'Badge rejects invalid pubkey format');
    }

    // === Directory endpoint ===
    console.log('\n=== Directory endpoint ===');
    {
      const res = await fetch('/directory');
      assert(res.status === 200, 'Directory returns 200');
      const ct = res.headers['content-type'];
      assert(ct && ct.includes('text/html'), `Directory content-type is HTML (got ${ct})`);
      assert(res.body.includes('NIP-30386 Agent Directory'), 'Directory contains title');
      assert(res.body.includes('<!DOCTYPE html>'), 'Directory is valid HTML document');
    }

    // === Playground endpoint ===
    console.log('\n=== Playground endpoint ===');
    {
      const res = await fetch('/playground');
      assert(res.status === 200, 'Playground returns 200');
      const ct = res.headers['content-type'];
      assert(ct && ct.includes('text/html'), `Playground content-type is HTML (got ${ct})`);
      assert(res.body.includes('NIP-30386 Playground'), 'Playground contains title');
      assert(res.body.includes('<!DOCTYPE html>'), 'Playground is valid HTML');
      assert(res.body.includes('runValidate'), 'Playground has validate function');
      assert(res.body.includes('runQuery'), 'Playground has query function');
      assert(res.body.includes('runDiscover'), 'Playground has discover function');
      assert(res.body.includes('TEMPLATES'), 'Playground has event templates');
      assert(res.body.includes('agent-reputation'), 'Playground references agent-reputation namespace');
    }

    // === Method not allowed ===
    console.log('\n=== Wrong HTTP methods ===');
    {
      const res = await fetch('/validate', { method: 'GET' });
      assert(res.status === 404, 'GET /validate returns 404 (POST only)');
    }

  } finally {
    server.close();
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Test error:', err);
  if (server) server.close();
  process.exit(1);
});
