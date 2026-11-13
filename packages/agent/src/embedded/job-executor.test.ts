import { describe, expect, test } from "bun:test";
import {
  type JobSpec,
  type JobStatusResult,
  type SandboxJobSpec,
  type SchedulerAdapter,
  SchedulerSubmissionError,
  SchedulerSubmissionUnknownError,
} from "../adapters/base";
import { createOutputCollector, type OutputReader } from "../output-collector";
import { JobRunner, type JobStatusReport } from "./job-executor";

function makeAdapter(opts: {
  submit?: () => Promise<{ schedulerJobId: string }>;
  statuses?: JobStatusResult[];
  getJobLogs?: SchedulerAdapter["getJobLogs"];
  stageSandboxInputs?: SchedulerAdapter["stageSandboxInputs"];
  validateQueueTarget?: SchedulerAdapter["validateQueueTarget"];
}): SchedulerAdapter {
  let i = 0;
  return {
    type: "mock",
    version: "0.0",
    submit: opts.submit ?? (async () => ({ schedulerJobId: "scheduler-1" })),
    cancel: async () => {},
    confirmStopped: async () => true,
    status: async () => {
      const s = opts.statuses?.[i++] ?? { status: "completed" };
      return s;
    },
    ...(opts.getJobLogs ? { getJobLogs: opts.getJobLogs } : {}),
    ...(opts.stageSandboxInputs ? { stageSandboxInputs: opts.stageSandboxInputs } : {}),
    ...(opts.validateQueueTarget ? { validateQueueTarget: opts.validateQueueTarget } : {}),
  };
}

const baseSpec: JobSpec = {
  jobId: "job-1",
  name: "test",
  command: "echo hi",
  cpus: 1,
  memoryMb: 1024,
  gpus: 0,
  wallTimeSec: 60,
  workingDir: "",
  envVars: {},
};

const noSleep = async (_ms: number) => {};

