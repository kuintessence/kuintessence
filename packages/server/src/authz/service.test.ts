import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { v1 } from "@authzed/authzed-node";
import type { PgDb } from "@kuintessence/db";
import {
  agentPlatformTuple,
  agentProviderTuple,
  clusterFileRootPlatformTuple,
  jobConsumerOrgTuple,
  jobOwnerTuple,
  jobPlatformTuple,
  jobSubmissionTuples,
  netdriveConsumerOrgTuple,
  netdrivePlatformTuple,
  organizationMembershipReplacementTuples,
  organizationMembershipTuple,
  platformMemberTuple,
  platformRoleReplacementTuples,
  platformRoleTuple,
  providerPlatformTuple,
  queuePlatformTuple,
  queueVisibleOrgTuple,
  softwareAssetGrantTuples,
  softwareAssetProviderTuple,
  softwareAssetPublicGrantTuples,
  sshCredentialPlatformTuple,
  sshRecordingActorTuple,
  sshRecordingPlatformTuple,
  sshSessionAgentTuple,
  sshSessionOpenerTuple,
  sshSessionPlatformTuple,
  workflowConsumerOrgTuple,
  workflowPlatformTuple,
} from "./projection";
import { AuthzService, coalesceAuthzTuples } from "./service";

const db = {} as PgDb;

type FakeBulkClient = {
  promises: {
    checkBulkPermissions?: (
      request: v1.CheckBulkPermissionsRequest,
    ) => Promise<v1.CheckBulkPermissionsResponse>;
    checkPermission?: (request: v1.CheckPermissionRequest) => Promise<v1.CheckPermissionResponse>;
    lookupResources?: (request: v1.LookupResourcesRequest) => Promise<v1.LookupResourcesResponse[]>;
    readSchema?: (request: v1.ReadSchemaRequest) => Promise<v1.ReadSchemaResponse>;
    writeRelationships?: (request: v1.WriteRelationshipsRequest) => Promise<void>;
    writeSchema?: (request: v1.WriteSchemaRequest) => Promise<void>;
    deleteRelationships?: (request: v1.DeleteRelationshipsRequest) => Promise<void>;
  };
  close: () => void;
};

function fakeAuditDb(): { db: PgDb; rows: Record<string, unknown>[] } {
  const rows: Record<string, unknown>[] = [];
  const auditDb = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        rows.push(row);
      },
    }),
  } as unknown as PgDb;
  return { db: auditDb, rows };
}

function fakeOutboxDb(row: Record<string, unknown>): {
  db: PgDb;
  updates: Record<string, unknown>[];
  claimRows: Record<string, unknown>[];
  claimConditions: unknown[];
  selectionConditions: unknown[];
} {
  const updates: Record<string, unknown>[] = [];
  const claimRows: Record<string, unknown>[] = [{ id: row.id }];
  const claimConditions: unknown[] = [];
  const selectionConditions: unknown[] = [];
  let selectionCount = 0;
  const outboxDb = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => {
          selectionConditions.push(condition);
          return {
            orderBy: () => ({
              limit: async () => (selectionCount++ === 0 ? [row] : []),
            }),
          };
        },
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: (condition: unknown) => {
          updates.push(value);
          claimConditions.push(condition);
          return {
            returning: async () => claimRows,
          };
        },
      }),
    }),
  } as unknown as PgDb;
  return { db: outboxDb, updates, claimRows, claimConditions, selectionConditions };
}

function fakeSequentialOutboxDb(): {
  db: PgDb;
  rows: Array<Record<string, unknown>>;
} {
  const rows = [1, 2, 3].map((sequence) => ({
    id: `00000000-0000-4000-8000-00000000010${sequence}`,
    sequence,
    operation: "create",
    resourceType: "organization",
    resourceId: "org-1",
    relation: "member",
    subjectType: "user",
    subjectId: `u-${sequence}`,
    subjectRelation: null,
    payload: {},
    attempts: 0,
    status: "pending",
  }));
  const outboxDb = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => {
              const next = rows.find((row, index) => {
                if (row.status !== "pending") return false;
                return rows.slice(0, index).every((earlier) => earlier.status === "succeeded");
              });
              return next ? [next] : [];
            },
          }),
        }),
      }),
    }),
    update: () => ({
      set: (value: Record<string, unknown>) => ({
        where: () => {
          const row =
            value.status === "processing"
              ? rows.find((candidate) => candidate.status === "pending")
              : rows.find((candidate) => candidate.status === "processing");
          if (row) Object.assign(row, value);
          return {
            returning: async () => (row ? [{ id: row.id }] : []),
          };
        },
      }),
    }),
  } as unknown as PgDb;
  return { db: outboxDb, rows };
}

