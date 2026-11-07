import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  auditLog,
  authzOutbox,
  createPgDb,
  federationAgreementApprovals,
  federationAgreements,
  federationBudgets,
  federationCapabilities,
  federationSigningKeys,
  federationSites,
  orgs,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationMemberOptionsSchema,
} from "@kuintessence/shared/federation";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { exportSPKI } from "jose";
import pino from "pino";
import { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminAuthzRoutes } from "../routes/admin-authz";
import { createAdminFederationPermissionRoutes } from "../routes/admin-federation-permissions";
import { createFederationAgreementRoutes } from "../routes/federation-agreements";
import { FederationAgreementService } from "./agreements";
import { FederationPermissionService } from "./permissions";
import { signFederationMessage, verifyFederationMessage } from "./signatures";
import { testAgreement, testKeys, testNow } from "./test-fixtures";
import { FederationTrustRegistry } from "./trust-registry";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const permissions = new FederationPermissionService(db);
const trust = new FederationTrustRegistry(db);
const aActor = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const bActor = { orgId: crypto.randomUUID(), userId: crypto.randomUUID() };
const adminId = crypto.randomUUID();
const executionUserId = crypto.randomUUID();
const outsiderId = crypto.randomUUID();
let a: Awaited<ReturnType<typeof testKeys>>;
let b: Awaited<ReturnType<typeof testKeys>>;
let aService: FederationAgreementService;
let bService: FederationAgreementService;
const termsList: ReturnType<typeof testAgreement>[] = [];

function terms() {
  const value = testAgreement(a.signing.siteId, b.signing.siteId);
  termsList.push(value);
  return value;
}

beforeAll(async () => {
  await db.insert(orgs).values([
    { id: aActor.orgId, name: "Institution A business scope" },
    { id: bActor.orgId, name: "Institution B business scope" },
  ]);
  await db.insert(users).values([
    {
      id: aActor.userId,
      orgId: aActor.orgId,
      email: `${aActor.userId}@test.invalid`,
      role: "user",
    },
    {
      id: bActor.userId,
      orgId: bActor.orgId,
      email: `${bActor.userId}@test.invalid`,
      role: "operator",
    },
    { id: adminId, orgId: aActor.orgId, email: `${adminId}@test.invalid`, role: "platform_admin" },
    {
      id: executionUserId,
      orgId: bActor.orgId,
      email: `${executionUserId}@test.invalid`,
      role: "user",
      serviceAccount: true,
    },
    { id: outsiderId, orgId: aActor.orgId, email: `${outsiderId}@test.invalid`, role: "user" },
  ]);
  await db.insert(userOrgMemberships).values([
    { ...aActor, role: "member" },
    { ...bActor, role: "member" },
    { orgId: bActor.orgId, userId: executionUserId, role: "member" },
    { orgId: aActor.orgId, userId: adminId, role: "owner" },
  ]);
  [a, b] = await Promise.all([testKeys(), testKeys()]);
  for (const key of [a, b]) {
    await trust.addSite(
      { id: key.signing.siteId, name: "Agreement test", endpoint: "https://test.invalid" },
      adminId,
    );
    await trust.addKey(
      key.signing.siteId,
      {
        keyId: key.signing.keyId,
        publicKeyPem: await exportSPKI(key.verification.publicKey),
        allowedKinds: ["agreement", "acceptance", "delegation"],
        validFrom: key.verification.validFrom.toISOString(),
        validUntil: key.verification.validUntil.toISOString(),
      },
      adminId,
    );
  }
  aService = new FederationAgreementService(db, a.signing, () => testNow);
  bService = new FederationAgreementService(db, b.signing, () => testNow);
  for (const actor of [aActor, bActor])
    await permissions.set({ ...actor, capability: "agreement.approve", enabled: true }, adminId);
});

