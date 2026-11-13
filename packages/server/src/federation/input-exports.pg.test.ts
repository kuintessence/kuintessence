import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  auditLog,
  createPgDb,
  federationCapabilities,
  federationWorkflowInputExports,
  netdriveFiles,
  orgs,
  userOrgMemberships,
  users,
  workflowRuns,
} from "@kuintessence/db";
import { WorkflowExecutionInterrupted } from "@kuintessence/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { WorkflowExecutionJournalStore } from "../workflow/execution-journal";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { FederationWorkflowInputExports } from "./input-exports";
import { FederationPermissionService } from "./permissions";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Isolated input export database required");
const db = createPgDb(url, { max: 6, idle_timeout: 1 });
const actor = { userId: crypto.randomUUID(), orgId: crypto.randomUUID() };
const other = { userId: crypto.randomUUID(), orgId: actor.orgId };
const service = new FederationWorkflowInputExports();
const permission = new FederationPermissionService(db);
const runs: string[] = [],
  files: string[] = [];
beforeAll(async () => {
  await db.insert(orgs).values({ id: actor.orgId, name: "Input export test" });
  await db
    .insert(users)
    .values([actor, other].map((who) => ({ id: who.userId, email: `${who.userId}@test.invalid` })));
  await db
    .insert(userOrgMemberships)
    .values([actor, other].map((who) => ({ ...who, role: "member" })));
  for (const who of [actor, other])
    await permission.set({ ...who, capability: "delegation.submit", enabled: true }, actor.userId);
});
afterAll(async () => {
  if (runs.length) await db.delete(workflowRuns).where(inArray(workflowRuns.id, runs));
  if (files.length) await db.delete(netdriveFiles).where(inArray(netdriveFiles.id, files));
  await db.delete(federationCapabilities).where(eq(federationCapabilities.orgId, actor.orgId));
  await db.delete(auditLog).where(eq(auditLog.orgId, actor.orgId));
  await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, actor.orgId));
  await db.delete(users).where(inArray(users.id, [actor.userId, other.userId]));
  await db.delete(orgs).where(eq(orgs.id, actor.orgId));
  await db.$client.end();
});

async function fixture() {
  const runId = crypto.randomUUID(),
    fileId = crypto.randomUUID();
  runs.push(runId);
  files.push(fileId);
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Source input run",
    status: "running",
    submittedBy: actor.userId,
    input: { executionModel: "durable-v2", orgId: actor.orgId, role: "user", yaml: "" },
  });
  const original = {
    id: fileId,
    ownerId: actor.userId,
    path: "private-source-folder/source.dat",
    size: 4,
    sha256: "a".repeat(64),
    storageKey: `private-object/${fileId}`,
    storageVersionId: "version-1",
  };
  await db.insert(netdriveFiles).values(original);
  const journal = new WorkflowExecutionJournalStore(db);
  const lease = await journal.acquire(runId);
  if (!lease) throw new Error("Missing lease");
  const invocation = { path: JSON.stringify(["node", "remote"]) };
  const selection = [{ descriptor: "input", type: "File", files: [{ fileId, path: "input.dat" }] }];
  const capture = (raw: unknown = selection) =>
    service.capture(actor, lease, "remote", invocation, raw);
  return { runId, fileId, original, journal, lease, invocation, selection, capture };
}

