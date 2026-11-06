import { afterEach, beforeEach, expect, test } from "bun:test";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  agents,
  createPgDb,
  dataAccessPolicies,
  dataAssetFiles,
  dataAssetManifestEntries,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  jobDataBindings,
  jobDispatchOutbox,
  jobs,
  users,
  workflowRuns,
} from "@kuintessence/db";
import {
  InputStagingSchema,
  SandboxExecutionSchema,
  SandboxIoType,
  SandboxMountMode,
  type ServerMessage,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { eq, sql } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { JobDispatchOutbox } from "../grpc/job-dispatch-outbox";
import { evaluateActiveDataAccess } from "../services/data-access-decision";
import { DataDeliveryResolver } from "../services/data-delivery";
import { PgDataPrerequisiteRepository } from "../services/data-prerequisite-repository-drizzle";
import { assertRunningDataBindings, FederationDataDispatch } from "./data-dispatch";
import { checkFederationJobData } from "./execution-policy";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 4, idle_timeout: 1 });
const other = createPgDb(url, { max: 1, idle_timeout: 1 });
const userId = crypto.randomUUID(),
  jobId = crypto.randomUUID(),
  runId = crypto.randomUUID();
const assetId = crypto.randomUUID(),
  versionId = crypto.randomUUID(),
  locationId = crypto.randomUUID();
const fileId = crypto.randomUUID(),
  bindingId = crypto.randomUUID(),
  grantId = crypto.randomUUID();
const agentId = `data-renewal-${crypto.randomUUID()}`;
const digest = `sha256:${"a".repeat(64)}`;
let minted = 0;
const minio = {
  dataMarketImmutableBucket: "test-data",
  presignImmutableDownload: async (_key: string, _ttl: number, version: string) =>
    `https://objects.test/${version}?ticket=${++minted}`,
};
const service = new FederationDataDispatch(db, minio);
let original: ServerMessage;

