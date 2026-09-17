import { describe, expect, test } from "bun:test";
import type { Spawner } from "../adapters/base";
import { createCachedSchedulerQueueDepthReader, readSchedulerQueueDepth } from "./queue-depth";

function recordingSpawner(result: { exitCode: number; stdout: string; stderr: string } | Error): {
  spawner: Spawner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawner: Spawner = {
    async run(cmd) {
      calls.push(cmd);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { spawner, calls };
}

describe("readSchedulerQueueDepth", () => {
  test("Slurm: counts squeue -h lines", async () => {
    const { spawner, calls } = recordingSpawner({
      exitCode: 0,
      stdout: "  111 jobname1 user1 R 0:00 1 node1\n  112 jobname2 user2 PD 0:00 1 (none)\n",
      stderr: "",
    });
    const out = await readSchedulerQueueDepth({ schedulerType: "slurm", spawner });
    expect(out).toBe(2);
    expect(calls[0]).toEqual(["squeue", "-h"]);
  });

  test("Slurm: empty output → 0", async () => {
    const { spawner } = recordingSpawner({ exitCode: 0, stdout: "", stderr: "" });
    const out = await readSchedulerQueueDepth({ schedulerType: "slurm", spawner });
    expect(out).toBe(0);
  });

  test("Slurm: missing squeue → 0 (best effort)", async () => {
    const { spawner } = recordingSpawner(new Error("ENOENT"));
    const out = await readSchedulerQueueDepth({ schedulerType: "slurm", spawner });
    expect(out).toBe(0);
  });

  test("Slurm: non-zero exit → 0", async () => {
    const { spawner } = recordingSpawner({ exitCode: 1, stdout: "", stderr: "down" });
    const out = await readSchedulerQueueDepth({ schedulerType: "slurm", spawner });
    expect(out).toBe(0);
  });

  test("PBS Pro: counts qstat lines minus 2 header rows", async () => {
    const { spawner, calls } = recordingSpawner({
      exitCode: 0,
      stdout: [
        "Job id            Name             User              Time Use S Queue",
        "----------------  ---------------- ----------------  -------- - -----",
        "111.pbs           job1             user1                    0 R workq",
        "112.pbs           job2             user2                    0 Q workq",
      ].join("\n"),
      stderr: "",
    });
    const out = await readSchedulerQueueDepth({ schedulerType: "pbs-pro", spawner });
    expect(out).toBe(2);
    expect(calls[0]?.[0]).toBe("qstat");
  });

  test("PBS Pro: empty (no header) → 0", async () => {
    const { spawner } = recordingSpawner({ exitCode: 0, stdout: "", stderr: "" });
    const out = await readSchedulerQueueDepth({ schedulerType: "pbs-pro", spawner });
    expect(out).toBe(0);
  });

  test("Torque: counts qstat lines minus 2 header rows", async () => {
    const { spawner } = recordingSpawner({
      exitCode: 0,
      stdout: [
        "Job ID            Name             User              Time Use S Queue",
        "----------------  ---------------- ----------------  -------- - -----",
        "111.torque        job1             user1                    0 R workq",
      ].join("\n"),
      stderr: "",
    });
    const out = await readSchedulerQueueDepth({ schedulerType: "torque", spawner });
    expect(out).toBe(1);
  });

  test("Kubernetes: counts kubectl get jobs -o name lines", async () => {
    const { spawner, calls } = recordingSpawner({
      exitCode: 0,
      stdout: "job.batch/foo\njob.batch/bar\njob.batch/baz\n",
      stderr: "",
    });
    const out = await readSchedulerQueueDepth({ schedulerType: "kubernetes", spawner });
    expect(out).toBe(3);
    expect(calls[0]).toEqual(["kubectl", "get", "jobs", "-o", "name"]);
  });

  test("unknown scheduler → 0 without invoking spawner", async () => {
    const { spawner, calls } = recordingSpawner({ exitCode: 0, stdout: "", stderr: "" });
    const out = await readSchedulerQueueDepth({ schedulerType: "unknown" as never, spawner });
    expect(out).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("passes the command timeout to the spawner", async () => {
    let timeoutMs: number | undefined;
    const spawner: Spawner = {
      async run(_cmd, options) {
        timeoutMs = options?.timeoutMs;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    await readSchedulerQueueDepth({ schedulerType: "kubernetes", spawner, timeoutMs: 5_000 });
    expect(timeoutMs).toBe(5_000);
  });

  test("caches scheduler CLI results until the refresh interval expires", async () => {
    let currentTime = 10_000;
    let calls = 0;
    const spawner: Spawner = {
      async run() {
        calls += 1;
        return { exitCode: 0, stdout: "job.batch/a\n", stderr: "" };
      },
    };
    const read = createCachedSchedulerQueueDepthReader({
      schedulerType: "kubernetes",
      spawner,
      refreshIntervalMs: 120_000,
      now: () => currentTime,
    });

    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    expect(calls).toBe(1);
    currentTime += 120_000;
    expect(await read()).toBe(1);
    expect(calls).toBe(2);
  });

  test("coalesces concurrent scheduler CLI reads", async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spawner: Spawner = {
      async run() {
        calls += 1;
        await gate;
        return { exitCode: 0, stdout: "job.batch/a\njob.batch/b\n", stderr: "" };
      },
    };
    const read = createCachedSchedulerQueueDepthReader({
      schedulerType: "kubernetes",
      spawner,
      refreshIntervalMs: 120_000,
    });
    const first = read();
    const second = read();
    release?.();
    expect(await Promise.all([first, second])).toEqual([2, 2]);
    expect(calls).toBe(1);
  });
});
