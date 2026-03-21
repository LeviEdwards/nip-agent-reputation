# Integration Guide

How to add agent reputation to your Lightning/Nostr application.

## Quick Start

```bash
npm install nip-agent-reputation  # or: git clone + npm install
```

## Examples

| Example | Description | Use When |
|---------|-------------|----------|
| [01-query-reputation](01-query-reputation.js) | Query an agent's reputation | Before transacting with an unknown agent |
| [02-publish-self-attestation](02-publish-self-attestation.js) | Publish your LND node's metrics | Establishing your presence in the reputation network |
| [03-bilateral-attestation](03-bilateral-attestation.js) | Attest a counterparty after transacting | After a successful (or failed) transaction |
| [04-web-of-trust](04-web-of-trust.js) | Sybil-resistant trust scoring | When you need to verify attesters aren't fake |
| [05-pre-payment-gate](05-pre-payment-gate.js) | Automated go/no-go payment decisions | Building an agent that pays other agents |
| [06-declare-service](06-declare-service.js) | Announce your service (NIP-89) | Making your agent discoverable |
| [07-l402-integration](07-l402-integration.js) | Full L402 payment flow with reputation | Building an L402 client with trust |

## Common Integration Patterns

### Pattern 1: "Check before you pay"

The simplest integration — query reputation before sending a payment:

```js
import { queryAttestations, aggregateAttestations } from 'nip-agent-reputation';

async function shouldPay(counterpartyPubkey, amountSats) {
  const attestations = await queryAttestations(counterpartyPubkey);
  
  if (attestations.length === 0) {
    return amountSats < 100;  // only risk pocket change on unknowns
  }
  
  const agg = aggregateAttestations(attestations);
  return agg.settlement_rate?.weightedAvg > 0.90;
}
```

### Pattern 2: "Attest after every transaction"

Build reputation data by publishing bilateral attestations:

```js
import { TransactionHistory, TransactionRecord, buildBilateralFromHistory, publishToRelays } from 'nip-agent-reputation';
import { getKeypair } from 'nip-agent-reputation/keys';

const history = new TransactionHistory();
const { secretKey } = getKeypair();

// After each transaction:
history.add(new TransactionRecord({
  counterpartyNodePubkey: '03abc...',
  invoiceAmountSats: 5000,
  settled: true,
  responseTimeMs: 340,
}));

// Periodically publish (e.g., every 5 transactions):
const event = buildBilateralFromHistory(history, '03abc...', secretKey);
await publishToRelays(event);
```

### Pattern 3: "Announce + self-attest on a schedule"

For Lightning node operators running autonomous agents:

```js
import { buildSelfAttestation, buildServiceHandler, publishToRelays } from 'nip-agent-reputation';
import { collectLndMetrics } from 'nip-agent-reputation/lnd';
import { getKeypair } from 'nip-agent-reputation/keys';

// Once: declare your service
const handler = buildServiceHandler({
  id: 'my-api',
  description: 'Bitcoin data API',
  price: '10', priceUnit: 'sats', pricePer: 'per-request',
  protocol: 'L402',
  endpoint: 'https://api.example.com',
}, secretKey);
await publishToRelays(handler);

// Every 6 hours (via cron):
const metrics = await collectLndMetrics({ /* LND config */ });
const attestation = buildSelfAttestation(metrics, secretKey);
await publishToRelays(attestation);
```

### Pattern 4: "Web-of-trust for high-value decisions"

For large payments or channel opens, use recursive trust scoring:

```js
import { WebOfTrust, queryAttestations } from 'nip-agent-reputation';

const wot = new WebOfTrust({
  queryFn: (pk) => queryAttestations(pk),
  maxDepth: 2,
});

const scored = await wot.score(counterpartyPubkey);

if (scored.sybilRisk === 'high') {
  console.log('⚠️ All attestations are self-reported or from unknown attesters');
  // Require manual approval for this transaction
}

if (scored.confidence > 1.0 && scored.sybilRisk === 'low') {
  // Safe for automated high-value transactions
}
```

## Running the Examples

Most examples work standalone:

```bash
# Query reputation (read-only, no keys needed)
node examples/01-query-reputation.js 03b8a5da1975f121b0b835d1187f9b0857dedfae50dcbf0ccd43e650a73effb0a8

# Web-of-trust scoring (read-only)
node examples/04-web-of-trust.js 1bb7ae47020335130b9654e3c13633f92446c4717e859f82b46e6363118c6ead

# Pre-payment gate (read-only check)
node examples/05-pre-payment-gate.js 03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f 50000
```

Examples that publish events use dry-run mode by default. Set `PUBLISH=true` to actually publish:

```bash
PUBLISH=true node examples/03-bilateral-attestation.js
```

Examples that need LND access require environment variables:

```bash
LND_REST_URL=https://localhost:8080 \
LND_MACAROON_PATH=/path/to/admin.macaroon \
LND_TLS_CERT_PATH=/path/to/tls.cert \
node examples/02-publish-self-attestation.js
```

## Key Concepts

- **Self-attestation** (weight 0.3): You report your own metrics. Low trust but establishes presence.
- **Bilateral attestation** (weight 1.0): Published after real transaction. Highest trust.
- **Observer attestation** (weight 0.7): Third-party monitoring. Intermediate trust.
- **Decay**: All attestations lose weight over time (configurable half-life, default 30 days).
- **Web-of-trust**: Recursive scoring — attester reputation modulates attestation weight.
- **No composite score**: The protocol publishes raw dimensions. You decide how to weight them.
