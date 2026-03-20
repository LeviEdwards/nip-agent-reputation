#!/usr/bin/env node

/**
 * Tests for observer attestation module.
 */

import { getKeypair } from './keys.js';
import {
  ProbeResult,
  ChannelSnapshot,
  ObservationSession,
  buildObserverAttestation,
} from './observer.js';
import { parseAttestation, aggregateAttestations } from './attestation.js';
import { buildSelfAttestation } from './attestation.js';
import { buildBilateralAttestation } from './bilateral.js';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}`);
    failed++;
  }
}

const kp = getKeypair();
const SUBJECT_NODE_PUBKEY = '03864ef025fde8fb587d989186ce6a4a186895ee44a926bfc370e2c366597a3f8f'; // ACINQ
const SUBJECT_NOSTR_PUBKEY = 'a'.repeat(64);

// ===== Phase 1: ProbeResult construction =====
console.log('\n=== Phase 1: ProbeResult Construction ===');

const probe1 = new ProbeResult({ reachable: true, latencyMs: 120, method: 'ping' });
assert(probe1.reachable === true, 'Probe reachable');
assert(probe1.latencyMs === 120, 'Probe latency');
assert(probe1.method === 'ping', 'Probe method');
assert(typeof probe1.timestamp === 'number', 'Probe has timestamp');

const probe2 = new ProbeResult({ reachable: false, error: 'connection refused' });
assert(probe2.reachable === false, 'Failed probe');
assert(probe2.error === 'connection refused', 'Error captured');
assert(probe2.latencyMs === null, 'No latency on failure');

const probeDefaults = new ProbeResult();
assert(probeDefaults.reachable === true, 'Default: reachable');
assert(probeDefaults.method === 'ping', 'Default: method ping');

// ===== Phase 2: ChannelSnapshot construction =====
console.log('\n=== Phase 2: ChannelSnapshot Construction ===');

const snap1 = new ChannelSnapshot({ numChannels: 5, totalCapacitySats: 2000000, activeChannels: 4, peers: 3 });
assert(snap1.numChannels === 5, 'Channel count');
assert(snap1.totalCapacitySats === 2000000, 'Total capacity');
assert(snap1.activeChannels === 4, 'Active channels');
assert(snap1.peers === 3, 'Peer count');

const snapDefaults = new ChannelSnapshot();
assert(snapDefaults.numChannels === 0, 'Default: 0 channels');
assert(snapDefaults.totalCapacitySats === 0, 'Default: 0 capacity');

// ===== Phase 3: ObservationSession =====
console.log('\n=== Phase 3: ObservationSession ===');

const session = new ObservationSession(SUBJECT_NODE_PUBKEY, 'lightning-node', {
  subjectNostrPubkey: SUBJECT_NOSTR_PUBKEY,
  observerNote: 'Automated monitoring',
});
assert(session.subjectNodePubkey === SUBJECT_NODE_PUBKEY, 'Subject pubkey set');
assert(session.serviceType === 'lightning-node', 'Service type set');
assert(session.subjectNostrPubkey === SUBJECT_NOSTR_PUBKEY, 'Nostr pubkey set');
assert(session.probes.length === 0, 'No probes yet');
assert(session.channelSnapshots.length === 0, 'No snapshots yet');

// Record probes
const now = Math.floor(Date.now() / 1000);
session.recordProbe({ reachable: true, latencyMs: 100, timestamp: now - 3600 });
session.recordProbe({ reachable: true, latencyMs: 150, timestamp: now - 2700 });
session.recordProbe({ reachable: false, timestamp: now - 1800, error: 'timeout' });
session.recordProbe({ reachable: true, latencyMs: 200, timestamp: now - 900 });
session.recordProbe({ reachable: true, latencyMs: 130, timestamp: now });
assert(session.probes.length === 5, 'Recorded 5 probes');

// Record channel snapshots
session.recordChannelState({ numChannels: 5, totalCapacitySats: 2000000, activeChannels: 5, timestamp: now - 3600 });
session.recordChannelState({ numChannels: 5, totalCapacitySats: 2100000, activeChannels: 4, timestamp: now });
assert(session.channelSnapshots.length === 2, 'Recorded 2 snapshots');

// Compute dimensions
const dims = session.computeDimensions();
assert(dims.uptime_percent !== undefined, 'Has uptime dimension');
assert(dims.uptime_percent.value === '80.0', `Uptime = 80% (4/5 reachable) — got ${dims.uptime_percent.value}`);
assert(dims.uptime_percent.sampleSize === 5, 'Uptime sample size = 5');

assert(dims.response_time_ms !== undefined, 'Has response time dimension');
// Average of 100, 150, 200, 130 = 145
assert(dims.response_time_ms.value === '145', `Avg response time = 145ms — got ${dims.response_time_ms.value}`);
assert(dims.response_time_ms.sampleSize === 4, 'Response time sample = 4 (excludes failed)');

assert(dims.capacity_sats !== undefined, 'Has capacity dimension');
assert(dims.capacity_sats.value === '2100000', `Capacity = latest snapshot — got ${dims.capacity_sats.value}`);

assert(dims.num_channels !== undefined, 'Has num_channels dimension');
assert(dims.num_channels.value === '5', `Num channels = 5 — got ${dims.num_channels.value}`);

assert(dims.channel_availability !== undefined, 'Has channel_availability dimension');
assert(dims.channel_availability.value === '1.0000', `All snapshots had active channels — got ${dims.channel_availability.value}`);

// Window hours
assert(session.windowHours >= 1, `Window hours > 0 — got ${session.windowHours}`);

// ===== Phase 4: Empty session edge case =====
console.log('\n=== Phase 4: Empty Session Edge Cases ===');

const emptySession = new ObservationSession(SUBJECT_NODE_PUBKEY);
const emptyDims = emptySession.computeDimensions();
assert(Object.keys(emptyDims).length === 0, 'Empty session has no dimensions');
assert(emptySession.windowHours === 0, 'Empty session window = 0');

try {
  buildObserverAttestation(emptySession, kp.secretKey);
  assert(false, 'Should throw on empty session');
} catch (e) {
  assert(e.message.includes('No observations'), 'Throws on empty session');
}

// Probes only (no channel data)
const probeOnlySession = new ObservationSession(SUBJECT_NODE_PUBKEY);
probeOnlySession.recordProbe({ reachable: true, latencyMs: 50 });
const probeOnlyDims = probeOnlySession.computeDimensions();
assert(probeOnlyDims.uptime_percent !== undefined, 'Probe-only has uptime');
assert(probeOnlyDims.capacity_sats === undefined, 'Probe-only has no capacity');

// Channel only (no probes)
const channelOnlySession = new ObservationSession(SUBJECT_NODE_PUBKEY);
channelOnlySession.recordChannelState({ numChannels: 3, totalCapacitySats: 500000, activeChannels: 3 });
const channelOnlyDims = channelOnlySession.computeDimensions();
assert(channelOnlyDims.capacity_sats !== undefined, 'Channel-only has capacity');
assert(channelOnlyDims.uptime_percent === undefined, 'Channel-only has no uptime');

// ===== Phase 5: Build Observer Attestation Event =====
console.log('\n=== Phase 5: Build Observer Attestation ===');

const event = buildObserverAttestation(session, kp.secretKey, {
  observerDescription: 'Automated Lightning network monitor',
});

assert(event.kind === 30078, 'Kind 30078');
assert(event.id.length === 64, 'Has valid event ID');
assert(event.sig.length === 128, 'Has valid signature');

const tags = event.tags;
const getTag = (name) => tags.find(t => t[0] === name);
const getAllTags = (name) => tags.filter(t => t[0] === name);

assert(getTag('d')[1] === `${SUBJECT_NODE_PUBKEY}:lightning-node`, 'd tag correct');
assert(getTag('service_type')[1] === 'lightning-node', 'Service type tag');
assert(getTag('node_pubkey')[1] === SUBJECT_NODE_PUBKEY, 'Node pubkey tag');
assert(getTag('p')[1] === SUBJECT_NOSTR_PUBKEY, 'p tag for Nostr pubkey');
assert(getTag('attestation_type')[1] === 'observer', 'Attestation type = observer');
assert(getTag('observation_method') !== null, 'Has observation_method tag');
assert(getTag('L')[1] === 'agent-reputation', 'L label tag');
assert(getTag('l')[1] === 'attestation', 'l label tag');

const dimTags = getAllTags('dimension');
assert(dimTags.length >= 4, `Has ≥4 dimension tags — got ${dimTags.length}`);

// Verify content
const content = JSON.parse(event.content);
assert(content.attestation_type === 'observer', 'Content type = observer');
assert(content.num_probes === 5, 'Content records 5 probes');
assert(content.num_channel_snapshots === 2, 'Content records 2 snapshots');
assert(content.observer_description === 'Automated Lightning network monitor', 'Observer description in content');

// ===== Phase 6: Parse Observer Attestation =====
console.log('\n=== Phase 6: Parse Observer Attestation ===');

const parsed = parseAttestation(event);
assert(parsed.attestationType === 'observer', 'Parsed type = observer');
assert(parsed.nodePubkey === SUBJECT_NODE_PUBKEY, 'Parsed node pubkey');
assert(parsed.serviceType === 'lightning-node', 'Parsed service type');
assert(parsed.dimensions.length >= 4, 'Parsed dimensions');
assert(parsed.decayWeight > 0.99, 'Fresh event has ~1.0 decay weight');

const uptimeDim = parsed.dimensions.find(d => d.name === 'uptime_percent');
assert(uptimeDim && uptimeDim.value === 80, `Parsed uptime = 80 — got ${uptimeDim?.value}`);

// ===== Phase 7: Aggregation with Other Types =====
console.log('\n=== Phase 7: Mixed Aggregation (self + bilateral + observer) ===');

// Simulate self-attestation with uptime 99%
const selfAtt = {
  id: 'self001',
  attester: 'self_pubkey',
  attestationType: 'self',
  dimensions: [{ name: 'uptime_percent', value: 99.0, sampleSize: 10 }],
  decayWeight: 1.0,
  halfLifeHours: 720,
};

// Simulate bilateral with uptime 95%
const bilateralAtt = {
  id: 'bilateral001',
  attester: 'bilateral_pubkey',
  attestationType: 'bilateral',
  dimensions: [{ name: 'uptime_percent', value: 95.0, sampleSize: 20 }],
  decayWeight: 1.0,
  halfLifeHours: 720,
};

// Observer with uptime 80%
const observerAtt = {
  id: 'observer001',
  attester: 'observer_pubkey',
  attestationType: 'observer',
  dimensions: [{ name: 'uptime_percent', value: 80.0, sampleSize: 5 }],
  decayWeight: 1.0,
  halfLifeHours: 720,
};

const agg = aggregateAttestations([selfAtt, bilateralAtt, observerAtt]);

// Weights: self=0.3, bilateral=1.0, observer=0.7
// Weighted sum: 99*0.3 + 95*1.0 + 80*0.7 = 29.7 + 95 + 56 = 180.7
// Total weight: 0.3 + 1.0 + 0.7 = 2.0
// Weighted avg: 180.7 / 2.0 = 90.35
assert(agg.uptime_percent !== undefined, 'Aggregated uptime exists');
const expected = 180.7 / 2.0;
const actual = agg.uptime_percent.weightedAvg;
assert(Math.abs(actual - expected) < 0.01, `Weighted avg = ${expected.toFixed(2)} — got ${actual.toFixed(2)}`);
assert(agg.uptime_percent.numAttesters === 3, '3 attesters');
assert(agg.uptime_percent.totalWeight === 2.0, `Total weight = 2.0 — got ${agg.uptime_percent.totalWeight}`);

// Observer-only aggregation
const observerOnlyAgg = aggregateAttestations([observerAtt]);
assert(observerOnlyAgg.uptime_percent.totalWeight === 0.7, 'Observer-only weight = 0.7');
assert(observerOnlyAgg.uptime_percent.weightedAvg === 80.0, 'Observer-only avg = raw value');

// ===== Phase 8: Serialization Round-Trip =====
console.log('\n=== Phase 8: Serialization Round-Trip ===');

const json = session.toJSON();
assert(json.subjectNodePubkey === SUBJECT_NODE_PUBKEY, 'JSON has pubkey');
assert(json.probes.length === 5, 'JSON has 5 probes');
assert(json.channelSnapshots.length === 2, 'JSON has 2 snapshots');

const restored = ObservationSession.fromJSON(json);
assert(restored.subjectNodePubkey === SUBJECT_NODE_PUBKEY, 'Restored pubkey');
assert(restored.probes.length === 5, 'Restored probes');
assert(restored.channelSnapshots.length === 2, 'Restored snapshots');

const restoredDims = restored.computeDimensions();
assert(restoredDims.uptime_percent.value === dims.uptime_percent.value, 'Restored uptime matches');
assert(restoredDims.response_time_ms.value === dims.response_time_ms.value, 'Restored latency matches');
assert(restoredDims.capacity_sats.value === dims.capacity_sats.value, 'Restored capacity matches');

// Build event from restored session
const restoredEvent = buildObserverAttestation(restored, kp.secretKey);
assert(restoredEvent.kind === 30078, 'Restored event valid');
const restoredParsed = parseAttestation(restoredEvent);
assert(restoredParsed.attestationType === 'observer', 'Restored event type = observer');

// ===== Phase 9: All probes fail =====
console.log('\n=== Phase 9: All Probes Fail ===');

const allFailSession = new ObservationSession(SUBJECT_NODE_PUBKEY);
allFailSession.recordProbe({ reachable: false, timestamp: now - 300 });
allFailSession.recordProbe({ reachable: false, timestamp: now });
const allFailDims = allFailSession.computeDimensions();
assert(allFailDims.uptime_percent.value === '0.0', 'All fail = 0% uptime');
assert(allFailDims.response_time_ms === undefined, 'No response time when all fail');

// Can still build attestation (0% uptime is valid data)
const allFailEvent = buildObserverAttestation(allFailSession, kp.secretKey);
assert(allFailEvent.kind === 30078, '0% uptime attestation is valid');

// ===== Phase 10: Channel availability with inactive snapshots =====
console.log('\n=== Phase 10: Channel Availability Edge Cases ===');

const mixedSession = new ObservationSession(SUBJECT_NODE_PUBKEY);
mixedSession.recordChannelState({ numChannels: 3, totalCapacitySats: 500000, activeChannels: 3 });
mixedSession.recordChannelState({ numChannels: 3, totalCapacitySats: 500000, activeChannels: 0 });
mixedSession.recordChannelState({ numChannels: 0, totalCapacitySats: 0, activeChannels: 0 });

const mixedDims = mixedSession.computeDimensions();
// 1 out of 3 snapshots had active channels
assert(mixedDims.channel_availability.value === '0.3333', `Availability = 1/3 — got ${mixedDims.channel_availability.value}`);
assert(mixedDims.capacity_sats.value === '0', 'Latest snapshot capacity = 0 (node went down)');

// ===== Results =====
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
