// auto stage now drives the full composite scorer.
//
// The auto stage doesn't reject candidates — it RANKS the survivors of every
// earlier stage by writing a normalised 0..100 score to `scoreSink` keyed by
// agentId. The pipeline reads that sink to pick the final placement and the
// trace builder reads it to render the survivor cards.
//
// `CompositeScorer` combines load, cost, locality, and queue-wait scorers.
// Per-axis weights come from
// `preferences.softWeights` (translated by `softWeightsToOverrides`).

import { createLogger } from "@kuintessence/shared";
import { CompositeScorer, defaultScorers, type ScoreBreakdown } from "../scoring";
import {
  softWeightsToOverrides,
  toAgentCandidate,
  toScoringContext,
} from "../scoring/from-pipeline";
import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

const logger = createLogger("placement-pipeline");

export class AutoFilter implements FilterStage {
  readonly name = "auto";

  /**
   * Most recent breakdowns (keyed by agentId) so callers that wire up a
   * trace channel can pick up per-scorer contributions. Not part of the
   * `FilterStage` contract — `placement-trace.ts` reads the score sink and
   * the trace UI degrades gracefully if breakdowns are absent.
   */
  readonly breakdowns: Map<string, ScoreBreakdown> = new Map();

  constructor(
    /** Mutate this map keyed by agentId to store final 0..100 scores. */
    private scoreSink: Map<string, number>,
    private composite: CompositeScorer = new CompositeScorer(defaultScorers),
  ) {}

  evaluate(agent: AgentRow, ctx: PlacementContext): StageResult {
    const candidate = toAgentCandidate(agent);
    const scoringCtx = toScoringContext(ctx);
    const overrides = softWeightsToOverrides(ctx.preferences.softWeights);

    // We rebuild the composite per-evaluate so weight overrides from the
    // *current* job's preferences win without mutating the shared instance.
    // This is cheap (`new CompositeScorer(...)` just stores the array).
    const composite =
      Object.keys(overrides).length === 0
        ? this.composite
        : new CompositeScorer(defaultScorers, { weightOverrides: overrides });

    const breakdown = composite.scoreOne(candidate, scoringCtx);
    const preferredIndex = ctx.preferredQueueSelections?.findIndex(
      (queue) => queue.agentId === agent.agentId && queue.schedulerType === agent.schedulerType,
    );
    const plannedIndex = ctx.preferredAgentIds?.indexOf(agent.agentId) ?? -1;
    const finalScore =
      plannedIndex >= 0
        ? 20_000 - plannedIndex
        : preferredIndex !== undefined && preferredIndex >= 0
          ? 10_000 - preferredIndex
          : breakdown.finalScore;
    this.scoreSink.set(agent.agentId, finalScore);
    this.breakdowns.set(agent.agentId, breakdown);

    // Surface the breakdown via the existing pipeline logger. The shared
    // `PlacementTrace` schema does not yet have a `scoreBreakdowns` channel,
    // so this is the cheapest hook that keeps the data observable.
    // TODO: extend `PlacementTrace` with per-agent score breakdowns and
    // populate them from this map in `placement-trace.ts`.
    logger.debug(
      {
        stage: this.name,
        agentId: agent.agentId,
        finalScore,
        contributions: breakdown.contributions,
      },
      "auto-stage score breakdown",
    );

    return { kind: "pass" };
  }
}
