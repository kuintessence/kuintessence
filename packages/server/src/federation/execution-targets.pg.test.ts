import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import {
  agents,
  authzOutbox,
  createPgDb,
  jobs,
  orgs,
  schedulerQueues,
  users,
} from "@kuintessence/db";
import { QueueValidationMode, type ServerMessage } from "@kuintessence/proto";
import type { FederationExecutionTarget } from "@kuintessence/shared/federation";
import { eq, inArray, sql } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { PreferenceService } from "../preferences/preference-service";
import { AgentManager } from "../services/agent-manager";
import { JobService } from "../services/job-service";
import { PlacementOrchestrator } from "../services/placement-orchestrator";
import { QueueRegistryService } from "../services/queue-registry";
import {
  lockFederationTarget,
  requireFederationTargets,
  resolveFederationTargets,
} from "./execution-targets";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation target tests require an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const provider = crypto.randomUUID(),
  consumer = crypto.randomUUID(),
  userId = crypto.randomUUID();
const agentIds = [`fed-target-${crypto.randomUUID()}`, `fed-target-${crypto.randomUUID()}`];
const queueIds = [`fed-queue-${crypto.randomUUID()}`, `fed-queue-${crypto.randomUUID()}`];
const targets: FederationExecutionTarget[] = agentIds.map((agentId, index) => ({
  agentId,
  providerOrgId: provider,
  clusterId: `cluster-${index}`,
  queueId: queueIds[index] ?? "",
}));
const context = { userId, orgId: consumer, role: "user" as const };
const registry = new QueueRegistryService(db);
const service = new JobService(db);
const dispatcher = new AgentDispatcher();
const sent: { agentId: string; message: ServerMessage }[] = [];
const jobIds: string[] = [];
const orchestrator = new PlacementOrchestrator({
  db,
  agentManager: new AgentManager(db),
  jobService: service,
  preferenceService: new PreferenceService(db),
  dispatcher,
  queueRegistry: registry,
});

