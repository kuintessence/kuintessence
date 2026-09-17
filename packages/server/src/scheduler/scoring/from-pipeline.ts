// bridge between the placement pipeline's `AgentRow` /
// `PlacementContext` (defined in `../types.ts`) and the auto-scoring world
// (`AgentCandidate` / scoring `PlacementContext` in `./types.ts`).
//
// The placement pipeline operates on real `AgentRow`s pulled from Drizzle and
// a job-centric `PlacementContext` (job + preferences + RBAC). The scoring
// layer is intentionally schema-agnostic — it asks for a flat `AgentCandidate`
// and a job-shape `PlacementContext` with fields the pipeline doesn't
// natively carry. This module performs the shape-shift in one place so the
// auto-stage stays small and the missing fields are documented.
//
// `costRates` (from `PreferenceSpec`), `dataSites` (from
// `JobSubmit.requires.locality`), and Agent topology fields are real fields
// read directly. Legacy rows may still have null siteId/clusterId, so those
// fall back to siteName for compatibility.

import type { PreferenceSpec } from "@kuintessence/shared";
import type { AgentRow, PlacementContext as PipelinePlacementContext } from "../types";
import type { AgentCandidate, PlacementContext as ScoringPlacementContext } from "./types";

const DEFAULT_LOAD_PERCENT = 50; // matches the historical loadScore neutral midpoint
const DEFAULT_EXPECTED_WALL_SEC = 3600;
const DEFAULT_EXPECTED_CPU_HOURS = 1;

/** Adapt one `AgentRow` to the scorer's `AgentCandidate` view. */
export function toAgentCandidate(agent: AgentRow): AgentCandidate {
  return {
    agentId: agent.agentId,
    siteId: agent.siteId ?? agent.siteName,
    clusterName: agent.clusterId ?? agent.siteName,
    loadPercent: agent.cpuUsagePercent ?? DEFAULT_LOAD_PERCENT,
    // Migration 0013 — these are real columns now, populated by heartbeat.
    queueDepth: agent.queueDepth,
    historicalP95WaitSec: agent.historicalP95WaitSec,
  };
}

/** Adapt the pipeline-level `PlacementContext` into the scorer's view. */
export function toScoringContext(ctx: PipelinePlacementContext): ScoringPlacementContext {
  const job = ctx.job;
  const prefs = ctx.preferences;

  const cpus = job.resources?.cpus ?? 1;
  const wallSec = job.resources?.wallTimeSec ?? DEFAULT_EXPECTED_WALL_SEC;
  const expectedCpuHours = Math.max((cpus * wallSec) / 3600, DEFAULT_EXPECTED_CPU_HOURS);

  return {
    dataSites: job.requires?.locality?.dataSites ?? [],
    costRates: prefs.costRates ?? {},
    expectedCpuHours,
    expectedWallSec: wallSec,
  };
}

/**
 * Mapping between the user-facing soft-weight knobs (in `PreferenceSpec`,
 * the names CP-Console understands) and the scorer registry names
 * (`load`, `cost`, `locality`, `queue-wait`). Keep both halves stable —
 * renaming either side is a breaking change to the placement contract.
 */
export const SOFT_WEIGHT_TO_SCORER: Record<string, string> = {
  loadWeight: "load",
  costWeight: "cost",
  localityWeight: "locality",
  queueWaitWeight: "queue-wait",
};

/** Translate `softWeights` from `PreferenceSpec` into composite weight overrides. */
export function softWeightsToOverrides(
  softWeights: PreferenceSpec["softWeights"],
): Record<string, number> {
  if (!softWeights) return {};
  const out: Record<string, number> = {};
  for (const [pref, scorer] of Object.entries(SOFT_WEIGHT_TO_SCORER)) {
    const v = (softWeights as Record<string, number | undefined>)[pref];
    if (typeof v === "number") out[scorer] = v;
  }
  return out;
}
