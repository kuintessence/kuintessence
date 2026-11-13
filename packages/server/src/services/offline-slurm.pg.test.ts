// Run only through test:unit: this suite writes to a disposable database, never the configured source DB.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  agents,
  authzOutbox,
  createPgDb,
  fileTransfers,
  jobs,
  jobWorkRootReleases,
  loadPgMigrationFiles,
  netdriveFiles,
  users,
  workflowOutputPublicationIntents,
  workflowOutputPublications,
} from "@kuintessence/db";
import { SiteOperationsSchema, usecase } from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import { netdriveFileTuples } from "../authz/projection";
import { AuthzService } from "../authz/service";
import { FakeMinioBackend } from "../storage/minio-client.test";
import { PgPublicationStore, type PublicationInput } from "../workflow/output-publication";
import {
  PgPublicationIntentStore,
  WorkflowPublicationIntentRecovery,
} from "../workflow/output-publication-intent";
import { AgentManager } from "./agent-manager";
import { JobService } from "./job-service";
import { type NetDriveCommitDb, type NetDriveCommitResult, NetDriveService } from "./netdrive";
import { PgTransferSessionStore, type TransferSession } from "./transfer-session-store";

const databaseUrl = process.env.DATABASE_URL;
if (
  !databaseUrl ||
  !/^kuintessence_unit_[a-z0-9_]+$/.test(new URL(databaseUrl).pathname.slice(1))
) {
  throw new Error(
    "Run PostgreSQL acceptance with bun run test:unit --suite offline-slurm-pg; a disposable unit database is required",
  );
}
const ownerId = randomUUID();
const db = createPgDb(databaseUrl);
const replica = createPgDb(databaseUrl);
const observer = createPgDb(databaseUrl);
const checksum = (body: string) => createHash("sha256").update(body).digest("hex");
const secret = "offline-slurm-postgres-acceptance-secret";

function gatedWorkflowSubmission(rollback: boolean) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let jobId = "";
  type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
  const connection = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "transaction")
        return (work: (tx: Tx) => Promise<unknown>) =>
          db.transaction(async (tx) => {
            const result = await work(tx);
            if (
              !result ||
              typeof result !== "object" ||
              !("id" in result) ||
              typeof result.id !== "string"
            )
              throw new Error("Expected submitted job row");
            jobId = result.id;
            entered.resolve();
            await release.promise;
            if (rollback) throw new Error("simulated submit transaction crash");
            return result;
          });
      return Reflect.get(target, property, receiver);
    },
  });
  return {
    service: new JobService(connection),
    entered,
    release,
    get jobId() {
      return jobId;
    },
  };
}
const authz = new AuthzService({
  db,
  mode: "off",
  endpoint: "unused",
  token: "unused",
  schemaPath: "",
  platformAdminDegrade: false,
});

beforeAll(async () => {
  await db.insert(users).values({
    id: ownerId,
    email: `${ownerId}@acceptance.invalid`,
    displayName: "PG acceptance",
    role: "user",
  });
});
afterAll(async () => {
  await Promise.all([
    db.$client.end({ timeout: 5 }),
    replica.$client.end({ timeout: 5 }),
    observer.$client.end({ timeout: 5 }),
  ]);
});

function authorization(commit: NetDriveCommitResult, tx: NetDriveCommitDb) {
  return authz.enqueueMany(
    [
      ...commit.replacedFiles.flatMap((file) =>
        netdriveFileTuples({ fileId: file.id, userId: ownerId, orgId: null }, "delete"),
      ),
      ...netdriveFileTuples({ fileId: commit.file.id, userId: ownerId, orgId: null }),
    ],
    tx,
  );
}

