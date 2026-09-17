/**
 * admin SSO config route tests (PRD F1.1).
 *
 * Covers:
 *   - GET /admin/sso/config: RBAC, redacted secret, defaults when no row
 *   - PUT /admin/sso/config: RBAC, validation, encrypted-at-rest, audit log,
 *     keep-existing-secret on omitted clientSecret + redacted placeholder
 *   - POST /admin/sso/test: RBAC, validation, success/error envelope
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { auditLog, createPgDb, type PgDb, ssoConfig } from "@kuintessence/db";
import { SSO_SECRET_REDACTED } from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import {
  type OidcClientImpl,
  resetOidcClientImpl,
  setOidcClientImplForTesting,
} from "../auth/oidc";
import { decryptSecret } from "../auth/secret-cipher";
import { loadSsoConfig } from "../auth/sso-config-store";
import type { AuthzCheck, AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { createAdminSsoRoutes } from "./admin-sso";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const SECRET_KEY = "test-sso-wrapping-key-32-chars-long-or-more!!";

const db: PgDb = createPgDb(TEST_DB_URL);

function makeApp(
  role: string,
  options: {
    authz?: AuthzService;
    jwtSub?: string;
    principalRole?: string | null;
    principalUserId?: string | null;
  } = {},
) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.use("*", async (c, next) => {
    const sub = options.jwtSub ?? `${role}@sso-routes.test`;
    c.set("user" as never, {
      sub,
      role,
      email: `${role}@sso-routes.test`,
    });
    const principalUserId =
      options.principalUserId === undefined ? `${role}-sso-user` : options.principalUserId;
    if (principalUserId) {
      c.set("principal" as never, {
        sub,
        role: options.principalRole === undefined ? role : options.principalRole,
        email: `${role}@sso-routes.test`,
        userId: principalUserId,
        orgId: null,
        orgIds: [],
        memberships: [],
      });
    }
    await next();
  });
  app.route(
    "/api",
    createAdminSsoRoutes(db, {
      secretWrappingKey: SECRET_KEY,
      authz: options.authz,
    }),
  );
  return app;
}

async function clearAll() {
  await db.delete(ssoConfig).where(eq(ssoConfig.singletonId, "default"));
  await db.delete(auditLog).where(eq(auditLog.action, "sso.config.update"));
  await db.delete(auditLog).where(eq(auditLog.action, "sso.config.test"));
}

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
});

afterEach(() => {
  resetOidcClientImpl();
});

describe("createAdminSsoRoutes — constructor", () => {
  test("rejects too-short wrapping key", () => {
    expect(() => createAdminSsoRoutes(db, { secretWrappingKey: "short" })).toThrow(/at least 32/);
  });
});

describe("GET /admin/sso/config", () => {
  test("rejects regular user with 403", async () => {
    const res = await makeApp("user").request("/api/admin/sso/config");
    expect(res.status).toBe(403);
  });

  test("rejects org_admin with 403", async () => {
    const res = await makeApp("org_admin").request("/api/admin/sso/config");
    expect(res.status).toBe(403);
  });

  test("returns defaults when no config row exists", async () => {
    const res = await makeApp("platform_admin").request("/api/admin/sso/config");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body.providerType).toBe("oidc");
    expect(body.providerDisplayName).toBe("");
    expect(body.loginWelcomeZh).toBe("");
    expect(body.loginWelcomeEn).toBe("");
    expect(body.issuerUrl).toBe("");
    expect(body.clientId).toBe("");
    expect(body.clientSecret).toBe("");
    expect(body.groupMapping).toEqual({});
    expect(body.autoCreateUsers).toBe(true);
  });

  test("SpiceDB platform#view can authorize a non-platform bound user", async () => {
    const calls: Array<AuthzCheck & { localAllowed: boolean }> = [];
    const authz = {
      mode: "enforce",
      requirePermission: async (check: AuthzCheck) => {
        calls.push(check as AuthzCheck & { localAllowed: boolean });
      },
    } as unknown as AuthzService;

    const res = await makeApp("user", { authz, principalUserId: "sso-user-1" }).request(
      "/api/admin/sso/config",
    );

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      {
        actorUserId: "sso-user-1",
        actorEmail: "user@sso-routes.test",
        resource: { type: "platform", id: "root" },
        permission: "view",
        subject: { type: "user", id: "sso-user-1" },
        context: { localAllowed: false, source: "admin-sso" },
        localAllowed: false,
      },
    ]);
  });

  test("does not trust JWT platform_admin without a bound principal", async () => {
    const res = await makeApp("platform_admin", { principalUserId: null }).request(
      "/api/admin/sso/config",
    );

    expect(res.status).toBe(403);
  });

  test("redacts client_secret on read after a save", async () => {
    await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        providerDisplayName: "Research SSO",
        loginWelcomeZh: "欢迎访问科研平台",
        loginWelcomeEn: "Welcome to the research platform",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "real-secret",
        redirectUri: "https://kq.example.com/api/auth/oidc/callback",
        groupMapping: {},
        autoCreateUsers: true,
      }),
    });

    const res = await makeApp("platform_admin").request("/api/admin/sso/config");
    const body = (await res.json()) as {
      clientSecret: string;
      providerDisplayName: string;
      loginWelcomeZh: string;
      loginWelcomeEn: string;
    };
    expect(body.clientSecret).toBe(SSO_SECRET_REDACTED);
    expect(body.providerDisplayName).toBe("Research SSO");
    expect(body.loginWelcomeZh).toBe("欢迎访问科研平台");
    expect(body.loginWelcomeEn).toBe("Welcome to the research platform");
  });
});

describe("PUT /admin/sso/config", () => {
  test("rejects regular user", async () => {
    const res = await makeApp("user").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true, issuerUrl: "https://idp", clientId: "k" }),
    });
    expect(res.status).toBe(403);
  });

  test("validates body — bad URL", async () => {
    const res = await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        issuerUrl: "definitely not a url",
        clientId: "kq",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("encrypts client_secret at rest (round-trip via cipher)", async () => {
    const res = await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "the-real-secret",
        redirectUri: "https://kq.example.com/api/auth/oidc/callback",
        groupMapping: { admins: "platform_admin" },
        autoCreateUsers: true,
      }),
    });
    expect(res.status).toBe(200);

    const stored = await loadSsoConfig(db);
    expect(stored.clientSecretEncrypted).not.toBe("the-real-secret");
    expect(stored.clientSecretEncrypted.length).toBeGreaterThan(0);
    const decrypted = await decryptSecret(stored.clientSecretEncrypted, SECRET_KEY);
    expect(decrypted).toBe("the-real-secret");
  });

  test("response redacts secret", async () => {
    const res = await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "x",
        redirectUri: "",
        groupMapping: {},
        autoCreateUsers: true,
      }),
    });
    const body = (await res.json()) as { clientSecret: string };
    expect(body.clientSecret).toBe(SSO_SECRET_REDACTED);
  });

  test("omitting clientSecret preserves the existing encrypted blob", async () => {
    // First save with a secret.
    await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "first-secret",
        redirectUri: "",
        groupMapping: {},
        autoCreateUsers: true,
      }),
    });
    const before = await loadSsoConfig(db);
    expect(before.clientSecretEncrypted.length).toBeGreaterThan(0);
    const beforeBlob = before.clientSecretEncrypted;

    // Second save WITHOUT clientSecret field — should not rotate.
    await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: false,
        providerType: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        redirectUri: "",
        groupMapping: {},
        autoCreateUsers: true,
      }),
    });
    const after = await loadSsoConfig(db);
    expect(after.clientSecretEncrypted).toBe(beforeBlob);
    expect(after.enabled).toBe(false);
  });

  test("redacted placeholder also preserves existing secret", async () => {
    await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "first-secret",
        redirectUri: "",
        groupMapping: {},
        autoCreateUsers: true,
      }),
    });
    const before = await loadSsoConfig(db);
    const beforeBlob = before.clientSecretEncrypted;

    await makeApp("platform_admin").request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: SSO_SECRET_REDACTED,
        redirectUri: "",
        groupMapping: {},
        autoCreateUsers: true,
      }),
    });
    const after = await loadSsoConfig(db);
    expect(after.clientSecretEncrypted).toBe(beforeBlob);
  });

  test("writes canonical actor and audit log entry; secretRotated flag reflects rotation", async () => {
    const actorUserId = "00000000-0000-4000-8000-00000000c001";
    await makeApp("platform_admin", {
      jwtSub: "casdoor-opaque-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/sso/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        providerType: "oidc",
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "first",
        redirectUri: "",
        groupMapping: { admins: "platform_admin" },
        autoCreateUsers: true,
      }),
    });
    const stored = await loadSsoConfig(db);
    expect(stored.updatedBy).toBe(actorUserId);
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "sso.config.update"));
    expect(entries.length).toBeGreaterThan(0);
    const latest = entries[entries.length - 1];
    expect(latest?.actor).toBe(actorUserId);
    const diff = latest?.diff as {
      after?: { secretRotated?: boolean; groupMappingKeys?: string[] };
    };
    expect(diff.after?.secretRotated).toBe(true);
    expect(diff.after?.groupMappingKeys).toEqual(["admins"]);
  });
});

describe("POST /admin/sso/test", () => {
  test("rejects regular user", async () => {
    const res = await makeApp("user").request("/api/admin/sso/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ issuerUrl: "https://idp.example.com", clientId: "kq" }),
    });
    expect(res.status).toBe(403);
  });

  test("returns discovered endpoints on success", async () => {
    const fake: OidcClientImpl = {
      discover: async () => ({
        config: {
          serverMetadata: () => ({
            issuer: "https://idp.example.com",
            authorization_endpoint: "https://idp.example.com/auth",
            token_endpoint: "https://idp.example.com/token",
            userinfo_endpoint: "https://idp.example.com/userinfo",
            jwks_uri: "https://idp.example.com/jwks",
          }),
        } as never,
        endpoints: {
          issuer: "https://idp.example.com",
          authorizationEndpoint: "https://idp.example.com/auth",
          tokenEndpoint: "https://idp.example.com/token",
          userinfoEndpoint: "https://idp.example.com/userinfo",
          jwksUri: "https://idp.example.com/jwks",
        },
      }),
      buildAuthUrl: () => new URL("https://idp.example.com/auth"),
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    };
    setOidcClientImplForTesting(fake);

    const res = await makeApp("platform_admin").request("/api/admin/sso/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "x",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.issuer).toBe("https://idp.example.com");
    expect(body.tokenEndpoint).toBe("https://idp.example.com/token");
    expect(body.error).toBeNull();
  });

  test("returns error envelope when discovery fails", async () => {
    setOidcClientImplForTesting({
      discover: async () => {
        throw new Error("ENOTFOUND idp.example.com");
      },
      buildAuthUrl: () => new URL("https://x/"),
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    });

    const res = await makeApp("platform_admin").request("/api/admin/sso/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.error).toContain("ENOTFOUND");
  });

  test("test endpoint does NOT persist a config row", async () => {
    setOidcClientImplForTesting({
      discover: async () => ({
        config: { serverMetadata: () => ({ issuer: "https://i" }) } as never,
        endpoints: {
          issuer: "https://i",
          authorizationEndpoint: null,
          tokenEndpoint: null,
          userinfoEndpoint: null,
          jwksUri: null,
        },
      }),
      buildAuthUrl: () => new URL("https://x/"),
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    });
    await makeApp("platform_admin").request("/api/admin/sso/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "x",
      }),
    });
    const stored = await loadSsoConfig(db);
    expect(stored.issuerUrl).toBe(""); // still default
  });

  test("writes canonical audit actor for the probe", async () => {
    setOidcClientImplForTesting({
      discover: async () => ({
        config: { serverMetadata: () => ({ issuer: "https://i" }) } as never,
        endpoints: {
          issuer: "https://i",
          authorizationEndpoint: null,
          tokenEndpoint: null,
          userinfoEndpoint: null,
          jwksUri: null,
        },
      }),
      buildAuthUrl: () => new URL("https://x/"),
      exchangeCode: async () => ({ accessToken: "", idToken: null, sub: null }),
      fetchUserInfo: async () => ({
        sub: "",
        email: null,
        emailVerified: null,
        name: null,
        preferredUsername: null,
        rawGroups: null,
      }),
    });
    const actorUserId = "00000000-0000-4000-8000-00000000c002";
    await makeApp("platform_admin", {
      jwtSub: "casdoor-opaque-sub",
      principalUserId: actorUserId,
    }).request("/api/admin/sso/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        issuerUrl: "https://idp.example.com",
        clientId: "kq",
        clientSecret: "x",
      }),
    });
    const entries = await db.select().from(auditLog).where(eq(auditLog.action, "sso.config.test"));
    expect(entries.length).toBeGreaterThan(0);
    const latest = entries[entries.length - 1];
    expect(latest?.actor).toBe(actorUserId);
  });
});
