# NIP-XXX: Agent Reputation Attestations

**Status:** DRAFT v0.4
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

> **Note:** The `p` tag in Nostr events MUST be a 32-byte (64 hex) Nostr pubkey (x-only secp256k1). LND node pubkeys are 33-byte compressed secp256k1 (66 hex) and MUST NOT be used in `p` tags. Use `node_pubkey` tag instead.

```json
{
  "kind": 30078,
  "pubkey": "<attester_nostr_pubkey>",
  "created_at": <unix_timestamp>,
  "tags": [
    ["d", "<lnd_node_pubkey>:<service_type>"],
    ["node_pubkey", "<lnd_node_pubkey_66hex>"],
    ["p", "<subject_nostr_pubkey_64hex>"],
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
| `transaction_volume_sats` | Total settled volume in sample window | satoshis | varies |

Custom dimensions are allowed. Queriers ignore dimensions they don't understand.

### Decay Mechanism

The `half_life_hours` tag specifies how quickly this attestation should lose weight. Recommended defaults:

- **Payment/settlement dimensions:** 720 hours (30 days)
- **Uptime/availability:** 2160 hours (90 days)
- **Capacity:** 168 hours (7 days) — changes frequently

Queriers apply exponential decay:
```
weight = clamp(2^(-age_hours / half_life_hours), 0, 1.0)
```

An attestation with a 30-day half-life loses 50% weight after 30 days, 75% after 60 days, ~97% after 5 half-lives (150 days).

**Future timestamps:** Attestations with `created_at` in the future produce `age_hours < 0`, which yields `weight > 1.0`. Queriers MUST clamp weight to `[0, 1.0]` and SHOULD penalize or discard events with future timestamps (potential clock skew attack).

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

### Querier Behavior: Self-Attestation Only

When all attestations for a subject are `self` type:

1. The aggregated `totalWeight` will be ≤ 0.3 (since self-attestations carry 0.3 type weight)
2. Queriers SHOULD treat `totalWeight < 0.5` as **low confidence** — no external validation exists
3. Recommended thresholds:
   - `totalWeight >= 1.0` — sufficient confidence for automated decisions
   - `0.5 <= totalWeight < 1.0` — moderate confidence, may require additional signals
   - `totalWeight < 0.5` — low confidence, self-reported only, treat as unverified
4. Queriers MAY display self-only attestations with a visual indicator (e.g., "⚠ self-reported only")
5. Self-only status is itself a signal: the agent either has no transaction partners or none have attested

### Stale Service Detection

A service may become inactive without explicit removal. Queriers detect this via decay:

1. If all attestations for a service have effective weight below a threshold (recommended: `0.05`), the service is likely inactive
2. Specifically: `effectiveWeight = decayWeight × typeWeight`. If `max(effectiveWeight) < 0.05` across all attestations, flag as stale
3. A 30-day half-life attestation reaches 0.05 effective weight after approximately 130 days (for bilateral) or 37 days (for self)
4. Queriers SHOULD:
   - Display stale services with an indicator (e.g., "last attested 6 months ago")
   - Exclude stale services from automated discovery results
   - NOT delete stale attestations — they provide historical record
5. Service providers SHOULD publish periodic self-attestation updates (weekly or monthly) to signal liveness

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


### v0.2 (2026-03-19) — Reference Implementation + Live Relay Test
- [x] Built Node.js reference implementation (`src/cli.js`, `src/lnd.js`, `src/attestation.js`, `src/keys.js`)
- [x] Collected real metrics from LND: 2 active channels, 20/20 payments succeeded (100% success rate), 1.4M sats capacity, 100% uptime
- [x] Published kind 30078 self-attestation to 4 relays: relay.damus.io, nos.lol, relay.nostr.band, relay.snort.social — **all 4 accepted**
- [x] Event ID: `eb12c36dcd1384e2061094782f5f575bd30989047483423fff8141ec5a00440a`
- [x] **Discovered spec bug:** `p` tag cannot hold LND node pubkeys (33-byte / 66 hex compressed secp256k1). Nostr `p` tags expect 32-byte (64 hex) x-only pubkeys. Fix: use `node_pubkey` custom tag for LND pubkey; reserve `p` tag for agent's Nostr identity if available.
- [x] Spec updated with `node_pubkey` tag clarification and warning note

### v0.4 (2026-03-19) — Integration Test + Handler Declaration + Edge Cases
- [x] Built `src/handler.js`: `buildServiceHandler()`, `parseServiceHandler()`, `queryServiceHandlers()` — kind 31990 handler declaration
- [x] CLI command added: `handler` — publish service handler declaration with `--id`, `--desc`, `--price`, `--protocol`, `--endpoint` flags
- [x] Built `src/test-integration.js`: 64/64 tests pass — full lifecycle: handler → transactions → bilateral attest → self attest → aggregation → edge cases
- [x] **Phase 1-4:** Handler declaration, transaction recording, bilateral + self attestation build/verify — all green
- [x] **Phase 5:** Aggregation confirmed: bilateral (weight 1.0) dominates self (weight 0.3). Math: (0.97×0.3 + 0.8×1.0)/1.3 = 0.839
- [x] **Phase 6:** Self-only edge case validated: totalWeight=0.3, below 0.5 trust threshold → flags as unverified
- [x] **Phase 7:** Stale service detection validated: 180-day-old self-attestation has effective weight 0.005 (< 0.05 threshold)
- [x] **Phase 8:** Future timestamp clamping confirmed: decay clamped to 1.0, negative age detected
- [x] **Phase 9:** Multi-attester aggregation (3 attesters): weighted avg 0.909 — math checks out
- [x] **Phase 10:** Full JSON serialization round-trip for handler events, bilateral events, and transaction history
- [x] Spec updated: added "Querier Behavior: Self-Attestation Only" section with trust threshold recommendations
- [x] Spec updated: added "Stale Service Detection" section with decay-based inactivity detection

### v0.3 (2026-03-19) — Bilateral Attestation Implementation + Live Test
- [x] Built `src/bilateral.js`: `TransactionRecord`, `TransactionHistory`, `buildBilateralAttestation()`, `buildBilateralFromHistory()`
- [x] 44/44 unit tests pass (`src/test-bilateral.js`): construction, dimension computation, event building, parsing, mixed aggregation, serialization round-trip, validation
- [x] CLI commands added: `record` (log transaction), `history` (view tx history), `attest` (build+publish bilateral)
- [x] Transaction history persistence via `.tx-history.json` (git-ignored)
- [x] **Live relay test:** Published bilateral attestation for ACINQ node → accepted by all 4 relays
- [x] **Event ID:** `14458374175d55aa532ec12a19e934707487614fc6b9d69498ac7f8531a66068`
- [x] **Aggregation confirmed:** Querying our Nostr pubkey returns both self + bilateral attestations, properly weighted (bilateral 1.0 > self 0.3)
- [x] Spec updated: added `transaction_volume_sats` standard dimension
- [x] Replaced relay.nostr.band (still EHOSTUNREACH) with relay.primal.net in code; confirmed all 4 relays working
- [x] Key validation: bilateral attestation type dominates self in weighted average (0.7434 settlement rate = blend of self 1.0 @0.3 weight + bilateral 0.6667 @1.0 weight) — math checks out

### v0.2.1 (2026-03-19) — Query Pipeline Validated + Decay Math Proven
- [x] **Debugged query failure:** Previous session recorded wrong event ID & hex pubkey. Live event found on 3/4 relays (relay.nostr.band unreachable — EHOSTUNREACH).
- [x] **Query by Nostr pubkey (64 hex) — works:** `node src/cli.js query 1bb7ae...` → found 1 attestation, parsed correctly
- [x] **Query by LND node pubkey (66 hex) — works:** `node src/cli.js query 03b8a5da...` → found via `#L` filter + post-filter on `node_pubkey` tag
- [x] **Aggregation pipeline works:** decay-weighted average with type weighting (self=0.3, bilateral=1.0) verified
- [x] **Decay math validated** (`src/test-decay.js`): all checkpoints pass — 1 half-life=0.5, 2=0.25, 5=0.031, 10=0.001, custom half-life works
- [x] **Found spec gap:** Future timestamps produce weight > 1.0. Added MUST clamp to [0, 1.0] + SHOULD penalize future timestamps
- [x] relay.nostr.band down (EHOSTUNREACH) — may need alternate relay. Others (damus, nos.lol, snort.social) all working.