test("input snapshots are scoped, private, idempotent and fixed across recovery and loop calls", async () => {
  const f = await fixture();
  const results = await Promise.all([f.capture(), f.capture(), f.capture()]);
  expect(new Set(results.map((result) => result.exportId)).size).toBe(1);
  const saved = results[0];
  if (!saved) throw new Error("Missing export");
  expect(saved.manifest.inputs).toEqual([
    {
      descriptor: "input",
      type: "File",
      files: [{ path: "input.dat", sha256: "a".repeat(64), sizeBytes: 4 }],
    },
  ]);
  for (const privateValue of [
    f.fileId,
    f.original.path,
    f.original.storageKey,
    f.original.storageVersionId,
    actor.userId,
  ])
    expect(JSON.stringify(saved)).not.toContain(privateValue);
  const audit = await db.select().from(auditLog).where(eq(auditLog.target, saved.exportId));
  expect(audit).toHaveLength(1);
  expect(audit[0]?.action).toBe("federation.input.snapshot");
  expect(JSON.stringify(audit)).not.toContain(f.fileId);
  await f.lease.release();
  const lease = await f.journal.acquire(f.runId);
  if (!lease) throw new Error("Missing restored lease");
  expect(
    await new FederationWorkflowInputExports().capture(
      actor,
      lease,
      "remote",
      f.invocation,
      f.selection,
    ),
  ).toEqual(saved);
  const loop = await service.capture(
    actor,
    lease,
    "remote",
    { path: JSON.stringify(["node", "each", "iteration", 1, "node", "remote"]) },
    f.selection,
  );
  expect(loop.exportId).not.toBe(saved.exportId);
  expect(loop.manifestDigest).toBe(saved.manifestDigest);
  const resolved = await db.transaction((tx) =>
    service.resolve(tx, actor, f.runId, saved.exportId),
  );
  expect(resolved.bindings[0]?.versionId).toBe("version-1");
  await expect(
    service.capture(actor, lease, "changed", f.invocation, f.selection),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await expect(
    service.capture(actor, lease, "remote", f.invocation, [
      { ...f.selection[0], files: [{ fileId: f.fileId, path: "changed.dat" }] },
    ]),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await expect(
    db.transaction((tx) => service.resolve(tx, other, f.runId, saved.exportId)),
  ).rejects.toThrow("POLICY_DENIED");
  await lease.release();
});

test("input snapshot preparation validates paths, unique descriptors, total limits and empty batches", async () => {
  const f = await fixture();
  const member = { fileId: f.fileId, path: "a" };
  const group = { descriptor: "input", type: "FileBatch", files: [member] };
  for (const invalid of [
    [group, group],
    [{ ...group, files: [member, member] }],
    [{ ...group, files: [member, { ...member, path: "a/b" }] }],
    [{ ...group, files: [{ ...member, path: "../secret" }] }],
    [{ ...group, files: [{ ...member, path: "/absolute" }] }],
    [{ ...group, files: [{ ...member, path: "a\\b" }] }],
    [{ ...group, files: [{ ...member, path: "a\u0000b" }] }],
    [{ ...group, descriptor: "__proto__" }],
    [{ ...group, type: "File", files: [] }],
    [
      {
        ...group,
        files: Array.from({ length: 257 }, (_, i) => ({ ...member, path: `file-${i}` })),
      },
    ],
    [{ ...group, storageKey: "injected" }],
  ])
    await expect(f.capture(invalid)).rejects.toThrow("INVALID_MESSAGE");
  expect(
    await db
      .select()
      .from(federationWorkflowInputExports)
      .where(eq(federationWorkflowInputExports.runId, f.runId)),
  ).toHaveLength(0);
  const empty = await f.capture([{ ...group, files: [] }]);
  expect(empty.manifest.inputs[0]?.files).toEqual([]);
  await f.lease.release();
});

test("unversioned and foreign files cannot be captured and byte totals cannot overflow", async () => {
  const f = await fixture();
  for (const storageVersionId of [null, "null", ""]) {
    await db.update(netdriveFiles).set({ storageVersionId }).where(eq(netdriveFiles.id, f.fileId));
    await expect(f.capture()).rejects.toThrow("DATA_WAITING");
  }
  await db
    .update(netdriveFiles)
    .set({ storageVersionId: "version-1", ownerId: other.userId })
    .where(eq(netdriveFiles.id, f.fileId));
  await expect(f.capture()).rejects.toThrow("POLICY_DENIED");
  await db
    .update(netdriveFiles)
    .set({ ownerId: actor.userId, size: Number.MAX_SAFE_INTEGER })
    .where(eq(netdriveFiles.id, f.fileId));
  await expect(
    f.capture([
      {
        descriptor: "batch",
        type: "FileBatch",
        files: [
          { fileId: f.fileId, path: "a" },
          { fileId: f.fileId, path: "b" },
        ],
      },
    ]),
  ).rejects.toThrow("INVALID_MESSAGE");
  expect(
    await db
      .select()
      .from(federationWorkflowInputExports)
      .where(eq(federationWorkflowInputExports.runId, f.runId)),
  ).toHaveLength(0);
  await f.lease.release();
});

test("replacement, deletion, ownership or permission changes deny frozen input reuse", async () => {
  const f = await fixture();
  const saved = await f.capture();
  for (const change of [
    { storageVersionId: "version-2" },
    { storageKey: "replacement" },
    { sha256: "b".repeat(64) },
    { size: 5 },
    { deletedAt: new Date() },
    { ownerId: other.userId },
  ]) {
    await db.update(netdriveFiles).set(change).where(eq(netdriveFiles.id, f.fileId));
    await expect(f.capture()).rejects.toThrow();
    await expect(
      db.transaction((tx) => service.resolve(tx, actor, f.runId, saved.exportId)),
    ).rejects.toThrow();
    await db
      .update(netdriveFiles)
      .set({ ...f.original, deletedAt: null })
      .where(eq(netdriveFiles.id, f.fileId));
  }
  await permission.set({ ...actor, capability: "delegation.submit", enabled: false }, actor.userId);
  try {
    await expect(f.capture()).rejects.toThrow("POLICY_DENIED");
    await expect(
      db.transaction((tx) => service.resolve(tx, actor, f.runId, saved.exportId)),
    ).rejects.toThrow("POLICY_DENIED");
  } finally {
    await permission.set(
      { ...actor, capability: "delegation.submit", enabled: true },
      actor.userId,
    );
  }
  await db.delete(netdriveFiles).where(eq(netdriveFiles.id, f.fileId));
  await expect(
    db.transaction((tx) => service.resolve(tx, actor, f.runId, saved.exportId)),
  ).rejects.toThrow("POLICY_DENIED");
  await f.lease.release();
});

test("cancelled runs and stale leases cannot create or disclose source input snapshots", async () => {
  const f = await fixture();
  const saved = await f.capture();
  await f.lease.release();
  const current = await f.journal.acquire(f.runId);
  if (!current) throw new Error("Missing replacement lease");
  await expect(f.capture()).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await new WorkflowRunRegistry(db).requestCancel(f.runId);
  await expect(
    service.capture(actor, current, "remote", { path: "other" }, f.selection),
  ).rejects.toBeInstanceOf(WorkflowExecutionInterrupted);
  await expect(
    db.transaction((tx) => service.resolve(tx, actor, f.runId, saved.exportId)),
  ).rejects.toThrow("CANCELLATION_REQUESTED");
  expect(
    await db
      .select()
      .from(federationWorkflowInputExports)
      .where(eq(federationWorkflowInputExports.runId, f.runId)),
  ).toHaveLength(1);
  await current.release();
});

test("snapshot recheck holds source rows against deletion and rejects damaged private mappings", async () => {
  const f = await fixture();
  const saved = await f.capture();
  await db.transaction(async (tx) => {
    await service.resolve(tx, actor, f.runId, saved.exportId);
    await expect(
      db.transaction(async (otherTx) => {
        await otherTx.execute(sql`set local lock_timeout = '50ms'`);
        await otherTx
          .update(netdriveFiles)
          .set({ deletedAt: new Date() })
          .where(eq(netdriveFiles.id, f.fileId));
      }),
    ).rejects.toMatchObject({ cause: { code: "55P03" } });
  });
  await db
    .update(federationWorkflowInputExports)
    .set({ intentDigest: `sha256:${"f".repeat(64)}` })
    .where(eq(federationWorkflowInputExports.id, saved.exportId));
  await expect(
    db.transaction((tx) => service.resolve(tx, actor, f.runId, saved.exportId)),
  ).rejects.toThrow("OPERATION_CONFLICT");
  await f.lease.release();
});
