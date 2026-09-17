import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

export interface QueueFilterOptions {
  autoDefaultRejections?: ReadonlyMap<string, string>;
}

export class QueueFilter implements FilterStage {
  readonly name = "queue";

  constructor(private readonly options: QueueFilterOptions = {}) {}

  evaluate(agent: AgentRow, ctx: PlacementContext): StageResult {
    const queue = ctx.queueSelection;
    if (!queue) {
      const reason = this.options.autoDefaultRejections?.get(agent.agentId);
      return reason ? { kind: "reject", reason } : { kind: "pass" };
    }
    if (agent.agentId !== queue.agentId) {
      return { kind: "reject", reason: `agent is not bound to queue ${queue.queueId}` };
    }
    if (agent.schedulerType !== queue.schedulerType) {
      return {
        kind: "reject",
        reason: `schedulerType ${agent.schedulerType} does not match queue ${queue.schedulerType}`,
      };
    }
    return { kind: "pass" };
  }
}
