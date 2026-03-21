/**
 * Shared constants for NIP Agent Reputation.
 * 
 * Kind 30388 is the proposed dedicated kind for agent reputation attestations.
 * Previously used kind 30078 (application-specific data) during initial development.
 * Kind 31990 is NIP-89 handler information (unchanged).
 */

// Attestation event kind — proposed dedicated kind per NIP-XX
export const ATTESTATION_KIND = 30388;

// Handler declaration kind — NIP-89 compatible
export const HANDLER_KIND = 31990;

// Legacy kind (for backwards-compatible querying during migration)
export const LEGACY_ATTESTATION_KIND = 30078;