test("completed job retains durable output recovery across a shared disk fault and Agent restart", async () => {
  const { createSqliteDb } = await import("@kuintessence/db");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { ActiveRemoteJobs } = await import("../queue/active-remote-jobs");
  const directory = await mkdtemp("/tmp/kq-output-recovery-");
  let db = createSqliteDb(`${directory}/agent.db`);
  try {
    let store = new ActiveRemoteJobs(db);
    let submissions = 0;
    let releases = 0;
    const reports: JobStatusReport[] = [];
    const adapter = makeAdapter({
      submit: async () => {
        submissions++;
        return { schedulerJobId: "original-123" };
      },
    });
    adapter.releaseJob = async () => {
      releases++;
    };
    const outputs = [{ descriptor: "result", path: "result.json", isBatch: false }];
    const read: OutputReader = async () => "42";
    let first: JobRunner;
    read.readValidated = async () => {
      first.cancel();
      throw Object.assign(new Error("shared disk unavailable"), { code: "EIO" });
    };
    first = new JobRunner({
      adapter,
      sleep: noSleep,
      collectOutputs: createOutputCollector(read),
      onSchedulerSubmitted: (spec, schedulerJobId, expectedOutputs) =>
        store.recordSubmitted({ spec, schedulerJobId, expectedOutputs }),
      onJobFinished: (jobId) => store.markFinished(jobId),
      onStatusUpdate: (report) => {
        reports.push(report);
      },
    });
    await first.run({ ...baseSpec, workingDir: "/shared/work" }, outputs);
    expect(reports.map((report) => report.status)).toEqual(["queued"]);
    expect(releases).toBe(0);
    db.$client.close();
    db = createSqliteDb(`${directory}/agent.db`);
    store = new ActiveRemoteJobs(db);
    const [recovered] = await store.listActive();
    if (!recovered) throw new Error("output recovery record must survive restart");
    expect(recovered.schedulerJobId).toBe("original-123");
    read.readValidated = async () => "42";
    await new JobRunner({
      adapter,
      sleep: noSleep,
      collectOutputs: createOutputCollector(read),
      onJobFinished: (jobId) => store.markFinished(jobId),
      onStatusUpdate: (report) => {
        reports.push(report);
      },
    }).resume(recovered.spec, recovered.schedulerJobId, recovered.expectedOutputs);
    expect(reports.at(-1)).toMatchObject({
      status: "completed",
      schedulerJobId: "original-123",
      collected: { result: "42" },
    });
    expect(await store.listActive()).toEqual([]);
    expect(submissions).toBe(1);
    expect(releases).toBe(1);
  } finally {
    db.$client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("transient stdout I/O is retried before publishing a completed report", async () => {
  const reports: JobStatusReport[] = [];
  let reads = 0;
  const runner = new JobRunner({
    adapter: makeAdapter({
      getJobLogs: async () => {
        if (++reads === 1) throw Object.assign(new Error("stale log handle"), { code: "ESTALE" });
        return "result=42";
      },
    }),
    sleep: noSleep,
    onStatusUpdate: (report) => {
      reports.push(report);
    },
  });
  await runner.run(baseSpec);
  expect(reports.map((report) => report.status)).toEqual(["queued", "completed"]);
  expect(reports.at(-1)?.collected).toEqual({ stdout: "result=42" });
  expect(reads).toBe(2);
});

const kubernetesSandbox: SandboxJobSpec = {
  language: "python",
  entrypoint: "main.py",
  scriptContent: "print('ok')",
  scriptHostPath: "",
  contextHostPath: "",
  runtimeKind: "OCI",
  runtimePath: `registry.example/runtime@sha256:${"a".repeat(64)}`,
  executionMode: "RootImpersonation",
  identity: {
    mode: "MappedAccount",
    backend: "Kubernetes",
    accountId: "00000000-0000-0000-0000-000000000001",
    namespace: "kq-user",
    serviceAccount: "user",
  },
  mounts: [],
  resources: { cpus: 1, memoryMb: 1024 },
  limits: { pids: 16, outputBytes: 1_000, logBytes: 1_000 },
  kubernetesArtifactPvc: "artifacts",
};

test("Sandbox keeps its existing optional output read and stdout failure behavior", async () => {
  const failure = Object.assign(new Error("shared disk unavailable"), { code: "EIO" });
  const read: OutputReader = async () => {
    throw failure;
  };
  read.readValidated = read;
  const reports: JobStatusReport[] = [];
  const runner = new JobRunner({
    adapter: makeAdapter({
      stageSandboxInputs: async () => {},
      getJobLogs: async () => {
        throw failure;
      },
    }),
    sleep: noSleep,
    collectOutputs: createOutputCollector(read),
    validateSandboxOutputs: async () => ({ validated: "yes" }),
    onStatusUpdate: (report) => {
      reports.push(report);
    },
  });
  await runner.run({ ...baseSpec, sandbox: kubernetesSandbox }, [
    { descriptor: "optional", path: "optional.txt", isBatch: false },
  ]);
  expect(reports.map((report) => report.status)).toEqual(["queued", "completed"]);
  expect(reports.at(-1)?.collected).toEqual({ validated: "yes" });
});

describe("JobRunner", () => {
  test("enforces a fresh queue rejection before scheduler submission", async () => {
    const reports: JobStatusReport[] = [];
    let submitted = false;
    const runner = new JobRunner({
      adapter: makeAdapter({
        submit: async () => {
          submitted = true;
          return { schedulerJobId: "scheduler-1" };
        },
        validateQueueTarget: async () => ({
          accepted: false,
          failureCode: "QUEUE_NOT_ACCEPTING",
        }),
      }),
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      sleep: noSleep,
    });

    await runner.run({
      ...baseSpec,
      queueName: "drained",
      queueTargetMode: "named",
      queueValidationMode: "enforce",
    });

    expect(submitted).toBe(false);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      status: "failed",
      failureCode: "QUEUE_NOT_ACCEPTING",
    });
  });
  test("keeps legacy and shadow submissions compatible", async () => {
    const reports: JobStatusReport[] = [];
    const shadowRejections: string[] = [];
    let validationCalls = 0;
    const runner = new JobRunner({
      adapter: makeAdapter({
        validateQueueTarget: async () => {
          validationCalls += 1;
          return { accepted: false, failureCode: "QUEUE_NOT_FOUND" };
        },
        statuses: [{ status: "completed", exitCode: 0 }],
      }),
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      onQueueValidationShadowRejection: (failureCode) => {
        shadowRejections.push(failureCode);
      },
      sleep: noSleep,
    });

    await runner.run({ ...baseSpec, queueName: "legacy" });
    await runner.run({
      ...baseSpec,
      jobId: "shadow-job",
      queueName: "legacy",
      queueTargetMode: "named",
      queueValidationMode: "shadow",
    });

    expect(validationCalls).toBe(1);
    expect(shadowRejections).toEqual(["QUEUE_NOT_FOUND"]);
    expect(reports.filter((report) => report.status === "completed")).toHaveLength(2);
  });
  test("reports scheduler submission failures with a structured failure code", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        submit: async () => {
          throw new SchedulerSubmissionError("qsub failed");
        },
      }),
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      sleep: noSleep,
    });

    await runner.run(baseSpec);

    expect(reports).toEqual([
      expect.objectContaining({
        status: "failed",
        failureCode: "SCHEDULER_SUBMIT_FAILED",
      }),
    ]);
  });
  test("unknown submission preserves the intent and does not emit a false terminal status", async () => {
    const events: string[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        submit: async () => {
          events.push("sbatch-accepted");
          throw new SchedulerSubmissionUnknownError();
        },
      }),
      onSchedulerSubmitting: () => {
        events.push("persist-intent");
      },
      onStatusUpdate: (report) => {
        events.push(report.status);
      },
      onJobFinished: () => {
        events.push("delete-intent");
      },
      sleep: noSleep,
    });
    expect(await runner.run(baseSpec)).toBeNull();
    await runner.cancelAndKill();
    await expect(runner.waitForPendingCancellation()).rejects.toThrow("outcome is unknown");
    expect(events).toEqual(["persist-intent", "sbatch-accepted"]);
  });
  test("queued status delivery failure cannot erase an already submitted job", async () => {
    const events: string[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({}),
      onSchedulerSubmitted: () => {
        events.push("persist-id");
      },
      onStatusUpdate: (report) => {
        events.push(report.status);
        if (report.status === "queued") throw new Error("outbox temporarily unavailable");
      },
      onJobFinished: () => {
        events.push("delete-record");
      },
      sleep: noSleep,
    });
    expect(await runner.run(baseSpec)).toBe("scheduler-1");
    expect(events).toEqual(["persist-id", "queued", "completed", "delete-record"]);
  });
  test("suppresses logs and output collection for restricted no-egress jobs", async () => {
    const reports: JobStatusReport[] = [];
    let logReads = 0;
    let outputCollections = 0;
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [{ status: "completed", exitCode: 0 }],
        getJobLogs: async () => {
          logReads += 1;
          return "secret";
        },
      }),
      collectOutputs: async () => {
        outputCollections += 1;
        return { artifact: "secret" };
      },
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      sleep: noSleep,
    });

    await runner.run({ ...baseSpec, restrictedNoEgress: true }, [
      { descriptor: "artifact", path: "result.dat", isBatch: false },
    ]);

    expect(logReads).toBe(0);
    expect(outputCollections).toBe(0);
    expect(reports.at(-1)?.collected).toBeUndefined();
  });
  test("submits and emits queued + completed status", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [{ status: "running" }, { status: "completed", exitCode: 0 }],
      }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    const id = await runner.run(baseSpec);
    expect(id).toBe("scheduler-1");
    expect(reports.map((r) => r.status)).toEqual(["queued", "running", "completed"]);
    expect(reports[2]?.exitCode).toBe(0);
  });
  test("awaits terminal status durability before scheduler release and cleanup", async () => {
    let terminalStarted: (() => void) | undefined;
    const terminalObserved = new Promise<void>((resolve) => {
      terminalStarted = resolve;
    });
    let finishPersist: (() => void) | undefined;
    const persisted = new Promise<void>((resolve) => {
      finishPersist = resolve;
    });
    const events: string[] = [];
    const adapter = makeAdapter({ statuses: [{ status: "completed", exitCode: 0 }] });
    adapter.releaseJob = async () => {
      events.push("release");
    };
    const runner = new JobRunner({
      adapter,
      onStatusUpdate: async (report) => {
        if (report.status !== "completed") return;
        events.push("persist-start");
        terminalStarted?.();
        await persisted;
        events.push("persist-done");
      },
      onJobFinished: () => {
        events.push("finished");
      },
      sleep: noSleep,
    });

    const runPromise = runner.run(baseSpec);
    await terminalObserved;
    expect(events).toEqual(["persist-start"]);
    finishPersist?.();
    await runPromise;

    expect(events).toEqual(["persist-start", "persist-done", "finished", "release"]);
  });
  test("does not release or finish a job when terminal durability fails", async () => {
    const events: string[] = [];
    const adapter = makeAdapter({ statuses: [{ status: "completed", exitCode: 0 }] });
    adapter.releaseJob = async () => {
      events.push("release");
    };
    const runner = new JobRunner({
      adapter,
      onStatusUpdate: async (report) => {
        if (report.status === "completed") throw new Error("SQLite unavailable");
      },
      onJobFinished: () => {
        events.push("finished");
      },
      sleep: noSleep,
    });

    await expect(runner.run(baseSpec)).rejects.toThrow("SQLite unavailable");
    expect(events).toEqual([]);
  });
  test("stages Kubernetes Sandbox inputs before scheduler submit", async () => {
    const order: string[] = [];
    let ensureWorkingDirCalls = 0;
    const adapter = makeAdapter({
      stageSandboxInputs: async (_sandbox, jobId) => {
        order.push(`stage:${jobId}`);
      },
      submit: async () => {
        order.push("submit");
        return { schedulerJobId: "scheduler-1" };
      },
      statuses: [{ status: "completed" }],
    });
    const runner = new JobRunner({
      adapter,
      validateSandboxOutputs: async () => ({}),
      ensureWorkingDir: async () => {
        ensureWorkingDirCalls += 1;
        throw new Error("Kubernetes Sandbox workingDir belongs to the Pod");
      },
      onSchedulerSubmitting: async () => {
        order.push("before-submit");
      },
      onStatusUpdate: () => undefined,
      sleep: noSleep,
    });
    await runner.run({ ...baseSpec, workingDir: "/kq", sandbox: kubernetesSandbox });
    expect(ensureWorkingDirCalls).toBe(0);
    expect(order).toEqual(["stage:job-1", "before-submit", "submit"]);
  });
  test("keeps host working directory preparation for SIF Sandbox jobs", async () => {
    const workingDirs: string[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({ statuses: [{ status: "completed" }] }),
      validateSandboxOutputs: async () => ({}),
      ensureWorkingDir: async (workingDir) => {
        workingDirs.push(workingDir);
      },
      onStatusUpdate: () => undefined,
      sleep: noSleep,
    });
    const sifSandbox: SandboxJobSpec = {
      ...kubernetesSandbox,
      runtimeKind: "SIF",
      runtimePath: "/runtime/bash.sif",
      executionMode: "SelfAccount",
      identity: {
        mode: "MappedAccount",
        backend: "Unix",
        accountId: "00000000-0000-0000-0000-000000000001",
        username: "kqagent",
        uid: 2001,
        gid: 2001,
        allowedQueues: [],
      },
    };

    await runner.run({ ...baseSpec, workingDir: "/work/job-1", sandbox: sifSandbox });
    expect(workingDirs).toEqual(["/work/job-1"]);
  });
  test("forwards the scheduler-reported node + pending reason on status transitions", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [
          { status: "running", node: "node[001-004]", reason: "None" },
          { status: "completed", exitCode: 0 },
        ],
      }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    const running = reports.find((r) => r.status === "running");
    expect(running?.node).toBe("node[001-004]");
    expect(running?.reason).toBe("None");
  });
  test("re-emits when the pending reason changes while the status stays queued", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [
          { status: "queued", reason: "Priority" },
          { status: "queued", reason: "Resources" },
          { status: "completed", exitCode: 0 },
        ],
      }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    // "why isn't it running" changes without a status transition — both reasons
    // must reach the Server, not just the first.
    const queuedReasons = reports.filter((r) => r.status === "queued").map((r) => r.reason);
    expect(queuedReasons).toContain("Priority");
    expect(queuedReasons).toContain("Resources");
  });
  test("emits failed status when submit throws", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        submit: async () => {
          throw new Error("sbatch boom");
        },
      }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    const id = await runner.run(baseSpec);
    expect(id).toBeNull();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.status).toBe("failed");
    expect(reports[0]?.message).toContain("sbatch boom");
  });
  test("only emits when status changes", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [
          { status: "queued" },
          { status: "queued" },
          { status: "running" },
          { status: "running" },
          { status: "completed" },
        ],
      }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    // Initial submit emits "queued" once. Poll loop sees:
    // queued (no change), queued (no change), running (change),
    // running (no change), completed (change, terminal).
    expect(reports.map((r) => r.status)).toEqual(["queued", "running", "completed"]);
  });
  test("retries on status poll error and continues", async () => {
    let i = 0;
    const adapter: SchedulerAdapter = {
      type: "mock",
      version: "0",
      submit: async () => ({ schedulerJobId: "x" }),
      cancel: async () => {},
      confirmStopped: async () => true,
      status: async () => {
        if (i++ === 0) throw new Error("transient");
        return { status: "completed", exitCode: 0 };
      },
    };
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter,
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    expect(reports.map((r) => r.status)).toEqual(["queued", "completed"]);
  });
  test("collects expected outputs on completion and attaches them to the terminal report", async () => {
    const reports: JobStatusReport[] = [];
    let collectArgs: { outputs: unknown; workingDir: string } | undefined;
    const runner = new JobRunner({
      adapter: makeAdapter({ statuses: [{ status: "running" }, { status: "completed" }] }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      collectOutputs: async (outputs, workingDir) => {
        collectArgs = { outputs, workingDir };
        return { log: "residual = 0.003" };
      },
      sleep: noSleep,
    });
    await runner.run({ ...baseSpec, workingDir: "/work" }, [
      { descriptor: "log", path: "residual.log", isBatch: false },
    ]);
    const terminal = reports.find((r) => r.status === "completed");
    expect(terminal?.collected).toEqual({ log: "residual = 0.003" });
    expect(collectArgs?.workingDir).toBe("/work");
    // Non-terminal reports carry no collected outputs.
    expect(reports.find((r) => r.status === "running")?.collected).toBeUndefined();
  });
  test("reports failed when terminal output collection throws", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({ statuses: [{ status: "completed", exitCode: 0 }] }),
      collectOutputs: async () => {
        throw new Error("collector unavailable");
      },
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run({ ...baseSpec, workingDir: "/work" }, [
      { descriptor: "log", path: "residual.log", isBatch: false },
    ]);
    const terminal = reports.at(-1);
    expect(reports.map((r) => r.status)).toEqual(["queued", "failed"]);
    expect(terminal?.message).toContain("collector unavailable");
    expect(terminal?.collected).toBeUndefined();
  });
  test("captures scheduler stdout on completion", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [{ status: "completed" }],
        getJobLogs: async (schedulerJobId, lines, jobId) => {
          expect(jobId).toBe(baseSpec.jobId);
          return `id=${schedulerJobId} lines=${lines}\n`;
        },
      }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    expect(reports.find((r) => r.status === "completed")?.collected?.stdout).toBe(
      "id=scheduler-1 lines=200\n",
    );
  });
  test("does not clobber a collected file output named stdout", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [{ status: "completed" }],
        getJobLogs: async () => "from scheduler",
      }),
      collectOutputs: async () => ({ stdout: "from file" }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec, [{ descriptor: "stdout", path: "stdout.txt", isBatch: false }]);
    expect(reports.find((r) => r.status === "completed")?.collected?.stdout).toBe("from file");
  });
  test("omits stdout when the adapter has no getJobLogs", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({ statuses: [{ status: "completed" }] }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    expect(reports.find((r) => r.status === "completed")?.collected?.stdout).toBeUndefined();
  });
  test("omits stdout when getJobLogs throws without failing the job", async () => {
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        statuses: [{ status: "completed" }],
        getJobLogs: async () => {
          throw new Error("log unavailable");
        },
      }),
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    const terminal = reports.find((r) => r.status === "completed");
    expect(terminal?.status).toBe("completed");
    expect(terminal?.collected?.stdout).toBeUndefined();
  });
  test("ensures the working directory exists before submitting", async () => {
    const calls: string[] = [];
    const runner = new JobRunner({
      adapter: {
        type: "mock",
        version: "0",
        submit: async () => {
          calls.push("submit");
          return { schedulerJobId: "x" };
        },
        cancel: async () => {},
        confirmStopped: async () => true,
        status: async () => ({ status: "completed" }),
      },
      ensureWorkingDir: async (p) => {
        calls.push(`mkdir:${p}`);
      },
      onStatusUpdate: () => {},
      sleep: noSleep,
    });
    await runner.run({ ...baseSpec, workingDir: "/runs/job-1" });
    expect(calls).toEqual(["mkdir:/runs/job-1", "submit"]);
  });
  test("a failure to create the working directory fails the job without submitting", async () => {
    const calls: string[] = [];
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: makeAdapter({
        submit: async () => {
          calls.push("submit");
          return { schedulerJobId: "x" };
        },
      }),
      ensureWorkingDir: async () => {
        throw new Error("permission denied");
      },
      onStatusUpdate: (r) => {
        reports.push(r);
      },
      sleep: noSleep,
    });
    const id = await runner.run({ ...baseSpec, workingDir: "/runs/job-1" });
    expect(id).toBeNull();
    expect(calls).not.toContain("submit");
    expect(reports.map((r) => r.status)).toEqual(["failed"]);
  });
  test("does not invoke collectOutputs when there are no expected outputs", async () => {
    let called = false;
    const runner = new JobRunner({
      adapter: makeAdapter({ statuses: [{ status: "completed" }] }),
      onStatusUpdate: () => {},
      collectOutputs: async () => {
        called = true;
        return {};
      },
      sleep: noSleep,
    });
    await runner.run(baseSpec);
    expect(called).toBe(false);
  });
  test("cancel stops polling", async () => {
    let polls = 0;
    const adapter: SchedulerAdapter = {
      type: "mock",
      version: "0",
      submit: async () => ({ schedulerJobId: "x" }),
      cancel: async () => {},
      confirmStopped: async () => true,
      status: async () => {
        polls++;
        return { status: "running" };
      },
    };
    const runner = new JobRunner({
      adapter,
      onStatusUpdate: () => {},
      sleep: async () => {},
    });
    runner.cancel(); // cancel before polling begins
    await runner.run(baseSpec);
    // After submit+queued, loop body is skipped because cancelled=true
    expect(polls).toBe(0);
  });
  test("cancellation before scheduler submission emits one terminal report without side effects", async () => {
    let submitCalls = 0;
    const cancelCalls: string[] = [];
    const reports: JobStatusReport[] = [];
    let finishedCalls = 0;
    const adapter: SchedulerAdapter = {
      type: "mock",
      version: "0",
      submit: async () => {
        submitCalls += 1;
        return { schedulerJobId: "slurm-99" };
      },
      cancel: async (id) => {
        cancelCalls.push(id);
      },
      status: async () => ({ status: "running" }),
    };
    const runner = new JobRunner({
      adapter,
      onSchedulerSubmitting: async () => {
        await runner.cancelAndKill();
      },
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      onJobFinished: () => {
        finishedCalls += 1;
      },
      sleep: async () => {},
    });
    await runner.run(baseSpec);
    expect(submitCalls).toBe(0);
    expect(cancelCalls).toEqual([]);
    expect(reports).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(reports[0]?.schedulerJobId).toBeUndefined();
    expect(finishedCalls).toBe(1);
  });
  test("preparation rejection after cancellation emits only cancelled", async () => {
    let submitCalls = 0;
    let cancelCalls = 0;
    let finishedCalls = 0;
    let markValidationStarted: (() => void) | undefined;
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve;
    });
    let rejectValidation: ((reason?: unknown) => void) | undefined;
    const validation = new Promise<never>((_resolve, reject) => {
      rejectValidation = reject;
    });
    const reports: JobStatusReport[] = [];
    const adapter: SchedulerAdapter = {
      type: "mock",
      version: "0",
      submit: async () => {
        submitCalls += 1;
        return { schedulerJobId: "must-not-submit" };
      },
      cancel: async () => {
        cancelCalls += 1;
      },
      status: async () => ({ status: "running" }),
      validateQueueTarget: async () => {
        markValidationStarted?.();
        return validation;
      },
    };
    const runner = new JobRunner({
      adapter,
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      onJobFinished: () => {
        finishedCalls += 1;
      },
      sleep: noSleep,
    });

    const running = runner.run({
      ...baseSpec,
      queueName: "batch",
      queueTargetMode: "named",
      queueValidationMode: "enforce",
    });
    await validationStarted;
    await runner.cancelAndKill();
    rejectValidation?.(new Error("queue probe failed"));
    await running;

    expect(submitCalls).toBe(0);
    expect(cancelCalls).toBe(0);
    expect(reports).toEqual([expect.objectContaining({ status: "cancelled" })]);
    expect(reports[0]?.failureCode).toBeUndefined();
    expect(finishedCalls).toBe(1);
  });
  test("submission failure after cancellation preserves the scheduler failure", async () => {
    let cancelCalls = 0;
    let finishedCalls = 0;
    let markSubmissionStarted: (() => void) | undefined;
    const submissionStarted = new Promise<void>((resolve) => {
      markSubmissionStarted = resolve;
    });
    let rejectSubmission: ((reason?: unknown) => void) | undefined;
    const submission = new Promise<never>((_resolve, reject) => {
      rejectSubmission = reject;
    });
    const reports: JobStatusReport[] = [];
    const runner = new JobRunner({
      adapter: {
        type: "mock",
        version: "0",
        submit: async () => {
          markSubmissionStarted?.();
          return submission;
        },
        cancel: async () => {
          cancelCalls += 1;
        },
        status: async () => ({ status: "running" }),
      },
      onStatusUpdate: (report) => {
        reports.push(report);
      },
      onJobFinished: () => {
        finishedCalls += 1;
      },
      sleep: noSleep,
    });

    const running = runner.run(baseSpec);
    await submissionStarted;
    await runner.cancelAndKill();
    rejectSubmission?.(new SchedulerSubmissionError("sbatch failed"));
    await running;

    expect(cancelCalls).toBe(0);
    expect(reports).toEqual([
      expect.objectContaining({ status: "failed", failureCode: "SCHEDULER_SUBMIT_FAILED" }),
    ]);
    expect(finishedCalls).toBe(1);
  });
  test("cancelAndKill mid-run scancels exactly once", async () => {
    const cancelCalls: string[] = [];
    const ref: { runner?: JobRunner } = {};
    const adapter: SchedulerAdapter = {
      type: "mock",
      version: "0",
      submit: async () => ({ schedulerJobId: "slurm-99" }),
      cancel: async (id) => {
        cancelCalls.push(id);
      },
      confirmStopped: async () => true,
      status: async () => ({ status: "running" }), // never terminal
    };
    ref.runner = new JobRunner({
      adapter,
      onStatusUpdate: async (r) => {
        if (r.status === "running") await ref.runner?.cancelAndKill();
      },
      sleep: async () => {},
    });
    await ref.runner.run(baseSpec);
    expect(cancelCalls).toEqual(["slurm-99"]);
  });
  test("cancel (shutdown) stops polling without scancelling the cluster job", async () => {
    const cancelCalls: string[] = [];
    const adapter: SchedulerAdapter = {
      type: "mock",
      version: "0",
      submit: async () => ({ schedulerJobId: "slurm-99" }),
      cancel: async (id) => {
        cancelCalls.push(id);
      },
      status: async () => ({ status: "running" }),
    };
    const runner = new JobRunner({ adapter, onStatusUpdate: () => {}, sleep: async () => {} });
    runner.cancel();
    await runner.run(baseSpec);
    expect(cancelCalls).toEqual([]);
  });
});

