import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzService } from "../authz/service";
import type { PrincipalLike } from "../middleware/cp-rbac";
import { createErrorHandler } from "../middleware/error-handler";
import type { AgentRegistrationService } from "../services/agent-registration";
import type { CpConsoleService } from "../services/cp-console";
import type { DataAccessRequest, DataMarketService } from "../services/data-market";
import type { SoftwareOperationService, SoftwareOperationView } from "../software-governance";
import type { CertIssuanceService } from "./admin-agents";
import { buildCpRouter } from "./cp";

const silent = pino({ level: "silent" });

type LookupResourcesInput = Parameters<AuthzService["lookupResources"]>[0];
type CpAgentList = Awaited<ReturnType<CpConsoleService["listAgents"]>>;

function makeApp(
  softwareOperations: Pick<SoftwareOperationService, "requestOperation"> &
    Partial<Pick<SoftwareOperationService, "assertAgentInScope" | "listOperations">>,
  consoleService?: Partial<CpConsoleService>,
  authz?: AuthzService,
  principal: (PrincipalLike & { email?: string; userId?: string }) | null = {
    sub: "cp-route@test",
    role: "super_admin",
    email: "cp-route@test",
    userId: "user-cp-route",
    orgId: null,
    orgIds: [],
  },
  agentRegistration?: Pick<AgentRegistrationService, "createToken" | "revoke"> &
    Partial<Pick<AgentRegistrationService, "listActive">>,
  agentCerts?: Pick<CertIssuanceService, "listCerts" | "revokeCert">,
  dataMarket?: Partial<DataMarketService>,
) {
  const app = new Hono();
  const operationService = {
    assertAgentInScope: async () => {},
    listOperations: async () => [],
    ...softwareOperations,
  };
  app.onError(createErrorHandler(silent));
  app.use("*", async (c, next) => {
    c.set("principal" as never, principal);
    await next();
  });
  app.route(
    "/api/cp",
    buildCpRouter({
      consoleService: (consoleService ?? {}) as CpConsoleService,
      softwareOperations: operationService as SoftwareOperationService,
      agentRegistration: agentRegistration as AgentRegistrationService | undefined,
      agentCerts,
      dataMarket: dataMarket as DataMarketService | undefined,
      authz,
    }),
  );
  return app;
}

test("rejects legacy CP user governance writes before calling the service", async () => {
  const mutations: unknown[] = [];
  const service = {
    setUserSuspended: async (...args: unknown[]) => {
      mutations.push(["suspend", ...args]);
    },
    setUserQuota: async (...args: unknown[]) => {
      mutations.push(["quota", ...args]);
    },
  };
  const app = makeApp(
    { requestOperation: async () => operationView("unused") },
    service,
    undefined,
    {
      sub: "provider-sub",
      role: "org_admin",
      email: "provider@test",
      userId: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000002",
      orgIds: ["00000000-0000-4000-8000-000000000002"],
    },
    undefined,
    undefined,
    undefined,
  );

  const suspend = await app.request("/api/cp/users/user-a/suspend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suspended: true }),
  });
  const quota = await app.request("/api/cp/users/user-a/quota", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "provider-operator" },
    body: JSON.stringify({ quota: 42 }),
  });

  await expectLegacyGovernanceWriteDisabled(suspend);
  await expectLegacyGovernanceWriteDisabled(quota);
  expect(mutations).toEqual([]);
});

test("rejects platform-wide legacy CP user governance writes", async () => {
  const mutations: unknown[] = [];
  const service = {
    setUserSuspended: async (...args: unknown[]) => {
      mutations.push(args);
    },
  };
  const app = makeApp(
    { requestOperation: async () => operationView("unused") },
    service,
    undefined,
    {
      sub: "platform-sub",
      role: "platform_admin",
      email: "platform@test",
      userId: "00000000-0000-4000-8000-000000000001",
      orgId: "00000000-0000-4000-8000-000000000002",
      orgIds: ["00000000-0000-4000-8000-000000000002"],
    },
    undefined,
    undefined,
    undefined,
  );

  const response = await app.request("/api/cp/users/user-a/suspend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suspended: true }),
  });

  await expectLegacyGovernanceWriteDisabled(response);
  expect(mutations).toEqual([]);
});

test("keeps CP management authorization ahead of the disabled write guard", async () => {
  let mutationCalls = 0;
  const app = makeApp(
    { requestOperation: async () => operationView("unused") },
    {
      setUserSuspended: async () => {
        mutationCalls += 1;
      },
      setUserQuota: async () => {
        mutationCalls += 1;
      },
    },
    undefined,
    {
      sub: "provider-operator",
      role: "user",
      email: "provider-operator@test",
      userId: "provider-operator-user",
      orgId: "00000000-0000-4000-8000-000000000002",
      orgIds: ["00000000-0000-4000-8000-000000000002"],
      memberships: [{ orgId: "00000000-0000-4000-8000-000000000002", role: "operator" }],
    },
  );

  const suspend = await app.request("/api/cp/users/user-a/suspend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suspended: true }),
  });
  const quota = await app.request("/api/cp/users/user-a/quota", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ quota: 42 }),
  });

  expect(suspend.status).toBe(403);
  expect(quota.status).toBe(403);
  expect(mutationCalls).toBe(0);
});

test("keeps authentication ahead of the disabled write guard", async () => {
  const app = makeApp(
    { requestOperation: async () => operationView("unused") },
    { setUserSuspended: async () => {} },
    undefined,
    null,
  );

  const response = await app.request("/api/cp/users/user-a/suspend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ suspended: true }),
  });

  expect(response.status).toBe(401);
  expect(await response.json()).toMatchObject({ error: { code: "UNAUTHENTICATED" } });
});

test("keeps CP user and audit reads available while legacy writes are disabled", async () => {
  const app = makeApp(
    { requestOperation: async () => operationView("unused") },
    {
      listUsers: async () => ({
        total: 1,
        items: [{ id: "user-a", email: "user-a@test", role: "user", suspended: false, quota: 7 }],
      }),
      searchAudit: async () => ({ total: 1, items: [{ action: "cp.user.suspend" }] }),
    },
    undefined,
    {
      sub: "provider-admin",
      role: "org_admin",
      email: "provider-admin@test",
      userId: "provider-admin-user",
      orgId: "00000000-0000-4000-8000-000000000002",
      orgIds: ["00000000-0000-4000-8000-000000000002"],
    },
  );

  const users = await app.request("/api/cp/users");
  const audit = await app.request("/api/cp/audit/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: "2026-01-01T00:00:00Z", to: "2026-01-02T00:00:00Z" }),
  });

  expect(users.status).toBe(200);
  expect(audit.status).toBe(200);
  expect(await users.json()).toMatchObject({ total: 1 });
  expect(await audit.json()).toMatchObject({ total: 1 });
});