afterAll(async () => {
  for (const value of termsList) {
    await db
      .delete(federationAgreements)
      .where(eq(federationAgreements.revisionId, value.agreementRevisionId));
    await db
      .delete(federationBudgets)
      .where(
        and(
          eq(federationBudgets.domainId, value.budgetDomainId),
          eq(federationBudgets.epoch, value.epoch),
        ),
      );
  }
  const orgIds = [aActor.orgId, bActor.orgId];
  const userIds = [aActor.userId, bActor.userId, adminId, executionUserId, outsiderId];
  await db
    .delete(federationAgreementApprovals)
    .where(inArray(federationAgreementApprovals.localOrgId, orgIds));
  await db.delete(federationCapabilities).where(inArray(federationCapabilities.orgId, orgIds));
  await db.delete(auditLog).where(inArray(auditLog.actor, userIds));
  await db.delete(authzOutbox).where(inArray(authzOutbox.resourceId, orgIds));
  if (a && b) {
    await db
      .delete(federationSigningKeys)
      .where(inArray(federationSigningKeys.siteId, [a.signing.siteId, b.signing.siteId]));
    await db
      .delete(federationSites)
      .where(inArray(federationSites.id, [a.signing.siteId, b.signing.siteId]));
  }
  await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.orgId, orgIds));
  await db.delete(users).where(inArray(users.id, userIds));
  await db.delete(orgs).where(inArray(orgs.id, orgIds));
});

test("platform admin is not a business approver; grant requires a current human member", async () => {
  const value = terms();
  await expect(
    aService.approve({ userId: adminId, orgId: aActor.orgId }, { terms: value }),
  ).rejects.toThrow("POLICY_DENIED");
  for (const actor of [
    { orgId: aActor.orgId, userId: outsiderId },
    { orgId: bActor.orgId, userId: executionUserId },
  ])
    await expect(
      permissions.set({ ...actor, capability: "agreement.approve", enabled: true }, adminId),
    ).rejects.toThrow("POLICY_DENIED");
  await expect(
    bService.approve(bActor, { terms: value, executionUserId: aActor.userId }),
  ).rejects.toThrow("POLICY_DENIED");
  expect(
    await db
      .select()
      .from(federationAgreementApprovals)
      .where(eq(federationAgreementApprovals.revisionId, value.agreementRevisionId)),
  ).toHaveLength(0);
});