test.each([
  "submit",
  "receipt",
] as const)("uncertain %s retains durable job inputs without publishing a failure", async (boundary) => {
  const reports: JobStatusReport[] = [];
  let cleaned = false;
  let reconciled = false;
  const runner = new JobRunner({
    adapter: makeAdapter({
      submit: async () => {
        if (boundary === "submit") throw new Error("submission response lost");
        return { schedulerJobId: "accepted" };
      },
    }),
    onSchedulerSubmitted: async () => {
      throw new Error("receipt write failed");
    },
    onSubmissionUncertain: async (spec) => {
      expect(spec.jobId).toBe(baseSpec.jobId);
      reconciled = true;
      return true;
    },
    onStatusUpdate: (report) => {
      reports.push(report);
    },
    onJobFinished: () => {
      cleaned = true;
    },
    sleep: noSleep,
  });
  await runner.run(baseSpec);
  expect(reconciled).toBe(true);
  expect(reports).toEqual([]);
  expect(cleaned).toBe(false);
});

test("a failed status query during recovery waits without releasing inputs or reporting failure", async () => {
  const reports: JobStatusReport[] = [];
  const events: string[] = [];
  let polls = 0;
  const adapter = makeAdapter({});
  adapter.status = async () => {
    polls++;
    if (polls === 1) {
      events.push("unavailable");
      throw new Error("scheduler unavailable");
    }
    return { status: "completed", exitCode: 0 };
  };
  const runner = new JobRunner({
    adapter,
    sleep: noSleep,
    onStatusUpdate: (report) => {
      reports.push(report);
      events.push(report.status);
    },
    onJobFinished: () => {
      events.push("cleanup");
    },
  });
  await runner.resume(baseSpec, "original-scheduler-job");
  expect(events).toEqual(["unavailable", "completed", "cleanup"]);
  expect(reports[0]?.schedulerJobId).toBe("original-scheduler-job");
});

