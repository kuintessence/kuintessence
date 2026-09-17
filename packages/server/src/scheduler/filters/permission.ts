import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

/**
 * Rejects guest dispatch; resource-specific authorization runs outside this filter.
 */
export class PermissionFilter implements FilterStage {
  readonly name = "permission";
  evaluate(_agent: AgentRow, ctx: PlacementContext): StageResult {
    if (ctx.userRole === "guest") {
      return { kind: "reject", reason: "guest role cannot dispatch" };
    }
    return { kind: "pass" };
  }
}
