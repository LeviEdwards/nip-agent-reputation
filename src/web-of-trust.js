/**
 * Web-of-Trust scoring for NIP Agent Reputation.
 * 
 * Sybil resistance via recursive attester reputation weighting:
 * When aggregating attestations for a subject, each attester's own
 * reputation modulates the weight of their attestation.
 * 
 * Algorithm:
 *   1. Query attestations for subject S
 *   2. For each attester A, compute A's "trust score" (their own reputation)
 *   3. Multiply A's attestation weight by A's trust score
 *   4. Aggregate with trust-modulated weights
 * 
 * Trust score sources (in priority order):
 *   - Bilateral attestations from other reputable nodes (recursive, depth-limited)
 *   - Observable Lightning graph data (channel count, capacity, age)
 *   - Self-attestation baseline (low weight, prevents cold start deadlock)
 * 
 * Depth limit prevents infinite recursion. Default: 2 hops.
 * Cache prevents redundant queries within a single scoring session.
 * 
 * Usage:
 *   import { WebOfTrust } from './web-of-trust.js';
 *   
 *   const wot = new WebOfTrust({ maxDepth: 2, queryFn: queryAttestations });
 *   const scored = await wot.score('subject_pubkey');
 *   // scored.dimensions — trust-weighted dimension aggregates
 *   // scored.trustGraph — who attested, their trust scores, effective weights
 */

import { aggregateAttestations } from './attestation.js';

// Default configuration
const DEFAULTS = {
  maxDepth: 2,            // Maximum recursion depth for trust lookups
  selfTrustFloor: 0.1,   // Minimum trust for self-only attesters (prevents deadlock)
  unknownTrustFloor: 0.05, // Trust for completely unknown attesters
  bilateralBonus: 0.3,   // Bonus trust per bilateral attestation received
  graphCapacityWeight: 0.0000001, // Trust per sat of channel capacity (1M sats ≈ 0.1)
  graphChannelWeight: 0.02, // Trust per channel
  maxTrustScore: 1.0,     // Cap trust at 1.0
  cacheTtlMs: 300000,    // Cache entries valid for 5 minutes
};

/**
 * Attestation type weights (from spec).
 */
const TYPE_WEIGHTS = {
  bilateral: 1.0,
  observer: 0.7,
  self: 0.3,
};

/**
 * Trust cache entry.
 */
class TrustCacheEntry {
  constructor(pubkey, trustScore, depth, attestationCount, sources) {
    this.pubkey = pubkey;
    this.trustScore = trustScore;
    this.depth = depth;
    this.attestationCount = attestationCount;
    this.sources = sources; // array of { type, contribution }
    this.cachedAt = Date.now();
  }

  isValid(ttlMs) {
    return Date.now() - this.cachedAt < ttlMs;
  }
}

/**
 * Result of scoring a subject.
 */
export class ScoredReputation {
  constructor(subjectPubkey) {
    this.subjectPubkey = subjectPubkey;
    this.dimensions = {};      // name → { weightedAvg, totalWeight, numAttesters }
    this.trustGraph = [];       // array of { attester, trustScore, effectiveWeight, attestationType, sources }
    this.rawAttestations = [];  // original attestations before trust weighting
    this.meta = {
      depth: 0,
      cacheHits: 0,
      queriesMade: 0,
      sybilFlags: [],
    };
  }

  /**
   * Overall confidence: sum of trust-weighted attestation weights.
   * Higher = more trustworthy attesters have attested this subject.
   */
  get confidence() {
    return this.trustGraph.reduce((sum, entry) => sum + entry.effectiveWeight, 0);
  }

  /**
   * Sybil risk assessment.
   */
  get sybilRisk() {
    if (this.trustGraph.length === 0) return 'unknown';
    
    const selfOnly = this.trustGraph.every(e => e.attestationType === 'self');
    if (selfOnly) return 'high';
    
    const lowTrustAttesters = this.trustGraph.filter(e => e.trustScore < 0.2);
    if (lowTrustAttesters.length > this.trustGraph.length * 0.7) return 'elevated';
    
    const uniqueAttesters = new Set(this.trustGraph.map(e => e.attester));
    if (uniqueAttesters.size >= 3 && this.confidence > 1.0) return 'low';
    
    return 'moderate';
  }

  toJSON() {
    return {
      subjectPubkey: this.subjectPubkey,
      dimensions: this.dimensions,
      confidence: this.confidence,
      sybilRisk: this.sybilRisk,
      trustGraph: this.trustGraph,
      meta: this.meta,
    };
  }
}

/**
 * Web-of-Trust engine for recursive trust scoring.
 */