test("a resumed queued job acknowledges its original scheduler id using the observed state", async () => {
  const reports: JobStatusReport[] = [];
  const runner = new JobRunner({
    adapter: makeAdapter({
      statuses: [{ status: "queued" }, { status: "completed", exitCode: 0 }],
    }),
    onStatusUpdate: (report) => {
      reports.push(report);
    },
    sleep: noSleep,
  });
  await runner.resume(baseSpec, "original");
  expect(reports.map(({ status }) => status)).toEqual(["queued", "completed"]);
  expect(reports[0]?.schedulerJobId).toBe("original");
});

test("unconfirmed cancellation retains inputs and can be retried after the scheduler stops", async () => {
  const poll = Promise.withResolvers<void>();
  const polling = Promise.withResolvers<void>();
  let stopped = false;
  let cleanups = 0;
  const adapter = makeAdapter({});
  adapter.confirmStopped = async () => stopped;
  const runner = new JobRunner({
    adapter,
    onStatusUpdate: () => {},
    onJobFinished: () => {
      cleanups++;
    },
    sleep: () => {
      polling.resolve();
      return poll.promise;
    },
  });
  const running = runner.run(baseSpec);
  await polling.promise;
  await expect(runner.cancelAndKill()).rejects.toThrow("stop is not confirmed");
  expect(cleanups).toBe(0);
  stopped = true;
  await runner.cancelAndKill();
  expect(cleanups).toBe(0);
  poll.resolve();
  await running;
  expect(cleanups).toBe(1);
});

