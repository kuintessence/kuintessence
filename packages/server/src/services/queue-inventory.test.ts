import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  agentSchedulerQueueSnapshots,
  agentSchedulerQueues,
  agents,
  auditLog,
  createPgDb,
  orgs,
  type PgDb,
  schedulerQueues,
} from "@kuintessence/db";
import { ErrorCode } from "@kuintessence/shared";
import { and, eq, like } from "drizzle-orm";
import { QueueInventoryService } from "./queue-inventory";
import { QueueRegistryService } from "./queue-registry";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const TEST_RUN_ID = crypto.randomUUID();
const AGENT_ID = `queue-inventory-test-agent-${TEST_RUN_ID}`;
const QUEUE_PREFIX = `queue-inventory-test-${TEST_RUN_ID}-`;

describe("QueueInventoryService", () => {
  let db: PgDb;
  let inventory: QueueInventoryService;
  let providerOrgId: string;
  let consumerOrgId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    inventory = new QueueInventoryService(db);
    const [provider, consumer] = await db
      .insert(orgs)
      .values([
        { name: "queue-inventory-test-provider" },
        { name: "queue-inventory-test-consumer" },
      ])
      .returning();
    if (!provider || !consumer) throw new Error("failed to create queue inventory test orgs");
    providerOrgId = provider.id;
    consumerOrgId = consumer.id;
    await db.insert(agents).values({
      agentId: AGENT_ID,
      siteName: "queue-inventory-test-site",
      providerOrgId,
      siteId: "queue-inventory-test-site",
      clusterId: "queue-inventory-test-cluster",
      topology: {},
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      status: "online",
    });
  });

  beforeEach(async () => {
    await db.delete(agentSchedulerQueues).where(eq(agentSchedulerQueues.agentId, AGENT_ID));
    await db
      .delete(agentSchedulerQueueSnapshots)
      .where(eq(agentSchedulerQueueSnapshots.agentId, AGENT_ID));
  });

  afterAll(async () => {
    await db.delete(schedulerQueues).where(like(schedulerQueues.queueId, `${QUEUE_PREFIX}%`));
    await db
      .delete(auditLog)
      .where(
        and(
          eq(auditLog.actor, "system"),
          like(auditLog.action, "queue.inventory.%"),
          eq(auditLog.target, AGENT_ID),
        ),
      );
    await db.delete(agentSchedulerQueues).where(eq(agentSchedulerQueues.agentId, AGENT_ID));
    await db
      .delete(agentSchedulerQueueSnapshots)
      .where(eq(agentSchedulerQueueSnapshots.agentId, AGENT_ID));
    await db.delete(agents).where(eq(agents.agentId, AGENT_ID));
    await db.delete(orgs).where(eq(orgs.id, providerOrgId));
    await db.delete(orgs).where(eq(orgs.id, consumerOrgId));
  });

  test("replaces successful facts, preserves them after failed collection, and audits default drift", async () => {
    await inventory.declareCapability(AGENT_ID, true);
    const firstObservedAt = new Date();
    await inventory.reconcile(AGENT_ID, {
      status: "available",
      defaultQueueName: "batch",
      observedAt: firstObservedAt,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt: firstObservedAt,
        },
        {
          queueName: "gpu",
          queueType: "partition",
          isDefault: false,
          state: "up",
          acceptsSubmissions: true,
          observedAt: firstObservedAt,
        },
      ],
    });

    const first = await inventory.getForAgent(AGENT_ID);
    expect(first.status).toBe("available");
    expect(first.defaultQueueName).toBe("batch");
    expect(first.queues.map((queue) => queue.queueName).sort()).toEqual(["batch", "gpu"]);

    const secondObservedAt = new Date();
    await inventory.reconcile(AGENT_ID, {
      status: "available",
      defaultQueueName: "gpu",
      observedAt: secondObservedAt,
      queues: [
        {
          queueName: "gpu",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt: secondObservedAt,
        },
      ],
    });
    const second = await inventory.getForAgent(AGENT_ID);
    expect(second.defaultQueueName).toBe("gpu");
    expect(second.queues.map((queue) => queue.queueName)).toEqual(["gpu"]);

    await inventory.reconcile(AGENT_ID, {
      status: "unavailable",
      reason: "command_failed",
      observedAt: new Date(),
      queues: [],
    });
    const failed = await inventory.getForAgent(AGENT_ID);
    expect(failed.status).toBe("unavailable");
    expect(failed.reason).toBe("command_failed");
    expect(failed.queues.map((queue) => queue.queueName)).toEqual(["gpu"]);

    const audit = await db
      .select()
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "queue.inventory.default_changed"), eq(auditLog.target, AGENT_ID)),
      );
    expect(audit).toHaveLength(1);
  });

  test("returns effective stale status with last-known facts after freshUntil expires", async () => {
    const observedAt = new Date("2026-08-19T00:00:00.000Z");
    const freshInventory = new QueueInventoryService(db, {
      maxAgeSec: 60,
      now: () => observedAt,
    });
    await freshInventory.reconcile(AGENT_ID, {
      status: "available",
      defaultQueueName: "batch",
      observedAt,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt,
        },
      ],
    });

    const staleInventory = new QueueInventoryService(db, {
      maxAgeSec: 60,
      now: () => new Date("2026-08-19T00:01:01.000Z"),
    });
    const inventoryView = await staleInventory.getForAgent(AGENT_ID);

    expect(inventoryView.status).toBe("stale");
    expect(inventoryView.reason).toBe("stale");
    expect(inventoryView.freshUntil).toBeNull();
    expect(inventoryView.lastAttemptAt).toEqual(observedAt);
    expect(inventoryView.lastSuccessfulObservedAt).toEqual(observedAt);
    expect(inventoryView.queues.map((queue) => queue.queueName)).toEqual(["batch"]);
  });

  test("returns warning outside enforce and blocks stale HPC targets in enforce", async () => {
    const observedAt = new Date("2026-08-19T00:00:00.000Z");
    const freshInventory = new QueueInventoryService(db, {
      maxAgeSec: 60,
      now: () => observedAt,
    });
    await freshInventory.reconcile(AGENT_ID, {
      status: "available",
      defaultQueueName: "batch",
      observedAt,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt,
        },
      ],
    });
    const unvalidatedRegistry = new QueueRegistryService(db);
    await unvalidatedRegistry.create(
      {
        queueId: `${QUEUE_PREFIX}eligibility`,
        name: "Eligibility queue",
        visibleOrgIds: [consumerOrgId],
        agentId: AGENT_ID,
        schedulerType: "slurm",
        queueName: "batch",
        enabled: true,
        policyTags: [],
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    await unvalidatedRegistry.create(
      {
        queueId: `${QUEUE_PREFIX}mismatch`,
        name: "Mismatched queue",
        visibleOrgIds: [consumerOrgId],
        agentId: AGENT_ID,
        schedulerType: "torque",
        queueName: "batch",
        enabled: true,
        policyTags: [],
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const staleInventory = new QueueInventoryService(db, {
      maxAgeSec: 60,
      now: () => new Date("2026-08-19T00:01:01.000Z"),
    });

    for (const [validationMode, expectedState] of [
      ["off", "warning"],
      ["shadow", "warning"],
      ["enforce", "blocked"],
    ] as const) {
      const registry = new QueueRegistryService(db, undefined, {
        inventory: staleInventory,
        validationMode,
      });
      const visible = await registry.listVisible({ role: "user", orgId: consumerOrgId });
      const eligibility = visible.find(
        (queue) => queue.queueId === `${QUEUE_PREFIX}eligibility`,
      )?.submitEligibility;
      const mismatch = visible.find(
        (queue) => queue.queueId === `${QUEUE_PREFIX}mismatch`,
      )?.submitEligibility;
      expect(eligibility).toEqual({ state: expectedState, reason: "stale", retryable: true });
      expect(mismatch).toEqual({
        state: "blocked",
        reason: "scheduler_mismatch",
        retryable: false,
      });
    }
  });

  test("enforces fresh observed named and default targets while keeping structured errors", async () => {
    const registry = new QueueRegistryService(db, undefined, {
      inventory,
      validationMode: "enforce",
    });
    const observedAt = new Date();
    await inventory.reconcile(AGENT_ID, {
      status: "available",
      defaultQueueName: "batch",
      observedAt,
      queues: [
        {
          queueName: "batch",
          queueType: "partition",
          isDefault: true,
          state: "up",
          acceptsSubmissions: true,
          observedAt,
        },
      ],
    });
    await registry.create(
      {
        queueId: `${QUEUE_PREFIX}default`,
        name: "Inventory default",
        visibleOrgIds: [consumerOrgId],
        agentId: AGENT_ID,
        schedulerType: "slurm",
        target: { mode: "default" },
        enabled: true,
        policyTags: [],
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const selected = await registry.resolveForSubmit(`${QUEUE_PREFIX}default`, {
      role: "user",
      orgId: consumerOrgId,
    });
    expect(selected).toMatchObject({
      targetMode: "default",
      resolvedQueueName: "batch",
    });
    expect(selected?.queueName).toBeUndefined();

    await inventory.reconcile(AGENT_ID, {
      status: "unavailable",
      reason: "command_failed",
      observedAt: new Date(),
      queues: [],
    });
    await expect(
      registry.resolveForSubmit(`${QUEUE_PREFIX}default`, {
        role: "user",
        orgId: consumerOrgId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.QUEUE_INVENTORY_UNAVAILABLE,
      statusCode: 503,
      details: { reason: "command_failed", retryable: true },
    });
  });

  test("persists no-go across immediate ready and recovers only after continuous health", async () => {
    let now = new Date("2026-08-20T00:00:00.000Z");
    const options = {
      maxAgeSec: 10,
      recoveryHoldSec: 20,
      now: () => now,
    };
    const recoveryInventory = new QueueInventoryService(db, options);
    const available = () => ({
      status: "available" as const,
      defaultQueueName: "batch",
      observedAt: now,
      queues: [
        {
          queueName: "batch",
          queueType: "partition" as const,
          isDefault: true,
          state: "up" as const,
          acceptsSubmissions: true,
          observedAt: now,
        },
      ],
    });
    await recoveryInventory.declareCapability(AGENT_ID, true);
    await recoveryInventory.reconcile(AGENT_ID, available());
    const registrySeed = new QueueRegistryService(db);
    await registrySeed.create(
      {
        queueId: `${QUEUE_PREFIX}persistent-no-go`,
        name: "Persistent no-go queue",
        visibleOrgIds: [consumerOrgId],
        agentId: AGENT_ID,
        schedulerType: "slurm",
        queueName: "batch",
        enabled: true,
        policyTags: [],
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const healthyCoverage = await recoveryInventory.getCoverage();

    now = new Date("2026-08-20T00:00:01.000Z");
    await recoveryInventory.reconcile(AGENT_ID, {
      status: "unavailable",
      reason: "command_failed",
      observedAt: now,
      queues: [],
    });
    const lastNoGoAt = now;

    now = new Date("2026-08-20T00:00:02.000Z");
    await recoveryInventory.reconcile(AGENT_ID, available());
    const restartedInventory = new QueueInventoryService(db, options);
    const immediateReady = await restartedInventory.getForAgent(AGENT_ID);
    const faultedCoverage = await restartedInventory.getCoverage();
    expect(immediateReady).toMatchObject({
      status: "unavailable",
      reason: "command_failed",
      lastNoGoAt,
      noGoReason: "command_failed",
      recoveryStartedAt: now,
      recoveredAt: null,
    });
    expect(faultedCoverage.activeNoGoAgents).toBe(healthyCoverage.activeNoGoAgents + 1);
    expect(faultedCoverage.lastNoGoAt).toEqual(lastNoGoAt);
    expect(faultedCoverage.statusCounts.available).toBe(healthyCoverage.statusCounts.available - 1);
    expect(faultedCoverage.statusCounts.unavailable).toBe(
      healthyCoverage.statusCounts.unavailable + 1,
    );

    const enforcedRegistry = new QueueRegistryService(db, undefined, {
      inventory: restartedInventory,
      validationMode: "enforce",
    });
    await expect(
      enforcedRegistry.resolveForSubmit(`${QUEUE_PREFIX}persistent-no-go`, {
        role: "user",
        orgId: consumerOrgId,
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.QUEUE_INVENTORY_UNAVAILABLE,
      statusCode: 503,
      details: { reason: "command_failed", retryable: true },
    });

    now = new Date("2026-08-20T00:00:13.000Z");
    await restartedInventory.reconcile(AGENT_ID, available());
    expect(await restartedInventory.getForAgent(AGENT_ID)).toMatchObject({
      status: "unavailable",
      recoveryStartedAt: now,
      recoveredAt: null,
    });

    now = new Date("2026-08-20T00:00:23.000Z");
    await restartedInventory.reconcile(AGENT_ID, available());
    expect((await restartedInventory.getForAgent(AGENT_ID)).status).toBe("unavailable");

    now = new Date("2026-08-20T00:00:33.000Z");
    await restartedInventory.reconcile(AGENT_ID, available());
    const recovered = await restartedInventory.getForAgent(AGENT_ID);
    expect(recovered).toMatchObject({
      status: "available",
      lastNoGoAt,
      noGoReason: "command_failed",
      recoveredAt: now,
    });
    await expect(
      enforcedRegistry.resolveForSubmit(`${QUEUE_PREFIX}persistent-no-go`, {
        role: "user",
        orgId: consumerOrgId,
      }),
    ).resolves.toMatchObject({ resolvedQueueName: "batch" });
    const recoveredCoverage = await restartedInventory.getCoverage();
    expect(recoveredCoverage.activeNoGoAgents).toBe(healthyCoverage.activeNoGoAgents);
    expect(recoveredCoverage.lastNoGoAt).toEqual(lastNoGoAt);
    expect(recoveredCoverage.statusCounts).toEqual(healthyCoverage.statusCounts);
  });
});