async function expectLegacyGovernanceWriteDisabled(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({
    error: {
      code: ErrorCode.CP_GOVERNANCE_WRITE_DISABLED,
      message:
        "Compute-provider user governance writes are disabled pending organization-scoped governance.",
    },
  });
}

function operationView(spec: string): SoftwareOperationView {
  return {
    id: "op-route-test",
    agentId: "agent-a",
    requestedBy: "cp-route@test",
    action: "install",
    spec,
    status: "queued",
    stdout: null,
    stderr: null,
    exitCode: null,
    error: null,
    requestedAt: "2026-06-22T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    updatedAt: "2026-06-22T00:00:00.000Z",
  };
}

function failedOperationView(spec: string): SoftwareOperationView {
  return {
    ...operationView(spec),
    id: `op-failed-${spec}`,
    status: "failed",
    error: `failed to dispatch ${spec}`,
    finishedAt: "2026-06-22T00:00:01.000Z",
    updatedAt: "2026-06-22T00:00:01.000Z",
  };
}

test("provider operator membership cannot execute provider management mutations", async () => {
  let mutationCalls = 0;
  const app = makeApp(
    { requestOperation: async () => operationView("unused") },
    {
      editSoftwarePolicy: async () => {
        mutationCalls += 1;
      },
    },
    undefined,
    {
      sub: "provider-operator",
      role: "user",
      email: "provider-operator@test",
      userId: "provider-operator-user",
      orgId: "00000000-0000-4000-8000-000000000002",
      orgIds: ["00000000-0000-4000-8000-000000000002"],
      memberships: [{ orgId: "00000000-0000-4000-8000-000000000002", role: "operator" }],
    },
  );

  const response = await app.request("/api/cp/software/policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cluster: "cluster-a", list: "whitelist", specs: ["fftw"] }),
  });

  expect(response.status).toBe(403);
  expect(mutationCalls).toBe(0);
});

test("provider operator membership can execute in-scope software operations", async () => {
  let operationCalls = 0;
  const providerOrgId = "00000000-0000-4000-8000-000000000002";
  const app = makeApp(
    {
      assertAgentInScope: async () => undefined,
      requestOperation: async (input) => {
        operationCalls += 1;
        return operationView(input.spec);
      },
    },
    undefined,
    undefined,
    {
      sub: "provider-operator",
      role: "user",
      email: "provider-operator@test",
      userId: "provider-operator-user",
      orgId: providerOrgId,
      orgIds: [providerOrgId],
      memberships: [{ orgId: providerOrgId, role: "operator" }],
    },
  );

  const response = await app.request("/api/cp/software/operations", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
    body: JSON.stringify({ agentId: "agent-a", action: "install", spec: "zlib@1.3" }),
  });

  expect(response.status).toBe(202);
  expect(operationCalls).toBe(1);
});

function certService(
  overrides: Partial<CertIssuanceService> = {},
): Pick<CertIssuanceService, "listCerts" | "revokeCert"> {
  return {
    listCerts: async () => [
      {
        id: "cert-route-1",
        fingerprintSha256: "c".repeat(64),
        subjectCn: "agent-a",
        issuedAt: new Date("2026-01-01T00:00:00.000Z"),
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        revokedAt: null,
        issuedBy: "user-route-1",
      },
    ],
    revokeCert: async () => undefined,
    ...overrides,
  };
}

