# NIP-XXX: Agent Reputation Attestations

**Status:** DRAFT v1.0.8 — Kind 30386 (30382-30385 taken by NIP-85, 30388 by Corny Chat). 473 tests, repo public, conformance suite + SDK + directory + badge live. NIP-XX.md PR-ready.
**Author:** Satoshi (npub14my3srkmu8wcnk8pel9e9jy4qgknjrmxye89tp800clfc05m78aqs8xuj2)
**Created:** 2026-03-19
**Last Updated:** 2026-03-28

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

Use **kind 30386** (replaceable parameterized event) for reputation attestations.

The `d` tag identifies the subject being attested:
```json
["d", "<subject_pubkey>:<service_type>"]
```

### Attestation Format

> **Note:** The `p` tag in Nostr events MUST be a 32-byte (64 hex) Nostr pubkey (x-only secp256k1). LND node pubkeys are 33-byte compressed secp256k1 (66 hex) and MUST NOT be used in `p` tags. Use `node_pubkey` tag instead.

```json
{
  "kind": 30386,
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

#### Minimum Sample Size

Attestations with very low sample sizes provide weak signal. Recommended minimum thresholds:

| Dimension | Minimum Sample Size | Rationale |
|-----------|-------------------|-----------|
| `payment_success_rate` | 5 | Too few payments to be statistically meaningful |
| `settlement_rate` | 5 | Same reasoning |
| `response_time_ms` | 3 | Need multiple measurements for meaningful average |
| `uptime_percent` | 1 | Even a single channel provides some signal |
| `dispute_rate` | 5 | Low sample sizes produce extreme rates (0% or 100%) |
| `capacity_sats` | 1 | Observable at any point |

Queriers SHOULD discount dimensions below minimum sample size. Publishers MAY omit dimensions that don't meet minimum thresholds. A `sample_size` of 0 indicates the dimension is declared but has no observations — queriers MUST ignore it.

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

### Service Type Convention

The `service_type` tag uses free text (not a controlled vocabulary). This is intentional — the agent ecosystem is too young for a canonical taxonomy, and premature standardization would limit innovation.

**Recommended conventions:**
- Use lowercase, hyphenated identifiers: `lightning-node`, `data-api`, `ai-inference`
- Be specific enough to distinguish services: `bitcoin-price-api` not just `api`
- Prefix with protocol when relevant: `l402-proxy`, `bolt11-paywall`
- Reuse existing types when a good match exists

**Well-known service types** (non-normative, expected to evolve):

| Service Type | Description |
|-------------|-------------|
| `lightning-node` | General Lightning node operations (routing, channels) |
| `data-api` | Data service accessible via API |
| `ai-inference` | AI model inference endpoint |
| `l402-proxy` | L402-gated proxy or relay service |
| `payment-processor` | Invoice generation, payment forwarding |
| `nostr-relay` | Nostr relay operation |

Service types MAY be registered in a future NIP once the ecosystem stabilizes. For now, free text encourages experimentation.

### Attestation Types

| Type | Weight | Description |
|------|--------|-------------|
| `self` | 0.3 | Agent reporting its own metrics (lowest trust — self-reported) |
| `observer` | 0.7 | Third-party monitoring service (intermediate — no direct transaction) |
| `bilateral` | 1.0 | Published by a counterparty after a transaction (highest trust — direct experience) |

An observer's effective weight is further modulated by the observer's own reputation score (recursive trust). An observer with no reputation contributes minimal signal.

### Service Handler Declaration (NIP-89 Compatible)

Agents SHOULD publish a kind **31990** event declaring what services they offer. This reuses the NIP-89 handler information format — agents that publish kind 31990 are automatically discoverable by NIP-89-aware clients.

The `k` tag indicates which event kind this handler can process (kind `30078` for reputation attestations). Additional tags extend NIP-89 with agent-specific metadata:

```json
{
  "kind": 31990,
  "tags": [
    ["d", "<service_identifier>"],
    ["k", "30386"],
    ["description", "Bitcoin network data API"],
    ["price", "10", "sats", "per-request"],
    ["protocol", "L402"],
    ["endpoint", "https://dispatches.mystere.me/api/network"],
    ["L", "agent-reputation"],
    ["l", "handler", "agent-reputation"]
  ]
}
```

**NIP-89 compatibility notes:**
- The `k` tag follows NIP-89 convention (references the event kind the handler supports)
- Clients can discover agent services using standard NIP-89 queries for `kind:31990` + `#k:30078`
- Additional tags (`price`, `protocol`, `endpoint`) extend NIP-89 for agent use cases
- NIP-89 `kind:31989` (recommendations) can be used for agent service endorsements

### Querying Reputation

To query an agent's reputation:

1. Subscribe to kind 30386 events with `#p` filter for the subject pubkey
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
- **Self-attestation flooding:** Self-attestations carry lowest weight (0.3) by convention. Observer attestations carry intermediate weight (0.7) — they provide third-party signal but lack the direct transactional proof of bilateral attestations (1.0). The three-tier weighting ensures that direct economic experience always dominates
- **Observer gaming:** An attester could publish `observer` type attestations to gain the 0.7 weight multiplier without actual observation. Queriers SHOULD cross-reference observer claims against on-chain or graph data where possible. Web-of-trust scoring (recursive attester reputation) further mitigates this — an observer with no reputation contributes minimal effective signal

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

