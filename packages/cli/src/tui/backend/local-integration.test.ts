import { describe, expect, test } from "bun:test";
import {
  K8sAdapter,
  PbsProAdapter,
  SlurmAdapter,
  type Spawner,
  TorqueAdapter,
} from "@kuintessence/agent/adapters";
import { SqliteLocalJobStore } from "@kuintessence/agent/embedded";
import { createSqliteDb } from "@kuintessence/db";
import { LocalBackend } from "./local";

/**
 * Scenario 2 (all-in-one local mode) end-to-end through the *real* adapter
 * stack: LocalBackend → concrete SchedulerAdapter → spawner. The unit tests
 * exercise LocalBackend with a fake adapter and the adapters with a mock
 * spawner separately; this wires the full local data path so the
 * "download the binary to a login node and it works" guarantee is CI-checked
 * across all four schedulers. The spawner is mocked (no real scheduler), so it
 * runs anywhere.
 */
function scriptedSpawner(byCommand: Record<string, { exitCode?: number; stdout: string }>): {
  spawner: Spawner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const spawner: Spawner = {
    async run(cmd) {
      calls.push(cmd);
      const r = byCommand[cmd[0] ?? ""];
      if (!r) throw new Error(`no scripted response for ${cmd[0]}`);
      return { exitCode: r.exitCode ?? 0, stdout: r.stdout, stderr: "" };
    },
  };
  return { spawner, calls };
}

const JOB_SPEC = JSON.stringify({ name: "wrf", command: "echo hi", cpus: 4, memoryMb: 8192 });

describe("LocalBackend × SlurmAdapter (full local stack)", () => {
  test("lists, submits, and tails logs through the real adapter", async () => {
    const { spawner, calls } = scriptedSpawner({
      squeue: { stdout: "12345|wrf|RUNNING|compute|2026-05-30T10:00:00\n" },
      sbatch: { stdout: "67890\n" },
      scontrol: { stdout: "JobId=12345 JobName=wrf StdOut=/scratch/wrf.out" },
      tail: { stdout: "epoch 1\nepoch 2\n" },
      scancel: { stdout: "" },
    });
    const backend = new LocalBackend(new SlurmAdapter("23.02.7", { spawner }));

    expect(backend.info.mode).toBe("local");
    expect(backend.capabilities).toMatchObject({ jobs: true, submit: true, logs: true });

    const jobs = await backend.listJobs();
    expect(jobs).toEqual([
      {
        id: "12345",
        name: "wrf",
        status: "running",
        location: "compute",
        submittedAt: "2026-05-30T10:00:00",
      },
    ]);

    expect(await backend.submitFromSpec(JOB_SPEC)).toMatchObject({ id: "67890", name: "wrf" });
    expect(await backend.getJobLogs("12345", 100)).toBe("epoch 1\nepoch 2\n");
    await backend.cancelJob("12345");

    expect(calls.map((c) => c[0])).toEqual(["squeue", "sbatch", "scontrol", "tail", "scancel"]);
  });

  test("surfaces node + start time in the job detail through the real adapter", async () => {
    const { spawner } = scriptedSpawner({
      squeue: {
        stdout: JSON.stringify({
          jobs: [
            {
              job_id: 12345,
              job_state: "RUNNING",
              nodes: "node[01-04]",
              start_time: { set: true, number: 1700000000 },
            },
          ],
        }),
      },
    });
    const backend = new LocalBackend(new SlurmAdapter("23.02.7", { spawner }));
    const detail = await backend.getJobDetail("12345");
    expect(detail).toMatchObject({
      id: "12345",
      status: "running",
      node: "node[01-04]",
      startedAt: "2023-11-14T22:13:20.000Z",
    });
  });

  test("a submitted job persists and still lists after the queue empties (real SQLite)", async () => {
    const { spawner } = scriptedSpawner({
      sbatch: { stdout: "67890\n" },
      squeue: { stdout: "" }, // empty queue — the job has been evicted
    });
    const store = new SqliteLocalJobStore(createSqliteDb(":memory:"));
    const backend = new LocalBackend(
      new SlurmAdapter("23.02.7", { spawner }),
      undefined,
      "host",
      store,
    );

    await backend.submitFromSpec(JOB_SPEC);
    const jobs = await backend.listJobs();
    // Live queue is empty, yet the kq-submitted job still shows from SQLite.
    expect(jobs.map((j) => j.id)).toEqual(["67890"]);
    expect(jobs[0]).toMatchObject({ name: "wrf", status: "queued", location: "—" });
  });
});

describe("LocalBackend × PbsProAdapter (full local stack)", () => {
  test("lists via qstat JSON and tails via Output_Path", async () => {
    const { spawner } = scriptedSpawner({
      qstat: {
        stdout: JSON.stringify({
          Jobs: {
            "101.srv": {
              Job_Name: "mesh",
              job_state: "R",
              queue: "gpu",
              Output_Path: "srv:/home/u/mesh.o101",
            },
          },
        }),
      },
      tail: { stdout: "pbs out\n" },
    });
    const backend = new LocalBackend(new PbsProAdapter("19.0.0", { spawner }));
    expect(backend.capabilities.jobs).toBe(true);
    const jobs = await backend.listJobs();
    expect(jobs[0]).toMatchObject({
      id: "101.srv",
      name: "mesh",
      status: "running",
      location: "gpu",
    });
    expect(await backend.getJobLogs("101.srv", 50)).toBe("pbs out\n");
  });

  test("job detail surfaces the pending reason (qstat comment) through the real adapter", async () => {
    const { spawner } = scriptedSpawner({
      qstat: {
        stdout: JSON.stringify({
          Jobs: {
            "101.srv": {
              job_state: "Q",
              comment: "Not Running: Insufficient amount of resource: ncpus",
            },
          },
        }),
      },
    });
    const backend = new LocalBackend(new PbsProAdapter("19.0.0", { spawner }));
    const detail = await backend.getJobDetail("101.srv");
    expect(detail).toMatchObject({
      id: "101.srv",
      status: "queued",
      reason: "Not Running: Insufficient amount of resource: ncpus",
    });
  });
});

