// Queue-wait scorer — penalize candidates whose historical wait time is
// long compared to the job's expected runtime.
//
// Heuristic:
//   waitRatio = historicalP95WaitSec / max(expectedWallSec, 60)
//   - waitRatio < 0.2  -> 100   (negligible wait)
//   - waitRatio > 5.0  -> 0     (queue dwarfs the job)
//   - linear in between
// Empty queue + zero historical wait → 100.
import type { Scorer } from "./types";

const RATIO_FLOOR = 0.2;
const RATIO_CEIL = 5.0;

export const queueWaitScorer: Scorer = {
  name: "queue-wait",
  weight: 0.2,
  score(candidate, ctx) {
    if (candidate.historicalP95WaitSec <= 0 && candidate.queueDepth === 0) return 100;
    const denom = Math.max(ctx.expectedWallSec, 60);
    const waitRatio = candidate.historicalP95WaitSec / denom;
    if (waitRatio <= RATIO_FLOOR) return 100;
    if (waitRatio >= RATIO_CEIL) return 0;
    return ((RATIO_CEIL - waitRatio) / (RATIO_CEIL - RATIO_FLOOR)) * 100;
  },
};
