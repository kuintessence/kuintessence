import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

/**
 * Reject agents whose CPU usage exceeds maxCpuPercent (default 95).
 */
export class LoadFilter implements FilterStage {
  readonly name = "load";
  constructor(private maxCpuPercent = 95) {}
  evaluate(agent: AgentRow, _ctx: PlacementContext): StageResult {
    if (agent.cpuUsagePercent !== null && agent.cpuUsagePercent > this.maxCpuPercent) {
      return {
        kind: "reject",
        reason: `agent CPU ${agent.cpuUsagePercent}% exceeds ${this.maxCpuPercent}%`,
      };
    }
    return { kind: "pass" };
  }
}
