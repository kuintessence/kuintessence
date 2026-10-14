import { expect, test } from "bun:test";
import { waitForSoftwareInstallation } from "./wait-for-installation";

test("waits for both successful operation and confirmed inventory", async () => {
  let polls = 0;
  let inventoryChecks = 0;
  await waitForSoftwareInstallation({
    operationId: "operation",
    timeoutMs: 1000,
    readJobStatus: async () => "pending",
    readOperation: async () => ({ status: polls === 0 ? "running" : "succeeded", error: null }),
    inventoryReady: async () => {
      inventoryChecks++;
      return polls === 2;
    },
    sleep: async () => {
      polls++;
    },
  });
  expect(polls).toBe(2);
  expect(inventoryChecks).toBe(2);
});

for (const status of ["failed", "rejected"] as const) {
  test(`fails the waiter on ${status} without checking inventory`, async () => {
    await expect(
      waitForSoftwareInstallation({
        operationId: "operation",
        timeoutMs: 1000,
        readJobStatus: async () => "pending",
        readOperation: async () => ({ status, error: "installation denied or failed" }),
        inventoryReady: async () => {
          throw new Error("must not execute");
        },
      }),
    ).rejects.toThrow(`operation ${status}`);
  });
}

test("cancellation stops waiting without cancelling the shared installation", async () => {
  await expect(
    waitForSoftwareInstallation({
      operationId: "operation",
      timeoutMs: 1000,
      readJobStatus: async () => "cancelled",
      readOperation: async () => {
        throw new Error("must not execute");
      },
      inventoryReady: async () => false,
    }),
  ).rejects.toThrow("Job stopped");
});

test("never dispatches when successful install has no confirmed inventory", async () => {
  await expect(
    waitForSoftwareInstallation({
      operationId: "operation",
      timeoutMs: 1,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 2)),
      readJobStatus: async () => "pending",
      readOperation: async () => ({ status: "succeeded", error: null }),
      inventoryReady: async () => false,
    }),
  ).rejects.toThrow("Timed out");
});
