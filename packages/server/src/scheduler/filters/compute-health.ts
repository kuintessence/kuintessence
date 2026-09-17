import type { AgentRow, FilterStage, PlacementContext, StageResult } from "../types";

export interface ComputeHealthFilterOptions {
  enforce?: boolean;
  maxAgeSec?: number;
  maxFutureSkewSec?: number;
  now?: () => Date;
}

const DEFAULT_COMPUTE_HEALTH_MAX_AGE_SEC = 120;
const DEFAULT_COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC = 5;
const AUDITABLE_UNAVAILABLE_REASONS = new Set([
  "scheduler_unavailable",
  "scheduler_command_failed",
  "no_operational_nodes",
  "invalid_scheduler_state",
  "unsupported_scheduler",
  "probe_timeout",
]);
const INVALID_HEALTH_REASONS = new Set(["invalid_observed_at", "invalid_health_report"]);

export class ComputeHealthFilter implements FilterStage {
  readonly name = "compute-health";
  private readonly enforce: boolean;
  private readonly maxAgeMs: number;
  private readonly maxFutureSkewMs: number;
  private readonly now: () => Date;

  constructor(options: ComputeHealthFilterOptions = {}) {
    this.enforce = options.enforce ?? false;
    this.maxAgeMs = Math.max(1, options.maxAgeSec ?? DEFAULT_COMPUTE_HEALTH_MAX_AGE_SEC) * 1_000;
    this.maxFutureSkewMs =
      Math.max(0, options.maxFutureSkewSec ?? DEFAULT_COMPUTE_HEALTH_MAX_FUTURE_SKEW_SEC) * 1_000;
    this.now = options.now ?? (() => new Date());
  }

  evaluate(agent: AgentRow, _ctx: PlacementContext): StageResult {
    if (agent.computeHealthCapable !== true) {
      return this.unknownResult("legacy Agent did not advertise compute health");
    }

    if (agent.computeHealthStatus === "unavailable") {
      return {
        kind: "reject",
        reason: unavailableReason(agent.computeHealthReason),
      };
    }

    if (agent.computeHealthReason && INVALID_HEALTH_REASONS.has(agent.computeHealthReason)) {
      return { kind: "reject", reason: "compute health report is invalid" };
    }

    if (
      agent.computeHealthStatus === "ready" &&
      (agent.computeHealthNodeCount === null ||
        agent.computeHealthOperationalNodeCount === null ||
        agent.computeHealthOperationalNodeCount <= 0 ||
        agent.computeHealthOperationalNodeCount > agent.computeHealthNodeCount)
    ) {
      return { kind: "reject", reason: "compute health report is invalid" };
    }

    const observedAt = agent.computeHealthObservedAt;
    if (observedAt !== null && observedAt !== undefined) {
      const ageMs = this.now().getTime() - observedAt.getTime();
      if (!Number.isFinite(ageMs) || ageMs < -this.maxFutureSkewMs || ageMs > this.maxAgeMs) {
        return { kind: "reject", reason: "compute health report is stale or clock-invalid" };
      }
    }

    if (agent.computeHealthStatus !== "ready" || observedAt === null || observedAt === undefined) {
      return this.unknownResult("compute health is not ready");
    }

    return { kind: "pass" };
  }

  private unknownResult(detail: string): StageResult {
    if (this.enforce) {
      return { kind: "reject", reason: `compute health is unknown: ${detail}` };
    }
    return { kind: "pass" };
  }
}

function unavailableReason(reason: string | null | undefined): string {
  if (reason && AUDITABLE_UNAVAILABLE_REASONS.has(reason)) {
    return `compute health reports unavailable: ${reason}`;
  }
  return "compute health reports unavailable";
}
