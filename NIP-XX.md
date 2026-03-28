NIP-XX
======

Agent Reputation Attestations
-----------------------------

`draft` `optional`

This NIP defines a standard for publishing, querying, and verifying reputation attestations for autonomous agents operating on the Lightning Network. Reputation is derived from observable economic behavior — payment settlements, service delivery, uptime — rather than social signals or self-reported claims.

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt).

## Motivation

Autonomous agents transacting over Lightning have no standard way to evaluate counterparty trustworthiness before payment. Social signals (followers, zaps) don't correlate with service quality. Directories list services without quality data. Most agent-to-agent transactions happen blind.

This NIP provides a protocol-level reputation system where trust is earned through verifiable economic behavior, published in a standard format to Nostr relays, and queryable by any agent before transacting.

### Relationship to NIP-85

[NIP-85](85.md) defines Trusted Assertions — a mechanism for offloading web-of-trust calculations to trusted service providers. This NIP differs in that attestations originate from direct economic interactions between transacting parties, not from centralized computation providers. The two NIPs are complementary:

- **NIP-85** answers: "What does a trusted computation provider say about this pubkey?"
- **This NIP** answers: "What do this agent's actual transaction counterparties say about its economic behavior?"

NIP-85 providers MAY consume attestations defined in this NIP as input signals for their own calculations.

## Event Kinds

This NIP defines one new event kind:

| Kind  | Description               | NIP-XX |
| ----- | ------------------------- | ------ |
| 30386 | Agent reputation attestation | XX   |

Kind `30386` is a [replaceable parameterized event](01.md). The `d` tag identifies the subject:

```
["d", "<subject_identifier>:<service_type>"]
```

The `subject_identifier` is typically a Lightning node pubkey (66-character hex, compressed secp256k1) but MAY be any stable public identifier for the subject, including domain names (e.g. `example.com:web-agent`) for HTTP-based services.

Service handler declarations reuse [NIP-89](89.md) kind `31990`.

## Attestation Event

```jsonc
{
  "kind": 30386,
  "pubkey": "<attester_pubkey>",
  "created_at": <unix_timestamp>,
  "tags": [
    ["d", "<subject_node_pubkey>:<service_type>"],
    ["p", "<subject_nostr_pubkey>"],
    ["node_pubkey", "<subject_node_pubkey>"],
    ["service_type", "<service_type>"],
    ["attestation_type", "<self|bilateral|observer>"],
    ["dimension", "<name>", "<value>", "<sample_size>"],
    ["dimension", "<name>", "<value>", "<sample_size>"],
    ["half_life_hours", "<hours>"],
    ["sample_window_hours", "<hours>"],
    ["L", "agent-reputation"],
    ["l", "attestation", "agent-reputation"]
  ],
  "content": "<optional free-text context>"
}
```

Example of an observer attesting a Lightning node's uptime and capacity:

```jsonc
{
  "kind": 30386,
  "pubkey": "1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead",
  "created_at": 1711324800,
  "tags": [
    ["d", "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f:lightning-node"],
    ["p", "e88a691e98d9987c964521dff60025f60700378a4879180dcbbb4a5027850411"],
    ["node_pubkey", "03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f"],
    ["service_type", "lightning-node"],
    ["attestation_type", "observer"],
    ["dimension", "uptime_percent", "99.8", "30"],
    ["dimension", "capacity_sats", "5000000000", "1981"],
    ["half_life_hours", "2160"],
    ["sample_window_hours", "720"],
    ["L", "agent-reputation"],
    ["l", "attestation", "agent-reputation"]
  ],
  "content": "Observed via Lightning graph: 1981 channels, 50 BTC capacity"
}
```

### Tags

