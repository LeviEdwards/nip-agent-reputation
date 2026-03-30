# NIP-XX PR Submission Instructions

## Prerequisites
1. Fork `nostr-protocol/nips` on GitHub (LeviEdwards account)
2. Clone the fork locally or use GitHub web editor

## Files to Add/Modify

### 1. Add `XX.md` (the NIP spec)
Copy `XX.md` from this directory to the root of the nips repo.

### 2. Update `README.md`
Add to the **List** section (alphabetical/numerical order, after NIP-A4):
```markdown
- [NIP-XX: Agent Reputation Attestations](XX.md)
```

Add to the **Event Kinds** table (between 30384 and 30388):
```markdown
| `30386`       | Agent Reputation Attestation | [XX](XX.md)                            |
```

Add to the **Common Tags** section if there's a good place:
```markdown
| `dimension`   | metric name, value, sample_size | [XX](XX.md) |
| `node_pubkey` | 66-hex Lightning node pubkey    | [XX](XX.md) |
| `attestation_type` | self, bilateral, observer  | [XX](XX.md) |
```

## PR Title
```
NIP-XX: Agent Reputation Attestations (kind 30386)
```

## PR Description
```
## Summary
Defines a standard for publishing, querying, and verifying reputation attestations for autonomous agents on the Lightning Network, using kind 30386 (replaceable parameterized events).

## Motivation
Autonomous agents transacting over Lightning need a protocol-level reputation system. Social signals don't correlate with service quality. This NIP enables trust earned through verifiable economic behavior.

## Key Design Decisions
- **Three attestation types**: self (agent reports own metrics), observer (third-party monitoring), bilateral (direct transaction counterparty)
- **Raw dimensions over composite scores**: publish individual metrics, let queriers weight them
- **Exponential decay**: old attestations lose weight via configurable half-life
- **NIP-32 labeling**: uses `L`/`l` tags for discoverability
- **NIP-89 service handlers**: agents declare services via kind 31990

## Implementations
- Reference implementation (Node.js): https://github.com/LeviEdwards/nip-agent-reputation
  - 530+ tests, conformance suite, client SDK
  - Live on 4 relays with 14+ events from 2 independent publishers
- Independent implementation: karl_bott (UtilShed.com) publishing web agent attestations

## Related NIPs
- NIP-85 (Trusted Assertions) — complementary; NIP-85 providers can consume these attestations as input
- NIP-66 (Relay Discovery) — similar pattern (monitoring/liveness via parameterized replaceable events)
- NIP-89 (Application Handlers) — reused for service declarations
- NIP-90 (Data Vending Machines) — complementary agent marketplace
```

## Acceptance Criteria Met
Per nostr/nips README:
- ✅ At least 2 implementations exist (reference + karl_bott)
- ✅ Events published to real relays (nos.lol, relay.damus.io, relay.primal.net, relay.snort.social)
- ✅ 14+ live events
- ✅ Kind 30386 available (between NIP-85 30384 and Corny Chat 30388)
- ✅ Spec follows NIP formatting conventions
- ✅ Uses existing NIP patterns (NIP-32 labeling, NIP-89 handlers)
