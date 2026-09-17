import { hasRole, type RoleName } from "@kuintessence/shared";
import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

/**
 * If any software requirement has installable=true, the user must have org_admin
 * role or higher to trigger a new software install on the target agent.
 */
export class InstallRightsFilter implements FilterStage {
  readonly name = "install-rights";

  evaluate(_agent: AgentRow, ctx: PlacementContext): StageResult {
    const reqs = ctx.job.softwareRequirements ?? [];
    const wantsInstall = reqs.some((r) => r.installable === true);
    if (!wantsInstall) return { kind: "pass" };

    const userRole = ctx.userRole as RoleName;
    if (!hasRole(userRole, "org_admin")) {
      return {
        kind: "reject",
        reason: "user lacks install permission (need org_admin+)",
      };
    }
    return { kind: "pass" };
  }
}
