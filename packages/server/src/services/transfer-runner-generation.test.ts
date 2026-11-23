import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import type { PgDb } from "@kuintessence/db";
import { AgentMessageSchema } from "@kuintessence/proto";
import type { AgentDispatcher } from "../grpc/dispatcher";
import { receiveInteraction } from "../grpc/interaction-receiver";
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
  let requestId = "";
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
      interactionAgentIds: () => ["agent"],
      pushFileTransfer: (_agent: string, id: string) => {
        requestId = id;
        return true;
      },
    } as unknown as AgentDispatcher,
    netdriveService: netdrive,
    transferRegistry: registry,
  });
  const data = { direction: "cluster_to_cloud" as const, source: "/output", target: "output" };
  const oldEvents: TransferProgressEvent[] = [];
  const newEvents: TransferProgressEvent[] = [];
  await runner.start("owner", "retry", data, (event) => oldEvents.push(event));
  registry.update(requestId, {
    state: "succeeded",
    copiedBytes: 1,
    sha256: "a".repeat(64),
    parts: [{ partNumber: 1, etag: "etag" }],
  });
  await started.promise;
  const oldId = requestId;
  await runner.start("owner", "retry", data, (event) => newEvents.push(event));
  expect(requestId).not.toBe(oldId);
  await receiveInteraction(
    { transferRegistry: registry },
    "agent",
    create(AgentMessageSchema, {
      payload: { case: "fileTransferProgress", value: { requestId: oldId, state: "failed" } },
    }),
    () => {},
  );
  expect(newEvents).toHaveLength(0);
  if (outcome === "succeeded")
    completion.resolve({
      file: { id: "old" },
      replacedFiles: [],
    } as unknown as NetDriveCommitResult);
  else completion.reject(new Error("old finalization failed"));
  await Promise.resolve();
  await Promise.resolve();
  expect(await runner.mintPartUrlsFor(requestId, [1], "agent", "upload-2")).toEqual([
    { partNumber: 1, url: "upload-2" },
  ]);
  expect(registry.update(requestId, { state: "running", copiedBytes: 1 })).toBe(true);
  expect(newEvents).toHaveLength(1);
  expect(oldEvents).toEqual([]);
  registry.cancel(requestId);
});

test.each(["cancel", "failed-event"])("old %s abort cannot clear a resumed round", async (mode) => {
  const abort = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const registry = new TransferRegistry();
  let round = 0;
  let requestId = "";
  const runner = new TransferRunner({
    db: {} as PgDb,
    dispatcher: {
      interactionAgentIds: () => ["agent"],
      pushFileTransfer: (_agent: string, id: string) => {
        requestId = id;
        return true;
      },
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
  if (mode === "cancel") registry.confirmCancellation(requestId, "agent");
  if (mode === "failed-event") registry.update(requestId, { copiedBytes: 0, state: "failed" });
  await started.promise;
  const oldId = requestId;
  await runner.start("owner", "retry", data, () => {});
  expect(requestId).not.toBe(oldId);
  abort.resolve();
  await cancelled;
  await Promise.resolve();
  expect(await runner.mintPartUrlsFor(requestId, [1], "agent", "upload-2")).toEqual([
    { partNumber: 1, url: "upload-2" },
  ]);
  expect(oldEvents).toEqual([]);
  registry.cancel(requestId);
});
