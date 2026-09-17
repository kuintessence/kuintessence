import { describe, expect, test } from "vitest";
import {
  AgentListSchema,
  AuditLogResponseSchema,
  JobDetailSchema,
  JobListSchema,
  WorkflowListSchema,
  WorkflowRunDetailSchema,
  WorkflowSubmitResponseSchema,
} from "./index";

describe("JobListSchema", () => {
  test("parses a minimal valid response", () => {
    const r = JobListSchema.parse({
      jobs: [{ id: "a", name: "n", status: "RUNNING", submittedAt: "2026-04-27T00:00:00Z" }],
    });
    expect(r.jobs).toHaveLength(1);
  });

  test("preserves unknown fields via passthrough", () => {
    const parsed = JobListSchema.parse({
      jobs: [
        {
          id: "a",
          name: "n",
          status: "RUNNING",
          submittedAt: "2026-04-27T00:00:00Z",
          futureField: 42,
        },
      ],
      bonus: true,
    }) as unknown as { jobs: Array<Record<string, unknown>>; bonus: boolean };
    expect(parsed.bonus).toBe(true);
    expect(parsed.jobs[0]?.futureField).toBe(42);
  });

  test("rejects responses missing required fields", () => {
    expect(() =>
      JobListSchema.parse({ jobs: [{ id: "a", name: "n", status: "RUNNING" }] }),
    ).toThrow();
  });
});

describe("JobDetailSchema", () => {
  test("accepts nullable optional fields", () => {
    const r = JobDetailSchema.parse({
      id: "a",
      name: "n",
      status: "FAILED",
      submittedAt: "2026-04-27T00:00:00Z",
      command: null,
      schedulerJobId: null,
      agentId: null,
      startedAt: null,
      completedAt: null,
      exitCode: 1,
      resources: { cpus: 1, memoryMb: 1024 },
    });
    expect(r.exitCode).toBe(1);
    expect(r.resources?.cpus).toBe(1);
  });
});

describe("WorkflowListSchema + WorkflowRunDetailSchema", () => {
  test("workflow list parses", () => {
    const r = WorkflowListSchema.parse({
      runs: [{ id: "r1", name: "x", status: "RUNNING", createdAt: "2026-04-27T00:00:00Z" }],
    });
    expect(r.runs).toHaveLength(1);
  });

  test("detail defaults stepJobs to empty object when missing", () => {
    const r = WorkflowRunDetailSchema.parse({
      id: "r1",
      name: "x",
      status: "RUNNING",
      createdAt: "2026-04-27T00:00:00Z",
    });
    expect(r.stepJobs).toEqual({});
  });

  test.each([
    null,
    undefined,
    { nodes: [], edges: [] },
  ])("accepts an unavailable or empty graph while preserving job mappings", (graph) => {
    const r = WorkflowRunDetailSchema.parse({
      id: "r1",
      name: "x",
      status: "pending",
      createdAt: "2026-04-27T00:00:00Z",
      graph,
      stepJobs: { solve: "job-solve" },
    });
    expect(r.graph).toEqual(graph);
    expect(r.stepJobs).toEqual({ solve: "job-solve" });
  });
});

describe("WorkflowSubmitResponseSchema", () => {
  test("parses a successful submit", () => {
    const r = WorkflowSubmitResponseSchema.parse({
      runId: "r-1",
      name: "pipe",
      status: "submitted",
    });
    expect(r.status).toBe("submitted");
  });

  test("requires a run status", () => {
    expect(() => WorkflowSubmitResponseSchema.parse({ runId: "r-1", name: "pipe" })).toThrow();
  });
});

describe("AgentListSchema", () => {
  test("parses agents with nullable monitoring fields", () => {
    const r = AgentListSchema.parse({
      agents: [
        {
          agentId: "a-1",
          siteName: "site",
          schedulerType: "slurm",
          schedulerVersion: "23.02",
          status: "online",
          lastHeartbeat: null,
          cpuUsagePercent: null,
          memoryUsedMb: null,
          memoryTotalMb: null,
        },
      ],
    });
    expect(r.agents[0]?.status).toBe("online");
  });
});

describe("AuditLogResponseSchema", () => {
  test("parses entries", () => {
    const r = AuditLogResponseSchema.parse({
      entries: [
        {
          id: "1",
          actor: "user@a",
          action: "job.create",
          target: "job/123",
          createdAt: "2026-04-27T00:00:00Z",
        },
      ],
    });
    expect(r.entries).toHaveLength(1);
  });
});
