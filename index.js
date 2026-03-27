/**
 * nip-agent-reputation — Nostr protocol for agent reputation attestations on Lightning Network
 * 
 * Reference implementation of NIP-XX (Agent Reputation Attestations).
 * Provides tools for building, publishing, querying, and aggregating
 * reputation attestations anchored in real Lightning Network settlement data.
 * 
 * @module nip-agent-reputation
 */

// Constants
export { ATTESTATION_KIND, HANDLER_KIND, LEGACY_KINDS } from './src/constants.js';

// Core attestation building, publishing, and querying
export {
  buildSelfAttestation,
  publishToRelays,
  queryAttestations,
  parseAttestation,
  meetsMinSampleSize,
  aggregateAttestations,
  DEFAULT_RELAYS,
  MIN_SAMPLE_SIZES,
} from './src/attestation.js';

// Bilateral attestations (post-transaction)
export {
  TransactionRecord,
  TransactionHistory,
  buildBilateralAttestation,
  buildBilateralFromHistory,
} from './src/bilateral.js';

// Observer attestations (third-party monitoring)
export {
  ProbeResult,
  ChannelSnapshot,
  ObservationSession,
  buildObserverAttestation,
  observeNodeFromGraph,
} from './src/observer.js';

// Service handler declarations (NIP-89 compatible)
export {
  buildServiceHandler,
  parseServiceHandler,
  queryServiceHandlers,
} from './src/handler.js';

// Auto-publish (periodic attestation updates)
export {
  loadState as loadAutoPublishState,
  saveState as saveAutoPublishState,
  detectMeaningfulChange,
  shouldPublish,
  recordPublish,
} from './src/auto-publish.js';

// Web-of-trust scoring
export {
  ScoredReputation,
  WebOfTrust,
} from './src/web-of-trust.js';

// Service discovery
export {
  discoverServices,
  formatDiscoveryResults,
} from './src/discover.js';

// Validation
export {
  validateAttestation,
  validateHandler,
  validateBatch,
} from './src/validate.js';

// HTTP API Server
export {
  createServer,
} from './src/server.js';

// Key management
export {
  getKeypair,
} from './src/keys.js';

// LND data collection
export {
  collectLndMetrics,
} from './src/lnd.js';

// Monitoring & fulfillment
export {
  probeEndpoint,
  checkSecurityHeaders,
  runMonitoringCycle,
  initRegistry,
} from './src/monitor.js';

export {
  fulfillOrder,
  scanAndFulfill,
} from './src/fulfill.js';

// Recurring billing
export {
  addToBilling,
  checkDueAccounts,
  markInvoiced,
  markPaid,
  suspendAccount,
  getBillingStatus,
  runBillingCycle,
  loadBillingAccounts,
  saveBillingAccounts,
  buildInvoiceMemo,
} from './src/billing.js';