describe("AuthzService", () => {
  test("coalesces repeated relationship mutations to their final operation", () => {
    const relationship = {
      resource: { type: "cluster_file_root", id: "root-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    };

    expect(
      coalesceAuthzTuples([
        { ...relationship, operation: "delete" },
        { ...relationship, operation: "create", payload: { revision: "new" } },
        {
          operation: "delete",
          resource: { type: "cluster_file_root", id: "root-1" },
          relation: "visible_org",
          subject: { type: "organization", id: "org-old" },
        },
      ]),
    ).toEqual([
      { ...relationship, operation: "create", payload: { revision: "new" } },
      {
        operation: "delete",
        resource: { type: "cluster_file_root", id: "root-1" },
        relation: "visible_org",
        subject: { type: "organization", id: "org-old" },
      },
    ]);
  });

  test("off mode is configured but non-blocking", async () => {
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    await expect(
      service.check({
        resource: { type: "queue", id: "q-1" },
        permission: "submit",
        subject: { type: "user", id: "u-1" },
      }),
    ).resolves.toBe(true);
    await expect(
      service.checkBulk([
        {
          resource: { type: "queue", id: "q-1" },
          permission: "submit",
          subject: { type: "user", id: "u-1" },
        },
      ]),
    ).resolves.toEqual([true]);
    await expect(service.health()).resolves.toMatchObject({
      mode: "off",
      configured: false,
      healthy: false,
      schemaMatches: false,
    });
  });

  test("health reports schema mismatch when SpiceDB schema drifts from disk", async () => {
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        readSchema: async () => v1.ReadSchemaResponse.create({ schemaText: "definition user {}" }),
      },
      close: () => undefined,
    });

    await expect(service.health()).resolves.toMatchObject({
      configured: true,
      healthy: true,
      schemaWritten: false,
      schemaMatches: false,
    });
  });

  test("health tolerates whitespace-only schema differences", async () => {
    const schema = await readFile("authz/schema.zed", "utf8");
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        readSchema: async () => v1.ReadSchemaResponse.create({ schemaText: `\r\n${schema}\r\n` }),
      },
      close: () => undefined,
    });

    await expect(service.health()).resolves.toMatchObject({
      configured: true,
      healthy: true,
      schemaMatches: true,
    });
  });

  test("health tolerates SpiceDB definition ordering differences", async () => {
    const schema = await readFile("authz/schema.zed", "utf8");
    const reorderedSchema = [...schema.matchAll(/definition\s+[A-Za-z_][A-Za-z0-9_]*\s*\{[^}]*\}/g)]
      .map((match) => match[0])
      .reverse()
      .join("\n");
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        readSchema: async () => v1.ReadSchemaResponse.create({ schemaText: reorderedSchema }),
      },
      close: () => undefined,
    });

    await expect(service.health()).resolves.toMatchObject({
      configured: true,
      healthy: true,
      schemaMatches: true,
    });
  });

  test("checkBulk uses SpiceDB CheckBulkPermissions and preserves response ordering", async () => {
    const captured: { request: v1.CheckBulkPermissionsRequest | null } = { request: null };
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        checkBulkPermissions: async (request) => {
          captured.request = request;
          return v1.CheckBulkPermissionsResponse.create({
            pairs: [
              {
                response: {
                  oneofKind: "item",
                  item: v1.CheckBulkPermissionsResponseItem.create({
                    permissionship: v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
                  }),
                },
              },
              {
                response: {
                  oneofKind: "item",
                  item: v1.CheckBulkPermissionsResponseItem.create({
                    permissionship: v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
                  }),
                },
              },
            ],
          });
        },
      },
      close: () => undefined,
    });
    await expect(
      service.checkBulk([
        {
          resource: { type: "queue", id: "q-1" },
          permission: "submit",
          subject: { type: "user", id: "u-1" },
        },
        {
          resource: { type: "job", id: "j-1" },
          permission: "cancel",
          subject: { type: "user", id: "u-2" },
        },
      ]),
    ).resolves.toEqual([true, false]);
    expect(captured.request?.items.length).toBe(2);
    expect(captured.request?.items[0]?.resource?.objectType).toBe("queue");
    expect(captured.request?.items[0]?.permission).toBe("submit");
    expect(captured.request?.items[1]?.resource?.objectType).toBe("job");
    expect(captured.request?.items[1]?.subject?.object?.objectId).toBe("u-2");
  });

  test("checkBulk fails closed when SpiceDB returns a per-item error", async () => {
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        checkBulkPermissions: async () =>
          v1.CheckBulkPermissionsResponse.create({
            pairs: [
              {
                response: {
                  oneofKind: "error",
                  error: { code: 7, message: "permission check failed", details: [] },
                },
              },
            ],
          }),
      },
      close: () => undefined,
    });
    await expect(
      service.checkBulk([
        {
          resource: { type: "queue", id: "q-1" },
          permission: "submit",
          subject: { type: "user", id: "u-1" },
        },
      ]),
    ).rejects.toThrow("permission check failed");
  });

  test("lookupResources removes duplicate resource ids while preserving first-seen order", async () => {
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        lookupResources: async () => [
          v1.LookupResourcesResponse.create({ resourceObjectId: "queue-1" }),
          v1.LookupResourcesResponse.create({ resourceObjectId: "queue-1" }),
          v1.LookupResourcesResponse.create({ resourceObjectId: "" }),
          v1.LookupResourcesResponse.create({ resourceObjectId: "queue-2" }),
        ],
      },
      close: () => undefined,
    });
    await expect(
      service.lookupResources({
        resourceType: "queue",
        permission: "submit",
        subject: { type: "user", id: "u-1" },
      }),
    ).resolves.toEqual(["queue-1", "queue-2"]);
  });

  test("replaceAllRelationships writes schema, purges managed resource types, and rewrites tuples", async () => {
    const writes: v1.WriteRelationshipsRequest[] = [];
    const purgedTypes: string[] = [];
    let schemaWrites = 0;
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        writeSchema: async () => {
          schemaWrites += 1;
        },
        deleteRelationships: async (request) => {
          purgedTypes.push(request.relationshipFilter?.resourceType ?? "");
        },
        writeRelationships: async (request) => {
          writes.push(request);
        },
      },
      close: () => undefined,
    });

    await expect(
      service.replaceAllRelationships([
        {
          operation: "create",
          resource: { type: "queue", id: "q-1" },
          relation: "submitter",
          subject: { type: "user", id: "u-1" },
        },
      ]),
    ).resolves.toEqual({
      purgedResourceTypes: [
        "platform",
        "organization",
        "provider",
        "agent",
        "queue",
        "software_asset",
        "data_asset",
        "job",
        "workflow",
        "netdrive_file",
        "cluster_file_root",
        "ssh_credential",
        "ssh_session",
        "ssh_recording",
      ],
      tupleCount: 1,
    });
    expect(schemaWrites).toBe(1);
    expect(purgedTypes).toContain("platform");
    expect(purgedTypes).toContain("ssh_recording");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.updates[0]?.relationship?.resource?.objectType).toBe("queue");
  });

  test("requirePermission audits platform administrator degraded fallback before allowing", async () => {
    const audit = fakeAuditDb();
    const service = new AuthzService({
      mode: "enforce",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: audit.db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        checkPermission: async () => {
          throw new Error("spicedb unavailable");
        },
      },
      close: () => undefined,
    });
    await expect(
      service.requirePermission(
        {
          actorUserId: "00000000-0000-0000-0000-000000000001",
          actorEmail: "admin@kuintessence.test",
          resource: { type: "queue", id: "q-1" },
          permission: "submit",
          subject: { type: "user", id: "00000000-0000-0000-0000-000000000001" },
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor).toBe("00000000-0000-0000-0000-000000000001");
    expect(audit.rows[0]?.action).toBe("authz.degraded_fallback");
    expect(audit.rows[0]?.target).toBe("queue:q-1#submit");
    expect(JSON.stringify(audit.rows[0]?.diff)).toContain("spicedb unavailable");
  });

  test("requirePermission falls back to actor email in degraded fallback audit when canonical user is missing", async () => {
    const audit = fakeAuditDb();
    const service = new AuthzService({
      mode: "enforce",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: audit.db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        checkPermission: async () => {
          throw new Error("spicedb unavailable");
        },
      },
      close: () => undefined,
    });
    await expect(
      service.requirePermission(
        {
          actorEmail: "admin@kuintessence.test",
          resource: { type: "queue", id: "q-1" },
          permission: "submit",
          subject: { type: "user", id: "00000000-0000-0000-0000-000000000001" },
        },
        true,
      ),
    ).resolves.toBeUndefined();
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.actor).toBe("admin@kuintessence.test");
  });

  test("requirePermission does not degrade a SpiceDB denial", async () => {
    const audit = fakeAuditDb();
    const service = new AuthzService({
      mode: "enforce",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: audit.db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        checkPermission: async () =>
          v1.CheckPermissionResponse.create({
            permissionship: v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
          }),
      },
      close: () => undefined,
    });
    await expect(
      service.requirePermission(
        {
          actorEmail: "admin@kuintessence.test",
          resource: { type: "queue", id: "q-1" },
          permission: "submit",
          subject: { type: "user", id: "00000000-0000-0000-0000-000000000001" },
        },
        true,
      ),
    ).rejects.toThrow("Authorization denied");
    expect(audit.rows).toHaveLength(0);
  });

  test("processOutbox reclaims an expired processing row with a fresh lease", async () => {
    const outbox = fakeOutboxDb({
      id: "00000000-0000-4000-8000-000000000001",
      operation: "create",
      resourceType: "queue",
      resourceId: "q-1",
      relation: "submitter",
      subjectType: "user",
      subjectId: "u-1",
      subjectRelation: null,
      payload: {},
      attempts: 2,
    });
    const writes: v1.WriteRelationshipsRequest[] = [];
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: outbox.db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        writeRelationships: async (request) => {
          writes.push(request);
        },
      },
      close: () => undefined,
    });

    const before = Date.now();
    await expect(service.processOutbox(10)).resolves.toEqual({ processed: 1, dead: 0 });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.updates[0]?.relationship?.resource?.objectType).toBe("queue");
    expect(outbox.updates[0]).toMatchObject({ status: "processing", attempts: 3 });
    expect(outbox.updates[0]?.nextAttemptAt).toBeInstanceOf(Date);
    expect((outbox.updates[0]?.nextAttemptAt as Date).getTime()).toBeGreaterThan(before);
    expect(outbox.updates[1]).toMatchObject({
      status: "succeeded",
      lastError: null,
    });
  });

  test("processOutbox gives an operator-retried row a fresh delivery window", async () => {
    const outbox = fakeOutboxDb({
      id: "00000000-0000-4000-8000-000000000009",
      operation: "create",
      resourceType: "queue",
      resourceId: "q-retried",
      relation: "submitter",
      subjectType: "user",
      subjectId: "u-retried",
      subjectRelation: null,
      payload: {},
      attempts: 0,
    });
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: outbox.db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        writeRelationships: async () => {
          throw new Error("SpiceDB remains unavailable");
        },
      },
      close: () => undefined,
    });

    await expect(service.processOutbox(1, { forcePending: true })).resolves.toEqual({
      processed: 0,
      dead: 0,
    });

    expect(outbox.updates[0]).toMatchObject({ status: "processing", attempts: 1 });
    expect(outbox.updates[1]).toMatchObject({
      status: "pending",
      lastError: "SpiceDB remains unavailable",
    });
  });

  test("processOutbox skips a row when another worker already claimed it", async () => {
    const outbox = fakeOutboxDb({
      id: "00000000-0000-4000-8000-000000000002",
      operation: "create",
      resourceType: "queue",
      resourceId: "q-2",
      relation: "submitter",
      subjectType: "user",
      subjectId: "u-2",
      subjectRelation: null,
      payload: {},
      attempts: 0,
    });
    outbox.claimRows.length = 0;
    const writes: v1.WriteRelationshipsRequest[] = [];
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: outbox.db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: {
        writeRelationships: async (request) => {
          writes.push(request);
        },
      },
      close: () => undefined,
    });

    await expect(service.processOutbox(10)).resolves.toEqual({ processed: 0, dead: 0 });

    expect(writes).toHaveLength(0);
    expect(outbox.updates).toHaveLength(1);
    expect(outbox.updates[0]).toMatchObject({ status: "processing", attempts: 1 });
  });

  test("processOutbox leaves a resource queued when an earlier mutation is dead", async () => {
    const outbox = fakeOutboxDb({
      id: "00000000-0000-4000-8000-000000000003",
      sequence: 2,
      operation: "create",
      resourceType: "data_asset",
      resourceId: "asset-1",
      relation: "user",
      subjectType: "user",
      subjectId: "u-1",
      subjectRelation: null,
      payload: {},
      attempts: 0,
    });
    outbox.claimRows.length = 0;
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: outbox.db,
      platformAdminDegrade: true,
    });
    const writes: v1.WriteRelationshipsRequest[] = [];
    injectFakeClient(service, {
      promises: { writeRelationships: async (request) => void writes.push(request) },
      close: () => undefined,
    });

    await expect(service.processOutbox(10)).resolves.toEqual({ processed: 0, dead: 0 });

    expect(writes).toEqual([]);
    expect(outbox.claimConditions).toHaveLength(1);
  });

  test("processOutbox applies the resource barrier before bounding the candidate batch", async () => {
    const outbox = fakeOutboxDb({
      id: "00000000-0000-4000-8000-000000000005",
      sequence: 101,
      operation: "create",
      resourceType: "workflow",
      resourceId: "independent-workflow",
      relation: "owner",
      subjectType: "user",
      subjectId: "u-1",
      subjectRelation: null,
      payload: {},
      attempts: 0,
    });
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: outbox.db,
      platformAdminDegrade: true,
    });
    injectFakeClient(service, {
      promises: { writeRelationships: async () => undefined },
      close: () => undefined,
    });

    await expect(service.processOutbox(100)).resolves.toEqual({ processed: 1, dead: 0 });

    expect(outbox.selectionConditions.length).toBeGreaterThan(0);
    expect(inspectSql(outbox.selectionConditions[0])).toContain("earlier");
  });

  test("drains a same-resource mutation chain within one batch budget", async () => {
    const outbox = fakeSequentialOutboxDb();
    const service = new AuthzService({
      mode: "off",
      endpoint: "localhost:50051",
      token: "test-token",
      schemaPath: "authz/schema.zed",
      db: outbox.db,
      platformAdminDegrade: true,
    });
    const subjects: string[] = [];
    injectFakeClient(service, {
      promises: {
        writeRelationships: async (request) => {
          subjects.push(request.updates[0]?.relationship?.subject?.object?.objectId ?? "");
        },
      },
      close: () => undefined,
    });

    await expect(service.processOutbox(3)).resolves.toEqual({ processed: 3, dead: 0 });

    expect(subjects).toEqual(["u-1", "u-2", "u-3"]);
    expect(outbox.rows.map((row) => row.status)).toEqual(["succeeded", "succeeded", "succeeded"]);
  });
});