test("both institutional signatures activate one recipient budget, never a source duplicate", async () => {
  const value = terms();
  const approvals = await Promise.all(
    Array.from({ length: 4 }, () => aService.approve(aActor, { terms: value })),
  );
  expect(new Set(approvals.map((v) => v.approvalJws)).size).toBe(1);
  const aApproval = approvals[0];
  if (!aApproval) throw new Error("Missing approval");
  const bApproval = await bService.approve(bActor, { terms: value, executionUserId });
  expect(
    (
      await verifyFederationMessage(
        FederationAgreementSchema,
        bApproval.approvalJws,
        b.verification,
        testNow,
      )
    ).payload,
  ).toEqual(value);
  await aService.attachCounterparty(aActor, value.agreementRevisionId, bApproval.approvalJws);
  expect(
    await db
      .select()
      .from(federationBudgets)
      .where(eq(federationBudgets.domainId, value.budgetDomainId)),
  ).toHaveLength(0);
  await Promise.all(
    Array.from({ length: 4 }, () =>
      bService.attachCounterparty(bActor, value.agreementRevisionId, aApproval.approvalJws),
    ),
  );
  const budgets = await db
    .select()
    .from(federationBudgets)
    .where(eq(federationBudgets.domainId, value.budgetDomainId));
  expect(budgets).toHaveLength(1);
  expect(budgets[0]?.available).toBe("100");
  expect(await bService.listReservations(bActor, value.agreementRevisionId)).toEqual([]);
  await expect(bService.listReservations(aActor, value.agreementRevisionId)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  expect((await bService.get(bActor, value.agreementRevisionId)).counterpartyApprovalJws).toBe(
    aApproval.approvalJws,
  );
  await expect(
    aService.approve(aActor, { terms: { ...value, maxTaskAmount: "1" } }),
  ).rejects.toThrow("OPERATION_CONFLICT");
});

test("wrong institution or modified terms cannot activate; org scope cannot be supplied by caller", async () => {
  const value = terms();
  await bService.approve(bActor, { terms: value, executionUserId });
  const altered = await signFederationMessage(
    FederationAgreementSchema,
    { ...value, maxTaskAmount: "1" },
    a.signing,
  );
  await expect(
    bService.attachCounterparty(bActor, value.agreementRevisionId, altered),
  ).rejects.toThrow("OPERATION_CONFLICT");
  const wrongSigner = await signFederationMessage(FederationAgreementSchema, value, b.signing);
  await expect(
    bService.attachCounterparty(bActor, value.agreementRevisionId, wrongSigner),
  ).rejects.toThrow("UNTRUSTED_IDENTITY");
  await expect(bService.get(aActor, value.agreementRevisionId)).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await expect(
    bService.get({ userId: aActor.userId, orgId: bActor.orgId }, value.agreementRevisionId),
  ).rejects.toThrow("POLICY_DENIED");
  expect(
    (await bService.get(bActor, value.agreementRevisionId)).counterpartyApprovalJws,
  ).toBeNull();
});

test("capability revocation and suspension stop approvals without erasing old signatures", async () => {
  const value = terms();
  const prior = await aService.approve(aActor, { terms: value });
  await permissions.set({ ...aActor, capability: "agreement.approve", enabled: false }, adminId);
  await expect(aService.approve(aActor, { terms: terms() })).rejects.toThrow("POLICY_DENIED");
  await expect(aService.get(aActor, value.agreementRevisionId)).rejects.toThrow("POLICY_DENIED");
  await permissions.set({ ...aActor, capability: "agreement.read", enabled: true }, adminId);
  expect((await aService.get(aActor, value.agreementRevisionId)).approvalJws).toBe(
    prior.approvalJws,
  );
  await expect(aService.approve(aActor, { terms: value })).rejects.toThrow("POLICY_DENIED");
  await permissions.set({ ...aActor, capability: "agreement.approve", enabled: true }, adminId);
  await db.update(users).set({ suspended: true }).where(eq(users.id, aActor.userId));
  try {
    await expect(aService.get(aActor, value.agreementRevisionId)).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, aActor.userId));
  }
});

