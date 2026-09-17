// auto-scoring extension types.
//
// Each scorer is a pure function that takes a candidate agent + placement
// context and returns a 0..100 score. The composite scorer takes a list
// of scorers with weights and returns a normalized weighted sum.
//
// Drop a new file into this directory and add it to the registry in
// `index.ts` to plug a new dimension into the auto stage.

export interface AgentCandidate {
  agentId: string;
  siteId: string;
  clusterName: string;
  /** 0..100 — current load factor (higher = busier). */
  loadPercent: number;
  /** Pending jobs in the local scheduler queue. */
  queueDepth: number;
  /** Historical 95th percentile of jobs' wait time, in seconds. */
  historicalP95WaitSec: number;
}

export interface PlacementContext {
  /** Site IDs holding input data the job needs. */
  dataSites: string[];
  /** Per-cluster price (cost per CPU-hour). Index by clusterName. */
  costRates: Record<string, number>;
  /** Job's expected CPU-hour requirement. */
  expectedCpuHours: number;
  /** Job's expected wallclock duration in seconds (for queue-wait scoring). */
  expectedWallSec: number;
}

export interface Scorer {
  /** Stable ID for telemetry and filtering. */
  readonly name: string;
  /** Default weight. The composite scorer accepts overrides. */
  readonly weight: number;
  /** 0..100; higher is better placement. Pure function. */
  score(candidate: AgentCandidate, ctx: PlacementContext): number;
}

export interface ScoreBreakdown {
  agentId: string;
  finalScore: number;
  /** Per-scorer (name, raw 0..100, weighted 0..100). */
  contributions: Array<{ name: string; raw: number; weighted: number }>;
}
