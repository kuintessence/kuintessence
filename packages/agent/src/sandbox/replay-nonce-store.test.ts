import { describe, expect, test } from "bun:test";
import { createSqliteDb } from "@kuintessence/db";
import { SandboxReplayNonceStore } from "./replay-nonce-store";

describe("SandboxReplayNonceStore", () => {
  test("atomically rejects a nonce replay and accepts it after expiry cleanup", async () => {
    let now = new Date("2026-07-14T00:00:00.000Z");
    const store = new SandboxReplayNonceStore(createSqliteDb(":memory:"), { now: () => now });
    const expiry = new Date(now.getTime() + 1_000);
    expect(await store.consume("nonce-1234567890123456", "job-a", expiry)).toBe(true);
    expect(await store.consume("nonce-1234567890123456", "job-a", expiry)).toBe(false);
    now = new Date(expiry.getTime() + 1);
    expect(
      await store.consume("nonce-1234567890123456", "job-b", new Date(now.getTime() + 1_000)),
    ).toBe(true);
  });
});
