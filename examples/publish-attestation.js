#!/usr/bin/env node
/**
 * Example: Publish a NIP-30386 attestation to Nostr relays
 *
 * Creates and publishes a kind 30386 reputation attestation event.
 * This demonstrates the attestation format — you would integrate
 * this into your monitoring or billing system.
 *
 * Usage:
 *   NOSTR_NSEC=nsec1... node examples/publish-attestation.js
 *
 * Requires: Node.js 18+, nostr-tools, ws
 *   npm install nostr-tools ws
 *
 * ⚠️ This publishes a REAL event to Nostr relays. Use with care.
 */

// NOTE: This example requires nostr-tools and ws.
// In a real integration, you'd use your existing Nostr signing setup.

async function main() {
  let nostrTools, SimplePool, WebSocket;
  try {
    nostrTools = await import('nostr-tools');
    ({ SimplePool } = await import('nostr-tools/pool'));
    ({ default: WebSocket } = await import('ws'));
    global.WebSocket = WebSocket;
  } catch (e) {
    console.error('Missing dependencies. Install with:');
    console.error('  npm install nostr-tools ws');
    process.exit(1);
  }

  const nsec = process.env.NOSTR_NSEC;
  if (!nsec) {
    console.error('Set NOSTR_NSEC environment variable to your nsec key.');
    console.error('  NOSTR_NSEC=nsec1... node examples/publish-attestation.js');
    process.exit(1);
  }

  const sk = nostrTools.nip19.decode(nsec).data;
  const pk = nostrTools.getPublicKey(sk);

  // Example: attest to an agent's service quality
  const subjectPubkey = pk; // self-attestation for demo — replace with target pubkey
  const serviceType = 'http-endpoint';

  const event = nostrTools.finalizeEvent({
    kind: 30386,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', `${subjectPubkey}:${serviceType}`],
      ['p', subjectPubkey],
      ['service_type', serviceType],
      ['attestation_type', 'self'],
      ['dimension', 'uptime_percent', '99.5', '168'],
      ['dimension', 'response_time_ms', '150', '168'],
      ['half_life_hours', '720'],
      ['sample_window_hours', '168'],
      ['L', 'agent-reputation'],
      ['l', 'attestation', 'agent-reputation'],
    ],
    content: JSON.stringify({
      note: 'Example self-attestation',
      tool: 'nip-agent-reputation/examples',
    }),
  }, sk);

  console.log('Event created:');
  console.log('  ID:', event.id.slice(0, 16) + '...');
  console.log('  Kind:', event.kind);
  console.log('  Pubkey:', event.pubkey.slice(0, 16) + '...');
  console.log('  d-tag:', event.tags.find(t => t[0] === 'd')[1]);
  console.log('  Dimensions:', event.tags.filter(t => t[0] === 'dimension').length);
  console.log('');

  const relays = [
    'wss://nos.lol',
    'wss://relay.primal.net',
    'wss://relay.snort.social',
    'wss://relay.damus.io',
  ];

  console.log('Publishing to', relays.length, 'relays...');

  const pool = new SimplePool();
  const results = await Promise.allSettled(pool.publish(relays, event));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.filter(r => r.status === 'rejected');

  console.log(`  Accepted: ${ok}/${relays.length}`);
  if (failed.length > 0) {
    for (const f of failed) {
      console.log('  Failed:', f.reason?.message || f.reason);
    }
  }

  console.log('');
  console.log('Verify on Nostr:');
  console.log(`  https://njump.me/${nostrTools.nip19.neventEncode({ id: event.id })}`);

  pool.close(relays);
  setTimeout(() => process.exit(0), 2000);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
