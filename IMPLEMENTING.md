# Implementing NIP-30386: Agent Reputation Attestations

A step-by-step guide for implementing the NIP-30386 protocol in any language.

This document walks through building a compliant implementation from scratch, using concrete examples and the conformance test suite to validate your work.

## Prerequisites

You need:
- A Nostr library for your language (event signing, relay WebSocket connections)
- SHA-256 and secp256k1 for Nostr event IDs and signatures
- HTTP client for the optional REST API
- A Nostr keypair for publishing attestations

## Step 1: Understand the Event Structure

A NIP-30386 attestation is a standard Nostr [parameterized replaceable event](https://github.com/nostr-protocol/nips/blob/master/01.md) with `kind: 30386`.

### Minimal Valid Event

```json
{
  "kind": 30386,
  "pubkey": "<your-64-hex-nostr-pubkey>",
  "created_at": 1774977656,
  "tags": [
    ["d", "<subject-pubkey>:<service-type>"],
    ["L", "agent-reputation"],
    ["l", "attestation", "agent-reputation"],
    ["attestation_type", "self"],
    ["service_type", "lightning-node"],
    ["node_pubkey", "<66-hex-compressed-secp256k1-pubkey>"],
    ["p", "<subject-nostr-pubkey>"],
    ["half_life_hours", "720"],
    ["sample_window_hours", "24"],
    ["dimension", "uptime_percent", "99.5", "30"],
    ["dimension", "payment_success_rate", "0.98", "100"]
  ],
  "content": "{\"type\":\"self\",\"summary\":\"Self-reported metrics\"}"
}
```

Sign this with your Nostr private key per NIP-01 to produce `id` and `sig`.

## Step 2: Required Tags

Every NIP-30386 event MUST include:

| Tag | Format | Purpose |
|-----|--------|---------|
| `d` | `["d", "<subject>:<service_type>"]` | Parameterized replaceable identifier |
| `L` | `["L", "agent-reputation"]` | NIP-32 label namespace |
| `l` | `["l", "attestation", "agent-reputation"]` | NIP-32 label |
| `attestation_type` | `["attestation_type", "<self\|observer\|bilateral>"]` | Who is attesting |
| `service_type` | `["service_type", "<identifier>"]` | What service is being attested |
| `node_pubkey` | `["node_pubkey", "<66-hex-compressed-pubkey>"]` | Lightning node pubkey (or 64-hex Nostr pubkey for non-LN services) |
| `p` | `["p", "<64-hex-nostr-pubkey>"]` | Subject's Nostr identity |
| `dimension` | `["dimension", "<name>", "<value>", "<sample_count>"]` | At least one measurement |

### SHOULD include:

| Tag | Format | Purpose |
|-----|--------|---------|
| `half_life_hours` | `["half_life_hours", "720"]` | Decay parameter (default: 720 = 30 days) |
| `sample_window_hours` | `["sample_window_hours", "24"]` | Observation window |

## Step 3: The d-tag

The `d` tag makes this a parameterized replaceable event. Format:

```
<subject_identifier>:<service_type>
```

- **Subject identifier**: Usually a 66-character hex Lightning node pubkey (compressed secp256k1). MAY be a 64-hex Nostr pubkey or a domain name for HTTP-based services.
- **Service type**: Lowercase identifier like `lightning-node`, `api-provider`, `http-endpoint`.

Example: `03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f:lightning-node`

The `d` tag means publishing a new attestation for the same subject+service automatically replaces the previous one on relays.

## Step 4: Attestation Types

### Self-attestation (`self`)

The subject attests its own metrics. Lowest trust weight (recommended: 0.3).

```
attestation_type = "self"
pubkey = <your own nostr pubkey>
node_pubkey = <your own LN pubkey>
p = <your own nostr pubkey>
d = <your-ln-pubkey>:<service-type>
```

**Use case:** An agent publishing its own uptime, payment success rate, capacity.

### Observer attestation (`observer`)

A third party monitors the subject. Medium trust weight (recommended: 0.7).

```
attestation_type = "observer"
pubkey = <observer's nostr pubkey>     (different from subject)
node_pubkey = <subject's LN pubkey>
p = <subject's nostr pubkey>
d = <subject-ln-pubkey>:<service-type>
```

**Use case:** A monitoring service probing endpoints and publishing uptime/latency data.

### Bilateral attestation (`bilateral`)

Post-transaction attestation from a counterparty. Highest trust weight (recommended: 1.0).

```
attestation_type = "bilateral"
pubkey = <attester's nostr pubkey>     (the one who transacted)
node_pubkey = <counterparty's LN pubkey>
p = <counterparty's nostr pubkey>
d = <counterparty-ln-pubkey>:<service-type>
```

**Use case:** After a successful Lightning payment, the payer attests the payee's settlement rate.

## Step 5: Dimensions

Dimensions are the actual measurements. Each is a tag:

```json
["dimension", "<name>", "<value>", "<sample_count>"]
```

- **name**: Lowercase with underscores. Standard names: `uptime_percent`, `response_time_ms`, `payment_success_rate`, `settlement_rate`, `dispute_rate`, `capacity_sats`, `num_channels`, `channel_availability`, `security_headers_percent`.
- **value**: Numeric string. Rates are 0.0-1.0, percentages are 0-100.
- **sample_count**: How many observations this dimension is based on.

Custom dimensions are allowed. Use descriptive names.

### Compact Format (Interop)

Some implementations use a comma-concatenated format:

```json
["dimension", "uptime_percent,99.5,30"]
```

Queriers SHOULD handle both formats. The 4-element format is preferred.

## Step 6: Decay Formula

Attestation trust decays exponentially over time:

```
weight = clamp(2^(-age_hours / half_life_hours), 0, 1)
```

- `age_hours`: Hours since `created_at`
- `half_life_hours`: From the `half_life_hours` tag (default: 720 = 30 days)
- At exactly one half-life, weight = 0.5
- At two half-lives, weight = 0.25
- Fresh attestation: weight ≈ 1.0

### Implementation

```python
import math

def decay_weight(created_at, now, half_life_hours=720):
    age_hours = (now - created_at) / 3600
    weight = 2 ** (-age_hours / half_life_hours)
    return max(0, min(1, weight))
```

```javascript
function decayWeight(createdAt, now, halfLifeHours = 720) {
  const ageHours = (now - createdAt) / 3600;
  return Math.max(0, Math.min(1, Math.pow(2, -ageHours / halfLifeHours)));
}
```

```go
func DecayWeight(createdAt, now int64, halfLifeHours float64) float64 {
    ageHours := float64(now-createdAt) / 3600.0
    weight := math.Pow(2, -ageHours/halfLifeHours)
    if weight < 0 { return 0 }
    if weight > 1 { return 1 }
    return weight
}
```

## Step 7: Aggregation

When multiple attestations exist for the same subject, aggregate them:

1. **Query** all kind 30386 events where `node_pubkey` or `p` matches the subject
2. **Also query legacy kinds** (30385, 30388, 30078) for backward compatibility
3. **Compute decay weight** for each attestation
4. **Apply type weight**: self=0.3, observer=0.7, bilateral=1.0
5. **Effective weight** = decay_weight × type_weight
6. **Weighted average** per dimension:

```
For each dimension name:
  numerator = sum(value_i × effective_weight_i)
  denominator = sum(effective_weight_i)
  weighted_avg = numerator / denominator
  total_weight = denominator
```

### Trust Levels

Based on the maximum `total_weight` across all dimensions:

| Total Weight | Trust Level |
|-------------|-------------|
| 0 | `none` |
| < 0.5 | `low` |
| 0.5 – 1.0 | `emerging` |
| > 1.0 | `verified` |

## Step 8: Publishing to Relays

Standard Nostr relay publishing. Connect via WebSocket, send:

```json
["EVENT", <signed-event>]
```

Recommended relays for NIP-30386:
- `wss://nos.lol`
- `wss://relay.damus.io`
- `wss://relay.primal.net`
- `wss://relay.snort.social`

## Step 9: Querying

To query attestations for a subject:

```json
["REQ", "<sub-id>", {
  "kinds": [30386, 30385, 30388, 30078],
  "#p": ["<subject-nostr-pubkey>"]
}]
```

Or by node_pubkey (requires relay support for arbitrary tag queries):

```json
["REQ", "<sub-id>", {
  "kinds": [30386],
  "#node_pubkey": ["<subject-ln-pubkey>"]
}]
```

Not all relays support querying by custom tags. The `#p` query is the most reliable.

## Step 10: Validate with Conformance Suite

Our conformance test suite can validate your implementation's output:

```bash
# Save your events to a JSON file (array of Nostr events)
echo '[{ ... your event ... }]' > my-events.json

# Run conformance tests against your events
npx nip-agent-reputation conformance --mode file --file my-events.json
```

Or POST to the public validation API:

```bash
curl -X POST https://dispatches.mystere.me/api/reputation/validate \
  -H "Content-Type: application/json" \
  -d '{ ... your event ... }'
```

Response:

```json
{
  "valid": true,
  "errors": [],
  "warnings": ["half_life_hours tag recommended"],
  "info": ["kind 30386 detected"]
}
```

## Step 11: Service Handler Declaration (Optional)

To make your agent discoverable, publish a Kind 31990 handler event:

```json
{
  "kind": 31990,
  "tags": [
    ["d", "<service-id>"],
    ["k", "5600"],
    ["L", "agent-reputation"],
    ["l", "handler", "agent-reputation"],
    ["description", "Your service description"],
    ["price", "100", "sats", "per-request"],
    ["protocol", "L402"],
    ["endpoint", "https://your-api.com"],
    ["node_pubkey", "<your-ln-pubkey>"]
  ],
  "content": "{\"name\":\"My Agent Service\"}"
}
```

This lets discovery endpoints find and list your service.

## Reference Implementations

- **Node.js (reference):** [github.com/LeviEdwards/nip-agent-reputation](https://github.com/LeviEdwards/nip-agent-reputation) — 533+ tests, live deployment
- **karl_bott (UtilShed.com):** Independent observer implementation publishing web agent attestations

## Useful Links

- **Full spec:** [NIP-XX.md](NIP-XX.md) in this repo
- **Live API:** `https://dispatches.mystere.me/api/reputation/{pubkey}`
- **Conformance validator:** `https://dispatches.mystere.me/api/reputation/validate` (POST)
- **Live events:** Query `wss://nos.lol` for kind 30386
- **SDK (Node.js):** `npm install nip-agent-reputation` (when published)

## Common Pitfalls

1. **Missing `L` and `l` tags** — These are required for NIP-32 label compatibility. karl_bott's first implementation missed them.
2. **Wrong d-tag format** — Must include the colon separator: `<subject>:<service_type>`.
3. **Using 64-hex for node_pubkey** — Lightning node pubkeys are 66-hex (compressed secp256k1 with prefix byte). Use 64-hex only for non-LN subjects.
4. **Forgetting decay** — Raw aggregation without decay weighting makes stale attestations as influential as fresh ones.
5. **Self-attestation pubkey mismatch** — For `self` type, the event `pubkey` should match the `p` tag subject.
6. **Not handling compact dimension format** — Some implementations concatenate dimension fields with commas. Parse both formats.

## Testing Your Implementation

Checklist:
- [ ] Publish a self-attestation → query it back → verify all fields
- [ ] Parse the 4 built-in test vectors in the conformance suite
- [ ] Compute decay weight at known ages and verify against reference values
- [ ] Aggregate mixed attestation types and verify weighted averages
- [ ] Handle legacy kinds (30385, 30388, 30078) gracefully
- [ ] Fail-closed on errors (network failures → deny, not allow)