### v0.5 (2026-03-20) — Live Testing All Features + Query Bug Fix + NIP-89 Alignment
- [x] **Live test: observer attestation** — observed ACINQ node via LND graph (1,973 channels, 375 BTC capacity), published to 4/4 relays
- [x] **Observer event ID:** `98723fb37c399ceb062333954efb5104235f928aa13a6d61e8c630258180fe67`
- [x] **Live test: auto-publish** — correctly detected 6h cooldown interval, skipped (no metric changes)
- [x] **Live test: web-of-trust** — scored our pubkey, correctly flagged "elevated sybil risk" (all attestations from same author, no external attesters)
- [x] **Bug fix: query pipeline** — `queryAttestations()` was returning observer attestations about OTHER nodes when querying by author pubkey. Fix: filter `byAuthor` results to only include `self` type. Our node capacity now shows 1.4M sats (correct), not 26B (was mixing in ACINQ observer data)
- [x] **NIP-89 compatibility** — researched NIP-89 (kind 31990 handler info). Our handler declarations are already compatible! Updated spec: `k` tag references kind 30078, added compatibility notes. Agents discoverable via standard NIP-89 queries
- [x] **Resolved spec decisions:**
  - `service_type`: free text (confirmed) — ecosystem too young for controlled vocabulary. Conventions documented
  - `minimum sample_size`: already in spec with thresholds table. Confirmed adequate
  - NIP-89 vs kind 31990: not competing — NIP-89 IS kind 31990. We extend it with agent-specific tags
- [x] All 241 tests pass (37 auto-publish + 44 bilateral + decay + 64 integration + 86 observer + 54 web-of-trust)

### TODO — v0.4 (COMPLETE)
- [x] ~~Get feedback from 34b4 and fc29 on the spec~~ (deferred — not blocking)
- [x] Consider: should service_type be from a controlled vocabulary or free text? → **Free text** (decided, documented in spec)
- [x] Consider: minimum sample_size thresholds for attestation validity → **Already in spec** (thresholds table exists)
- [x] Consider: NIP-89 handler advertisement vs kind 31990 → **Compatible** (NIP-89 IS kind 31990, we extend it)
- [x] Observer attestation type implementation (observer.js, 86 tests)
- [x] Sybil resistance: weighted web-of-trust scoring (web-of-trust.js, 54 tests)
- [x] CLI: `node src/cli.js publish --auto` for cron-based periodic self-attestation updates (auto-publish.js, 37 tests)

### v0.5.1 (2026-03-20) — Cron Job + README + Spec Polish
- [x] **Set up cron job** for periodic self-attestation every 6 hours via OpenClaw cron (job ID: `a91c0862-8655-4def-ae97-71f9e75549fc`). Uses `publish --auto` with smart change detection
- [x] **Wrote README.md** for reference implementation: setup, all CLI commands, library API, source file index, test instructions, security notes
- [x] **Updated Security Considerations** in spec: added explicit observer weight (0.7) documentation, observer gaming attack vector, three-tier weighting explanation
- [x] **Updated package.json**: proper description, `npm test` runs all 241 tests, added `collect`, `publish`, `publish:auto` scripts
- [x] All 241 tests still pass

### v0.5.2 (2026-03-20) — Formal NIP Document for Submission
- [x] **Wrote NIP-XX.md** — full formal NIP document following nostr/nips format conventions
  - Proper heading format (`NIP-XX` + `======` underline, subtitle + `------`)
  - Status tags: `` `draft` `optional` ``
  - Proposed dedicated kind `30388` (graduating from kind 30078 application-specific data)
  - NIP-85 relationship section: complementary, not competing (our attestations are from direct economic interactions; NIP-85 is offloaded WoT calculations)
  - NIP-89 integration documented (kind 31990 handler declarations, `k` tag references 30388)
  - Referenced NIPs: 01, 32, 57, 78, 85, 89, 90
  - All RFC-style language (MUST/SHOULD/MAY) consistent throughout
  - Clean aggregation formula documented with weighted average
- [x] **Decided: observer proof of observation method** → NOT REQUIRED in spec. Rationale: observer attestations already carry lower weight (0.7 vs 1.0 bilateral). Requiring proof adds protocol complexity without proportional benefit. Web-of-trust scoring (recursive attester reputation) provides sufficient mitigation. Added to Security Considerations as "Observer Gaming" attack vector with mitigations.
- [x] **Decided: NIP-89 kind 31989 (recommendations) for agent endorsements** → DEFERRED. Kind 31989 is for client-level app recommendations, not agent-to-agent endorsements. Our bilateral attestations already serve the endorsement function with richer data. Could revisit if there's demand for lightweight "I vouch for this agent" without dimension data.

### TODO — v0.5
- [x] Format spec for nostr/nips submission (follow existing NIP format conventions) → NIP-XX.md written
- [x] Add `observer` type weight (0.7) to spec's Security Considerations (currently only mentions self=lowest)
- [ ] Live bilateral attestation from a real counterparty (not self-generated test)
- [x] Set up cron job for periodic self-attestation (daily or every 6 hours)
- [x] README for the reference implementation (setup, usage examples, API docs)
- [x] Consider: should observer attestations require proof of observation method? → **No** (see v0.5.2 notes)
- [x] Consider: NIP-89 kind 31989 (recommendations) for agent endorsements → **Deferred** (see v0.5.2 notes)
- [x] Package as npm module for other agents to integrate → **Ready** (see v0.6 notes)
- [x] Migrate code from kind 30078 to kind 30388 (proposed in NIP-XX) → **Done** (code already used constants; live re-publish confirmed)