describe("CP agent registration token routes", () => {
  const providerA = "00000000-0000-4000-8000-00000000c001";
  const providerB = "00000000-0000-4000-8000-00000000c002";

  test("registration context returns provider org choices in CP scope", async () => {
    const scopes: Parameters<CpConsoleService["listRegistrationProviderOrgs"]>[0][] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listRegistrationProviderOrgs: async (scope) => {
          scopes.push(scope);
          return [{ id: providerA, name: "Provider A" }];
        },
      },
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
    );

    const res = await app.request("/api/cp/agent-registration-context");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providerOrgs: Array<{ id: string; name: string }>;
      isPlatformWide: boolean;
      schedulers: string[];
    };
    expect(body.providerOrgs).toEqual([{ id: providerA, name: "Provider A" }]);
    expect(body.isPlatformWide).toBe(false);
    expect(body.schedulers).toEqual(["slurm", "pbs-pro", "torque", "kubernetes"]);
    expect(scopes[0]?.orgIds).toEqual([providerA]);
    expect(scopes[0]?.isPlatformWide).toBe(false);
  });

  test("lists active registration tokens in CP scope without exposing plaintext tokens", async () => {
    const seen: unknown[] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      {
        createToken: async () => {
          throw new Error("should not be called");
        },
        listActive: async (input) => {
          seen.push(input);
          return [
            {
              id: "intent-active-a",
              agentId: "agent-route-active",
              siteName: "site-active",
              providerOrgId: providerA,
              expiresAt: new Date("2026-07-07T00:00:00.000Z"),
              createdAt: new Date("2026-07-06T00:00:00.000Z"),
            },
          ];
        },
        revoke: async () => undefined,
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens");

    expect(res.status).toBe(200);
    expect(seen).toEqual([{ providerOrgIds: [providerA], isPlatformWide: false }]);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        agentId: string;
        siteName: string;
        providerOrgId: string;
        token?: string;
        createdAt: string;
        expiresAt: string;
      }>;
    };
    expect(body.items).toEqual([
      {
        id: "intent-active-a",
        agentId: "agent-route-active",
        siteName: "site-active",
        providerOrgId: providerA,
        expiresAt: "2026-07-07T00:00:00.000Z",
        createdAt: "2026-07-06T00:00:00.000Z",
      },
    ]);
    expect(body.items[0]?.token).toBeUndefined();
  });

  test("platform-wide token creation requires an explicit provider org", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "platform-sub",
        role: "platform_admin",
        email: "platform@test",
        userId: "platform-user",
        orgIds: [],
      },
      {
        createToken: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
        revoke: async () => undefined,
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-route-a",
        siteName: "site-a",
        expiresInSec: 3600,
      }),
    });

    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("requires an active organization before a multi-provider mutation", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "provider-sub",
        role: "user",
        email: "provider@test",
        userId: "provider-user",
        memberships: [
          { orgId: providerA, role: "owner" },
          { orgId: providerB, role: "admin" },
        ],
      },
      {
        createToken: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
        revoke: async () => undefined,
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-route-a",
        siteName: "site-a",
        expiresInSec: 3600,
      }),
    });

    expect(res.status).toBe(409);
    expect(calls).toBe(0);
  });

  test("non-platform CP admins cannot create tokens for another provider org", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      {
        createToken: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
        revoke: async () => undefined,
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        providerOrgId: providerB,
        agentId: "agent-route-b",
        siteName: "site-b",
        expiresInSec: 3600,
      }),
    });

    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("single-provider CP admins can omit providerOrgId and create scoped tokens", async () => {
    const seen: unknown[] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      {
        createToken: async (input) => {
          seen.push(input);
          return {
            id: "intent-route-a",
            agentId: input.agentId,
            siteName: input.siteName,
            providerOrgId: input.providerOrgId,
            token: "kqagt-route-token",
            expiresAt: new Date("2026-07-07T00:00:00.000Z"),
          };
        },
        revoke: async () => undefined,
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-route-c",
        siteName: "site-c",
        expiresInSec: 3600,
      }),
    });

    expect(res.status).toBe(201);
    expect(seen).toEqual([
      {
        agentId: "agent-route-c",
        siteName: "site-c",
        providerOrgId: providerA,
        expiresInSec: 3600,
        createdBy: "provider-user",
      },
    ]);
    const body = (await res.json()) as { providerOrgId: string; token: string };
    expect(body.providerOrgId).toBe(providerA);
    expect(body.token).toBe("kqagt-route-token");
  });

  test("fails closed before creating registration tokens without canonical actor", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        orgIds: [providerA],
      },
      {
        createToken: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
        revoke: async () => undefined,
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-route-no-actor",
        siteName: "site-no-actor",
        expiresInSec: 3600,
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(calls).toBe(0);
  });

  test("platform admins can create tokens for an explicit provider org", async () => {
    const seen: unknown[] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "platform-sub",
        role: "platform_admin",
        email: "platform@test",
        userId: "platform-user",
        orgIds: [],
      },
      {
        createToken: async (input) => {
          seen.push(input);
          return {
            id: "intent-route-b",
            agentId: input.agentId,
            siteName: input.siteName,
            providerOrgId: input.providerOrgId,
            token: "kqagt-platform-token",
            expiresAt: new Date("2026-07-07T00:00:00.000Z"),
          };
        },
        revoke: async () => undefined,
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        providerOrgId: providerB,
        agentId: "agent-route-d",
        siteName: "site-d",
        expiresInSec: 3600,
      }),
    });

    expect(res.status).toBe(201);
    expect(seen).toEqual([
      {
        agentId: "agent-route-d",
        siteName: "site-d",
        providerOrgId: providerB,
        expiresInSec: 3600,
        createdBy: "platform-user",
      },
    ]);
  });

  test("fails closed before revoking registration tokens without canonical actor", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      undefined,
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        orgIds: [providerA],
      },
      {
        createToken: async () => {
          throw new Error("should not be called");
        },
        revoke: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
      },
    );

    const res = await app.request("/api/cp/agent-registration-tokens/intent-no-actor", {
      method: "DELETE",
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(calls).toBe(0);
  });
});

