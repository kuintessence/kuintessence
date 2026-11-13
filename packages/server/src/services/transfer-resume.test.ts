import { expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { AgentDispatcher } from "../grpc/dispatcher";
import type { NetDriveService } from "./netdrive";
import { TransferRegistry } from "./transfer-registry";
import { TransferRunner } from "./transfer-runner";
import type { TransferSession, TransferSessionStore } from "./transfer-session-store";

test("download content binding uses authorized NetDrive metadata rather than client byte counts", async () => {
  const dispatcher = new AgentDispatcher();
  const registry = new TransferRegistry();
  let received = false;
  dispatcher.register("agent", {
    push: (message) => {
      if (message.payload.case !== "fileTransferRequest") return;
      received = true;
      expect(message.payload.value.totalBytes).toBe(6n);
      expect(message.payload.value.expectedSha256).toBe("a".repeat(64));
      expect(message.payload.value.sourceUrl).toBe("https://object.invalid/authorized");
    },
    close() {},
  });
  const runner = new TransferRunner({
    db: {} as PgDb,
    dispatcher,
    transferRegistry: registry,
    netdriveService: {
      getFileById: async () => ({ id: "file", ownerId: "owner", size: 6, sha256: "a".repeat(64) }),
      mintDownloadUrlForAuthorizedFile: async () => ({
        downloadUrl: "https://object.invalid/authorized",
      }),
    } as unknown as NetDriveService,
  });
  try {
    await runner.start(
      "owner",
      "download",
      {
        direction: "cloud_to_cluster",
        source: "display",
        target: "/shared/input",
        sourceFileId: "file",
        totalBytes: 12345,
      },
      () => {},
    );
    expect(received).toBe(true);
  } finally {
    registry.cancel("download");
  }
});

test("new Server runner restores the persisted uploadId rather than creating another upload", async () => {
  let session: TransferSession | undefined;
  let minted = 0;
  let restored = 0;
  const sessions: TransferSessionStore = {
    load: async () => session,
    save: async (_owner, _id, value) => {
      session = value ?? undefined;
      return value;
    },
  };
  const netdrive = {
    initiateMultipart: async () => {
      minted++;
      return {
        storageKey: "netdrive/owner/object",
        uploadId: "original",
        commitToken: "ephemeral",
        partSize: 8,
      };
    },
    restoreMultipartSession: async (_owner: string, value: TransferSession) => {
      restored++;
      return { ...value, commitToken: "fresh" };
    },
  } as unknown as NetDriveService;
  const dispatcher = new AgentDispatcher();
  const uploadIds: string[] = [];
  dispatcher.register("agent", {
    push: (message) => {
      if (message.payload.case === "fileTransferRequest")
        uploadIds.push(message.payload.value.uploadId);
    },
    close() {},
  });
  const registry = new TransferRegistry();
  const deps = {
    db: {} as PgDb,
    dispatcher,
    netdriveService: netdrive,
    transferRegistry: registry,
    sessionStore: sessions,
  };
  const data = {
    direction: "cluster_to_cloud" as const,
    source: "/shared/output",
    target: "output",
    agentId: "agent",
  };
  try {
    await new TransferRunner(deps).start("owner", "transfer", data, () => {});
    registry.cancel("transfer");
    const restarted = new TransferRunner(deps);
    await restarted.start("owner", "transfer", data, () => {});
    expect(minted).toBe(1);
    expect(restored).toBe(1);
    expect(uploadIds).toEqual(["original", "original"]);
    await expect(
      restarted.mintPartUrlsFor("transfer", [1], "agent", "superseded-upload"),
    ).rejects.toThrow("upload binding mismatch");
    await expect(restarted.mintPartUrlsFor("transfer", [1], "another-agent")).rejects.toThrow(
      "binding mismatch",
    );
    await expect(
      new TransferRunner(deps).start(
        "owner",
        "transfer",
        { ...data, source: "/changed" },
        () => {},
      ),
    ).rejects.toThrow("binding changed");
  } finally {
    registry.cancel("transfer");
  }
});

test("failed finalize keeps its durable completion and restarted Server finalizes without redispatch", async () => {
  let session: TransferSession | undefined;
  let attempts = 0;
  let dispatches = 0;
  let aborts = 0;
  const registry = new TransferRegistry();
  const dispatcher = new AgentDispatcher();
  dispatcher.register("agent", {
    push: () => {
      dispatches++;
    },
    close() {},
  });
  const netdrive = {
    initiateMultipart: async () => ({
      storageKey: "netdrive/owner/object",
      uploadId: "original",
      partSize: 5242880,
      commitToken: "token",
    }),
    restoreMultipartSession: async (_owner: string, saved: TransferSession) => ({
      ...saved,
      commitToken: "fresh",
    }),
    completeMultipartWithReplacements: async () => {
      attempts++;
      if (attempts === 1) throw new Error("commit response lost");
      return { file: { id: "file" }, replacedFiles: [] };
    },
    abortMultipart: async () => {
      aborts++;
    },
  } as unknown as NetDriveService;
  const deps = {
    db: {} as PgDb,
    dispatcher,
    transferRegistry: registry,
    netdriveService: netdrive,
    sessionStore: {
      load: async () => session,
      save: async (_owner: string, _id: string, value: TransferSession | null) => {
        session = value ?? undefined;
        return value;
      },
    },
  };
  const data = {
    direction: "cluster_to_cloud" as const,
    source: "/shared/output",
    target: "output",
    agentId: "agent",
  };
  const failed = Promise.withResolvers<void>();
  await new TransferRunner(deps).start("owner", "transfer", data, (event) => {
    if (event.state === "failed") failed.resolve();
  });
  registry.update("transfer", {
    state: "succeeded",
    copiedBytes: 4,
    sha256: "a".repeat(64),
    parts: [{ partNumber: 1, etag: "part" }],
  });
  await failed.promise;
  expect(session?.completion?.copiedBytes).toBe(4);
  dispatcher.unregister("agent");
  const events: string[] = [];
  const restarted = new TransferRunner(deps);
  expect(restarted.canHandle(data)).toBe(false);
  expect(await restarted.canResume("owner", "transfer", data)).toBe(true);
  expect(await restarted.canResume("owner", "transfer", { ...data, source: "/changed" })).toBe(
    false,
  );
  await restarted.start("owner", "transfer", data, (event) => {
    events.push(event.state);
  });
  expect(events).toEqual(["succeeded"]);
  expect(dispatches).toBe(1);
  expect(attempts).toBe(2);
  expect(aborts).toBe(0);
  // A crash after committing metadata but before persisting terminal progress can replay again.
  expect(session?.completion).toBeDefined();
  await new TransferRunner(deps).start("owner", "transfer", data, () => {});
  expect(dispatches).toBe(1);
  expect(attempts).toBe(3);
});

test("dispatcher replays completion returned by a concurrent session save instead of dispatching Agent", async () => {
  const base: TransferSession = {
    storageKey: "netdrive/owner/object",
    uploadId: "upload",
    partSize: 5242880,
    agentId: "agent",
    source: "/output",
    target: "output",
    size: 4,
  };
  const completion = {
    copiedBytes: 4,
    sha256: "a".repeat(64),
    parts: [{ partNumber: 1, etag: "part" }],
  };
  let dispatches = 0;
  let finalizations = 0;
  const dispatcher = new AgentDispatcher();
  dispatcher.register("agent", {
    push: () => {
      dispatches++;
    },
    close() {},
  });
  const netdrive = {
    restoreMultipartSession: async () => ({ ...base, commitToken: "fresh" }),
    completeMultipartWithReplacements: async () => {
      finalizations++;
      return { file: { id: "file" }, replacedFiles: [] };
    },
  } as unknown as NetDriveService;
  const runner = new TransferRunner({
    db: {} as PgDb,
    dispatcher,
    netdriveService: netdrive,
    transferRegistry: new TransferRegistry(),
    sessionStore: {
      load: async () => base,
      save: async (_owner, _id, value) => (value ? { ...value, completion } : null),
    },
  });
  await runner.start(
    "owner",
    "transfer",
    {
      direction: "cluster_to_cloud",
      agentId: "agent",
      source: "/output",
      target: "output",
      totalBytes: 4,
    },
    () => {},
  );
  expect(finalizations).toBe(1);
  expect(dispatches).toBe(0);
});
