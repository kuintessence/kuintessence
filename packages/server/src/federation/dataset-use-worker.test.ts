import { expect, test } from "bun:test";
import { FederationDatasetUseWorker } from "./dataset-use-worker";

test("dataset renewal worker serializes ticks and drains its in-flight request on stop", async () => {
  const pending = Promise.withResolvers<boolean>();
  let calls = 0;
  const worker = new FederationDatasetUseWorker({
    renewNext: () => {
      calls++;
      return pending.promise;
    },
  });
  const first = worker.tick();
  expect(worker.tick()).toBe(first);
  const stopping = worker.stop();
  pending.resolve(true);
  await stopping;
  expect(calls).toBe(1);
});

test("dataset renewal worker yields after a bounded batch and stops on an empty queue", async () => {
  let calls = 0;
  const worker = new FederationDatasetUseWorker({
    renewNext: async () => {
      calls++;
      return calls <= 8;
    },
  });
  await worker.tick();
  expect(calls).toBe(8);
  await worker.tick();
  expect(calls).toBe(9);
  await worker.stop();
});
