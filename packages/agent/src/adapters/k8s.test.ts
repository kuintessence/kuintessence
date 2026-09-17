import { describe, expect, test } from "bun:test";
import type { Spawner } from "./base";
import { K8sAdapter } from "./k8s";

function mockSpawner(responses: Array<{ exitCode: number; stdout: string; stderr?: string }>): {
  spawner: Spawner;
  calls: string[][];
} {
  const calls: string[][] = [];
  let i = 0;
  const spawner: Spawner = {
    async run(cmd) {
      calls.push(cmd);
      const r = responses[i++];
      if (!r) throw new Error("No more mock responses");
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr ?? "" };
    },
  };
  return { spawner, calls };
}

const baseSpec = {
  jobId: "job-abc-123",
  name: "my-job",
  command: "python train.py",
  cpus: 4,
  memoryMb: 16384,
  gpus: 0,
  wallTimeSec: 3600,
  workingDir: "/workspace",
  envVars: { EPOCHS: "10", LR: "0.001" },
};

describe("K8sAdapter.listJobs", () => {
  test("parses kubectl get jobs -o json into ListedJob[] and maps phases", async () => {
    const json = JSON.stringify({
      items: [
        { metadata: { name: "kq-1" }, status: { active: 1 } },
        { metadata: { name: "kq-2" }, status: { succeeded: 1 } },
        { metadata: { name: "kq-3" }, status: { failed: 1 } },
        { metadata: { name: "kq-4" }, status: {} },
      ],
    });
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: json }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const jobs = await adapter.listJobs();
    expect(calls[0]?.[0]).toBe("kubectl");
    expect(calls[0]).toContain("kq-ns");
    expect(jobs).toEqual([
      { schedulerJobId: "kq-1", name: "kq-1", status: "running", queue: "kq-ns" },
      { schedulerJobId: "kq-2", name: "kq-2", status: "completed", queue: "kq-ns" },
      { schedulerJobId: "kq-3", name: "kq-3", status: "failed", queue: "kq-ns" },
      { schedulerJobId: "kq-4", name: "kq-4", status: "queued", queue: "kq-ns" },
    ]);
  });

  test("returns empty array when no jobs exist", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: JSON.stringify({ items: [] }) }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner });
    expect(await adapter.listJobs()).toEqual([]);
  });

  test("throws on kubectl failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "no cluster" }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner });
    expect(adapter.listJobs()).rejects.toThrow(/kubectl/);
  });
});

describe("K8sAdapter.findByKuintessenceJobId", () => {
  test("uses the Kuintessence UUID label selector in the submitted namespace", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: JSON.stringify({ items: [{ metadata: { name: "kq-job-123" } }] }) },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "default" });

    await expect(
      adapter.findByKuintessenceJobId({ jobId: "job-123", namespace: "mapped-ns" }),
    ).resolves.toEqual({ status: "found", schedulerJobId: "kq-job-123" });
    expect(calls[0]).toEqual([
      "kubectl",
      "get",
      "jobs",
      "-n",
      "mapped-ns",
      "-l",
      "kuintessence.io/job-id=job-123",
      "-o",
      "json",
    ]);
  });
});

describe("K8sAdapter.getJobLogs", () => {
  test("tails pod logs for the job", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "epoch 1\nepoch 2\n" }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const text = await adapter.getJobLogs("kq-1", 100);
    expect(calls[0]?.[0]).toBe("kubectl");
    expect(calls[0]).toContain("job/kq-1");
    expect(calls[0]).toContain("--tail=100");
    expect(text).toBe("epoch 1\nepoch 2\n");
  });

  test("throws on kubectl logs failure", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "not found" }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner });
    expect(adapter.getJobLogs("kq-x", 50)).rejects.toThrow(/kubectl/);
  });
});