export class WebOfTrust {
  /**
   * @param {object} opts
   * @param {function} opts.queryFn - (pubkey) => Promise<attestation[]> — fetches attestations
   * @param {function} [opts.graphFn] - (pubkey) => Promise<{channels, capacity}> — LND graph lookup
   * @param {number} [opts.maxDepth] - Max recursion depth
   */
  constructor(opts = {}) {
    this.queryFn = opts.queryFn;
    this.graphFn = opts.graphFn || null;
    this.config = { ...DEFAULTS, ...opts };
    this.cache = new Map();  // pubkey → TrustCacheEntry
    this._queriesMade = 0;
    this._cacheHits = 0;
  }

  /**
   * Score a subject's reputation using web-of-trust weighted aggregation.
   * 
   * @param {string} subjectPubkey - Pubkey to evaluate
   * @returns {Promise<ScoredReputation>}
   */
  async score(subjectPubkey) {
    if (!this.queryFn) throw new Error('queryFn is required');

    const result = new ScoredReputation(subjectPubkey);

    // Step 1: Get attestations for subject
    const attestations = await this._query(subjectPubkey);
    result.rawAttestations = attestations;

    if (attestations.length === 0) {
      result.meta.queriesMade = this._queriesMade;
      result.meta.cacheHits = this._cacheHits;
      return result;
    }

    // Step 2: Compute trust score for each attester
    const attesterScores = new Map();
    for (const att of attestations) {
      if (att.attester === subjectPubkey) {
        // Self-attestation: use selfTrustFloor (can't vouch for yourself)
        attesterScores.set(att.attester, {
          trustScore: this.config.selfTrustFloor,
          sources: [{ type: 'self', contribution: this.config.selfTrustFloor }],
        });
        continue;
      }

      if (!attesterScores.has(att.attester)) {
        const trust = await this._computeTrust(att.attester, 1, new Set([subjectPubkey]));
        attesterScores.set(att.attester, trust);
      }
    }

    // Step 3: Compute trust-weighted dimensions
    const trustWeightedDimensions = {};

    for (const att of attestations) {
      const attesterInfo = attesterScores.get(att.attester);
      const trustScore = attesterInfo ? attesterInfo.trustScore : this.config.unknownTrustFloor;
      const typeWeight = TYPE_WEIGHTS[att.attestationType] || 0.3;
      const effectiveWeight = att.decayWeight * typeWeight * trustScore;

      // Record in trust graph
      result.trustGraph.push({
        attester: att.attester,
        trustScore,
        typeWeight,
        decayWeight: att.decayWeight,
        effectiveWeight,
        attestationType: att.attestationType,
        sources: attesterInfo ? attesterInfo.sources : [{ type: 'unknown', contribution: 0 }],
      });

      // Aggregate dimensions
      for (const dim of att.dimensions) {
        if (!trustWeightedDimensions[dim.name]) {
          trustWeightedDimensions[dim.name] = { weightedSum: 0, totalWeight: 0, attesters: new Set() };
        }
        const d = trustWeightedDimensions[dim.name];
        const val = parseFloat(dim.value);
        if (!isNaN(val)) {
          d.weightedSum += val * effectiveWeight;
          d.totalWeight += effectiveWeight;
          d.attesters.add(att.attester);
        }
      }
    }

    // Step 4: Finalize dimensions
    for (const [name, data] of Object.entries(trustWeightedDimensions)) {
      result.dimensions[name] = {
        weightedAvg: data.totalWeight > 0 ? data.weightedSum / data.totalWeight : 0,
        totalWeight: Math.round(data.totalWeight * 10000) / 10000,
        numAttesters: data.attesters.size,
      };
    }

    // Sybil detection flags
    this._detectSybilPatterns(result);

    result.meta.depth = this.config.maxDepth;
    result.meta.queriesMade = this._queriesMade;
    result.meta.cacheHits = this._cacheHits;

    return result;
  }

