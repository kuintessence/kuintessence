import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  agents,
  artifactReplicas,
  createPgDb,
  fileTransfers,
  jobs,
  netdriveFiles,
  users,
  workflowArtifactFiles,
  workflowArtifacts,
  workflowRuns,
} from "@kuintessence/db";
import { createUsecaseExecutor, type JobSubmission, workflowDsl } from "@kuintessence/shared";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { artifactBatchHash } from "./artifact-members";
import { PgArtifactStore, WorkflowArtifactService } from "./workflow-artifact";
import { publishSandboxArtifactFile, WorkflowArtifactFiles } from "./workflow-artifact-files";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Artifact file tests require an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const ownerId = randomUUID();
const agentId = `artifact-${randomUUID()}`;
const runIds: string[] = [];
const store = new PgArtifactStore(db);
beforeAll(async () => {
  await db.insert(users).values({ id: ownerId, email: `${ownerId}@test.invalid`, role: "user" });
  await db.insert(agents).values({
    agentId,
    siteName: "Isolated",
    siteId: "site",
    clusterId: "cluster",
    schedulerType: "slurm",
    schedulerVersion: "test",
  });
});
afterAll(async () => {
  if (runIds.length) await db.delete(workflowRuns).where(inArray(workflowRuns.id, runIds));
  await db.delete(jobs).where(eq(jobs.submittedBy, ownerId));
  await db.delete(agents).where(eq(agents.agentId, agentId));
  await db.delete(users).where(eq(users.id, ownerId));
  await db.$client.end({ timeout: 5 });
});
async function fixture(
  batch: boolean,
  durability: "Ephemeral" | "Persistent" | "Checkpoint" = "Ephemeral",
) {
  const workflowRunId = randomUUID();
  runIds.push(workflowRunId);
  await db.insert(workflowRuns).values({
    id: workflowRunId,
    name: "Artifact bridge",
    status: "running",
    submittedBy: ownerId,
  });
  const [producer] = await db
    .insert(jobs)
    .values({
      name: "producer",
      cpus: 1,
      memoryMb: 64,
      command: "true",
      submittedBy: ownerId,
      status: "completed",
      agentId,
    })
    .returning();
  if (!producer) throw new Error("Missing producer");
  const fileMembers = batch
    ? [
        { relativePath: "a.dat", sha256: "a".repeat(64), sizeBytes: 2 },
        { relativePath: "nested/b.dat", sha256: "b".repeat(64), sizeBytes: 3 },
      ]
    : null;
  const registration = {
    workflowRunId,
    producerNodeId: "producer",
    producerJobId: producer.id,
    descriptor: "result",
    ioType: batch ? ("FileBatch" as const) : ("File" as const),
    contentHash: fileMembers ? artifactBatchHash(fileMembers) : "c".repeat(64),
    sizeBytes: fileMembers ? 5 : 4,
    durability,
    ownerId,
    agentId,
    siteId: "site",
    clusterId: "cluster",
    storageRef: "/isolated/result",
    fileMembers,
  };
  const { artifact, replica } = await store.registerLocal(registration);
  const attempts: string[] = [];
  let failure = "";
  let loseReceipt = false;
  const publish: ConstructorParameters<typeof WorkflowArtifactFiles>[1] = (input) =>
    publishSandboxArtifactFile(
      input,
      async (transfer) => {
        const ids = await db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${transfer.transferId},0))`,
          );
          const [receipt] = await tx
            .select()
            .from(fileTransfers)
            .where(eq(fileTransfers.id, transfer.transferId));
          if (receipt) {
            expect(transfer.target).toBe(receipt.target);
            return receipt.netdriveFileIds;
          }
          attempts.push(input.source);
          if (input.source === failure) throw new Error("transfer offline");
          const [file] = await tx
            .insert(netdriveFiles)
            .values({
              ownerId,
              path: transfer.target,
              storageKey: transfer.target,
              sha256: input.sha256,
              size: input.sizeBytes,
            })
            .returning();
          if (!file) throw new Error("Missing uploaded file");
          await tx.insert(fileTransfers).values({
            id: transfer.transferId,
            userId: ownerId,
            state: "succeeded",
            direction: "cluster_to_cloud",
            source: transfer.source,
            workflowRunId: transfer.workflowRunId,
            agentId: transfer.agentId,
            jobId: transfer.jobId,
            target: transfer.target,
            netdriveFileIds: [file.id],
          });
          return [file.id];
        });
        if (loseReceipt) {
          loseReceipt = false;
          throw new Error("Lost commit response");
        }
        return ids;
      },
      {
        getFileById: async (id) =>
          (
            await db
              .select()
              .from(netdriveFiles)
              .where(and(eq(netdriveFiles.id, id), isNull(netdriveFiles.deletedAt)))
          )[0] ?? null,
      },
    );
  const make = () => {
    const bridge = new WorkflowArtifactFiles(db, publish);
    const service = new WorkflowArtifactService(store, bridge);
    return {
      bridge,
      service,
      resolve: (value: unknown, scope = { workflowRunId, ownerId }) =>
        bridge.resolve(value, scope, service),
    };
  };
  return {
    workflowRunId,
    producer,
    artifact,
    replica,
    registration,
    make,
    attempts,
    loseReceipt: () => {
      loseReceipt = true;
    },
    ref: { artifactId: artifact.id, type: artifact.ioType },
    fail: (source: string) => {
      failure = source;
    },
  };
}

async function orphan(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  sha256: string,
  size: number,
  source: string,
) {
  const path = `workflow-runs/${f.workflowRunId}/artifacts/${f.artifact.id}/copies/${randomUUID()}/${name}`;
  const [file] = await db
    .insert(netdriveFiles)
    .values({ ownerId, path, storageKey: randomUUID(), size, sha256 })
    .returning();
  if (!file) throw new Error("Missing fixture file");
  await db.insert(fileTransfers).values({
    id: randomUUID(),
    userId: ownerId,
    state: "succeeded",
    direction: "cluster_to_cloud",
    agentId,
    workflowRunId: f.workflowRunId,
    jobId: f.producer.id,
    source,
    target: path,
    netdriveFileIds: [file.id],
  });
  return file;
}

test("a successful transfer with a random copy path restores an unmapped file after its local replica expires", async () => {
  const f = await fixture(false, "Checkpoint");
  const { contentHash, sizeBytes } = f.artifact;
  const unrelated = await orphan(f, "result", contentHash, sizeBytes, f.replica.storageRef);
  await db
    .update(fileTransfers)
    .set({ netdriveFileIds: [randomUUID()] })
    .where(eq(fileTransfers.target, unrelated.path));
  await orphan(f, "result", contentHash, sizeBytes, "/another/source");
  await orphan(f, "result.extra", contentHash, sizeBytes, f.replica.storageRef);
  await orphan(f, "result", "a".repeat(64), sizeBytes, f.replica.storageRef);
  await db
    .update(artifactReplicas)
    .set({ status: "expired" })
    .where(eq(artifactReplicas.id, f.replica.id));
  await expect(f.make().resolve(f.ref)).rejects.toThrow("no verified local replica");
  const file = await orphan(f, "result", contentHash, sizeBytes, f.replica.storageRef);
  await f.make().service.awaitCheckpointPersistence(f.workflowRunId);
  expect(await f.make().resolve(f.ref)).toEqual({
    fileMetadataId: file.id,
    fileMetadataName: "result",
  });
  expect(await store.pendingPersistence(f.workflowRunId)).toEqual([]);
  expect(f.attempts).toEqual([]);
});

test("partial batch recovery reuses verified nested receipts and waits for a live source for missing members", async () => {
  const f = await fixture(true);
  const file = await orphan(f, "nested/b.dat", "b".repeat(64), 3, "/isolated/result/nested/b.dat");
  await db
    .update(artifactReplicas)
    .set({ expiresAt: new Date(0) })
    .where(eq(artifactReplicas.id, f.replica.id));
  await expect(f.make().resolve(f.ref)).rejects.toThrow("awaits a verified local replica");
  expect(f.attempts).toEqual([]);
  await store.registerLocal(f.registration);
  const files = await f.make().resolve(f.ref);
  expect(files).toContainEqual({
    fileMetadataId: file.id,
    fileMetadataName: "nested/b.dat",
    relativePath: "nested/b.dat",
  });
  expect(f.attempts).toEqual(["/isolated/result/a.dat"]);
});

test.each([
  false,
  true,
])("soft-deleted persistent files are repaired on job replay (batch=%s)", async (batch) => {
  const f = await fixture(batch, "Persistent");
  const result = await f.make().resolve(f.ref);
  const id = (Array.isArray(result) ? result[0] : result) as { fileMetadataId: string };
  await db
    .update(netdriveFiles)
    .set({ deletedAt: new Date() })
    .where(eq(netdriveFiles.id, id.fileMetadataId));
  expect(await store.pendingPersistence(f.workflowRunId)).toHaveLength(1);
  const before = f.attempts.length;
  const repaired = await f.make().service.registerLocal(f.registration);
  expect(repaired.persistentAt).toBeInstanceOf(Date);
  if (!batch) expect(repaired.netdriveFileId).not.toBe(id.fileMetadataId);
  expect(f.attempts.length).toBe(before + 1);
  expect(await store.pendingPersistence(f.workflowRunId)).toHaveLength(0);
  expect(await f.make().resolve(f.ref)).not.toEqual(result);
});

test("GC rebuilds a missed expiry from the run end and a replay cannot revive a released source", async () => {
  const f = await fixture(false);
  const finished = new Date("2026-01-05T00:00:00Z");
  const deadline = new Date("2026-01-06T00:00:00Z");
  const removed: string[] = [];
  const gc = new WorkflowArtifactService(store, undefined, async (item) => {
    removed.push(item.storageRef);
  });
  await db
    .update(workflowRuns)
    .set({ status: "completed", completedAt: finished })
    .where(eq(workflowRuns.id, f.workflowRunId));
  expect(await gc.collectGarbage(new Date(deadline.getTime() - 1))).toBe(0);
  const replay = await store.registerLocal(f.registration);
  expect(replay.replica.expiresAt).toEqual(deadline);
  await gc.markWorkflowTerminal(f.workflowRunId, new Date(deadline));
  expect(await gc.collectGarbage(deadline)).toBe(1);
  expect(removed).toEqual([f.replica.storageRef]);
  expect((await store.registerLocal(f.registration)).replica.status).toBe("expired");
  const late = await store.registerLocal({
    ...f.registration,
    descriptor: "extra",
    storageRef: "/isolated/extra",
  });
  expect(late.replica.expiresAt).toEqual(deadline);
  expect(await gc.collectGarbage(deadline)).toBe(1);
  expect(removed).toEqual([f.replica.storageRef, "/isolated/extra"]);
});

test("a replaced mutable output at a released path is scheduled for cleanup again", async () => {
  const f = await fixture(false);
  const input = {
    ...f.registration,
    producerJobId: null,
    descriptor: "scratch",
    storageRef: "/isolated/scratch",
  };
  const { replica } = await store.registerLocal(input);
  const terminal = new Date("2026-02-01T00:00:00Z"),
    deadline = new Date("2026-02-02T00:00:00Z");
  await db
    .update(workflowRuns)
    .set({ status: "completed", completedAt: terminal })
    .where(eq(workflowRuns.id, f.workflowRunId));
  await store.expireEphemeral(f.workflowRunId, 86400000);
  const removed: string[] = [];
  const release = async (item: { storageRef: string }) => {
    removed.push(item.storageRef);
  };
  expect(await store.releaseExpired(replica.id, deadline, release)).toBe(true);
  const replacement = await store.registerLocal({ ...input, contentHash: "d".repeat(64) });
  expect(replacement.replica.expiresAt).toEqual(deadline);
  expect(await store.releaseExpired(replacement.replica.id, deadline, release)).toBe(true);
  expect(removed).toEqual([input.storageRef, input.storageRef]);
  await store.releaseExpired(f.replica.id, deadline, release);
});

test("GC preserves active and durable sources and drains only the current release on shutdown", async () => {
  const active = await fixture(false),
    durable = await fixture(false, "Checkpoint"),
    ephemeral = await fixture(false);
  const second = await store.registerLocal({
    ...ephemeral.registration,
    descriptor: "second",
    storageRef: "/isolated/second",
  });
  const finished = new Date("2026-01-05T00:00:00Z"),
    now = new Date("2026-01-07T00:00:00Z");
  await db
    .update(workflowRuns)
    .set({ status: "failed", completedAt: finished })
    .where(inArray(workflowRuns.id, [durable.workflowRunId, ephemeral.workflowRunId]));
  await db
    .update(artifactReplicas)
    .set({ expiresAt: finished })
    .where(inArray(artifactReplicas.id, [active.replica.id, durable.replica.id]));
  const stop = new AbortController();
  const removed: string[] = [];
  const gc = new WorkflowArtifactService(store, undefined, async (replica) => {
    removed.push(replica.id);
    stop.abort();
  });
  expect(await gc.collectGarbage(now, stop.signal)).toBe(1);
  expect(await gc.collectGarbage(now)).toBe(1);
  expect(removed.sort()).toEqual([ephemeral.replica.id, second.replica.id].sort());
  expect(
    (await store.availableReplicas([durable.artifact.id, active.artifact.id]))
      .map((item) => item.id)
      .sort(),
  ).toEqual([durable.replica.id, active.replica.id].sort());
});

test("GC rechecks expiry, skips in-flight releases and retries a missing Agent acknowledgement", async () => {
  const f = await fixture(false);
  const deadline = new Date("2026-03-03T00:00:00Z");
  await db
    .update(workflowRuns)
    .set({ status: "cancelled", completedAt: new Date("2026-03-02T00:00:00Z") })
    .where(eq(workflowRuns.id, f.workflowRunId));
  await store.expireEphemeral(f.workflowRunId, 86400000);
  expect(await store.collectExpired(deadline)).toContain(f.replica.id);
  const extend = new Date(deadline.getTime() + 60000);
  await db
    .update(artifactReplicas)
    .set({ expiresAt: extend })
    .where(eq(artifactReplicas.id, f.replica.id));
  let releases = 0;
  const ack = Promise.withResolvers<void>(),
    started = Promise.withResolvers<void>();
  const release = async () => {
    releases++;
    started.resolve();
    await ack.promise;
  };
  expect(await store.releaseExpired(f.replica.id, deadline, release)).toBe(false);
  expect(releases).toBe(0);
  const first = store.releaseExpired(f.replica.id, extend, release);
  await started.promise;
  try {
    expect(
      await new PgArtifactStore(db).releaseExpired(f.replica.id, extend, async () => {
        releases++;
      }),
    ).toBe(false);
  } finally {
    ack.reject(new Error("Agent offline"));
    await expect(first).rejects.toThrow("Agent offline");
  }
  expect(releases).toBe(1);
  expect(await store.collectExpired(extend)).toContain(f.replica.id);
  expect(
    await store.releaseExpired(f.replica.id, extend, async () => {
      releases++;
    }),
  ).toBe(true);
  expect(await store.collectExpired(extend)).not.toContain(f.replica.id);
  expect(releases).toBe(2);
});

test("a late failure from a concurrent publisher leaves the committed replica available", async () => {
  const f = await fixture(false);
  const attempt = await store.beginPersistence(f.artifact, f.replica);
  await f.make().resolve(f.ref);
  await store.failPersistence(attempt.id, "delayed failure");
  expect(
    (await store.availableReplicas([f.artifact.id])).some((replica) => replica.id === attempt.id),
  ).toBe(true);
});

test("single-file bridge shares concurrent publication, keeps references stable, and checks scope and export policy", async () => {
  const f = await fixture(false);
  const first = f.make();
  await expect(first.resolve(f.ref, { workflowRunId: randomUUID(), ownerId })).rejects.toThrow(
    "scope",
  );
  await expect(
    first.resolve(f.ref, { workflowRunId: f.workflowRunId, ownerId: randomUUID() }),
  ).rejects.toThrow("scope");
  await expect(first.resolve({ ...f.ref, type: "FileBatch" })).rejects.toThrow("type");
  expect(f.attempts).toHaveLength(0);
  const files = await Promise.all(Array.from({ length: 8 }, () => first.resolve(f.ref)));
  expect(f.attempts).toEqual(["/isolated/result"]);
  expect(files.every((file) => JSON.stringify(file) === JSON.stringify(files[0]))).toBe(true);
  expect(await f.make().resolve(f.ref)).toEqual(files[0]);
  expect(await f.make().resolve([f.ref])).toEqual([files[0]]);
  await db.update(jobs).set({ restrictedNoEgress: true }).where(eq(jobs.id, f.producer.id));
  await expect(first.resolve(f.ref)).rejects.toThrow("does not permit file export");
  expect(f.attempts).toHaveLength(1);
});

test("a fresh Sandbox publisher recovers the exact committed receipt after a lost response", async () => {
  const f = await fixture(false);
  f.loseReceipt();
  await expect(f.make().resolve(f.ref)).rejects.toThrow("publication is pending");
  await f.make().resolve(f.ref);
  expect(f.attempts).toEqual(["/isolated/result"]);
  const receipts = await db
    .select()
    .from(fileTransfers)
    .where(eq(fileTransfers.source, "/isolated/result"));
  expect(receipts.filter((row) => row.target.includes(f.artifact.id))).toHaveLength(1);
});

test("a delayed publisher reuses the live file despite its stale snapshot and replaces a deleted file", async () => {
  const f = await fixture(false);
  const first = f.make();
  const original = await first.resolve(f.ref);
  expect(f.artifact.netdriveFileId).toBeNull();
  await first.service.persist({ artifact: f.artifact, replica: f.replica }, ownerId);
  expect(f.attempts).toEqual(["/isolated/result"]);
  expect(await first.resolve(f.ref)).toEqual(original);
  const [current] = await db
    .select()
    .from(workflowArtifacts)
    .where(eq(workflowArtifacts.id, f.artifact.id));
  if (!current?.netdriveFileId) throw new Error("Missing live file");
  await db.delete(netdriveFiles).where(eq(netdriveFiles.id, current.netdriveFileId));
  await first.service.persist({ artifact: f.artifact, replica: f.replica }, ownerId);
  expect(f.attempts).toEqual(["/isolated/result", "/isolated/result"]);
  expect(await first.resolve(f.ref)).not.toEqual(original);
});

test("FileBatch resumes from immutable member mappings and feeds a software node with nested file paths", async () => {
  const f = await fixture(true);
  f.fail("/isolated/result/nested/b.dat");
  await expect(f.make().resolve(f.ref)).rejects.toThrow("publication is pending");
  const [saved] = await db
    .select()
    .from(workflowArtifactFiles)
    .where(eq(workflowArtifactFiles.artifactId, f.artifact.id));
  expect(saved?.relativePath).toBe("a.dat");
  f.fail("");
  const fresh = f.make();
  const files = await fresh.resolve(f.ref);
  expect(f.attempts).toEqual([
    "/isolated/result/a.dat",
    "/isolated/result/nested/b.dat",
    "/isolated/result/nested/b.dat",
  ]);
  expect(await fresh.resolve(f.ref)).toEqual(files);
  expect(
    (
      await db
        .select()
        .from(workflowArtifactFiles)
        .where(eq(workflowArtifactFiles.artifactId, f.artifact.id))
    ).find((row) => row.relativePath === "a.dat")?.netdriveFileId,
  ).toBe(saved?.netdriveFileId);
  let submission: JobSubmission | undefined;
  const executor = createUsecaseExecutor({
    resolveFileInput: fresh.resolve,
    resolvePackage: async () => ({
      usecase: {
        commandFile: "true",
        inputSlots: [
          {
            kind: "File",
            descriptor: "data",
            refMaterials: [{ kind: "FileInputRef", descriptor: "data" }],
          },
        ],
      },
      software: { kind: "Bare" },
      arguments: [],
      environments: [],
      filesomeInputs: [{ descriptor: "data", fileKind: { kind: "Batched", pattern: "inputs/*" } }],
      filesomeOutputs: [],
      valueOutputs: [],
    }),
    submitJob: async (spec) => {
      submission = spec;
      return { jobId: randomUUID(), status: "completed", collected: {} };
    },
  });
  const downstream = workflowDsl.WorkflowNodeSchema.parse({
    type: "SoftwareUsecaseComputing",
    id: "downstream",
    name: "downstream",
    usecaseVersionId: randomUUID(),
    softwareVersionId: randomUUID(),
    inputSlots: [
      {
        type: "File",
        descriptor: "data",
        isBatch: true,
        from: { node: "producer", output: "result" },
      },
    ],
  });
  expect(
    (
      await executor(downstream, {
        nodes: { producer: { status: "Succeeded", values: { result: f.ref } } },
      })
    ).status,
  ).toBe("Succeeded");
  expect(submission?.inputStaging.map((file) => file.stagePath)).toEqual([
    "inputs/a.dat",
    "inputs/nested/b.dat",
  ]);
  expect(submission?.inputStaging[0]?.fileMetadataId).toBe(saved?.netdriveFileId ?? "missing");
});

test("batch manifests cannot change on replay and deleted member files are republished", async () => {
  const f = await fixture(true);
  const first = f.make();
  await first.resolve(f.ref);
  const [member] = await db
    .select()
    .from(workflowArtifactFiles)
    .where(eq(workflowArtifactFiles.artifactId, f.artifact.id));
  if (!member?.netdriveFileId) throw new Error("Missing saved member");
  await db.delete(netdriveFiles).where(eq(netdriveFiles.id, member.netdriveFileId));
  const checkpoint = { ...f.registration, durability: "Checkpoint" as const };
  await db
    .update(workflowArtifacts)
    .set({ durability: "Checkpoint" })
    .where(eq(workflowArtifacts.id, f.artifact.id));
  expect(await store.pendingPersistence(f.workflowRunId)).toHaveLength(1);
  await first.service.awaitCheckpointPersistence(f.workflowRunId);
  expect(await store.pendingPersistence(f.workflowRunId)).toEqual([]);
  expect(f.attempts).toHaveLength(3);
  const changed = [{ relativePath: "changed.dat", sha256: "d".repeat(64), sizeBytes: 5 }];
  await expect(
    store.registerLocal({
      ...checkpoint,
      fileMembers: changed,
      contentHash: artifactBatchHash(changed),
    }),
  ).rejects.toThrow("immutable");
});

test("independent publishers preserve the first live file mapping", async () => {
  const f = await fixture(false);
  const results = await Promise.all([f.make().resolve(f.ref), f.make().resolve(f.ref)]);
  expect(results[0]).toEqual(results[1]);
  expect(await f.make().resolve(f.ref)).toEqual(results[0]);
  const copies = await db.select().from(netdriveFiles).where(eq(netdriveFiles.ownerId, ownerId));
  const paths = copies.filter((file) => file.path.includes(f.artifact.id)).map((file) => file.path);
  expect(new Set(paths).size).toBe(paths.length);
});

test("empty batches are distinct from missing manifests and complete without file uploads", async () => {
  const f = await fixture(true);
  const [empty] = await db
    .insert(workflowArtifacts)
    .values({
      workflowRunId: f.workflowRunId,
      producerNodeId: "producer",
      producerJobId: f.producer.id,
      descriptor: "empty",
      ioType: "FileBatch",
      contentHash: artifactBatchHash([]),
      sizeBytes: 0,
      durability: "Checkpoint",
      fileMembers: [],
    })
    .returning();
  if (!empty) throw new Error("Missing empty batch");
  const bridge = f.make();
  expect(await bridge.resolve({ artifactId: empty.id, type: "FileBatch" })).toEqual([]);
  expect(f.attempts).toHaveLength(0);
  await db
    .update(workflowArtifacts)
    .set({ fileMembers: null })
    .where(eq(workflowArtifacts.id, empty.id));
  await expect(bridge.resolve({ artifactId: empty.id, type: "FileBatch" })).rejects.toThrow(
    "verified manifest",
  );
});
