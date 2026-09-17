import { QueueFailureCodeSchema } from "@kuintessence/shared";
import { Hono } from "hono";
import { identityFallbackMetricLines } from "../observability/identity-fallback";
import {
  emptyQueueObservabilitySnapshot,
  type QueueObservabilitySnapshot,
  queueInventoryStatusCount,
} from "../services/queue-observability";

interface MetricsState {
  startedAt: number;
  requestCount: number;
}

export interface MetricsRouteOptions {
  queueObservability?: {
    snapshot(): Promise<QueueObservabilitySnapshot>;
  };
}

const state: MetricsState = { startedAt: Date.now(), requestCount: 0 };

export function recordRequest(): void {
  state.requestCount++;
}

export function createMetricsRoutes(options: MetricsRouteOptions = {}) {
  const metricsRoutes = new Hono();

  metricsRoutes.get("/metrics", async (c) => {
    const uptime = Math.floor((Date.now() - state.startedAt) / 1000);
    const queueObservability = options.queueObservability
      ? await options.queueObservability.snapshot()
      : emptyQueueObservabilitySnapshot();
    const lines = [
      "# HELP kq_server_uptime_seconds Server uptime in seconds",
      "# TYPE kq_server_uptime_seconds counter",
      `kq_server_uptime_seconds ${uptime}`,
      "# HELP kq_server_requests_total Total HTTP requests handled by Server",
      "# TYPE kq_server_requests_total counter",
      `kq_server_requests_total ${state.requestCount}`,
      "# HELP kq_server_identity_fallback_total Non-UUID session subjects resolved through the temporary email fallback",
      "# TYPE kq_server_identity_fallback_total counter",
      ...identityFallbackMetricLines(),
      ...queueObservabilityMetricLines(queueObservability),
    ];
    return c.text(lines.join("\n"), 200, { "Content-Type": "text/plain; version=0.0.4" });
  });

  return metricsRoutes;
}

export const metricsRoutes = createMetricsRoutes();

function queueObservabilityMetricLines(snapshot: QueueObservabilitySnapshot): string[] {
  const totalHpcAgents = snapshot.coverage.totalHpcAgents;
  const available = queueInventoryStatusCount(snapshot.coverage, "available");
  const capabilityCoverage =
    totalHpcAgents === 0 ? 0 : snapshot.coverage.capabilityDeclared / totalHpcAgents;
  const freshCoverage = totalHpcAgents === 0 ? 0 : available / totalHpcAgents;
  const lines = [
    "# HELP kq_server_queue_inventory_hpc_agents Registered HPC Agents included in queue inventory coverage",
    "# TYPE kq_server_queue_inventory_hpc_agents gauge",
    `kq_server_queue_inventory_hpc_agents ${totalHpcAgents}`,
    "# HELP kq_server_queue_inventory_capability_declared HPC Agents that declared queue_inventory_v1",
    "# TYPE kq_server_queue_inventory_capability_declared gauge",
    `kq_server_queue_inventory_capability_declared ${snapshot.coverage.capabilityDeclared}`,
    "# HELP kq_server_queue_inventory_available HPC Agents with fresh available queue inventory",
    "# TYPE kq_server_queue_inventory_available gauge",
    `kq_server_queue_inventory_available ${available}`,
    "# HELP kq_server_queue_inventory_no_go_agents HPC Agents held by the persistent queue inventory recovery gate",
    "# TYPE kq_server_queue_inventory_no_go_agents gauge",
    `kq_server_queue_inventory_no_go_agents ${snapshot.coverage.activeNoGoAgents}`,
    "# HELP kq_server_queue_inventory_last_no_go_timestamp_seconds Latest persisted queue inventory no-go observation",
    "# TYPE kq_server_queue_inventory_last_no_go_timestamp_seconds gauge",
    `kq_server_queue_inventory_last_no_go_timestamp_seconds ${snapshot.coverage.lastNoGoAt ? snapshot.coverage.lastNoGoAt.getTime() / 1_000 : 0}`,
    "# HELP kq_server_queue_inventory_capability_coverage_ratio Declared queue inventory capability divided by registered HPC Agents",
    "# TYPE kq_server_queue_inventory_capability_coverage_ratio gauge",
    `kq_server_queue_inventory_capability_coverage_ratio ${capabilityCoverage}`,
    "# HELP kq_server_queue_inventory_fresh_coverage_ratio Fresh available queue inventory divided by registered HPC Agents",
    "# TYPE kq_server_queue_inventory_fresh_coverage_ratio gauge",
    `kq_server_queue_inventory_fresh_coverage_ratio ${freshCoverage}`,
    "# HELP kq_server_queue_inventory_agents Queue inventory effective status by registered HPC Agent count",
    "# TYPE kq_server_queue_inventory_agents gauge",
  ];

  for (const status of ["unknown", "available", "unavailable", "stale", "unsupported"] as const) {
    lines.push(
      `kq_server_queue_inventory_agents{status="${status}"} ${queueInventoryStatusCount(snapshot.coverage, status)}`,
    );
  }

  lines.push(
    "# HELP kq_server_queue_validation_shadow_rejections_total Agent queue validations rejected in shadow mode by canonical failure code",
    "# TYPE kq_server_queue_validation_shadow_rejections_total counter",
  );
  for (const failureCode of QueueFailureCodeSchema.options) {
    lines.push(
      `kq_server_queue_validation_shadow_rejections_total{failure_code="${failureCode}"} ${snapshot.failures.shadowRejections[failureCode] ?? 0}`,
    );
  }

  lines.push(
    "# HELP kq_server_scheduler_submit_failures_total Scheduler submission failures by canonical failure code",
    "# TYPE kq_server_scheduler_submit_failures_total counter",
  );
  for (const failureCode of QueueFailureCodeSchema.options) {
    lines.push(
      `kq_server_scheduler_submit_failures_total{failure_code="${failureCode}"} ${snapshot.failures.schedulerSubmitFailures[failureCode] ?? 0}`,
    );
  }
  return lines;
}