  /**
   * Compute trust score for an attester (recursive).
   * 
   * @param {string} pubkey - Attester to evaluate
   * @param {number} depth - Current recursion depth
   * @param {Set<string>} visited - Pubkeys already in the chain (cycle prevention)
   * @returns {Promise<{trustScore, sources}>}
   */
  async _computeTrust(pubkey, depth, visited) {
    // Check cache
    const cached = this.cache.get(pubkey);
    if (cached && cached.isValid(this.config.cacheTtlMs)) {
      this._cacheHits++;
      return { trustScore: cached.trustScore, sources: cached.sources };
    }

    // Depth limit reached: use floor
    if (depth > this.config.maxDepth) {
      return {
        trustScore: this.config.unknownTrustFloor,
        sources: [{ type: 'depth-limit', contribution: this.config.unknownTrustFloor }],
      };
    }

    visited = new Set(visited);
    visited.add(pubkey);

    let trustScore = 0;
    const sources = [];

    // Source 1: Graph data (if available)
    if (this.graphFn) {
      try {
        const graphData = await this.graphFn(pubkey);
        if (graphData) {
          const capacityTrust = Math.min(
            graphData.capacity * this.config.graphCapacityWeight,
            0.3 // cap graph-capacity contribution
          );
          const channelTrust = Math.min(
            graphData.channels * this.config.graphChannelWeight,
            0.3 // cap graph-channel contribution
          );
          const graphTrust = capacityTrust + channelTrust;
          trustScore += graphTrust;
          sources.push({ type: 'graph-capacity', contribution: capacityTrust, capacity: graphData.capacity });
          sources.push({ type: 'graph-channels', contribution: channelTrust, channels: graphData.channels });
        }
      } catch {
        // Graph lookup failed — continue without it
      }
    }

    // Source 2: Bilateral attestations received by this attester
    try {
      const attestations = await this._query(pubkey);
      const bilateral = attestations.filter(
        a => a.attestationType === 'bilateral' && !visited.has(a.attester)
      );

      if (bilateral.length > 0) {
        // Each bilateral attester contributes trust, modulated by their own trust (recursive)
        let bilateralTrust = 0;
        for (const att of bilateral) {
          let attesterTrust;
          if (depth + 1 > this.config.maxDepth) {
            attesterTrust = this.config.unknownTrustFloor;
          } else {
            const result = await this._computeTrust(att.attester, depth + 1, visited);
            attesterTrust = result.trustScore;
          }
          bilateralTrust += this.config.bilateralBonus * att.decayWeight * Math.max(attesterTrust, this.config.unknownTrustFloor);
        }
        bilateralTrust = Math.min(bilateralTrust, 0.5); // cap bilateral contribution
        trustScore += bilateralTrust;
        sources.push({ type: 'bilateral-received', contribution: bilateralTrust, count: bilateral.length });
      }

      // Source 3: Self-attestation (low contribution, prevents total zero)
      const selfAtts = attestations.filter(a => a.attestationType === 'self');
      if (selfAtts.length > 0) {
        const selfContribution = this.config.selfTrustFloor;
        trustScore += selfContribution;
        sources.push({ type: 'self-attestation', contribution: selfContribution });
      }
    } catch {
      // Query failed — use floor
    }

    // Ensure minimum floor
    trustScore = Math.max(trustScore, this.config.unknownTrustFloor);
    trustScore = Math.min(trustScore, this.config.maxTrustScore);

    // Cache result
    this.cache.set(pubkey, new TrustCacheEntry(
      pubkey, trustScore, depth, 0, sources
    ));

    return { trustScore, sources };
  }

  /**
   * Detect sybil patterns in the trust graph.
   */
  _detectSybilPatterns(result) {
    const flags = [];

    // Pattern 1: All attesters are low-trust
    const lowTrustCount = result.trustGraph.filter(e => e.trustScore <= this.config.selfTrustFloor).length;
    if (lowTrustCount === result.trustGraph.length && result.trustGraph.length > 0) {
      flags.push('all-attesters-low-trust');
    }

    // Pattern 2: Suspiciously uniform scores across attesters
    if (result.trustGraph.length >= 3) {
      const bilaterals = result.trustGraph.filter(e => e.attestationType === 'bilateral');
      if (bilaterals.length >= 3) {
        // Check if all attesters gave nearly identical dimension values
        // (real attesters have variance; sybils copy-paste)
        const dimValues = {};
        for (const att of result.rawAttestations) {
          if (att.attestationType !== 'bilateral') continue;
          for (const dim of att.dimensions) {
            if (!dimValues[dim.name]) dimValues[dim.name] = [];
            dimValues[dim.name].push(parseFloat(dim.value));
          }
        }
        for (const [name, values] of Object.entries(dimValues)) {
          if (values.length >= 3) {
            const mean = values.reduce((a, b) => a + b, 0) / values.length;
            const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
            const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : 0;
            // Coefficient of variation < 0.01 with 3+ attesters is suspicious
            if (cv < 0.01) {
              flags.push(`suspiciously-uniform:${name}`);
            }
          }
        }
      }
    }

    // Pattern 3: Mutual attestation ring (A→B, B→A only)
    // Detected if an attester also appears as a subject in the attester's own attestations
    // This requires deeper analysis — flag if attester set is very small relative to total attestations
    if (result.trustGraph.length >= 2) {
      const uniqueAttesters = new Set(result.trustGraph.map(e => e.attester));
      if (uniqueAttesters.size <= 1 && result.trustGraph.length > 1) {
        flags.push('single-attester-multiple-attestations');
      }
    }

    result.meta.sybilFlags = flags;
  }

  /**
   * Internal query with stats tracking.
   */
  async _query(pubkey) {
    this._queriesMade++;
    return this.queryFn(pubkey);
  }

  /**
   * Clear the trust cache.
   */
  clearCache() {
    this.cache.clear();
    this._queriesMade = 0;
    this._cacheHits = 0;
  }
}