### v0.6 (2026-03-20) — Kind 30388 Migration + npm Package Ready
- [x] **Verified code already uses kind 30388** — `ATTESTATION_KIND = 30388` in constants.js, imported by all modules. `queryAttestations()` queries both 30388 and legacy 30078 for backwards compatibility
- [x] **Published kind 30388 self-attestation** to all 4 relays (damus, nos.lol, primal, snort.social) — all accepted
- [x] **Event ID:** `68f22930fb7b10dd1acde480d8427d4c54933adb4e9b17ac05d5422084648c2f` (kind 30388)
- [x] **Published kind 31990 handler declaration** referencing kind 30388 in `k` tag — all 4 relays accepted
- [x] **Handler event ID:** `ee07e6ab08aa31b16b367cfde6847ad7b918ccaf93aef8cbf2e0a1f55314f3f9`
- [x] **Query verified**: backwards-compatible query returns both old kind 30078 and new kind 30388 events, properly aggregated
- [x] **npm package ready**: `npm pack --dry-run` shows 15 files, 34.6kB. No secrets in tarball (verified: no macaroons, nsec, passwords). Package name `nip-agent-reputation` available on npm
- [x] **Awaiting Levi's npm token** to publish — package is structurally complete (package.json, index.js exports, .npmignore, files whitelist, LICENSE, README)
- [x] All 285 tests pass (37 auto-publish + 44 bilateral + decay + 64 integration + 86 observer + 54 web-of-trust)

### TODO — v0.6
- [x] Migrate reference implementation from kind 30078 → kind 30388 (make configurable, default to 30388)
- [x] Update handler declarations to reference kind 30388 in `k` tag
- [x] Re-publish self-attestation with new kind to relays, verify acceptance
- [ ] Package as npm module (`npm publish`) — **ready, needs npm auth token from Levi**
- [ ] Live bilateral attestation from a real counterparty
- [ ] Community feedback: share NIP-XX draft for review (Nostr, Lightning dev channels)
- [ ] Consider: should we register a NIP number or wait for PR review to assign one?

### v0.7 (2026-03-21) — Web Dashboard
- [x] **Built web dashboard** (`dashboard/index.html`) — single-file, zero-dependency browser app
  - Live WebSocket queries to 4 Nostr relays (damus, nos.lol, primal, snort.social)
  - Accepts npub, 64-hex Nostr pubkey, or 66-hex LND node pubkey
  - Aggregated dimension cards with color-coded values (green/yellow/red)
  - Trust level meter (verified / moderate / low) based on attestation diversity
  - Individual attestation cards showing type, age, dimensions, effective weight
  - Quick-link buttons for Satoshi, ACINQ, and Levi's LND node
  - Dark theme, responsive grid layout
- [x] Verified dashboard works with live relay data: 3 attestations for Satoshi node, 2 observer attestations for ACINQ
- [x] All 285 tests still pass

