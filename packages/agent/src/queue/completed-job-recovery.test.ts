import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeRemoteJobs, runSqliteMigrations, type SqliteDb } from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { JobSpec, SchedulerAdapter } from "../adapters/base";
import { JobRunner, type JobStatusReport } from "../embedded/job-executor";
import { ActiveRemoteJobs } from "./active-remote-jobs";

const spec: JobSpec = {
  jobId: "completed-job",
  schedulerName: "stable-tag",
  name: "fixture",
  command: "calculate",
  cpus: 1,
  memoryMb: 128,
  gpus: 0,
  wallTimeSec: 60,
  workingDir: "/shared/job",
  envVars: {},
};
const outputs = [{ descriptor: "result", path: "result.txt", isBatch: false }];
const noSleep = async () => {};
const adapter = (): SchedulerAdapter => ({
  type: "slurm",
  version: "fixture",
  submit: async () => {
    throw new Error("must never resubmit");
  },
  status: async () => ({ status: "completed", exitCode: 0, node: "compute-1" }),
  cancel: async () => {},
});

test("durable completion survives SQLite reopen and purged scheduler history without resubmission", async () => {
  const root = await mkdtemp(join(tmpdir(), "kq-completed-recovery-"));
  let sqlite = new Database(join(root, "agent.db"));
  try {
    sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    runSqliteMigrations(sqlite);
    let store = new ActiveRemoteJobs(drizzle(sqlite));
    const original = { ...spec, workingDir: root };
    await writeFile(join(root, "result.txt"), "scientific result");
    await store.recordSubmitted({
      spec: original,
      schedulerJobId: "123",
      expectedOutputs: outputs,
    });
    let captured = false;
    const firstAdapter = adapter();
    let released = false;
    firstAdapter.releaseJob = async () => {
      released = true;
    };
    let first: JobRunner;
    first = new JobRunner({
      adapter: firstAdapter,
      sleep: noSleep,
      onStatusUpdate: () => {},
      onSchedulerCompleted: async (spec, schedulerJobId, expectedOutputs, result) => {
        await store.recordCompleted({ spec, schedulerJobId, expectedOutputs }, result);
        captured = true;
      },
      collectOutputs: async () => {
        expect(captured).toBe(true);
        first.cancel();
        throw Object.assign(new Error("shared filesystem unavailable"), { code: "EIO" });
      },
      onJobFinished: async () => {
        throw new Error("must retain the completed worker");
      },
    });
    await first.resume(original, "123", outputs);
    expect(released).toBe(false);
    expect((await store.get(spec.jobId))?.completionSnapshot?.result.status).toBe("completed");
    sqlite.close();
    sqlite = new Database(join(root, "agent.db"));
    store = new ActiveRemoteJobs(drizzle(sqlite));
    const recovered = await store.get(spec.jobId);
    if (!recovered?.completionSnapshot) throw new Error("Missing durable completion");
    const reports: JobStatusReport[] = [];
    let schedulerQueries = 0;
    const purged = adapter();
    purged.status = async () => {
      schedulerQueries++;
      throw new Error("accounting purged");
    };
    purged.prepareResume = async () => {
      throw new Error("must not require purged scheduler metadata");
    };
    purged.releaseJob = async () => {
      released = true;
    };
    await new JobRunner({
      adapter: purged,
      sleep: noSleep,
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      collectOutputs: async (_, workingDir) => ({
        result: await readFile(join(workingDir, "result.txt"), "utf8"),
      }),
      onJobFinished: (jobId) => store.markFinished(jobId),
    }).resume(
      recovered.spec,
      recovered.schedulerJobId,
      recovered.expectedOutputs,
      recovered.completionSnapshot,
    );
    expect(schedulerQueries).toBe(0);
    expect(reports).toMatchObject([
      { status: "completed", schedulerJobId: "123", collected: { result: "scientific result" } },
    ]);
    expect(released).toBe(true);
    expect(await store.get(spec.jobId)).toBeUndefined();
  } finally {
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed durable completion write cannot collect outputs, report completion or release", async () => {
  let collected = false;
  let released = false;
  const realCompletion = adapter();
  realCompletion.releaseJob = async () => {
    released = true;
  };
  await expect(
    new JobRunner({
      adapter: realCompletion,
      sleep: noSleep,
      onSchedulerCompleted: async () => {
        throw new Error("disk full");
      },
      collectOutputs: async () => {
        collected = true;
        return {};
      },
      onStatusUpdate: () => {
        throw new Error("must not report unsaved completion");
      },
      onJobFinished: async () => {
        released = true;
      },
    }).resume(spec, "123", outputs),
  ).rejects.toThrow("disk full");
  expect(collected).toBe(false);
  expect(released).toBe(false);
});

test("completion snapshots reject changed scheduler, spec, outputs and unknown format", async () => {
  const sqlite = new Database(":memory:");
  try {
    runSqliteMigrations(sqlite);
    const db: SqliteDb = drizzle(sqlite);
    const store = new ActiveRemoteJobs(db);
    await store.recordSubmitted({ spec, schedulerJobId: "123", expectedOutputs: outputs });
    await store.recordCompleted(
      { spec, schedulerJobId: "123", expectedOutputs: outputs },
      { status: "completed", exitCode: 0 },
    );
    const [original] = await db.select().from(activeRemoteJobs);
    if (!original) throw new Error("Missing fixture");
    const snapshot = original.spec.completionSnapshot as Record<string, unknown>;
    for (const changed of [
      { ...original.spec, command: "other calculation" },
      { ...original.spec, completionSnapshot: { ...snapshot, schedulerJobId: "124" } },
      { ...original.spec, completionSnapshot: { ...snapshot, format: 2 } },
    ]) {
      await db
        .update(activeRemoteJobs)
        .set({ spec: changed })
        .where(eq(activeRemoteJobs.jobId, spec.jobId));
      await expect(store.get(spec.jobId)).rejects.toThrow("binding");
    }
    await db
      .update(activeRemoteJobs)
      .set({
        spec: original.spec,
        expectedOutputs: [{ descriptor: "other", path: "other", isBatch: false }],
      })
      .where(eq(activeRemoteJobs.jobId, spec.jobId));
    await expect(store.get(spec.jobId)).rejects.toThrow("binding");
  } finally {
    sqlite.close();
  }
});

test("restricted completion snapshots keep the original no-egress collection policy", async () => {
  const sqlite = new Database(":memory:");
  try {
    runSqliteMigrations(sqlite);
    const store = new ActiveRemoteJobs(drizzle(sqlite));
    const restricted = { ...spec, restrictedNoEgress: true };
    await store.recordSubmitted({
      spec: restricted,
      schedulerJobId: "123",
      expectedOutputs: outputs,
    });
    await store.recordCompleted(
      { spec: restricted, schedulerJobId: "123", expectedOutputs: outputs },
      { status: "completed", exitCode: 0 },
    );
    const recovered = await store.get(spec.jobId);
    if (!recovered?.completionSnapshot) throw new Error("Missing snapshot");
    const purged = adapter();
    purged.status = async () => {
      throw new Error("must not query");
    };
    const reports: JobStatusReport[] = [];
    await new JobRunner({
      adapter: purged,
      sleep: noSleep,
      collectOutputs: async () => {
        throw new Error("must not collect restricted output");
      },
      onStatusUpdate: (report) => {
        reports.push(report);
      },
    }).resume(recovered.spec, "123", recovered.expectedOutputs, recovered.completionSnapshot);
    expect(reports[0]?.status).toBe("completed");
    expect(reports[0]?.collected).toBeUndefined();
  } finally {
    sqlite.close();
  }
});
