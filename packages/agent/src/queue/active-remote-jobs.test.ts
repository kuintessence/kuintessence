import { describe, expect, test } from "bun:test";
import { createSqliteDb } from "@kuintessence/db";
import { ActiveRemoteJobs } from "./active-remote-jobs";

describe("ActiveRemoteJobs", () => {
  test("persists protected data mount paths for restart-safe output isolation", async () => {
    const store = new ActiveRemoteJobs(createSqliteDb(":memory:"));
    await store.recordSubmitted({
      schedulerJobId: "scheduler-1",
      spec: {
        jobId: "job-1",
        name: "test",
        command: "true",
        cpus: 1,
        memoryMb: 128,
        gpus: 0,
        wallTimeSec: 60,
        workingDir: "/managed/jobs/job-1",
        envVars: {},
        licensedMaterialCleanup: [
          {
            selectorId: "potcar-pbe",
            sourcePath: "/managed/licensed/vasp/POTCAR",
            targetPath: "/managed/jobs/job-1/POTCAR",
          },
        ],
      },
      expectedOutputs: [
        {
          descriptor: "result",
          path: "result.txt",
          isBatch: false,
          pathsOnly: true,
          protectedPaths: ["/managed/jobs/job-1/inputs/restricted"],
          protectedMounts: [
            {
              selectorId: "dataset-1",
              sourcePath: "/managed/datasets/dataset-1",
              targetPath: "/managed/jobs/job-1/inputs/restricted",
            },
          ],
        },
      ],
    });
    const [recovered] = await store.listActive();
    expect(recovered?.expectedOutputs[0]?.protectedPaths).toEqual([
      "/managed/jobs/job-1/inputs/restricted",
    ]);
    expect(recovered?.expectedOutputs[0]?.pathsOnly).toBe(true);
    expect(recovered?.expectedOutputs[0]?.protectedMounts).toEqual([
      {
        selectorId: "dataset-1",
        sourcePath: "/managed/datasets/dataset-1",
        targetPath: "/managed/jobs/job-1/inputs/restricted",
      },
    ]);
    expect(recovered?.spec.licensedMaterialCleanup).toEqual([
      {
        selectorId: "potcar-pbe",
        sourcePath: "/managed/licensed/vasp/POTCAR",
        targetPath: "/managed/jobs/job-1/POTCAR",
      },
    ]);
  });
});

test.each([
  false,
  true,
])("recovers Sandbox metadata without inventing signed resources (legacy=%s)", async (legacy) => {
  const db = createSqliteDb(":memory:");
  const store = new ActiveRemoteJobs(db);
  const spec = {
    jobId: "job",
    name: "sandbox",
    command: "",
    cpus: 1,
    memoryMb: 128,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: "/managed/job",
    envVars: {},
    schedulerName: "kq-job",
    queueTargetMode: "named" as const,
    queueValidationMode: "enforce" as const,
    sandbox: {
      language: "python" as const,
      entrypoint: "main.py",
      scriptContent: "print('ok')",
      scriptHostPath: "/managed/job/main.py",
      contextHostPath: "/managed/job/context.json",
      runtimeKind: "OCI" as const,
      runtimePath: `registry.test/runtime@sha256:${"a".repeat(64)}`,
      executionMode: "RootImpersonation" as const,
      identity: {
        backend: "Kubernetes" as const,
        mode: "MappedAccount" as const,
        accountId: "00000000-0000-0000-0000-000000000001",
        namespace: "original-ns",
        serviceAccount: "original-account",
      },
      mounts: [
        {
          descriptor: "output",
          ioType: "File" as const,
          mode: "WriteOnly" as const,
          relativePath: "output",
          containerPath: "/kq/outputs/output",
          hostPath: "/managed/job/output",
          sizeLimitBytes: 100,
          required: true,
          batchEntries: [],
        },
      ],
      ...(legacy ? {} : { resources: { cpus: 1, memoryMb: 128 } }),
      limits: { pids: 8, outputBytes: 100, logBytes: 100 },
      kubernetesArtifactPvc: "original-pvc",
    },
  };
  await store.recordSubmitted({
    spec,
    schedulerJobId: "scheduler",
    dispatchId: "job:7",
    expectedOutputs: [],
  });
  const [restored] = await new ActiveRemoteJobs(db).listActive();
  expect(restored?.dispatchId).toBe("job:7");
  expect(restored?.spec).toMatchObject(spec);
  expect(restored?.spec.sandbox?.mounts).toHaveLength(1);
  expect(restored?.spec.sandbox?.resources).toEqual(
    legacy ? undefined : { cpus: 1, memoryMb: 128 },
  );
});

