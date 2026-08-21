/**
 * Complexity-aware weight rebalancing for the Auto-Combo scorer.
 *
 * The content-aware routing hint (`buildComplexityRoutingHint`) feeds
 * `tierAffinity` / `specificityMatch` factors in `scoring.ts`. Those factors are
 * only meaningful when their weights are non-zero — but every mode pack
 * (`modePacks.ts`) hard-zeros both, and `DEFAULT_WEIGHTS` gives them only 0.05
 * each (enough to break ties, not to re-rank against health/quota). This helper
 * lifts both factors to a decision-relevant budget when complexity-aware routing
 * is active, donating the delta from the two factors least critical to routing
 * *correctness* for a difficulty-matched selection: cost and latency. (Hard cost
 * ceilings are handled separately by the X-OmniRoute-Budget candidate filter, so
 * shaving costInv here does not remove the cost guardrail.)
 *
 * Pure + allocation-only: returns a new weights object, never mutates the input.
 * The result is NOT re-normalized to exactly 1.0 — the scorer computes a weighted
 * sum and compares relatively, so a constant total is unnecessary; we only ensure
 * no weight goes negative.
 */
import type { ScoringWeights } from "./scoring";

/** Target weight for each complexity factor when the feature is active. */
export const COMPLEXITY_FACTOR_WEIGHT = 0.12;

/** Factors we shave to fund the complexity budget, in priority order. */
const DONOR_FACTORS: Array<keyof ScoringWeights> = ["costInv", "latencyInv"];

/**
 * Raise `tierAffinity` and `specificityMatch` to `COMPLEXITY_FACTOR_WEIGHT` each,
 * funding the increase from the donor factors (cost, then latency) without letting
 * any donor go negative. Idempotent-ish: calling it on already-boosted weights is a
 * no-op for the boosted factors (the delta is 0).
 */
export function rebalanceForComplexity(weights: ScoringWeights): ScoringWeights {
  const next: ScoringWeights = { ...weights };

  for (const factor of ["tierAffinity", "specificityMatch"] as const) {
    const current = next[factor] ?? 0;
    let delta = COMPLEXITY_FACTOR_WEIGHT - current;
    if (delta <= 0) continue; // already at/above target — leave it
    next[factor] = COMPLEXITY_FACTOR_WEIGHT;

    // Fund `delta` from donors, in order, clamping each at 0.
    for (const donor of DONOR_FACTORS) {
      if (delta <= 0) break;
      const available = next[donor] ?? 0;
      const take = Math.min(available, delta);
      next[donor] = available - take;
      delta -= take;
    }
    // If donors were exhausted, the remaining delta is simply added budget — the
    // scorer normalizes relatively, so an oversized total still ranks correctly.
  }

  return next;
}