describe("K8sAdapter.buildJobManifest", () => {
  const adapter = new K8sAdapter("v1.28.0", { namespace: "kq-ns", tmpDir: "/tmp" });

  test("produces a valid batch/v1 Job manifest", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    expect(manifest.apiVersion).toBe("batch/v1");
    expect(manifest.kind).toBe("Job");
  });

  test("job name is DNS-safe lowercase", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    const meta = manifest.metadata as { name: string };
    expect(meta.name).toBe("kq-job-abc-123");
    expect(meta.name).toMatch(/^[a-z0-9-]+$/);
  });

  test("namespace matches adapter namespace", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    const meta = manifest.metadata as { namespace: string };
    expect(meta.namespace).toBe("kq-ns");
  });

  test("queueName overrides namespace and QoS becomes a label", () => {
    const manifest = adapter.buildJobManifest({ ...baseSpec, queueName: "gpu-ns", qos: "normal" });
    const meta = manifest.metadata as { namespace: string; labels: Record<string, string> };
    expect(meta.namespace).toBe("gpu-ns");
    expect(meta.labels["kuintessence.io/qos"]).toBe("normal");
  });

  test("kuintessence labels are set", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    const meta = manifest.metadata as { labels: Record<string, string> };
    expect(meta.labels["kuintessence.io/job-id"]).toBe("job-abc-123");
    expect(meta.labels["kuintessence.io/job-name"]).toBe("my-job");
  });

  test("backoffLimit is 0 and restartPolicy is Never", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    const spec = manifest.spec as {
      backoffLimit: number;
      template: { spec: { restartPolicy: string } };
    };
    expect(spec.backoffLimit).toBe(0);
    expect(spec.template.spec.restartPolicy).toBe("Never");
  });

  test("activeDeadlineSeconds is set when wallTimeSec > 0", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    const spec = manifest.spec as { activeDeadlineSeconds?: number };
    expect(spec.activeDeadlineSeconds).toBe(3600);
  });

  test("activeDeadlineSeconds is absent when wallTimeSec = 0", () => {
    const manifest = adapter.buildJobManifest({ ...baseSpec, wallTimeSec: 0 });
    const spec = manifest.spec as { activeDeadlineSeconds?: number };
    expect(spec.activeDeadlineSeconds).toBeUndefined();
  });

  test("resource limits include cpu and memory", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    const spec = manifest.spec as {
      template: {
        spec: {
          containers: Array<{ resources: { limits: Record<string, string> } }>;
        };
      };
    };
    const limits = spec.template.spec.containers[0]?.resources.limits;
    expect(limits?.cpu).toBe("4");
    expect(limits?.memory).toBe("16384Mi");
  });

  test("GPU limit added when gpus > 0", () => {
    const manifest = adapter.buildJobManifest({ ...baseSpec, gpus: 2 });
    const spec = manifest.spec as {
      template: {
        spec: {
          containers: Array<{ resources: { limits: Record<string, string> } }>;
        };
      };
    };
    const limits = spec.template.spec.containers[0]?.resources.limits;
    expect(limits?.["nvidia.com/gpu"]).toBe("2");
  });

  test("no GPU limit when gpus = 0", () => {
    const manifest = adapter.buildJobManifest({ ...baseSpec, gpus: 0 });
    const spec = manifest.spec as {
      template: {
        spec: {
          containers: Array<{ resources: { limits: Record<string, string> } }>;
        };
      };
    };
    const limits = spec.template.spec.containers[0]?.resources.limits;
    expect(limits?.["nvidia.com/gpu"]).toBeUndefined();
  });

  test("env vars are mapped to name/value pairs", () => {
    const manifest = adapter.buildJobManifest(baseSpec);
    const spec = manifest.spec as {
      template: {
        spec: {
          containers: Array<{ env?: Array<{ name: string; value: string }> }>;
        };
      };
    };
    const env = spec.template.spec.containers[0]?.env ?? [];
    expect(env).toContainEqual({ name: "EPOCHS", value: "10" });
    expect(env).toContainEqual({ name: "LR", value: "0.001" });
  });

  test("feeds stdinText to the container command through a quoted here-doc", () => {
    const manifest = adapter.buildJobManifest({
      ...baseSpec,
      jobId: "job-stdin-1",
      command: "awk '{s+=$1} END {print s}'",
      stdinText: "1\n2 with spaces\n3's\n",
    });
    const container = (
      manifest.spec as {
        template: { spec: { containers: Array<{ command: string[] }> } };
      }
    ).template.spec.containers[0];
    const command = container?.command[2] ?? "";
    expect(command).toContain("cat > '.kq-stdin-job-stdin-1' <<'__KQ_STDIN_job_stdin_1__'");
    expect(command).toContain("2 with spaces");
    expect(command).toContain("3's");
    expect(command).toContain(
      "sh -c 'awk '\\''{s+=$1} END {print s}'\\''' < '.kq-stdin-job-stdin-1'",
    );
  });
});

describe("K8sAdapter.submit (with mock spawner)", () => {
  test("calls kubectl apply and returns sanitised job name", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: "job.batch/kq-job-abc-123 created\n" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns", tmpDir: "/tmp" });
    const result = await adapter.submit(baseSpec);
    expect(result.schedulerJobId).toBe("kq-job-abc-123");
    expect(calls[0]?.[0]).toBe("kubectl");
    expect(calls[0]).toContain("apply");
  });

  test("uses queueName as kubectl namespace when provided", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: "job.batch/kq-job-abc-123 created\n" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns", tmpDir: "/tmp" });
    await adapter.submit({ ...baseSpec, queueName: "gpu-ns" });
    expect(calls[0]).toContain("-n");
    expect(calls[0]).toContain("gpu-ns");
  });

  test("throws on kubectl apply failure", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 1, stdout: "", stderr: 'namespaces "kq-ns" not found' },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns", tmpDir: "/tmp" });
    await expect(adapter.submit(baseSpec)).rejects.toThrow(/kubectl apply failed/);
  });
});

