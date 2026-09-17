// auto-scoring barrel.
//
// The auto stage of the placement pipeline (`packages/server/src/scheduler/auto-stage.ts`)
// imports `defaultScorers` and `CompositeScorer` to compute a ranking
// over the surviving candidates from earlier stages.

export { type CompositeOptions, CompositeScorer } from "./composite";
export { costScorer } from "./cost-scorer";
export { loadScorer } from "./load-scorer";
export { localityScorer } from "./locality-scorer";
export { queueWaitScorer } from "./queue-wait-scorer";
export type { AgentCandidate, PlacementContext, ScoreBreakdown, Scorer } from "./types";

import { costScorer } from "./cost-scorer";
import { loadScorer } from "./load-scorer";
import { localityScorer } from "./locality-scorer";
import { queueWaitScorer } from "./queue-wait-scorer";
import type { Scorer } from "./types";

/** The default scorer set the auto stage uses unless overridden. */
export const defaultScorers: Scorer[] = [loadScorer, costScorer, localityScorer, queueWaitScorer];
