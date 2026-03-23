# PR: NIP-XX — Agent Reputation Attestations

## Summary

This NIP defines a protocol for publishing, querying, and verifying reputation attestations for autonomous agents operating on the Lightning Network. Reputation is derived from observable economic behavior — payment settlements, service delivery, uptime — rather than social signals.

## What this PR includes

1. **New file: `XX.md`** — The full NIP specification
2. **New event kind: `30386`** — Agent reputation attestation (replaceable parameterized)
3. **README.md update** — Add kind 30386 to the event kinds table

## Kind number justification

Kind `30386` is the first available kind after NIP-85's Trusted Assertions block (30382–30385) and before Corny Chat's Slide Set (30388). This placement is intentional — agent reputation attestations are complementary to NIP-85's trusted assertions framework but differ in that they originate from direct economic interactions rather than centralized computation providers.

## Relationship to existing NIPs

- **NIP-85 (Trusted Assertions)**: Complementary. NIP-85 providers may consume these attestations as input signals. This NIP provides the raw economic data; NIP-85 provides computed trust scores.
- **NIP-89 (Recommended Application Handlers)**: Used directly. Agent service declarations use kind 31990 with `k` tag referencing 30386.
- **NIP-32 (Labeling)**: Used for namespace tagging (`L: agent-reputation`).
- **NIP-90 (Data Vending Machines)**: Complementary marketplace protocol.

## Working implementation

- **Reference implementation**: https://github.com/LeviEdwards/nip-agent-reputation
- **Language**: Node.js (ESM)
- **Tests**: 461 unit tests covering all modules
- **Live events**: Kind 30386 attestations published to damus, nos.lol, primal, snort.social
- **Dashboard**: Interactive query tool at https://github.com/LeviEdwards/nip-agent-reputation/tree/main/dashboard

## Key design decisions

1. **No composite score** — Different use cases weight dimensions differently. The spec provides building blocks, not a number.
2. **Exponential decay** — Attestations lose relevance over time via configurable half-life.
3. **Three attestation types** with recommended weights: self (0.3), observer (0.7), bilateral (1.0).
4. **Free-text service types** — The agent ecosystem is too young for controlled vocabulary.
5. **NIP-32 labeling** — All events tagged with `L: agent-reputation` for efficient relay querying.

## Changes to README.md

Add to the event kinds table:

```
| `30386`       | Agent Reputation Attestation    | [XX](XX.md)                            |
```
