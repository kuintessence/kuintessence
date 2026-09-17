import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import * as schema from "@kuintessence/db";
import { runSqliteMigrations } from "@kuintessence/db";
import { SoftwareOperationAction, SoftwareOperationStatus } from "@kuintessence/proto";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { JobStatusReport } from "../embedded/job-executor";
import { type HeartbeatSnapshot, type OutboundItem, OutboundQueue } from "./outbound-queue";

function freshDb() {
  const sqlite = new Database(":memory:");
  runSqliteMigrations(sqlite);
  return drizzle(sqlite, { schema });
}

const baseReport: JobStatusReport = {
  jobId: "job-1",
  status: "queued",
  schedulerJobId: "sched-1",
};

const baseHeartbeat: HeartbeatSnapshot = {
  cpuUsagePercent: 12.3,
  memoryUsedMb: 1024,
  memoryTotalMb: 8192,
  runningJobs: 1,
  queuedJobs: 0,
};

const baseSoftwareResult: Extract<OutboundItem, { kind: "softwareOperationResult" }> = {
  kind: "softwareOperationResult",
  operationId: "op-1",
  action: SoftwareOperationAction.INSTALL,
  status: SoftwareOperationStatus.SUCCEEDED,
  spec: "zlib@1.3",
  stdout: "ok",
  exitCode: 0,
  installed: [{ name: "zlib", version: "1.3", hash: "abc", spec: "zlib@1.3" }],
};

