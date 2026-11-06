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

test("recovers Sandbox identity, isolation and output-validation metadata without dropping fields", async () => {
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
});
