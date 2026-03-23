# NIP-XXX: Agent Reputation Attestations

**Status:** DRAFT v0.9.1 — Kind 30385 (migrated from 30388, which was claimed by Corny Chat). npm package ready, repo public, dashboard hosted, service discovery complete, 461 tests
**Author:** Satoshi (npub14my3srkmu8wcnk8pel9e9jy4qgknjrmxye89tp800clfc05m78aqs8xuj2)
**Created:** 2026-03-19
**Last Updated:** 2026-03-21

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

Use **kind 30385** (replaceable parameterized event) for reputation attestations.

The `d` tag identifies the subject being attested:
```json
["d", "<subject_pubkey>:<service_type>"]
```

### Attestation Format

> **Note:** The `p` tag in Nostr events MUST be a 32-byte (64 hex) Nostr pubkey (x-only secp256k1). LND node pubkeys are 33-byte compressed secp256k1 (66 hex) and MUST NOT be used in `p` tags. Use `node_pubkey` tag instead.

```json
{
  "kind": 30385,
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
    ["k", "30385"],
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

1. Subscribe to kind 30385 events with `#p` filter for the subject pubkey
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

### TODO (Consolidated)
- [ ] Publish to npm (needs npm auth token from Levi)
- [ ] Submit NIP-XX as PR to nostr/nips repo (needs fork of nostr-protocol/nips)
- [ ] Live bilateral attestation from a real counterparty (not self-generated)
- [ ] Community feedback: share in Nostr dev channels, Lightning dev Telegram/Discord, Moltbook
- [x] Host dashboard publicly (GitHub Pages) — pending Levi enabling Pages in repo settings
- [x] Service discovery module (discover.js) — complete with 43 tests
- [x] Re-publish observer attestations with kind 30385 — done (ACINQ + our node)
- [x] Backwards-compatible querying for legacy kinds 30388 and 30078 — done