**Publishing keypair (attestation-only, no funds):**
- npub: `npub1rwm6u3czqv63xzuk2n3uzd3nlyjyd3r306zelq45de3kxyvvd6ksfdw2wu`
- hex: `1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead`
- nsec saved in `.nostr-nsec` (git-ignored)

### v0.1 (2026-03-19) — Initial Draft
- [x] Core event format defined
- [x] 6 standard dimensions specified
- [x] Decay mechanism with configurable half-life
- [x] Attestation types (self/bilateral/observer)
- [x] Service handler declaration (kind 31990)
- [x] Query flow described
- [x] Privacy and security considerations

### TODO — v0.2 (COMPLETE)
- [x] Write reference implementation (Node.js) that publishes self-attestation from our LND data
- [x] Test: publish a real kind 30078 event to relays with our actual node metrics
- [x] Test: query and parse the attestation back (fixed: wrong pubkey in notes; works on 3/4 relays)
- [x] Validate decay math with real timestamps (all checkpoints pass; found & fixed future-timestamp spec gap)
- [x] Write a query client that aggregates attestations for a given pubkey (CLI: `node src/cli.js query <pubkey>`)
- [x] Replace relay.nostr.band (down) with relay.primal.net — confirmed working

### TODO — v0.3 (COMPLETE)
- [x] Reference implementation for bilateral attestation (post-transaction auto-publish)
- [x] Aggregation library (takes N attestations, applies decay, returns weighted dimensions) — built into attestation.js
- [x] Edge case: what happens when an agent has only self-attestations? (document recommended querier behavior) — spec section added + tested
- [x] Edge case: attestation for a service that no longer exists (stale service detection) — spec section added + tested
- [x] Integration test: full cycle (declare handler → transact → bilateral attest → query) — 64/64 tests pass

### TODO — v0.4
- [ ] Get feedback from 34b4 and fc29 on the spec
- [ ] Consider: should service_type be from a controlled vocabulary or free text?
- [ ] Consider: minimum sample_size thresholds for attestation validity
- [ ] Consider: NIP-89 handler advertisement vs kind 31990
- [ ] Observer attestation type implementation
- [ ] Sybil resistance: weighted web-of-trust scoring (attester reputation affects attestation weight)
- [ ] CLI: `node src/cli.js publish --auto` for cron-based periodic self-attestation updates
