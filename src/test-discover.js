/**
 * Tests for Service Discovery (discover.js)
 * 
 * Tests the discoverServices() and formatDiscoveryResults() functions
 * using mock relay data.
 */

import { discoverServices, formatDiscoveryResults } from './discover.js';
import { HANDLER_KIND, ATTESTATION_KIND } from './constants.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

// --- Mock Pool ---

function createMockPool(eventsByFilter) {
  return {
    querySync: async (relays, filter) => {
      // Match events by kind
      const kind = Array.isArray(filter.kinds) ? filter.kinds[0] : null;
      const events = eventsByFilter[kind] || eventsByFilter['default'] || [];
      return events;
    },
    close: () => {},
  };
}

// --- Test Helpers ---

function makeHandlerEvent(pubkey, serviceId, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const tags = [
    ['d', serviceId],
    ['k', String(opts.kTag || 30385)],
    ['description', opts.description || `Service: ${serviceId}`],
    ['L', 'agent-reputation'],
    ['l', 'handler', 'agent-reputation'],
  ];
  if (opts.price) tags.push(['price', ...opts.price]);
  if (opts.protocol) tags.push(['protocol', opts.protocol]);
  if (opts.endpoint) tags.push(['endpoint', opts.endpoint]);
  if (opts.nodePubkey) tags.push(['node_pubkey', opts.nodePubkey]);

  return {
    kind: HANDLER_KIND,
    pubkey,
    created_at: opts.createdAt || now - (opts.ageHours || 0) * 3600,
    tags,
    content: '',
  };
}

function makeAttestationEvent(attesterPubkey, subjectPubkey, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    kind: ATTESTATION_KIND,
    pubkey: attesterPubkey,
    created_at: opts.createdAt || now - (opts.ageHours || 0) * 3600,
    tags: [
      ['d', `${subjectPubkey}:lightning-node`],
      ['p', subjectPubkey],
      ['attestation_type', opts.type || 'self'],
      ['half_life_hours', String(opts.halfLife || 720)],
      ['dimension', 'payment_success_rate', String(opts.paymentRate || 0.95), '10'],
      ['dimension', 'uptime_percent', String(opts.uptime || 99.0), '168'],
      ['L', 'agent-reputation'],
      ['l', 'attestation', 'agent-reputation'],
    ],
    content: '',
  };
}

// --- Tests ---