describe("LocalBackend × TorqueAdapter (full local stack)", () => {
  test("lists via tabular qstat", async () => {
    const { spawner } = scriptedSpawner({
      qstat: {
        stdout: [
          "Job id     Name   User   Time Use S Queue",
          "---------- ------ ------ -------- - -----",
          "55.srv     solve  alice  00:00:10 R batch",
          "",
        ].join("\n"),
      },
    });
    const backend = new LocalBackend(new TorqueAdapter("6.1.0", { spawner }));
    const jobs = await backend.listJobs();
    expect(jobs[0]).toMatchObject({
      id: "55.srv",
      name: "solve",
      status: "running",
      location: "batch",
    });
  });

  test("tails logs via Output_Path (host: prefix stripped) through the real adapter", async () => {
    const { spawner, calls } = scriptedSpawner({
      qstat: {
        stdout: ["Job Id: 55.srv", "    Output_Path = srv:/home/alice/solve.o55"].join("\n"),
      },
      tail: { stdout: "torque out 1\ntorque out 2\n" },
    });
    const backend = new LocalBackend(new TorqueAdapter("6.1.0", { spawner }));
    expect(backend.capabilities.logs).toBe(true);
    expect(await backend.getJobLogs("55.srv", 50)).toBe("torque out 1\ntorque out 2\n");
    // The login-node-local path (host: prefix stripped) is what gets tailed.
    expect(calls.find((c) => c[0] === "tail")).toContain("/home/alice/solve.o55");
  });

  test("job detail surfaces node (exec_host) + pending reason (comment) through the real adapter", async () => {
    const { spawner } = scriptedSpawner({
      qstat: {
        stdout: [
          "Job Id: 55.srv",
          "    job_state = R",
          "    exec_host = node03/0+node03/1+node04/0",
          "    comment = Job started on Mon",
        ].join("\n"),
      },
    });
    const backend = new LocalBackend(new TorqueAdapter("6.1.0", { spawner }));
    const detail = await backend.getJobDetail("55.srv");
    expect(detail).toMatchObject({
      id: "55.srv",
      status: "running",
      node: "node03,node04",
      reason: "Job started on Mon",
    });
  });
});

describe("LocalBackend × K8sAdapter (full local stack)", () => {
  test("lists via kubectl get jobs and tails via kubectl logs", async () => {
    const { spawner } = scriptedSpawner({
      kubectl: {
        stdout: JSON.stringify({ items: [{ metadata: { name: "kq-1" }, status: { active: 1 } }] }),
      },
    });
    const backend = new LocalBackend(new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" }));
    const jobs = await backend.listJobs();
    expect(jobs[0]).toMatchObject({
      id: "kq-1",
      name: "kq-1",
      status: "running",
      location: "kq-ns",
    });
  });

  test("job detail composes the job status + pod node/start via two kubectl calls", async () => {
    // K8s status() makes two kubectl calls: `get job` (status) then, for a
    // running/completed job, `get pods` (node + start time). Route by subcommand.
    const calls: string[][] = [];
    const spawner: Spawner = {
      async run(cmd) {
        calls.push(cmd);
        const out = cmd.includes("pods")
          ? "worker-7\t2023-11-14T22:13:20Z"
          : JSON.stringify({ status: { active: 1 } });
        return { exitCode: 0, stdout: out, stderr: "" };
      },
    };
    const backend = new LocalBackend(new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" }));
    const detail = await backend.getJobDetail("kq-1");
    expect(detail).toMatchObject({
      id: "kq-1",
      status: "running",
      node: "worker-7",
      startedAt: "2023-11-14T22:13:20Z",
    });
    expect(calls.some((c) => c.includes("pods"))).toBe(true);
  });

  test("job detail surfaces the pending pod reason (Unschedulable) through the real adapter", async () => {
    const spawner: Spawner = {
      async run(cmd) {
        const out = cmd.includes("pods")
          ? JSON.stringify({
              items: [
                {
                  status: {
                    conditions: [
                      { type: "PodScheduled", status: "False", reason: "Unschedulable" },
                    ],
                  },
                },
              ],
            })
          : JSON.stringify({ status: {} }); // no active/succeeded/failed → queued
        return { exitCode: 0, stdout: out, stderr: "" };
      },
    };
    const backend = new LocalBackend(new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" }));
    const detail = await backend.getJobDetail("kq-1");
    expect(detail).toMatchObject({ id: "kq-1", status: "queued", reason: "Unschedulable" });
  });

  test("job detail surfaces the failed pod exit code + terminated reason through the real adapter", async () => {
    const spawner: Spawner = {
      async run(cmd) {
        const out = cmd.includes("pods")
          ? JSON.stringify({
              items: [
                {
                  status: {
                    containerStatuses: [
                      { state: { terminated: { exitCode: 137, reason: "OOMKilled" } } },
                    ],
                  },
                },
              ],
            })
          : JSON.stringify({ status: { failed: 1 } });
        return { exitCode: 0, stdout: out, stderr: "" };
      },
    };
    const backend = new LocalBackend(new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" }));
    const detail = await backend.getJobDetail("kq-1");
    expect(detail.status).toBe("failed");
    expect(detail.exitCode).toBe(137);
    expect(detail.message).toContain("OOMKilled");
  });
});
