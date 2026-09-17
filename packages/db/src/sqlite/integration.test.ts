import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { runSqliteMigrations } from "./migrate";
import * as schema from "./schema";
import {
  activeRemoteJobs,
  agentConfig,
  inboundDispatchPending,
  localJobs,
  localSoftware,
  localWorkflowRuns,
  outboundHeartbeat,
  outboundJobStatus,
  outboundSoftwareOperationResult,
  queuedOperations,
} from "./schema";

function freshDb() {
  const sqlite = new Database(":memory:");
  runSqliteMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

describe("SQLite integration", () => {
  test("migrations backfill columns added to a pre-existing local_jobs table", () => {
    const sqlite = new Database(":memory:");
    // Simulate a ~/.kq/local.db created by an older kq — local_jobs without the
    // name/gpus/wall_time_sec columns that were added later. CREATE-IF-NOT-EXISTS
    // alone would leave it stale; the migration must ADD the missing columns.
    sqlite.exec(`CREATE TABLE local_jobs (
      job_id TEXT PRIMARY KEY,
      scheduler_job_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      command TEXT NOT NULL,
      cpus INTEGER NOT NULL,
      memory_mb INTEGER NOT NULL,
      exit_code INTEGER,
      submitted_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    runSqliteMigrations(sqlite);
    const cols = (sqlite.query("PRAGMA table_info(local_jobs)").all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain("name");
    expect(cols).toContain("gpus");
    expect(cols).toContain("wall_time_sec");
    // Idempotent: a second run on the now-complete table is a no-op (no throw).
    expect(() => runSqliteMigrations(sqlite)).not.toThrow();
  });

  test("queued_operations round-trip", () => {
    const { db, sqlite } = freshDb();
    const inserted = db
      .insert(queuedOperations)
      .values({
        operationType: "register",
        payload: { agentId: "test-01" },
        idempotencyKey: "key-1",
        createdAt: new Date(),
      })
      .returning()
      .all();

    expect(inserted.length).toBe(1);
    const row = inserted[0];
    if (!row) throw new Error("expected inserted row");
    expect(row.operationType).toBe("register");
    expect(row.payload).toEqual({ agentId: "test-01" });
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.attempts).toBe(0);
    sqlite.close();
  });

  test("queued_operations idempotency_key is unique", () => {
    const { db, sqlite } = freshDb();
    db.insert(queuedOperations)
      .values({
        operationType: "register",
        payload: {},
        idempotencyKey: "dup-key",
        createdAt: new Date(),
      })
      .run();

    expect(() =>
      db
        .insert(queuedOperations)
        .values({
          operationType: "register",
          payload: {},
          idempotencyKey: "dup-key",
          createdAt: new Date(),
        })
        .run(),
    ).toThrow();
    sqlite.close();
  });

  test("local_jobs round-trip", () => {
    const { db, sqlite } = freshDb();
    const inserted = db
      .insert(localJobs)
      .values({
        jobId: "job-001",
        command: "echo hello",
        cpus: 4,
        memoryMb: 8192,
        submittedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning()
      .all();

    expect(inserted.length).toBe(1);
    const row = inserted[0];
    if (!row) throw new Error("expected inserted row");
    expect(row.jobId).toBe("job-001");
    expect(row.status).toBe("pending");
    expect(row.cpus).toBe(4);
    expect(row.submittedAt).toBeInstanceOf(Date);

    const updated = db
      .update(localJobs)
      .set({ status: "running", schedulerJobId: "slurm-12345" })
      .where(eq(localJobs.jobId, "job-001"))
      .returning()
      .all();
    if (!updated[0]) throw new Error("expected updated row");
    expect(updated[0].status).toBe("running");
    expect(updated[0].schedulerJobId).toBe("slurm-12345");
    sqlite.close();
  });

  test("agent_config round-trip", () => {
    const { db, sqlite } = freshDb();
    db.insert(agentConfig).values({ key: "site_id", value: "example-01" }).run();

    const rows = db.select().from(agentConfig).where(eq(agentConfig.key, "site_id")).all();
    if (!rows[0]) throw new Error("expected row");
    expect(rows[0].value).toBe("example-01");
    sqlite.close();
  });

  test("outbound_job_status preserves insertion order via createdAt asc", () => {
    const { db, sqlite } = freshDb();
    const t0 = new Date(1_700_000_000_000);
    db.insert(outboundJobStatus)
      .values([
        {
          jobId: "j-1",
          payload: { jobId: "j-1", status: "queued" },
          createdAt: new Date(t0.getTime() + 1),
        },
        {
          jobId: "j-1",
          payload: { jobId: "j-1", status: "running" },
          createdAt: new Date(t0.getTime() + 2),
        },
        {
          jobId: "j-1",
          payload: { jobId: "j-1", status: "completed", exitCode: 0 },
          createdAt: new Date(t0.getTime() + 3),
        },
      ])
      .run();

    const rows = db
      .select()
      .from(outboundJobStatus)
      .orderBy(asc(outboundJobStatus.createdAt))
      .all();
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => (r.payload as { status: string }).status)).toEqual([
      "queued",
      "running",
      "completed",
    ]);
    sqlite.close();
  });

  test("outbound_software_operation_result round-trip with json payload", () => {
    const { db, sqlite } = freshDb();
    const t0 = new Date(1_700_000_000_000);
    db.insert(outboundSoftwareOperationResult)
      .values([
        {
          operationId: "op-1",
          payload: { operationId: "op-1", status: "running", spec: "zlib" },
          createdAt: new Date(t0.getTime() + 1),
        },
        {
          operationId: "op-1",
          payload: {
            operationId: "op-1",
            status: "succeeded",
            spec: "zlib",
            installed: [{ name: "zlib", version: "1.3", hash: "abc", spec: "zlib@1.3" }],
          },
          createdAt: new Date(t0.getTime() + 2),
        },
      ])
      .run();

    const rows = db
      .select()
      .from(outboundSoftwareOperationResult)
      .orderBy(asc(outboundSoftwareOperationResult.createdAt))
      .all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => (r.payload as { status: string }).status)).toEqual([
      "running",
      "succeeded",
    ]);
    sqlite.close();
  });

  test("inbound_dispatch_pending round-trip and ackedAt update", () => {
    const { db, sqlite } = freshDb();
    const t0 = new Date(1_700_000_000_000);
    db.insert(inboundDispatchPending)
      .values({
        dispatchId: "disp-1",
        jobId: "job-1",
        payload: { jobId: "job-1", name: "echo" },
        receivedAt: t0,
      })
      .run();

    // Pending query: ackedAt IS NULL
    const pending = db
      .select()
      .from(inboundDispatchPending)
      .where(isNull(inboundDispatchPending.ackedAt))
      .all();
    expect(pending).toHaveLength(1);
    const row = pending[0];
    if (!row) throw new Error("expected row");
    expect(row.dispatchId).toBe("disp-1");
    expect(row.jobId).toBe("job-1");
    expect(row.ackedAt).toBeNull();
    expect(row.receivedAt).toBeInstanceOf(Date);

    // Mark acked
    db.update(inboundDispatchPending)
      .set({ ackedAt: new Date(t0.getTime() + 1000) })
      .where(eq(inboundDispatchPending.dispatchId, "disp-1"))
      .run();

    const stillPending = db
      .select()
      .from(inboundDispatchPending)
      .where(isNull(inboundDispatchPending.ackedAt))
      .all();
    expect(stillPending).toHaveLength(0);

    sqlite.close();
  });

  test("inbound_dispatch_pending dispatch_id is unique", () => {
    const { db, sqlite } = freshDb();
    db.insert(inboundDispatchPending)
      .values({
        dispatchId: "dup-disp",
        jobId: "job-1",
        payload: {},
        receivedAt: new Date(),
      })
      .run();

    expect(() =>
      db
        .insert(inboundDispatchPending)
        .values({
          dispatchId: "dup-disp",
          jobId: "job-2",
          payload: {},
          receivedAt: new Date(),
        })
        .run(),
    ).toThrow();
    sqlite.close();
  });

  test("active_remote_jobs round-trip with json payloads", () => {
    const { db, sqlite } = freshDb();
    const now = new Date(1_700_000_000_000);
    const inserted = db
      .insert(activeRemoteJobs)
      .values({
        jobId: "job-001",
        schedulerJobId: "slurm-101",
        spec: {
          jobId: "job-001",
          name: "resume-me",
          command: "bash -lc 'sleep 30'",
          cpus: 1,
          memoryMb: 1024,
          gpus: 0,
          wallTimeSec: 120,
          workingDir: "/tmp/job-001",
          envVars: {},
        },
        expectedOutputs: [{ descriptor: "stdout", path: "slurm.out", isBatch: false }],
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all();

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    if (!row) throw new Error("expected inserted row");
    expect(row.schedulerJobId).toBe("slurm-101");
    expect(row.spec.name).toBe("resume-me");
    expect(row.expectedOutputs[0]?.descriptor).toBe("stdout");
    expect(row.createdAt).toBeInstanceOf(Date);
    sqlite.close();
  });

  test("local_software round-trip with index ordering", () => {
    const { db, sqlite } = freshDb();
    const t0 = new Date(1_700_000_000_000);
    const inserted = db
      .insert(localSoftware)
      .values({
        name: "gromacs",
        version: "2024.1",
        spec: "gromacs@2024.1",
        source: "spack",
        detectedAt: t0,
      })
      .returning()
      .all();

    expect(inserted.length).toBe(1);
    const row = inserted[0];
    if (!row) throw new Error("expected inserted row");
    expect(row.name).toBe("gromacs");
    expect(row.version).toBe("2024.1");
    expect(row.spec).toBe("gromacs@2024.1");
    expect(row.source).toBe("spack");
    expect(row.detectedAt).toBeInstanceOf(Date);

    db.insert(localSoftware)
      .values({
        name: "amber",
        version: "22",
        spec: "amber@22",
        source: "module",
        detectedAt: new Date(t0.getTime() + 1000),
      })
      .run();

    const byName = db.select().from(localSoftware).orderBy(asc(localSoftware.name)).all();
    expect(byName.map((r) => r.name)).toEqual(["amber", "gromacs"]);

    const onlySpack = db
      .select()
      .from(localSoftware)
      .where(eq(localSoftware.source, "spack"))
      .all();
    expect(onlySpack).toHaveLength(1);
    expect(onlySpack[0]?.name).toBe("gromacs");
    sqlite.close();
  });

  test("local_workflow_runs round-trip with defaults and step_jobs update", () => {
    const { db, sqlite } = freshDb();
    const t0 = new Date(1_700_000_000_000);
    const inserted = db
      .insert(localWorkflowRuns)
      .values({
        runId: "run-001",
        name: "nightly",
        description: null,
        submittedBy: "alice",
        status: "running",
        createdAt: t0,
        updatedAt: t0,
      })
      .returning()
      .all();

    expect(inserted.length).toBe(1);
    const row = inserted[0];
    if (!row) throw new Error("expected inserted row");
    expect(row.runId).toBe("run-001");
    expect(row.status).toBe("running");
    expect(row.stepJobs).toBe("{}");
    expect(row.result).toBeNull();
    expect(row.createdAt).toBeInstanceOf(Date);

    const updated = db
      .update(localWorkflowRuns)
      .set({ stepJobs: JSON.stringify({ build: "job-1" }), status: "succeeded" })
      .where(eq(localWorkflowRuns.runId, "run-001"))
      .returning()
      .all();
    if (!updated[0]) throw new Error("expected updated row");
    expect(updated[0].status).toBe("succeeded");
    expect(JSON.parse(updated[0].stepJobs)).toEqual({ build: "job-1" });
    sqlite.close();
  });

  test("outbound_heartbeat round-trip with json payload", () => {
    const { db, sqlite } = freshDb();
    db.insert(outboundHeartbeat)
      .values({
        payload: { cpuUsagePercent: 12.5, memoryUsedMb: 1024, runningJobs: 2, queuedJobs: 0 },
        createdAt: new Date(),
      })
      .run();
    const rows = db.select().from(outboundHeartbeat).all();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error("expected row");
    expect((row.payload as { cpuUsagePercent: number }).cpuUsagePercent).toBe(12.5);
    expect(row.createdAt).toBeInstanceOf(Date);
    sqlite.close();
  });
});
