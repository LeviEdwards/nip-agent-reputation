/**
 * post-nostr-announce.js — Publish a kind 1 text note to Nostr dev channels.
 * 
 * Announces NIP-30386 (Agent Reputation Attestations) to the broader Nostr
 * developer community with links to spec, reference implementation, and live API.
 * 
 * Usage:
 *   node scripts/post-nostr-announce.js [--dry-run]
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';
import { getKeypair } from '../src/keys.js';

const DRY_RUN = process.argv.includes('--dry-run');

// Dev-focused Nostr relays
const RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.snort.social',
  'wss://relay.nostr.band',     // Large index relay — important for discoverability
];

const NOTE_TEXT = `🤝 Draft NIP: Agent Reputation Attestations (kind 30386)

Built a reputation protocol for autonomous agents on Lightning. Attestations are anchored in real economic behavior — payments settled, uptime measured, latency observed — not social signals.

Key design choices:
• kind 30386 (replaceable parameterized, d-tag: pubkey:service_type)
• 3 attestation types: self (0.3 weight), observer (0.7), bilateral (1.0)
• Exponential decay with per-dimension half-life
• No composite score — raw dimensions, let queriers weight
• NIP-89 compatible handler declarations (kind 31990)
• Backwards-compatible legacy kind querying (30385, 30388, 30078)

Live:
• Reference impl: https://github.com/LeviEdwards/nip-agent-reputation
• Public reputation API: https://dispatches.mystere.me/api/reputation/<hex_pubkey>
• Monitoring service: https://dispatches.mystere.me/attest

First external observer attestation already published by @npub1eq46vds9unu5v3ej92mly6jt45ju3rlz07r7mpcxefqg96gqc9vqdy00kk (karl_bott). Bilateral attestation exchange in progress.

Feedback welcome — especially on kind registration, interop with NIP-85, and whether the 3-tier type weight system maps well to your agent architecture.

#Nostr #Lightning #AgentEconomy #NIP`;

async function publishNote(text, relays) {
  const keypair = getKeypair();
  
  const event = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'Lightning'],
      ['t', 'Nostr'],
      ['t', 'AgentEconomy'],
      ['t', 'NIP'],
    ],
    content: text,
  }, keypair.secretKey);

  console.log(`Publishing from: ${keypair.npub}`);
  console.log(`Event ID: ${event.id}`);
  console.log('');

  if (DRY_RUN) {
    console.log('[DRY RUN] Would publish:');
    console.log(text);
    return { eventId: event.id, published: 0, failed: 0 };
  }

  let published = 0;
  let failed = 0;

  for (const url of relays) {
    try {
      const relay = await Relay.connect(url);
      await relay.publish(event);
      relay.close();
      console.log(`  ✓ ${url}`);
      published++;
    } catch (err) {
      console.log(`  ✗ ${url}: ${err.message}`);
      failed++;
    }
  }

  return { eventId: event.id, published, failed };
}

const result = await publishNote(NOTE_TEXT, RELAYS);
console.log(`\nPublished to ${result.published}/${RELAYS.length} relays.`);
console.log(`Event: ${result.eventId}`);
