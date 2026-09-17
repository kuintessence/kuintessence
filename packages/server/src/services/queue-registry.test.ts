import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agents, createPgDb, orgs, type PgDb, schedulerQueues } from "@kuintessence/db";
import { eq, like } from "drizzle-orm";
import type { AuthzService } from "../authz/service";
import type { QueueInventoryService } from "./queue-inventory";
import { QueueRegistryService } from "./queue-registry";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("QueueRegistryService", () => {
  let db: PgDb;
  let service: QueueRegistryService;
  let providerOrgId: string;
  let consumerOrgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new QueueRegistryService(db);

    const inserted = await db
      .insert(orgs)
      .values([{ name: "qr-provider" }, { name: "qr-consumer" }, { name: "qr-other" }])
      .returning();
    const [provider, consumer, other] = inserted;
    if (!provider || !consumer || !other) throw new Error("failed to create queue test orgs");
    providerOrgId = provider.id;
    consumerOrgId = consumer.id;
    otherOrgId = other.id;

    await db.insert(agents).values({
      agentId: "qr-agent-1",
      siteName: "qr-site",
      providerOrgId,
      siteId: "qr-site",
      clusterId: "qr-cluster",
      topology: {},
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      status: "online",
    });
  });

  afterAll(async () => {
    await db.delete(schedulerQueues).where(like(schedulerQueues.queueId, "qr-%"));
    await db.delete(agents).where(eq(agents.agentId, "qr-agent-1"));
    await db.delete(orgs).where(eq(orgs.id, providerOrgId));
    await db.delete(orgs).where(eq(orgs.id, consumerOrgId));
    await db.delete(orgs).where(eq(orgs.id, otherOrgId));
  });

  test("creates a provider-owned queue and exposes it to visible orgs", async () => {
    const queue = await service.create(
      {
        queueId: "qr-batch",
        name: "QR batch",
        visibleOrgIds: [consumerOrgId],
        agentId: "qr-agent-1",
        schedulerType: "slurm",
        queueName: "batch",
        enabled: true,
        policyTags: ["gpu"],
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    expect(queue.providerOrgId).toBe(providerOrgId);

    const visible = await service.listVisible({ role: "user", orgId: consumerOrgId });
    expect(visible.map((q) => q.queueId)).toContain("qr-batch");

    const hidden = await service.listVisible({ role: "user", orgId: otherOrgId });
    expect(hidden.map((q) => q.queueId)).not.toContain("qr-batch");
  });

  test("resolves enabled visible queues for submission", async () => {
    const selected = await service.resolveForSubmit("qr-batch", {
      role: "user",
      orgId: consumerOrgId,
    });
    expect(selected?.agentId).toBe("qr-agent-1");
    expect(selected?.targetMode).toBe("named");
    expect(selected?.queueName).toBe("batch");
  });

  test("resolves a default target without emitting a named scheduler queue", async () => {
    await service.create(
      {
        queueId: "qr-default",
        name: "QR scheduler default",
        visibleOrgIds: [consumerOrgId],
        agentId: "qr-agent-1",
        schedulerType: "slurm",
        target: { mode: "default" },
        enabled: true,
        policyTags: [],
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const selected = await service.resolveForSubmit("qr-default", {
      role: "user",
      orgId: consumerOrgId,
    });
    expect(selected?.targetMode).toBe("default");
    expect(selected?.queueName).toBeUndefined();
  });

  test("rejects disabled and cross-org queue submissions", async () => {
    await service.update(
      "qr-batch",
      { enabled: false },
      { role: "org_admin", orgId: providerOrgId },
    );
    await expect(
      service.resolveForSubmit("qr-batch", { role: "user", orgId: consumerOrgId }),
    ).rejects.toThrow(/disabled/);

    await service.update(
      "qr-batch",
      { enabled: true },
      { role: "org_admin", orgId: providerOrgId },
    );
    await expect(
      service.resolveForSubmit("qr-batch", { role: "user", orgId: otherOrgId }),
    ).rejects.toThrow(/not visible/);
  });

  test("records unavailable preferred targets while retaining the soft fallback", async () => {
    await db.insert(schedulerQueues).values([
      {
        queueId: "qr-prefer-disabled",
        name: "QR preferred disabled",
        providerOrgId,
        visibleOrgIds: [consumerOrgId],
        agentId: "qr-agent-1",
        schedulerType: "slurm",
        queueName: "disabled",
        enabled: false,
        policyTags: [],
      },
      {
        queueId: "qr-prefer-hidden",
        name: "QR preferred hidden",
        providerOrgId,
        visibleOrgIds: [otherOrgId],
        agentId: "qr-agent-1",
        schedulerType: "slurm",
        queueName: "hidden",
        enabled: true,
        policyTags: [],
      },
    ]);

    const resolution = await service.inspectPreferredForSubmit(
      ["qr-prefer-missing", "qr-prefer-disabled", "qr-prefer-hidden"],
      { role: "user", orgId: consumerOrgId },
    );

    expect(resolution.selections).toEqual([]);
    expect(resolution.rejections).toEqual([
      { queueId: "qr-prefer-missing", code: "NOT_FOUND", reason: "queue_not_found" },
      {
        queueId: "qr-prefer-disabled",
        code: "QUEUE_UNAVAILABLE",
        reason: "queue_disabled",
      },
      { queueId: "qr-prefer-hidden", code: "FORBIDDEN", reason: "queue_not_visible" },
    ]);
  });

  test("allows a stale named fact to be prebuilt disabled but not enabled", async () => {
    const staleInventory = {
      assertAgentBinding: async () => ({ schedulerType: "slurm" }),
      inspectTarget: async () => ({
        capabilityDeclared: true,
        inventoryAvailable: false,
        targetAvailable: false,
        state: "stale",
        reason: "stale",
        observedAt: new Date("2026-08-19T00:00:00.000Z"),
        resolvedQueueName: null,
      }),
    } as unknown as QueueInventoryService;
    const guardedService = new QueueRegistryService(db, undefined, {
      inventory: staleInventory,
      validationMode: "shadow",
    });

    await guardedService.create(
      {
        queueId: "qr-stale-named",
        name: "QR stale named",
        visibleOrgIds: [consumerOrgId],
        agentId: "qr-agent-1",
        schedulerType: "slurm",
        target: { mode: "named" },
        queueName: "last-known",
        enabled: false,
        policyTags: [],
      },
      { role: "org_admin", orgId: providerOrgId },
    );

    await expect(
      guardedService.update(
        "qr-stale-named",
        { enabled: true },
        { role: "org_admin", orgId: providerOrgId },
      ),
    ).rejects.toThrow(/inventory is unavailable/);
  });

  test("keeps disabled queues hidden in enforce mode even when SpiceDB allows view", async () => {
    const queueId = "qr-disabled-enforce";
    await db.delete(schedulerQueues).where(eq(schedulerQueues.queueId, queueId));
    await db.insert(schedulerQueues).values({
      queueId,
      name: "QR disabled enforce",
      providerOrgId,
      visibleOrgIds: [consumerOrgId],
      agentId: "qr-agent-1",
      schedulerType: "slurm",
      queueName: "disabled",
      enabled: false,
      policyTags: [],
    });
    const authz = {
      mode: "enforce",
      requirePermission: async () => {},
    } as unknown as AuthzService;
    const enforcingService = new QueueRegistryService(db, authz);

    const visible = await enforcingService.listVisible({
      role: "user",
      orgId: consumerOrgId,
      userId: "00000000-0000-4000-8000-00000000a001",
    });

    expect(visible.map((queue) => queue.queueId)).not.toContain(queueId);
  });
});
