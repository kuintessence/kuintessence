import { describe, expect, test } from "bun:test";
import { createSqliteDb, localWorkflowRuns, type SqliteDb } from "@kuintessence/db";
import type { WorkflowRunGraph, WorkflowRunRecordResult } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { SqliteWorkflowRunStore } from "./sqlite-run-store";

const EMPTY_GRAPH: WorkflowRunGraph = { nodes: [], edges: [] };

function setup(): { store: SqliteWorkflowRunStore; db: SqliteDb } {
  const db = createSqliteDb(":memory:");
  return { store: new SqliteWorkflowRunStore(db), db };
}

function rowOf(db: SqliteDb, runId: string) {
  const rows = db.select().from(localWorkflowRuns).where(eq(localWorkflowRuns.runId, runId)).all();
  const row = rows[0];
  if (!row) throw new Error(`expected a run row for ${runId}`);
  return row;
}

describe("SqliteWorkflowRunStore", () => {
  test("recordRun stores a succeeded run when all node statuses are terminal-ok", async () => {
    const { store, db } = setup();
    const result: WorkflowRunRecordResult = {
      status: { a: "Succeeded", b: "Skipped" },
      values: { a: { status: "Succeeded", values: { out: 1 } } },
    };
    const runId = await store.recordRun("successful-run", "dave", result, EMPTY_GRAPH);

    const row = rowOf(db, runId);
    expect(row.status).toBe("succeeded");
    expect(row.name).toBe("successful-run");
    expect(row.submittedBy).toBe("dave");
    expect(row.result).not.toBeNull();
    const parsed = JSON.parse(row.result as string) as WorkflowRunRecordResult;
    expect(parsed).toEqual(result);
  });

  test("recordRun marks failed when any node status is a failure", async () => {
    const { store, db } = setup();
    const result: WorkflowRunRecordResult = {
      status: { a: "Succeeded", b: "Failed" },
      values: {},
    };
    const runId = await store.recordRun("failed-run", "erin", result, EMPTY_GRAPH);
    expect(rowOf(db, runId).status).toBe("failed");
  });

  test("getRun returns a recorded run with its result parsed", async () => {
    const { store } = setup();
    const result: WorkflowRunRecordResult = {
      status: { a: "Failed", b: "Cancelled" },
      values: {
        a: {
          status: "Failed",
          values: { out: 1 },
          failure: { message: "Exit 3", jobId: "job-a", exitCode: 3 },
        },
      },
    };
    const runId = await store.recordRun("detailed-run", "frank", result, EMPTY_GRAPH);

    const run = await store.getRun(runId);
    expect(run).not.toBeNull();
    if (!run) throw new Error("expected a run");
    expect(run.runId).toBe(runId);
    expect(run.name).toBe("detailed-run");
    expect(run.submittedBy).toBe("frank");
    expect(run.status).toBe("failed");
    expect(run.stepJobs).toEqual({});
    expect(run.result).toEqual(result);
    expect(run.createdAt).toBeInstanceOf(Date);
    expect(run.updatedAt).toBeInstanceOf(Date);
  });

  test("getRun returns null for an unknown runId", async () => {
    const { store } = setup();
    expect(await store.getRun("does-not-exist")).toBeNull();
  });

  test("listRuns returns recorded runs newest-first", async () => {
    const { store } = setup();
    const okResult: WorkflowRunRecordResult = { status: { a: "succeeded" }, values: {} };
    const first = await store.recordRun("first", "h", okResult, EMPTY_GRAPH);
    const second = await store.recordRun("second", "h", okResult, EMPTY_GRAPH);

    const runs = await store.listRuns();
    expect(runs.map((r) => r.runId)).toContain(first);
    expect(runs.map((r) => r.runId)).toContain(second);
    expect(runs.length).toBe(2);
  });

  test("listRuns honours the limit", async () => {
    const { store } = setup();
    const okResult: WorkflowRunRecordResult = { status: { a: "succeeded" }, values: {} };
    await store.recordRun("one", "h", okResult, EMPTY_GRAPH);
    await store.recordRun("two", "h", okResult, EMPTY_GRAPH);
    await store.recordRun("three", "h", okResult, EMPTY_GRAPH);

    const runs = await store.listRuns(2);
    expect(runs.length).toBe(2);
  });
});
