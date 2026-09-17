import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

export interface BillingFilterDeps {
  /** Map of "scope:scopeId" → remaining credit units. */
  quotas: Map<string, number>;
}

/**
 * Rejects a placement if the submitting user or org has zero (or negative) credits.
 * Resolution order:
 *   1. If a user-level quota exists and is <= 0, reject immediately.
 *   2. If no user-level quota is set and an org-level quota exists and is <= 0, reject.
 *   3. If neither scope has a quota, pass (no billing restriction configured).
 */
export class BillingFilter implements FilterStage {
  readonly name = "billing";

  constructor(private deps: BillingFilterDeps = { quotas: new Map() }) {}

  evaluate(_agent: AgentRow, ctx: PlacementContext): StageResult {
    const userKey = `user:${ctx.userId}`;
    const orgKey = ctx.orgId ? `org:${ctx.orgId}` : null;

    const userQuota = this.deps.quotas.get(userKey);
    if (userQuota !== undefined && userQuota <= 0) {
      return { kind: "reject", reason: "user quota exhausted" };
    }
    // User quota overrides org quota — only check org when user has no explicit quota
    if (orgKey && userQuota === undefined) {
      const orgQuota = this.deps.quotas.get(orgKey);
      if (orgQuota !== undefined && orgQuota <= 0) {
        return { kind: "reject", reason: "org quota exhausted" };
      }
    }
    return { kind: "pass" };
  }
}