describe("OutboundQueue", () => {
  let db: ReturnType<typeof freshDb>;

  beforeEach(() => {
    db = freshDb();
  });

  test("starts empty", async () => {
    const q = new OutboundQueue(db);
    expect(await q.pendingCount()).toBe(0);
  });

  test("enqueueJobStatus increments pendingCount", async () => {
    const q = new OutboundQueue(db, { createEventId: () => "event-1" });
    const first = await q.enqueueJobStatus(baseReport);
    expect(first.item).toMatchObject({ kind: "jobStatus", eventId: "event-1" });
    expect(await q.pendingCount()).toBe(1);
    await q.enqueueJobStatus({ ...baseReport, status: "running" });
    expect(await q.pendingCount()).toBe(2);
  });

  test("keeps a stable event id across replay and deletes only on matching acknowledgement", async () => {
    const ids = ["event-terminal", "event-other"];
    const q = new OutboundQueue(db, { createEventId: () => ids.shift() ?? "unexpected" });
    await q.enqueueJobStatus({
      ...baseReport,
      status: "completed",
      collected: { result: "42" },
      workingDir: "/managed/jobs/job-1",
    });
    await q.enqueueJobStatus({ ...baseReport, jobId: "job-2", status: "failed" });

    const firstReplay = await q.loadForReplay();
    const secondReplay = await q.loadForReplay();
    expect(
      firstReplay.map((entry) =>
        entry.item.kind === "jobStatus" ? entry.item.eventId : undefined,
      ),
    ).toEqual(["event-terminal", "event-other"]);
    expect(
      secondReplay.map((entry) =>
        entry.item.kind === "jobStatus" ? entry.item.eventId : undefined,
      ),
    ).toEqual(["event-terminal", "event-other"]);
    expect(firstReplay[0]?.item).toMatchObject({
      kind: "jobStatus",
      report: { workingDir: "/managed/jobs/job-1" },
    });

    expect(await q.acknowledgeJobStatus("unknown")).toBe(false);
    expect(await q.pendingCount()).toBe(2);
    expect(await q.acknowledgeJobStatus("event-terminal")).toBe(true);
    expect(await q.pendingCount()).toBe(1);
    expect(await q.acknowledgeJobStatus("event-terminal")).toBe(false);
  });

  test("keeps a shadow rejection durable until its matching acknowledgement", async () => {
    const q = new OutboundQueue(db, { createEventId: () => "shadow-event-1" });
    const queued = await q.enqueueQueueValidationShadowRejection("QUEUE_NOT_ACCEPTING");

    expect(queued.item).toEqual({
      kind: "queueValidationShadowRejection",
      eventId: "shadow-event-1",
      failureCode: "QUEUE_NOT_ACCEPTING",
    });
    expect((await q.loadForReplay())[0]?.item).toEqual(queued.item);
    expect(await q.acknowledgeQueueValidationShadowRejection("unknown")).toBe(false);
    expect(await q.pendingCount()).toBe(1);
    expect(await q.acknowledgeQueueValidationShadowRejection("shadow-event-1")).toBe(true);
    expect(await q.pendingCount()).toBe(0);
  });

  test("retries a shadow rejection idempotently with the same event id", async () => {
    const q = new OutboundQueue(db);

    const first = await q.enqueueQueueValidationShadowRejection(
      "QUEUE_NOT_ACCEPTING",
      "shadow-event-retry",
    );
    const retry = await q.enqueueQueueValidationShadowRejection(
      "QUEUE_NOT_ACCEPTING",
      "shadow-event-retry",
    );

    expect(retry.item).toEqual(first.item);
    expect(await q.pendingCount()).toBe(1);
    await retry.acknowledge();
    expect(await q.pendingCount()).toBe(0);
  });

  test("rejects reusing a shadow event id for another failure code", async () => {
    const q = new OutboundQueue(db);
    await q.enqueueQueueValidationShadowRejection("QUEUE_CHANGED", "shadow-event-conflict");

    await expect(
      q.enqueueQueueValidationShadowRejection("QUEUE_NOT_ACCEPTING", "shadow-event-conflict"),
    ).rejects.toThrow("event id already has another failure code");
    expect((await q.loadForReplay())[0]?.item).toMatchObject({
      kind: "queueValidationShadowRejection",
      eventId: "shadow-event-conflict",
      failureCode: "QUEUE_CHANGED",
    });
    expect(await q.pendingCount()).toBe(1);
  });

  test("handles an ACK racing ahead of the replay acknowledger idempotently", async () => {
    const q = new OutboundQueue(db, { createEventId: () => "event-race" });
    await q.enqueueJobStatus({ ...baseReport, status: "completed" });
    const replay = (await q.loadForReplay())[0];
    if (!replay) throw new Error("expected replayable status");

    expect(await q.acknowledgeJobStatus("event-race")).toBe(true);
    await replay.acknowledge();

    expect(await q.pendingCount()).toBe(0);
  });

  test("enqueueHeartbeat increments pendingCount", async () => {
    const q = new OutboundQueue(db);
    await q.enqueueHeartbeat(baseHeartbeat);
    await q.enqueueHeartbeat({ ...baseHeartbeat, cpuUsagePercent: 50 });
    expect(await q.pendingCount()).toBe(2);
  });

  test("pendingCount sums every durable outbound table", async () => {
    const q = new OutboundQueue(db);
    await q.enqueueJobStatus(baseReport);
    await q.enqueueQueueValidationShadowRejection("QUEUE_CHANGED");
    await q.enqueueHeartbeat(baseHeartbeat);
    await q.enqueueHeartbeat(baseHeartbeat);
    await q.enqueueSoftwareOperationResult(baseSoftwareResult);
    expect(await q.pendingCount()).toBe(5);
  });

  test("loadForReplay returns created_at order across all tables", async () => {
    const q = new OutboundQueue(db, { now: makeClock([100, 200, 300, 400, 500, 600]) });
    await q.enqueueJobStatus({ ...baseReport, status: "queued" }); // t=100
    await q.enqueueQueueValidationShadowRejection("QUEUE_CHANGED"); // t=200
    await q.enqueueHeartbeat(baseHeartbeat); // t=300
    await q.enqueueJobStatus({ ...baseReport, status: "running" }); // t=400
    await q.enqueueSoftwareOperationResult(baseSoftwareResult); // t=500
    await q.enqueueJobStatus({ ...baseReport, status: "completed" }); // t=600

    const replay = await q.loadForReplay();
    const sent = replay.map((entry) => entry.item);

    expect(sent.map((i) => i.kind)).toEqual([
      "jobStatus",
      "queueValidationShadowRejection",
      "heartbeat",
      "jobStatus",
      "softwareOperationResult",
      "jobStatus",
    ]);
    expect(sent.map((i) => (i.kind === "jobStatus" ? i.report.status : i.kind))).toEqual([
      "queued",
      "queueValidationShadowRejection",
      "heartbeat",
      "running",
      "softwareOperationResult",
      "completed",
    ]);
    expect(await q.pendingCount()).toBe(6);
    await Promise.all(replay.map((entry) => entry.acknowledge()));
    expect(await q.pendingCount()).toBe(0);
  });

  test("loadForReplay keeps rows durable until acknowledged", async () => {
    const q = new OutboundQueue(db);
    await q.enqueueJobStatus(baseReport);
    await q.enqueueSoftwareOperationResult(baseSoftwareResult);

    const replay = await q.loadForReplay();
    expect(replay.map((entry) => entry.item.kind)).toEqual([
      "jobStatus",
      "softwareOperationResult",
    ]);
    expect(await q.pendingCount()).toBe(2);

    await replay[0]?.acknowledge();
    expect(await q.pendingCount()).toBe(1);
    await replay[1]?.acknowledge();
    expect(await q.pendingCount()).toBe(0);
  });

  test("payload round-trip preserves all JobStatusReport fields", async () => {
    const q = new OutboundQueue(db);
    const report: JobStatusReport = {
      jobId: "job-x",
      status: "failed",
      schedulerJobId: "slurm-99",
      exitCode: 137,
      message: "OOM killed",
      failureCode: "SCHEDULER_SUBMIT_FAILED",
      node: "node[001-004]",
      reason: "OutOfMemory",
      collected: { result: "energy=-42.1", stdout: "done\n" },
    };
    await q.enqueueJobStatus(report);

    const replay = await q.loadForReplay();
    expect(replay).toHaveLength(1);
    const item = replay[0]?.item;
    if (!item || item.kind !== "jobStatus") throw new Error("expected jobStatus item");
    expect(item.report).toEqual(report);
  });

  test("payload round-trip preserves all HeartbeatSnapshot fields", async () => {
    const q = new OutboundQueue(db);
    const hb: HeartbeatSnapshot = {
      cpuUsagePercent: 42.5,
      memoryUsedMb: 2048,
      memoryTotalMb: 16_384,
      runningJobs: 5,
      queuedJobs: 3,
    };
    await q.enqueueHeartbeat(hb);

    const item = (await q.loadForReplay())[0]?.item;
    if (!item || item.kind !== "heartbeat") throw new Error("expected heartbeat item");
    expect(item.snapshot).toEqual(hb);
  });

  test("payload round-trip preserves software operation result fields", async () => {
    const q = new OutboundQueue(db);
    await q.enqueueSoftwareOperationResult(baseSoftwareResult);

    const item = (await q.loadForReplay())[0]?.item;
    if (!item || item.kind !== "softwareOperationResult") {
      throw new Error("expected softwareOperationResult item");
    }
    expect(item).toEqual(baseSoftwareResult);
  });

  // ---------------------------------------------------------------------------
  // Heartbeat compaction
  // ---------------------------------------------------------------------------

  test("enqueueHeartbeat caps the table at maxQueuedHeartbeats (most recent kept)", async () => {
    const q = new OutboundQueue(db, {
      now: makeClock(Array.from({ length: 100 }, (_, i) => 1_000_000 + i)),
      maxQueuedHeartbeats: 10,
    });

    // Insert 100 heartbeats, each with a unique cpuUsagePercent so we can
    // identify which 10 survived.
    for (let i = 0; i < 100; i++) {
      await q.enqueueHeartbeat({ ...baseHeartbeat, cpuUsagePercent: i });
    }

    // Total queue size must reflect the cap, not the insert count.
    expect(await q.pendingCount()).toBe(10);

    // Drain and verify the survivors are the last 10 inserted (cpu = 90..99),
    // in insertion (created_at asc) order.
    const sent = (await q.loadForReplay()).map((entry) => entry.item);
    expect(sent.length).toBe(10);
    const cpus = sent.map((i) => (i.kind === "heartbeat" ? i.snapshot.cpuUsagePercent : -1));
    expect(cpus).toEqual([90, 91, 92, 93, 94, 95, 96, 97, 98, 99]);
  });

  test("heartbeat compaction does not affect job-status rows", async () => {
    const q = new OutboundQueue(db, {
      now: makeClock(Array.from({ length: 50 }, (_, i) => 1_000_000 + i)),
      maxQueuedHeartbeats: 5,
    });

    await q.enqueueJobStatus(baseReport);
    for (let i = 0; i < 20; i++) {
      await q.enqueueHeartbeat({ ...baseHeartbeat, cpuUsagePercent: i });
    }
    await q.enqueueJobStatus({ ...baseReport, status: "running" });

    // 5 heartbeats (cap) + 2 job-status rows = 7 total
    expect(await q.pendingCount()).toBe(7);
  });

  test("default maxQueuedHeartbeats is 50", async () => {
    const q = new OutboundQueue(db, {
      now: makeClock(Array.from({ length: 100 }, (_, i) => 1_000_000 + i)),
    });
    for (let i = 0; i < 75; i++) {
      await q.enqueueHeartbeat({ ...baseHeartbeat, cpuUsagePercent: i });
    }
    expect(await q.pendingCount()).toBe(50);
  });

  test("maxQueuedHeartbeats=0 disables heartbeat persistence", async () => {
    const q = new OutboundQueue(db, { maxQueuedHeartbeats: 0 });
    await q.enqueueHeartbeat(baseHeartbeat);
    await q.enqueueHeartbeat(baseHeartbeat);
    expect(await q.pendingCount()).toBe(0);
  });
});

/**
 * Returns a now() function that yields the supplied timestamps in order,
 * then sticks on the last value. Lets tests deterministically order rows
 * even when inserts happen in the same tick.
 */
function makeClock(values: number[]): () => Date {
  let i = 0;
  return () => new Date(values[Math.min(i++, values.length - 1)] ?? 0);
}
