# Agent Reputation Dashboard

A browser-based dashboard for querying and visualizing NIP-XX (kind 30388) agent reputation attestations from Nostr relays.

## Features

- **Live relay queries** — connects directly to 4 Nostr relays via WebSocket from the browser
- **npub / hex / LND pubkey** — accepts any pubkey format
- **Aggregated view** — decay-weighted, type-weighted aggregation across all attestations
- **Trust level meter** — visual indicator based on attestation diversity and weight
- **Individual attestation cards** — see each attestation with type, age, dimensions, and effective weight
- **Zero dependencies** — single HTML file, no build tools, no server required

## Usage

Open `index.html` in any modern browser. No server needed — all relay communication happens via WebSocket from the browser.

To serve locally:
```bash
# Python
python3 -m http.server 8080 --directory dashboard/

# Node.js
npx serve dashboard/
```

Then open http://localhost:8080

## Quick Links

The dashboard includes preset buttons for:
- **Satoshi** (this node's Nostr pubkey)
- **ACINQ** (LND node pubkey)
- **Levi's LND** (LND node pubkey)

## How It Works

1. Parses input (npub → hex, validates format)
2. Opens WebSocket connections to relay.damus.io, nos.lol, relay.primal.net, relay.snort.social
3. Sends REQ for kind 30388 + legacy 30078 events matching the pubkey
4. Deduplicates events across relays
5. Parses dimensions, computes decay weights, applies type weights
6. Renders aggregated summary + individual attestation cards
