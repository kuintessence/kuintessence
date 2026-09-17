import { describe, expect, test } from "bun:test";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { Hono } from "hono";
import pino from "pino";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { type CertIssuanceService, createAdminAgentRoutes } from "./admin-agents";

function fakeService(overrides: Partial<CertIssuanceService> = {}): CertIssuanceService {
  return {
    listCerts: async () => [
      {
        id: "cert-1",
        fingerprintSha256: "e".repeat(64),
        subjectCn: "agent-7",
        issuedAt: new Date("2026-01-01T00:00:00Z"),
        expiresAt: new Date("2027-01-01T00:00:00Z"),
        revokedAt: null,
        issuedBy: "user-1",
      },
    ],
    issueCert: async ({ agentId }) => ({
      certPem: `-----BEGIN CERTIFICATE-----FAKE${agentId}-----END CERTIFICATE-----`,
      caCertPem: "-----BEGIN CERTIFICATE-----FAKECA-----END CERTIFICATE-----",
      fingerprintSha256: "f".repeat(64),
      issuedAt: new Date("2026-01-01T00:00:00Z"),
      expiresAt: new Date("2027-01-01T00:00:00Z"),
    }),
    revokeCert: async () => undefined,
    ...overrides,
  };
}

interface MakeAppOptions {
  readonly jwtSub?: string;
  readonly principalUserId?: string | null;
}

function makeApp(
  role: string,
  service: CertIssuanceService,
  authz?: AuthzService,
  options: MakeAppOptions = {},
): Hono {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    const sub = options.jwtSub ?? "user-1";
    const userId = options.principalUserId === undefined ? "user-1" : options.principalUserId;
    c.set("user" as never, { sub, role, email: "x@test" });
    if (userId !== null) {
      c.set("principal" as never, {
        sub,
        role,
        email: "x@test",
        userId,
        orgId: null,
        orgIds: [],
        memberships: [],
      });
    }
    await next();
  });
  app.route("/api", createAdminAgentRoutes(service, { authz }));
  return app;
}

