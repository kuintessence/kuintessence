import { expect, test } from "bun:test";
import type { JobSpec, QueueTargetValidationResult, SchedulerAdapter } from "../adapters/base";
import { ExecutorPool, type ExecutorPoolDeps, ExecutorPoolStoppedError } from "./executor-pool";

function fakeAdapter(): SchedulerAdapter {
  let polls = 0;
  return {
    type: "fake",
    version: "0",
    async submit() {
      return { schedulerJobId: "S1" };
    },
    async cancel() {},
    async status() {
      polls += 1;
      return polls >= 2 ? { status: "completed", exitCode: 0 } : { status: "running" };
    },
  };
}
const spec: JobSpec = {
  jobId: "j1",
  name: "n",
  command: "echo",
  cpus: 1,
  memoryMb: 1,
  gpus: 0,
  wallTimeSec: 60,
  workingDir: "",
  envVars: {},
};

test("submit registers an active job and emits transitions", async () => {
  const seen: string[] = [];
  const pool = new ExecutorPool({
    adapter: fakeAdapter(),
    pollIntervalMs: 0,
    sleep: async () => {},
    onTransition: (r) => {
      seen.push(r.status);
    },
  });
  await pool.submit(spec);
  expect(pool.listActive()).toContain("j1");
  await pool.await("j1");
  expect(seen).toEqual(["queued", "running", "completed"]);
  expect(pool.listActive()).not.toContain("j1");
});

test("cancel kills the scheduler job", async () => {
  let cancelled = false;
  let schedulerSubmitted: (() => void) | undefined;
  const submitted = new Promise<void>((resolve) => {
    schedulerSubmitted = resolve;
  });
  let unblockPolling: (() => void) | undefined;
  const pollBlocked = new Promise<void>((resolve) => {
    unblockPolling = resolve;
  });
  const adapter: SchedulerAdapter = {
    ...fakeAdapter(),
    async cancel() {
      cancelled = true;
    },
  };
  const pool = new ExecutorPool({
    adapter,
    pollIntervalMs: 0,
    sleep: async () => pollBlocked,
    onTransition: (report) => {
      if (report.status === "queued") schedulerSubmitted?.();
    },
  });
  await pool.submit(spec);
  await submitted;
  await pool.cancel("j1");
  unblockPolling?.();
  await pool.await("j1");
  expect(cancelled).toBe(true);
});

test("cancel during pending queue validation avoids scheduler side effects", async () => {
  let submitCalls = 0;
  let cancelCalls = 0;
  let finishedCalls = 0;
  const reports: Array<{ status: string; schedulerJobId?: string }> = [];
  let resolveValidation: ((result: QueueTargetValidationResult) => void) | undefined;
  const validation = new Promise<QueueTargetValidationResult>((resolve) => {
    resolveValidation = resolve;
  });
  const adapter: SchedulerAdapter = {
    ...fakeAdapter(),
    async submit() {
      submitCalls += 1;
      return { schedulerJobId: "S1" };
    },
    async validateQueueTarget() {
      return validation;
    },
    async cancel() {
      cancelCalls += 1;
    },
  };
  const pool = new ExecutorPool({
    adapter,
    pollIntervalMs: 0,
    sleep: async () => {},
    onTransition: (report) => {
      reports.push(report);
    },
    onJobFinished: () => {
      finishedCalls += 1;
    },
  });
  await pool.submit({
    ...spec,
    queueName: "default",
    queueTargetMode: "named",
    queueValidationMode: "enforce",
  });

  const cancellation = pool.cancel("j1");
  await Promise.resolve();
  expect(cancelCalls).toBe(0);
  if (!resolveValidation) throw new Error("queue validation was not invoked");
  resolveValidation({ accepted: true, resolvedQueueName: "default" });

  await cancellation;
  expect(submitCalls).toBe(0);
  expect(cancelCalls).toBe(0);
  expect(reports).toEqual([expect.objectContaining({ status: "cancelled" })]);
  expect(reports[0]?.schedulerJobId).toBeUndefined();
  expect(finishedCalls).toBe(1);
});

