import { describe, expect, test } from "bun:test";
import {
  completionFromJob,
  type JobCompletion,
  JobCompletionRegistry,
} from "./job-completion-registry";

describe("JobCompletionRegistry", () => {
  test("multiple waiters do not replace each other and time out independently", async () => {
    const reg = new JobCompletionRegistry();
    const early = reg.awaitCompletion("shared", 5);
    const remaining = reg.awaitCompletion("shared", 1000);
    await expect(early).rejects.toThrow("timed out");
    reg.complete("shared", { status: "completed", collected: { value: "done" } });
    expect((await remaining).collected).toEqual({ value: "done" });
  });

  test("recovers a persisted completion without any in-memory notification", async () => {
    const completion: JobCompletion = { status: "completed", collected: { output: "persisted" } };
    const load = async () => completion;
    const before = new JobCompletionRegistry({ load });
    before.complete("job", { status: "failed", collected: {} });
    expect(await before.awaitCompletion("job", 100)).toEqual(completion);
    const after = new JobCompletionRegistry({ load });
    expect(await after.awaitCompletion("job", 100)).toEqual(completion);
    expect(await after.awaitCompletion("job", 100)).toEqual(completion);
  });

  test("polls persistent results when an event is lost and retries transient read errors", async () => {
    let reads = 0;
    const reg = new JobCompletionRegistry({
      pollIntervalMs: 2,
      load: async () => {
        reads++;
        if (reads === 1) throw new Error("temporary database outage");
        if (reads === 2) return null;
        return { status: "completed", collected: { value: "saved" } };
      },
    });
    const [first, second] = await Promise.all([
      reg.awaitCompletion("job", 1000),
      reg.awaitCompletion("job", 1000),
    ]);
    expect(first).toEqual(second);
    expect(first.collected.value).toBe("saved");
    expect(reads).toBe(3);
  });

  test("notification during a stale database read triggers another read instead of trusting event data", async () => {
    let release: (value: JobCompletion | null) => void = () => {};
    const stale = new Promise<JobCompletion | null>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const reg = new JobCompletionRegistry({
      pollIntervalMs: 60_000,
      load: async () => {
        reads++;
        return reads === 1 ? stale : { status: "completed", collected: { value: "database" } };
      },
    });
    const result = reg.awaitCompletion("job", 1000);
    reg.complete("job", { status: "failed", collected: { value: "uncommitted notification" } });
    release(null);
    expect(await result).toEqual({ status: "completed", collected: { value: "database" } });
    expect(reads).toBe(2);
  });

  test("aborting a waiter stops its polling and a stale read cannot resolve a new waiter", async () => {
    let release: (value: JobCompletion | null) => void = () => {};
    const stale = new Promise<JobCompletion | null>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const reg = new JobCompletionRegistry({
      pollIntervalMs: 60_000,
      load: async () => {
        reads++;
        return reads === 1 ? stale : { status: "completed", collected: { value: "new" } };
      },
    });
    const controller = new AbortController();
    const first = reg.awaitCompletion("job", 1000, controller.signal);
    controller.abort(new Error("lease lost"));
    await expect(first).rejects.toThrow("lease lost");
    const second = reg.awaitCompletion("job", 1000);
    release({ status: "failed", collected: {} });
    expect((await second).collected.value).toBe("new");
    await Bun.sleep(5);
    expect(reads).toBe(2);
  });

  test("reconstructed results retain failure details but exclude restricted outputs", () => {
    const job = {
      status: "failed",
      restrictedNoEgress: true,
      collectedOutputs: { secret: "data" },
      errorMessage: "exit failed",
      reason: "TIMEOUT",
      exitCode: 124,
    };
    expect(completionFromJob(job)).toEqual({
      status: "failed",
      collected: {},
      errorMessage: "exit failed",
      reason: "TIMEOUT",
      exitCode: 124,
    });
    expect(completionFromJob({ ...job, status: "running" })).toBeNull();
    expect(completionFromJob({ ...job, restrictedNoEgress: false })?.collected).toEqual({
      secret: "data",
    });
  });

  test("resolves an awaited job when it completes", async () => {
    const reg = new JobCompletionRegistry();
    const p = reg.awaitCompletion("j1");
    reg.complete("j1", { status: "completed", collected: { log: "ok" } });
    expect(await p).toEqual({ status: "completed", collected: { log: "ok" } });
  });

  test("buffers a completion that arrives before the await", async () => {
    const reg = new JobCompletionRegistry();
    reg.complete("j2", { status: "completed", collected: { log: "early" } });
    expect(await reg.awaitCompletion("j2")).toEqual({
      status: "completed",
      collected: { log: "early" },
    });
  });

  test("carries a terminal failure status through to the awaiter", async () => {
    const reg = new JobCompletionRegistry();
    const p = reg.awaitCompletion("j3");
    reg.complete("j3", { status: "failed", collected: {} });
    expect(await p).toEqual({ status: "failed", collected: {} });
  });

  test("completing an unknown job is a no-op", () => {
    const reg = new JobCompletionRegistry();
    expect(() => reg.complete("ghost", { status: "completed", collected: {} })).not.toThrow();
  });

  test("resolves when complete() arrives (timeout set) and does not later reject", async () => {
    const reg = new JobCompletionRegistry();
    const p = reg.awaitCompletion("t1", 1000);
    reg.complete("t1", { status: "completed", collected: {} });
    expect(await p).toEqual({ status: "completed", collected: {} });

    let rejected = false;
    p.catch(() => {
      rejected = true;
    });
    await Bun.sleep(20);
    expect(rejected).toBe(false);
  });

  test("rejects with a timeout error after timeoutMs and evicts the pending entry", async () => {
    const reg = new JobCompletionRegistry();
    const p = reg.awaitCompletion("t2", 10);
    await expect(p).rejects.toThrow(/timed out/);

    expect(() => reg.complete("t2", { status: "failed", collected: {} })).not.toThrow();
    expect(await reg.awaitCompletion("t2")).toEqual({ status: "failed", collected: {} });
  });

  test("timeoutMs omitted/0 stays pending until complete()", async () => {
    const reg = new JobCompletionRegistry();
    const p = reg.awaitCompletion("t3");
    const sentinel = Symbol("pending");
    const winner = await Promise.race([p, Bun.sleep(20).then(() => sentinel)]);
    expect(winner).toBe(sentinel);

    const completion = { status: "completed", collected: { out: "x" } } as const;
    reg.complete("t3", completion);
    expect(await p).toEqual(completion);
  });

  test("clamps an over-max timeout so it does not overflow and fire immediately", async () => {
    const reg = new JobCompletionRegistry();
    // 5e9 ms > setTimeout's signed-32-bit ceiling. Unclamped, this overflows and
    // fires (almost) immediately, rejecting at once. Clamped, it stays pending.
    const p = reg.awaitCompletion("t5", 5_000_000_000);
    const sentinel = Symbol("pending");
    const winner = await Promise.race([
      p.catch(() => "rejected"),
      Bun.sleep(30).then(() => sentinel),
    ]);
    expect(winner).toBe(sentinel);

    const completion = { status: "completed", collected: {} } as const;
    reg.complete("t5", completion);
    expect(await p).toEqual(completion);
  });

  test("completion buffered before await is returned (existing behavior preserved)", async () => {
    const reg = new JobCompletionRegistry();
    const completion = { status: "completed", collected: { a: "b" } } as const;
    reg.complete("t4", completion);
    expect(await reg.awaitCompletion("t4")).toEqual(completion);
  });
});
