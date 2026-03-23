/**
 * Shared constants for NIP Agent Reputation.
 * 
 * Kind 30385 is the proposed dedicated kind for agent reputation attestations.
 * Adjacent to NIP-85 trusted assertions (30382-30384) — same trust/reputation domain.
 * Previously used kind 30388 (discovered to be claimed by Corny Chat "Slide Set"),
 * and kind 30078 (application-specific data) during initial prototyping.
 * Kind 31990 is NIP-89 handler information (unchanged).
 */

// Attestation event kind — proposed dedicated kind per NIP-XX
export const ATTESTATION_KIND = 30385;

// Handler declaration kind — NIP-89 compatible
export const HANDLER_KIND = 31990;

// Legacy kind (for backwards-compatible querying during migration)
export const LEGACY_ATTESTATION_KIND = 30078;