test("runner carries scheduler UID through submission, recovery and cancellation", async () => {
  const schedulerUid = crypto.randomUUID();
  let submittedUid: string | undefined;
  let resumedUid: string | undefined;
  const cancelled: Array<string | undefined> = [];
  const adapter: SchedulerAdapter = {
    type: "kubernetes",
    version: "test",
    submit: async () => ({ schedulerJobId: "original", schedulerUid }),
    prepareResume: (_spec, _id, uid) => {
      resumedUid = uid;
    },
    status: async () => ({ status: "running" }),
    cancel: async (_id, lookup) => {
      cancelled.push(lookup?.schedulerUid);
    },
    confirmStopped: async () => true,
  };
  for (const resume of [false, true]) {
    const runner = new JobRunner({
      adapter,
      onStatusUpdate: async () => {},
      onSchedulerSubmitted: async (_spec, _id, _outputs, uid) => {
        submittedUid = uid;
      },
      sleep: async () => {
        await runner.cancelAndKill();
      },
    });
    if (resume) await runner.resume(baseSpec, "original", [], schedulerUid);
    else await runner.run(baseSpec);
  }
  expect(submittedUid).toBe(schedulerUid);
  expect(resumedUid).toBe(schedulerUid);
  expect(cancelled).toEqual([schedulerUid, schedulerUid]);
});

