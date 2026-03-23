# NIP Agent Reputation

A Nostr protocol extension (kind 30386) for agent reputation attestations on the Lightning Network.

Agents publish verifiable reputation data — settlement rates, uptime, capacity — anchored to real economic behavior, not self-reported claims. Other agents query this data from Nostr relays before transacting.

**[Read the full NIP spec →](NIP-XX.md)**

## Why

Autonomous agents transacting over Lightning have no standard way to evaluate counterparty trustworthiness. Social signals don't correlate with service quality. Directories list services without quality data. Most agent-to-agent transactions happen blind.

This protocol fixes that by putting reputation on the same decentralized rail agents already use for communication (Nostr) and payments (Lightning).

## How It Works

### Three Attestation Types

| Type | Weight | Source |
| ---- | ------ | ------ |
| **Self** | 0.3 | Agent reports its own metrics |
| **Observer** | 0.7 | Third party monitors via Lightning graph |
| **Bilateral** | 1.0 | Counterparty attests after a real transaction |

Bilateral attestations carry the most weight because the attester has economic skin in the game.

### Decay

Attestations lose relevance over time via exponential decay. A 30-day-old bilateral attestation carries ~50% of its original weight. Stale services get flagged automatically. No manual cleanup needed.

### Service Discovery

Agents publish NIP-89 handler declarations (kind 31990) alongside reputation events. Any agent can query relays for available services, filter by reputation score, and decide whether to transact — no centralized registry.

## Install

```bash
npm install nip-agent-reputation
```

Or run directly:

```bash
npx nip-agent-reputation --help
```

## Quick Start

### Publish a self-attestation

```bash
# Generate or load your Nostr keypair
npx nip-agent-reputation publish --type self \
  --service lightning-node \
  --lnd-host https://localhost:8080 \
  --lnd-macaroon /path/to/readonly.macaroon \
  --lnd-cert /path/to/tls.cert
```

### Discover services

```bash
# Find Lightning node services with reputation data
npx nip-agent-reputation discover --type lightning-node --reputation

# JSON output for programmatic use
npx nip-agent-reputation discover --type lightning-node --reputation --json
```

### Query an agent's reputation

```bash
# By Nostr pubkey (64-char hex)
npx nip-agent-reputation query <nostr_pubkey>

# By LND node pubkey (66-char hex)
npx nip-agent-reputation query <lnd_node_pubkey>
```

### Start the REST server

```bash
npx nip-agent-reputation serve --port 3386

# Endpoints:
# GET /attestations/:pubkey — query attestations
# GET /discover?type=lightning-node — discover services
# POST /attest — publish an attestation
```

## Programmatic Usage

```javascript
import {
  createAttestation,
  publishAttestation,
  queryAttestations
} from 'nip-agent-reputation';

// Query attestations for a node
const attestations = await queryAttestations(
  '03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8',
  ['wss://relay.damus.io', 'wss://nos.lol']
);

for (const a of attestations) {
  console.log(`${a.attestationType} from ${a.attester.slice(0, 16)}...`);
  for (const [name, value, sampleSize] of a.dimensions) {
    console.log(`  ${name}: ${value} (n=${sampleSize})`);
  }
}
```

```javascript
import { discoverServices } from 'nip-agent-reputation/discover';

// Find services with reputation enrichment
const services = await discoverServices({
  serviceType: 'lightning-node',
  enrichReputation: true,
  minTrustWeight: 0.5
});
```

```javascript
import { initBilateral, completeBilateral } from 'nip-agent-reputation/bilateral';

// Initiate a bilateral attestation with a counterparty
const { challenge } = await initBilateral(myKeypair, counterpartyPubkey, {
  serviceType: 'lightning-node',
  dimensions: [
    ['settlement_rate', '0.99', '15'],
    ['response_time_ms', '800', '15']
  ]
});
```

## Modules

| Module | Description |
| ------ | ----------- |
| `attestation` | Create, sign, publish, and query attestations |
| `bilateral` | Two-party mutual attestation protocol |
| `observer` | Generate attestations from LND graph data |
| `discover` | Service discovery via NIP-89 handler declarations |
| `web-of-trust` | Recursive trust scoring across attestation chains |
| `validate` | Event validation against NIP spec |
| `auto-publish` | Scheduled self-attestation publishing |
| `server` | REST API server |
| `cli` | Command-line interface |
| `keys` | Nostr keypair management |
| `lnd` | LND REST API client |

## Live Events

Attestations are published to 4 major relays:
- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.primal.net`
- `wss://relay.snort.social`

Query them with any Nostr client filtering for kind 30386 + label `agent-reputation`.

## Event Kind

**Kind 30386** — Replaceable parameterized event (NIP-01). Placed after the NIP-85 Trusted Assertions block (30382–30385) and before Corny Chat (30388).

Backwards-compatible querying includes legacy kinds: 30385, 30388, 30078.

## Tests

```bash
npm test
# 461 tests across 9 test files
```

## Status

**Draft** — seeking feedback on the spec and bilateral attestation partners.

- [x] Reference implementation (Node.js, 461 tests)
- [x] Live events on 4 relays
- [x] CLI + REST server
- [x] Service discovery with reputation filtering
- [x] Web-of-trust scoring
- [x] Exponential decay with configurable half-life
- [ ] npm publish (pending)
- [ ] NIP PR to [nostr-protocol/nips](https://github.com/nostr-protocol/nips) (pending)
- [ ] First live bilateral attestation from a real counterparty

## License

MIT
