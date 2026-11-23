// PG-backed: cluster->cloud now drives an S3 multipart upload. The Server
// pre-initiates the multipart, dispatches uploadId/commitToken/partSize to the
// agent, and on a terminal "succeeded" event (carrying part ETags) calls
// completeMultipart, which inserts the netdrive_files row.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  createPgDb,
  fileTransfers,
  netdriveFiles,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { AgentMessageSchema, type ServerMessage } from "@kuintessence/proto";
import type { TransferCreate } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import type { AuthzCheck, AuthzService, AuthzTuple } from "../authz/service";
import { type AgentChannel, AgentDispatcher } from "../grpc/dispatcher";
import { receiveInteraction } from "../grpc/interaction-receiver";
import { FakeMinioBackend } from "../storage/minio-client.test";
import { waitForOutputTransfer } from "../workflow/output-transfer";
import { pgOutputTransferStore } from "../workflow/pg-output-transfer-store";
import { FileService } from "./file-service";
import { NetDriveService } from "./netdrive";
import { PgFileTransferStore } from "./pg-file-transfer-store";
import { TransferRegistry } from "./transfer-registry";
import { TransferRunner } from "./transfer-runner";
import { PgTransferSessionStore } from "./transfer-session-store";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const COMMIT_SECRET = "transfer-runner-test-commit-secret-please-rotate-in-prod";

const OWNER_ID = "00000000-0000-0000-0000-00000000c401";
const OWNER_EMAIL = `transfer-runner-${OWNER_ID}@test`;
const SHARED_ACTOR_ID = "00000000-0000-0000-0000-00000000c404";
const SHARED_ACTOR_EMAIL = `transfer-runner-${SHARED_ACTOR_ID}@test`;
const ORG_ID = "00000000-0000-0000-0000-00000000c402";
const AGENT_ID = "agent-tr-1";
const SECOND_AGENT_ID = "agent-tr-2";
const NETDRIVE_FILE_ID = "00000000-0000-0000-0000-00000000c403";

async function seedUser(db: PgDb, id: string, email: string): Promise<void> {
  await db.insert(orgs).values({ id: ORG_ID, name: "transfer-runner-test" }).onConflictDoNothing();
  await db
    .insert(users)
    .values({ id, email, displayName: "transfer-runner-test", role: "user" })
    .onConflictDoNothing();
  await db
    .insert(userOrgMemberships)
    .values({ userId: id, orgId: ORG_ID, role: "member" })
    .onConflictDoNothing();
}

function capturingAuthz(enqueued: AuthzTuple[]): AuthzService {
  return {
    mode: "enforce",
    enqueueMany: async (tuples: AuthzTuple[]) => {
      enqueued.push(...tuples);
    },
  } as unknown as AuthzService;
}

/** Records every ServerMessage the dispatcher pushes so the test can inspect it. */
class RecordingChannel implements AgentChannel {
  readonly pushed: ServerMessage[] = [];
  push(msg: ServerMessage): void {
    this.pushed.push(msg);
  }
  close(): void {}
}