async function runTests() {
  const pubkeyA = 'aaaa'.repeat(16);
  const pubkeyB = 'bbbb'.repeat(16);
  const pubkeyC = 'cccc'.repeat(16);

  // === Phase 1: Basic Discovery ===
  console.log('\n=== Phase 1: Basic Discovery ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'lightning-node', {
        description: 'Lightning routing node',
        price: ['10', 'sats', 'per-request'],
        protocol: 'L402',
        endpoint: 'https://example.com/api',
        ageHours: 2,
      }),
      makeHandlerEvent(pubkeyB, 'ai-inference', {
        description: 'AI model inference',
        price: ['50', 'sats', 'per-request'],
        protocol: 'L402',
        ageHours: 24,
      }),
    ];

    const pool = createMockPool({ [HANDLER_KIND]: handlers });
    const results = await discoverServices(pool, ['wss://mock'], {});

    assert(results.length === 2, `Found 2 services (got ${results.length})`);
    assert(results[0].serviceId === 'lightning-node', 'Newest first (lightning-node)');
    assert(results[1].serviceId === 'ai-inference', 'Older second (ai-inference)');
    assert(results[0].price.amount === '10', 'Price parsed correctly');
    assert(results[0].protocol === 'L402', 'Protocol parsed');
    assert(results[0].endpoint === 'https://example.com/api', 'Endpoint parsed');
    assert(results[0].reputation === null, 'No reputation without enrichment');
  }

  // === Phase 2: Service Type Filter ===
  console.log('\n=== Phase 2: Service Type Filter ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'lightning-node', { description: 'Lightning routing' }),
      makeHandlerEvent(pubkeyB, 'ai-inference', { description: 'AI model' }),
      makeHandlerEvent(pubkeyC, 'data-api', { description: 'Bitcoin data API' }),
    ];

    const pool = createMockPool({ [HANDLER_KIND]: handlers });

    const lightning = await discoverServices(pool, ['wss://mock'], { serviceType: 'lightning' });
    assert(lightning.length === 1, `Type filter "lightning" → 1 result (got ${lightning.length})`);
    assert(lightning[0].serviceId === 'lightning-node', 'Correct service filtered');

    const ai = await discoverServices(pool, ['wss://mock'], { serviceType: 'ai' });
    assert(ai.length === 1, `Type filter "ai" → 1 result (got ${ai.length})`);

    const data = await discoverServices(pool, ['wss://mock'], { serviceType: 'data' });
    assert(data.length === 1, `Type filter "data" → 1 result (got ${data.length})`);

    // Description match
    const bitcoin = await discoverServices(pool, ['wss://mock'], { serviceType: 'bitcoin' });
    assert(bitcoin.length === 1, `Type filter "bitcoin" matches description (got ${bitcoin.length})`);
  }

  // === Phase 3: Protocol Filter ===
  console.log('\n=== Phase 3: Protocol Filter ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'svc-a', { protocol: 'L402' }),
      makeHandlerEvent(pubkeyB, 'svc-b', { protocol: 'bolt11' }),
      makeHandlerEvent(pubkeyC, 'svc-c', {}), // no protocol
    ];

    const pool = createMockPool({ [HANDLER_KIND]: handlers });

    const l402 = await discoverServices(pool, ['wss://mock'], { protocol: 'L402' });
    assert(l402.length === 1, `Protocol filter "L402" → 1 result (got ${l402.length})`);
    assert(l402[0].serviceId === 'svc-a', 'Correct service for L402');

    const bolt11 = await discoverServices(pool, ['wss://mock'], { protocol: 'bolt11' });
    assert(bolt11.length === 1, `Protocol filter "bolt11" → 1 result (got ${bolt11.length})`);
  }

  // === Phase 4: Max Age Filter ===
  console.log('\n=== Phase 4: Max Age Filter ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'fresh', { ageHours: 12 }),
      makeHandlerEvent(pubkeyB, 'medium', { ageHours: 72 }), // 3 days
      makeHandlerEvent(pubkeyC, 'stale', { ageHours: 720 }), // 30 days
    ];

    const pool = createMockPool({ [HANDLER_KIND]: handlers });

    const oneDay = await discoverServices(pool, ['wss://mock'], { maxAgeDays: 1 });
    assert(oneDay.length === 1, `Max 1 day → 1 result (got ${oneDay.length})`);

    const sevenDays = await discoverServices(pool, ['wss://mock'], { maxAgeDays: 7 });
    assert(sevenDays.length === 2, `Max 7 days → 2 results (got ${sevenDays.length})`);

    const allTime = await discoverServices(pool, ['wss://mock'], {});
    assert(allTime.length === 3, `No max age → all 3 (got ${allTime.length})`);
  }

  // === Phase 5: Deduplication ===
  console.log('\n=== Phase 5: Deduplication ===');
  {
    const now = Math.floor(Date.now() / 1000);
    const handlers = [
      makeHandlerEvent(pubkeyA, 'my-service', { createdAt: now - 3600, description: 'Old version' }),
      makeHandlerEvent(pubkeyA, 'my-service', { createdAt: now - 60, description: 'New version' }),
    ];

    const pool = createMockPool({ [HANDLER_KIND]: handlers });
    const results = await discoverServices(pool, ['wss://mock'], {});

    assert(results.length === 1, `Deduplicated to 1 (got ${results.length})`);
    assert(results[0].description === 'New version', 'Kept newest version');
  }

  // === Phase 6: Reputation Enrichment ===
  console.log('\n=== Phase 6: Reputation Enrichment ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'lightning-node', { ageHours: 1 }),
    ];
    const attestations = [
      makeAttestationEvent(pubkeyA, pubkeyA, { type: 'self', paymentRate: 0.95, uptime: 99.5, ageHours: 6 }),
      makeAttestationEvent(pubkeyB, pubkeyA, { type: 'bilateral', paymentRate: 0.92, uptime: 98.0, ageHours: 12 }),
    ];

    const pool = {
      querySync: async (relays, filter) => {
        const kind = Array.isArray(filter.kinds) ? filter.kinds[0] : null;
        if (kind === HANDLER_KIND) return handlers;
        // Attestation query - filter by #p tag
        if (filter['#p']) {
          return attestations.filter(e => {
            const pTag = e.tags.find(t => t[0] === 'p');
            return pTag && filter['#p'].includes(pTag[1]);
          });
        }
        return attestations;
      },
      close: () => {},
    };

    const results = await discoverServices(pool, ['wss://mock'], { withReputation: true });

    assert(results.length === 1, `1 service with reputation`);
    assert(results[0].reputation !== null, 'Has reputation data');
    assert(results[0].reputation.attestationCount === 2, `2 attestations (got ${results[0].reputation.attestationCount})`);
    assert(results[0].reputation.uniqueAttesters === 2, `2 unique attesters (got ${results[0].reputation.uniqueAttesters})`);
    assert(results[0].reputation.hasExternalAttestations === true, 'Has external attestations');
    assert(results[0].reputation.trustLevel !== 'low', `Trust level not low (got ${results[0].reputation.trustLevel})`);
    assert(results[0].reputation.dimensions.payment_success_rate !== undefined, 'Has payment_success_rate dimension');
  }

  // === Phase 7: No Services Found ===
  console.log('\n=== Phase 7: No Services Found ===');
  {
    const pool = createMockPool({ [HANDLER_KIND]: [] });
    const results = await discoverServices(pool, ['wss://mock'], {});
    assert(results.length === 0, 'Empty result set');
  }

  // === Phase 8: Format Output ===
  console.log('\n=== Phase 8: Format Output ===');
  {
    // Empty
    const emptyOutput = formatDiscoveryResults([]);
    assert(emptyOutput.includes('No agent services found'), 'Empty format message');

    // With services
    const services = [
      {
        serviceId: 'test-service',
        description: 'A test service',
        pubkey: pubkeyA,
        price: { amount: '10', unit: 'sats', per: 'per-request' },
        protocol: 'L402',
        endpoint: 'https://example.com',
        nodePubkey: '03' + 'ab'.repeat(32),
        ageHours: 2.5,
        reputation: {
          totalWeight: 1.2,
          trustLevel: 'verified',
          attestationCount: 3,
          uniqueAttesters: 2,
          hasExternalAttestations: true,
          dimensions: { payment_success_rate: 0.97, uptime_percent: 99.1 },
        },
      },
    ];

    const output = formatDiscoveryResults(services);
    assert(output.includes('test-service'), 'Shows service ID');
    assert(output.includes('A test service'), 'Shows description');
    assert(output.includes('10 sats'), 'Shows price');
    assert(output.includes('L402'), 'Shows protocol');
    assert(output.includes('verified'), 'Shows trust level');
    assert(output.includes('external attestations'), 'Shows external attestation indicator');
    assert(output.includes('payment_success_rate'), 'Shows dimensions');
  }

  // === Phase 9: Self-Only Reputation ===
  console.log('\n=== Phase 9: Self-Only Reputation ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'solo-service', { ageHours: 1 }),
    ];
    const attestations = [
      makeAttestationEvent(pubkeyA, pubkeyA, { type: 'self', paymentRate: 0.99, uptime: 100, ageHours: 1 }),
    ];

    const pool = {
      querySync: async (relays, filter) => {
        const kind = Array.isArray(filter.kinds) ? filter.kinds[0] : null;
        if (kind === HANDLER_KIND) return handlers;
        return attestations;
      },
      close: () => {},
    };

    const results = await discoverServices(pool, ['wss://mock'], { withReputation: true });

    assert(results[0].reputation.hasExternalAttestations === false, 'No external attestations');
    assert(results[0].reputation.trustLevel === 'low', `Self-only → low trust (got ${results[0].reputation.trustLevel})`);
    assert(results[0].reputation.totalWeight < 0.5, `Self-only totalWeight < 0.5 (got ${results[0].reputation.totalWeight})`);
  }

  // === Phase 10: Combined Filters ===
  console.log('\n=== Phase 10: Combined Filters ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'lightning-node', { protocol: 'L402', ageHours: 12 }),
      makeHandlerEvent(pubkeyB, 'lightning-relay', { protocol: 'bolt11', ageHours: 48 }),
      makeHandlerEvent(pubkeyC, 'ai-model', { protocol: 'L402', ageHours: 2 }),
    ];

    const pool = createMockPool({ [HANDLER_KIND]: handlers });

    const results = await discoverServices(pool, ['wss://mock'], {
      serviceType: 'lightning',
      protocol: 'L402',
      maxAgeDays: 1,
    });

    assert(results.length === 1, `Combined filters → 1 result (got ${results.length})`);
    assert(results[0].serviceId === 'lightning-node', 'Correct service survives all filters');
  }

  // === Phase 11: Min Trust Weight Filter ===
  console.log('\n=== Phase 11: Min Trust Weight Filter ===');
  {
    const handlers = [
      makeHandlerEvent(pubkeyA, 'good-service', { ageHours: 1 }),
      makeHandlerEvent(pubkeyB, 'weak-service', { ageHours: 1 }),
    ];

    const pool = {
      querySync: async (relays, filter) => {
        const kind = Array.isArray(filter.kinds) ? filter.kinds[0] : null;
        if (kind === HANDLER_KIND) return handlers;
        if (filter['#p']?.includes(pubkeyA)) {
          return [
            makeAttestationEvent(pubkeyB, pubkeyA, { type: 'bilateral', paymentRate: 0.99, ageHours: 1 }),
            makeAttestationEvent(pubkeyC, pubkeyA, { type: 'bilateral', paymentRate: 0.95, ageHours: 2 }),
          ];
        }
        if (filter['#p']?.includes(pubkeyB)) {
          return [
            makeAttestationEvent(pubkeyB, pubkeyB, { type: 'self', paymentRate: 0.90, ageHours: 1 }),
          ];
        }
        return [];
      },
      close: () => {},
    };

    const results = await discoverServices(pool, ['wss://mock'], {
      withReputation: true,
      minTrustWeight: 0.5,
    });

    assert(results.length === 1, `Min trust filter removes weak service (got ${results.length})`);
    assert(results[0].serviceId === 'good-service', 'Only well-attested service remains');
  }

  // === Summary ===
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
