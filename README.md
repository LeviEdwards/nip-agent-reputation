# NIP-XXX: Agent Reputation Attestations

> **Status:** DRAFT v0.5 | [Full Specification](./nip-agent-reputation.md)

A Nostr protocol for publishing, querying, and verifying reputation attestations for autonomous agents on the Lightning Network. Reputation is derived from observable economic behavior — payment settlements, service delivery, uptime — not granted trust or self-reported claims.

## Why

The agent economy on Lightning has no standard way for one agent to evaluate another before transacting. This NIP provides:

- **Settlement-anchored reputation** — grounded in real Lightning payments
- **Raw dimensions, not composite scores** — individual metrics that queriers weight per their own needs
- **Decay by default** — old attestations lose weight over time (configurable half-life)
- **No central authority** — published to Nostr relays, queryable by anyone
- **Three trust tiers** — self (0.3), observer (0.7), bilateral (1.0) — direct economic experience dominates

## Reference Implementation

Node.js CLI and library for publishing and querying agent reputation attestations (kind 30078) and service handler declarations (kind 31990).

### Requirements

- Node.js ≥ 18
- LND node with REST API access (for collecting metrics)
- A Nostr keypair (auto-generated on first run, stored in `.nostr-nsec`)

### Setup

```bash
git clone https://github.com/LeviEdwards/nip-agent-reputation.git
cd nip-agent-reputation
npm install
```

Configure LND access by setting environment variables or editing `src/lnd.js`:
- `LND_REST_HOST` — LND REST API endpoint (default: `https://10.21.21.9:8080`)
- TLS cert and admin macaroon paths are configured in `src/lnd.js`

### CLI Commands

#### Collect Metrics (dry run)
```bash
node src/cli.js collect
```
Gathers metrics from your LND node and displays what would be published. No events sent.

#### Publish Self-Attestation
```bash
# Standard publish
node src/cli.js publish

# Auto-publish (skip if no meaningful change since last publish)
node src/cli.js publish --auto

# Force publish regardless of interval/change detection
node src/cli.js publish --force

# Auto-publish with JSON output (for cron integration)
node src/cli.js publish --auto --json
```

Publishes a kind 30078 self-attestation event to configured relays with your node's current metrics.

Auto-publish mode tracks state in `.auto-publish-state.json` and skips if:
- Less than 6 hours since last publish AND no meaningful metric change
- Always publishes if over 7 days since last (prevents staleness)

#### Query Attestations
```bash
# Query by Nostr pubkey (64 hex)
node src/cli.js query <nostr_pubkey_hex>

# Query by LND node pubkey (66 hex) — filters via node_pubkey tag
node src/cli.js query <lnd_node_pubkey>
```

Returns all attestations for a pubkey, applies decay weighting, and aggregates dimensions across attesters.

#### Record Transactions (for bilateral attestation)
```bash
# Record a settled transaction
node src/cli.js record <node_pubkey> <amount_sats> settled

# Record with response time
node src/cli.js record <node_pubkey> <amount_sats> settled --time 1200

# Record a failed/disputed transaction
node src/cli.js record <node_pubkey> <amount_sats> failed --dispute
```

Transaction history is stored in `.tx-history.json` (git-ignored).

#### Publish Bilateral Attestation
```bash
node src/cli.js attest <node_pubkey> [--nostr <nostr_pubkey>] [--service <type>]
```

Builds a bilateral attestation from recorded transaction history with the given counterparty and publishes to relays. Bilateral attestations carry the highest trust weight (1.0).

#### Observe a Node
```bash
# Dry run — observe and display metrics
node src/cli.js observe <node_pubkey>

# Observe and publish attestation
node src/cli.js observe <node_pubkey> --publish
```

Queries LND's network graph for the target node's channel count, capacity, and connectivity, then builds an observer attestation (trust weight 0.7).

#### Publish Service Handler (NIP-89 compatible)
```bash
node src/cli.js handler --id <service_id> --desc <description> \
  [--price <sats>] [--protocol <L402|bolt11>] [--endpoint <url>]
```

Publishes a kind 31990 service handler declaration. Compatible with NIP-89 — discoverable by any NIP-89-aware client.

#### Web-of-Trust Scoring
```bash
# Score a pubkey's trust
node src/cli.js trust <pubkey>

# With depth control and graph visualization
node src/cli.js trust <pubkey> --depth 3 --graph
```

Performs recursive trust-weighted reputation scoring. Evaluates attester diversity, flags sybil risk indicators (e.g., all attestations from the same author).

#### Verify an Event
```bash
node src/cli.js verify '<event_json_string>'
```

Parses and validates a raw Nostr event as an attestation.

### Library API

The implementation is modular — import individual components:

```javascript
import { buildSelfAttestation, publishToRelays, queryAttestations, aggregateAttestations } from './src/attestation.js';
import { TransactionHistory, buildBilateralFromHistory } from './src/bilateral.js';
import { ObservationSession, buildObserverAttestation } from './src/observer.js';
import { WebOfTrust } from './src/web-of-trust.js';
import { buildServiceHandler } from './src/handler.js';
import { shouldPublish, recordPublish } from './src/auto-publish.js';
import { collectLndMetrics } from './src/lnd.js';
import { getKeypair } from './src/keys.js';
```

### Source Files

| File | Description |
|------|-------------|
| `src/cli.js` | CLI entry point with all commands |
| `src/attestation.js` | Core: build, sign, publish, query, aggregate attestations |
| `src/bilateral.js` | Transaction recording + bilateral attestation builder |
| `src/observer.js` | Node observation via LND graph + observer attestation builder |
| `src/web-of-trust.js` | Recursive trust scoring + sybil risk detection |
| `src/auto-publish.js` | Smart publish scheduling (interval + change detection) |
| `src/handler.js` | Service handler declaration (kind 31990 / NIP-89) |
| `src/lnd.js` | LND REST API client for metric collection |
| `src/keys.js` | Nostr keypair generation and management |

### Tests

```bash
# Run all tests
node src/test-decay.js && node src/test-bilateral.js && node src/test-auto-publish.js && \
node src/test-integration.js && node src/test-observer.js && node src/test-web-of-trust.js

# 241 tests total across all suites
```

### Relays

Events are published to:
- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.primal.net`
- `wss://relay.snort.social`

### Security

- Private keys are stored in `.nostr-nsec` (git-ignored)
- Transaction history in `.tx-history.json` (git-ignored)
- Auto-publish state in `.auto-publish-state.json` (git-ignored)
- Only aggregate metrics are published — never raw financial data
- LND macaroons and credentials are never included in events

## Specification

The full NIP specification is in the root [`nip-agent-reputation.md`](./nip-agent-reputation.md) file. Key design decisions:

- **Event kind 30078** (replaceable parameterized) for attestations
- **Event kind 31990** (NIP-89 handler info) for service declarations
- **Exponential decay** with configurable half-life per dimension
- **Three attestation types** with different trust weights
- **Free-text service types** — ecosystem too young for controlled vocabulary
- **No composite scores** — raw dimensions let queriers weight for their use case

## License

ISC
