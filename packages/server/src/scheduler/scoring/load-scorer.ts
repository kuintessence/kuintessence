// Load scorer — extracted from the legacy auto stage.
// Lower load => higher score. Linear inverse: score = 100 - loadPercent.
import type { Scorer } from "./types";

export const loadScorer: Scorer = {
  name: "load",
  weight: 0.4,
  score(candidate) {
    const load = clamp(candidate.loadPercent, 0, 100);
    return 100 - load;
  },
};

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