test("submission identity and inputs remain immutable across retries and concurrent confirmations", async () => {
  const store = new ActiveRemoteJobs(createSqliteDb(":memory:"));
  const spec = {
    jobId: "immutable",
    name: "fixture",
    command: "true",
    cpus: 1,
    memoryMb: 64,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: "/shared/fixture",
    envVars: { A: "one", B: "two" },
  };
  const outputs = [{ descriptor: "result", path: "result.txt", isBatch: false }];
  await store.recordSubmissionIntent(spec, outputs);
  const original = await store.get(spec.jobId);
  await expect(store.recordSubmissionIntent(spec, outputs)).rejects.toThrow("already exists");
  await expect(
    store.recordSubmitted({
      spec: { ...spec, command: "different" },
      expectedOutputs: outputs,
      schedulerJobId: "123",
    }),
  ).rejects.toThrow("binding");
  await expect(
    store.recordSubmitted({ spec, expectedOutputs: [], schedulerJobId: "123" }),
  ).rejects.toThrow("binding");
  expect(await store.get(spec.jobId)).toEqual(original);
  const settled = await Promise.allSettled(
    ["123", "456"].map((schedulerJobId) =>
      store.recordSubmitted({ spec, expectedOutputs: outputs, schedulerJobId }),
    ),
  );
  expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
  const confirmed = await store.get(spec.jobId);
  expect(["123", "456"]).toContain(confirmed?.schedulerJobId ?? "");
  await store.recordSubmitted({
    spec: { ...spec, envVars: { B: "two", A: "one" } },
    expectedOutputs: outputs,
    schedulerJobId: confirmed?.schedulerJobId ?? "",
  });
  const schedulerUid = crypto.randomUUID();
  await store.recordSubmitted({
    spec,
    expectedOutputs: outputs,
    schedulerJobId: confirmed?.schedulerJobId ?? "",
    dispatchId: "immutable:1",
    schedulerUid,
  });
  expect((await store.get(spec.jobId))?.schedulerUid).toBe(schedulerUid);
  for (const changed of [
    { dispatchId: "immutable:2", schedulerUid },
    { dispatchId: "immutable:1", schedulerUid: crypto.randomUUID() },
  ]) {
    await expect(
      store.recordSubmitted({
        spec,
        expectedOutputs: outputs,
        schedulerJobId: confirmed?.schedulerJobId ?? "",
        ...changed,
      }),
    ).rejects.toThrow("identity");
  }
  expect((await store.get(spec.jobId))?.schedulerUid).toBe(schedulerUid);
  await expect(store.recordSubmissionIntent(spec, outputs)).rejects.toThrow("already exists");
  expect((await store.get(spec.jobId))?.schedulerJobId).toBe(confirmed?.schedulerJobId);
  expect((await store.get(spec.jobId))?.submittedAfter).toBe(original?.submittedAfter);
});

test("late confirmation never recreates a finished or cancelled submission", async () => {
  const store = new ActiveRemoteJobs(createSqliteDb(":memory:"));
  const spec = {
    jobId: "finished",
    name: "fixture",
    command: "true",
    cpus: 1,
    memoryMb: 64,
    gpus: 0,
    wallTimeSec: 60,
    workingDir: "/shared/fixture",
    envVars: {},
  };
  await store.recordSubmissionIntent(spec, []);
  await store.markFinished(spec.jobId);
  expect(await store.confirmSubmission(spec.jobId, "123")).toBe(false);
  expect(await store.get(spec.jobId)).toBeUndefined();
});

test("an accepted submission with a lost CLI reply is recovered from disk and accounting without another sbatch", async () => {
  const { Database } = await import("bun:sqlite");
  const { drizzle } = await import("drizzle-orm/bun-sqlite");
  const { runSqliteMigrations } = await import("@kuintessence/db");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { SlurmAdapter } = await import("../adapters/slurm");
  const root = await mkdtemp("/tmp/kq-accepted-submission-");
  let sqlite = new Database(`${root}/agent.db`);
  try {
    runSqliteMigrations(sqlite);
    let store = new ActiveRemoteJobs(drizzle(sqlite));
    const spec = {
      jobId: "durable-uuid",
      schedulerName: "stable-tag",
      name: "fixture",
      command: "true",
      cpus: 1,
      memoryMb: 64,
      gpus: 0,
      wallTimeSec: 60,
      workingDir: "/shared/fixture",
      envVars: {},
    };
    let submissions = 0;
    const adapter = new SlurmAdapter("23", {
      spawner: {
        run: async (argv) => {
          if (argv[0] === "id") return { exitCode: 0, stdout: "1000\n", stderr: "" };
          if (argv[0] === "sbatch") {
            submissions++;
            return {
              exitCode: 1,
              stdout: "",
              stderr:
                "sbatch: error: Batch job submission failed: Socket timed out on send/recv operation",
            };
          }
          return {
            exitCode: 0,
            stdout: argv[0] === "squeue" ? "" : "123|stable-tag|KQ_JOB_ID=durable-uuid|account\n",
            stderr: "",
          };
        },
      },
    });
    await store.recordSubmissionIntent(spec, []);
    await expect(adapter.submit(spec)).rejects.toMatchObject({
      name: "SchedulerSubmissionUnknownError",
    });
    sqlite.close();
    sqlite = new Database(`${root}/agent.db`);
    store = new ActiveRemoteJobs(drizzle(sqlite));
    const pending = await store.get(spec.jobId);
    const found = await adapter.findByKuintessenceJobId({
      jobId: spec.jobId,
      schedulerName: spec.schedulerName,
      includeCompleted: true,
      submittedAfter: pending?.submittedAfter,
    });
    expect(found.status).toBe("found");
    if (found.status !== "found") throw new Error("expected uniquely recovered allocation");
    expect(await store.confirmSubmission(spec.jobId, found.schedulerJobId)).toBe(true);
    expect((await store.get(spec.jobId))?.schedulerJobId).toBe("123");
    await expect(store.recordSubmissionIntent(spec, [])).rejects.toThrow("already exists");
    expect(submissions).toBe(1);
  } finally {
    sqlite.close();
    await rm(root, { recursive: true, force: true });
  }
});
