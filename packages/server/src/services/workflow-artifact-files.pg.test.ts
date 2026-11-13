import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  agents,
  createPgDb,
  jobs,
  netdriveFiles,
  users,
  workflowArtifactFiles,
  workflowArtifacts,
  workflowRuns,
} from "@kuintessence/db";
import { createUsecaseExecutor, type JobSubmission, workflowDsl } from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import { artifactBatchHash } from "./artifact-members";
import { PgArtifactStore, WorkflowArtifactService } from "./workflow-artifact";
import { WorkflowArtifactFiles } from "./workflow-artifact-files";

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
async function fixture(batch: boolean) {
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
    durability: "Ephemeral" as const,
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
  const publish: ConstructorParameters<typeof WorkflowArtifactFiles>[1] = async (input) => {
    attempts.push(input.source);
    if (input.source === failure) throw new Error("transfer offline");
    const [file] = await db
      .insert(netdriveFiles)
      .values({
        ownerId: input.ownerId,
        path: input.target,
        storageKey: input.target,
        sha256: input.sha256,
        size: input.sizeBytes,
      })
      .returning();
    if (!file) throw new Error("Missing uploaded file");
    return { netdriveFileId: file.id, storageRef: file.path };
  };
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
    ref: { artifactId: artifact.id, type: artifact.ioType },
    fail: (source: string) => {
      failure = source;
    },
  };
}

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
