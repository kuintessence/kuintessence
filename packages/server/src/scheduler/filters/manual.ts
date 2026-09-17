import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

/**
 * Apply user-resolved preferences (allowedAgents/deniedAgents from preferences).
 * Also enforces hard limits from the merged preference spec.
 */
export class ManualFilter implements FilterStage {
  readonly name = "manual";
  evaluate(agent: AgentRow, ctx: PlacementContext): StageResult {
    const policy = ctx.preferences.sitePolicy;
    if (policy?.deniedAgents?.includes(agent.agentId)) {
      return { kind: "reject", reason: "agent denied by preference" };
    }
    if (policy?.allowedAgents && !policy.allowedAgents.includes(agent.agentId)) {
      return { kind: "reject", reason: "agent not in allowedAgents" };
    }

    const hl = ctx.preferences.hardLimits;
    if (hl?.maxCpus !== undefined && ctx.job.resources.cpus > hl.maxCpus) {
      return {
        kind: "reject",
        reason: `cpus ${ctx.job.resources.cpus} > limit ${hl.maxCpus}`,
      };
    }
    if (hl?.maxMemoryMb !== undefined && ctx.job.resources.memoryMb > hl.maxMemoryMb) {
      return {
        kind: "reject",
        reason: `memoryMb ${ctx.job.resources.memoryMb} > limit ${hl.maxMemoryMb}`,
      };
    }
    if (
      hl?.maxWallTimeSec !== undefined &&
      ctx.job.resources.wallTimeSec !== undefined &&
      ctx.job.resources.wallTimeSec > hl.maxWallTimeSec
    ) {
      return { kind: "reject", reason: "wallTime > limit" };
    }
    return { kind: "pass" };
  }
}
