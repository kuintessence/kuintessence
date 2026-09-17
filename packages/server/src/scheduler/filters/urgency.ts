import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

/**
 * Rejects agent if its current active (running+queued) job count is at or above
 * maxConcurrentJobs. When no live count is available, falls back conservatively to 0
 * (pass).
 *
 * The getActiveJobCount function is injected so the orchestrator can provide a live
 * count from the DB without coupling the filter to a data-access layer.
 */
export class UrgencyFilter implements FilterStage {
  readonly name = "urgency";

  constructor(private getActiveJobCount: (agentId: string) => number = () => 0) {}

  evaluate(agent: AgentRow, _ctx: PlacementContext): StageResult {
    const agentWithExtra = agent as AgentRow & { maxConcurrentJobs?: number | null };
    const max = agentWithExtra.maxConcurrentJobs ?? 100;
    const active = this.getActiveJobCount(agent.agentId);
    if (active >= max) {
      return {
        kind: "reject",
        reason: `agent at concurrency limit (${active}/${max})`,
      };
    }
    return { kind: "pass" };
  }
}
