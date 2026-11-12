import { expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { NetDriveCommitResult, NetDriveService } from "./netdrive";
import { type TransferProgressEvent, TransferRegistry } from "./transfer-registry";
import { TransferRunner } from "./transfer-runner";

test.each([
  "succeeded",
  "failed",
])("old %s finalization cannot clear a resumed round", async (outcome) => {
  const completion = Promise.withResolvers<NetDriveCommitResult>();
  const started = Promise.withResolvers<void>();
  const registry = new TransferRegistry();
  let round = 0;
  const netdrive = {
    initiateMultipart: async () => ({
      storageKey: "key",
      uploadId: `upload-${++round}`,
      commitToken: "token",
      partSize: 10,
    }),
    completeMultipartWithReplacements: () => {
      started.resolve();
      return completion.promise;
    },
    mintPartUrls: async (_owner: string, request: { uploadId: string }) => ({
      urls: [{ partNumber: 1, url: request.uploadId }],
    }),
  } as unknown as NetDriveService;
  const runner = new TransferRunner({
    db: {} as PgDb,
    dispatcher: {
      onlineAgentIds: () => ["agent"],
      pushFileTransfer: () => true,
    } as unknown as AgentDispatcher,
    netdriveService: netdrive,
    transferRegistry: registry,
  });
  const data = { direction: "cluster_to_cloud" as const, source: "/output", target: "output" };
  const oldEvents: TransferProgressEvent[] = [];
  const newEvents: TransferProgressEvent[] = [];
  await runner.start("owner", "retry", data, (event) => oldEvents.push(event));
  registry.update("retry", {
    state: "succeeded",
    copiedBytes: 1,
    sha256: "a".repeat(64),
    parts: [{ partNumber: 1, etag: "etag" }],
  });
  await started.promise;
  await runner.start("owner", "retry", data, (event) => newEvents.push(event));
  if (outcome === "succeeded")
    completion.resolve({
      file: { id: "old" },
      replacedFiles: [],
    } as unknown as NetDriveCommitResult);
  else completion.reject(new Error("old finalization failed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(await runner.mintPartUrlsFor("retry", [1], "agent", "upload-2")).toEqual([
    { partNumber: 1, url: "upload-2" },
  ]);
  expect(registry.update("retry", { state: "running", copiedBytes: 1 })).toBe(true);
  expect(newEvents).toHaveLength(1);
  expect(oldEvents).toEqual([]);
  registry.cancel("retry");
});

test.each(["cancel", "failed-event"])("old %s abort cannot clear a resumed round", async (mode) => {
  const abort = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const registry = new TransferRegistry();
  let round = 0;
  const runner = new TransferRunner({
    db: {} as PgDb,
    dispatcher: {
      onlineAgentIds: () => ["agent"],
      pushFileTransfer: () => true,
      pushFileTransferCancel: () => true,
    } as unknown as AgentDispatcher,
    netdriveService: {
      initiateMultipart: async () => ({
        storageKey: "key",
        uploadId: `upload-${++round}`,
        commitToken: "token",
        partSize: 10,
      }),
      abortMultipart: () => {
        started.resolve();
        return abort.promise;
      },
      mintPartUrls: async (_owner: string, request: { uploadId: string }) => ({
        urls: [{ partNumber: 1, url: request.uploadId }],
      }),
    } as unknown as NetDriveService,
    transferRegistry: registry,
  });
  const data = { direction: "cluster_to_cloud" as const, source: "/output", target: "output" };
  const oldEvents: TransferProgressEvent[] = [];
  await runner.start("owner", "retry", data, (event) => oldEvents.push(event));
  const cancelled = mode === "cancel" ? runner.cancel("retry") : undefined;
  if (mode === "failed-event") registry.update("retry", { copiedBytes: 0, state: "failed" });
  await started.promise;
  await runner.start("owner", "retry", data, () => {});
  abort.resolve();
  await cancelled;
  await Promise.resolve();
  expect(await runner.mintPartUrlsFor("retry", [1], "agent", "upload-2")).toEqual([
    { partNumber: 1, url: "upload-2" },
  ]);
  expect(oldEvents).toEqual([]);
  registry.cancel("retry");
});
