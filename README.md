# NIP-30386: Agent Reputation Attestations

A Nostr protocol and reference implementation for agent reputation on Lightning Network.

Trust is earned through verifiable economic behavior — payment settlements, uptime, service delivery — not social signals.

[![Tests](https://img.shields.io/badge/tests-533%20passing-brightgreen)](#testing)
[![Version](https://img.shields.io/badge/version-1.0.10-blue)](package.json)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

## What This Is

- **[NIP-XX.md](NIP-XX.md)** — The formal Nostr protocol specification (Kind 30386)
- **Reference implementation** — Node.js library for building, publishing, querying, and aggregating attestations
- **Client SDK** — Zero-dependency `ReputationClient` for any agent to check reputation before paying
- **Reputation server** — REST API + Nostr relay queries with badge generation, discovery, and conformance testing
- **CLI** — `npx nip-agent-reputation` for self-attestation, monitoring, and conformance testing

## Quick Start

### Check an agent's reputation before paying

```js
import { ReputationClient } from 'nip-agent-reputation';

const client = new ReputationClient('https://dispatches.mystere.me/api/reputation');
const decision = await client.checkAndDecide(pubkey, amountSats);

if (decision.allow) {
  // Pay the invoice
} else {
  console.log('Rejected:', decision.reasons);
}
```

### Query attestations from Nostr relays

```js
import { queryAttestations, aggregateAttestations } from 'nip-agent-reputation';

const events = await queryAttestations(pubkey, {
  relays: ['wss://nos.lol', 'wss://relay.damus.io'],
});

const summary = aggregateAttestations(events);
console.log(summary.trustLevel);     // 'verified' | 'emerging' | 'none'
console.log(summary.dimensions);     // { uptime_percent, response_time_ms, ... }
console.log(summary.attestationCount);
```

### Publish a self-attestation (from your LND node)

```js
import { buildSelfAttestation, publishToRelays } from 'nip-agent-reputation';

const event = await buildSelfAttestation({
  lndHost: 'https://localhost:8080',
  macaroonHex: process.env.LND_MACAROON,
  tlsCertPath: '/path/to/tls.cert',
});

await publishToRelays(event, ['wss://nos.lol', 'wss://relay.damus.io']);
```

### Build a bilateral attestation (post-transaction)

```js
import { buildBilateralAttestation } from 'nip-agent-reputation';

const event = buildBilateralAttestation({
  counterpartyPubkey: '03abcdef...',
  serviceType: 'api-provider',
  settled: true,
  amountSats: 1000,
  responseTimeMs: 250,
});
```

## Installation

```bash
npm install nip-agent-reputation
```

Or use the CLI directly:

```bash
npx nip-agent-reputation --help
```

## Architecture

```
src/
  attestation.js   — Core attestation building, publishing, querying, aggregation
  bilateral.js     — Post-transaction bilateral attestations
  monitor.js       — Endpoint monitoring (uptime, response time, security headers)
  server.js        — REST API server (reputation queries, discovery, badges)
  fulfill.js       — Attestation order fulfillment workflow
  billing.js       — Monthly recurring billing for monitoring services
  cli.js           — CLI entry point

sdk/
  reputation-client.js — Zero-dependency client SDK (7KB, Node.js 18+ / browsers)

test/
  test.js            — Core unit tests (312 tests)
  test-bilateral.js  — Bilateral attestation tests (44 tests)
  test-fulfill.js    — Order fulfillment tests (7 tests)
  test-sdk.js        — SDK unit tests (35 tests)
  test-sdk-live.js   — SDK live integration tests (13 tests × local + public)
  conformance.js     — Protocol conformance suite (98 tests)

examples/
  payment-gate.js      — Check reputation before paying (runnable demo)
  discover-agents.js   — Find agents with reputation data
  publish-attestation.js — Publish an attestation to Nostr relays

scripts/
  ensure-server.sh   — Server health check / auto-start
  run-monitoring.sh  — Full monitoring cycle (probe, attest, publish, bill)
  smoke-test.sh      — 10-endpoint API validation
```

## The Protocol (Kind 30386)

Attestations are [replaceable parameterized events](https://github.com/nostr-protocol/nips/blob/master/01.md) published to standard Nostr relays.

### Attestation Types

| Type | Weight | Source |
|------|--------|--------|
| `self` | 0.3 | Agent attesting its own metrics (LND node data) |
| `observer` | 0.7 | Independent monitor measuring uptime, response time, security |
| `bilateral` | 1.0 | Post-transaction attestation from actual counterparty |

### Dimensions

Attestations carry typed measurement dimensions:

- `uptime_percent` — Service availability (0-100)
- `response_time_ms` — Average response latency
- `payment_settlement_rate` — Fraction of payments settled (0.0-1.0)
- `channel_count`, `total_capacity_sats`, `routing_success_rate` — LN metrics
- `security_headers_percent` — HTTP security posture (0-100)

### Decay

Older attestations decay exponentially: `score = clamp(2^(-age/half_life), 0, 1)` where `half_life` defaults to 30 days.

### d-tag Format

```
["d", "<subject_identifier>:<service_type>"]
```

Subject identifiers are typically Lightning node pubkeys (66-hex compressed secp256k1) but MAY be domain names for HTTP-based services.

See [NIP-XX.md](NIP-XX.md) for the full specification.

## Client SDK

The SDK (`sdk/reputation-client.js`) is a zero-dependency, 7KB client for checking agent reputation before paying.

```js
import { ReputationClient } from 'nip-agent-reputation';

const client = new ReputationClient({
  apiBase: 'https://dispatches.mystere.me/api/reputation', // or your own server
  timeoutMs: 10000,
  policy: {
    minSettlementRate: 0.90,
    maxDisputeRate: 0.10,
    minTotalWeight: 0.3,
    maxBlindPaymentSats: 100,    // allow tiny payments with no reputation
  },
});

// One-call flow: query + decide
const { allow, reasons, reputation } = await client.checkAndDecide(pubkey, 5000);

// Or query separately
const rep = await client.query(pubkey);
const shouldPay = client.shouldPay(rep, 5000);

// Discovery
const { services } = await client.discover({ type: 'lightning-node' });

// SVG badge URL
const badgeUrl = client.badgeUrl(pubkey);
```

**Fail-closed by design:** Network errors, timeouts, and malformed responses all result in `allow: false`.

## REST API

Start the server:

```bash
npx nip-agent-reputation server --port 3386
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/reputation/:pubkey` | Aggregated reputation for a pubkey |
| `GET` | `/discover` | List known agent services |
| `GET` | `/reputation/badge/:pubkey` | SVG reputation badge |
| `POST` | `/reputation/validate` | Validate an attestation event |
| `GET` | `/reputation/health` | Server health check |
| `GET` | `/reputation/directory` | Full service directory |

## Conformance Testing

Test any NIP-30386 implementation:

```bash
# Test built-in vectors
npx nip-agent-reputation conformance --mode vectors

# Test against a live relay
npx nip-agent-reputation conformance --mode relay --relay wss://nos.lol

# Test events from a JSON file
npx nip-agent-reputation conformance --mode file --file events.json
```

## Examples

Ready-to-run scripts in `examples/`:

```bash
# Check an agent's reputation before paying
node examples/payment-gate.js <agent_pubkey> <amount_sats>

# Discover agents with reputation data
node examples/discover-agents.js [--service-type <type>]

# Publish an attestation to Nostr relays (requires nostr-tools, ws)
NOSTR_NSEC=nsec1... node examples/publish-attestation.js
```

## Testing

```bash
# Full suite (13 suites, 533+ tests)
npm test

# Individual suites
node test/test.js            # 312 core tests
node test/test-bilateral.js  # 44 bilateral tests
node test/test-fulfill.js    # 7 fulfillment tests
node test/test-sdk.js        # 37 SDK unit tests

# Conformance suite
node test/conformance.js     # 98 conformance tests

# Live integration (requires running server)
node test/test-sdk-live.js           # 13 tests against local server
node test/test-sdk-live.js --public  # 13 tests against public proxy

# API smoke test
bash scripts/smoke-test.sh   # 10 endpoint checks
```

**533+ tests total** across 13 suites, all passing.

## Live Deployment

The reference implementation runs live:

- **Public API:** `https://dispatches.mystere.me/api/reputation/{pubkey}`
- **Discovery:** `https://dispatches.mystere.me/api/reputation/discover`
- **Badges:** `https://dispatches.mystere.me/api/reputation/badge/{pubkey}`
- **Nostr relays:** `wss://nos.lol`, `wss://relay.damus.io`, `wss://relay.primal.net`, `wss://relay.snort.social`

### Live Events on Nostr

- 14+ attestation events published across 4 relays
- 2 independent implementations (reference + karl_bott/UtilShed)
- Automated monitoring runs every 6 hours

## NIP Acceptance Criteria

Per [nostr-protocol/nips BREAKING.md](https://github.com/nostr-protocol/nips/blob/master/BREAKING.md):

- ✅ **2+ implementations** — Reference implementation + karl_bott (UtilShed.com)
- ✅ **Events on relays** — 14+ live events on 4 major relays
- ✅ **Kind 30386 available** — Between NIP-85 (30382-30385) and Corny Chat (30388)
- ✅ **Conformance suite** — 98 tests validating any implementation
- ✅ **Backward compatibility** — Legacy kind migration (LEGACY_KINDS array)

## License

MIT
