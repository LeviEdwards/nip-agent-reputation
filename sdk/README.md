# NIP-30386 Reputation Client SDK

Zero-dependency, single-file client for querying agent reputation before payments.

## Quick Start

```javascript
import { ReputationClient } from './reputation-client.js';

const client = new ReputationClient();

// Check reputation before paying
const result = await client.checkAndDecide(counterpartyPubkey, 5000);
if (result.allow) {
  // proceed with payment
} else {
  console.log('Payment denied:', result.reasons);
}
```

## API

### `new ReputationClient(optionsOrApiBase?)`

Accepts either a URL string or an options object:

```javascript
// String shorthand
const client = new ReputationClient('http://localhost:3386');

// Options object
const client = new ReputationClient({ apiBase: 'http://localhost:3386', timeoutMs: 5000 });
```

| Option | Default | Description |
|--------|---------|-------------|
| `apiBase` | `https://dispatches.mystere.me/api/reputation` | Reputation API URL |
| `discoverUrl` | Auto-derived from apiBase | Override for proxied /discover endpoint |
| `timeoutMs` | `10000` | Request timeout |
| `policy` | See below | Payment policy thresholds |

### Default Policy

```javascript
{
  minSettlementRate: 0.90,     // Minimum acceptable settlement rate
  maxDisputeRate: 0.10,        // Maximum acceptable dispute rate
  minTotalWeight: 0.3,         // Minimum attestation weight
  largeThresholdSats: 50000,   // Above this = "large transaction"
  largeMinWeight: 1.0,         // Large transactions need external attestations
  largeMinSettlement: 0.95,    // Large transactions need higher settlement
  maxBlindPaymentSats: 100,    // Max payment with zero reputation
}
```

### Methods

- **`query(pubkey)`** — Fetch raw reputation data
- **`discover(filters?)`** — Find available agent services  
- **`evaluate(reputation, amountSats)`** — Apply policy to reputation data → `{ allow, reasons, trustLevel }`
- **`shouldPay(reputation, amountSats)`** — Shorthand → `boolean`
- **`checkAndDecide(pubkey, amountSats)`** — Query + evaluate in one call (fails closed on errors)
- **`badgeUrl(pubkey)`** — Get embeddable SVG badge URL

### Badge

Embed reputation in READMEs:

```markdown
![Reputation](https://dispatches.mystere.me/api/reputation/badge/YOUR_HEX_PUBKEY)
```

## Self-Hosting

Point the client at your own NIP-30386 server:

```javascript
const client = new ReputationClient({ apiBase: 'http://localhost:3386' });
```
