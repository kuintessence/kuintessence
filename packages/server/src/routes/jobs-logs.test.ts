import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import type { BoundOrgMembership } from "../middleware/principal-binder";
import type { JobLogAccessEvent } from "../services/job-log-access-auditor";
import { JobLogsUnavailableError } from "../services/job-logs-service";
import type { JobService } from "../services/job-service";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { createJobRoutes, jobLogDelta } from "./jobs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(
  job: Record<string, unknown> | null | (() => Record<string, unknown> | null),
  getLogs?: (
    agentId: string,
    schedulerJobId: string,
    lines: number,
    jobId: string,
    restrictedNoEgress: boolean,
  ) => Promise<string>,
  userId = "owner",
  memberships: BoundOrgMembership[] = [],
  audit?: { record(event: JobLogAccessEvent): Promise<void> },
) {
  const service = {
    getById: async () => (typeof job === "function" ? job() : job),
  } as unknown as JobService;
  const orchestrator = {} as PlacementOrchestrator;
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("user" as never, { sub: userId, role: "user", email: `${userId}@example.test` });
    c.set("principal" as never, {
      userId,
      role: "user",
      email: `${userId}@example.test`,
      orgId: "org-1",
      orgIds: ["org-1"],
      memberships,
    });
    await next();
  });
  app.route(
    "/api",
    createJobRoutes(service, {} as PgDb, orchestrator, {
      ...(getLogs ? { jobLogs: { get: getLogs } } : {}),
      ...(audit ? { jobLogAccessAudit: audit } : {}),
      jobLogsPollIntervalMs: 0,
    }),
  );
  return app;
}

describe("GET /jobs/:id/logs", () => {
  test("resolves the scheduler placement and returns the requested log tail", async () => {
    const calls: unknown[] = [];
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
      },
      async (...args) => {
        calls.push(args);
        return "epoch 1\nepoch 2\n";
      },
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs?text=1&lines=200`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: "epoch 1\nepoch 2\n" });
    expect(calls).toEqual([["agent-1", "scheduler-42", 200, JOB_ID, false]]);
  });

  test("refuses restricted no-egress logs before contacting the Agent", async () => {
    let called = false;
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
        restrictedNoEgress: true,
      },
      async () => {
        called = true;
        return "secret";
      },
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  test("rejects an invalid line count before dispatch", async () => {
    let called = false;
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
      },
      async () => {
        called = true;
        return "";
      },
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs?lines=5001`);

    expect(response.status).toBe(400);
    expect(called).toBe(false);
  });

  test("reports that logs are not ready before scheduler submission", async () => {
    const app = makeApp({ id: JOB_ID, submittedBy: "owner", agentId: null });

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "JOB_DISPATCH_FAILED" },
    });
  });

  test("reports a missing running-job log as not ready instead of a gateway failure", async () => {
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
        status: "running",
      },
      async () => {
        throw new JobLogsUnavailableError();
      },
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "JOB_LOG_UNAVAILABLE", details: { state: "not_ready" } },
    });
  });

  test("reports a missing terminal-job log as unavailable instead of a gateway failure", async () => {
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
        status: "completed",
      },
      async () => {
        throw new JobLogsUnavailableError();
      },
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({
      error: { code: "JOB_LOG_UNAVAILABLE", details: { state: "terminal_unavailable" } },
    });
  });

  test("does not expose raw scheduler output to a non-owner in off mode", async () => {
    let called = false;
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
      },
      async () => {
        called = true;
        return "secret output";
      },
      "viewer",
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(403);
    expect(called).toBe(false);
  });

  test("allows and audits a consumer organization admin reading raw logs", async () => {
    const events: JobLogAccessEvent[] = [];
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        orgId: "org-1",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
      },
      async () => "scoped output",
      "consumer-admin",
      [{ orgId: "org-1", role: "admin" }],
      {
        record: async (event) => {
          events.push(event);
        },
      },
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(200);
    expect(events).toEqual([
      {
        actorUserId: "consumer-admin",
        jobId: JOB_ID,
        access: "tail",
        scope: "consumer_admin",
      },
    ]);
  });

  test("allows and audits a provider operator through the job provider snapshot", async () => {
    const events: JobLogAccessEvent[] = [];
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        orgId: "consumer-org",
        providerOrgId: "provider-org",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
      },
      async () => "provider output",
      "provider-operator",
      [{ orgId: "provider-org", role: "operator" }],
      {
        record: async (event) => {
          events.push(event);
        },
      },
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(200);
    expect(events[0]?.scope).toBe("provider_operator");
  });

  test("rejects an ordinary consumer organization member reading raw logs", async () => {
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        orgId: "org-1",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
      },
      async () => "hidden output",
      "consumer-member",
      [{ orgId: "org-1", role: "member" }],
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs`);

    expect(response.status).toBe(403);
  });

  test("streams the initial tail and closes a terminal job with an end event", async () => {
    const app = makeApp(
      {
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
        status: "completed",
      },
      async () => "epoch 1\nepoch 2\n",
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs/stream?lines=20`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: log\ndata: epoch 1\ndata: epoch 2\ndata: \n\n");
    expect(body).toContain("event: end\ndata: completed\n\n");
  });

  test("streams only the delta before closing when a running job completes", async () => {
    let jobRead = 0;
    let logRead = 0;
    const app = makeApp(
      () => ({
        id: JOB_ID,
        submittedBy: "owner",
        agentId: "agent-1",
        schedulerJobId: "scheduler-42",
        status: jobRead++ === 0 ? "running" : "completed",
      }),
      async () => (logRead++ === 0 ? "epoch 1\n" : "epoch 1\nepoch 2\n"),
    );

    const response = await app.request(`/api/jobs/${JOB_ID}/logs/stream`);
    const body = await response.text();

    expect(body.match(/data: epoch 1/g)).toHaveLength(1);
    expect(body.match(/data: epoch 2/g)).toHaveLength(1);
    expect(body).toContain("event: end\ndata: completed\n\n");
  });
});

describe("jobLogDelta", () => {
  test("finds appended text after a sliding tail window", () => {
    expect(jobLogDelta("line 1\nline 2\nline 3\n", "line 2\nline 3\nline 4\n")).toBe("line 4\n");
  });

  test("returns the full replacement after log rotation", () => {
    expect(jobLogDelta("old output\n", "new output\n")).toBe("new output\n");
  });
});