test("terminal runner reports preserve scheduler accounting independently of declared resources", async () => {
  const accounting = {
    version: 1,
    source: "slurm-sacct",
    schedulerJobId: "scheduler-1",
    observedAt: new Date().toISOString(),
    elapsedMilliseconds: "5000",
    cpuTimeMilliseconds: "1234",
    allocatedCpus: "2",
  } as const;
  const reports: JobStatusReport[] = [];
  const runner = new JobRunner({
    adapter: makeAdapter({ statuses: [{ status: "completed", exitCode: 0, accounting }] }),
    sleep: noSleep,
    onStatusUpdate: (report) => {
      reports.push(report);
    },
  });
  await runner.run(baseSpec);
  expect(reports.find((report) => report.status === "completed")?.accounting).toEqual(accounting);
});

test.each([
  false,
  true,
])("runner preserves leased cancellation without a Kubernetes UID, resume=%s", async (resume) => {
  const epochs: Array<number | undefined> = [];
  const adapter = makeAdapter({});
  adapter.cancel = async (_id, lookup) => {
    epochs.push(lookup?.federationDispatchEpoch);
  };
  const runner = new JobRunner({
    adapter,
    onStatusUpdate: () => {},
    sleep: async () => {
      await runner.cancelAndKill();
    },
  });
  const spec = { ...baseSpec, federationDispatchEpoch: 7 };
  if (resume) await runner.resume(spec, "original");
  else await runner.run(spec);
  expect(epochs).toEqual([7]);
});

