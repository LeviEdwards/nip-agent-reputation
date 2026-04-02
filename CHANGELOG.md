# Changelog

All notable changes to NIP-30386 Agent Reputation Attestations.

## [1.0.12] - 2026-04-01

### Added
- `scan` CLI command — scan relays for all kind 30386 events and report protocol health
- `scan --validate` — run full validation on every event found
- `scan --json` — machine-readable JSON output for automation
- `scan --history` — adoption trends over time (from scan logs)
- Scan log persistence in `data/scan-logs/` for tracking adoption

### Fixed
- Validator now accepts 64-hex `node_pubkey` (Nostr x-only pubkeys for HTTP services)
- Scan validation getter bug — `valid` property was lost during object spread

### Changed
- NIP spec updated: `node_pubkey` may be 64-hex for non-Lightning services

## [1.0.11] - 2026-04-01

### Added
- Interactive playground at `/playground` — validate events, query reputation, discover services, copy templates
- `IMPLEMENTING.md` — 343-line implementation guide for any language
- Playground proxied to public at `dispatches.mystere.me/api/reputation/playground`
- 9 new server tests for playground endpoint
- `nip-pr/AWESOME-NOSTR-PR.md` — PR materials for awesome-nostr listing

## [1.0.10] - 2026-03-31

### Added
- `examples/` directory with 3 demo scripts (payment-gate, discover-agents, publish-attestation)
- SDK string constructor — `new ReputationClient('https://api.example.com')` 
- 2 new SDK tests for string constructor

## [1.0.9] - 2026-03-30

### Added
- `nip-pr/` directory with PR-INSTRUCTIONS.md and XX.md (NIP spec ready for submission)
- Version bump infrastructure across package.json, cli.js, server.js

### Fixed
- Server version string was hardcoded to 1.0.5 — now reads from package.json pattern
- `run-all.sh` test runner stopping early due to held WebSocket connections
- All 12 test files now call `process.exit(0)` on completion

## [1.0.8] - 2026-03-28

### Added
- Conformance test suite (`test/conformance.js`) — 98 tests across 4 test vectors
- Test vectors: minimal valid self, observer, missing labels (negative), compact dimensions (interop)
- Live relay conformance mode: `node test/conformance.js --live`

### Changed
- NIP-XX.md updated: domain-based d-tag subjects allowed, 64-hex pubkeys in node_pubkey

## [1.0.7] - 2026-03-27

### Added
- SDK (`sdk/reputation-client.js`) — zero-dependency client with `checkAndDecide()` one-call flow
- Fail-closed error handling in SDK
- 35 SDK tests including live API integration tests
- SDK exported from package index.js

## [1.0.6] - 2026-03-26

### Added
- Billing module (`src/billing.js`) — recurring monthly invoicing for monitored endpoints
- Billing CLI commands: `billing`, `billing --due`, `billing --accounts`
- 12 billing tests
- Billing wired into fulfillment pipeline

## [1.0.5] - 2026-03-25

### Added
- Fulfillment module (`src/fulfill.js`) — process attestation orders from `/attest` landing page
- Order scanning and batch processing
- 7 fulfillment tests
- `scripts/check-orders.sh` and `scripts/fulfill-order.sh`

## [1.0.4] - 2026-03-25

### Added
- HTTP API server (`src/server.js`) — REST endpoints for reputation, discovery, validation
- Badge endpoint (`/reputation/badge/:pubkey`) — SVG reputation badges
- Directory endpoint (`/directory`) — HTML directory of attested services  
- Validation endpoint (`POST /validate`) — validate attestation events via API
- 58 server tests

## [1.0.3] - 2026-03-24

### Added
- Validation module (`src/validate.js`) — comprehensive event validation
- `validateAttestation()`, `validateHandler()`, `validateBatch()` functions
- 85 validation tests covering all tag requirements, edge cases, strict mode

## [1.0.2] - 2026-03-24

### Added
- Service discovery (`src/discover.js`) — find agent services via NIP-89 kind 31990
- Discovery filters: service type, protocol, max age, min trust weight
- Reputation enrichment for discovered services
- 43 discovery tests

## [1.0.1] - 2026-03-23

### Added
- Web-of-trust scoring (`src/web-of-trust.js`) — recursive trust-weighted reputation
- Sybil detection: uniform scoring flags, low-trust attester warnings
- Cycle prevention in trust graph traversal
- 54 WoT tests

## [1.0.0] - 2026-03-22

### Added
- Initial release
- Core attestation builder (`src/attestation.js`) — self, observer, bilateral types
- LND metrics collection (`src/lnd.js`)
- Observer attestation (`src/observer.js`) — probe endpoints, snapshot channels
- Bilateral attestation (`src/bilateral.js`) — transaction recording and attestation building
- Service handler declaration (`src/handler.js`) — NIP-89 kind 31990
- Auto-publish logic (`src/auto-publish.js`) — change detection, rate limiting
- CLI tool (`src/cli.js`) — collect, publish, query, verify, record, history, attest, observe, trust, discover
- Exponential decay formula: `clamp(2^(-age/half_life), 0, 1)`
- Kind 30386 (parameterized replaceable event)
- NIP-32 labeling (`L`/`l` tags for `agent-reputation` namespace)
- Publishing to 4 relays: nos.lol, damus, primal, snort.social
- NIP-XX.md specification document
