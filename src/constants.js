/**
 * Shared constants for NIP Agent Reputation.
 * 
 * Kind 30386 is the proposed dedicated kind for agent reputation attestations.
 * Adjacent to NIP-85 trusted assertions (30382-30385) — same trust/reputation domain.
 * Previously used kind 30385 (discovered NIP-85 uses it for NIP-73 identifier assertions),
 * kind 30388 (claimed by Corny Chat "Slide Set"), and kind 30078 (prototyping).
 * Kind 31990 is NIP-89 handler information (unchanged).
 */

// Attestation event kind — proposed dedicated kind per NIP-XX
export const ATTESTATION_KIND = 30386;

// Handler declaration kind — NIP-89 compatible
export const HANDLER_KIND = 31990;

// Legacy kinds (for backwards-compatible querying during migration)
export const LEGACY_KINDS = [30385, 30388, 30078];