test("a rejecting run() with no await() caller does not leak an unhandled rejection", async () => {
  const adapter: SchedulerAdapter = {
    type: "fake",
    version: "0",
    async submit() {
      return { schedulerJobId: "S1" };
    },
    async cancel() {},
    async status() {
      return { status: "running" };
    },
  };
  const pool = new ExecutorPool({
    adapter,
    pollIntervalMs: 0,
    sleep: async () => {},
    onTransition: () => {
      throw new Error("emit blew up");
    },
  });
  await pool.submit(spec);
  await new Promise((r) => setTimeout(r, 5));
  expect(pool.listActive()).not.toContain("j1");
});

test("done entry is cleaned up after completion (no unbounded growth)", async () => {
  const pool = new ExecutorPool({
    adapter: {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
    } as SchedulerAdapter,
    pollIntervalMs: 0,
    sleep: async () => {},
    onTransition: () => {},
  });
  await pool.submit(spec);
  await pool.await("j1");
  // @ts-expect-error probing private map size for the growth guarantee
  expect(pool.done.size).toBe(0);
});

test("forwards a per-job child logger bound to jobId", async () => {
  const childCalls: unknown[] = [];
  const fakeChild = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
      return fakeChild;
    },
  };
  const fakeLogger = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child(bindings: unknown) {
      childCalls.push(bindings);
      return fakeChild;
    },
  };
  const pool = new ExecutorPool({
    adapter: {
      type: "fake",
      version: "0",
      async submit() {
        return { schedulerJobId: "S1" };
      },
      async cancel() {},
      async status() {
        return { status: "completed", exitCode: 0 };
      },
    } as SchedulerAdapter,
    pollIntervalMs: 0,
    sleep: async () => {},
    onTransition: () => {},
    logger: fakeLogger as unknown as ExecutorPoolDeps["logger"],
  });
  await pool.submit(spec);
  await pool.await("j1");
  expect(childCalls).toContainEqual({ jobId: "j1" });
});

test("stopAll stops polling without killing", async () => {
  let cancelCalls = 0;
  const adapter: SchedulerAdapter = {
    ...fakeAdapter(),
    async status() {
      return { status: "running" };
    },
    async cancel() {
      cancelCalls += 1;
    },
  };
  const pool = new ExecutorPool({
    adapter,
    pollIntervalMs: 0,
    sleep: async () => {},
    onTransition: () => {},
  });
  await pool.submit(spec);
  pool.stopAll();
  await pool.await("j1");
  expect(cancelCalls).toBe(0);
  expect(pool.listActive()).not.toContain("j1");
});

test("stopAll during pending preparation preserves the dispatch without a business terminal", async () => {
  let submitCalls = 0;
  let cancelCalls = 0;
  let finishedCalls = 0;
  const reports: Array<{ status: string; schedulerJobId?: string }> = [];
  let releasePreparation: (() => void) | undefined;
  const preparation = new Promise<void>((resolve) => {
    releasePreparation = resolve;
  });
  const pool = new ExecutorPool({
    adapter: {
      ...fakeAdapter(),
      async submit() {
        submitCalls += 1;
        return { schedulerJobId: "must-not-submit" };
      },
      async cancel() {
        cancelCalls += 1;
      },
    },
    ensureWorkingDir: async () => preparation,
    onTransition: (report) => {
      reports.push(report);
    },
    onJobFinished: () => {
      finishedCalls += 1;
    },
  });

  await pool.submit({ ...spec, workingDir: "/managed/jobs/j1" });
  pool.stopAll();
  releasePreparation?.();
  await pool.await("j1");

  expect(submitCalls).toBe(0);
  expect(cancelCalls).toBe(0);
  expect(reports).toEqual([]);
  expect(finishedCalls).toBe(0);
});

test("stopAll rejects runners created by late asynchronous preparation", async () => {
  const pool = new ExecutorPool({ adapter: fakeAdapter(), onTransition: () => {} });

  pool.stopAll();

  await expect(pool.submit(spec)).rejects.toBeInstanceOf(ExecutorPoolStoppedError);
  expect(pool.listActive()).toEqual([]);
});