test("activation audit failure rolls back the peer signature, agreement and budget together", async () => {
  const value = terms();
  const source = await aService.approve(aActor, { terms: value });
  await bService.approve(bActor, { terms: value, executionUserId });
  await db.execute(
    sql`CREATE FUNCTION federation_test_activation_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'federation.agreement.activate' THEN RAISE EXCEPTION 'injected activation fault'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER federation_test_activation_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION federation_test_activation_fail()`,
  );
  try {
    await expect(
      bService.attachCounterparty(bActor, value.agreementRevisionId, source.approvalJws),
    ).rejects.toThrow();
    expect(
      (await bService.get(bActor, value.agreementRevisionId)).counterpartyApprovalJws,
    ).toBeNull();
    expect(
      await db
        .select()
        .from(federationBudgets)
        .where(eq(federationBudgets.domainId, value.budgetDomainId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(federationAgreements)
        .where(eq(federationAgreements.revisionId, value.agreementRevisionId)),
    ).toHaveLength(0);
  } finally {
    await db.execute(sql`DROP TRIGGER federation_test_activation_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION federation_test_activation_fail()`);
  }
  await bService.attachCounterparty(bActor, value.agreementRevisionId, source.approvalJws);
  await bService.setState(bActor, value.agreementRevisionId, "suspended");
  const [agreement] = await db
    .select()
    .from(federationAgreements)
    .where(eq(federationAgreements.revisionId, value.agreementRevisionId));
  expect(agreement?.state).toBe("suspended");
  await bService.setState(bActor, value.agreementRevisionId, "revoked");
  await expect(bService.setState(bActor, value.agreementRevisionId, "active")).rejects.toThrow(
    "AGREEMENT_UNAVAILABLE",
  );
  await expect(
    bService.attachCounterparty(bActor, value.agreementRevisionId, source.approvalJws),
  ).rejects.toThrow("AGREEMENT_UNAVAILABLE");
});

test("approval HTTP routes use the session organization and explicit grants, including the list path", async () => {
  function app(actor: typeof aActor, role = "user", automation = false) {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, { ...actor, role });
      if (automation) c.set("automation" as never, { userId: actor.userId });
      await next();
    });
    r.route("/api", createFederationAgreementRoutes(aService));
    r.route("/api", createAdminFederationPermissionRoutes(permissions));
    return r;
  }
  expect((await app(aActor).request("/api/federation/agreements")).status).toBe(200);
  expect(
    (
      await app({ orgId: aActor.orgId, userId: adminId }, "platform_admin").request(
        "/api/federation/agreements",
      )
    ).status,
  ).toBe(403);
  expect((await app(aActor, "user", true).request("/api/federation/agreements")).status).toBe(403);
  expect(
    (
      await app(aActor, "operator").request(
        `/api/admin/federation/capabilities?orgId=${aActor.orgId}`,
      )
    ).status,
  ).toBe(403);
  const value = terms();
  const response = await app(aActor).request("/api/federation/agreements/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ terms: value, orgId: bActor.orgId }),
  });
  expect(response.status).toBe(400);
  expect(
    (
      await app({ orgId: aActor.orgId, userId: adminId }, "platform_admin").request(
        `/api/admin/federation/capabilities?orgId=${aActor.orgId}`,
      )
    ).status,
  ).toBe(200);
});

test("signing authority and agreement lifetime are required even for a granted approver", async () => {
  const value = terms();
  const keyId = "receipt-only";
  await trust.addKey(
    a.signing.siteId,
    {
      keyId,
      publicKeyPem: await exportSPKI(a.verification.publicKey),
      allowedKinds: ["acceptance"],
      validFrom: a.verification.validFrom.toISOString(),
      validUntil: a.verification.validUntil.toISOString(),
    },
    adminId,
  );
  const noAuthority = new FederationAgreementService(db, { ...a.signing, keyId }, () => testNow);
  await expect(noAuthority.approve(aActor, { terms: value })).rejects.toThrow("UNTRUSTED_IDENTITY");
  await expect(
    aService.approve(aActor, { terms: { ...value, validUntil: testNow.toISOString() } }),
  ).rejects.toThrow("AUTHORIZATION_EXPIRED");
  await expect(
    aService.approve(aActor, { terms: { ...value, mode: "ledger_coordinated" } }),
  ).rejects.toThrow("LEDGER_REQUIRED");
  expect(
    await db
      .select()
      .from(federationAgreementApprovals)
      .where(eq(federationAgreementApprovals.revisionId, value.agreementRevisionId)),
  ).toHaveLength(0);
});

test("current federation grants stay organization-scoped and expand only explicit capabilities", async () => {
  const admin = { orgId: aActor.orgId, userId: adminId };
  expect((await permissions.current(admin)).effectiveCapabilities).toEqual([]);
  await permissions.set({ ...admin, capability: "delegation.submit", enabled: true }, adminId);
  await permissions.set({ ...admin, capability: "asset.map", enabled: true }, adminId);
  try {
    expect(await permissions.current(admin)).toEqual({
      ...admin,
      grants: ["asset.map", "delegation.submit"],
      effectiveCapabilities: [
        "asset.read",
        "asset.map",
        "delegation.read",
        "delegation.submit",
        "delegation.cancel",
      ],
    });
    await expect(permissions.current({ userId: adminId, orgId: bActor.orgId })).rejects.toThrow(
      "POLICY_DENIED",
    );
    await expect(
      permissions.current({ userId: executionUserId, orgId: bActor.orgId }),
    ).rejects.toThrow("POLICY_DENIED");
    await permissions.set({ ...admin, capability: "delegation.submit", enabled: false }, adminId);
    expect((await permissions.current(admin)).effectiveCapabilities).toEqual([
      "asset.read",
      "asset.map",
    ]);
  } finally {
    for (const capability of ["delegation.submit", "asset.map"] as const)
      await permissions.set({ ...admin, capability, enabled: false }, adminId);
  }
});

