import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

export interface SoftwareFilterDeps {
  /** Map from agentId → Set of "name@version" strings the agent has installed. */
  agentSoftware: Map<string, Set<string>>;
  availability?: Map<string, Map<string, string[]>>;
}

/**
 * Rejects agent if any non-installable software requirement is missing.
 * Software with `installable: true` is allowed even if the agent doesn't have it
 * (the install-rights filter will check whether the user can request install).
 */
export class SoftwareFilter implements FilterStage {
  readonly name = "software";

  constructor(private deps: SoftwareFilterDeps = { agentSoftware: new Map() }) {}

  evaluate(agent: AgentRow, ctx: PlacementContext): StageResult {
    const reqs = ctx.job.softwareRequirements ?? [];
    if (reqs.length === 0) return { kind: "pass" };

    const installed = this.deps.agentSoftware.get(agent.agentId) ?? new Set<string>();
    const missing: string[] = [];

    for (const req of reqs) {
      const key = req.version ? `${req.name}@${req.version}` : req.name;
      const availabilityReasons = this.deps.availability?.get(key)?.get(agent.agentId) ?? [];
      if (availabilityReasons.length > 0) {
        missing.push(`${key} (${availabilityReasons.join("; ")})`);
        continue;
      }
      if (req.installable) continue;
      const hasKeyed = installed.has(key);
      // If no version pinned, accept any installed version of this software
      const hasName = req.version
        ? false
        : [...installed].some((s) => s.startsWith(`${req.name}@`));
      if (!hasKeyed && !hasName) {
        missing.push(key);
      }
    }

    if (missing.length > 0) {
      return { kind: "reject", reason: `missing software: ${missing.join(", ")}` };
    }
    return { kind: "pass" };
  }
}