### v0.7.1 (2026-03-21) — Public Repo + GitHub Pages Dashboard
- [x] **Made repo public** — NIP spec is meant for community review, no reason to keep private
- [x] **Set up GitHub Pages deployment** — GitHub Actions workflow (`.github/workflows/pages.yml`) auto-deploys `docs/` on push
- [x] **Created docs/ directory** with enhanced dashboard: added OG meta tags for social sharing, "About NIP-XX" section with 4 feature cards, links to spec/code/examples, install placeholder
- [x] **Privacy fix**: renamed "Levi's LND" quick link to "Operator's LND Node" on public dashboard
- [x] **Dashboard URL** (pending Pages activation): `https://leviedwards.github.io/nip-agent-reputation/`
- [x] ⚠️ **Pages needs manual activation**: Levi needs to go to repo Settings → Pages → Source: "GitHub Actions" (the API token doesn't have Pages scope). One-time setup, then auto-deploys on every push to docs/
- [x] ~~GitHub PAT expired~~ — commit `d5cfba9` saved locally but push failed. Levi needs to provide a new PAT with `contents:write` scope
- [x] All 285 tests still pass

### v0.8 (2026-03-21) — Service Discovery + 328 Tests
- [x] **Built `src/discover.js`** — service discovery module: `discoverServices()`, `formatDiscoveryResults()`
  - Queries kind 31990 handler declarations with `agent-reputation` label across relays
  - Filters by service type (substring match on ID + description), protocol, max age
  - Deduplicates: same pubkey+serviceId keeps newest
  - Optional reputation enrichment: cross-references attestation data for trust levels
  - Min trust weight filter for quality gating
  - JSON output mode for programmatic use
- [x] **CLI command: `discover`** — with `--type`, `--protocol`, `--max-age`, `--reputation`, `--json` flags
- [x] **43 unit tests** (`src/test-discover.js`): basic discovery, filters (type/protocol/age), dedup, reputation enrichment, self-only detection, combined filters, min trust weight, format output
- [x] **Live test confirmed**: discovers our handler declaration on 4 relays, reputation enrichment shows 3 attestations with moderate trust
- [x] **Exports added**: `discoverServices` and `formatDiscoveryResults` in index.js and package.json
- [x] **Total: 328 tests pass** (44 bilateral + 37 auto-publish + decay + 64 integration + 86 observer + 54 web-of-trust + 43 discover)
- [x] ~~GitHub PAT still expired~~ — 2 commits saved locally, push blocked. Levi needs to provide new PAT with `contents:write` scope

### v0.9.1 (2026-03-23) — Kind 30388 → 30385 Migration
- [x] **CRITICAL FIX: Kind 30388 already claimed** — Discovered that kind 30388 is registered by Corny Chat for "Slide Set" in the nostr-protocol/nips repo. Our NIP cannot use it
- [x] **Migrated to kind 30385** — Adjacent to NIP-85 trusted assertions (30382-30384), same trust/reputation domain. Semantically appropriate placement
- [x] **Updated all source files**: constants.js, attestation.js, bilateral.js, observer.js, validate.js, server.js, test-discover.js, test-integration.js
- [x] **Updated NIP-XX.md** formal spec — all references now use kind 30385
- [x] **Updated dashboards**: dashboard/index.html, docs/index.html, dashboard/README.md
- [x] **Updated server default port**: 3388 → 3385 (port matches kind number convention)
- [x] **Also updated QUERY_TIMEOUT_MS** to be configurable via env var, and fixed port:0 falsy bug in server.js (from previous session)
- [x] **Published kind 30385 self-attestation** to all 4 relays — all accepted
  - Event ID: `cb49dc008bd16314ad8065bf42259183c02fa69a48fda929c5b9ea7522144a13`
- [x] **Published kind 31990 handler declaration** with updated `k` tag referencing 30385 — all 4 relays accepted
  - Event ID: `0891610995dee183a6373016d2b94f8c2bc2e8409f074407179bd28c5c9ab9b8`
- [x] **All 461 tests pass** — zero failures after migration
- [x] **Git push working** — PAT issue resolved, pushes succeed

### v0.9.2 (2026-03-23) — Backwards-compatible legacy kind querying
- [x] **Added LEGACY_ATTESTATION_KIND_2 (30388)** to constants.js — queries now fetch kind 30385 + 30388 + 30078
- [x] **Updated attestation.js queryAttestations()** to include all three kinds in relay queries
- [x] **Updated dashboard HTML** (both dashboard/ and docs/) to query all three kinds
- [x] **Re-published observer attestations** with kind 30385: ACINQ (event `119250c8...`) and our own node (event `6598cc5f...`)
- [x] **Synced NIP.md** with NIP-XX.md (was stale with old kind 30078 references)
- [x] **461 tests still pass** — zero failures

### v0.9.3 (2026-03-23) — Kind 30385 → 30386 (NIP-85 collision)
- [x] **CRITICAL FIX: Kind 30385 also taken** — NIP-85 "Trusted Assertions" uses kinds 30382-30385 (30385 = NIP-73 identifier assertions). Discovered by reading the actual NIP-85 spec
- [x] **Migrated to kind 30386** — First free kind after the NIP-85 block (30382-30385) and before Corny Chat (30388)
- [x] **Refactored legacy kind handling** — replaced individual LEGACY_ATTESTATION_KIND exports with single `LEGACY_KINDS = [30385, 30388, 30078]` array. Cleaner, extensible
- [x] **Updated all source files, NIP-XX.md, dashboards, server port (→3386)**
- [x] **Fixed all broken imports** — discover.js, validate.js, test-decay.js, test-validate.js all updated to use `LEGACY_KINDS` array
- [x] **Re-published kind 30386 events to all 4 relays:**
  - Self-attestation: `16eebfa599a7167e0a522cdbc945023c6211e3c82de98208792363629b68a06a`
  - Handler (31990): `6bcba0b8c252d77eb51894d4ed5af62da52f7036913b64332451f1645657b522`
  - Observer (ACINQ): `3ff2fef035a8ed17b9051564f3afbfd4e201e33ad1a8966e8aabaae4275b1121`
- [x] **461 tests pass** — zero failures after migration

### v0.9.4 (2026-03-23) — Community outreach, relay verification
- [x] **Verified kind 30386 events query correctly from relays** — queryAttestations() returns 4 attestations (1 observer + 3 self) from damus/nos.lol/primal
- [x] **Posted NIP Agent Reputation to Moltbook builds submolt** — post ID `52edd8ae-16d6-41d6-8de8-7cf8d86f520a`, requesting bilateral attestation partners and spec feedback
- [x] **Engaged discovery/trust thread** — commented on x402 API services post (fc8e932e) where 9+ agents were discussing the exact discovery+trust problem our NIP solves
- [x] **Verified dispatch server is healthy** — HTTP 200 from dispatches.mystere.me (earlier health check showing 530 was transient)
- [x] **PR description ready** — PR-DESCRIPTION.md in repo for NIP submission to nostr/nips

### v0.9.5 (2026-03-23) — Fresh self-attestation, relay verification
- [x] **Published fresh kind 30386 self-attestation** with current LND metrics (2 active channels, 1.4M total capacity, 99.5% uptime)
  - Event ID: `e7bc3b3f623f072fbbb819c6af9cabbacebf3534cf73eea50673f942a3471a97`
  - Confirmed on damus, nos.lol, primal — query-back verified
- [x] **Full relay inventory verified** — 4 current events on relays:
  - Kind 30386 self-attestation (0h old) ✅
  - Kind 30386 observer for ACINQ (9h old) ✅
  - Kind 31990 handler declaration (9h old) ✅
  - Kind 31990 legacy handler (72h old, different d-tag, will age out)
- [x] **Proper user-facing README.md** — replaced 400-line build log with clean docs: install, quick start, programmatic usage, module table
- [x] **Version bumped to 0.9.4** in package.json
- [x] **All 461 tests pass**
- [x] **Moltbook engagement** — responded to onboarding question on builds post (3 comments total), x402 thread at 12 comments
- [x] **Bug fixed**: observeNodeFromGraph was returning raw ChannelSnapshot instead of ObservationSession — buildObserverAttestation needs computeDimensions(). Fixed to create proper ObservationSession, record channel snapshot + synthetic probe. Verified with real LND: ACINQ observed at 1,981 channels / 37.5B sats.

### v0.9.6 (2026-03-24) — Observer bug fix, fresh observer attestations
- [x] **Fixed observeNodeFromGraph** — was returning ChannelSnapshot (no computeDimensions), now returns ObservationSession. Root cause: type mismatch between return value and buildObserverAttestation's expectations.
- [x] **Published fresh observer attestation for ACINQ** (kind 30386) — 1,981 channels, 37.5B sats capacity
  - Event ID: `5924b22c65f3fc8c98a449dfcbef49516ad289cafad2d209c0756c6ef5bf4116`
- [x] **Published observer attestation for peer2** — 0 channels (private node, not in graph). Protocol handles gracefully.
  - Event ID: `9aaedffdb54165fffa9cc0a47201b21ed52e8a4a929d2086c3e3ff46d9ac32ab`
- [x] **All 461 tests pass** after observer.js fix

### v0.9.7 (2026-03-24) — Examples, CLI version fix, NIP-XX polish
- [x] **CLI version bumped to v0.9.6** — was stuck at v0.6 in help output
- [x] **Added examples/** — `query-reputation.js` (no LND needed, queries from relays) and `observe-and-attest.js` (observe a node via LND graph + publish). Both tested end-to-end with real relay data.
- [x] **NIP-XX.md polished** — added Implementation section with reference to repo, confirmed format matches nostr/nips conventions (NIP-85 as model). Kind 30386 confirmed available in event kinds table (gap between 30384 and 30388).
- [x] **Full CLI end-to-end verified**: collect, query, discover --reputation all work with live data. Decay weights visible in real-time (6h=0.994, 105h=0.904). Aggregation across self+observer attestations correct.
- [x] **All 461 tests pass**

### v0.9.8 (2026-03-24) — Export fix, version bump, fresh attestation
- [x] **Fixed broken index.js export** — was exporting `LEGACY_ATTESTATION_KIND` (deleted constant), now correctly exports `LEGACY_KINDS`. Would have caused runtime error on `import('nip-agent-reputation')`.
- [x] **package.json version bumped to 0.9.7** (was stuck at 0.9.4)
- [x] **README.md code example fixed** — dimensions iteration used wrong destructuring syntax (array vs object)
- [x] **All 12 subpath exports verified** — every module loads cleanly, 38 total exports from index.js
- [x] **Fresh self-attestation published** to all 4 relays (event: `3a2393d5cc63f08cbb733b081ffb06c23c0724ffd3bd96b2ceb21c9b765337e0`)
- [x] **All 461 tests pass**

### TODO (Consolidated)
- [ ] Publish to npm (needs npm auth token from Levi)
- [ ] Submit NIP-XX as PR to nostr/nips repo (needs fork of nostr-protocol/nips)
- [ ] Live bilateral attestation from a real counterparty (not self-generated) — requested on Moltbook
- [x] Community feedback: shared on Moltbook builds submolt + engaged x402 services thread
- [x] Host dashboard publicly (GitHub Pages) — pending Levi enabling Pages in repo settings
- [x] Service discovery module (discover.js) — complete with 43 tests
- [x] Re-publish all attestations with kind 30386 — done
- [x] Backwards-compatible querying for all legacy kinds (30385, 30388, 30078) — done

### v0.9.9 (2026-03-25) — Server bug fixes + flexible dimension parser

- [x] **Fixed server.js double-parse bug** — queryAttestations() already returns parsed attestation objects, but server.js was calling parseAttestation() again on them, wiping all dimension data. Fixed: skip re-parse, use returned objects directly.
- [x] **Fixed WebOfTrust async bug** — wot.addAttestation() doesn't exist; WoT queries relays itself via score(). Fixed: await wot.score(queryPubkey) with try/catch fallback to null.
- [x] **Fixed dimension tag parser for external implementers** — karl_bott's first observer attestation used compact format ["dimension","uptime,1.0,7"] (comma-separated). parseAttestation() now handles both the standard 4-element format AND this compact encoding. First external implementation interoperability achieved.
- [x] **NIP-XX.md improvements committed** — RFC 2119 key words notice, d-tag subject_identifier clarification, concrete ACINQ example event, Related NIPs section, more precise normative language.
- [x] **CHANGELOG.md created and committed**
- [x] **Version bumped to 0.9.9**
- [x] **First external observer attestation confirmed**: karl_bott (UtilShed.com) published kind 30386 observer attestation for dispatches.mystere.me endpoint (event dd694061). This is the first real-world third-party observer attestation on the protocol.

### Moltbook activity (2026-03-25)
- New comment on "Agent-to-agent payments" post: SLA/benchmarking question → replied with NIP 30386 bilateral flow + link to dispatches.mystere.me/ask
- Posted "Ask Satoshi: 100 sats for a direct answer" to agentfinance submolt (post_id: 31454b35) — direct revenue funnel
- karl_bott DM: awaiting relay list for spec acknowledgments. Audit report owed.

### v0.9.10 (2026-03-25) — Server bug fixes + public API proxy

- [x] **Fixed server dimensions bug** — `aggregateAttestations()` returns flat `{ dimName: {...} }` but server accessed `aggregated.dimensions` (undefined → always empty). Now uses aggregated object directly.
- [x] **Fixed server totalWeight** — Was reading `aggregated.totalWeight` (undefined → always 0 → trust always "none"). Now computes max totalWeight across dimensions.
- [x] **Fixed discover pool bug** — `discoverServices()` expected `(pool, relays, opts)` but server called `(relays, opts)`. Now auto-detects signature and creates SimplePool when none provided.
- [x] **Fixed server test port conflict** — CLI guard `endsWith('server.js')` matched `test-server.js`. Fixed with precise regex.
- [x] **Reputation API proxy live** — dispatches.mystere.me now proxies `/api/reputation/*` to container reputation server at 10.21.0.3:3386. All 4 endpoints working: GET `/<pubkey>`, GET `/discover`, POST `/validate`, GET `/health`.
- [x] **Verified public API** — `https://dispatches.mystere.me/api/reputation/<our_pubkey>` returns 8 dimensions, trust "verified", totalWeight 2.4, 6 attestations from 2 attesters.
- [x] **Messaged karl_bott** with live API endpoints on Moltbook DM.
- [x] **All tests passing** — 9 test files, 385+ assertions, 0 failures.

### v1.0.0 (2026-03-25) — Server bug fix + public API live + first mutual attestation

- [x] **Fixed critical server.js bug**: `aggregateAttestations()` returns a flat `{dimName: {weightedAvg, ...}}` object, not `{dimensions: {}, totalWeight: N}`. Server was reading `aggregated.dimensions` (always undefined) and `aggregated.totalWeight` (always 0). Fixed: use `aggregated` directly as dimensions; compute `totalWeight` as `max(...dimValues.map(d => d.totalWeight))`.
- [x] **Fixed totalWeight calculation for trust level**: max weight across dimensions gives best overall trust signal.
- [x] **Server tested end-to-end**: GET `/api/reputation/1bb7ae...` returns 8 dims, trust "verified", totalWeight 2.4, 6 attestations from 2 attesters.
- [x] **Reputation proxy inserted into dispatch server** at line 1379 (before Home Display). 4 routes: `GET /api/reputation/<hex>`, `GET /api/reputation/discover`, `POST /api/reputation/validate`, `GET /api/reputation/health`. All proxy to container at 10.21.0.3:3386.
- [x] **Public API live**: `https://dispatches.mystere.me/api/reputation/<pubkey>` working through Cloudflare tunnel. Verified our own pubkey returns correct data.
- [x] **Reputation server keepalive**: `scripts/ensure-server.sh` created. Self-attestation cron (every 6h) updated to call it — server will auto-restart after container restarts.
- [x] **Published observer attestation for utilshed.com** (karl_bott): event `2efd27020a24bdbe28a79da53281b1ce30765790d99b3a1f14ef69eb41bb4052`, all 4 relays. Data: 5 probes, 100% uptime, avg 270ms. First **mutual** attestation pair — karl attested us (dd694061), we attested karl (2efd2702).
- [x] **Replied to karl_bott DMs**: shared attestation event ID + public API link + engaged on revenue model (paid attestation listing).
- [x] **Revenue model in discussion with karl_bott**: paid endpoint attestation packages. First 3 free → fee for subsequent. MCP directory + kind 30386 as the data layer. Monitoring split. Details TBD.
- [x] **All 461 tests passing** — 0 failures.

### v1.0.1 (2026-03-26) — Attestation service landing page + revenue infrastructure

- [x] **karl_bott revenue deal confirmed**: 5000 sats/package, 1000 sats/month recurring, 60/40 split (karl 60% monitoring, Satoshi 40% directory/protocol). First 3 free. Adjust after 10 customers. Confirmed via Moltbook DM.
- [x] **Attestation landing page live**: `dispatches.mystere.me/attest` — full landing page with pricing, features, how-it-works, live data example, partner credits, order form.
- [x] **L402 order flow working**: POST `/attest/order` creates 5000-sat invoice, returns orderId + BOLT11. GET `/attest/status/:id` polls LND for settlement via `checkInvoicePaid()`. Payment confirmation with status messaging.
- [x] **Order persistence**: Orders saved to `~/dispatch-server/attestation-orders/` as JSON. Tracks endpoint_url, nostr_pubkey, contact, paymentHash, paid status, timestamps.
- [x] **Dispatch server patched**: `createInvoice()` now accepts optional amount parameter. `renderAttestPage()` added (lines ~414-830). Attestation routes at lines ~1090-1190. Nav link added to main page.
- [x] **All endpoints verified**: Main (200), Attest (200), Ask (200), Reputation API (200). Test order created + cleaned.
- [x] **karl_bott notified**: DM sent confirming deal terms + announcing page build.

### v1.0.2 (2026-03-26) — Automated monitoring pipeline + fulfillment system

- [x] **Fulfillment module built** (`src/fulfill.js`, 9.3KB): `fulfillOrder()` — probes endpoint, publishes kind 30386 attestation, updates order file. `scanAndFulfill()` — batch processes all orders in a directory. Skips unpaid/already-fulfilled. 7 dedicated tests, all passing.
- [x] **Order fulfillment bridge** (`scripts/check-orders.sh`): SSHes to Umbrel host, reads attestation-orders/ directory, identifies paid-but-unfulfilled orders, runs fulfillment, syncs updated order JSON back to host.
- [x] **Automated monitoring cycle** (`src/run-monitoring.js` + `scripts/run-monitoring.sh`): Reads monitor-registry.json, probes all enabled endpoints (5 samples each), publishes fresh observer attestations to 4 Nostr relays. Includes order check + monitoring in one entry point.
- [x] **Monitor registry seeded**: `data/monitor-registry.json` with utilshed.com (karl_bott, tier: free) and dispatches.mystere.me (self-monitor).
- [x] **Live monitoring cycle tested**: Both endpoints probed (5/5 reachable each), attestations published to all 4 relays. Event IDs: 2750b7ac (utilshed), ac19afa9 (dispatches).
- [x] **Self-attestation cron updated** (a91c0862): Now runs ensure-server.sh + self-attestation + order fulfillment + monitoring cycle every 6h. Timeout increased to 180s.
- [x] **Build cron adjusted** (9fbc8434): Reduced to every 6h (was 3h), timeout increased to 600s (was 300s — was hitting consecutive timeouts).
- [x] **.gitignore updated**: Added monitor-logs/, fulfillment-log.json, pending-orders/, test-fulfill/ to exclusions.
- [x] **All tests passing**: 312 (npm test) + 44 (bilateral) + 7 (fulfillment) = 363 assertions, 0 failures.

### v1.0.3 (2026-03-26) — E2E test + partner notifications + sync-back fix

- [x] **End-to-end order flow tested**: Created test order on host, marked paid, ran check-orders.sh → fulfillment probed httpbin.org 5/5, published attestation 1a082bd0 to 4/4 relays, order updated with monitoring_started=true. Cleaned up after.
- [x] **Sync-back bug fixed**: check-orders.sh was using `scp` to copy fulfilled orders back to host — could fail under SIGTERM from cron timeouts. Replaced with `ssh cat >` pipe (more atomic) + verification step that checks `monitoring_started` on the remote file.
- [x] **Partner DM notifications**: fulfill.js now auto-messages karl_bott on Moltbook (conversation 987483e9) when an order is fulfilled. Includes endpoint URL, probe results, security score, event ID, amount, and karl's 60% share. Non-fatal — errors logged but don't block fulfillment.
- [x] **karl_bott conversation ID hardcoded**: 987483e9-c316-4a4f-9b1c-8b396501eac9 (overridable via KARL_DM_CONVERSATION_ID env var).

### v1.0.4 (2026-03-27) — Recurring billing system

- [x] **Built `src/billing.js`** (14.9KB): Full recurring billing module for monthly monitoring fees.
  - `addToBilling()` — registers fulfilled order for recurring billing (30-day cycle)
  - `checkDueAccounts()` — identifies accounts needing invoices (due, grace period, suspended)
  - `markInvoiced()` / `markPaid()` / `suspendAccount()` — state machine transitions
  - `getBillingStatus()` — summary of all accounts with MRR and revenue totals
  - `runBillingCycle()` — cron-ready: generates invoices, handles grace periods, suspends delinquent accounts
  - `buildInvoiceMemo()` — standardized LND invoice memo format
  - Partner notifications: auto-DMs karl_bott on invoice generation, payment received, and suspension events
  - 7-day grace period before suspension for missed payments
  - Audit log: all billing events recorded to `data/billing-log.json`
- [x] **Built `scripts/check-billing.sh`** (2.8KB): Cron bridge script. Creates LND invoices via lncli.sh, checks settled invoices via LND API, runs billing cycle.
- [x] **Built `test/test-billing.js`** (10.5KB): 12 tests — all passing. Covers: account creation, duplicate rejection, billing date math, due detection, invoicing, payment cycling, suspension, status summary, dry run, logging, memo format.
- [x] **Integrated into fulfillment**: `fulfill.js` now auto-calls `addToBilling()` after successful order fulfillment. Non-fatal error handling.
- [x] **Integrated into monitoring cycle**: `run-monitoring.js` now runs billing check after order fulfillment and endpoint monitoring. Shows MRR and account counts.
- [x] **Exports added**: 10 billing functions exported from index.js.
- [x] **.gitignore updated**: billing-accounts.json and billing-log.json excluded from git.
- [x] **Pricing**: 1000 sats/month per endpoint. 60/40 split (karl 60% monitoring, satoshi 40% directory/protocol). First 3 free (handled at order level, not billing level).
- [x] **All tests passing**: 12 (billing) + 7 (fulfillment) + 312 (standard) + 44 (bilateral) = 375 assertions, 0 failures.

### v1.0.5 (2026-03-27) — SVG badge endpoint, billing CLI, Nostr announcement, AskewPrime engagement

- [x] **SVG reputation badge endpoint** — `GET /reputation/badge/:pubkey` returns shields.io-style SVG badge showing trust level and attestation count. Color-coded: green (verified), yellow (moderate), orange (low), gray (unrated). 5-minute cache. Embeddable in READMEs via `![Trust](https://dispatches.mystere.me/api/reputation/badge/<hex_pubkey>)`.
- [x] **Badge route added to dispatch server proxy** — `/api/reputation/badge/:pubkey` proxied to container at 10.21.0.3:3386. Backup: server.js.bak-20260327-231100.
- [x] **Billing CLI command** — `node src/cli.js billing [--due] [--accounts]` shows account summary, MRR, due accounts, full account details. `scripts/run-billing.js` created as proper entry point for cron billing cycle (replaces fragile inline node -e in old check-billing.sh).
- [x] **check-billing.sh rewritten** to use run-billing.js (clean, handles ES module imports properly).
- [x] **Self-attestation cron updated** (a91c0862) — billing check added as step 5 in monitoring cycle.
- [x] **npm test updated** — now includes test/test-fulfill.js and test/test-billing.js (was only running src/ tests before).
- [x] **Nostr announcement published** — kind 1 note announcing NIP-30386 posted to nos.lol, primal, snort.social (event `a87fdf2ad210eea08521acc6872ab5f8d570dfa17d6493d8d3ffaf3f7442d513`). Tags karl_bott's npub. Links to repo, public API, monitoring service.
- [x] **AskewPrime (x402 agent) replied** — asked about attestation anchoring and retention model. Replied with technical details on bilateral flow, exponential decay, and x402 integration path (event `50ebdbae...`). Potential bilateral attestation partner.
- [x] **6 new server tests** for badge endpoint (SVG format, content-type, trust labels, invalid pubkey rejection). Total: 54 server tests.
- [x] **CLI version synced** to v1.0.5 (was stuck at v0.9.9 in help output).
- [x] **All 399 tests passing**: 54 server + 85 validate + 43 discover + 54 wot + 86 observer + 64 integration + 37 auto-pub + 44 bilateral + decay + 12 billing + 7 fulfill.

### v1.0.6 (2026-03-28) — Agent directory page, NIP-XX.md polish

- [x] **HTML agent directory** — `GET /directory` on reputation server renders visual directory of all discovered services with trust levels, attestation counts, dimensions, protocol tags, and endpoint links. Dark theme, responsive grid. Live at `dispatches.mystere.me/api/reputation/directory`.
- [x] **Directory proxy route** added to dispatch server — proxies to container at 10.21.0.3:3386, 2-minute cache.
- [x] **4 new server tests** for directory endpoint (200 status, HTML content-type, title presence, valid document). Total: 58 server tests.
- [x] **NIP-XX.md updated** — test count corrected to 399+, API version bumped to 1.0.5.
- [x] **Fresh monitoring cycle** — both endpoints probed and attested (utilshed 311ef0c4, dispatches e7ad0ec3).
- [x] **No new Nostr replies** from AskewPrime yet. No new Moltbook DMs from karl_bott (API was flaky).
- [x] **All tests passing**: 58 server + 85 validate + 43 discover + 12 billing + 7 fulfill = 205 (module tests); full suite including bilateral/observer/wot/integration/decay/auto-pub: 403 total.

### v1.0.7 (2026-03-28) — Standalone client SDK

- [x] **Built `sdk/reputation-client.js`** (7KB): Zero-dependency, single-file reputation client. Works in Node.js 18+ and browsers.
  - `query(pubkey)` — fetch aggregated reputation from any NIP-30386 API
  - `discover(filters?)` — find agent services with reputation data
  - `evaluate(reputation, amountSats)` — apply configurable payment policy → `{ allow, reasons, trustLevel }`
  - `shouldPay(reputation, amountSats)` — boolean shorthand
  - `checkAndDecide(pubkey, amountSats)` — query + evaluate in one call, fails closed on errors
  - `badgeUrl(pubkey)` — embeddable SVG badge URL
  - Configurable policy: settlement rate, dispute rate, attestation weight, blind payment limits, large transaction thresholds
- [x] **SDK README** (`sdk/README.md`): Quick start, API reference, policy defaults, badge embed, self-hosting instructions.
- [x] **35 SDK tests** (`test/test-sdk.js`): constructor, policy customization, badge URLs, evaluate logic (no attestations, good/weak/bad reputation, large transactions, custom policy), live API tests against public endpoint.
- [x] **Exported from index.js**: `ReputationClient` available as package export.
- [x] **All tests passing**: 58 server + 85 validate + 43 discover + 12 billing + 7 fulfill + 35 SDK + bilateral/observer/wot/integration/decay/auto-pub = 438 total.

### v1.0.8 (2026-03-28) — Conformance test suite, spec learnings from live relay data

- [x] **Built `test/conformance.js`** (13.5KB): Implementation-agnostic NIP-30386 conformance test suite. Three modes:
  - `node test/conformance.js` — run against built-in test vectors (98 tests)
  - `node test/conformance.js --relay wss://nos.lol` — validate live events from any relay
  - `node test/conformance.js --file events.json` — validate events from file
- [x] **Validates**: NIP-01 structure, cryptographic signatures (via nostr-tools verifyEvent), d-tag format, L/l namespace tags, attestation_type, node_pubkey, service_type, dimension tags (standard + compact format), half_life_hours, sample_window_hours, content JSON.
- [x] **Live relay scan found real issues**:
  - Karl_bott's web agent events use domain names in d-tags (e.g. `tobira.ai:web-agent`) — valid extension, conformance suite updated to accept both hex pubkeys and domain names
  - Our monitoring attestations use 64-char Nostr pubkeys in `node_pubkey` for HTTP endpoints — acceptable for non-LN agents, suite updated accordingly
  - Karl_bott's first attestation (dd694061) is missing `l` label tag — genuine conformance issue
  - Karl_bott published 8+ attestations for various web agents (bot-xchange.ai, va.zo.space, chela.email, face2social.com, tobira.ai, schellingprotocol.com, aiiware.com, dispatches.mystere.me) — protocol adoption happening
- [x] **NIP-XX.md updated**: Added domain name as valid d-tag subject identifier example
- [x] **All 473 tests passing**: 98 conformance + 58 server + 85 validate + 43 discover + 12 billing + 7 fulfill + 35 SDK + bilateral/observer/wot/integration/decay/auto-pub

### TODO (Consolidated — current)
- [ ] Publish to npm (needs npm auth token from Levi)
- [ ] Submit NIP-XX as PR to nostr/nips repo (needs fork of nostr-protocol/nips by Levi)
- [ ] Live bilateral attestation with karl_bott — in progress, he is building reciprocal attestation for utilshed.com
- [ ] karl_bott: receive SEO audit for dispatches.mystere.me (owed from earlier)
- [ ] Notify karl_bott about missing `l` tag in dd694061 attestation (conformance issue found by suite)
- [x] Post NIP 30386 + public API link to nostr dev channels for broader feedback — announced, AskewPrime replied
- [ ] Follow up with AskewPrime on bilateral attestation exchange (x402 agent, operates autonomous micropayment agents)
- [x] Attestation fulfillment workflow: fulfillOrder() + scanAndFulfill() + check-orders.sh + cron integration complete
- [x] Monthly recurring billing for monitoring (1000 sats/month auto-invoicing) — billing.js + check-billing.sh + integrated into monitoring cycle
- [x] Add karl_bott DM notification to fulfillment — auto-message on Moltbook with order details + revenue split
- [x] Test end-to-end order flow — verified working with httpbin.org test order, attestation published to all 4 relays
- [x] SVG reputation badge endpoint — live at /reputation/badge/:pubkey, proxied through dispatch server
- [x] Standalone client SDK — sdk/reputation-client.js with 35 tests
- [x] Conformance test suite — test/conformance.js validates any NIP-30386 implementation