test("Workflow submit creates its publication intent atomically and rollback exposes neither row", async () => {
  const data = {
    name: "durable-publication-intent",
    command: "already-computed",
    workingDir: "/shared/acceptance/output",
    resources: { cpus: 1, memoryMb: 128 },
    expectedOutputs: [{ descriptor: "result", path: "out.dat", isBatch: false, pathsOnly: true }],
    fileOutputDescriptors: ["result"],
  };
  for (const rollback of [false, true]) {
    const staged = gatedWorkflowSubmission(rollback);
    const submitted = staged.service.submit(data, ownerId, {
      orgId: null,
      workflowOutputPublication: true,
    });
    // Attach immediately so a deliberate rollback never becomes an unhandled rejection.
    const outcome = submitted.then(
      (job) => ({ job }),
      (error: unknown) => ({ error }),
    );
    await staged.entered.promise;
    try {
      expect(await observer.select().from(jobs).where(eq(jobs.id, staged.jobId))).toHaveLength(0);
      expect(
        await observer
          .select()
          .from(workflowOutputPublicationIntents)
          .where(eq(workflowOutputPublicationIntents.jobId, staged.jobId)),
      ).toHaveLength(0);
    } finally {
      staged.release.resolve();
    }
    const result = await outcome;
    expect("error" in result).toBe(rollback);
    expect(await observer.select().from(jobs).where(eq(jobs.id, staged.jobId))).toHaveLength(
      rollback ? 0 : 1,
    );
    expect(
      await observer
        .select()
        .from(workflowOutputPublicationIntents)
        .where(eq(workflowOutputPublicationIntents.jobId, staged.jobId)),
    ).toHaveLength(rollback ? 0 : 1);
  }
  const ordinary = await new JobService(db).submit(data, ownerId, { orgId: null });
  expect(
    await observer
      .select()
      .from(workflowOutputPublicationIntents)
      .where(eq(workflowOutputPublicationIntents.jobId, ordinary.id)),
  ).toHaveLength(0);
});

test("completed status committed before enqueue is recovered from durable job facts on a fresh connection", async () => {
  const agentId = `intent-${randomUUID()}`;
  await db.insert(agents).values({
    agentId,
    siteName: "intent-acceptance",
    schedulerType: "slurm",
    schedulerVersion: "test",
  });
  const service = new JobService(db);
  const job = await service.submit(
    {
      name: "completed-before-publication",
      command: "never-resubmit",
      resources: { cpus: 1, memoryMb: 128 },
      workingDir: "/shared/completed-output",
      expectedOutputs: [{ descriptor: "result", path: "out.dat", isBatch: false, pathsOnly: true }],
      fileOutputDescriptors: ["result"],
    },
    ownerId,
    { orgId: null, workflowOutputPublication: true },
  );
  await db.update(jobs).set({ agentId }).where(eq(jobs.id, job.id));
  const facts = { [usecase.batchOutputPathsDescriptor("result")]: '["out.dat"]' };
  await service.updateStatus(
    job.id,
    "completed",
    "original-scheduler-id",
    agentId,
    undefined,
    0,
    facts,
  );
  expect(
    await observer
      .select()
      .from(workflowOutputPublications)
      .where(eq(workflowOutputPublications.jobId, job.id)),
  ).toHaveLength(0);
  expect(
    (await observer.select().from(jobs).where(eq(jobs.id, job.id)))[0]?.collectedOutputs,
  ).toEqual(facts);
  const publications = new PgPublicationStore(observer);
  await new WorkflowPublicationIntentRecovery({
    store: new PgPublicationIntentStore(observer),
    publications,
  }).enqueue(job.id);
  const recovered = await publications.get(job.id);
  expect(recovered?.input).toMatchObject({ jobId: job.id, ownerId, agentId });
  expect(recovered?.input.workflowRunId).toBeUndefined();
  expect(recovered?.input.files[0]?.source).toBe("/shared/completed-output/out.dat");
  expect(recovered?.released).toBe(false);
  expect(
    await observer.select().from(jobWorkRootReleases).where(eq(jobWorkRootReleases.jobId, job.id)),
  ).toHaveLength(0);
  expect(
    await observer
      .select()
      .from(workflowOutputPublicationIntents)
      .where(eq(workflowOutputPublicationIntents.jobId, job.id)),
  ).toHaveLength(0);
});

