// Cost scorer — cheaper clusters score higher.
//
// Rate is per-CPU-hour. The total cost for the job at this cluster is
// `rate * expectedCpuHours`. We compute relative cost vs. the cheapest
// candidate seen and map [1.0, 5.0]× → [100, 0].
//
// If the cluster is missing from costRates, the scorer returns 50
// (neutral) rather than penalizing it — pricing data is often partial.
import type { Scorer } from "./types";

const NEUTRAL_SCORE = 50;
const PRICE_RATIO_FLOOR = 1.0;
const PRICE_RATIO_CEIL = 5.0;

export const costScorer: Scorer = {
  name: "cost",
  weight: 0.2,
  score(candidate, ctx) {
    const rate = ctx.costRates[candidate.clusterName];
    if (rate === undefined || rate <= 0) return NEUTRAL_SCORE;

    const myCost = rate * ctx.expectedCpuHours;
    const allRates = Object.values(ctx.costRates).filter((r) => r > 0);
    if (allRates.length === 0) return NEUTRAL_SCORE;
    const minRate = Math.min(...allRates);
    const minCost = minRate * ctx.expectedCpuHours;
    if (minCost === 0) return NEUTRAL_SCORE;

    const ratio = myCost / minCost; // >= 1
    if (ratio <= PRICE_RATIO_FLOOR) return 100;
    if (ratio >= PRICE_RATIO_CEIL) return 0;
    // Linear interpolation in [floor, ceil] -> [100, 0].
    return ((PRICE_RATIO_CEIL - ratio) / (PRICE_RATIO_CEIL - PRICE_RATIO_FLOOR)) * 100;
  },
};
