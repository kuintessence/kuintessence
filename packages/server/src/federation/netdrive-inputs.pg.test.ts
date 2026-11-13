import { afterEach, beforeEach, expect, test } from "bun:test";
import { clone, toBinary } from "@bufbuild/protobuf";
import {
  agents,
  createPgDb,
  jobDispatchOutbox,
  jobs,
  netdriveFiles,
  orgs,
  users,
  workflowRuns,
} from "@kuintessence/db";
import { type ServerMessage, ServerMessageSchema } from "@kuintessence/proto";
import type { JobSubmission } from "@kuintessence/shared";
import { eq, sql } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { JobDispatchOutbox } from "../grpc/job-dispatch-outbox";
import { FederationDataDispatch } from "./data-dispatch";
import { checkFederationNetdriveJob } from "./netdrive-inputs";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("NetDrive tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 3, idle_timeout: 1 });
const other = createPgDb(url, { max: 1, idle_timeout: 1 });
const userId = crypto.randomUUID(),
  otherUserId = crypto.randomUUID(),
  orgId = crypto.randomUUID();
const runId = crypto.randomUUID();
const jobId = crypto.randomUUID(),
  fileId = crypto.randomUUID(),
  agentId = `netdrive-${crypto.randomUUID()}`;
const identity = { userId, orgId };
const intent = {
  nodeId: "node",
  envVars: {},
  expectedOutputs: [],
  name: "NetDrive",
  command: "cat input.txt",
  resources: { cpus: 1, memoryMb: 128 },
  inputStaging: [{ fileMetadataId: fileId, stagePath: "input.txt" }],
} satisfies JobSubmission;
let original: ServerMessage;
let minted = 0;
const service = new FederationDataDispatch(db, undefined, async (key, versionId) => ({
  sourceUrl: `https://objects.test/${key}?ticket=${++minted}${versionId ? `&versionId=${encodeURIComponent(versionId)}` : ""}`,
  expiresAt: Date.now() + 60_000,
}));
async function save(message = original) {
  await db
    .insert(jobDispatchOutbox)
    .values({
      jobId,
      agentId,
      dispatchEpoch: 1,
      payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
    })
    .onConflictDoUpdate({
      target: jobDispatchOutbox.jobId,
      set: {
        payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
      },
    });
}
beforeEach(async () => {
  minted = 0;
  await db
    .insert(users)
    .values([userId, otherUserId].map((id) => ({ id, email: `${id}@test.invalid` })));
  await db.insert(orgs).values({ id: orgId, name: "NetDrive test" });
  await db.insert(agents).values({
    agentId,
    siteName: "NetDrive test",
    schedulerType: "slurm",
    schedulerVersion: "test",
    status: "online",
  });
  await db.insert(jobs).values({
    id: jobId,
    name: "NetDrive",
    command: intent.command,
    cpus: 1,
    memoryMb: 128,
    status: "queued",
    submittedBy: userId,
    orgId,
    agentId,
    dispatchEpoch: 1,
  });
  await db.insert(netdriveFiles).values({
    id: fileId,
    ownerId: userId,
    path: "input.txt",
    size: 4,
    sha256: "a".repeat(64),
    storageKey: "original-input",
  });
  original = new AgentDispatcher().buildDispatchJob(jobId, {
    jobIdInternal: jobId,
    name: intent.name,
    command: intent.command,
    resources: intent.resources,
    federationExecution: true,
    dispatchEpoch: 1,
    inputStaging: [
      {
        fileMetadataId: fileId,
        stagePath: "input.txt",
        sourceUrl: "https://expired.invalid/input",
        netdriveInput: true,
        expectedSha256: "a".repeat(64),
        expectedSizeBytes: 4,
        deliveryLeaseId: crypto.randomUUID(),
        deliveryLeaseExpiresAtUnixMs: 1,
      },
    ],
  });
  await save();
});
afterEach(async () => {
  await db.delete(jobs).where(eq(jobs.id, jobId));
  await db.delete(workflowRuns).where(eq(workflowRuns.id, runId));
  await db.delete(netdriveFiles).where(eq(netdriveFiles.id, fileId));
  await db.delete(agents).where(eq(agents.agentId, agentId));
  await db.delete(orgs).where(eq(orgs.id, orgId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, otherUserId));
});

test("NetDrive refreshes expired URLs without changing saved intent and keeps running without URL renewal", async () => {
  const before = Buffer.from(toBinary(ServerMessageSchema, original)).toString("base64");
  const prepared = await service.prepare(agentId, original);
  await db.transaction(prepared.authorize);
  if (prepared.message.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
  expect(prepared.message.payload.value.inputStaging[0]).toMatchObject({
    sourceUrl: "https://objects.test/original-input?ticket=1",
    expectedSha256: "a".repeat(64),
    totalBytes: 4n,
  });
  const [saved] = await db
    .select()
    .from(jobDispatchOutbox)
    .where(eq(jobDispatchOutbox.jobId, jobId));
  expect(saved?.payloadBase64).toBe(before);
  expect(Buffer.from(toBinary(ServerMessageSchema, original)).toString("base64")).toBe(before);
  await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
  await checkFederationNetdriveJob(db, jobId, intent, identity);
  expect(minted).toBe(1);
});

test.each([
  "delete",
  "hash",
  "size",
  "owner",
  "missing",
] as const)("NetDrive %s revokes both new downloads and running permission", async (change) => {
  const prepared = await service.prepare(agentId, original);
  if (change === "missing") await db.delete(netdriveFiles).where(eq(netdriveFiles.id, fileId));
  else
    await db
      .update(netdriveFiles)
      .set(
        change === "delete"
          ? { deletedAt: new Date() }
          : change === "hash"
            ? { sha256: "b".repeat(64) }
            : change === "size"
              ? { size: 5 }
              : { ownerId: otherUserId },
      )
      .where(eq(netdriveFiles.id, fileId));
  await expect(db.transaction(prepared.authorize)).rejects.toThrow("POLICY_DENIED");
  await expect(service.prepare(agentId, original)).rejects.toThrow("POLICY_DENIED");
  await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
  await expect(checkFederationNetdriveJob(db, jobId, intent, identity)).rejects.toThrow(
    "POLICY_DENIED",
  );
});

test("NetDrive refuses a stale object key and retries using the new location", async () => {
  const prepared = await service.prepare(agentId, original);
  await db
    .update(netdriveFiles)
    .set({ storageKey: "moved-input" })
    .where(eq(netdriveFiles.id, fileId));
  await expect(db.transaction(prepared.authorize)).rejects.toThrow("moved during URL renewal");
  const retry = await service.prepare(agentId, original);
  await db.transaction(retry.authorize);
  if (retry.message.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
  expect(retry.message.payload.value.inputStaging[0]?.sourceUrl).toContain("moved-input");
});

test("NetDrive final authorization locks the file and fails promptly on a concurrent writer", async () => {
  const prepared = await service.prepare(agentId, original);
  await db.transaction(async (tx) => {
    await prepared.authorize(tx);
    await expect(
      Promise.resolve(
        other.execute(sql`select id from netdrive_files where id=${fileId} for update nowait`),
      ),
    ).rejects.toMatchObject({ cause: { code: "55P03" } });
  });
  await other.transaction(async (tx) => {
    await tx.select().from(netdriveFiles).where(eq(netdriveFiles.id, fileId)).for("update");
    await expect(db.transaction(prepared.authorize)).rejects.toMatchObject({
      cause: { code: "55P03" },
    });
  });
});

test.each([
  "legacy",
  "path",
  "missing",
  "epoch",
  "marker",
] as const)("NetDrive refuses %s changes to its persisted input binding", async (change) => {
  const changed = clone(ServerMessageSchema, original);
  if (changed.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
  const input = changed.payload.value.inputStaging[0];
  if (!input) throw new Error("Missing input");
  if (change === "legacy")
    Object.assign(input, {
      netdriveInput: false,
      deliveryLeaseId: "",
      expectedSha256: "",
      totalBytes: 0n,
    });
  if (change === "path") input.stagePath = "other.txt";
  if (change === "missing") changed.payload.value.inputStaging = [];
  if (change === "epoch") changed.payload.value.dispatchEpoch = 2n;
  if (change === "marker") input.netdriveInput = false;
  await save(changed);
  await expect(checkFederationNetdriveJob(db, jobId, intent, identity)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test("NetDrive pending preparation is allowed, queued gaps retry, running gaps fail closed", async () => {
  await db.delete(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, jobId));
  await db.update(jobs).set({ status: "pending" }).where(eq(jobs.id, jobId));
  await checkFederationNetdriveJob(db, jobId, intent, identity);
  await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, jobId));
  await expect(checkFederationNetdriveJob(db, jobId, intent, identity)).rejects.toThrow(
    "still being prepared",
  );
  await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, jobId));
  await expect(checkFederationNetdriveJob(db, jobId, intent, identity)).rejects.toThrow(
    "OPERATION_CONFLICT",
  );
});

test("NetDrive outbox waits for preparation capability and renews credentials on redelivery", async () => {
  await db.insert(workflowRuns).values({
    id: runId,
    name: "NetDrive",
    status: "running",
    submittedBy: userId,
    input: { yaml: "", role: "user", federationReservationId: crypto.randomUUID() },
  });
  await db
    .update(jobDispatchOutbox)
    .set({ workflowRunId: runId })
    .where(eq(jobDispatchOutbox.jobId, jobId));
  const dispatcher = new AgentDispatcher();
  const messages: ServerMessage[] = [];
  const channel = {
    federationExecutionV1: true,
    federationComputeLeaseV1: true,
    federationNetdriveInputLeaseV1: false,
    verifiedCertFingerprint: "verified",
    close: () => {},
    push: (message: ServerMessage) => {
      messages.push(message);
    },
  };
  dispatcher.register(agentId, channel);
  const outbox = new JobDispatchOutbox(
    db,
    dispatcher,
    async () => async (tx) => {
      await checkFederationNetdriveJob(tx, jobId, intent, identity, true);
      return Date.now() + 10_000;
    },
    (agent, message) => service.prepare(agent, message),
  );
  await outbox.redeliver(agentId);
  expect(messages).toHaveLength(0);
  expect(minted).toBe(0);
  channel.federationNetdriveInputLeaseV1 = true;
  await outbox.redeliver(agentId);
  expect(messages).toHaveLength(1);
  expect(minted).toBe(1);
  await outbox.redeliver(agentId);
  expect(messages).toHaveLength(2);
  expect(minted).toBe(2);
  const urls = messages.map((message) =>
    message.payload.case === "dispatchJob"
      ? message.payload.value.inputStaging[0]?.sourceUrl
      : undefined,
  );
  expect(new Set(urls).size).toBe(2);
});

test("NetDrive renewal pins the saved object version and rejects replacement during signing", async () => {
  await db
    .update(netdriveFiles)
    .set({ storageVersionId: "original-version" })
    .where(eq(netdriveFiles.id, fileId));
  const prepared = await service.prepare(agentId, original);
  if (prepared.message.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
  const firstUrl = prepared.message.payload.value.inputStaging[0]?.sourceUrl;
  expect(firstUrl && new URL(firstUrl).searchParams.get("versionId")).toBe("original-version");
  await db.transaction(prepared.authorize);
  await db
    .update(netdriveFiles)
    .set({ storageVersionId: "replacement-version" })
    .where(eq(netdriveFiles.id, fileId));
  await expect(db.transaction(prepared.authorize)).rejects.toThrow("moved during URL renewal");
  const retry = await service.prepare(agentId, original);
  if (retry.message.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
  const nextUrl = retry.message.payload.value.inputStaging[0]?.sourceUrl;
  expect(nextUrl && new URL(nextUrl).searchParams.get("versionId")).toBe("replacement-version");
  await db.transaction(retry.authorize);
});
