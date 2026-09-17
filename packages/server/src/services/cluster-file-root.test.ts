import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { agents, clusterFileRoots, createPgDb, orgs, type PgDb } from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import type { AuthzService } from "../authz/service";
import { ClusterFileRootService } from "./cluster-file-root";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

describe("ClusterFileRootService", () => {
  let db: PgDb;
  let service: ClusterFileRootService;
  let providerOrgId: string;
  let consumerOrgId: string;
  let otherOrgId: string;
  const agentId = "cfr-agent-1";

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new ClusterFileRootService(db);

    await db
      .delete(clusterFileRoots)
      .where(
        inArray(clusterFileRoots.path, [
          "/cfr",
          "/cfr-disabled",
          "/cfr-authz-use",
          "/cfr-authz-use-allow",
          "/cfr-authz-create-allow",
          "/cfr-authz-create-denied",
          "/cfr-authz-admin-list",
          "/cfr-authz-manage",
          "/cfr-authz-manage-allow",
          "/cfr-multi-org",
          "/cfr-admin-multi-org",
        ]),
      );
    await db.delete(agents).where(eq(agents.agentId, agentId));
    await db.delete(orgs).where(inArray(orgs.name, ["cfr-provider", "cfr-consumer", "cfr-other"]));

    const inserted = await db
      .insert(orgs)
      .values([{ name: "cfr-provider" }, { name: "cfr-consumer" }, { name: "cfr-other" }])
      .returning();
    const [provider, consumer, other] = inserted;
    if (!provider || !consumer || !other) {
      throw new Error("failed to create cluster file root test orgs");
    }
    providerOrgId = provider.id;
    consumerOrgId = consumer.id;
    otherOrgId = other.id;

    await db.insert(agents).values({
      agentId,
      siteName: "cfr-site",
      providerOrgId,
      siteId: "cfr-site",
      clusterId: "cfr-cluster",
      topology: {},
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
      status: "online",
    });
  });

  afterAll(async () => {
    await db
      .delete(clusterFileRoots)
      .where(
        inArray(clusterFileRoots.path, [
          "/cfr",
          "/cfr-disabled",
          "/cfr-authz-use",
          "/cfr-authz-use-allow",
          "/cfr-authz-create-allow",
          "/cfr-authz-create-denied",
          "/cfr-authz-admin-list",
          "/cfr-authz-manage",
          "/cfr-authz-manage-allow",
          "/cfr-multi-org",
          "/cfr-admin-multi-org",
        ]),
      );
    await db.delete(agents).where(eq(agents.agentId, agentId));
    await db.delete(orgs).where(eq(orgs.id, providerOrgId));
    await db.delete(orgs).where(eq(orgs.id, consumerOrgId));
    await db.delete(orgs).where(eq(orgs.id, otherOrgId));
  });

  test("creates a provider-owned root and exposes it to visible orgs", async () => {
    const root = await service.create(
      {
        label: "CFR",
        agentId,
        path: "/cfr",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );

    expect(root.providerOrgId).toBe(providerOrgId);
    const visible = await service.resolveAllowedRootPaths(
      { role: "user", orgId: consumerOrgId },
      { agentId },
    );
    expect(visible.paths).toEqual(["/cfr"]);

    const hidden = await service.resolveAllowedRootPaths(
      { role: "user", orgId: otherOrgId },
      { agentId },
    );
    expect(hidden).toEqual({ paths: [], hasConfiguredRoots: true, roots: [] });
  });

  test("uses all bound organization memberships for visible roots", async () => {
    await service.create(
      {
        label: "CFR multi-org",
        agentId,
        path: "/cfr-multi-org",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );

    const visible = await service.resolveAllowedRootPaths(
      { role: "user", orgId: otherOrgId, orgIds: [otherOrgId, consumerOrgId] },
      { agentId },
    );
    expect(visible.paths).toContain("/cfr-multi-org");
  });

  test("uses all bound organization memberships for provider administration", async () => {
    const root = await service.create(
      {
        label: "CFR admin multi-org",
        providerOrgId,
        path: "/cfr-admin-multi-org",
        visibleOrgIds: [],
        enabled: true,
      },
      { role: "org_admin", orgId: otherOrgId, orgIds: [otherOrgId, providerOrgId] },
    );

    expect(root.providerOrgId).toBe(providerOrgId);
  });

  test("rejects cross-provider management", async () => {
    await expect(
      service.create(
        {
          label: "cross-org",
          providerOrgId,
          path: "/cfr-cross",
          visibleOrgIds: [],
          enabled: true,
        },
        { role: "org_admin", orgId: otherOrgId },
      ),
    ).rejects.toThrow(/outside your org/);
  });

  test("enforce mode checks provider#manage when creating outside local provider org", async () => {
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
    const authzService = new ClusterFileRootService(db, authz);

    const root = await authzService.create(
      {
        label: "authz create allow",
        providerOrgId,
        agentId,
        path: "/cfr-authz-create-allow",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      {
        role: "user",
        orgId: otherOrgId,
        userId: "user-1",
        email: "user@example.com",
      },
    );

    expect(root.providerOrgId).toBe(providerOrgId);
    expect(calls).toEqual([
      {
        actorUserId: "user-1",
        actorEmail: "user@example.com",
        resource: { type: "provider", id: providerOrgId },
        permission: "manage",
        subject: { type: "user", id: "user-1" },
        context: { localAllowed: false, source: "cluster-file-root-create" },
        localAllowed: false,
      },
    ]);
    expect(enqueued).toContainEqual(
      expect.objectContaining({
        resource: { type: "cluster_file_root", id: root.id },
        relation: "provider",
      }),
    );
  });

  test("enforce mode rejects creates denied by provider#manage", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new Error("denied");
      },
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);

    await expect(
      authzService.create(
        {
          label: "authz create denied",
          providerOrgId,
          path: "/cfr-authz-create-denied",
          visibleOrgIds: [],
          enabled: true,
        },
        {
          role: "user",
          orgId: otherOrgId,
          userId: "user-1",
          email: "user@example.com",
        },
      ),
    ).rejects.toThrow("denied");
  });

  test("enforce mode fails closed when provider#manage create lacks canonical user id", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);

    await expect(
      authzService.create(
        {
          label: "authz create missing subject",
          providerOrgId,
          path: "/cfr-authz-create-denied",
          visibleOrgIds: [],
          enabled: true,
        },
        {
          role: "user",
          orgId: otherOrgId,
          email: "user@example.com",
          sub: "legacy-user-sub",
        },
      ),
    ).rejects.toThrow("Authorization principal is not bound");
    expect(calls).toEqual([]);
  });

  test("enforce mode filters admin list roots denied by cluster_file_root#manage", async () => {
    const root = await service.create(
      {
        label: "authz admin list",
        agentId,
        path: "/cfr-authz-admin-list",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
        throw new Error("denied");
      },
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);

    const roots = await authzService.listAdmin({
      role: "org_admin",
      orgId: providerOrgId,
      userId: "admin-1",
      email: "admin@example.com",
    });

    expect(roots.map((item) => item.id)).not.toContain(root.id);
    expect(calls).toContainEqual({
      actorUserId: "admin-1",
      actorEmail: "admin@example.com",
      resource: { type: "cluster_file_root", id: root.id },
      permission: "manage",
      subject: { type: "user", id: "admin-1" },
      context: { localAllowed: true },
      localAllowed: true,
    });
  });

  test("disabled roots still prevent static fallback", async () => {
    await service.create(
      {
        label: "disabled",
        path: "/cfr-disabled",
        visibleOrgIds: [consumerOrgId],
        enabled: false,
      },
      { role: "org_admin", orgId: providerOrgId },
    );

    const allowed = await service.resolveAllowedRootPaths(
      { role: "user", orgId: consumerOrgId },
      { agentId: "other-agent" },
    );
    expect(allowed).toEqual({ paths: [], hasConfiguredRoots: true, roots: [] });
  });

  test("enforce mode filters roots denied by cluster_file_root#use", async () => {
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new Error("denied");
      },
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);
    await service.create(
      {
        label: "authz",
        path: "/cfr-authz-use",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );

    const allowed = await authzService.resolveAllowedRootPaths(
      {
        role: "user",
        orgId: consumerOrgId,
        userId: "user-1",
        email: "user@example.com",
      },
      { agentId },
    );

    expect(allowed.paths).not.toContain("/cfr-authz-use");
    expect(allowed.hasConfiguredRoots).toBe(true);
  });

  test("enforce mode fails closed when cluster_file_root#use lacks canonical user id", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);
    await service.create(
      {
        label: "authz",
        path: "/cfr-authz-use",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );

    await expect(
      authzService.resolveAllowedRootPaths(
        {
          role: "user",
          orgId: consumerOrgId,
          email: "user@example.com",
          sub: "legacy-user-sub",
        },
        { agentId },
      ),
    ).rejects.toThrow("Authorization principal is not bound");
    expect(calls).toEqual([]);
  });

  test("enforce mode allows roots authorized by cluster_file_root#use outside local visibility", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
      enqueueMany: async () => undefined,
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);
    const root = await service.create(
      {
        label: "authz allow",
        path: "/cfr-authz-use-allow",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );

    const allowed = await authzService.resolveAllowedRootPaths(
      {
        role: "user",
        orgId: otherOrgId,
        userId: "user-1",
        email: "user@example.com",
      },
      { agentId },
    );

    expect(allowed.paths).toContain("/cfr-authz-use-allow");
    expect(calls).toContainEqual({
      actorUserId: "user-1",
      actorEmail: "user@example.com",
      resource: { type: "cluster_file_root", id: root.id },
      permission: "use",
      subject: { type: "user", id: "user-1" },
      context: { localAllowed: false },
      localAllowed: false,
    });
  });

  test("enforce mode rejects updates denied by cluster_file_root#manage", async () => {
    const root = await service.create(
      {
        label: "authz",
        path: "/cfr-authz-manage",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new Error("denied");
      },
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);

    await expect(
      authzService.update(
        root.id,
        { label: "blocked" },
        {
          role: "org_admin",
          orgId: providerOrgId,
          userId: "admin-1",
          email: "admin@example.com",
        },
      ),
    ).rejects.toThrow("denied");
  });

  test("enforce mode fails closed when cluster_file_root#manage lacks canonical user id", async () => {
    const root = await service.create(
      {
        label: "authz",
        path: "/cfr-authz-manage",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);

    await expect(
      authzService.update(
        root.id,
        { label: "blocked" },
        {
          role: "org_admin",
          orgId: providerOrgId,
          email: "admin@example.com",
          sub: "legacy-admin-sub",
        },
      ),
    ).rejects.toThrow("Authorization principal is not bound");
    expect(calls).toEqual([]);
  });

  test("enforce mode allows updates authorized by cluster_file_root#manage outside local provider org", async () => {
    const root = await service.create(
      {
        label: "authz manage allow",
        path: "/cfr-authz-manage-allow",
        visibleOrgIds: [consumerOrgId],
        enabled: true,
      },
      { role: "org_admin", orgId: providerOrgId },
    );
    const calls: unknown[] = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        calls.push(input);
      },
      enqueueMany: async () => undefined,
    } as unknown as AuthzService;
    const authzService = new ClusterFileRootService(db, authz);

    const updated = await authzService.update(
      root.id,
      { label: "authorized" },
      {
        role: "org_admin",
        orgId: otherOrgId,
        userId: "admin-1",
        email: "admin@example.com",
      },
    );

    expect(updated.label).toBe("authorized");
    expect(calls).toEqual([
      {
        actorUserId: "admin-1",
        actorEmail: "admin@example.com",
        resource: { type: "cluster_file_root", id: root.id },
        permission: "manage",
        subject: { type: "user", id: "admin-1" },
        context: { localAllowed: false },
        localAllowed: false,
      },
    ]);
  });
});