describe("K8sAdapter.cancel", () => {
  test("calls kubectl delete job with --ignore-not-found", async () => {
    const { spawner, calls } = mockSpawner([{ exitCode: 0, stdout: "" }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    await adapter.cancel("kq-job-abc-123");
    expect(calls[0]).toContain("delete");
    expect(calls[0]).toContain("kq-job-abc-123");
    expect(calls[0]).toContain("--ignore-not-found");
  });

  test("throws when kubectl cannot confirm cancellation", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "not found" }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    await expect(adapter.cancel("kq-job-abc-123")).rejects.toThrow(/kubectl delete failed/);
  });
});

describe("K8sAdapter.status", () => {
  function makeJobStatus(active?: number, succeeded?: number, failed?: number): string {
    return JSON.stringify({
      status: {
        ...(active !== undefined ? { active } : {}),
        ...(succeeded !== undefined ? { succeeded } : {}),
        ...(failed !== undefined ? { failed } : {}),
      },
    });
  }

  test("active > 0 -> running", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeJobStatus(1, 0, 0) }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("running");
  });

  test("uses the mapped namespace restored from a persisted Sandbox job", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus(1, 0, 0) },
      { exitCode: 0, stdout: JSON.stringify({ items: [] }) },
      { exitCode: 0, stdout: "worker-node-3" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "default-ns" });
    adapter.prepareResume(
      {
        ...baseSpec,
        queueName: "mapped-ns",
      },
      "kq-job-abc-123",
    );
    await adapter.status("kq-job-abc-123");
    expect(calls.every((call) => call.includes("mapped-ns"))).toBe(true);
    adapter.releaseJob("kq-job-abc-123");
  });

  test("attaches the pod's node when the job is running", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus(1, 0, 0) },
      { exitCode: 0, stdout: JSON.stringify({ items: [] }) },
      { exitCode: 0, stdout: "worker-node-3" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("running");
    expect(r.node).toBe("worker-node-3");
    expect(calls[1]?.join(" ")).toContain("job-name=kq-job-abc-123");
  });

  test("attaches the pod's node and RFC3339 start time when running", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus(1, 0, 0) },
      { exitCode: 0, stdout: JSON.stringify({ items: [] }) },
      { exitCode: 0, stdout: "worker-node-3\t2024-07-15T14:23:45Z" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.node).toBe("worker-node-3");
    expect(r.startedAt).toBe("2024-07-15T14:23:45Z");
  });

  test("tolerates a pod with a node but no start time yet", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus(1, 0, 0) },
      { exitCode: 0, stdout: JSON.stringify({ items: [] }) },
      { exitCode: 0, stdout: "worker-node-3\t" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.node).toBe("worker-node-3");
    expect(r.startedAt).toBeUndefined();
  });

  test("active job with FailedCreatePodSandBox event -> failed", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus(1, 0, 0) },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            {
              metadata: { uid: "pod-uid-1" },
              status: {
                containerStatuses: [{ state: { waiting: { reason: "ContainerCreating" } } }],
              },
            },
          ],
        }),
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            {
              reason: "FailedCreatePodSandBox",
              message:
                "failed to generate sandbox container spec options: failed to generate seccomp spec opts: seccomp is not supported",
            },
          ],
        }),
      },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("FailedCreatePodSandBox");
    expect(r.message).toContain("seccomp is not supported");
    expect(calls[1]?.join(" ")).toContain("job-name=kq-job-abc-123");
    expect(calls[2]?.join(" ")).toContain("involvedObject.uid=pod-uid-1");
  });

  function podJson(opts: { scheduledReason?: string; waitingReason?: string }): string {
    return JSON.stringify({
      items: [
        {
          status: {
            conditions: opts.scheduledReason
              ? [{ type: "PodScheduled", status: "False", reason: opts.scheduledReason }]
              : [],
            containerStatuses: opts.waitingReason
              ? [{ state: { waiting: { reason: opts.waitingReason } } }]
              : [],
          },
        },
      ],
    });
  }

  test("surfaces the unschedulable reason for a queued (pending) job", async () => {
    const { spawner, calls } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus() },
      { exitCode: 0, stdout: podJson({ scheduledReason: "Unschedulable" }) },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("queued");
    expect(r.reason).toBe("Unschedulable");
    expect(r.node).toBeUndefined();
    expect(calls[1]?.join(" ")).toContain("job-name=kq-job-abc-123");
  });

  test("prefers a container waiting reason (ImagePullBackOff) over scheduling", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus() },
      {
        exitCode: 0,
        stdout: podJson({ scheduledReason: "Unschedulable", waitingReason: "ImagePullBackOff" }),
      },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.reason).toBe("ImagePullBackOff");
  });

  test("queued with no discernible reason leaves reason undefined", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus() },
      { exitCode: 0, stdout: podJson({}) },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("queued");
    expect(r.reason).toBeUndefined();
  });

  test("a failed pod-reason query degrades gracefully (status still queued)", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus() },
      { exitCode: 1, stdout: "", stderr: "boom" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("queued");
    expect(r.reason).toBeUndefined();
  });

  test("succeeded > 0 -> completed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeJobStatus(0, 1, 0) }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("completed");
    expect(r.exitCode).toBe(0);
  });

  test("failed > 0 -> failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeJobStatus(0, 0, 1) }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("failed");
  });

  function terminatedPodJson(exitCode: number, reason?: string): string {
    return JSON.stringify({
      items: [
        {
          status: {
            containerStatuses: [
              { state: { terminated: { exitCode, ...(reason ? { reason } : {}) } } },
            ],
          },
        },
      ],
    });
  }

  test("failed job surfaces the container exit code + terminated reason", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus(0, 0, 1) },
      { exitCode: 0, stdout: terminatedPodJson(137, "OOMKilled") },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBe(137);
    expect(r.message).toContain("OOMKilled");
  });

  test("failed job without pod detail keeps a generic message and no exit code", async () => {
    const { spawner } = mockSpawner([
      { exitCode: 0, stdout: makeJobStatus(0, 0, 1) },
      { exitCode: 1, stdout: "", stderr: "boom" },
    ]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("failed");
    expect(r.exitCode).toBeUndefined();
    expect(r.message).toBe("Job failed in K8s");
  });

  test("no active/succeeded/failed -> queued", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: makeJobStatus() }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("queued");
  });

  test("kubectl get returns non-zero exit -> failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 1, stdout: "", stderr: "not found" }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("failed");
  });

  test("kubectl returns non-JSON -> failed", async () => {
    const { spawner } = mockSpawner([{ exitCode: 0, stdout: "Error from server" }]);
    const adapter = new K8sAdapter("v1.28.0", { spawner, namespace: "kq-ns" });
    const r = await adapter.status("kq-job-abc-123");
    expect(r.status).toBe("failed");
    expect(r.message).toContain("non-JSON");
  });
});

