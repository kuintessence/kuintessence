import { describe, expect, test } from "bun:test";
import { readSeedConfig, runSeedCommand } from "./index";
import { MemorySeedStore } from "./test-store";

const databaseUrl = "postgresql://seed:unit-test-only@localhost/seed";

function logger() {
  const messages: string[] = [];
  return {
    messages,
    info: (message: string) => {
      messages.push(message);
    },
    error: (message: string) => {
      messages.push(message);
    },
  };
}

describe("seed command", () => {
  test("defaults to minimal and requires an explicit demo mode", () => {
    expect(readSeedConfig({ DATABASE_URL: databaseUrl }).mode).toBe("minimal");
    expect(readSeedConfig({ DATABASE_URL: databaseUrl, SEED_MODE: "demo" }).mode).toBe("demo");
  });

  test.each([
    {},
    { DATABASE_URL: "" },
    { DATABASE_URL: "private invalid input" },
    { DATABASE_URL: "https://localhost/seed" },
    { DATABASE_URL: "postgresql://localhost/seed#private" },
    { DATABASE_URL: databaseUrl, SEED_MODE: "" },
    { DATABASE_URL: databaseUrl, SEED_MODE: "production" },
  ])("rejects invalid configuration without connecting or echoing input", async (env) => {
    const log = logger();
    let connected = false;
    expect(
      await runSeedCommand(env, log, () => {
        connected = true;
        throw new Error("Must not connect");
      }),
    ).toBe(1);
    expect(connected).toBe(false);
    expect(log.messages).toEqual(["KQ_SEED_FAILED"]);
  });

  test("closes before success and logs a fixed marker for idempotent reruns", async () => {
    const store = new MemorySeedStore();
    const log = logger();
    let closed = 0;
    const connect = () => ({
      transaction: store.transaction.bind(store),
      close: async () => {
        expect(log.messages).toHaveLength(closed);
        closed++;
      },
    });
    expect(await runSeedCommand({ DATABASE_URL: databaseUrl }, log, connect)).toBe(0);
    expect(await runSeedCommand({ DATABASE_URL: databaseUrl }, log, connect)).toBe(0);
    expect(closed).toBe(2);
    expect(log.messages).toEqual(["KQ_SEED_APPLIED", "KQ_SEED_ALREADY_APPLIED"]);
  });

  test("closes after transaction failure without logging exception contents", async () => {
    const log = logger();
    let closed = false;
    expect(
      await runSeedCommand({ DATABASE_URL: databaseUrl }, log, () => ({
        transaction: async () => {
          throw new Error(`Database error containing ${databaseUrl} and private row values`);
        },
        close: async () => {
          closed = true;
        },
      })),
    ).toBe(1);
    expect(closed).toBe(true);
    expect(log.messages).toEqual(["KQ_SEED_FAILED"]);
  });

  test("connection and close failures are safe nonzero exits", async () => {
    const log = logger();
    expect(
      await runSeedCommand({ DATABASE_URL: databaseUrl }, log, () => {
        throw new Error(databaseUrl);
      }),
    ).toBe(1);
    const store = new MemorySeedStore();
    expect(
      await runSeedCommand({ DATABASE_URL: databaseUrl }, log, () => ({
        transaction: store.transaction.bind(store),
        close: async () => {
          throw new Error(databaseUrl);
        },
      })),
    ).toBe(1);
    expect(log.messages).toEqual(["KQ_SEED_FAILED", "KQ_SEED_FAILED"]);
  });
});
