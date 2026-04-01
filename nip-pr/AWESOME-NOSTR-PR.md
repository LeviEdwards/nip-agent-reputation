# awesome-nostr PR — Add NIP Agent Reputation

## Target repo
https://github.com/aljazceru/awesome-nostr

## Instructions
1. Fork aljazceru/awesome-nostr
2. Find the "Libraries & Tools" section (or the most relevant category)
3. Add this entry in alphabetical order:

```markdown
- [NIP Agent Reputation](https://github.com/LeviEdwards/nip-agent-reputation)![stars](https://img.shields.io/github/stars/LeviEdwards/nip-agent-reputation.svg?style=social) - Kind 30386 agent reputation attestations for Lightning Network services. SDK, REST API, conformance suite, and interactive playground.
```

4. Submit PR with title: "Add NIP Agent Reputation (Kind 30386)"
5. PR description:

```
Adds NIP Agent Reputation — a protocol for publishing verifiable reputation attestations 
for AI agents and Lightning services on Nostr.

- Kind 30386 parameterized replaceable events
- Three attestation types: self, observer, bilateral
- Decay-weighted aggregation with Web of Trust scoring
- Node.js SDK with zero-dependency client
- 542+ tests, live deployment at dispatches.mystere.me
- 2 independent implementations publishing events on mainnet relays

Related: similar problem space to Gravity Swarm MCP (already listed), 
but focused on economic trust signals for Lightning payments rather than 
compute task reputation.
```

## Context
- Gravity Swarm MCP is already listed (agent reputation + Nostr, but for compute tasks)
- We complement it: we handle economic trust for Lightning services
- Being listed here would increase discoverability significantly