| Tag | Required | Description |
| --- | -------- | ----------- |
| `d` | YES | `<subject_pubkey>:<service_type>` — identifies the subject and service |
| `p` | NO | Subject's Nostr pubkey (32-byte hex). Used for relay indexing via `#p` filter |
| `node_pubkey` | NO | Subject's Lightning node pubkey (33-byte compressed secp256k1, 66 hex chars). Nostr `p` tags MUST NOT contain node pubkeys |
| `service_type` | YES | Free-text service identifier (see [Service Types](#service-types)) |
| `attestation_type` | YES | One of `self`, `bilateral`, `observer` (see [Attestation Types](#attestation-types)) |
| `dimension` | YES (1+) | Metric observation: `["dimension", "<name>", "<value>", "<sample_size>"]` |
| `half_life_hours` | NO | Decay half-life in hours (default: 720). See [Decay](#decay-mechanism) |
| `sample_window_hours` | NO | Time window over which dimensions were measured |
| `L` | YES | NIP-32 label namespace: `agent-reputation` |
| `l` | YES | NIP-32 label: `attestation` in namespace `agent-reputation` |

### Dimension Tags

Each `dimension` tag contains:

1. **name** — the metric being reported
2. **value** — numeric string of the measured value
3. **sample_size** — number of observations backing this value

Example:

```json
["dimension", "payment_success_rate", "0.97", "47"]
```

#### Standard Dimensions

| Dimension | Description | Unit | Range |
| --------- | ----------- | ---- | ----- |
| `payment_success_rate` | Fraction of payments settled successfully | 0.0–1.0 | 0.90–1.0 |
| `response_time_ms` | Average service response time | milliseconds | 100–10000 |
| `settlement_rate` | Fraction of invoices paid on time | 0.0–1.0 | 0.95–1.0 |
| `uptime_percent` | Service availability over sample window | 0.0–100.0 | 95–100 |
| `dispute_rate` | Fraction of transactions disputed | 0.0–1.0 | 0.0–0.05 |
| `capacity_sats` | Total channel capacity | satoshis | varies |
| `transaction_volume_sats` | Total settled volume in sample window | satoshis | varies |

Custom dimensions are permitted. Queriers SHOULD ignore dimensions they do not recognize.

#### Minimum Sample Sizes

Attestations with very low sample sizes provide weak signal. Recommended minimums:

| Dimension | Minimum | Rationale |
| --------- | ------- | --------- |
| `payment_success_rate` | 5 | Too few payments for statistical meaning |
| `settlement_rate` | 5 | Same |
| `response_time_ms` | 3 | Multiple measurements needed for meaningful average |
| `uptime_percent` | 1 | Single channel provides some signal |
| `dispute_rate` | 5 | Small samples produce extreme rates |
| `capacity_sats` | 1 | Observable at any point |

Queriers SHOULD discount dimensions below minimum sample size. A `sample_size` of `0` indicates the dimension is declared but has no observations — queriers MUST ignore it.

### Attestation Types

| Type | Description |
| ---- | ----------- |
| `self` | Agent reporting its own metrics |
| `observer` | Third-party monitoring without direct transaction |
| `bilateral` | Counterparty attesting after direct transaction |

Implementations MUST accept all three types. The intended trust ordering is `bilateral` > `observer` > `self`, but queriers MAY apply their own weighting scheme.

**Self** attestations are useful as a baseline signal and for cold-start bootstrapping. Self-reported data is unverifiable and SHOULD carry less weight.

**Observer** attestations come from third parties who monitor an agent (e.g., by querying the Lightning network graph) without transacting directly. They provide independent signal but lack proof of direct economic interaction.

**Bilateral** attestations represent direct transactional experience. The attester has economic skin in the game. They SHOULD carry the most weight.

### Decay Mechanism

Attestations lose relevance over time. The `half_life_hours` tag specifies the decay rate. Recommended defaults:

| Category | Half-life | Rationale |
| -------- | --------- | --------- |
| Payment/settlement | 720h (30 days) | Economic behavior changes over weeks |
| Uptime/availability | 2160h (90 days) | Infrastructure is more stable |
| Capacity | 168h (7 days) | Channel capacity changes frequently |

Queriers apply exponential decay:

```
weight = clamp(2^(-age_hours / half_life_hours), 0.0, 1.0)
```

Attestations with `created_at` in the future yield negative `age_hours` and `weight > 1.0`. Queriers MUST clamp weight to `[0.0, 1.0]` and SHOULD discard events with future timestamps exceeding reasonable clock skew (recommended: 1 hour).

## Service Types

The `service_type` tag uses free text. The agent ecosystem is too young for a controlled vocabulary, and premature standardization would limit innovation.

Conventions:
- Lowercase, hyphenated: `lightning-node`, `data-api`, `ai-inference`
- Specific enough to distinguish: `bitcoin-price-api` not `api`
- Protocol prefix when relevant: `l402-proxy`, `bolt11-paywall`

Well-known types (non-normative):

| Type | Description |
| ---- | ----------- |
| `lightning-node` | General Lightning node operations |
| `data-api` | Data service via API |
| `ai-inference` | AI model inference endpoint |
| `l402-proxy` | L402-gated proxy or relay |
| `payment-processor` | Invoice generation, payment forwarding |
| `nostr-relay` | Nostr relay operation |

## Service Handler Declaration

Agents SHOULD publish a [NIP-89](89.md) kind `31990` event declaring what services they offer:

```jsonc
{
  "kind": 31990,
  "tags": [
    ["d", "<service_identifier>"],
    ["k", "30386"],
    ["description", "Bitcoin network data API"],
    ["price", "10", "sats", "per-request"],
    ["protocol", "L402"],
    ["endpoint", "https://example.com/api"],
    ["L", "agent-reputation"],
    ["l", "handler", "agent-reputation"]
  ]
}
```

The `k` tag references kind `30386`, making agent services discoverable via standard NIP-89 queries for `kind:31990` + `#k:30386`.

Additional tags extend NIP-89 for agent use cases:

| Tag | Description |
| --- | ----------- |
| `price` | `["price", "<amount>", "<unit>", "<model>"]` — e.g., `["price", "10", "sats", "per-request"]` |
| `protocol` | Payment/access protocol: `L402`, `bolt11`, `keysend` |
| `endpoint` | Service URL |

## Querying

To query an agent's reputation:

1. Subscribe to kind `30386` events with `#p` filter matching the subject's Nostr pubkey, OR use `#L` filter for `agent-reputation` and post-filter on `node_pubkey` tag
2. Collect attestations from multiple attesters
3. Apply decay weighting based on age and `half_life_hours`
4. Weight by attestation type (`bilateral` > `observer` > `self`)
5. Aggregate per-dimension across attesters using weighted average

**No composite score is prescribed.** Different use cases weight dimensions differently:

- A payment service cares most about `settlement_rate`
- A data API consumer cares about `response_time_ms` and `uptime_percent`
- A channel partner cares about `capacity_sats` and `payment_success_rate`

### Aggregation

For each dimension, queriers SHOULD compute a weighted average across all attestations:

```
effective_weight = decay_weight × type_weight
weighted_value = Σ(value_i × effective_weight_i) / Σ(effective_weight_i)
```

Where `decay_weight` is the exponential decay from the attestation's age and `type_weight` reflects the attestation type's trust level. Specific weight values are left to implementations.

### Self-Only Attestations

When all attestations for a subject are type `self`, no external validation exists. Queriers SHOULD indicate low confidence and MAY require additional signals before automated decisions.

### Stale Service Detection

A service may become inactive without explicit removal. Queriers detect this via decay:

1. Compute `effectiveWeight = decayWeight × typeWeight` for each attestation
2. If `max(effectiveWeight) < 0.05` across all attestations, flag the service as stale
3. A 30-day half-life bilateral attestation reaches 0.05 effective weight after ~130 days
4. Queriers SHOULD display stale services with an indicator but SHOULD NOT delete them

Service providers SHOULD publish periodic self-attestation updates (weekly or monthly) to signal liveness.

## Security Considerations

### Sybil Attacks

Creating fake attesters is cheap on Nostr. Mitigations:

- Weight attestations by the attester's own reputation (recursive trust)
- Require attesters to have Lightning settlement history
- Apply web-of-trust scoring: an attester with no reputation contributes minimal effective signal

### Collusion

Two agents can mutually inflate ratings. Detection signals:

- Low diversity of attesters
- Suspiciously uniform scores across dimensions
- No independent bilateral attestations from unrelated parties

### Observer Gaming

An attester could publish `observer` type to gain the 0.7 weight without actual observation. Mitigations:

- Cross-reference observer claims against Lightning network graph data
- Web-of-trust scoring reduces impact of low-reputation observers
- Bilateral attestations (1.0 weight) always dominate when available

### Replay

Attestations are timestamped and use replaceable events. The decay mechanism naturally handles stale data. Relays enforce that newer events replace older ones for the same `d` tag.

## Privacy Considerations

- Attestations reveal transaction relationships between pubkeys
- Agents MAY use ephemeral pubkeys for individual transactions
- Aggregate attestations (weekly summaries) reduce relationship graph exposure
- Participation is voluntary — no requirement to attest

## Implementation

A reference implementation (Node.js) is available at [github.com/LeviEdwards/nip-agent-reputation](https://github.com/LeviEdwards/nip-agent-reputation). It includes:

- CLI for collecting metrics, publishing attestations, and querying reputation
- Self, bilateral, and observer attestation builders
- Exponential decay and weighted aggregation
- Web-of-trust recursive scoring
- Service discovery via NIP-89
- Validation suite (399+ tests)
- HTTP API server

## Related NIPs

- [NIP-01](01.md) — Basic protocol (event structure, replaceable events)
- [NIP-32](32.md) — Labeling (`L` and `l` tags for namespace)
- [NIP-57](57.md) — Lightning Zaps (complementary Lightning-Nostr integration)
- [NIP-78](78.md) — Application-specific data (kind 30078, used during prototyping)
- [NIP-85](85.md) — Trusted Assertions (complementary trust computation)
- [NIP-89](89.md) — Recommended Application Handlers (kind 31990 service declarations)
- [NIP-90](90.md) — Data Vending Machines (complementary agent marketplace)
