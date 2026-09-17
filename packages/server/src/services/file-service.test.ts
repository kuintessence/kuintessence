import { describe, expect, test } from "bun:test";
import type { TransferCreate } from "@kuintessence/shared";
import { AgentDispatcher } from "../grpc/dispatcher";
import {
  buildClusterLsCommand,
  FileService,
  type FileTransferRunner,
  InMemoryFileTransferStore,
  shellSingleQuote,
} from "./file-service";
import { ShellExecRegistry } from "./shell-exec-registry";

const transferData: TransferCreate = {
  direction: "cluster_to_cloud",
  source: "/scratch/run/output.dat",
  target: "outputs/output.dat",
  agentId: "agent-a",
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function recordingRunner(started: string[], cancelled: string[] = []): FileTransferRunner {
  return {
    canHandle: () => true,
    start: async (_actorUserId, transferId) => {
      started.push(transferId);
    },
    cancel: async (transferId) => {
      cancelled.push(transferId);
      return true;
    },
  };
}

function completingRunner(netdriveFileId: string): FileTransferRunner {
  return {
    canHandle: () => true,
    start: async (_actorUserId, _transferId, _data, onProgress) => {
      onProgress({
        copiedBytes: 42,
        state: "succeeded",
        netdriveFileIds: [netdriveFileId],
      });
    },
    cancel: async () => true,
  };
}

async function waitForTransferState(
  service: FileService,
  userId: string,
  state: "running" | "failed" | "cancelled",
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [transfer] = await service.listTransfers(userId);
    if (transfer?.state === state) return;
    await Bun.sleep(5);
  }
  throw new Error(`transfer did not reach ${state}`);
}

describe("shellSingleQuote", () => {
  test("wraps a plain string in single quotes", () => {
    expect(shellSingleQuote("/data/run")).toBe("'/data/run'");
  });

  test("escapes embedded single quotes", () => {
    // a'b  ->  'a'\''b'
    expect(shellSingleQuote("a'b")).toBe("'a'\\''b'");
  });
});

describe("buildClusterLsCommand", () => {
  // SECURITY regression: the cluster path comes from `?path=` (user-controlled)
  // and is sent to the agent's shell. Stripping only double-quotes is unsafe
  // because $(...) and backticks execute inside double quotes. Single-quoting
  // makes every metacharacter literal.
  test("single-quotes the path so $()/backticks/; cannot execute", () => {
    const evil = "/x$(touch /tmp/pwned)`id`; rm -rf /";
    const cmd = buildClusterLsCommand(evil);
    // The entire path appears inside single quotes (literal, no expansion).
    expect(cmd).toContain(`'${evil}'`);
    // No double-quote interpolation remains.
    expect(cmd).not.toContain('"');
  });

  test("produces a read-only ls for a normal path (no mkdir side effect)", () => {
    const cmd = buildClusterLsCommand("/data");
    expect(cmd).toBe("ls -la --time-style=long-iso '/data'");
    // A GET listing must not mutate the filesystem.
    expect(cmd).not.toContain("mkdir");
  });
});

describe("FileService cluster Agent selection", () => {
  test("never falls back to another online Agent for an explicit target", async () => {
    const dispatcher = new AgentDispatcher();
    const registry = new ShellExecRegistry();
    const pushed: unknown[] = [];
    dispatcher.register("agent-online", {
      push(message) {
        pushed.push(message);
      },
      close() {},
    });
    const service = new FileService();
    service.attachShell(dispatcher, registry);

    expect(await service.listClusterReal("/scratch", { agentId: "agent-offline" })).toEqual({
      status: "unavailable",
    });
    expect(
      await service.downloadClusterReal("/scratch/file.txt", { agentId: "agent-offline" }),
    ).toEqual({ status: "unavailable" });
    expect(
      await service.checkClusterTransferPath("cluster_to_cloud", "/scratch/file.txt", {
        agentId: "agent-offline",
      }),
    ).toEqual({ status: "unavailable" });
    expect(await service.checkClusterFileRoot("/scratch", { agentId: "agent-offline" })).toEqual({
      status: "unavailable",
    });
    expect(await service.listClusterReal("/scratch", { siteId: "unknown-site" })).toEqual({
      status: "unavailable",
    });
    expect(pushed).toEqual([]);
  });
});

