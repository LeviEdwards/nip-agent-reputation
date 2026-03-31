#!/usr/bin/env node
/**
 * Example: Discover agents with reputation data
 *
 * Queries the NIP-30386 discovery endpoint to find all agents
 * with published reputation attestations, then ranks them.
 *
 * Usage:
 *   node examples/discover-agents.js [--service-type <type>]
 *
 * Requires: Node.js 18+, no other dependencies.
 */

import { ReputationClient } from '../sdk/reputation-client.js';

const API = 'https://dispatches.mystere.me/api/reputation';
const DISCOVER_URL = 'https://dispatches.mystere.me/api/reputation/discover';

async function main() {
  const serviceType = process.argv.includes('--service-type')
    ? process.argv[process.argv.indexOf('--service-type') + 1]
    : null;

  // String constructor + discoverUrl override for proxied deployments
  const client = new ReputationClient({ apiBase: API, discoverUrl: DISCOVER_URL });

  console.log('Discovering agents with NIP-30386 reputation data...');
  if (serviceType) console.log(`Filtering by service type: ${serviceType}`);
  console.log('');

  const result = await client.discover(serviceType ? { serviceType } : {});
  const agents = result.services || result || [];

  if (!agents || agents.length === 0) {
    console.log('No agents found with reputation data.');
    process.exit(0);
  }

  console.log(`Found ${agents.length} agent(s):`);
  console.log('');

  for (const agent of agents) {
    const pubkey = agent.pubkey || '?';
    const svcId = agent.serviceId || agent.service_type || '?';
    const desc = agent.description || '';
    const protocol = agent.protocol || '';
    const endpoint = agent.endpoint || '';

    console.log(`  ${pubkey.slice(0, 20)}...`);
    console.log(`    Service: ${svcId}`);
    if (desc) console.log(`    Description: ${desc.slice(0, 80)}`);
    if (protocol) console.log(`    Protocol: ${protocol}`);
    if (endpoint) console.log(`    Endpoint: ${endpoint}`);
    if (agent.price) console.log(`    Price: ${agent.price.amount} ${agent.price.unit}/${agent.price.per || 'request'}`);

    // Show reputation if enriched
    const rep = agent.reputation;
    if (rep && rep.attestationCount > 0) {
      console.log(`    Reputation: ${rep.attestationCount} attestation(s), trust: ${rep.trustLevel || '?'}`);
    }
    console.log('');
  }

  // Show badge URLs
  console.log('Badge URLs (embed in your site):');
  for (const agent of agents.slice(0, 3)) {
    const pubkey = agent.pubkey || agent.subject || '';
    if (pubkey) {
      console.log(`  ${pubkey.slice(0, 12)}...: ${client.badgeUrl(pubkey)}`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