describe("CP agent certificate routes", () => {
  const providerA = "00000000-0000-4000-8000-00000000c001";
  const fp = "c".repeat(64);

  test("lists cert metadata for an in-scope CP agent without PEM", async () => {
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgents: async () => [
          { id: "agent-a", hostname: "host-a", siteId: "site-a", status: "online" },
        ],
      },
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      undefined,
      certService(),
    );

    const res = await app.request("/api/cp/agents/agent-a/certs");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      certs: Array<{
        id: string;
        fingerprintSha256: string;
        subjectCn: string;
        issuedAt: string;
        expiresAt: string;
        revokedAt: string | null;
        issuedBy: string | null;
        certPem?: string;
      }>;
    };
    expect(body.certs).toEqual([
      {
        id: "cert-route-1",
        fingerprintSha256: fp,
        subjectCn: "agent-a",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        revokedAt: null,
        issuedBy: "user-route-1",
      },
    ]);
    expect(body.certs[0]?.certPem).toBeUndefined();
  });

  test("rejects cert listing for an out-of-scope CP agent", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgents: async () => [
          { id: "agent-a", hostname: "host-a", siteId: "site-a", status: "online" },
        ],
      },
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      undefined,
      certService({
        listCerts: async () => {
          calls += 1;
          return [];
        },
      }),
    );

    const res = await app.request("/api/cp/agents/agent-b/certs");

    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("revokes certs for an in-scope CP agent with canonical actor", async () => {
    let revoked: unknown = null;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgents: async () => [
          { id: "agent-a", hostname: "host-a", siteId: "site-a", status: "online" },
        ],
      },
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      undefined,
      certService({
        revokeCert: async (input) => {
          revoked = input;
        },
      }),
    );

    const res = await app.request(`/api/cp/agents/agent-a/certs/${fp}`, { method: "DELETE" });

    expect(res.status).toBe(204);
    expect(revoked).toEqual({
      agentId: "agent-a",
      fingerprintSha256: fp,
      revokedBy: "provider-user",
    });
  });

  test("revokes certs with an audit reason over POST", async () => {
    let revoked: unknown = null;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgents: async () => [
          { id: "agent-a", hostname: "host-a", siteId: "site-a", status: "online" },
        ],
      },
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      undefined,
      certService({
        revokeCert: async (input) => {
          revoked = input;
        },
      }),
    );

    const res = await app.request(`/api/cp/agents/agent-a/certs/${fp}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ reason: "operator rotated key" }),
    });

    expect(res.status).toBe(200);
    expect(revoked).toEqual({
      agentId: "agent-a",
      fingerprintSha256: fp,
      revokedBy: "provider-user",
      reason: "operator rotated key",
    });
  });

  test("fails closed before revoking certs without canonical actor", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgents: async () => [
          { id: "agent-a", hostname: "host-a", siteId: "site-a", status: "online" },
        ],
      },
      undefined,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        orgIds: [providerA],
      },
      undefined,
      certService({
        revokeCert: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
      }),
    );

    const res = await app.request(`/api/cp/agents/agent-a/certs/${fp}`, { method: "DELETE" });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(calls).toBe(0);
  });

  test("uses agent#operate and agent#manage for cert list and revoke in enforce mode", async () => {
    const checks: Array<{ input: unknown; isPlatformAdmin: boolean }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown, isPlatformAdmin: boolean) => {
        checks.push({ input, isPlatformAdmin });
      },
    } as unknown as AuthzService;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      { listAgents: async () => [] },
      authz,
      {
        sub: "provider-sub",
        role: "org_admin",
        email: "provider@test",
        userId: "provider-user",
        orgIds: [providerA],
      },
      undefined,
      certService(),
    );

    const list = await app.request("/api/cp/agents/agent-spice/certs");
    const revoke = await app.request(`/api/cp/agents/agent-spice/certs/${fp}`, {
      method: "DELETE",
    });

    expect(list.status).toBe(200);
    expect(revoke.status).toBe(204);
    expect(checks.map((check) => check.input)).toEqual([
      {
        actorUserId: "provider-user",
        actorEmail: "provider@test",
        resource: { type: "agent", id: "agent-spice" },
        permission: "operate",
        subject: { type: "user", id: "provider-user" },
        context: { localAllowed: false, source: "cp-agent-certs" },
        localAllowed: false,
      },
      {
        actorUserId: "provider-user",
        actorEmail: "provider@test",
        resource: { type: "agent", id: "agent-spice" },
        permission: "manage",
        subject: { type: "user", id: "provider-user" },
        context: { localAllowed: false, source: "cp-agent-certs" },
        localAllowed: false,
      },
    ]);
    expect(checks.map((check) => check.isPlatformAdmin)).toEqual([false, false]);
  });
});

describe("CP software operation routes", () => {
  test("fails closed for non-provider dashboard requests in enforce mode", async () => {
    let dashboardCalls = 0;
    const protectedPaths = [
      "/api/cp/dashboard",
      "/api/cp/software/policies",
      "/api/cp/software/overview",
      "/api/cp/users",
      "/api/cp/agent-registration-context",
      "/api/cp/agent-registration-tokens",
      "/api/cp/data/assets",
      "/api/cp/data/imports",
      "/api/cp/data/access-requests",
    ];
    for (const principal of [
      {
        sub: "ordinary-subject",
        role: "user",
        email: "ordinary@example.test",
        userId: "ordinary-user",
        orgId: null,
        orgIds: [],
      },
      {
        sub: "member-subject",
        role: "user",
        email: "member@example.test",
        userId: "member-user",
        orgId: null,
        orgIds: [],
        memberships: [{ orgId: "provider-org", role: "member" }],
      },
    ]) {
      const app = makeApp(
        { requestOperation: async () => operationView("unexpected") },
        {
          getDashboardKpis: async () => {
            dashboardCalls += 1;
            throw new Error("should not be called");
          },
        },
        { mode: "enforce" } as AuthzService,
        principal,
      );
      for (const path of protectedPaths) {
        const res = await app.request(path);

        expect(res.status).toBe(403);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe("NO_ORG_MEMBERSHIP");
      }
    }
    expect(dashboardCalls).toBe(0);
  });

  test("filters CP agent list through SpiceDB agent operate lookup in enforce mode", async () => {
    const lookupInputs: LookupResourcesInput[] = [];
    const agentIdInputs: string[][] = [];
    const authz = {
      mode: "enforce",
      lookupResources: async (input: LookupResourcesInput) => {
        lookupInputs.push(input);
        return ["agent-b"];
      },
    } as unknown as AuthzService;
    const app = makeApp(
      {
        requestOperation: async () => operationView("unexpected"),
      },
      {
        listAgentsByIds: async (agentIds) => {
          agentIdInputs.push(agentIds);
          return [
            { id: "agent-a", hostname: "site-a", siteId: "site-a", status: "online" },
            { id: "agent-b", hostname: "site-b", siteId: "site-b", status: "offline" },
          ].filter((agent) => agentIds.includes(agent.id)) satisfies CpAgentList;
        },
      },
      authz,
      {
        sub: "oidc-subject",
        role: "user",
        email: "spice-agent-view@example.test",
        userId: "user-spice-agent-view",
        orgId: null,
        orgIds: [],
      },
    );

    const res = await app.request("/api/cp/agents");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: CpAgentList };
    expect(body.items.map((agent) => agent.id)).toEqual(["agent-b"]);
    expect(lookupInputs).toEqual([
      {
        resourceType: "agent",
        permission: "operate",
        subject: { type: "user", id: "user-spice-agent-view" },
      },
    ]);
    expect(agentIdInputs).toEqual([["agent-b"]]);
  });

  test("rejects an organization member with only agent view permission", async () => {
    const lookupInputs: LookupResourcesInput[] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgentsByIds: async () => {
          throw new Error("should not be called");
        },
      },
      {
        mode: "enforce",
        lookupResources: async (input: LookupResourcesInput) => {
          lookupInputs.push(input);
          return input.permission === "view" ? ["agent-member-visible"] : [];
        },
      } as unknown as AuthzService,
      {
        sub: "member-subject",
        role: "user",
        email: "member-view@example.test",
        userId: "member-view-user",
        orgId: null,
        orgIds: [],
        memberships: [{ orgId: "provider-org", role: "member" }],
      },
    );

    const res = await app.request("/api/cp/agents");

    expect(res.status).toBe(403);
    expect(lookupInputs).toEqual([
      {
        resourceType: "agent",
        permission: "operate",
        subject: { type: "user", id: "member-view-user" },
      },
    ]);
  });

  test("fails closed for CP agent list in enforce mode without canonical user id", async () => {
    let lookupCalls = 0;
    let listCalls = 0;
    const authz = {
      mode: "enforce",
      lookupResources: async () => {
        lookupCalls += 1;
        return ["agent-a"];
      },
    } as unknown as AuthzService;
    const app = makeApp(
      {
        requestOperation: async () => operationView("unexpected"),
      },
      {
        listAgents: async () => {
          listCalls += 1;
          return [];
        },
      },
      authz,
      {
        sub: "oidc-subject",
        role: "user",
        email: "missing-user-id@example.test",
        orgId: null,
        orgIds: [],
      },
    );

    const res = await app.request("/api/cp/agents");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(lookupCalls).toBe(0);
    expect(listCalls).toBe(0);
  });

  test("fails closed for CP agent list when SpiceDB lookup is unavailable", async () => {
    let listCalls = 0;
    const authz = {
      mode: "enforce",
      lookupResources: async () => {
        throw new Error("lookup down");
      },
    } as unknown as AuthzService;
    const app = makeApp(
      {
        requestOperation: async () => operationView("unexpected"),
      },
      {
        listAgents: async () => {
          listCalls += 1;
          return [{ id: "agent-a", hostname: "site-a", siteId: "site-a", status: "online" }];
        },
      },
      authz,
      {
        sub: "oidc-subject",
        role: "user",
        email: "lookup-down@example.test",
        userId: "user-lookup-down",
        orgId: null,
        orgIds: [],
      },
    );

    const res = await app.request("/api/cp/agents");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("Authorization unavailable: lookup down");
    expect(listCalls).toBe(0);
  });

  test("rejects policy overlays with conflicting allow and deny specs", async () => {
    let calls = 0;
    const app = makeApp(
      {
        requestOperation: async () => operationView("unexpected"),
      },
      {
        saveClusterSoftwarePolicy: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
      },
    );

    const res = await app.request("/api/cp/software/policies/clusters/cluster-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        installMode: "explicit-install-grant",
        allowList: [" zlib "],
        denyList: ["zlib"],
        lockEnabled: false,
        trustedPublicAutoInstall: false,
        usecaseDefaultAllow: true,
        usecaseAllowList: [],
        usecaseDenyList: [],
        mirrors: [],
        preinstallList: [],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Spack specs cannot be both allowed and denied: zlib");
    expect(calls).toBe(0);
  });

  test("rejects policy overlays with conflicting usecase grant and deny entries", async () => {
    let calls = 0;
    const app = makeApp(
      {
        requestOperation: async () => operationView("unexpected"),
      },
      {
        saveAgentSoftwarePolicy: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
      },
    );

    const res = await app.request("/api/cp/software/policies/agents/agent-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        installMode: "explicit-install-grant",
        allowList: [],
        denyList: [],
        lockEnabled: false,
        trustedPublicAutoInstall: false,
        usecaseDefaultAllow: false,
        usecaseAllowList: ["usecase:foam"],
        usecaseDenyList: [" usecase:foam "],
        mirrors: [],
        preinstallList: [],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain(
      "Software usecases cannot be both granted and denied: usecase:foam",
    );
    expect(calls).toBe(0);
  });

  test("passes operation list status and action filters to the service", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const app = makeApp({
      requestOperation: async () => operationView("unexpected"),
      listOperations: async (input) => {
        seen.push(input as unknown as Record<string, unknown>);
        return [failedOperationView("zlib")];
      },
    });

    const res = await app.request(
      "/api/cp/software/operations?agentId=agent-a&status=failed&action=install&limit=50",
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: SoftwareOperationView[] };
    expect(body.items.map((item) => item.status)).toEqual(["failed"]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      agentId: "agent-a",
      status: "failed",
      action: "install",
      limit: 50,
    });
  });

  test("rejects blank single-operation specs before reaching the service", async () => {
    let calls = 0;
    const app = makeApp({
      requestOperation: async () => {
        calls += 1;
        return operationView("unexpected");
      },
    });

    const res = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", spec: "   " }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(calls).toBe(0);
  });

  test("requires an idempotency key before creating a software operation", async () => {
    let calls = 0;
    const app = makeApp({
      requestOperation: async () => {
        calls += 1;
        return operationView("unexpected");
      },
    });

    const res = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", spec: "zlib@1.3" }),
    });

    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("trims single-operation specs before dispatch", async () => {
    let seenSpec = "";
    let seenRequestedBy = "";
    let seenIdempotencyKey = "";
    const app = makeApp({
      requestOperation: async (input) => {
        seenSpec = input.spec;
        seenRequestedBy = input.requestedBy;
        seenIdempotencyKey = input.idempotencyKey ?? "";
        return operationView(input.spec);
      },
    });

    const res = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", spec: " zlib@1.3 " }),
    });

    expect(res.status).toBe(202);
    expect(seenSpec).toBe("zlib@1.3");
    expect(seenRequestedBy).toBe("user-cp-route");
    expect(seenIdempotencyKey).toBe("software-operation-test");
    const body = (await res.json()) as SoftwareOperationView;
    expect(body.spec).toBe("zlib@1.3");
  });

  test("rejects single operations denied by agent#operate before creating an operation", async () => {
    let calls = 0;
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    } as unknown as AuthzService;
    const app = makeApp(
      {
        requestOperation: async () => {
          calls += 1;
          return operationView("unexpected");
        },
      },
      undefined,
      authz,
      {
        sub: "cp-route@test",
        role: "super_admin",
        email: "cp-route@test",
        userId: "user-cp-route",
        orgId: null,
        orgIds: [],
      },
    );

    const res = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", spec: "zlib@1.3" }),
    });

    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("uses agent#operate as the CP software operation gate in enforce mode", async () => {
    const checks: unknown[] = [];
    let calls = 0;
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        checks.push(input);
      },
    } as unknown as AuthzService;
    const app = makeApp(
      {
        assertAgentInScope: async () => {
          throw new AppError(ErrorCode.FORBIDDEN, "local scope should not run", 403);
        },
        requestOperation: async (input) => {
          calls += 1;
          expect(input.agentScopeVerified).toBe(true);
          return operationView(input.spec);
        },
      },
      undefined,
      authz,
      {
        sub: "stale-cp-subject",
        role: "user",
        email: "bound-cp-member@test",
        userId: "user-member-1",
      },
    );

    const res = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", spec: "zlib@1.3" }),
    });

    expect(res.status).toBe(202);
    expect(calls).toBe(1);
    expect(checks).toEqual([
      {
        actorUserId: "user-member-1",
        actorEmail: "bound-cp-member@test",
        resource: { type: "agent", id: "agent-a" },
        permission: "operate",
        subject: { type: "user", id: "user-member-1" },
        context: { localAllowed: false, source: "cp-software" },
        localAllowed: false,
      },
    ]);
  });

  test("records out-of-scope CP agent operation as local denial in enforce mode", async () => {
    const checks: unknown[] = [];
    let calls = 0;
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        checks.push(input);
      },
    } as unknown as AuthzService;
    const app = makeApp(
      {
        assertAgentInScope: async () => {
          throw new AppError(ErrorCode.FORBIDDEN, "Agent is outside CP scope", 403);
        },
        requestOperation: async (input) => {
          calls += 1;
          expect(input.agentScopeVerified).toBe(true);
          return operationView(input.spec);
        },
      },
      undefined,
      authz,
      {
        sub: "stale-provider-subject",
        role: "org_admin",
        email: "bound-cp-provider@test",
        userId: "provider-user-1",
        orgIds: ["org-a"],
      },
    );

    const res = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-b", action: "install", spec: "zlib@1.3" }),
    });

    expect(res.status).toBe(202);
    expect(calls).toBe(1);
    expect(checks).toEqual([
      {
        actorUserId: "provider-user-1",
        actorEmail: "bound-cp-provider@test",
        resource: { type: "agent", id: "agent-b" },
        permission: "operate",
        subject: { type: "user", id: "provider-user-1" },
        context: { localAllowed: false, source: "cp-software" },
        localAllowed: false,
      },
    ]);
  });

  test("checks agent#operate before listing operations for a specific agent", async () => {
    const calls: unknown[] = [];
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        calls.push(input);
        return true;
      },
    } as unknown as AuthzService;
    const app = makeApp(
      {
        requestOperation: async () => operationView("unexpected"),
        listOperations: async () => [operationView("zlib@1.3")],
      },
      undefined,
      authz,
    );

    const res = await app.request("/api/cp/software/operations?agentId=agent-a");

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "user-cp-route",
        actorEmail: "cp-route@test",
        resource: { type: "agent", id: "agent-a" },
        permission: "operate",
        subject: { type: "user", id: "user-cp-route" },
        context: { localAllowed: true, source: "cp-software" },
        localAllowed: true,
      },
    ]);
  });

  test("uses agent#operate as the CP software operation list gate in enforce mode", async () => {
    const checks: unknown[] = [];
    const app = makeApp(
      {
        assertAgentInScope: async () => {
          throw new AppError(ErrorCode.FORBIDDEN, "local scope should not run", 403);
        },
        requestOperation: async () => operationView("unexpected"),
        listOperations: async (input) => {
          expect(input.agentScopeVerified).toBe(true);
          return [operationView("zlib@1.3")];
        },
      },
      undefined,
      {
        mode: "enforce",
        requirePermission: async (input: unknown) => {
          checks.push(input);
        },
      } as unknown as AuthzService,
      {
        sub: "stale-cp-view-subject",
        role: "user",
        email: "bound-cp-view@test",
        userId: "user-member-1",
      },
    );

    const res = await app.request("/api/cp/software/operations?agentId=agent-a");

    expect(res.status).toBe(200);
    expect(checks).toEqual([
      {
        actorUserId: "user-member-1",
        actorEmail: "bound-cp-view@test",
        resource: { type: "agent", id: "agent-a" },
        permission: "operate",
        subject: { type: "user", id: "user-member-1" },
        context: { localAllowed: false, source: "cp-software" },
        localAllowed: false,
      },
    ]);
  });

  test("fails closed for CP software checks without canonical user id in enforce mode", async () => {
    const checks: unknown[] = [];
    let calls = 0;
    const app = makeApp(
      {
        requestOperation: async () => {
          calls += 1;
          return operationView("unexpected");
        },
        listOperations: async () => {
          calls += 1;
          return [operationView("unexpected")];
        },
      },
      undefined,
      {
        mode: "enforce",
        requirePermission: async (input: unknown) => {
          checks.push(input);
        },
      } as unknown as AuthzService,
      {
        sub: "member@test",
        role: "user",
        email: "member@test",
      },
    );

    const createRes = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", spec: "zlib@1.3" }),
    });
    const listRes = await app.request("/api/cp/software/operations?agentId=agent-a");

    expect(createRes.status).toBe(403);
    expect(listRes.status).toBe(403);
    expect(calls).toBe(0);
    expect(checks).toEqual([]);
  });

  test("fails closed for CP software checks without canonical user id in shadow mode", async () => {
    const checks: unknown[] = [];
    let calls = 0;
    const app = makeApp(
      {
        requestOperation: async () => {
          calls += 1;
          return operationView("unexpected");
        },
        listOperations: async () => {
          calls += 1;
          return [operationView("unexpected")];
        },
      },
      undefined,
      {
        mode: "shadow",
        shadowCheck: async (input: unknown) => {
          checks.push(input);
        },
      } as unknown as AuthzService,
      {
        sub: "member@test",
        role: "user",
        email: "member@test",
      },
    );

    const createRes = await app.request("/api/cp/software/operations", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", spec: "zlib@1.3" }),
    });
    const listRes = await app.request("/api/cp/software/operations?agentId=agent-a");

    expect(createRes.status).toBe(403);
    expect(listRes.status).toBe(403);
    expect(calls).toBe(0);
    expect(checks).toEqual([]);
  });

  test("trims, de-duplicates, and ignores blank batch specs before dispatch", async () => {
    const seenSpecs: string[] = [];
    const seenRequesters: string[] = [];
    let precheckCalls = 0;
    const app = makeApp({
      assertAgentInScope: async () => {
        precheckCalls += 1;
      },
      requestOperation: async (input) => {
        expect(input.agentScopeVerified).toBe(true);
        seenSpecs.push(input.spec);
        seenRequesters.push(input.requestedBy);
        return operationView(input.spec);
      },
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-a",
        action: "install",
        specs: [" zlib@1.3 ", "", "zlib@1.3", " openmpi@4.1.6 "],
      }),
    });

    expect(res.status).toBe(202);
    expect(precheckCalls).toBe(1);
    expect(seenSpecs).toEqual(["zlib@1.3", "openmpi@4.1.6"]);
    expect(seenRequesters).toEqual(["user-cp-route", "user-cp-route"]);
    const body = (await res.json()) as {
      items: SoftwareOperationView[];
      summary: {
        inputCount: number;
        nonEmptyCount: number;
        uniqueSpecCount: number;
        ignoredEmptyCount: number;
        ignoredDuplicateCount: number;
      };
    };
    expect(body.items.map((item) => item.spec)).toEqual(["zlib@1.3", "openmpi@4.1.6"]);
    expect(body.summary).toEqual({
      inputCount: 4,
      nonEmptyCount: 3,
      uniqueSpecCount: 2,
      ignoredEmptyCount: 1,
      ignoredDuplicateCount: 1,
    });
  });

  test("accepts duplicate-heavy batch requests when the unique spec count is within the limit", async () => {
    const seenSpecs: string[] = [];
    const app = makeApp({
      requestOperation: async (input) => {
        seenSpecs.push(input.spec);
        return operationView(input.spec);
      },
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-a",
        action: "install",
        specs: [
          ...Array.from({ length: 201 }, () => " zlib@1.3 "),
          ...Array.from({ length: 201 }, () => " openmpi@4.1.6 "),
        ],
      }),
    });

    expect(res.status).toBe(202);
    expect(seenSpecs).toEqual(["zlib@1.3", "openmpi@4.1.6"]);
    const body = (await res.json()) as {
      items: SoftwareOperationView[];
      summary: { ignoredDuplicateCount: number; uniqueSpecCount: number };
    };
    expect(body.items.map((item) => item.spec)).toEqual(["zlib@1.3", "openmpi@4.1.6"]);
    expect(body.summary.ignoredDuplicateCount).toBe(400);
    expect(body.summary.uniqueSpecCount).toBe(2);
  });

  test("rejects batch requests with more than 200 unique specs after normalization", async () => {
    let calls = 0;
    const app = makeApp({
      requestOperation: async () => {
        calls += 1;
        return operationView("unexpected");
      },
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-a",
        action: "install",
        specs: Array.from({ length: 201 }, (_, index) => `pkg-${index}`),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("At most 200 unique specs can be submitted at once");
    expect(calls).toBe(0);
  });

  test("rejects batch requests with more than 2000 raw spec lines before dispatch", async () => {
    let calls = 0;
    const app = makeApp({
      requestOperation: async () => {
        calls += 1;
        return operationView("unexpected");
      },
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-a",
        action: "install",
        specs: Array.from({ length: 2001 }, () => "zlib@1.3"),
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(calls).toBe(0);
  });

  test("prevalidates the batch target agent before creating any operation", async () => {
    let calls = 0;
    const app = makeApp({
      assertAgentInScope: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Agent is outside CP scope", 403);
      },
      requestOperation: async () => {
        calls += 1;
        return operationView("unexpected");
      },
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-a",
        action: "install",
        specs: ["zlib@1.3", "openmpi@4.1.6"],
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Agent is outside CP scope");
    expect(calls).toBe(0);
  });

  test("preserves per-spec failed operation items in batch responses", async () => {
    const app = makeApp({
      requestOperation: async (input) =>
        input.spec === "bad@1" ? failedOperationView(input.spec) : operationView(input.spec),
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-a",
        action: "install",
        specs: ["ok@1", "bad@1"],
      }),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { items: SoftwareOperationView[] };
    expect(body.items.map((item) => [item.spec, item.status])).toEqual([
      ["ok@1", "queued"],
      ["bad@1", "failed"],
    ]);
    expect(body.items[1]?.error).toBe("failed to dispatch bad@1");
  });

  test("rejects batch requests with no non-empty specs", async () => {
    let calls = 0;
    const app = makeApp({
      requestOperation: async () => {
        calls += 1;
        return operationView("unexpected");
      },
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({ agentId: "agent-a", action: "install", specs: [" ", "\t"] }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("At least one non-empty spec is required");
    expect(calls).toBe(0);
  });

  test("rejects unsupported batch operation actions before reaching the service", async () => {
    let calls = 0;
    const app = makeApp({
      requestOperation: async () => {
        calls += 1;
        return operationView("unexpected");
      },
    });

    const res = await app.request("/api/cp/software/operations/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "software-operation-test" },
      body: JSON.stringify({
        agentId: "agent-a",
        action: "uninstall",
        specs: ["zlib@1.3"],
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(calls).toBe(0);
  });

  test("reviews preinstalled mappings after checking agent manage scope", async () => {
    const seen: unknown[] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgents: async () => [
          {
            id: "agent-a",
            hostname: "agent-a",
            siteId: "site-a",
            status: "online",
          },
        ],
        reviewPreinstalledMapping: async (scope, input) => {
          seen.push({ scope, input });
          return {
            providerOrgIds: [],
            providerPolicy: null,
            clusters: [],
            agents: [],
            summary: {
              clusters: 0,
              agents: 0,
              lockedAgents: 0,
              overrides: 0,
              mirrors: 0,
              preinstalledSpecs: 0,
              installedSpecs: 0,
            },
          };
        },
      },
      {
        mode: "shadow",
        shadowCheck: async (input: unknown) => {
          seen.push({ authz: input });
          return true;
        },
      } as unknown as AuthzService,
      {
        sub: "stale-review-sub",
        role: "org_admin",
        email: "reviewer@test",
        userId: "reviewer-user-1",
        orgIds: ["org-a"],
      },
    );

    const res = await app.request("/api/cp/software/preinstalled-mappings/map-a/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-a", decision: "approve" }),
    });

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        authz: {
          actorUserId: "reviewer-user-1",
          actorEmail: "reviewer@test",
          resource: { type: "agent", id: "agent-a" },
          permission: "manage",
          subject: { type: "user", id: "reviewer-user-1" },
          context: { localAllowed: true, source: "cp-software-preinstalled-mapping" },
          localAllowed: true,
        },
      },
      {
        scope: expect.objectContaining({ orgIds: ["org-a"], isPlatformWide: false }),
        input: {
          agentId: "agent-a",
          mappingId: "map-a",
          decision: "approve",
          reviewedBy: "reviewer-user-1",
        },
      },
    ]);
  });

  test("rejects preinstalled mapping review before mutation when agent manage is denied", async () => {
    let calls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unexpected") },
      {
        listAgents: async () => [
          {
            id: "agent-a",
            hostname: "agent-a",
            siteId: "site-a",
            status: "online",
          },
        ],
        reviewPreinstalledMapping: async () => {
          calls += 1;
          throw new Error("should not be called");
        },
      },
      {
        mode: "enforce",
        requirePermission: async () => {
          throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
        },
      } as unknown as AuthzService,
    );

    const res = await app.request("/api/cp/software/preinstalled-mappings/map-a/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "agent-a", decision: "reject" }),
    });

    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("CP data import accepts only the strict source union and never forwards manifests", async () => {
    const imports: unknown[] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unused") },
      undefined,
      undefined,
      {
        sub: "cp-data@test",
        role: "org_admin",
        email: "cp-data@test",
        userId: "cp-data-user",
        orgId: "00000000-0000-4000-8000-000000000001",
        orgIds: ["00000000-0000-4000-8000-000000000001"],
      },
      undefined,
      undefined,
      {
        startProviderImport: async (_actor, input) => {
          imports.push(input);
          return {} as Awaited<ReturnType<DataMarketService["startProviderImport"]>>;
        },
      },
    );
    const headers = { "Content-Type": "application/json", "Idempotency-Key": "import-key" };
    const valid = await app.request("/api/cp/data/imports", {
      method: "POST",
      headers,
      body: JSON.stringify({
        assetId: "00000000-0000-4000-8000-000000000010",
        version: "v1",
        source: {
          kind: "cp-local",
          agentId: "agent-1",
          managedRootId: "00000000-0000-4000-8000-000000000011",
          relativePath: "cohort/run-1",
        },
      }),
    });
    const forbidden = await app.request("/api/cp/data/imports", {
      method: "POST",
      headers,
      body: JSON.stringify({
        assetId: "00000000-0000-4000-8000-000000000010",
        version: "v1",
        source: {
          kind: "cp-local",
          agentId: "agent-1",
          managedRootId: "00000000-0000-4000-8000-000000000011",
          relativePath: "cohort/run-1",
        },
        manifest: { checksum: "a".repeat(64) },
      }),
    });

    expect(valid.status).toBe(201);
    expect(forbidden.status).toBe(400);
    expect(imports).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ kind: "cp-local", relativePath: "cohort/run-1" }),
      }),
    ]);
  });

  test("platform-wide CP data mutations require an active organization", async () => {
    let assetCalls = 0;
    const app = makeApp(
      { requestOperation: async () => operationView("unused") },
      undefined,
      undefined,
      {
        sub: "platform-data",
        role: "platform_admin",
        email: "platform-data@test",
        userId: "platform-data-user",
        orgIds: [],
      },
      undefined,
      undefined,
      {
        createProviderAsset: async () => {
          assetCalls += 1;
          throw new Error("should not be called");
        },
      },
    );
    const response = await app.request("/api/cp/data/assets", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "platform-data-asset" },
      body: JSON.stringify({
        name: "Provider dataset",
        visibility: "organization",
        kind: "scientific-dataset",
        accessMode: "request",
        sensitivity: "internal",
        tags: [],
      }),
    });

    expect(response.status).toBe(409);
    expect(assetCalls).toBe(0);
  });

  test("scoped replica creation uses the active organization and never reaches another provider", async () => {
    const providerA = "00000000-0000-4000-8000-0000000000a1";
    const providerB = "00000000-0000-4000-8000-0000000000b1";
    const calls: unknown[] = [];
    const app = makeApp(
      { requestOperation: async () => operationView("unused") },
      undefined,
      undefined,
      {
        sub: "multi-provider-data",
        role: "user",
        email: "multi-provider-data@test",
        userId: "multi-provider-data-user",
        memberships: [
          { orgId: providerA, role: "owner" },
          { orgId: providerB, role: "admin" },
        ],
      },
      undefined,
      undefined,
      {
        createReplica: async (actor, input) => {
          calls.push({ actor, input });
          throw new AppError(ErrorCode.FORBIDDEN, "Not authorized for this data asset", 403);
        },
      },
    );
    const response = await app.request("/api/cp/data/versions/version-owned-by-b/replicas", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": "replica-b-from-a",
        "X-KQ-Active-Organization": providerA,
      },
      body: JSON.stringify({
        agentId: "agent-a",
        siteId: "site-a",
        clusterId: "cluster-a",
        locationKind: "cp-local",
      }),
    });

    expect(response.status).toBe(403);
    expect(calls).toEqual([
      {
        actor: expect.objectContaining({
          orgId: providerA,
          orgIds: [providerA],
          providerManagerOrgIds: [providerA],
        }),
        input: expect.objectContaining({ versionId: "version-owned-by-b" }),
      },
    ]);
  });

  test("scoped replica creation surfaces the unavailable coordinator without persisting a row", async () => {
    let replicaCalls = 0;
    const providerOrgId = "00000000-0000-4000-8000-0000000000a1";
    const app = makeApp(
      { requestOperation: async () => operationView("unused") },
      undefined,
      undefined,
      {
        sub: "provider-data",
        role: "org_admin",
        email: "provider-data@test",
        userId: "provider-data-user",
        orgId: providerOrgId,
        orgIds: [providerOrgId],
      },
      undefined,
      undefined,
      {
        createReplica: async () => {
          replicaCalls += 1;
          throw new AppError(
            ErrorCode.INTERNAL_ERROR,
            "DATA_REPLICA_UNAVAILABLE: replica coordinator is not configured",
            501,
          );
        },
      },
    );
    const response = await app.request("/api/cp/data/versions/version-a/replicas", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "replica-unavailable" },
      body: JSON.stringify({
        agentId: "agent-a",
        siteId: "site-a",
        clusterId: "cluster-a",
        locationKind: "cp-local",
      }),
    });

    expect(response.status).toBe(501);
    expect(replicaCalls).toBe(1);
  });

  test("CP access request endpoints preserve scope, pagination, and strict review decisions", async () => {
    const listInputs: unknown[] = [];
    const reviews: unknown[] = [];
    const accessRequest: DataAccessRequest = {
      id: "request-1",
      assetId: "00000000-0000-4000-8000-000000000010",
      requesterUserId: "00000000-0000-4000-8000-000000000020",
      requesterOrgId: "00000000-0000-4000-8000-000000000021",
      status: "pending",
      reason: "Need access",
      reviewedBy: null,
      reviewedAt: null,
      createdAt: new Date("2026-07-24T00:00:00.000Z"),
      capability: "use",
      subjectKind: "user",
      subjectId: "00000000-0000-4000-8000-000000000020",
      decisionReason: null,
      expiresAt: null,
    };
    const app = makeApp(
      { requestOperation: async () => operationView("unused") },
      undefined,
      undefined,
      {
        sub: "cp-data-review@test",
        role: "org_admin",
        email: "cp-data-review@test",
        userId: "cp-data-reviewer",
        orgId: "00000000-0000-4000-8000-000000000001",
        orgIds: ["00000000-0000-4000-8000-000000000001"],
      },
      undefined,
      undefined,
      {
        listProviderAccessRequests: async (_actor, input) => {
          listInputs.push(input);
          return { requests: [], total: 0, limit: input.limit, offset: input.offset };
        },
        getProviderAccessRequest: async () => accessRequest,
        reviewProviderAccessRequest: async (_actor, requestId, review) => {
          reviews.push({ requestId, review });
          return {
            idempotent: false,
            request: { ...accessRequest, id: requestId, status: "approved" as const },
            grant: null,
            capabilityChange: null,
          };
        },
      },
    );

    const list = await app.request("/api/cp/data/access-requests?status=pending&limit=10&offset=2");
    const detail = await app.request("/api/cp/data/access-requests/request-1");
    const review = await app.request("/api/cp/data/access-requests/request-1/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "approve",
        reason: "Approved for analysis",
        expiresAt: "2026-08-01T00:00:00.000Z",
      }),
    });
    const invalid = await app.request("/api/cp/data/access-requests/request-1/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "reject", unexpected: true }),
    });

    expect(list.status).toBe(200);
    expect(detail.status).toBe(200);
    expect(review.status).toBe(200);
    expect(invalid.status).toBe(400);
    expect(listInputs).toEqual([{ status: "pending", limit: 10, offset: 2 }]);
    expect(reviews).toEqual([
      {
        requestId: "request-1",
        review: {
          decision: "approve",
          reason: "Approved for analysis",
          expiresAt: new Date("2026-08-01T00:00:00.000Z"),
        },
      },
    ]);
  });
});
