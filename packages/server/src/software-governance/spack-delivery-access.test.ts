import { describe, expect, test } from "bun:test";
import {
  agentCerts,
  agents,
  type PgDb,
  softwareOperations,
  softwarePolicies,
  softwarePolicyOverlays,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { AuthzService } from "../authz/service";
import { createSpackDeliveryAccess } from "./spack-delivery-access";

const actorId = "22222222-2222-4222-8222-222222222222";
const operationId = "11111111-1111-4111-8111-111111111111";

function fixture(mode: AuthzService["mode"] = "off") {
  const operation = {
    agentId: "agent-a",
    requestedBy: actorId,
    providerOrgId: "provider-a",
    action: "install",
    status: "queued",
    spec: "zlib@1.3.1",
  };
  const user = { role: "user", suspended: false };
  const rows = new Map<unknown, unknown[]>([
    [softwareOperations, [operation]],
    [users, [user]],
    [userOrgMemberships, [{ orgId: "provider-a", role: "admin" }]],
    [agents, [{ agentId: "agent-a", providerOrgId: "provider-a", siteName: "site-a" }]],
    [softwarePolicyOverlays, []],
    [softwarePolicies, []],
    [agentCerts, [{ id: "cert" }]],
  ]);
  const predicates: { table: unknown; sql: string; params: unknown[] }[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const builder = {
          innerJoin: () => builder,
          where: (query: SQL) => {
            const compiled = new PgDialect().sqlToQuery(query);
            predicates.push({ table, sql: compiled.sql, params: compiled.params });
            const result = rows.get(table) ?? [];
            return Object.assign(Promise.resolve(result), { limit: async () => result });
          },
        };
        return builder;
      },
    }),
  } as unknown as PgDb;
  const checks: unknown[] = [];
  let deny = false;
  const access = createSpackDeliveryAccess(db, {
    mode,
    requirePermission: async (check) => {
      checks.push(check);
      if (deny) throw new Error("current authorization denied");
    },
    shadowCheck: async (check) => {
      checks.push(check);
      return !deny;
    },
  });
  return {
    operation,
    user,
    rows,
    predicates,
    access,
    checks,
    deny: () => {
      deny = true;
    },
  };
}

describe("Spack production authorization adapter (offline query fixtures)", () => {
  test("loads current user and membership for the operation, using a UUID parameter lookup", async () => {
    const f = fixture();
    expect(await f.access.operation(operationId)).toEqual({
      agentId: "agent-a",
      requestedBy: actorId,
      providerOrgId: "provider-a",
      spec: "zlib@1.3.1",
    });
    const userLookup = f.predicates.find((query) => query.table === users);
    expect(userLookup?.sql).toBe('"users"."id" = $1');
    expect(userLookup?.params).toEqual([actorId]);
    expect(f.predicates[0]?.params).toEqual([operationId]);
  });

  test("rejects suspended/deleted users, terminal operations and non-install actions", async () => {
    for (const status of ["succeeded", "failed", "rejected"]) {
      const f = fixture();
      f.operation.status = status;
      expect(await f.access.operation(operationId)).toBeNull();
    }
    const suspended = fixture();
    suspended.user.suspended = true;
    expect(await suspended.access.operation(operationId)).toBeNull();
    const deleted = fixture();
    deleted.rows.set(users, []);
    expect(await deleted.access.operation(operationId)).toBeNull();
    const load = fixture();
    load.operation.action = "load";
    expect(await load.access.operation(operationId)).toBeNull();
  });

  test("rejects lost CP membership, downgraded member role and provider reassignment", async () => {
    const lost = fixture();
    lost.rows.set(userOrgMemberships, []);
    expect(await lost.access.operation(operationId)).toBeNull();
    const downgraded = fixture();
    downgraded.rows.set(userOrgMemberships, [{ orgId: "provider-a", role: "member" }]);
    expect(await downgraded.access.operation(operationId)).toBeNull();
    const moved = fixture();
    moved.operation.providerOrgId = "provider-b";
    expect(await moved.access.operation(operationId)).toBeNull();
  });

  test("applies current Spack policy before serving material", async () => {
    const f = fixture();
    f.rows.set(softwarePolicies, [{ scope: "agent", denyList: ["zlib@*"], lockEnabled: false }]);
    expect(await f.access.operation(operationId)).toBeNull();
  });

  test("enforce mode rechecks agent#operate through the existing authorization service", async () => {
    const f = fixture("enforce");
    expect(await f.access.operation(operationId)).not.toBeNull();
    expect(f.checks).toEqual([
      expect.objectContaining({
        resource: { type: "agent", id: "agent-a" },
        permission: "operate",
        subject: { type: "user", id: actorId },
      }),
    ]);
    f.deny();
    await expect(f.access.operation(operationId)).rejects.toThrow("authorization denied");
  });

  test("certificate lookup requires the correct Agent, fingerprint, validity interval and no revocation", async () => {
    const f = fixture();
    expect(await f.access.certificate("agent-a", "f".repeat(64))).toBe(true);
    const predicate = f.predicates[0];
    expect(predicate?.sql).toContain('"agent_certs"."agent_id" = $1');
    expect(predicate?.sql).toContain('"agent_certs"."fingerprint_sha256" = $2');
    expect(predicate?.sql).toContain('"agent_certs"."revoked_at" is null');
    expect(predicate?.sql).toContain('"agent_certs"."issued_at" <= $3');
    expect(predicate?.sql).toContain('"agent_certs"."expires_at" > $4');
    expect(predicate?.params.slice(0, 2)).toEqual(["agent-a", "f".repeat(64)]);
    f.rows.set(agentCerts, []);
    expect(await f.access.certificate("agent-a", "f".repeat(64))).toBe(false);
  });
});