test("member lookup excludes nonmembers, service identities and suspended humans while stale grants remain revocable", async () => {
  const active = await permissions.members(aActor.orgId, "", 1, 0);
  expect(active.data).toHaveLength(1);
  expect(active.hasMore).toBe(true);
  const all = await permissions.members(aActor.orgId, "", 100, 0);
  expect(new Set(all.data.map((row) => row.userId))).toEqual(new Set([aActor.userId, adminId]));
  expect(
    (await permissions.members(bActor.orgId, "", 100, 0)).data.map((row) => row.userId),
  ).toEqual([bActor.userId]);
  expect(
    (await permissions.members(aActor.orgId, `${adminId}@test.invalid`, 10, 0)).data.map(
      (row) => row.userId,
    ),
  ).toEqual([adminId]);
  await db.update(users).set({ suspended: true }).where(eq(users.id, aActor.userId));
  try {
    expect(
      (await permissions.members(aActor.orgId, "", 100, 0)).data.map((row) => row.userId),
    ).toEqual([adminId]);
    await expect(permissions.current(aActor)).rejects.toThrow("POLICY_DENIED");
    const grants = await permissions.list(aActor.orgId, 100, 0);
    expect(grants.find((row) => row.userId === aActor.userId)).toMatchObject({
      suspended: true,
      membershipActive: true,
      email: `${aActor.userId}@test.invalid`,
    });
  } finally {
    await db.update(users).set({ suspended: false }).where(eq(users.id, aActor.userId));
  }
  const admin = { orgId: aActor.orgId, userId: adminId };
  await permissions.set({ ...admin, capability: "result.read", enabled: true }, adminId);
  await db
    .delete(userOrgMemberships)
    .where(and(eq(userOrgMemberships.userId, adminId), eq(userOrgMemberships.orgId, aActor.orgId)));
  try {
    expect(
      (await permissions.list(aActor.orgId, 100, 0)).find((row) => row.userId === adminId),
    ).toMatchObject({ membershipActive: false });
    await permissions.set({ ...admin, capability: "result.read", enabled: false }, adminId);
    expect(
      (await permissions.list(aActor.orgId, 100, 0)).some((row) => row.userId === adminId),
    ).toBe(false);
  } finally {
    await db.insert(userOrgMemberships).values({ ...admin, role: "owner" });
    await permissions.set({ ...admin, capability: "result.read", enabled: false }, adminId);
  }
});

