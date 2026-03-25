# Changelog

All notable changes to this project will be documented in this file.

## [0.9.8] - 2026-03-24

### Fixed
- Broken `LEGACY_ATTESTATION_KIND` export in index.js (renamed to `LEGACY_KINDS`)
- README code example used wrong destructuring for dimension objects

### Changed
- package.json version bumped to match actual release (was stuck at 0.9.4)

## [0.9.7] - 2026-03-24

### Added
- `examples/query-reputation.js` — query attestations without LND access
- `examples/observe-and-attest.js` — observe a node and publish attestation
- Implementation section in NIP-XX.md

### Fixed
- CLI version string updated from v0.6 to v0.9.6

## [0.9.6] - 2026-03-24

### Fixed
- `observeNodeFromGraph()` returned raw `ChannelSnapshot` instead of `ObservationSession`, causing `buildObserverAttestation` crash on `computeDimensions()`
- ACINQ now correctly reports 1981 channels in observer attestations

### Changed
- Fresh observer attestations published for both peers with corrected data

## [0.9.5] - 2026-03-23

### Added
- Fresh self-attestation with live relay verification
- Relay inventory check confirming all 4 attestation types present

## [0.9.4] - 2026-03-23

### Fixed
- Kind number migration: 30385 → 30386 (30385 collides with NIP-85 identifier assertions)
- All source files, NIP-XX.md, server default port, dashboard updated to kind 30386
- `LEGACY_KINDS` array replaces individual legacy kind constants
- `queryAttestations()` queries all four kinds (30386 + 3 legacy)
- Relay verification confirmed working end-to-end

## [0.9.3] - 2026-03-23

### Added
- PR-DESCRIPTION.md for NIP submission

### Fixed
- Kind number migration: 30388 → 30385 (30388 collides with Corny Chat Slide Set)

## [0.9.2] - 2026-03-23

### Fixed
- server.js `port:0` falsy bug — now uses `options.port !== undefined` check
- `QUERY_TIMEOUT_MS` reads from environment variable
- test-server.js sets timeout to 3000ms for reliable CI

## [0.9.1] - 2026-03-22

### Added
- Service discovery module (`discover.js`) with 43 tests
- Validation module (`validate.js`) with 85 tests
- Web-of-trust recursive scoring

## [0.9.0] - 2026-03-22

### Added
- Complete reference implementation: attestation, bilateral, observer, handler, auto-publish
- CLI with collect, publish, query, discover, serve commands
- REST API server
- 461 tests across 9 test files
- Live events published to 4 relays (damus, nos.lol, primal, snort.social)
- NIP-XX.md spec (300+ lines)
