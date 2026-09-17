// Composite scorer — weighted sum of N scorers, normalized to 0..100.
//
// Weights are taken from each scorer's `weight` field by default, but
// callers may override per-scorer (e.g., CP-tuned policy: bump locality
// to 0.4). The normalizer divides by the sum of weights, so the result
// remains 0..100 even if weights don't sum to 1.

import type { AgentCandidate, PlacementContext, ScoreBreakdown, Scorer } from "./types";

export interface CompositeOptions {
  /** Override per-scorer weight by name. */
  weightOverrides?: Record<string, number>;
}

export class CompositeScorer {
  constructor(
    private readonly scorers: Scorer[],
    private readonly opts: CompositeOptions = {},
  ) {}

  /**
   * Score one candidate; return a breakdown so the placement-trace UI can
   * explain WHY a candidate ranked where it did.
   */
  scoreOne(candidate: AgentCandidate, ctx: PlacementContext): ScoreBreakdown {
    let totalWeight = 0;
    let weighted = 0;
    const contributions: ScoreBreakdown["contributions"] = [];
    for (const sc of this.scorers) {
      const w = this.opts.weightOverrides?.[sc.name] ?? sc.weight;
      if (w <= 0) continue;
      const raw = clamp(sc.score(candidate, ctx), 0, 100);
      const wval = raw * w;
      contributions.push({ name: sc.name, raw, weighted: wval });
      weighted += wval;
      totalWeight += w;
    }
    const finalScore = totalWeight === 0 ? 0 : weighted / totalWeight;
    return { agentId: candidate.agentId, finalScore, contributions };
  }

  /** Score and rank a candidate set descending by finalScore. */
  rank(candidates: AgentCandidate[], ctx: PlacementContext): ScoreBreakdown[] {
    return candidates.map((c) => this.scoreOne(c, ctx)).sort((a, b) => b.finalScore - a.finalScore);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