describe("TransferRunner.startClusterToCloud (multipart)", () => {
  let db: PgDb;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    await seedUser(db, OWNER_ID, OWNER_EMAIL);
    await seedUser(db, SHARED_ACTOR_ID, SHARED_ACTOR_EMAIL);
  });

  beforeEach(async () => {
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, OWNER_ID));
  });

  afterAll(async () => {
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, OWNER_ID));
    await db.delete(users).where(eq(users.id, SHARED_ACTOR_ID));
    await db.delete(users).where(eq(users.id, OWNER_ID));
    await db.delete(orgs).where(eq(orgs.id, ORG_ID));
  });

  function makeRunner(authz?: AuthzService): {
    runner: TransferRunner;
    backend: FakeMinioBackend;
    channel: RecordingChannel;
    transferRegistry: TransferRegistry;
  } {
    const backend = new FakeMinioBackend();
    const netdriveService = new NetDriveService(db, backend, { commitSecret: COMMIT_SECRET });
    const dispatcher = new AgentDispatcher();
    const channel = new RecordingChannel();
    dispatcher.register(AGENT_ID, channel);
    const transferRegistry = new TransferRegistry();
    const runner = new TransferRunner({ db, dispatcher, netdriveService, transferRegistry, authz });
    return { runner, backend, channel, transferRegistry };
  }

  function fileTransferReq(channel: RecordingChannel) {
    const msg = channel.pushed.find((m) => m.payload.case === "fileTransferRequest");
    if (msg?.payload.case !== "fileTransferRequest") {
      throw new Error("no fileTransferRequest pushed");
    }
    return msg.payload.value;
  }

  const transferData: TransferCreate = {
    direction: "cluster_to_cloud",
    source: "/cluster/run1/out.dat",
    target: "outputs/run1/out.dat",
  };

  test("PostgreSQL accepts terminal progress only for the current running attempt", async () => {
    const store = new PgFileTransferStore(db);
    const transfer = await new FileService(store).createTransfer(OWNER_ID, transferData, OWNER_ID);
    const start = "2026-01-01T00:00:00.001Z";
    await store.transition(OWNER_ID, transfer.id, "failed", { state: "running", startedAt: start });
    const finish = { state: "succeeded" } as const;
    expect(
      await store.transition(OWNER_ID, transfer.id, "running", finish, "2026-01-01T00:00:00.000Z"),
    ).toBeNull();
    expect((await store.transition(OWNER_ID, transfer.id, "running", finish, start))?.state).toBe(
      "succeeded",
    );
    expect(
      await store.transition(OWNER_ID, transfer.id, "running", { state: "failed" }, start),
    ).toBeNull();
  });

  async function until(check: () => Promise<boolean>) {
    for (let n = 0; n < 200; n++) {
      if (await check()) return;
      await Bun.sleep(10);
    }
    throw new Error("Expected transfer state was not reached");
  }

  test("workflow waiters reuse a late receipt and another Server can take over a failed start", async () => {
    const first = pgOutputTransferStore(db, new PgFileTransferStore(db));
    const second = pgOutputTransferStore(db, new PgFileTransferStore(db));
    const input = {
      ownerId: OWNER_ID,
      transferId: randomUUID(),
      agentId: AGENT_ID,
      source: "/output",
      target: "result",
    };
    const fail = async () => {
      throw new Error("offline");
    };
    await expect(
      waitForOutputTransfer({ store: first, runner: { start: fail } }, input),
    ).rejects.toThrow("offline");
    const started = Promise.withResolvers<Parameters<TransferRunner["start"]>[3]>();
    const ctrl = new AbortController();
    const waiting = waitForOutputTransfer(
      {
        store: second,
        runner: {
          start: async (_owner, _id, _data, onProgress) => {
            started.resolve(onProgress);
          },
        },
      },
      input,
      ctrl.signal,
    );
    const notify = await started.promise;
    ctrl.abort();
    await expect(waiting).rejects.toThrow("interrupted");
    await expect(
      waitForOutputTransfer({ store: first, runner: { start: fail } }, input),
    ).rejects.toThrow("already in progress");
    const file = randomUUID();
    notify({ state: "succeeded", copiedBytes: 1, netdriveFileIds: [file] });
    await until(async () => (await first.ensure(input))?.state === "succeeded");
    expect(await waitForOutputTransfer({ store: first, runner: { start: fail } }, input)).toEqual([
      file,
    ]);
  });

  test("a second Server preserves a live lease and waits for the owning Agent to acknowledge cancellation", async () => {
    const a = new PgFileTransferStore(db),
      b = new PgFileTransferStore(db);
    const left = new FileService(a),
      right = new FileService(b);
    const { runner, channel, transferRegistry } = makeRunner();
    left.attachRunner(runner);
    const row = await left.createTransfer(OWNER_ID, transferData, OWNER_ID);
    await until(async () => channel.pushed.length === 1);
    const attempt = fileTransferReq(channel).requestId;
    expect(await right.reconcileInterruptedTransfers()).toBe(0);
    expect((await b.getByUser(OWNER_ID, row.id))?.state).toBe("running");
    const cancelled = right.cancelTransfer(OWNER_ID, row.id);
    await until(async () => {
      await a.maintain((row) => left.cancelOwned(row));
      return channel.pushed.some((m) => m.payload.case === "fileTransferCancel");
    });
    expect((await b.getByUser(OWNER_ID, row.id))?.state).toBe("running");
    const ack = create(AgentMessageSchema, {
      payload: { case: "fileTransferProgress", value: { requestId: attempt, state: "cancelled" } },
    });
    await receiveInteraction({ transferRegistry }, "another-agent", ack, () => {});
    expect((await b.getByUser(OWNER_ID, row.id))?.state).toBe("running");
    await receiveInteraction({ transferRegistry }, AGENT_ID, ack, () => {});
    expect((await cancelled).state).toBe("cancelled");
    expect(transferRegistry.update(attempt, { state: "running", copiedBytes: 1 }, AGENT_ID)).toBe(
      false,
    );
  });

  test("a cancellation in flight cannot report success after the active owner loses its lease", async () => {
    const owner = new PgFileTransferStore(db);
    const peer = new PgFileTransferStore(db);
    const service = new FileService(owner);
    const row = await service.createTransfer(OWNER_ID, transferData, OWNER_ID);
    const startedAt = new Date().toISOString();
    await owner.transition(OWNER_ID, row.id, "failed", { state: "running", startedAt });
    const pending = peer.coordinateCancel(OWNER_ID, row.id, async () => {
      throw new Error("wrong owner");
    });

    await until(async () =>
      Boolean(
        (
          await db
            .select({ token: fileTransfers.cancelRequest })
            .from(fileTransfers)
            .where(eq(fileTransfers.id, row.id))
        )[0]?.token,
      ),
    );
    await db
      .update(fileTransfers)
      .set({ dispatchExpiresAt: new Date(0) })
      .where(eq(fileTransfers.id, row.id));
    await peer.markInterrupted("TRANSFER_INTERRUPTED_BY_SERVER_RESTART");
    await expect(pending).rejects.toThrow("not accepted");
    expect((await peer.getByUser(OWNER_ID, row.id))?.state).toBe("failed");
    await expect(
      new PgTransferSessionStore(db, owner.serverId).verifyRunningOwner(OWNER_ID, row.id, db),
    ).rejects.toThrow("expired");
    expect(
      await owner.transition(OWNER_ID, row.id, "running", { state: "succeeded" }, startedAt),
    ).toBeNull();
  });

  test("only expired leases are recovered and a resumed queued upload retries cancellation cleanup", async () => {
    const a = new PgFileTransferStore(db),
      b = new PgFileTransferStore(db);
    const service = new FileService(a),
      remote = new FileService(b);
    const sessions = new PgTransferSessionStore(db, a.serverId);
    const row = await service.createTransfer(OWNER_ID, transferData, OWNER_ID);
    await a.transition(OWNER_ID, row.id, "failed", { state: "queued" });
    const saved = {
      source: transferData.source,
      target: transferData.target,
      agentId: AGENT_ID,
      size: 0,
      storageKey: `netdrive/objects/${randomUUID()}`,
      uploadId: "original",
      partSize: 5242880,
    };
    await new PgTransferSessionStore(db).save(OWNER_ID, row.id, saved);
    await db
      .update(fileTransfers)
      .set({ dispatchExpiresAt: new Date(0) })
      .where(eq(fileTransfers.id, row.id));
    expect(await remote.reconcileInterruptedTransfers()).toBe(1);
    expect(await a.transition(OWNER_ID, row.id, "queued", { state: "running" })).toBeNull();
    let aborts = 0;
    const dispatcher = new AgentDispatcher();
    dispatcher.register(AGENT_ID, new RecordingChannel());
    service.attachRunner(
      new TransferRunner({
        db,
        dispatcher,
        transferRegistry: new TransferRegistry(),
        sessionStore: sessions,
        netdriveService: {
          restoreMultipartSession: async () => ({ ...saved, commitToken: "restored" }),
          abortMultipart: async () => {
            if (++aborts === 1) throw new Error("Object store busy");
          },
        } as unknown as NetDriveService,
      }),
    );
    const guard = Promise.withResolvers<undefined>();
    await service.resumeTransfer(OWNER_ID, row.id, { beforeDispatch: () => guard.promise });
    const cancelled = remote.cancelTransfer(OWNER_ID, row.id);
    await until(async () => {
      await a.maintain((row) => service.cancelOwned(row));
      return aborts === 1;
    });
    expect((await sessions.load(OWNER_ID, row.id))?.uploadId).toBe("original");
    guard.resolve(undefined);
    await a.maintain((row) => service.cancelOwned(row));
    expect((await cancelled).state).toBe("cancelled");
    expect(aborts).toBe(2);
    expect(await sessions.load(OWNER_ID, row.id)).toBeUndefined();
  });

  test("pushes a FileTransferRequest carrying uploadId/commitToken/partSize", async () => {
    const { runner, channel } = makeRunner();
    await runner.start(OWNER_ID, "transfer-a", transferData, () => {});
    const req = fileTransferReq(channel);
    expect(req.direction).toBe("cluster_to_cloud");
    expect(req.sourcePath).toBe("/cluster/run1/out.dat");
    expect(req.uploadId).toMatch(/.+/);
    expect(req.commitToken.split(".")).toHaveLength(3);
    expect(req.partSize).toBeGreaterThanOrEqual(BigInt(5 * 1024 * 1024));
    expect(req.targetUrl).toBe("");
  });

  test("cancels the registry, aborts multipart, and notifies the selected Agent", async () => {
    const { runner, channel, transferRegistry } = makeRunner();
    await runner.start(OWNER_ID, "transfer-cancel", transferData, () => {});

    const cancellation = runner.cancel("transfer-cancel");
    transferRegistry.confirmCancellation(fileTransferReq(channel).requestId, AGENT_ID);
    expect(await cancellation).toBe(true);
    expect(channel.pushed.map((message) => message.payload.case)).toEqual([
      "fileTransferRequest",
      "fileTransferCancel",
    ]);
    expect(
      transferRegistry.update(fileTransferReq(channel).requestId, {
        copiedBytes: 1,
        state: "succeeded",
        sha256: "a".repeat(64),
        parts: [],
      }),
    ).toBe(false);
    await expect(runner.mintPartUrlsFor(fileTransferReq(channel).requestId, [1])).rejects.toThrow(
      "no pending multipart upload",
    );
  });

  test("rejects cancellation after a terminal event crosses the commit boundary", async () => {
    const { runner, channel, transferRegistry } = makeRunner();
    await runner.start(OWNER_ID, "transfer-terminal", transferData, () => {});

    expect(
      transferRegistry.update(fileTransferReq(channel).requestId, {
        copiedBytes: 0,
        state: "failed",
        error: "agent failed",
      }),
    ).toBe(true);
    expect(await runner.cancel("transfer-terminal")).toBe(false);
  });

  test("routes a transfer to the explicitly selected online agent", async () => {
    const transferRegistry = new TransferRegistry();
    const dispatcher = new AgentDispatcher();
    const first = new RecordingChannel();
    const second = new RecordingChannel();
    dispatcher.register(AGENT_ID, first);
    dispatcher.register(SECOND_AGENT_ID, second);
    const backend = new FakeMinioBackend();
    const netdriveService = new NetDriveService(db, backend, { commitSecret: COMMIT_SECRET });
    const targetedRunner = new TransferRunner({
      db,
      dispatcher,
      netdriveService,
      transferRegistry,
    });
    await targetedRunner.start(
      OWNER_ID,
      "transfer-selected-agent",
      { ...transferData, agentId: SECOND_AGENT_ID },
      () => {},
    );
    expect(first.pushed.length).toBe(0);
    expect(second.pushed.length).toBe(1);
  });

  test("cloud_to_cluster uses sourceFileId when the UI provides canonical NetDrive metadata", async () => {
    const { runner, channel } = makeRunner();
    await db.insert(netdriveFiles).values({
      id: NETDRIVE_FILE_ID,
      ownerId: OWNER_ID,
      path: "inputs/renamed.dat",
      size: 4,
      sha256: "c".repeat(64),
      contentType: "application/octet-stream",
      etag: "etag",
      storageKey: "netdrive/test/source-file-id.dat",
    });

    await runner.start(
      OWNER_ID,
      "transfer-source-id",
      {
        direction: "cloud_to_cluster",
        source: "inputs/display-name-can-drift.dat",
        target: "/scratch/run/source.dat",
        sourceFileId: NETDRIVE_FILE_ID,
      },
      () => {},
    );

    const req = fileTransferReq(channel);
    expect(req.direction).toBe("cloud_to_cluster");
    expect(req.sourceUrl).toContain(encodeURIComponent("netdrive/test/source-file-id.dat"));
    expect(req.targetPath).toBe("/scratch/run/source.dat");
  });

  test("cloud_to_cluster mints a shared source URL only after rechecking netdrive_file use", async () => {
    const checks: AuthzCheck[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (check: AuthzCheck) => {
        checks.push(check);
      },
      enqueueMany: async () => undefined,
    } as unknown as AuthzService;
    const { runner, channel } = makeRunner(authz);
    await db.insert(netdriveFiles).values({
      id: NETDRIVE_FILE_ID,
      ownerId: OWNER_ID,
      path: "shared/input.dat",
      size: 4,
      sha256: "c".repeat(64),
      contentType: "application/octet-stream",
      etag: "etag",
      storageKey: "netdrive/test/shared-source.dat",
    });

    await runner.start(
      SHARED_ACTOR_ID,
      "transfer-shared-source",
      {
        direction: "cloud_to_cluster",
        source: "shared/input.dat",
        target: "/scratch/run/input.dat",
        sourceFileId: NETDRIVE_FILE_ID,
      },
      () => {},
    );

    expect(fileTransferReq(channel).sourceUrl).toContain(
      encodeURIComponent("netdrive/test/shared-source.dat"),
    );
    expect(checks).toEqual([
      expect.objectContaining({
        actorUserId: SHARED_ACTOR_ID,
        resource: { type: "netdrive_file", id: NETDRIVE_FILE_ID },
        permission: "use",
        subject: { type: "user", id: SHARED_ACTOR_ID },
      }),
    ]);
  });

  test("cloud_to_cluster rejects a shared source when runner authorization is revoked", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new Error("denied");
      },
      enqueueMany: async () => undefined,
    } as unknown as AuthzService;
    const { runner, channel } = makeRunner(authz);
    await db.insert(netdriveFiles).values({
      id: NETDRIVE_FILE_ID,
      ownerId: OWNER_ID,
      path: "shared/input.dat",
      size: 4,
      sha256: "c".repeat(64),
      contentType: "application/octet-stream",
      etag: "etag",
      storageKey: "netdrive/test/shared-source.dat",
    });

    await expect(
      runner.start(
        SHARED_ACTOR_ID,
        "transfer-shared-revoked",
        {
          direction: "cloud_to_cluster",
          source: "shared/input.dat",
          target: "/scratch/run/input.dat",
          sourceFileId: NETDRIVE_FILE_ID,
        },
        () => {},
      ),
    ).rejects.toThrow("NETDRIVE_SOURCE_FILE_UNAVAILABLE");
    expect(channel.pushed).toEqual([]);
  });

  test("cloud_to_cluster fails before NetDrive lookup when canonical sourceFileId is missing", async () => {
    const { runner, channel } = makeRunner();
    const events: Array<{ state: string; error?: string }> = [];

    await runner.start(
      OWNER_ID,
      "transfer-source-path-only",
      {
        direction: "cloud_to_cluster",
        source: "inputs/path-only.dat",
        target: "/scratch/run/path-only.dat",
      },
      (event) => events.push({ state: event.state, error: event.error }),
    );

    expect(events).toEqual([{ state: "failed", error: "NETDRIVE_SOURCE_FILE_ID_REQUIRED" }]);
    expect(channel.pushed).toEqual([]);
  });

  test("terminal succeeded event with parts completes multipart and inserts a row", async () => {
    const { runner, backend, channel, transferRegistry } = makeRunner();
    const events: { state: string; copiedBytes: number; netdriveFileIds?: string[] }[] = [];
    await runner.start(OWNER_ID, "transfer-b", transferData, (e) => {
      events.push({
        state: e.state,
        copiedBytes: e.copiedBytes,
        netdriveFileIds: e.netdriveFileIds,
      });
    });

    const req = fileTransferReq(channel);
    // Resolve the storageKey by minting part URLs (the fake URL encodes the key).
    const urls = await runner.mintPartUrlsFor(fileTransferReq(channel).requestId, [1, 2]);
    const keyFromUrl = decodeURIComponent(
      new URL(urls[0]?.url ?? "").pathname.replace(/^\/part\//, ""),
    );

    // The agent stages parts directly into MinIO via the presigned URLs.
    const e1 = await backend.putUploadedPart(keyFromUrl, req.uploadId, 1, Buffer.from("AAAA"));
    const e2 = await backend.putUploadedPart(keyFromUrl, req.uploadId, 2, Buffer.from("BB"));

    // The agent reports terminal success with the per-part ETags.
    const updated = transferRegistry.update(fileTransferReq(channel).requestId, {
      copiedBytes: 6,
      state: "succeeded",
      sha256: createHash("sha256").update("AAAABB").digest("hex"),
      parts: [
        { partNumber: 1, etag: e1.etag },
        { partNumber: 2, etag: e2.etag },
      ],
    });
    expect(updated).toBe(true);
    // The wrapped callback runs completeMultipart asynchronously (several DB
    // round-trips) and only then forwards the terminal progress event. Poll for
    // both effects so suite cleanup cannot race the transfer-log insert.
    let row: typeof netdriveFiles.$inferSelect | undefined;
    for (let i = 0; i < 100; i++) {
      const polled = await db
        .select()
        .from(netdriveFiles)
        .where(eq(netdriveFiles.ownerId, OWNER_ID));
      row = polled.find((r) => r.path === "outputs/run1/out.dat");
      if (row && events.some((e) => e.state === "succeeded")) break;
      await Bun.sleep(20);
    }
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("NetDrive row was not inserted");
    }
    expect(row.size).toBe(6);
    expect(row.sha256).toBe(createHash("sha256").update("AAAABB").digest("hex"));
    expect(events.find((e) => e.state === "succeeded")?.netdriveFileIds).toEqual([row.id]);
  });

  test("terminal succeeded event projects NetDrive file relationships", async () => {
    const enqueued: AuthzTuple[] = [];
    const { runner, backend, channel, transferRegistry } = makeRunner(capturingAuthz(enqueued));
    await runner.start(OWNER_ID, "transfer-authz", transferData, () => {});

    const req = fileTransferReq(channel);
    const urls = await runner.mintPartUrlsFor(fileTransferReq(channel).requestId, [1]);
    const keyFromUrl = decodeURIComponent(
      new URL(urls[0]?.url ?? "").pathname.replace(/^\/part\//, ""),
    );
    const part = await backend.putUploadedPart(keyFromUrl, req.uploadId, 1, Buffer.from("CCCC"));
    const updated = transferRegistry.update(fileTransferReq(channel).requestId, {
      copiedBytes: 4,
      state: "succeeded",
      sha256: createHash("sha256").update("CCCC").digest("hex"),
      parts: [{ partNumber: 1, etag: part.etag }],
    });
    expect(updated).toBe(true);

    let row: typeof netdriveFiles.$inferSelect | undefined;
    for (let i = 0; i < 100; i++) {
      const polled = await db
        .select()
        .from(netdriveFiles)
        .where(eq(netdriveFiles.ownerId, OWNER_ID));
      row = polled.find((r) => r.path === "outputs/run1/out.dat");
      if (row && enqueued.length === 3) break;
      await Bun.sleep(20);
    }
    expect(row).toBeDefined();
    if (!row) {
      throw new Error("NetDrive row was not inserted");
    }
    const fileId = row.id;
    expect(enqueued).toEqual([
      {
        operation: "create",
        resource: { type: "netdrive_file", id: fileId },
        relation: "owner",
        subject: { type: "user", id: OWNER_ID },
      },
      {
        operation: "create",
        resource: { type: "netdrive_file", id: fileId },
        relation: "platform",
        subject: { type: "platform", id: "root" },
      },
      {
        operation: "create",
        resource: { type: "netdrive_file", id: fileId },
        relation: "consumer_org",
        subject: { type: "organization", id: ORG_ID },
      },
    ]);
  });

  test("fails without a canonical actor user id instead of resolving by email", async () => {
    const { runner, channel } = makeRunner();
    const events: { state: string; error: string | null }[] = [];
    await runner.start(null, "transfer-missing-actor", transferData, (e) => {
      events.push({ state: e.state, error: e.error ?? null });
    });
    expect(channel.pushed.length).toBe(0);
    expect(events).toEqual([{ state: "failed", error: "user not found" }]);
  });
});