test("capability discovery cannot choose another principal or expose member directories without platform management", async () => {
  function app(actor: typeof aActor, role = "user", automation = false) {
    const r = new Hono();
    r.onError(createErrorHandler(pino({ level: "silent" })));
    r.use("*", async (c, next) => {
      c.set("principal" as never, { ...actor, role });
      if (automation) c.set("automation" as never, { userId: actor.userId });
      await next();
    });
    r.route("/api", createAdminFederationPermissionRoutes(permissions));
    return r;
  }
  const self = await app(aActor).request("/api/federation/capabilities");
  expect(self.status).toBe(200);
  expect(self.headers.get("cache-control")).toBe("no-store");
  expect(await self.json()).toMatchObject({ data: aActor });
  expect(
    (await app(aActor).request(`/api/federation/capabilities?orgId=${bActor.orgId}`)).status,
  ).toBe(400);
  expect((await app(aActor, "user", true).request("/api/federation/capabilities")).status).toBe(
    403,
  );
  expect(
    (
      await app({ orgId: bActor.orgId, userId: executionUserId }).request(
        "/api/federation/capabilities",
      )
    ).status,
  ).toBe(403);
  const path = `/api/admin/federation/capabilities/members?orgId=${aActor.orgId}`;
  expect((await app(aActor).request(path)).status).toBe(403);
  const response = await app({ orgId: aActor.orgId, userId: adminId }, "platform_admin").request(
    path,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(FederationMemberOptionsSchema.parse(await response.json()).data).toHaveLength(2);
});

test("membership deletion atomically revokes local federation grants and rejoining cannot restore them", async () => {
  const admin = { userId: adminId, orgId: aActor.orgId };
  const other = { userId: adminId, orgId: bActor.orgId };
  const authz = new AuthzService({
    mode: "off",
    endpoint: "",
    token: "",
    schemaPath: "",
    db,
    platformAdminDegrade: false,
  });
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    c.set("principal" as never, { ...admin, role: "platform_admin" });
    await next();
  });
  app.route("/api", createAdminAuthzRoutes(db, { authz, rawTupleAdminEnabled: false }));
  await db.insert(userOrgMemberships).values({ ...other, role: "member" });
  await permissions.set({ ...admin, capability: "agreement.approve", enabled: true }, adminId);
  await permissions.set({ ...other, capability: "asset.read", enabled: true }, adminId);
  const path = `/api/admin/authz/memberships/${adminId}/${aActor.orgId}`;
  const outboxBefore = await db
    .select()
    .from(authzOutbox)
    .where(eq(authzOutbox.resourceId, aActor.orgId));
  await db.execute(
    sql`CREATE FUNCTION federation_test_membership_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'authz.membership.delete' THEN RAISE EXCEPTION 'injected audit fault'; END IF; RETURN NEW; END $$`,
  );
  await db.execute(
    sql`CREATE TRIGGER federation_test_membership_audit_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION federation_test_membership_audit_fail()`,
  );
  try {
    expect((await app.request(path, { method: "DELETE" })).status).toBe(500);
    expect((await permissions.current(admin)).grants).toEqual(["agreement.approve"]);
    expect(
      await db.select().from(authzOutbox).where(eq(authzOutbox.resourceId, aActor.orgId)),
    ).toHaveLength(outboxBefore.length);
  } finally {
    await db.execute(sql`DROP TRIGGER federation_test_membership_audit_fail ON audit_log`);
    await db.execute(sql`DROP FUNCTION federation_test_membership_audit_fail()`);
  }
  try {
    expect((await app.request(path, { method: "DELETE" })).status).toBe(200);
    await expect(permissions.current(admin)).rejects.toThrow("POLICY_DENIED");
    expect(
      (await permissions.list(aActor.orgId, 100, 0)).some((row) => row.userId === adminId),
    ).toBe(false);
    expect((await permissions.current(other)).grants).toEqual(["asset.read"]);
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "authz.membership.delete"),
          eq(auditLog.target, `organization:${aActor.orgId}#membership@user:${adminId}`),
        ),
      );
    expect(audit).toMatchObject({
      actor: adminId,
      orgId: aActor.orgId,
      diff: { before: { federationCapabilities: ["agreement.approve"] } },
    });
    await db.insert(userOrgMemberships).values({ ...admin, role: "owner" });
    expect((await permissions.current(admin)).effectiveCapabilities).toEqual([]);
  } finally {
    await db
      .insert(userOrgMemberships)
      .values({ ...admin, role: "owner" })
      .onConflictDoNothing();
    await permissions.set({ ...admin, capability: "agreement.approve", enabled: false }, adminId);
    await permissions.set({ ...other, capability: "asset.read", enabled: false }, adminId);
    await db
      .delete(userOrgMemberships)
      .where(
        and(eq(userOrgMemberships.userId, adminId), eq(userOrgMemberships.orgId, bActor.orgId)),
      );
    authz.close();
  }
});
