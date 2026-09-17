import { describe, expect, test } from "bun:test";
import type { PgDb } from "@kuintessence/db";
import { ErrorCode } from "@kuintessence/shared";
import type { AuthzService } from "../authz/service";
import { QueueRegistryService } from "./queue-registry";

interface FakeQueueRow {
  queueId: string;
  name: string;
  providerOrgId: string;
  visibleOrgIds: string[];
  agentId: string;
  schedulerType: string;
  targetMode?: "default" | "named";
  queueName: string | null;
  qos: string | null;
  enabled: boolean;
  policyTags: string[];
  createdAt: Date;
  updatedAt: Date;
}

const queueRow: FakeQueueRow = {
  queueId: "queue-1",
  name: "Queue 1",
  providerOrgId: "provider-org",
  visibleOrgIds: ["consumer-org"],
  agentId: "agent-1",
  schedulerType: "slurm",
  queueName: "batch",
  qos: null,
  enabled: true,
  policyTags: [],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function fakeQueueDb(rows: FakeQueueRow[] = [queueRow]): PgDb {
  return {
    select: () => ({
      from: () => {
        const result = Promise.resolve(rows) as Promise<typeof rows> & {
          where: () => { limit: () => Promise<typeof rows> };
        };
        result.where = () => ({
          limit: async () => rows.slice(0, 1),
        });
        return result;
      },
    }),
  } as unknown as PgDb;
}

function fakeQueueCreateDb(): PgDb {
  return {
    insert: () => ({
      values: (row: unknown) => ({
        returning: async () => [
          {
            ...(row as typeof queueRow),
            createdAt: new Date(0),
            updatedAt: new Date(0),
          },
        ],
      }),
    }),
  } as unknown as PgDb;
}

describe("QueueRegistryService SpiceDB authorization", () => {
  test("checks provider#manage when creating a queue in enforce mode", async () => {
    const calls: unknown[] = [];
    const enqueued: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
      enqueueMany: async (tuples: unknown[]) => {
        enqueued.push(...tuples);
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueCreateDb(), authz);

    const queue = await service.create(
      {
        queueId: "queue-new",
        name: "Queue New",
        providerOrgId: "provider-org",
        visibleOrgIds: [],
        agentId: "agent-1",
        schedulerType: "slurm",
        queueName: "batch",
        enabled: true,
        policyTags: [],
      },
      {
        role: "user",
        orgId: "other-org",
        userId: "user-1",
        email: "user@example.com",
      },
    );

    expect(queue.queueId).toBe("queue-new");
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "provider", id: "provider-org" },
        permission: "manage",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false, source: "queue-create" },
        localAllowed: false,
      },
    ]);
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        resource: { type: "queue", id: "queue-new" },
        relation: "provider",
      }),
    );
  });

  test("filters visible queues denied by queue#view in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
        throw new Error("denied");
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueDb(), authz);

    const queues = await service.listVisible({
      role: "user",
      orgId: "consumer-org",
      userId: "user-1",
      email: "user@example.com",
    });

    expect(queues).toEqual([]);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "queue", id: "queue-1" },
        permission: "view",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: true },
        localAllowed: true,
      },
    ]);
  });

  test("rejects submit when queue#submit is denied in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
        throw new Error("denied");
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueDb(), authz);

    await expect(
      service.resolveForSubmit("queue-1", {
        role: "user",
        orgId: "consumer-org",
        userId: "user-1",
        email: "user@example.com",
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
      statusCode: 403,
    });
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "queue", id: "queue-1" },
        permission: "submit",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: true },
        localAllowed: true,
      },
    ]);
  });

  test("fails closed in enforce mode when canonical user id is missing", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueDb(), authz);

    await expect(
      service.resolveForSubmit("queue-1", {
        role: "user",
        orgId: "consumer-org",
        email: "user@example.com",
      }),
    ).rejects.toThrow("Authorization principal is not bound");
    expect(calls).toEqual([]);
  });

  test("fails closed in shadow mode when canonical user id is missing", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueDb(), authz);

    await expect(
      service.resolveForSubmit("queue-1", {
        role: "user",
        orgId: "consumer-org",
        email: "user@example.com",
      }),
    ).rejects.toThrow("Authorization principal is not bound");
    expect(calls).toEqual([]);
  });

  test("shows queues visible only through queue#view as blocked for submit in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: { permission: string }) => {
        calls.push(input);
        if (input.permission === "submit") throw new Error("denied");
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueDb(), authz);

    const queues = await service.listVisible({
      role: "user",
      orgId: "other-org",
      userId: "user-1",
      email: "user@example.com",
    });

    expect(queues.map((queue) => queue.queueId)).toEqual(["queue-1"]);
    expect(queues[0]?.submitEligibility).toEqual({
      state: "blocked",
      reason: "submit_permission_missing",
      retryable: false,
    });
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "queue", id: "queue-1" },
        permission: "view",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false },
        localAllowed: false,
      },
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "queue", id: "queue-1" },
        permission: "submit",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false },
        localAllowed: false,
      },
    ]);
  });

  test("allows admin list entries authorized only through queue#manage in enforce mode", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueDb(), authz);

    const queues = await service.listAdmin({
      role: "org_admin",
      orgId: "other-org",
      userId: "admin-1",
      email: "admin@example.com",
    });

    expect(queues.map((queue) => queue.queueId)).toEqual(["queue-1"]);
    expect(calls).toEqual([
      {
        actorUserId: "admin-1",
        actorEmail: "admin@example.com",
        resource: { type: "queue", id: "queue-1" },
        permission: "manage",
        subject: { type: "user", id: "admin-1" },
        context: { localAllowed: false },
        localAllowed: false,
      },
    ]);
  });

  test("allows submit through queue#submit even when local visible-org check is false", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const service = new QueueRegistryService(fakeQueueDb(), authz);

    const selected = await service.resolveForSubmit("queue-1", {
      role: "user",
      orgId: "other-org",
      userId: "user-1",
      email: "user@example.com",
    });

    expect(selected?.queueId).toBe("queue-1");
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "queue", id: "queue-1" },
        permission: "submit",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false },
        localAllowed: false,
      },
    ]);
  });

  test("resolves a default target without a named scheduler queue", async () => {
    const service = new QueueRegistryService(
      fakeQueueDb([{ ...queueRow, targetMode: "default", queueName: null }]),
    );

    const selected = await service.resolveForSubmit("queue-1", {
      role: "user",
      orgId: "consumer-org",
    });

    expect(selected).toMatchObject({
      queueId: "queue-1",
      agentId: "agent-1",
      targetMode: "default",
    });
    expect(selected).not.toHaveProperty("queueName");
  });
});