beforeAll(async () => {
  await db.insert(orgs).values([
    { id: provider, name: "Target provider" },
    { id: consumer, name: "Target consumer" },
  ]);
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@test.invalid`, role: "user", orgId: consumer });
  for (const [index, target] of targets.entries()) {
    await db.insert(agents).values({
      agentId: target.agentId,
      providerOrgId: provider,
      clusterId: target.clusterId,
      siteName: "Receiver",
      schedulerType: index === 0 ? "slurm" : "pbs",
      schedulerVersion: "test",
      status: "online",
      lastHeartbeat: new Date(),
      cpuUsagePercent: index === 0 ? 70 : 0,
    });
    await db.insert(schedulerQueues).values({
      queueId: target.queueId,
      name: "Approved queue",
      providerOrgId: provider,
      agentId: target.agentId,
      schedulerType: index === 0 ? "slurm" : "pbs",
      queueName: `queue-${index}`,
      visibleOrgIds: [consumer],
      qos: null,
    });
    dispatcher.register(target.agentId, {
      federationExecutionV1: true,
      verifiedCertFingerprint: "test-verified-certificate",
      push: (message) => {
        sent.push({ agentId: target.agentId, message });
      },
      close() {},
    });
  }
});
beforeEach(async () => {
  sent.length = 0;
  await db
    .update(schedulerQueues)
    .set({ enabled: true, visibleOrgIds: [consumer] })
    .where(inArray(schedulerQueues.queueId, queueIds));
});
afterAll(async () => {
  if (jobIds.length) {
    await db.delete(authzOutbox).where(inArray(authzOutbox.resourceId, jobIds));
    await db.delete(jobs).where(inArray(jobs.id, jobIds));
  }
  await db.delete(schedulerQueues).where(inArray(schedulerQueues.queueId, queueIds));
  await db.delete(agents).where(inArray(agents.agentId, agentIds));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(orgs).where(inArray(orgs.id, [provider, consumer]));
  await db.$client.end({ timeout: 5 });
});

function firstTarget() {
  const target = targets[0];
  if (!target) throw new Error("Missing target fixture");
  return target;
}

test("historical agreements without a target are readable but grant no execution scope", () => {
  expect(() => requireFederationTargets(undefined)).toThrow("lacks an approved");
  expect(() => requireFederationTargets([])).toThrow("lacks an approved");
});

test("signed cluster, provider and Agent must match the local authorized queue", async () => {
  const first = firstTarget();
  expect(
    (await resolveFederationTargets(db, registry, [first], context)).selections.map(
      (v) => v.queueId,
    ),
  ).toEqual([first.queueId]);
  for (const changed of [
    { ...first, clusterId: "different" },
    { ...first, providerOrgId: consumer },
    { ...first, agentId: agentIds[1] ?? "different" },
  ])
    expect(
      (await resolveFederationTargets(db, registry, [changed], context)).selections,
    ).toHaveLength(0);
  await db
    .update(schedulerQueues)
    .set({ visibleOrgIds: [] })
    .where(eq(schedulerQueues.queueId, first.queueId));
  expect((await resolveFederationTargets(db, registry, [first], context)).selections).toHaveLength(
    0,
  );
});

test("the final target fence rejects changed queue metadata and holds both queue and Agent locks", async () => {
  const target = firstTarget();
  const selection = (await resolveFederationTargets(db, registry, [target], context)).selections[0];
  if (!selection) throw new Error("Missing selection");
  const input = {
    agentId: target.agentId,
    queueId: target.queueId,
    targetMode: "named",
    queueName: "queue-0",
    qos: "",
    updatedAt: selection.targetUpdatedAt,
  };
  await db.transaction(async (tx) => {
    expect(await lockFederationTarget(tx, [target], input)).toEqual(target);
    for (const [table, key, id] of [
      ["agents", "agent_id", target.agentId],
      ["scheduler_queues", "queue_id", target.queueId],
    ]) {
      let code = "unlocked";
      try {
        await db.transaction((other) =>
          other.execute(sql.raw(`select 1 from ${table} where ${key} = '${id}' for update nowait`)),
        );
      } catch (error) {
        code =
          error &&
          typeof error === "object" &&
          "cause" in error &&
          error.cause &&
          typeof error.cause === "object" &&
          "code" in error.cause
            ? String(error.cause.code)
            : "unknown";
      }
      expect(code).toBe("55P03");
    }
  });
  await db
    .update(schedulerQueues)
    .set({ enabled: false })
    .where(eq(schedulerQueues.queueId, target.queueId));
  await expect(db.transaction((tx) => lockFederationTarget(tx, [target], input))).rejects.toThrow(
    "no longer authorized",
  );
});

async function submit() {
  const spec = {
    name: "Federation target placement",
    command: "true",
    resources: { cpus: 1, memoryMb: 16, wallTimeSec: 30 },
  };
  const job = await service.submit(spec, userId, { orgId: consumer });
  jobIds.push(job.id);
  return { jobId: job.id, job: spec, userId, userRole: "user" as const, orgId: consumer };
}

test("placement cannot escape the signed queue set and persists the selected queue", async () => {
  const input = await submit();
  const target = firstTarget();
  const result = await orchestrator.placeAndDispatch({ ...input, federationTargets: [target] });
  expect(result.selectedAgentId).toBe(target.agentId);
  expect(result.dispatched).toBe(true);
  expect(await service.getById(input.jobId)).toMatchObject({
    queueId: target.queueId,
    schedulerQueueName: "queue-0",
  });
  expect(sent).toHaveLength(1);
  const payload = sent[0]?.message.payload;
  expect(payload?.case === "dispatchJob" ? payload.value.queueValidationMode : undefined).toBe(
    QueueValidationMode.ENFORCE,
  );
  expect(
    await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, input.jobId)),
  ).toEqual([expect.objectContaining({ relation: "queue", subjectId: target.queueId })]);
});

test("disabled approved queues and explicit foreign queues never fall back to another cluster", async () => {
  const input = await submit();
  const target = firstTarget();
  await expect(
    orchestrator.placeAndDispatch({
      ...input,
      job: { ...input.job, schedulingStrategy: { queueId: queueIds[1] ?? "different" } },
      federationTargets: [target],
    }),
  ).rejects.toThrow("outside the federation");
  await db
    .update(schedulerQueues)
    .set({ enabled: false })
    .where(eq(schedulerQueues.queueId, target.queueId));
  await expect(
    orchestrator.placeAndDispatch({ ...input, federationTargets: [target] }),
  ).rejects.toThrow("No approved federation queue");
  expect(sent).toHaveLength(0);
  expect((await service.getById(input.jobId))?.status).toBe("pending");
});

test("queue authorization projection failure rolls back assignment before any dispatch", async () => {
  const input = await submit();
  await db.execute(
    sql`create function kq_test_fed_queue_projection_failure() returns trigger language plpgsql as $$ begin raise exception 'projection unavailable'; end $$`,
  );
  await db.execute(
    sql`create trigger kq_test_fed_queue_projection_failure before insert on authz_outbox for each row execute function kq_test_fed_queue_projection_failure()`,
  );
  try {
    await expect(
      orchestrator.placeAndDispatch({ ...input, federationTargets: [firstTarget()] }),
    ).rejects.toThrow();
    expect(await service.getById(input.jobId)).toMatchObject({
      status: "pending",
      queueId: null,
      agentId: null,
      dispatchEpoch: 0,
    });
    expect(sent).toHaveLength(0);
  } finally {
    await db.execute(sql`drop trigger kq_test_fed_queue_projection_failure on authz_outbox`);
    await db.execute(sql`drop function kq_test_fed_queue_projection_failure()`);
  }
});

test("a visibility change during external queue authorization cannot refresh an old permission", async () => {
  const target = firstTarget();
  const result = await resolveFederationTargets(
    db,
    {
      inspectPreferredForSubmit: async (...args) => {
        const authorized = await registry.inspectPreferredForSubmit(...args);
        await db
          .update(schedulerQueues)
          .set({ visibleOrgIds: [], updatedAt: new Date() })
          .where(eq(schedulerQueues.queueId, target.queueId));
        return authorized;
      },
    },
    [target],
    context,
  );
  expect(result.selections).toHaveLength(0);
});

test("an approved named queue remains usable when the unrelated scheduler default is unavailable", async () => {
  const unavailable = spyOn(registry, "autoCandidateRejection").mockResolvedValue(
    "default queue unavailable",
  );
  try {
    const input = await submit();
    const result = await orchestrator.placeAndDispatch({
      ...input,
      federationTargets: [firstTarget()],
    });
    expect(result.dispatched).toBe(true);
    expect((await service.getById(input.jobId))?.schedulerQueueName).toBe("queue-0");
  } finally {
    unavailable.mockRestore();
  }
});