async function upload(label: string) {
  const backend = new FakeMinioBackend();
  const first = new NetDriveService(db, backend, { commitSecret: secret });
  const second = new NetDriveService(replica, backend, { commitSecret: secret });
  const path = `acceptance/${label}-${randomUUID()}`;
  const init = await first.initiateMultipart(ownerId, { path, size: 4 });
  const part = await backend.putUploadedPart(
    init.storageKey,
    init.uploadId,
    1,
    Buffer.from("real"),
  );
  return {
    backend,
    first,
    second,
    request: {
      ...init,
      path,
      size: 4,
      sha256: checksum("real"),
      parts: [{ partNumber: 1, etag: part.etag }],
    },
  };
}

function gate() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { entered, release };
}

async function waitForBlockedTransaction(applicationName: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const rows = await observer.$client<{ waiting: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE application_name = ${applicationName} AND wait_event_type = 'Lock') AS waiting
    `;
    if (rows[0]?.waiting) return;
    await Bun.sleep(10);
  }
  throw new Error("Expected a second PostgreSQL connection to block on the transaction lock");
}

test("0073 and 0074 are applied in order; actual upgrade statements preserve old rows", async () => {
  const migrations = await loadPgMigrationFiles();
  const first = migrations.findIndex((migration) => migration.tag === "0073_classy_dagger");
  const resume = migrations[first];
  const operations = migrations[first + 1];
  expect(resume?.tag).toBe("0073_classy_dagger");
  expect(operations?.tag).toBe("0074_neat_zarda");
  if (!resume || !operations) throw new Error("Missing site recovery migrations");
  const applied = await db.$client<{ hash: string; created_at: string }[]>`
    SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at
  `;
  const index = applied.findIndex((row) => row.hash === resume.hash);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(applied[index + 1]?.hash).toBe(operations.hash);
  expect(applied[index]?.created_at).toBe(String(resume.folderMillis));
  expect(applied[index + 1]?.created_at).toBe(String(operations.folderMillis));
  await db.$client.begin(async (sql) => {
    await sql`CREATE TEMP TABLE file_transfers (id int PRIMARY KEY) ON COMMIT DROP`;
    await sql`CREATE TEMP TABLE agents (agent_id text PRIMARY KEY) ON COMMIT DROP`;
    await sql`INSERT INTO file_transfers VALUES (1)`;
    await sql`INSERT INTO agents VALUES ('legacy-agent')`;
    for (const migration of [resume, operations]) {
      for (const statement of migration.statements) await sql.unsafe(statement);
    }
    expect([...(await sql`SELECT id, resume_session FROM file_transfers`)]).toEqual([
      { id: 1, resume_session: null },
    ]);
    expect([...(await sql`SELECT agent_id, site_operations FROM agents`)]).toEqual([
      { agent_id: "legacy-agent", site_operations: null },
    ]);
    await sql`UPDATE file_transfers SET resume_session = '{"uploadId":"retained"}'::jsonb`;
    await sql`UPDATE agents SET site_operations = '{"version":1}'::jsonb`;
    expect((await sql`SELECT resume_session FROM file_transfers`)[0]?.resume_session).toEqual({
      uploadId: "retained",
    });
    expect((await sql`SELECT site_operations FROM agents`)[0]?.site_operations).toEqual({
      version: 1,
    });
  });
});

test("workflow publication survives JSONB roundtrips and fences stale writers across PG connections", async () => {
  const migration = (await loadPgMigrationFiles()).find(
    (entry) => entry.tag === "0075_workflow_output_publications",
  );
  if (!migration) throw new Error("Missing output publication migration");
  expect(
    await db.$client`SELECT hash FROM drizzle.__drizzle_migrations WHERE hash = ${migration.hash}`,
  ).toHaveLength(1);
  const jobId = randomUUID();
  const agentId = `publication-${randomUUID()}`;
  await db.insert(agents).values({
    agentId,
    siteName: "publication-acceptance",
    schedulerType: "slurm",
    schedulerVersion: "fixture",
  });
  await db.insert(jobs).values({
    id: jobId,
    name: "output-recovery",
    command: "true",
    cpus: 1,
    memoryMb: 64,
    submittedBy: ownerId,
    status: "completed",
    exitCode: 0,
  });
  const input: PublicationInput = {
    jobId,
    ownerId,
    agentId,
    outputs: [
      { descriptor: "result", path: "result.json", isBatch: false, paths: ["result.json"] },
    ],
    files: [
      {
        descriptor: "result",
        batch: false,
        source: "/shared/work/result.json",
        target: `workflow-runs/sync/jobs/${jobId}/result.json`,
        fileName: "result.json",
        transferId: randomUUID(),
      },
    ],
  };
  const first = new PgPublicationStore(db);
  const second = new PgPublicationStore(replica);
  await first.enqueue(input);
  const reused = await second.enqueue({
    ...input,
    files: input.files.map((file) => ({ ...file, transferId: randomUUID() })),
  });
  expect(reused.input).toEqual(input);
  const tokens = [randomUUID(), randomUUID()];
  const claims = await Promise.all([
    first.claim(jobId, tokens[0] ?? ""),
    second.claim(jobId, tokens[1] ?? ""),
  ]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const winnerToken = tokens[claims[0] ? 0 : 1] ?? "";
  const nextToken = randomUUID();
  const file = input.files[0];
  if (!file) throw new Error("Missing output fixture");
  const files = {
    [file.transferId]: { fileMetadataId: randomUUID(), fileMetadataName: "result.json" },
  };
  await first.save(jobId, winnerToken, files);
  expect((await second.get(jobId))?.files).toEqual(files);
  await observer
    .update(workflowOutputPublications)
    .set({ leaseUntil: new Date(0) })
    .where(eq(workflowOutputPublications.jobId, jobId));
  // Expiry itself fences the owner, even before another Server takes the claim.
  expect(await first.renew(jobId, winnerToken)).toBe(false);
  await expect(first.save(jobId, winnerToken, {})).rejects.toThrow("lease lost");
  await expect(first.finish(jobId, winnerToken)).rejects.toThrow("lease lost");
  await expect(first.enqueueRelease(input, winnerToken)).rejects.toThrow("lease lost");
  expect((await second.get(jobId))?.files).toEqual(files);
  expect((await second.get(jobId))?.released).toBe(false);
  expect(
    await observer.select().from(jobWorkRootReleases).where(eq(jobWorkRootReleases.jobId, jobId)),
  ).toHaveLength(0);
  expect(await second.claim(jobId, nextToken)).toBe(true);
  expect(await first.renew(jobId, winnerToken)).toBe(false);
  await expect(first.save(jobId, winnerToken, {})).rejects.toThrow("lease lost");
  await expect(first.enqueueRelease(input, winnerToken)).rejects.toThrow("lease lost");
  expect(
    await observer.select().from(jobWorkRootReleases).where(eq(jobWorkRootReleases.jobId, jobId)),
  ).toHaveLength(0);
  await first.retry(jobId, winnerToken, "stale writer");
  expect((await second.get(jobId))?.files).toEqual(files);
  await expect(
    second.enqueueRelease({ ...input, agentId: `${agentId}-other` }, nextToken),
  ).rejects.toThrow("lease lost");
  await expect(
    second.enqueueRelease({ ...input, ownerId: randomUUID() }, nextToken),
  ).rejects.toThrow("lease lost");
  await second.enqueueRelease(input, nextToken);
  expect(
    await observer.select().from(jobWorkRootReleases).where(eq(jobWorkRootReleases.jobId, jobId)),
  ).toHaveLength(1);
  await second.finish(jobId, nextToken);
  expect((await first.get(jobId))?.released).toBe(true);
  expect(await second.renew(jobId, nextToken)).toBe(false);
  await expect(second.save(jobId, nextToken, {})).rejects.toThrow("lease lost");
  await expect(second.finish(jobId, nextToken)).rejects.toThrow("lease lost");
  expect(await first.pending()).not.toContain(jobId);
});

test("separate PostgreSQL connections serialize multipart completion and enqueue authorization once", async () => {
  const f = await upload("concurrent");
  const name = `site-complete-${randomUUID()}`;
  await replica.$client`SELECT set_config('application_name', ${name}, false)`;
  const hold = gate();
  let pendingFileId = "";
  const first = f.first.completeMultipartWithReplacements(
    ownerId,
    f.request,
    undefined,
    async (commit, tx) => {
      await authorization(commit, tx);
      pendingFileId = commit.file.id;
      hold.entered.resolve();
      await hold.release.promise;
    },
  );
  let second: Promise<NetDriveCommitResult> | undefined;
  try {
    await Promise.race([hold.entered.promise, first]);
    second = f.second.completeMultipartWithReplacements(
      ownerId,
      f.request,
      undefined,
      authorization,
    );
    // Observe from another connection: neither the metadata nor its grants are visible before commit.
    expect(
      await observer
        .select()
        .from(netdriveFiles)
        .where(eq(netdriveFiles.storageKey, f.request.storageKey)),
    ).toHaveLength(0);
    expect(
      await observer.select().from(authzOutbox).where(eq(authzOutbox.resourceId, pendingFileId)),
    ).toHaveLength(0);
    await waitForBlockedTransaction(name);
  } finally {
    hold.release.resolve();
  }
  const result = await first;
  expect((await second)?.file.id).toBe(result.file.id);
  expect(
    await db.select().from(netdriveFiles).where(eq(netdriveFiles.storageKey, f.request.storageKey)),
  ).toHaveLength(1);
  const grants = await db
    .select()
    .from(authzOutbox)
    .where(
      and(
        eq(authzOutbox.resourceType, "netdrive_file"),
        eq(authzOutbox.resourceId, result.file.id),
      ),
    );
  expect(grants).toHaveLength(
    netdriveFileTuples({ fileId: result.file.id, userId: ownerId, orgId: null }).length,
  );
});

test("authorization failure rolls back file replacement and real outbox inserts; assembled object remains retryable", async () => {
  const f = await upload("rollback");
  const prior = await db
    .insert(netdriveFiles)
    .values({
      ownerId,
      path: f.request.path,
      size: 3,
      sha256: checksum("old"),
      contentType: "application/octet-stream",
      storageKey: `old/${randomUUID()}`,
      etag: "old",
    })
    .returning();
  const previous = prior[0];
  if (!previous) throw new Error("Missing prior file");
  let attemptedId = "";
  await expect(
    f.first.completeMultipartWithReplacements(ownerId, f.request, undefined, async (commit, tx) => {
      attemptedId = commit.file.id;
      await authorization(commit, tx);
      throw new Error("simulated crash before database commit");
    }),
  ).rejects.toThrow("simulated crash");
  expect(
    await db.select().from(netdriveFiles).where(eq(netdriveFiles.storageKey, f.request.storageKey)),
  ).toHaveLength(0);
  expect(
    (await db.select().from(netdriveFiles).where(eq(netdriveFiles.id, previous.id)))[0]?.deletedAt,
  ).toBeNull();
  expect(
    await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, attemptedId)),
  ).toHaveLength(0);
  expect(
    await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, previous.id)),
  ).toHaveLength(0);
  const recovered = await f.second.completeMultipartWithReplacements(
    ownerId,
    f.request,
    undefined,
    authorization,
  );
  expect(recovered.file.sha256).toBe(checksum("real"));
  expect(recovered.replacedFiles.map((file) => file.id)).toEqual([previous.id]);
});

test("response loss after object completion and after database commit converges on the same receipt", async () => {
  const f = await upload("lost-response");
  const complete = f.backend.completeMultipartUpload.bind(f.backend);
  f.backend.completeMultipartUpload = async (...args) => {
    await complete(...args);
    throw new Error("response lost");
  };
  const first = await f.first.completeMultipartWithReplacements(
    ownerId,
    f.request,
    undefined,
    authorization,
  );
  const retry = await new NetDriveService(replica, f.backend, {
    commitSecret: secret,
  }).completeMultipartWithReplacements(ownerId, f.request, undefined, authorization);
  expect(retry.file.id).toBe(first.file.id);
  await expect(
    f.second.completeMultipart(ownerId, { ...f.request, sha256: checksum("fake") }),
  ).rejects.toThrow("binding changed");
  await expect(
    f.second.completeMultipart(ownerId, { ...f.request, uploadId: "other" }),
  ).rejects.toThrow("uploadId mismatch");
  const grants = await db
    .select()
    .from(authzOutbox)
    .where(eq(authzOutbox.resourceId, first.file.id));
  expect(grants).toHaveLength(
    netdriveFileTuples({ fileId: first.file.id, userId: ownerId, orgId: null }).length,
  );
});

test("session row locks keep completion monotonic across an old dispatcher and reject changed binding or content", async () => {
  const inserted = await db
    .insert(fileTransfers)
    .values({
      userId: ownerId,
      direction: "cluster_to_cloud",
      source: "/output",
      target: "output",
      state: "running",
    })
    .returning();
  const id = inserted[0]?.id;
  if (!id) throw new Error("Missing transfer row");
  const session: TransferSession = {
    storageKey: `netdrive/${ownerId}/${randomUUID()}`,
    uploadId: "upload",
    partSize: 5242880,
    agentId: "agent",
    source: "/output",
    target: "output",
    size: 4,
  };
  const completion = {
    copiedBytes: 4,
    sha256: checksum("real"),
    parts: [{ partNumber: 1, etag: "part" }],
  };
  const store = new PgTransferSessionStore(db);
  const stale = new PgTransferSessionStore(replica);
  await store.save(ownerId, id, session);
  const name = `site-session-${randomUUID()}`;
  await replica.$client`SELECT set_config('application_name', ${name}, false)`;
  const hold = gate();
  const writer = db.transaction(async (tx) => {
    await tx.select().from(fileTransfers).where(eq(fileTransfers.id, id)).for("update");
    await tx
      .update(fileTransfers)
      .set({ resumeSession: { ...session, completion } })
      .where(eq(fileTransfers.id, id));
    hold.entered.resolve();
    await hold.release.promise;
  });
  let late: Promise<TransferSession | null> | undefined;
  try {
    await Promise.race([hold.entered.promise, writer]);
    late = stale.save(ownerId, id, session);
    await waitForBlockedTransaction(name);
  } finally {
    hold.release.resolve();
  }
  await writer;
  expect((await late)?.completion).toEqual(completion);
  expect((await store.load(ownerId, id))?.completion).toEqual(completion);
  await expect(stale.save(ownerId, id, { ...session, target: "other" })).rejects.toThrow(
    "binding changed",
  );
  await expect(
    stale.save(ownerId, id, {
      ...session,
      completion: { ...completion, sha256: checksum("fake") },
    }),
  ).rejects.toThrow("completion content changed");
  await expect(stale.save(randomUUID(), id, session)).rejects.toThrow("owner binding unavailable");
  await store.save(ownerId, id, null);
  await db.update(fileTransfers).set({ state: "cancelled" }).where(eq(fileTransfers.id, id));
  await expect(stale.save(ownerId, id, session)).rejects.toThrow("cancelled");
});

test("Agent site_operations survives a new manager and an older Agent heartbeat without telemetry", async () => {
  const agentId = `site-acceptance-${randomUUID()}`;
  const manager = new AgentManager(db);
  await manager.register({
    agentId,
    siteName: "acceptance",
    schedulerType: "slurm",
    schedulerVersion: "test",
  });
  const operations = SiteOperationsSchema.parse({
    version: 1,
    observedAt: Date.now(),
    transport: "ssh-forward",
    trust: "single-user",
    executor: "slurm",
    materials: { state: "ready" },
    installation: { state: "running", active: 1 },
    jobs: { state: "running", active: 2 },
    transfers: { state: "idle" },
    update: { phase: "staged", release: "a".repeat(64) },
  });
  await manager.heartbeat({
    agentId,
    cpuUsagePercent: 1,
    memoryUsedMb: 1,
    memoryTotalMb: 2,
    siteOperations: operations,
  });
  const restarted = new AgentManager(replica);
  expect((await restarted.getById(agentId))?.siteOperations).toEqual(operations);
  await restarted.heartbeat({ agentId, cpuUsagePercent: 2, memoryUsedMb: 1, memoryTotalMb: 2 });
  expect(
    (await db.select().from(agents).where(eq(agents.agentId, agentId)))[0]?.siteOperations,
  ).toEqual(operations);
});