test("cancel request acceptance does not release artifacts before confirmed termination", async () => {
  const submitted = Promise.withResolvers<void>();
  const poll = Promise.withResolvers<void>();
  let finished = false;
  const adapter = makeAdapter({});
  adapter.confirmStopped = async () => false;
  const runner = new JobRunner({
    adapter,
    sleep: () => poll.promise,
    onStatusUpdate: () => {
      submitted.resolve();
    },
    onJobFinished: () => {
      finished = true;
    },
  });
  const running = runner.run(baseSpec);
  const rejected = running.catch((error: unknown) => error);
  await submitted.promise;
  await expect(runner.cancelAndKill()).rejects.toThrow("stop is not confirmed");
  poll.resolve();
  expect(await rejected).toBeInstanceOf(AggregateError);
  expect(finished).toBe(false);
});

test("resume reports the first real queued state and scheduler ID without waiting for running", async () => {
  const reports: JobStatusReport[] = [];
  const runner = new JobRunner({
    adapter: makeAdapter({
      submit: async () => {
        throw new Error("must not resubmit");
      },
      statuses: [{ status: "queued" }, { status: "queued" }, { status: "completed", exitCode: 0 }],
    }),
    sleep: noSleep,
    onStatusUpdate: (report) => {
      reports.push(report);
    },
  });
  await runner.resume(baseSpec, "original-123");
  expect(reports.map((report) => report.status)).toEqual(["queued", "completed"]);
  expect(reports[0]?.schedulerJobId).toBe("original-123");
});

test("uncertain post-submit persistence retains the scheduler job without a false terminal report", async () => {
  const reports: JobStatusReport[] = [];
  let finished = false;
  const runner = new JobRunner({
    adapter: makeAdapter({}),
    sleep: noSleep,
    onSchedulerSubmitted: async () => {
      throw new SchedulerSubmissionUnknownError("persistence and stop outcome unknown");
    },
    onStatusUpdate: (report) => {
      reports.push(report);
    },
    onJobFinished: () => {
      finished = true;
    },
  });
  expect(await runner.run(baseSpec)).toBe("scheduler-1");
  expect(reports).toEqual([]);
  expect(finished).toBe(false);
});
