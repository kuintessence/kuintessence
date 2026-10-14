import { afterAll, beforeAll, expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { agents, authzOutbox, createPgDb, jobs, softwareOperations, users } from "@kuintessence/db";
import {
  type ServerMessage,
  SoftwareOperationAction,
  SoftwareOperationResultSchema,
  SoftwareOperationStatus,
} from "@kuintessence/proto";
import { eq, inArray } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { InstalledRegistry } from "./installed-registry";
import { SoftwareOperationService } from "./operation-service";
import { waitForSoftwareInstallation } from "./wait-for-installation";

const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
const agentId = "workflow-install-regression-agent";
const messages: ServerMessage[] = [];
let userId: string;
const jobIds: string[] = [];
const dispatcher = new AgentDispatcher();
const installed = new InstalledRegistry(db);
let operateAllowed = true;
const operations = new SoftwareOperationService(
  db,
  dispatcher,
  installed,
  async () => ({
    spackMaterialTicket: "test-ticket",
    spackManifestDigest: `sha256:${"a".repeat(64)}`,
  }),
  async () => {
    if (!operateAllowed) throw new Error("Agent operation permission denied");
  },
);

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ email: "workflow-install-regression@example.test", role: "platform_admin" })
    .returning();
  if (!user) throw new Error("missing user");
  userId = user.id;
  await db
    .insert(agents)
    .values({ agentId, siteName: "test", schedulerType: "slurm", schedulerVersion: "23" });
  dispatcher.register(agentId, {
    push: (message) => messages.push(message),
    close: () => undefined,
    spackMaterialDeliveryV1: true,
    verifiedCertFingerprint: "b".repeat(64),
  });
});
afterAll(async () => {
  if (jobIds.length) {
    await db.delete(authzOutbox).where(inArray(authzOutbox.resourceId, jobIds));
    await db.delete(jobs).where(inArray(jobs.id, jobIds));
  }
  await db.delete(softwareOperations).where(eq(softwareOperations.agentId, agentId));
  await db.delete(agents).where(eq(agents.agentId, agentId));
  if (userId) await db.delete(users).where(eq(users.id, userId));
});

async function makeJob(spec: string) {
  const [job] = await db
    .insert(jobs)
    .values({
      name: "install-regression",
      command: "exit 125",
      cpus: 1,
      memoryMb: 128,
      submittedBy: userId,
      softwareRequirements: [{ name: "example", spec, installable: true }],
    })
    .returning();
  if (!job) throw new Error("missing job");
  jobIds.push(job.id);
  return job;
}
function request(jobId: string, spec: string) {
  return operations.requestInstallForJob({
    jobId,
    agentId,
    spec,
    requestedBy: userId,
  });
}

test("concurrent jobs share one managed operation and retain their operation association", async () => {
  const spec = "example@1.0 +mpi";
  const jobA = await makeJob(spec);
  const jobB = await makeJob(spec);
  const before = messages.length;
  const [a, b] = await Promise.all([request(jobA.id, spec), request(jobB.id, spec)]);
  expect(a.id).toBe(b.id);
  expect(messages.slice(before).map((message) => message.payload.case)).toEqual([
    "softwareOperationRequest",
  ]);
  const linked = await db
    .select()
    .from(jobs)
    .where(inArray(jobs.id, [jobA.id, jobB.id]));
  expect(
    linked.every(
      (job) => job.status === "pending" && job.softwareRequirements?.[0]?.operationId === a.id,
    ),
  ).toBe(true);
  await operations.applyAgentResult(
    agentId,
    create(SoftwareOperationResultSchema, {
      operationId: a.id,
      action: SoftwareOperationAction.INSTALL,
      status: SoftwareOperationStatus.SUCCEEDED,
      spec,
      stdout: "",
      stderr: "",
      exitCode: 0,
      error: "",
      installed: [
        {
          name: "example",
          version: "1.0",
          spec,
          hash: "a".repeat(32),
          compiler: "gcc",
          arch: "x86_64",
        },
      ],
    }),
  );
  await waitForSoftwareInstallation({
    operationId: a.id,
    timeoutMs: 1000,
    readJobStatus: async () => "pending",
    readOperation: () => operations.getOperation(a.id),
    inventoryReady: async () =>
      (await installed.listForAgent(agentId)).some((row) => row.spec === spec),
  });
});

test("failed managed installation fails the waiter and a cancelled job starts no operation", async () => {
  const job = await makeJob("example@2");
  const op = await request(job.id, "example@2");
  await operations.applyAgentResult(
    agentId,
    create(SoftwareOperationResultSchema, {
      operationId: op.id,
      action: SoftwareOperationAction.INSTALL,
      status: SoftwareOperationStatus.FAILED,
      spec: "example@2",
      stdout: "",
      stderr: "",
      exitCode: 1,
      error: "build failed",
      installed: [],
    }),
  );
  await expect(
    waitForSoftwareInstallation({
      operationId: op.id,
      timeoutMs: 1000,
      readJobStatus: async () => "pending",
      readOperation: () => operations.getOperation(op.id),
      inventoryReady: async () => false,
    }),
  ).rejects.toThrow("build failed");
  const cancelled = await makeJob("example@3");
  await db.update(jobs).set({ status: "cancelled" }).where(eq(jobs.id, cancelled.id));
  const count = messages.length;
  await expect(request(cancelled.id, "example@3")).rejects.toThrow("no longer waiting");
  expect(messages).toHaveLength(count);
});

test("denied Agent operate permission cannot create or reuse an installation", async () => {
  const first = await makeJob("example@4");
  const existing = await request(first.id, "example@4");
  expect(existing.status).toBe("queued");
  const second = await makeJob("example@4");
  const missing = await makeJob("example@5");
  const before = messages.length;
  operateAllowed = false;
  try {
    await expect(request(second.id, "example@4")).rejects.toThrow(
      "Agent operation permission denied",
    );
    await expect(request(missing.id, "example@5")).rejects.toThrow(
      "Agent operation permission denied",
    );
    expect(messages).toHaveLength(before);
    const [unlinked] = await db.select().from(jobs).where(eq(jobs.id, second.id));
    expect(unlinked?.softwareRequirements?.[0]?.operationId).toBeUndefined();
  } finally {
    operateAllowed = true;
  }
});
