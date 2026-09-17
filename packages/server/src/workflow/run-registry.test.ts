import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgDb, orgs, type PgDb, users, workflowRuns } from "@kuintessence/db";
import type { WorkflowRunGraph, WorkflowRunRecordResult } from "@kuintessence/shared";
import { eq, like } from "drizzle-orm";
import { WorkflowRunRegistry } from "./run-registry";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("WorkflowRunRegistry", () => {
  let db: PgDb;
  let registry: WorkflowRunRegistry;
  let testUserId: string;
  const recordedRunIds: string[] = [];

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    registry = new WorkflowRunRegistry(db);

    const [org] = await db.insert(orgs).values({ name: "run-graph-test-org" }).returning();
    if (!org) throw new Error("create org failed");

    const [user] = await db
      .insert(users)
      .values({ email: "run-graph-test@kuintessence.test", role: "user", orgId: org.id })
      .returning();
    if (!user) throw new Error("create user failed");
    testUserId = user.id;
  });

  afterAll(async () => {
    for (const id of recordedRunIds) {
      await db.delete(workflowRuns).where(eq(workflowRuns.id, id));
    }
    await db.delete(users).where(eq(users.email, "run-graph-test@kuintessence.test"));
    await db.delete(orgs).where(like(orgs.name, "run-graph-test-%"));
  });

  test("recordRun persists the graph and getById reads it back", async () => {
    const result: WorkflowRunRecordResult = {
      status: { a: "Succeeded", b: "Succeeded" },
      values: {
        a: { status: "Succeeded", values: {} },
        b: { status: "Succeeded", values: { residual: 0.001 } },
      },
    };
    const graph: WorkflowRunGraph = {
      nodes: [
        { id: "a", name: "stage-in", kind: "NoAction" },
        { id: "b", name: "solve", kind: "SoftwareUsecaseComputing" },
      ],
      edges: [{ source: "a", target: "b", when: "a.ok" }],
    };

    const runId = await registry.recordRun("graphed-wf", testUserId, result, graph);
    recordedRunIds.push(runId);

    const row = await registry.getById(runId);
    expect(row).not.toBeNull();
    expect(row?.status).toBe("completed");
    expect(row?.graph).toEqual(graph);
    expect(row?.graph?.nodes).toHaveLength(2);
    expect(row?.graph?.edges).toEqual([{ source: "a", target: "b", when: "a.ok" }]);
  });

  test("createRun starts submitted and completeRun stores terminal result", async () => {
    const graph: WorkflowRunGraph = {
      nodes: [{ id: "a", name: "stage-in", kind: "NoAction" }],
      edges: [],
    };
    const runId = await registry.createRun("async-graphed-wf", testUserId, graph, {
      yaml: "name: async-graphed-wf\nspec:\n  nodeDrafts: []\n",
      role: "user",
    });
    recordedRunIds.push(runId);

    let row = await registry.getById(runId);
    expect(row?.status).toBe("submitted");
    expect(row?.graph).toEqual(graph);
    expect(row?.input?.role).toBe("user");
    expect(row?.submittedAt).toBeInstanceOf(Date);

    expect(await registry.queueAuthorizedRun(runId)).toBe(true);
    expect(await registry.claimForExecution(runId)).toBe(true);
    row = await registry.getById(runId);
    expect(row?.status).toBe("running");

    const result: WorkflowRunRecordResult = {
      status: { a: "Succeeded" },
      values: { a: { status: "Succeeded", values: { ok: true } } },
    };
    expect(await registry.completeRun(runId, result)).toBe(true);

    row = await registry.getById(runId);
    expect(row?.status).toBe("completed");
    expect(row?.result).toEqual(result);
    expect(row?.completedAt).toBeInstanceOf(Date);
    expect(await registry.requestCancel(runId)).toBe("completed");
    expect(await registry.failRun(runId, new Error("late failure"))).toBe(false);
    expect((await registry.getById(runId))?.status).toBe("completed");
  });

  test("completeRun persists a failed node summary and structured failure", async () => {
    const graph: WorkflowRunGraph = {
      nodes: [{ id: "solve", name: "LAMMPS solve", kind: "SoftwareUsecaseComputing" }],
      edges: [],
    };
    const runId = await registry.createRun("failed-wf", testUserId, graph, {
      yaml: "name: failed-wf\nspec:\n  nodeDrafts: []\n",
      role: "user",
    });
    recordedRunIds.push(runId);
    expect(await registry.queueAuthorizedRun(runId)).toBe(true);
    expect(await registry.claimForExecution(runId)).toBe(true);
    const result: WorkflowRunRecordResult = {
      status: { solve: "Failed" },
      values: {
        solve: {
          status: "Failed",
          values: {},
          failure: { message: "LAMMPS input command failed", jobId: "job-1", exitCode: 2 },
        },
      },
    };

    expect(await registry.completeRun(runId, result)).toBe(true);

    const row = await registry.getById(runId);
    expect(row?.status).toBe("failed");
    expect(row?.errorCode).toBe("WORKFLOW_NODE_FAILED");
    expect(row?.errorMessage).toBe("solve: LAMMPS input command failed");
    expect(row?.result).toEqual(result);
  });

  test("requestCancel marks active runs cancelling and exposes them for recovery", async () => {
    const graph: WorkflowRunGraph = { nodes: [], edges: [] };
    const runId = await registry.createRun("cancel-me", testUserId, graph, {
      yaml: "name: cancel-me\nspec:\n  nodeDrafts: []\n",
      role: "user",
    });
    recordedRunIds.push(runId);

    const status = await registry.requestCancel(runId);

    expect(status).toBe("cancelling");
    const row = await registry.getById(runId);
    expect(row?.status).toBe("cancelling");
    expect(row?.cancelRequestedAt).toBeInstanceOf(Date);

    const recoverable = await registry.listRecoverableRuns();
    expect(recoverable.some((r) => r.id === runId)).toBe(true);
  });

  test("recordStepJob merges node job ids without overwriting existing entries", async () => {
    const graph: WorkflowRunGraph = { nodes: [], edges: [] };
    const runId = await registry.createRun("step-jobs", testUserId, graph, {
      yaml: "name: step-jobs\nspec:\n  nodeDrafts: []\n",
      role: "user",
    });
    recordedRunIds.push(runId);

    expect(await registry.recordStepJob(runId, "too-early", "job-0")).toBe(false);
    expect(await registry.queueAuthorizedRun(runId)).toBe(true);
    expect(await registry.claimForExecution(runId)).toBe(true);
    expect(await registry.recordStepJob(runId, "solve", "job-1")).toBe(true);
    expect(await registry.recordStepJob(runId, "post", "job-2")).toBe(true);

    const row = await registry.getById(runId);
    expect(row?.stepJobs).toEqual({ solve: "job-1", post: "job-2" });
  });

  test("listPage filters before pagination and uses a stable newest-first order", async () => {
    const submittedAt = new Date("2026-08-12T08:00:00.000Z");
    const rows = [
      {
        id: "10000000-0000-4000-8000-000000000001",
        name: "pagination-climate-alpha",
        status: "completed",
      },
      {
        id: "10000000-0000-4000-8000-000000000002",
        name: "pagination-climate-beta",
        status: "failed",
      },
      {
        id: "10000000-0000-4000-8000-000000000003",
        name: "pagination-climate-gamma",
        status: "running",
      },
      {
        id: "10000000-0000-4000-8000-000000000004",
        name: "pagination-other",
        status: "cancelled",
      },
    ] as const;
    await db.insert(workflowRuns).values(
      rows.map((row) => ({
        ...row,
        submittedBy: testUserId,
        submittedAt,
        createdAt: submittedAt,
        updatedAt: submittedAt,
      })),
    );
    recordedRunIds.push(...rows.map((row) => row.id));

    const page = await registry.listPage({
      limit: 1,
      offset: 1,
      submittedBy: testUserId,
      query: "pagination-climate",
    });

    expect(page.runs.map((row) => row.id)).toEqual([rows[1].id]);
    expect(page.total).toBe(3);
    expect(page.summary).toEqual({ active: 1, completed: 1, failed: 1, cancelled: 0 });

    const failed = await registry.listPage({
      limit: 10,
      offset: 0,
      ids: rows.map((row) => row.id),
      query: "pagination-climate",
      status: "failed",
    });
    expect(failed.runs.map((row) => row.id)).toEqual([rows[1].id]);
    expect(failed.total).toBe(1);
    expect(failed.summary).toEqual({ active: 1, completed: 1, failed: 1, cancelled: 0 });
  });
});