describe("authz projection", () => {
  test("maps organization membership into SpiceDB tuple shape", () => {
    expect(organizationMembershipTuple({ userId: "u-1", orgId: "o-1", role: "operator" })).toEqual({
      operation: "create",
      resource: { type: "organization", id: "o-1" },
      relation: "operator",
      subject: { type: "user", id: "u-1" },
    });
  });

  test("maps platform_admin to platform admin relation", () => {
    expect(platformRoleTuple({ userId: "u-1", role: "platform_admin" })).toEqual({
      operation: "create",
      resource: { type: "platform", id: "root" },
      relation: "admin",
      subject: { type: "user", id: "u-1" },
    });
  });

  test("maps every authenticated user to platform member relation", () => {
    expect(platformMemberTuple("u-1")).toEqual({
      operation: "create",
      resource: { type: "platform", id: "root" },
      relation: "member",
      subject: { type: "user", id: "u-1" },
    });
  });

  test("replaces organization membership by deleting stale roles before creating the current role", () => {
    expect(
      organizationMembershipReplacementTuples({ userId: "u-1", orgId: "o-1", role: "viewer" }),
    ).toEqual([
      {
        operation: "delete",
        resource: { type: "organization", id: "o-1" },
        relation: "owner",
        subject: { type: "user", id: "u-1" },
      },
      {
        operation: "delete",
        resource: { type: "organization", id: "o-1" },
        relation: "admin",
        subject: { type: "user", id: "u-1" },
      },
      {
        operation: "delete",
        resource: { type: "organization", id: "o-1" },
        relation: "operator",
        subject: { type: "user", id: "u-1" },
      },
      {
        operation: "delete",
        resource: { type: "organization", id: "o-1" },
        relation: "member",
        subject: { type: "user", id: "u-1" },
      },
      {
        operation: "create",
        resource: { type: "organization", id: "o-1" },
        relation: "viewer",
        subject: { type: "user", id: "u-1" },
      },
    ]);
  });

  test("replaces platform role by deleting stale elevated relations before creating the current role", () => {
    expect(platformRoleReplacementTuples({ userId: "u-1", role: "platform_admin" })).toEqual([
      {
        operation: "delete",
        resource: { type: "platform", id: "root" },
        relation: "super_admin",
        subject: { type: "user", id: "u-1" },
      },
      {
        operation: "delete",
        resource: { type: "platform", id: "root" },
        relation: "operator",
        subject: { type: "user", id: "u-1" },
      },
      {
        operation: "create",
        resource: { type: "platform", id: "root" },
        relation: "admin",
        subject: { type: "user", id: "u-1" },
      },
    ]);
    expect(platformRoleReplacementTuples({ userId: "u-1", role: null })).toHaveLength(3);
  });

  test("maps provider-owned resources into relation tuples", () => {
    expect(agentProviderTuple({ agentId: "agent-1", providerOrgId: "org-1" })).toEqual({
      operation: "create",
      resource: { type: "agent", id: "agent-1" },
      relation: "provider",
      subject: { type: "provider", id: "org-1" },
    });
    expect(softwareAssetProviderTuple({ assetId: "asset-1", providerOrgId: "org-1" })).toEqual({
      operation: "create",
      resource: { type: "software_asset", id: "asset-1" },
      relation: "provider",
      subject: { type: "provider", id: "org-1" },
    });
  });

  test("maps software platform grants through platform member permissions", () => {
    expect(
      softwareAssetGrantTuples({
        assetId: "asset-1",
        subjectKind: "platform",
        subjectId: "platform",
        capabilities: ["view", "use", "install"],
        operation: "create",
      }),
    ).toEqual([
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "viewer",
        subject: { type: "platform", id: "root", relation: "software_view" },
      },
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "user",
        subject: { type: "platform", id: "root", relation: "software_use" },
      },
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "installer",
        subject: { type: "platform", id: "root", relation: "software_use" },
      },
    ]);
  });

  test("maps platform-public software assets to platform member grants", () => {
    expect(
      softwareAssetPublicGrantTuples({
        assetId: "asset-1",
        trustedForGlobalUse: false,
        operation: "create",
      }),
    ).toEqual([
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "viewer",
        subject: { type: "platform", id: "root", relation: "software_view" },
      },
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "user",
        subject: { type: "platform", id: "root", relation: "software_use" },
      },
    ]);
    expect(
      softwareAssetPublicGrantTuples({
        assetId: "asset-1",
        trustedForGlobalUse: true,
        operation: "create",
      }),
    ).toContainEqual({
      operation: "create",
      resource: { type: "software_asset", id: "asset-1" },
      relation: "installer",
      subject: { type: "platform", id: "root", relation: "software_use" },
    });
  });

  test("maps software organization grants through organization permission relations", () => {
    expect(
      softwareAssetGrantTuples({
        assetId: "asset-1",
        subjectKind: "org",
        subjectId: "org-1",
        capabilities: ["view", "use", "install"],
        operation: "create",
      }),
    ).toEqual([
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "viewer",
        subject: { type: "organization", id: "org-1", relation: "view" },
      },
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "user",
        subject: { type: "organization", id: "org-1", relation: "use" },
      },
      {
        operation: "create",
        resource: { type: "software_asset", id: "asset-1" },
        relation: "installer",
        subject: { type: "organization", id: "org-1", relation: "use" },
      },
    ]);
  });

  test("maps submit and ownership relations", () => {
    expect(queueVisibleOrgTuple({ queueId: "queue-1", orgId: "org-1" })).toEqual({
      operation: "create",
      resource: { type: "queue", id: "queue-1" },
      relation: "visible_org",
      subject: { type: "organization", id: "org-1" },
    });
    expect(jobOwnerTuple({ jobId: "job-1", userId: "u-1" })).toEqual({
      operation: "create",
      resource: { type: "job", id: "job-1" },
      relation: "owner",
      subject: { type: "user", id: "u-1" },
    });
    expect(jobConsumerOrgTuple({ jobId: "job-1", orgId: "org-1" })).toEqual({
      operation: "create",
      resource: { type: "job", id: "job-1" },
      relation: "consumer_org",
      subject: { type: "organization", id: "org-1" },
    });
    expect(jobPlatformTuple("job-1")).toEqual({
      operation: "create",
      resource: { type: "job", id: "job-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
  });

  test("maps every relationship required by workflow-created jobs", () => {
    expect(
      jobSubmissionTuples({
        jobId: "job-1",
        userId: "u-1",
        orgId: "org-1",
        queueId: "queue-1",
      }),
    ).toEqual([
      jobOwnerTuple({ jobId: "job-1", userId: "u-1" }),
      jobPlatformTuple("job-1"),
      jobConsumerOrgTuple({ jobId: "job-1", orgId: "org-1" }),
      {
        operation: "create",
        resource: { type: "job", id: "job-1" },
        relation: "queue",
        subject: { type: "queue", id: "queue-1" },
      },
    ]);
  });

  test("maps user-scoped resources into org and platform relations", () => {
    expect(netdriveConsumerOrgTuple({ fileId: "file-1", orgId: "org-1" })).toEqual({
      operation: "create",
      resource: { type: "netdrive_file", id: "file-1" },
      relation: "consumer_org",
      subject: { type: "organization", id: "org-1" },
    });
    expect(netdrivePlatformTuple("file-1")).toEqual({
      operation: "create",
      resource: { type: "netdrive_file", id: "file-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(workflowConsumerOrgTuple({ workflowId: "wf-1", orgId: "org-1" })).toEqual({
      operation: "create",
      resource: { type: "workflow", id: "wf-1" },
      relation: "consumer_org",
      subject: { type: "organization", id: "org-1" },
    });
    expect(workflowPlatformTuple("wf-1")).toEqual({
      operation: "create",
      resource: { type: "workflow", id: "wf-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(sshRecordingActorTuple({ sessionId: "sess-1", userId: "u-1" })).toEqual({
      operation: "create",
      resource: { type: "ssh_recording", id: "sess-1" },
      relation: "actor",
      subject: { type: "user", id: "u-1" },
    });
    expect(sshSessionAgentTuple({ sessionId: "sess-1", agentId: "agent-1" })).toEqual({
      operation: "create",
      resource: { type: "ssh_session", id: "sess-1" },
      relation: "agent",
      subject: { type: "agent", id: "agent-1" },
    });
    expect(sshSessionOpenerTuple({ sessionId: "sess-1", userId: "u-1" })).toEqual({
      operation: "create",
      resource: { type: "ssh_session", id: "sess-1" },
      relation: "opener",
      subject: { type: "user", id: "u-1" },
    });
    expect(sshSessionPlatformTuple("sess-1")).toEqual({
      operation: "create",
      resource: { type: "ssh_session", id: "sess-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(providerPlatformTuple("org-1")).toEqual({
      operation: "create",
      resource: { type: "provider", id: "org-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(agentPlatformTuple("agent-1")).toEqual({
      operation: "create",
      resource: { type: "agent", id: "agent-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(queuePlatformTuple("queue-1")).toEqual({
      operation: "create",
      resource: { type: "queue", id: "queue-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(clusterFileRootPlatformTuple("root-1")).toEqual({
      operation: "create",
      resource: { type: "cluster_file_root", id: "root-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(sshCredentialPlatformTuple("agent-1")).toEqual({
      operation: "create",
      resource: { type: "ssh_credential", id: "agent-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
    expect(sshRecordingPlatformTuple("sess-1")).toEqual({
      operation: "create",
      resource: { type: "ssh_recording", id: "sess-1" },
      relation: "platform",
      subject: { type: "platform", id: "root" },
    });
  });
});

function injectFakeClient(service: AuthzService, client: FakeBulkClient): void {
  (service as unknown as { client: FakeBulkClient | null }).client = client;
}

function inspectSql(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, candidate: unknown) => {
    if (typeof candidate === "object" && candidate !== null) {
      if (seen.has(candidate)) return "[Circular]";
      seen.add(candidate);
    }
    return candidate;
  });
}