describe("admin agent cert route", () => {
  test("platform_admin can list cert metadata without PEM", async () => {
    const app = makeApp("platform_admin", fakeService());
    const res = await app.request("/api/admin/agents/agent-7/certs");

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
        id: "cert-1",
        fingerprintSha256: "e".repeat(64),
        subjectCn: "agent-7",
        issuedAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2027-01-01T00:00:00.000Z",
        revokedAt: null,
        issuedBy: "user-1",
      },
    ]);
    expect(body.certs[0]?.certPem).toBeUndefined();
  });

  test("list endpoint uses platform#manage in enforce mode", async () => {
    const authzCalls: Array<AuthzCheck & { localAllowed: boolean }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (input: AuthzCheck) => {
        authzCalls.push(input as AuthzCheck & { localAllowed: boolean });
      },
    } as unknown as AuthzService;
    const app = makeApp("user", fakeService(), authz);

    const res = await app.request("/api/admin/agents/agent-7/certs");

    expect(res.status).toBe(200);
    expect(authzCalls[0]).toMatchObject({
      actorUserId: "user-1",
      resource: { type: "platform", id: "root" },
      permission: "manage",
      subject: { type: "user", id: "user-1" },
      context: { localAllowed: false, source: "admin-agents" },
    });
  });

  test("list endpoint fails closed in shadow mode without canonical principal", async () => {
    let listCalls = 0;
    const shadowCalls: unknown[] = [];
    const service = fakeService({
      listCerts: async () => {
        listCalls += 1;
        return fakeService().listCerts("agent-7");
      },
    });
    const authz = {
      mode: "shadow",
      shadowCheck: async (input: unknown) => {
        shadowCalls.push(input);
      },
    } as unknown as AuthzService;
    const app = makeApp("platform_admin", service, authz, { principalUserId: null });

    const res = await app.request("/api/admin/agents/agent-7/certs");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(listCalls).toBe(0);
    expect(shadowCalls).toEqual([]);
  });

  test("list endpoint fails closed in enforce mode without canonical principal", async () => {
    let listCalls = 0;
    const enforceCalls: unknown[] = [];
    const service = fakeService({
      listCerts: async () => {
        listCalls += 1;
        return fakeService().listCerts("agent-7");
      },
    });
    const authz = {
      mode: "enforce",
      requirePermission: async (input: unknown) => {
        enforceCalls.push(input);
      },
    } as unknown as AuthzService;
    const app = makeApp("platform_admin", service, authz, { principalUserId: null });

    const res = await app.request("/api/admin/agents/agent-7/certs");

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Authorization principal is not bound");
    expect(listCalls).toBe(0);
    expect(enforceCalls).toEqual([]);
  });

  test("platform_admin can issue a cert and gets PEM back", async () => {
    const app = makeApp("platform_admin", fakeService());
    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nABC\n-----END CERTIFICATE REQUEST-----",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      success: boolean;
      certPem: string;
      caCertPem: string;
      fingerprintSha256: string;
      expiresAt: string;
    };
    expect(body.success).toBe(true);
    expect(body.certPem).toContain("FAKEagent-7");
    expect(body.caCertPem).toContain("FAKECA");
    expect(body.fingerprintSha256).toMatch(/^f{64}$/);
    expect(body.expiresAt).toBe("2027-01-01T00:00:00.000Z");
  });

  test("rejects non-platform-admin", async () => {
    const app = makeApp("user", fakeService());
    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("rejects org_admin (only platform_admin and super_admin)", async () => {
    const app = makeApp("org_admin", fakeService());
    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "x" }),
    });
    expect(res.status).toBe(403);
  });

  test("super_admin also allowed", async () => {
    const app = makeApp("super_admin", fakeService());
    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "-----BEGIN CSR-----\nABC\n-----END CSR-----" }),
    });
    expect(res.status).toBe(201);
  });

  test("SpiceDB platform#manage can authorize a non-platform JWT role in enforce mode", async () => {
    const authzCalls: Array<{
      input: AuthzCheck & { localAllowed: boolean };
      isPlatformAdmin: boolean;
    }> = [];
    let issueCalls = 0;
    const authz = {
      mode: "enforce",
      requirePermission: async (input: AuthzCheck, isPlatformAdmin: boolean) => {
        authzCalls.push({
          input: input as AuthzCheck & { localAllowed: boolean },
          isPlatformAdmin,
        });
      },
    } as unknown as AuthzService;
    const service = fakeService({
      issueCert: async (input) => {
        issueCalls += 1;
        return fakeService().issueCert(input);
      },
    });
    const app = makeApp("user", service, authz);

    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "x" }),
    });

    expect(res.status).toBe(201);
    expect(issueCalls).toBe(1);
    expect(authzCalls).toEqual([
      {
        input: {
          actorUserId: "user-1",
          actorEmail: "x@test",
          resource: { type: "platform", id: "root" },
          permission: "manage",
          subject: { type: "user", id: "user-1" },
          context: { localAllowed: false, source: "admin-agents" },
          localAllowed: false,
        },
        isPlatformAdmin: false,
      },
    ]);
  });

  test("400 when csrPem is missing", async () => {
    const app = makeApp("platform_admin", fakeService());
    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("issue endpoint records the canonical Server user id instead of the JWT subject", async () => {
    let issuedBy = "";
    const service = fakeService({
      issueCert: async (input) => {
        issuedBy = input.issuedBy;
        return fakeService().issueCert(input);
      },
    });
    const app = makeApp("platform_admin", service, undefined, {
      jwtSub: "casdoor-opaque-sub",
      principalUserId: "server-user-1",
    });

    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "x" }),
    });

    expect(res.status).toBe(201);
    expect(issuedBy).toBe("server-user-1");
  });

  test("issue endpoint fails closed without a canonical Server user id", async () => {
    let calls = 0;
    const service = fakeService({
      issueCert: async (input) => {
        calls += 1;
        return fakeService().issueCert(input);
      },
    });
    const app = makeApp("platform_admin", service, undefined, { principalUserId: null });

    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "x" }),
    });

    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("SpiceDB platform#manage denial prevents cert issuance", async () => {
    let calls = 0;
    const authz = {
      mode: "enforce",
      requirePermission: async () => {
        throw new AppError(ErrorCode.FORBIDDEN, "Authorization denied", 403);
      },
    } as unknown as AuthzService;
    const service = fakeService({
      issueCert: async (input) => {
        calls += 1;
        return fakeService().issueCert(input);
      },
    });
    const app = makeApp("platform_admin", service, authz);

    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "x" }),
    });

    expect(res.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("400 when body is not JSON", async () => {
    const app = makeApp("platform_admin", fakeService());
    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  test("400 when service rejects malformed CSR", async () => {
    const failing: CertIssuanceService = {
      listCerts: fakeService().listCerts,
      issueCert: async () => {
        throw new Error("CSR signature is invalid");
      },
      revokeCert: async () => undefined,
    };
    const app = makeApp("platform_admin", failing);
    const res = await app.request("/api/admin/agents/agent-7/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "broken" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/CSR/);
  });

  test("forwards agentId from URL param to service (defense in depth)", async () => {
    let captured = "";
    const spy: CertIssuanceService = {
      listCerts: fakeService().listCerts,
      issueCert: async ({ agentId, csrPem, issuedBy }) => {
        captured = agentId;
        expect(csrPem).toBe("CSRBODY");
        expect(issuedBy).toBe("user-1");
        return {
          certPem: "C",
          caCertPem: "CA",
          fingerprintSha256: "0".repeat(64),
          issuedAt: new Date(),
          expiresAt: new Date(),
        };
      },
      revokeCert: async () => undefined,
    };
    const app = makeApp("platform_admin", spy);
    await app.request("/api/admin/agents/agent-zeta/cert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ csrPem: "CSRBODY" }),
    });
    expect(captured).toBe("agent-zeta");
  });

  test("revoke endpoint flips revoked_at", async () => {
    let revoked = "";
    const spy: CertIssuanceService = {
      listCerts: fakeService().listCerts,
      issueCert: fakeService().issueCert,
      revokeCert: async ({ fingerprintSha256 }) => {
        revoked = fingerprintSha256;
      },
    };
    const app = makeApp("platform_admin", spy);
    const fp = "a".repeat(64);
    const res = await app.request(`/api/admin/agents/agent-1/cert/${fp}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(revoked).toBe(fp);
  });

  test("revoke endpoint accepts an audit reason over POST", async () => {
    let captured: unknown = null;
    const spy: CertIssuanceService = {
      listCerts: fakeService().listCerts,
      issueCert: fakeService().issueCert,
      revokeCert: async (input) => {
        captured = input;
      },
    };
    const app = makeApp("platform_admin", spy);
    const fp = "a".repeat(64);
    const res = await app.request(`/api/admin/agents/agent-1/cert/${fp}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "key rotation" }),
    });

    expect(res.status).toBe(200);
    expect(captured).toEqual({
      agentId: "agent-1",
      fingerprintSha256: fp,
      revokedBy: "user-1",
      reason: "key rotation",
    });
  });

  test("revoke endpoint records the canonical Server user id instead of the JWT subject", async () => {
    let revokedBy = "";
    const spy: CertIssuanceService = {
      listCerts: fakeService().listCerts,
      issueCert: fakeService().issueCert,
      revokeCert: async ({ revokedBy: actor }) => {
        revokedBy = actor;
      },
    };
    const app = makeApp("platform_admin", spy, undefined, {
      jwtSub: "casdoor-opaque-sub",
      principalUserId: "server-user-1",
    });
    const fp = "b".repeat(64);

    const res = await app.request(`/api/admin/agents/agent-1/cert/${fp}`, {
      method: "DELETE",
    });

    expect(res.status).toBe(204);
    expect(revokedBy).toBe("server-user-1");
  });
});
