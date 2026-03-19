/**
 * Key management for NIP Agent Reputation.
 * 
 * SECURITY: Never commit or log the private key.
 * The nsec is loaded from environment variable or a local file
 * that is excluded from git (.nostr-nsec).
 */

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
// bytesToHex/hexToBytes not needed — nostr-tools handles encoding
import { nip19 } from 'nostr-tools';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEY_FILE = join(__dirname, '..', '.nostr-nsec');

/**
 * Get or create a keypair for publishing attestations.
 * Priority: NOSTR_NSEC env var > .nostr-nsec file > generate new
 */
export function getKeypair() {
  let sk;

  // Try env var first
  if (process.env.NOSTR_NSEC) {
    const decoded = nip19.decode(process.env.NOSTR_NSEC);
    if (decoded.type !== 'nsec') throw new Error('NOSTR_NSEC must be an nsec');
    sk = decoded.data;
  }
  // Try file
  else if (existsSync(KEY_FILE)) {
    const nsec = readFileSync(KEY_FILE, 'utf8').trim();
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec') throw new Error('.nostr-nsec must contain an nsec');
    sk = decoded.data;
  }
  // Generate new
  else {
    sk = generateSecretKey();
    const nsec = nip19.nsecEncode(sk);
    writeFileSync(KEY_FILE, nsec + '\n', { mode: 0o600 });
    console.log(`Generated new keypair. nsec saved to .nostr-nsec (git-ignored).`);
    console.log(`Public key (npub): ${nip19.npubEncode(getPublicKey(sk))}`);
  }

  const pk = getPublicKey(sk);
  return {
    secretKey: sk,
    publicKey: pk,
    npub: nip19.npubEncode(pk),
    nsec: nip19.nsecEncode(sk),
  };
}