beforeEach(async () => {
  minted = 0;
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid`, role: "user" });
  await db.insert(agents).values({
    agentId,
    siteName: "Data renewal test",
    schedulerType: "slurm",
    schedulerVersion: "test",
    status: "online",
  });
  await db.insert(jobs).values({
    id: jobId,
    name: "Renew credentials",
    command: "true",
    cpus: 1,
    memoryMb: 128,
    status: "queued",
    submittedBy: userId,
    agentId,
    dispatchEpoch: 1,
  });
  await db.insert(workflowRuns).values({
    id: runId,
    name: "Renewal test",
    status: "running",
    submittedBy: userId,
    input: { yaml: "", role: "user", federationReservationId: crypto.randomUUID() },
  });
  await db.insert(dataAssets).values({
    id: assetId,
    ownerKind: "platform",
    kind: "reference-data",
    name: "Governed input",
    lifecycle: "published",
    visibility: "organization",
    accessMode: "request",
    sensitivity: "internal",
  });
  await db.insert(dataAssetVersions).values({
    id: versionId,
    dataAssetId: assetId,
    version: "1",
    status: "ready",
    immutableAt: new Date(),
    manifestDigest: digest,
  });
  await db.insert(dataLocations).values({
    id: locationId,
    dataAssetVersionId: versionId,
    kind: "platform-object",
    uri: "s3://test-data/data-market/immutable/input",
    status: "available",
  });
  await db.insert(dataAssetFiles).values({
    id: fileId,
    dataAssetVersionId: versionId,
    locationId,
    path: "input.txt",
    digest,
    sizeBytes: 4,
    metadata: { objectKey: "data-market/immutable/input", objectVersionId: "version-one" },
  });
  await db.insert(dataAssetManifestEntries).values({
    dataAssetVersionId: versionId,
    dataAssetFileId: fileId,
    entryPath: "input.txt",
    digest,
    sizeBytes: 4,
  });
  await db.insert(dataGrants).values({
    id: grantId,
    dataAssetId: assetId,
    dataAssetVersionId: versionId,
    subjectKind: "user",
    subjectId: userId,
    capabilities: ["use"],
    status: "active",
    startsAt: new Date(Date.now() - 60_000),
  });
  await db.insert(jobDataBindings).values({
    id: bindingId,
    jobId,
    inputDescriptor: "data",
    source: "data-market",
    assetId,
    versionId,
    manifestDigest: digest,
    selectedEntries: ["input.txt"],
    allowedLocationIds: [locationId],
    stagePath: "inputs/data",
    assetKind: "reference-data",
    sensitivity: "internal",
    egressPolicy: "deny",
  });
  const repository = new PgDataPrerequisiteRepository(db);
  const deliveries = await new DataDeliveryResolver(db, minio, {
    verifyAccess: (input) => repository.verifyAccess(input),
  }).resolveForDispatch({ jobId, actorUserId: userId, orgId: null, agentId });
  original = new AgentDispatcher().buildDispatchJob(jobId, {
    federationExecution: true,
    jobIdInternal: jobId,
    name: "Renew credentials",
    command: "true",
    resources: { cpus: 1, memoryMb: 128 },
    dispatchEpoch: 1,
    dataDeliveries: deliveries,
  });
  if (original.payload.case !== "dispatchJob" || !original.payload.value.dataDeliveries[0])
    throw new Error("Invalid fixture");
  original.payload.value.dataDeliveries[0].leaseExpiresAtUnixMs = 1n;
});

afterEach(async () => {
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
  await db.delete(dataAssets).where(eq(dataAssets.id, assetId));
  await db.delete(agents).where(eq(agents.agentId, agentId));
  await db.delete(users).where(eq(users.id, userId));
});

test("reconnect renews credentials while retaining the original outbox and immutable data", async () => {
  const dispatcher = new AgentDispatcher();
  const delivered: ServerMessage[] = [];
  const makeOutbox = () =>
    new JobDispatchOutbox(
      db,
      dispatcher,
      async () => async () => Number.POSITIVE_INFINITY,
      (id, message) => service.prepare(id, message),
    );
  const bytes = Buffer.from(toBinary(ServerMessageSchema, original)).toString("base64");
  const outbox = makeOutbox();
  expect(await outbox.enqueue(agentId, original, runId)).toEqual({ sent: false, pending: true });
  dispatcher.register(agentId, {
    federationComputeLeaseV1: true,
    federationExecutionV1: true,
    verifiedCertFingerprint: "test-verified-certificate",
    close: () => {},
    push: (message) => delivered.push(message),
  });
  await outbox.redeliver(agentId);
  await makeOutbox().redeliver(agentId);
  expect(delivered).toHaveLength(2);
  const leases = delivered.map((message) => {
    if (message.payload.case !== "dispatchJob") throw new Error("Expected dispatch");
    const payload = message.payload.value;
    const binding = payload.dataDeliveries[0];
    if (!binding) throw new Error("Expected data binding");
    expect(payload.jobId).toBe(jobId);
    expect(payload.dispatchEpoch).toBe(1n);
    expect(payload.command).toBe("true");
    expect(binding.versionId).toBe(versionId);
    expect(binding.selectedEntries[0]?.sha256).toBe("a".repeat(64));
    expect(binding.leaseExpiresAtUnixMs).toBeGreaterThan(BigInt(Date.now()));
    return binding.leaseId;
  });
  expect(new Set(leases).size).toBe(2);
  const [saved] = await db
    .select()
    .from(jobDispatchOutbox)
    .where(eq(jobDispatchOutbox.jobId, jobId));
  expect(saved?.payloadBase64).toBe(bytes);
  await db.update(dataGrants).set({ status: "revoked" }).where(eq(dataGrants.id, grantId));
  await makeOutbox().redeliver(agentId);
  expect(delivered).toHaveLength(2);
});

test.each([
  "grant",
  "expiry",
  "version",
  "sensitivity",
  "binding",
  "object-version",
  "location",
  "deny",
] as const)("%s change during credential preparation rejects the final send", async (change) => {
  const prepared = await service.prepare(agentId, original);
  const beforeFenceMints = minted;
  switch (change) {
    case "grant":
      await db.update(dataGrants).set({ status: "revoked" }).where(eq(dataGrants.id, grantId));
      break;
    case "expiry":
      await db
        .update(dataGrants)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(dataGrants.id, grantId));
      break;
    case "version":
      await db
        .update(dataAssetVersions)
        .set({ status: "revoked" })
        .where(eq(dataAssetVersions.id, versionId));
      break;
    case "sensitivity":
      await db
        .update(dataAssets)
        .set({ sensitivity: "restricted" })
        .where(eq(dataAssets.id, assetId));
      break;
    case "binding":
      await db
        .update(jobDataBindings)
        .set({ stagePath: "changed" })
        .where(eq(jobDataBindings.id, bindingId));
      break;
    case "object-version":
      await db
        .update(dataAssetFiles)
        .set({
          metadata: { objectKey: "data-market/immutable/input", objectVersionId: "version-two" },
        })
        .where(eq(dataAssetFiles.id, fileId));
      break;
    case "location":
      await db
        .update(dataLocations)
        .set({ status: "unavailable" })
        .where(eq(dataLocations.id, locationId));
      break;
    case "deny":
      await db.insert(dataAccessPolicies).values({
        dataAssetId: assetId,
        subjectKind: "user",
        subjectId: userId,
        capabilities: ["use"],
        effect: "deny",
      });
      break;
  }
  await expect(db.transaction(prepared.authorize)).rejects.toBeDefined();
  expect(minted).toBe(beforeFenceMints);
});

test("the final fence holds grants and prevents a newly inserted deny policy until commit", async () => {
  const prepared = await service.prepare(agentId, original);
  await db.transaction(async (tx) => {
    await prepared.authorize(tx);
    for (const action of ["revoke", "insert-deny"] as const) {
      let code: string | undefined;
      try {
        await other.transaction(async (concurrent) => {
          await concurrent.execute(sql`set local lock_timeout = '50ms'`);
          if (action === "revoke")
            await concurrent
              .update(dataGrants)
              .set({ status: "revoked" })
              .where(eq(dataGrants.id, grantId));
          else
            await concurrent.insert(dataAccessPolicies).values({
              dataAssetId: assetId,
              subjectKind: "user",
              subjectId: userId,
              capabilities: ["use"],
              effect: "deny",
            });
        });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (cause && typeof cause === "object" && "code" in cause) code = String(cause.code);
      }
      expect(code).toBe("55P03");
    }
  });
});

test("a concurrent grant revocation lock fails promptly instead of waiting on its Job lock", async () => {
  const prepared = await service.prepare(agentId, original);
  await other.transaction(async (tx) => {
    await tx.select().from(dataGrants).where(eq(dataGrants.id, grantId)).for("update");
    await expect(
      db.transaction(async (sending) => {
        await sending.execute(sql`set local lock_timeout = '500ms'`);
        await prepared.authorize(sending);
      }),
    ).rejects.toBeDefined();
  });
});

test("data-bearing federation dispatch cannot bypass an absent renewal service", async () => {
  const dispatcher = new AgentDispatcher();
  let sent = 0;
  dispatcher.register(agentId, {
    federationComputeLeaseV1: true,
    federationExecutionV1: true,
    verifiedCertFingerprint: "test-verified-certificate",
    close: () => {},
    push: () => {
      sent++;
    },
  });
  const outbox = new JobDispatchOutbox(
    db,
    dispatcher,
    async () => async () => Number.POSITIVE_INFINITY,
  );
  expect(await outbox.enqueue(agentId, original, runId)).toEqual({ sent: false, pending: true });
  expect(sent).toBe(0);
  const [pending] = await db
    .select()
    .from(jobDispatchOutbox)
    .where(eq(jobDispatchOutbox.jobId, jobId));
  expect(pending?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 1000);
});

test("a failed retry timestamp write cannot turn an accepted durable dispatch into failure", async () => {
  await db.execute(
    sql`create function test_data_dispatch_backoff_failure() returns trigger language plpgsql as $$ begin raise exception 'test backoff failure'; end $$`,
  );
  await db.execute(
    sql`create trigger test_data_dispatch_backoff_failure before update on job_dispatch_outbox for each row execute function test_data_dispatch_backoff_failure()`,
  );
  try {
    const dispatcher = new AgentDispatcher();
    const outbox = new JobDispatchOutbox(
      db,
      dispatcher,
      async () => async () => Number.POSITIVE_INFINITY,
      (id, message) => service.prepare(id, message),
    );
    expect(await outbox.enqueue(agentId, original, runId)).toEqual({ sent: false, pending: true });
    const [pending] = await db
      .select()
      .from(jobDispatchOutbox)
      .where(eq(jobDispatchOutbox.jobId, jobId));
    expect(pending?.acknowledgedAt).toBeNull();
    expect(pending?.dispatchEpoch).toBe(1);
  } finally {
    await db.execute(sql`drop trigger test_data_dispatch_backoff_failure on job_dispatch_outbox`);
    await db.execute(sql`drop function test_data_dispatch_backoff_failure()`);
  }
});

test.each([
  "active",
  "hash",
  "size",
  "missing",
  "unbound",
  "extra",
] as const)("running Sandbox data validates %s against immutable entries without renewing downloads", async (change) => {
  if (original.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
  const dispatch = original.payload.value;
  const delivered = dispatch.dataDeliveries[0];
  const file = delivered?.selectedEntries[0];
  if (!delivered || !file) throw new Error("Missing delivery");
  dispatch.sandboxExecution = create(SandboxExecutionSchema, {
    networkDisabled: true,
    artifactMounts: [
      {
        descriptor: "data",
        mode: SandboxMountMode.READ_ONLY,
        ioType: SandboxIoType.FILE_BATCH,
        relativePath: "inputs/data",
        containerPath: "/kq/inputs/data",
        sizeLimitBytes: 4n,
        batchEntries: [{ relativePath: file.path, sha256: file.sha256, sizeBytes: file.sizeBytes }],
      },
    ],
  });
  dispatch.inputStaging = [
    create(InputStagingSchema, {
      fileMetadataId: `data-delivery-${bindingId}-0`,
      stagePath: "inputs/data/input.txt",
      sourceUrl: "https://expired.invalid/input",
      deliveryLeaseId: "original-lease",
      deliveryLeaseExpiresAtUnixMs: 1n,
    }),
  ];
  dispatch.dataDeliveries = [];
  dispatch.restrictedNoEgress = true;
  await db.delete(dataLocations).where(eq(dataLocations.id, locationId));
  await db.transaction((tx) => assertRunningDataBindings(tx, dispatch));
  const entry = dispatch.sandboxExecution.artifactMounts[0]?.batchEntries[0];
  const input = dispatch.inputStaging[0];
  if (!entry || !input) throw new Error("Missing Sandbox data");
  if (change === "hash") entry.sha256 = "e".repeat(64);
  if (change === "size") entry.sizeBytes += 1n;
  if (change === "missing") dispatch.inputStaging = [];
  if (change === "unbound") input.fileMetadataId = `data-delivery-${crypto.randomUUID()}-0`;
  if (change === "extra") dispatch.inputStaging.push({ ...input, stagePath: "inputs/data/extra" });
  if (change !== "active")
    await expect(db.transaction((tx) => assertRunningDataBindings(tx, dispatch))).rejects.toThrow(
      "Running data binding changed",
    );
  else
    await db.transaction(async (tx) => {
      await assertRunningDataBindings(tx, dispatch);
      await expect(
        Promise.resolve(
          other.execute(
            sql`select id from data_asset_manifest_entries where data_asset_version_id=${versionId} for update nowait`,
          ),
        ),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });
});

test("data authority uses only current matching grants and allow policies, with deny precedence", async () => {
  const now = new Date();
  const deadline = now.getTime() + 5_000;
  const input = {
    assetId,
    versionId,
    actorUserId: userId,
    orgIds: [],
    capability: "use" as const,
    now,
  };
  await db
    .update(dataGrants)
    .set({ expiresAt: new Date(deadline) })
    .where(eq(dataGrants.id, grantId));
  await db.insert(dataGrants).values([
    {
      dataAssetId: assetId,
      subjectKind: "user",
      subjectId: userId,
      capabilities: ["use"],
      startsAt: new Date(deadline + 1),
      status: "active",
    },
    {
      dataAssetId: assetId,
      subjectKind: "user",
      subjectId: crypto.randomUUID(),
      capabilities: ["use"],
      startsAt: now,
      status: "active",
    },
    {
      dataAssetId: assetId,
      subjectKind: "user",
      subjectId: userId,
      capabilities: ["view"],
      startsAt: now,
      status: "active",
    },
    {
      dataAssetId: assetId,
      subjectKind: "user",
      subjectId: userId,
      capabilities: ["use"],
      startsAt: now,
      status: "revoked",
    },
  ]);
  const otherVersion = crypto.randomUUID();
  await db.insert(dataAssetVersions).values({
    id: otherVersion,
    dataAssetId: assetId,
    version: "2",
    status: "ready",
    manifestDigest: digest,
    immutableAt: new Date(),
  });
  await db.insert(dataGrants).values({
    dataAssetId: assetId,
    dataAssetVersionId: otherVersion,
    subjectKind: "user",
    subjectId: userId,
    capabilities: ["use"],
    startsAt: now,
    status: "active",
  });
  expect(await evaluateActiveDataAccess(db, input)).toEqual({
    allowed: true,
    expiresAtUnixMs: deadline,
  });
  const [allow] = await db
    .insert(dataAccessPolicies)
    .values({
      dataAssetId: assetId,
      subjectKind: "user",
      subjectId: userId,
      capabilities: ["use"],
      effect: "allow",
      expiresAt: new Date(deadline + 2_000),
      status: "active",
    })
    .returning();
  if (!allow) throw new Error("Missing policy");
  expect(await evaluateActiveDataAccess(db, input)).toEqual({
    allowed: true,
    expiresAtUnixMs: deadline + 2_000,
  });
  const [deny] = await db
    .insert(dataAccessPolicies)
    .values({
      dataAssetId: assetId,
      subjectKind: "user",
      subjectId: userId,
      capabilities: ["use"],
      effect: "deny",
      expiresAt: new Date(deadline),
      status: "active",
    })
    .returning();
  if (!deny) throw new Error("Missing denial");
  expect(await evaluateActiveDataAccess(db, input)).toEqual({ allowed: false, expiresAtUnixMs: 0 });
  await db
    .update(dataAccessPolicies)
    .set({ expiresAt: now })
    .where(eq(dataAccessPolicies.id, deny.id));
  expect(await evaluateActiveDataAccess(db, input)).toEqual({
    allowed: true,
    expiresAtUnixMs: deadline + 2_000,
  });
  await db
    .update(dataAccessPolicies)
    .set({ expiresAt: null })
    .where(eq(dataAccessPolicies.id, allow.id));
  expect(await evaluateActiveDataAccess(db, input)).toEqual({
    allowed: true,
    expiresAtUnixMs: Number.POSITIVE_INFINITY,
  });
});

test("expired data permission cannot extend a permit, while public and owner access keep their semantics", async () => {
  const now = new Date();
  const access = new PgDataPrerequisiteRepository(db, { now: () => now });
  const input = { actorUserId: userId, orgId: null, assetId, versionId };
  await db.update(dataGrants).set({ expiresAt: now }).where(eq(dataGrants.id, grantId));
  expect(await access.authorizeAccess(input)).toEqual({ allowed: false, expiresAtUnixMs: 0 });
  await db
    .update(dataAssets)
    .set({ visibility: "public", accessMode: "open" })
    .where(eq(dataAssets.id, assetId));
  expect(await access.authorizeAccess(input)).toEqual({
    allowed: true,
    expiresAtUnixMs: Number.POSITIVE_INFINITY,
  });
  await db
    .update(dataAssets)
    .set({ visibility: "private", accessMode: "request" })
    .where(eq(dataAssets.id, assetId));
  expect(await access.authorizeAccess(input)).toEqual({ allowed: false, expiresAtUnixMs: 0 });
  await db
    .update(dataAssets)
    .set({ ownerKind: "user", ownerUserId: userId })
    .where(eq(dataAssets.id, assetId));
  expect(await access.authorizeAccess(input)).toEqual({
    allowed: true,
    expiresAtUnixMs: Number.POSITIVE_INFINITY,
  });
  await db
    .update(dataAssets)
    .set({ kind: "licensed-material", accessMode: "entitlement" })
    .where(eq(dataAssets.id, assetId));
  expect(await access.authorizeAccess(input)).toEqual({ allowed: false, expiresAtUnixMs: 0 });
});

test("a Job's data authority ends at its earliest required dataset deadline", async () => {
  const secondAsset = crypto.randomUUID(),
    secondVersion = crypto.randomUUID();
  const firstDeadline = Date.now() + 60_000,
    secondDeadline = firstDeadline - 10_000;
  try {
    await db
      .update(dataGrants)
      .set({ expiresAt: new Date(firstDeadline) })
      .where(eq(dataGrants.id, grantId));
    await db.insert(dataAssets).values({
      id: secondAsset,
      name: "Second input",
      ownerKind: "platform",
      kind: "reference-data",
      lifecycle: "published",
      visibility: "organization",
      accessMode: "request",
      sensitivity: "internal",
    });
    await db.insert(dataAssetVersions).values({
      id: secondVersion,
      dataAssetId: secondAsset,
      immutableAt: new Date(),
      version: "1",
      status: "ready",
      manifestDigest: digest,
    });
    await db.insert(dataGrants).values({
      dataAssetId: secondAsset,
      subjectKind: "user",
      subjectId: userId,
      capabilities: ["use"],
      startsAt: new Date(Date.now() - 1000),
      expiresAt: new Date(secondDeadline),
      status: "active",
    });
    await db.insert(jobDataBindings).values({
      jobId,
      inputDescriptor: "second",
      source: "data-market",
      assetId: secondAsset,
      versionId: secondVersion,
      manifestDigest: digest,
      assetKind: "reference-data",
      sensitivity: "internal",
      egressPolicy: "deny",
    });
    await db.transaction(async (tx) => {
      await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      expect(
        await checkFederationJobData(tx, jobId, { userId, orgId: crypto.randomUUID() }, true),
      ).toBe(secondDeadline);
      await expect(
        Promise.resolve(
          other.execute(sql`select id from data_grants where id=${grantId} for update nowait`),
        ),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });
  } finally {
    await db.delete(jobDataBindings).where(eq(jobDataBindings.assetId, secondAsset));
    await db.delete(dataAssets).where(eq(dataAssets.id, secondAsset));
  }
});
