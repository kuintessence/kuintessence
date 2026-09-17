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