describe("FileService transfer dispatch lifecycle", () => {
  test("persists queued before execution guard and marks running only before runner dispatch", async () => {
    const service = new FileService(new InMemoryFileTransferStore());
    const started: string[] = [];
    const guard = deferred();
    service.attachRunner(recordingRunner(started));

    const created = await service.createTransfer("user-a", transferData, "user-a", {
      beforeDispatch: async () => {
        await guard.promise;
        return {
          clusterRootId: "00000000-0000-4000-8000-000000000301",
          clusterRootRevision: "2026-07-13T00:00:00.000Z",
        };
      },
    });

    expect(created.state).toBe("queued");
    expect(created.startedAt).toBeNull();
    expect(started).toEqual([]);

    guard.resolve();
    await waitForTransferState(service, "user-a", "running");
    expect(started).toEqual([created.id]);
    expect((await service.listTransfers("user-a"))[0]).toEqual(
      expect.objectContaining({
        clusterRootId: "00000000-0000-4000-8000-000000000301",
        clusterRootRevision: "2026-07-13T00:00:00.000Z",
      }),
    );
  });

  test("fails closed when root authorization is revoked before dispatch", async () => {
    const service = new FileService(new InMemoryFileTransferStore());
    const started: string[] = [];
    service.attachRunner(recordingRunner(started));

    const created = await service.createTransfer("user-a", transferData, "user-a", {
      beforeDispatch: async () => {
        throw new Error("TRANSFER_ROOT_AUTHORIZATION_REVOKED");
      },
    });

    await waitForTransferState(service, "user-a", "failed");
    const [failed] = await service.listTransfers("user-a");
    expect(failed).toEqual(
      expect.objectContaining({
        id: created.id,
        state: "failed",
        startedAt: null,
        error: "TRANSFER_ROOT_AUTHORIZATION_REVOKED",
      }),
    );
    expect(started).toEqual([]);
  });

  test("persists committed NetDrive file ids from terminal progress", async () => {
    const service = new FileService(new InMemoryFileTransferStore());
    const netdriveFileId = "00000000-0000-4000-8000-000000000501";
    service.attachRunner(completingRunner(netdriveFileId));

    const created = await service.createTransfer("user-a", transferData, "user-a");

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [transfer] = await service.listTransfers("user-a");
      if (transfer?.state === "succeeded") break;
      await Bun.sleep(5);
    }
    expect((await service.listTransfers("user-a"))[0]).toEqual(
      expect.objectContaining({
        id: created.id,
        state: "succeeded",
        copiedBytes: 42,
        netdriveFileIds: [netdriveFileId],
      }),
    );
  });

  test("does not dispatch a queued transfer cancelled while its guard is pending", async () => {
    const service = new FileService(new InMemoryFileTransferStore());
    const started: string[] = [];
    const guard = deferred();
    service.attachRunner(recordingRunner(started));

    const created = await service.createTransfer("user-a", transferData, "user-a", {
      beforeDispatch: async () => {
        await guard.promise;
        return undefined;
      },
    });
    await service.cancelTransfer("user-a", created.id);
    guard.resolve();
    await Bun.sleep(10);

    expect((await service.listTransfers("user-a"))[0]?.state).toBe("cancelled");
    expect(started).toEqual([]);
  });

  test("cancels the active runner before marking a running transfer cancelled", async () => {
    const service = new FileService(new InMemoryFileTransferStore());
    const started: string[] = [];
    const cancelled: string[] = [];
    service.attachRunner(recordingRunner(started, cancelled));

    const created = await service.createTransfer("user-a", transferData, "user-a");
    await waitForTransferState(service, "user-a", "running");
    const result = await service.cancelTransfer("user-a", created.id);

    expect(result.state).toBe("cancelled");
    expect(cancelled).toEqual([created.id]);
  });

  test("rejects cancellation when the runner has already entered terminal commit", async () => {
    const service = new FileService(new InMemoryFileTransferStore());
    service.attachRunner({
      canHandle: () => true,
      start: async () => undefined,
      cancel: async () => false,
    });

    const created = await service.createTransfer("user-a", transferData, "user-a");
    await waitForTransferState(service, "user-a", "running");
    await expect(service.cancelTransfer("user-a", created.id)).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: "TRANSFER_CANCELLATION_NOT_ACCEPTED" },
    });
    expect((await service.listTransfers("user-a"))[0]?.state).toBe("running");
  });

  test("marks only running transfers dispatched through the changed root", async () => {
    const store = new InMemoryFileTransferStore();
    const service = new FileService(store);
    const rootId = "00000000-0000-4000-8000-000000000301";
    await store.create({
      id: "00000000-0000-4000-8000-000000000401",
      userId: "user-a",
      ...transferData,
      sourceFileId: undefined,
      siteId: null,
      totalBytes: null,
      copiedBytes: 0,
      state: "running",
      startedAt: "2026-07-13T00:00:00.000Z",
      finishedAt: null,
      error: null,
      clusterRootId: rootId,
      clusterRootRevision: "2026-07-13T00:00:00.000Z",
      rootPolicyChangedAt: null,
    });

    const changedAt = "2026-07-13T01:00:00.000Z";
    const affected = await service.markRunningTransfersRootPolicyChanged(rootId, changedAt);

    expect(affected).toHaveLength(1);
    expect(affected[0]?.rootPolicyChangedAt).toBe(changedAt);
  });
});
