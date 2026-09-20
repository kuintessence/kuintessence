import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { SchedulerQueueInventory } from "@kuintessence/shared";
import { availableQueueInventory, SchedulerQueueInventoryCache } from "./queue-inventory";

const epoch = Date.parse("2026-09-20T00:00:00.000Z");

function observeQueue(): SchedulerQueueInventory {
  const observedAt = new Date();
  return availableQueueInventory(
    [
      {
        queueName: "batch",
        queueType: "partition",
        isDefault: true,
        state: "up",
        acceptsSubmissions: true,
        observedAt,
      },
    ],
    observedAt,
  );
}

describe("SchedulerQueueInventoryCache", () => {
  beforeEach(() => {
    setSystemTime(epoch);
  });

  afterEach(() => {
    setSystemTime();
  });

  test("expires at the default 30 seconds without refreshing observations or TTL on hits", async () => {
    const cache = new SchedulerQueueInventoryCache();
    let calls = 0;
    const load = async () => {
      calls += 1;
      return observeQueue();
    };
    const first = await cache.inspect(load);
    expect(first.observedAt.getTime()).toBe(epoch);

    for (const elapsed of [10_000, 20_000, 29_999]) {
      setSystemTime(epoch + elapsed);
      const cached = await cache.inspect(load);
      expect(cached).toBe(first);
      expect(cached.observedAt.getTime()).toBe(epoch);
      expect(cached.queues[0]?.observedAt.getTime()).toBe(epoch);
      expect(calls).toBe(1);
    }

    setSystemTime(epoch + 30_000);
    const refreshed = await cache.inspect(load);
    expect(calls).toBe(2);
    expect(refreshed).not.toBe(first);
    expect(refreshed.observedAt.getTime()).toBe(epoch + 30_000);
    expect(refreshed.queues[0]?.observedAt.getTime()).toBe(epoch + 30_000);
    expect(first.observedAt.getTime()).toBe(epoch);
  });

  test.each([5_000, 90_000])("honors an explicit %i ms TTL", async (ttl) => {
    const cache = new SchedulerQueueInventoryCache(ttl);
    let calls = 0;
    const load = async () => {
      calls += 1;
      return observeQueue();
    };
    const first = await cache.inspect(load);

    setSystemTime(epoch + ttl - 1);
    expect(await cache.inspect(load)).toBe(first);
    expect(calls).toBe(1);
    expect(first.observedAt.getTime()).toBe(epoch);

    setSystemTime(epoch + ttl);
    const refreshed = await cache.inspect(load);
    expect(calls).toBe(2);
    expect(refreshed).not.toBe(first);
    expect(refreshed.observedAt.getTime()).toBe(epoch + ttl);
  });

  test("coalesces concurrent loads on a cold cache and after expiration", async () => {
    const cache = new SchedulerQueueInventoryCache();
    let pending = Promise.withResolvers<SchedulerQueueInventory>();
    let calls = 0;
    const load = () => {
      calls += 1;
      return pending.promise;
    };
    const firstReads = [cache.inspect(load), cache.inspect(load), cache.inspect(load)];
    expect(calls).toBe(1);
    const first = observeQueue();
    pending.resolve(first);
    for (const result of await Promise.all(firstReads)) {
      expect(result).toBe(first);
    }

    setSystemTime(epoch + 30_000);
    pending = Promise.withResolvers<SchedulerQueueInventory>();
    const refreshReads = [cache.inspect(load), cache.inspect(load)];
    expect(calls).toBe(2);
    const refreshed = observeQueue();
    pending.resolve(refreshed);
    for (const result of await Promise.all(refreshReads)) {
      expect(result).toBe(refreshed);
      expect(result).not.toBe(first);
    }
    expect(await cache.inspect(load)).toBe(refreshed);
    expect(calls).toBe(2);
  });

  test("starts the TTL when an asynchronous collection completes", async () => {
    const cache = new SchedulerQueueInventoryCache();
    const pending = Promise.withResolvers<SchedulerQueueInventory>();
    let calls = 0;
    const read = cache.inspect(() => {
      calls += 1;
      return pending.promise;
    });

    setSystemTime(epoch + 5_000);
    const first = observeQueue();
    pending.resolve(first);
    expect(await read).toBe(first);
    const load = async () => {
      calls += 1;
      return observeQueue();
    };

    setSystemTime(epoch + 34_999);
    expect(await cache.inspect(load)).toBe(first);
    expect(calls).toBe(1);

    setSystemTime(epoch + 35_000);
    const refreshed = await cache.inspect(load);
    expect(calls).toBe(2);
    expect(refreshed.observedAt.getTime()).toBe(epoch + 35_000);
    expect(first.observedAt.getTime()).toBe(epoch + 5_000);
  });

  test.each([
    false,
    true,
  ])("retries a rejected shared load with prior snapshot=%s", async (seed) => {
    const cache = new SchedulerQueueInventoryCache();
    if (seed) {
      await cache.inspect(async () => observeQueue());
      setSystemTime(epoch + 30_000);
    }
    const pending = Promise.withResolvers<SchedulerQueueInventory>();
    const failure = new Error("queue collection failed");
    let calls = 0;
    const load = () => {
      calls += 1;
      return pending.promise;
    };
    const results = Promise.allSettled([cache.inspect(load), cache.inspect(load)]);
    expect(calls).toBe(1);
    pending.reject(failure);
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toBe(failure);
      }
    }

    const recovered = observeQueue();
    const retry = async () => {
      calls += 1;
      return recovered;
    };
    expect(await cache.inspect(retry)).toBe(recovered);
    expect(calls).toBe(2);
    expect(await cache.inspect(retry)).toBe(recovered);
    expect(calls).toBe(2);
  });

  test("leaves freshness headroom across repeated heartbeats with collection and delivery delays", async () => {
    const cache = new SchedulerQueueInventoryCache();
    const observations: SchedulerQueueInventory[] = [];
    const load = async () => {
      setSystemTime(Date.now() + 5_000);
      const inventory = observeQueue();
      observations.push(inventory);
      return inventory;
    };
    let previous: SchedulerQueueInventory | undefined;
    let maximumAge = 0;

    for (let heartbeat = 0; heartbeat < 9; heartbeat += 1) {
      setSystemTime(epoch + heartbeat * 30_000);
      const inventory = await cache.inspect(load);
      expect(inventory).toBe(observations.at(-1));
      setSystemTime(Date.now() + 2_000);

      // The Server retains its previous observation until the next delivery.
      for (const snapshot of previous ? [previous, inventory] : [inventory]) {
        const age = Date.now() - snapshot.observedAt.getTime();
        expect(age).toBeGreaterThanOrEqual(0);
        expect(age).toBeLessThan(120_000);
        expect(snapshot.queues[0]?.observedAt.getTime()).toBe(snapshot.observedAt.getTime());
        maximumAge = Math.max(maximumAge, age);
      }
      previous = inventory;
    }

    expect(observations.map((inventory) => inventory.observedAt.getTime() - epoch)).toEqual([
      5_000, 65_000, 125_000, 185_000, 245_000,
    ]);
    expect(maximumAge).toBe(62_000);
    expect(120_000 - maximumAge).toBe(58_000);
  });
});
