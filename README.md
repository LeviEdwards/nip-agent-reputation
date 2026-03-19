# NIP-XXX: Agent Reputation Attestations

**Status:** DRAFT v0.1
**Author:** Satoshi (npub14my3srkmu8wcnk8pel9e9jy4qgknjrmxye89tp800clfc05m78aqs8xuj2)
**Created:** 2026-03-19
**Last Updated:** 2026-03-19

---

## Abstract

This NIP defines a standard for publishing, querying, and verifying reputation attestations for autonomous agents operating on the Lightning Network. Reputation is derived from observable economic behavior — payment settlements, service delivery, uptime — rather than granted trust or self-reported claims.

## Motivation

The agent economy on Lightning is growing, but there is no standard way for one agent to evaluate another's trustworthiness before transacting. Current approaches:

- **Directories** (satring.com, etc.) — list services but provide no quality signal
- **Social proof** (Nostr followers, zaps) — gameable, doesn't correlate with service quality
- **Nothing** — most agent-to-agent transactions happen blind

What's needed: a protocol-level reputation system where trust is earned through verifiable economic behavior, published in a standard format, and queryable by any agent before payment.

## Design Principles

1. **Settlement-anchored** — Reputation must be grounded in actual Lightning settlements, not claims
2. **Raw dimensions over composite scores** — Publish individual metrics; let queriers weight them
3. **Decay by default** — Old attestations lose weight over time. Configurable half-life per dimension
4. **No central authority** — Attestations are published to Nostr relays by the parties involved
5. **Cold start as filter** — New agents have no reputation, which is itself a signal. No bootstrapping shortcuts

## Specification

### Event Kind

Use **kind 30078** (replaceable parameterized event) for reputation attestations.

The `d` tag identifies the subject being attested:
```json
["d", "<subject_pubkey>:<service_type>"]
```

### Attestation Format

```json
{
  "kind": 30078,
  "pubkey": "<attester_pubkey>",
  "created_at": <unix_timestamp>,
  "tags": [
    ["d", "<subject_pubkey>:<service_type>"],
    ["p", "<subject_pubkey>"],
    ["service_type", "<free_text_service_type>"],
    ["dimension", "payment_success_rate", "0.97", "47"],
    ["dimension", "response_time_ms", "1200", "47"],
    ["dimension", "settlement_rate", "0.99", "47"],
    ["dimension", "uptime_percent", "99.2", "168"],
    ["dimension", "dispute_rate", "0.01", "47"],
    ["dimension", "capacity_sats", "500000", "1"],
    ["half_life_hours", "720"],
    ["sample_window_hours", "168"],
    ["attestation_type", "bilateral"],
    ["L", "agent-reputation"],
    ["l", "attestation", "agent-reputation"]
  ],
  "content": "<optional free-text context>"
}
```

### Dimension Tags

Each `dimension` tag contains:
- **name** — the metric being reported
- **value** — the measured value (numeric string)
- **sample_size** — number of observations backing this value

#### Standard Dimensions

| Dimension | Description | Unit | Typical Range |
|-----------|-------------|------|---------------|
| `payment_success_rate` | Fraction of payments that settled successfully | 0.0-1.0 | 0.90-1.0 |
| `response_time_ms` | Average response time for service delivery | milliseconds | 100-10000 |
| `settlement_rate` | Fraction of invoices paid on time | 0.0-1.0 | 0.95-1.0 |
| `uptime_percent` | Service availability over sample window | 0.0-100.0 | 95-100 |
| `dispute_rate` | Fraction of transactions disputed | 0.0-1.0 | 0.0-0.05 |
| `capacity_sats` | Total channel capacity visible | satoshis | varies |

Custom dimensions are allowed. Queriers ignore dimensions they don't understand.

### Decay Mechanism

The `half_life_hours` tag specifies how quickly this attestation should lose weight. Recommended defaults:

- **Payment/settlement dimensions:** 720 hours (30 days)
- **Uptime/availability:** 2160 hours (90 days)
- **Capacity:** 168 hours (7 days) — changes frequently

Queriers apply exponential decay:
```
weight = 2^(-age_hours / half_life_hours)
```

An attestation with a 30-day half-life loses 50% weight after 30 days, 75% after 60 days, ~97% after 5 half-lives (150 days).

### Attestation Types

- `self` — Agent reporting its own metrics (lowest trust weight)
- `bilateral` — Published by a counterparty after a transaction (higher trust)
- `observer` — Third-party monitoring service (requires own reputation)

### Service Handler Declaration

Agents SHOULD publish a kind **31990** event declaring what services they offer:

```json
{
  "kind": 31990,
  "tags": [
    ["d", "<service_identifier>"],
    ["k", "5600"],
    ["description", "Bitcoin network data API"],
    ["price", "10", "sats", "per-request"],
    ["protocol", "L402"],
    ["endpoint", "https://dispatches.mystere.me/api/network"],
    ["L", "agent-reputation"],
    ["l", "handler", "agent-reputation"]
  ]
}
```

### Querying Reputation

To query an agent's reputation:

1. Subscribe to kind 30078 events with `#p` filter for the subject pubkey
2. Collect attestations from multiple attesters
3. Apply decay weighting based on age and half-life
4. Weight by attestation type (bilateral > observer > self)
5. Aggregate per-dimension across attesters

No composite score is prescribed. Different use cases weight dimensions differently:
- A payment service cares most about `settlement_rate`
- A data API consumer cares about `response_time_ms` and `uptime_percent`
- A channel partner cares about `capacity_sats` and `payment_success_rate`

### Privacy Considerations

- Attestations reveal transaction relationships between pubkeys
- Agents MAY use ephemeral pubkeys for individual transactions
- Aggregate attestations (weekly summaries) reduce relationship exposure
- No requirement to attest — participation is voluntary

### Security Considerations

- **Sybil attacks:** Creating fake attesters is cheap. Weight attestations by the attester's own reputation (recursive, bootstraps from Lightning settlement history)
- **Collusion:** Two agents can mutually inflate ratings. Detect via: low diversity of attesters, suspiciously uniform scores, no independent bilateral attestations
- **Replay:** Attestations are timestamped. Decay mechanism naturally handles stale data
- **Self-attestation flooding:** Self-attestations carry lowest weight by convention

---

## Build Progress

### v0.1 (2026-03-19) — Initial Draft
- [x] Core event format defined
- [x] 6 standard dimensions specified
- [x] Decay mechanism with configurable half-life
- [x] Attestation types (self/bilateral/observer)
- [x] Service handler declaration (kind 31990)
- [x] Query flow described
- [x] Privacy and security considerations

### TODO — v0.2
- [ ] Write reference implementation (Node.js) that publishes self-attestation from our LND data
- [ ] Test: publish a real kind 30078 event to relays with our actual node metrics
- [ ] Test: query and parse the attestation back
- [ ] Validate decay math with real timestamps
- [ ] Get feedback from 34b4 and fc29 on the spec
- [ ] Consider: should service_type be from a controlled vocabulary or free text?
- [ ] Consider: minimum sample_size thresholds for attestation validity
- [ ] Consider: NIP-89 handler advertisement vs kind 31990
- [ ] Write a query client that aggregates attestations for a given pubkey

### TODO — v0.3
- [ ] Reference implementation for bilateral attestation (post-transaction auto-publish)
- [ ] Aggregation library (takes N attestations, applies decay, returns weighted dimensions)
- [ ] Edge case: what happens when an agent has only self-attestations?
- [ ] Edge case: attestation for a service that no longer exists
- [ ] Integration test: full cycle (declare handler → transact → bilateral attest → query)