describe("K8sAdapter.inspectComputeHealth", () => {
  test("reports a Ready uncordoned node as ready", async () => {
    const { spawner, calls } = mockSpawner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          items: [
            {
              metadata: { name: "k3s-1" },
              spec: { taints: [] },
              status: { conditions: [{ type: "Ready", status: "True" }] },
            },
            {
              metadata: { name: "k3s-2" },
              spec: {},
              status: { conditions: [{ type: "Ready", status: "True" }] },
            },
          ],
        }),
      },
    ]);
    const adapter = new K8sAdapter("v1.31.0", { spawner });

    await expect(adapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "ready",
      nodeCount: 2,
      operationalNodeCount: 2,
    });
    expect(calls[0]).toEqual(["kubectl", "get", "nodes", "-o", "json"]);
  });

  test("excludes unready, cordoned, and NoSchedule nodes from operational capacity", async () => {
    const adapter = new K8sAdapter("v1.31.0", {
      spawner: mockSpawner([
        {
          exitCode: 0,
          stdout: JSON.stringify({
            items: [
              {
                metadata: { name: "k3s-unready" },
                spec: {},
                status: { conditions: [{ type: "Ready", status: "False" }] },
              },
              {
                metadata: { name: "k3s-cordoned" },
                spec: { unschedulable: true },
                status: { conditions: [{ type: "Ready", status: "True" }] },
              },
              {
                metadata: { name: "k3s-tainted" },
                spec: { taints: [{ key: "maintenance", effect: "NoSchedule" }] },
                status: { conditions: [{ type: "Ready", status: "True" }] },
              },
            ],
          }),
        },
      ]).spawner,
    });

    await expect(adapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unavailable",
      nodeCount: 3,
      operationalNodeCount: 0,
      reason: "no_operational_nodes",
    });
  });

  test("maps command and JSON parse failures to unknown", async () => {
    const commandAdapter = new K8sAdapter("v1.31.0", {
      spawner: mockSpawner([{ exitCode: 1, stdout: "", stderr: "connection refused" }]).spawner,
    });
    await expect(commandAdapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unknown",
      reason: "scheduler_command_failed",
    });

    const invalidAdapter = new K8sAdapter("v1.31.0", {
      spawner: mockSpawner([{ exitCode: 0, stdout: "not json" }]).spawner,
    });
    await expect(invalidAdapter.inspectComputeHealth()).resolves.toMatchObject({
      state: "unknown",
      reason: "invalid_scheduler_state",
    });
  });
});
