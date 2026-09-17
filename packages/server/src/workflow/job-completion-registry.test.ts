import { describe, expect, test } from "bun:test";
import { JobCompletionRegistry } from "./job-completion-registry";

describe("JobCompletionRegistry", () => {
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
