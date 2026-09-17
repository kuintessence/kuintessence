import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { recordIdentityFallback } from "../observability/identity-fallback";
import { emptyQueueObservabilitySnapshot } from "../services/queue-observability";
import { createMetricsRoutes, metricsRoutes, recordRequest } from "./metrics";

describe("/metrics", () => {
  const app = new Hono().route("/", metricsRoutes);

  test("returns text/plain Prometheus format", async () => {
    const res = await app.request("/metrics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("kq_server_uptime_seconds");
    expect(body).toContain("kq_server_requests_total");
  });

  test("recordRequest increments counter", async () => {
    recordRequest();
    recordRequest();
    const res = await app.request("/metrics");
    const body = await res.text();
    const match = body.match(/kq_server_requests_total (\d+)/);
    expect(match).not.toBeNull();
    if (match) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(2);
    }
  });

  test("reports temporary identity fallback hits without identity labels", async () => {
    recordIdentityFallback("rest_principal");
    const res = await app.request("/metrics");
    const body = await res.text();

    expect(body).toContain("# TYPE kq_server_identity_fallback_total counter");
    const match = body.match(
      /kq_server_identity_fallback_total\{kind="non_uuid_sub_email_lookup",surface="rest_principal"\} (\d+)/,
    );
    expect(Number(match?.[1] ?? 0)).toBeGreaterThanOrEqual(1);
    expect(body).not.toContain("example.com");
  });

  test("exports queue coverage and low-cardinality failure signals", async () => {
    const base = emptyQueueObservabilitySnapshot();
    const snapshot = {
      coverage: {
        totalHpcAgents: 4,
        capabilityDeclared: 3,
        activeNoGoAgents: 1,
        lastNoGoAt: new Date("2026-08-19T15:30:00.000Z"),
        statusCounts: {
          ...base.coverage.statusCounts,
          available: 2,
          stale: 1,
          unsupported: 1,
        },
      },
      failures: {
        shadowRejections: {
          ...base.failures.shadowRejections,
          QUEUE_NOT_FOUND: 2,
        },
        schedulerSubmitFailures: {
          ...base.failures.schedulerSubmitFailures,
          SCHEDULER_SUBMIT_FAILED: 1,
        },
      },
    };
    const app = new Hono().route(
      "/",
      createMetricsRoutes({ queueObservability: { snapshot: async () => snapshot } }),
    );

    const body = await (await app.request("/metrics")).text();

    expect(body).toContain("kq_server_queue_inventory_available 2");
    expect(body).toContain("kq_server_queue_inventory_no_go_agents 1");
    expect(body).toContain("kq_server_queue_inventory_last_no_go_timestamp_seconds 1787153400");
    expect(body).toContain("kq_server_queue_inventory_capability_coverage_ratio 0.75");
    expect(body).toContain("kq_server_queue_inventory_fresh_coverage_ratio 0.5");
    expect(body).toContain(
      'kq_server_queue_validation_shadow_rejections_total{failure_code="QUEUE_NOT_FOUND"} 2',
    );
    expect(body).toContain(
      'kq_server_scheduler_submit_failures_total{failure_code="SCHEDULER_SUBMIT_FAILED"} 1',
    );
    expect(body).not.toContain("agent-1");
  });
});
