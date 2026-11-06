import { expect, spyOn, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { InstallationAuthorization } from "./install-authorization";

test("a backward wall clock and delayed timer cannot revive an expired lease", async () => {
  const now = Date.now();
  const lease = new InstallationAuthorization(
    now + 100,
    async () => now + 1000,
    new AbortController().signal,
  );
  const clock = spyOn(Date, "now").mockReturnValue(now - 60_000);
  try {
    const until = performance.now() + 130;
    while (performance.now() < until) {
      /* Delay the event loop past expiry. */
    }
    expect(() => lease.assertValid()).toThrow("authorization expired");
  } finally {
    clock.mockRestore();
    await lease.close();
  }
});

test("installation stays alive across renewals and closes its outstanding request", async () => {
  let renewals = 0;
  let accepted = 0;
  let pending: AbortSignal | undefined;
  const lease = new InstallationAuthorization(
    Date.now() + 200,
    async (signal) => {
      renewals++;
      if (renewals > 2) {
        pending = signal;
        await delay(10000, undefined, { signal });
      }
      return Date.now() + 200;
    },
    new AbortController().signal,
    async () => {
      accepted++;
    },
  );
  try {
    for (let i = 0; i < 100 && !pending; i++) await delay(10);
    expect(pending).toBeDefined();
    lease.assertValid();
    expect(accepted).toBe(2);
  } finally {
    await lease.close();
  }
  expect(pending?.aborted).toBe(true);
  expect(lease.signal.aborted).toBe(false);
});

test("an unresponsive renewal cannot outlive the previous grant", async () => {
  let waiting: AbortSignal | undefined;
  const lease = new InstallationAuthorization(
    Date.now() + 100,
    async (signal) => {
      waiting = signal;
      await delay(10000, undefined, { signal });
      return Date.now() + 100;
    },
    new AbortController().signal,
  );
  try {
    await delay(160);
    expect(waiting?.aborted).toBe(true);
    expect(() => lease.assertValid()).toThrow("authorization expired");
  } finally {
    await lease.close();
  }
});

test.each([
  "denied",
  "invalid",
  "supervisor-rejected",
] as const)("running renewal fails closed on %s", async (kind) => {
  const lease = new InstallationAuthorization(
    Date.now() + 200,
    async () => {
      if (kind === "denied") throw new Error("denied");
      return kind === "invalid" ? Date.now() + 60_000 : Date.now() + 200;
    },
    new AbortController().signal,
    async () => {
      throw new Error("supervisor write failed");
    },
  );
  try {
    await delay(150);
    expect(() => lease.assertValid()).toThrow("renewal failed");
  } finally {
    await lease.close();
  }
});

test("late success after expiry does not publish a fresh supervisor lease", async () => {
  let accept = 0;
  const lease = new InstallationAuthorization(
    Date.now() + 100,
    async () => {
      await delay(100);
      return Date.now() + 1000;
    },
    new AbortController().signal,
    async () => {
      accept++;
    },
  );
  try {
    await delay(200);
    expect(accept).toBe(0);
    expect(() => lease.assertValid()).toThrow("authorization expired");
  } finally {
    await lease.close();
  }
});

test("cancellation aborts renewal without waiting for its remote timeout", async () => {
  const controller = new AbortController();
  let waiting: AbortSignal | undefined;
  const lease = new InstallationAuthorization(
    Date.now() + 200,
    async (signal) => {
      waiting = signal;
      await delay(10000, undefined, { signal });
      return Date.now() + 200;
    },
    controller.signal,
  );
  try {
    for (let i = 0; i < 100 && !waiting; i++) await delay(10);
    controller.abort(new Error("cancelled"));
    expect(waiting?.aborted).toBe(true);
    expect(() => lease.assertValid()).toThrow("cancelled");
  } finally {
    await lease.close();
  }
});
