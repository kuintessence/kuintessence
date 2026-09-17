/**
 * integration tests for the OIDC routes (login + callback +
 * config-public). Uses the OidcClientImpl seam so no real IdP is needed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  authzOutbox,
  createPgDb,
  type PgDb,
  ssoConfig,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import {
  type OidcClientImpl,
  resetOidcClientImpl,
  setOidcClientImplForTesting,
} from "../auth/oidc";
import { encryptSecret } from "../auth/secret-cipher";
import { AUTH_REFRESH_COOKIE, AUTH_SESSION_COOKIE } from "../auth/session-cookie";
import { isBrowserSessionActive } from "../auth/session-ledger";
import { saveSsoConfig } from "../auth/sso-config-store";
import type { AuthzService } from "../authz/service";
import { createErrorHandler } from "../middleware/error-handler";
import { verifyToken } from "../services/auth";
import { createAuthRoutes, oidcExternalIdentityKey } from "./auth";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const JWT_SECRET = "auth-oidc-test-jwt-secret-32-chars-min!!";
const SSO_WRAP = "auth-oidc-sso-wrapping-key-32-chars-min!";
const TEST_USER_EMAIL = "oidc-cb@authtest.example";
const CHANGED_USER_EMAIL = "oidc-cb-renamed@authtest.example";
const LEGACY_USER_EMAIL = "oidc-cb-legacy@authtest.example";
const FALLBACK_USER_EMAIL = `sub-no-email@idp.example.com`;
const FALLBACK_USER_EMAIL_WITH_PORT = "sub-no-email@casdoor.localhost";

const db: PgDb = createPgDb(TEST_DB_URL);

function makeApp(authz?: AuthzService) {
  const app = new Hono();
  app.onError(createErrorHandler(pino({ level: "silent" })));
  app.route(
    "/api",
    createAuthRoutes(JWT_SECRET, db, {
      ssoSecretWrappingKey: SSO_WRAP,
      webBaseUrl: "/",
      allowInsecureIssuer: true,
      authz,
    }),
  );
  return app;
}

function authTokenFromSetCookie(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${AUTH_SESSION_COOKIE}=`));
  expect(cookie).toBeDefined();
  const raw = cookie?.split(";")[0]?.slice(AUTH_SESSION_COOKIE.length + 1) ?? "";
  return decodeURIComponent(raw);
}

async function clearAll() {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(
      inArray(users.email, [
        TEST_USER_EMAIL,
        CHANGED_USER_EMAIL,
        LEGACY_USER_EMAIL,
        FALLBACK_USER_EMAIL,
        FALLBACK_USER_EMAIL_WITH_PORT,
      ]),
    );
  const userIds = existing.map((row) => row.id);
  if (userIds.length > 0) {
    await db.delete(authzOutbox).where(inArray(authzOutbox.subjectId, userIds));
    await db.delete(userOrgMemberships).where(inArray(userOrgMemberships.userId, userIds));
  }
  await db.delete(ssoConfig).where(eq(ssoConfig.singletonId, "default"));
  await db.delete(users).where(eq(users.email, TEST_USER_EMAIL));
  await db.delete(users).where(eq(users.email, CHANGED_USER_EMAIL));
  await db.delete(users).where(eq(users.email, LEGACY_USER_EMAIL));
  await db.delete(users).where(eq(users.email, FALLBACK_USER_EMAIL));
  await db.delete(users).where(eq(users.email, FALLBACK_USER_EMAIL_WITH_PORT));
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

const STUB_META = () => ({
  issuer: "https://idp.example.com",
  authorization_endpoint: "https://idp.example.com/auth",
  token_endpoint: "https://idp.example.com/token",
  userinfo_endpoint: "https://idp.example.com/userinfo",
  jwks_uri: "https://idp.example.com/jwks",
});

function makeImpl(opts: {
  sub?: string;
  email?: string | null;
  groups?: unknown;
  name?: string | null;
}): OidcClientImpl {
  return {
    discover: async ({ issuerUrl }) => ({
      config: { serverMetadata: () => STUB_META() } as never,
      endpoints: {
        issuer: issuerUrl,
        authorizationEndpoint: "https://idp.example.com/auth",
        tokenEndpoint: "https://idp.example.com/token",
        userinfoEndpoint: "https://idp.example.com/userinfo",
        jwksUri: "https://idp.example.com/jwks",
      },
    }),
    buildAuthUrl: (_cfg, params) =>
      new URL(
        `https://idp.example.com/auth?state=${params.state}&redirect=${encodeURIComponent(
          params.redirectUri,
        )}`,
      ),
    exchangeCode: async () => ({
      accessToken: "at",
      idToken: "idt",
      sub: opts.sub ?? "sub-1",
    }),
    fetchUserInfo: async () => ({
      sub: opts.sub ?? "sub-1",
      email: opts.email === undefined ? TEST_USER_EMAIL : opts.email,
      emailVerified: true,
      name: opts.name === undefined ? "Alice" : opts.name,
      preferredUsername: null,
      rawGroups: opts.groups,
    }),
  };
}

async function seedSso(input: {
  enabled?: boolean;
  groupMapping?: Record<
    string,
    "super_admin" | "platform_admin" | "operator" | "org_admin" | "user" | "guest"
  >;
  autoCreateUsers?: boolean;
  redirectUri?: string;
  issuerUrl?: string;
  providerDisplayName?: string;
  loginWelcomeZh?: string;
  loginWelcomeEn?: string;
}) {
  const ciphertext = await encryptSecret("real-secret", SSO_WRAP);
  await saveSsoConfig(db, {
    enabled: input.enabled ?? true,
    providerType: "oidc",
    providerDisplayName: input.providerDisplayName,
    loginWelcomeZh: input.loginWelcomeZh,
    loginWelcomeEn: input.loginWelcomeEn,
    issuerUrl: input.issuerUrl ?? "https://idp.example.com",
    clientId: "kq-test",
    clientSecretEncrypted: ciphertext,
    redirectUri: input.redirectUri ?? "",
    groupMapping: input.groupMapping ?? {},
    autoCreateUsers: input.autoCreateUsers ?? true,
    updatedBy: "test",
  });
}

describe("GET /auth/oidc/config-public", () => {
  test("returns enabled=false when SSO not configured", async () => {
    const res = await makeApp().request("/api/auth/oidc/config-public");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      providerName: string;
      welcomeMessage: { zh: string; en: string };
    };
    expect(body.enabled).toBe(false);
    expect(body.providerName).toBe("");
    expect(body.welcomeMessage).toEqual({ zh: "", en: "" });
  });

  test("returns enabled=true with configured user-facing metadata and no issuer host", async () => {
    await seedSso({
      providerDisplayName: "Research SSO",
      loginWelcomeZh: "欢迎访问科研平台",
      loginWelcomeEn: "Welcome to the research platform",
    });
    const res = await makeApp().request("/api/auth/oidc/config-public");
    const body = (await res.json()) as {
      enabled: boolean;
      providerName: string;
      welcomeMessage: { zh: string; en: string };
    };
    expect(body.enabled).toBe(true);
    expect(body.providerName).toBe("Research SSO");
    expect(body.providerName).not.toContain("idp.example.com");
    expect(body.welcomeMessage).toEqual({
      zh: "欢迎访问科研平台",
      en: "Welcome to the research platform",
    });
  });

  test("returns enabled=false when sso row is enabled but issuer is empty", async () => {
    await saveSsoConfig(db, {
      enabled: true,
      providerType: "oidc",
      issuerUrl: "",
      clientId: "x",
      clientSecretEncrypted: "",
      redirectUri: "",
      groupMapping: {},
      autoCreateUsers: true,
      updatedBy: "t",
    });
    const res = await makeApp().request("/api/auth/oidc/config-public");
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });
});

describe("GET /auth/oidc/login", () => {
  test("redirects to IdP authorization URL with state cookie", async () => {
    await seedSso({});
    setOidcClientImplForTesting(makeImpl({}));

    const res = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("https://idp.example.com/auth");
    expect(location).toContain("state=");

    const setCookieHeaders = res.headers.getSetCookie();
    const stateCookie = setCookieHeaders.find((h) => h.startsWith("kq_oidc_state="));
    const verifierCookie = setCookieHeaders.find((h) => h.startsWith("kq_oidc_verifier="));
    expect(stateCookie).toBeDefined();
    expect(verifierCookie).toBeDefined();
    expect(stateCookie).toContain("HttpOnly");
    expect(verifierCookie).toContain("HttpOnly");
  });

  test("returns 400 when SSO is not enabled", async () => {
    setOidcClientImplForTesting(makeImpl({}));
    const res = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    expect(res.status).toBe(400);
  });

  test("rejects a CLI callback outside loopback", async () => {
    await seedSso({});
    setOidcClientImplForTesting(makeImpl({}));
    const url =
      "/api/auth/oidc/login?redirect_uri=https%3A%2F%2Fclient.example%2Fcallback&state=1234567890abcdef";
    const res = await makeApp().request(url, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});

describe("GET /auth/oidc/callback", () => {
  test("rejects callback without state cookie", async () => {
    await seedSso({});
    setOidcClientImplForTesting(makeImpl({}));
    const res = await makeApp().request("/api/auth/oidc/callback?code=c&state=s", {
      redirect: "manual",
    });
    expect(res.status).toBe(401);
  });

  test("happy path: signs JWT cookie, upserts user, redirects to web with session metadata", async () => {
    await seedSso({ groupMapping: { admins: "platform_admin" } });
    setOidcClientImplForTesting(makeImpl({ groups: ["admins"] }));

    // Step 1: simulate /login to get state+verifier cookies.
    const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    const location = loginRes.headers.get("Location") ?? "";
    const stateMatch = location.match(/state=([^&]+)/);
    expect(stateMatch).not.toBeNull();
    const state = decodeURIComponent(stateMatch?.[1] ?? "");

    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies
      .map((c) => c.split(";")[0])
      .filter((c) => c?.startsWith("kq_oidc_"))
      .join("; ");
    expect(cookieHeader.length).toBeGreaterThan(0);

    // Step 2: hit the callback with the same state.
    const cbRes = await makeApp().request(
      `/api/auth/oidc/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      {
        redirect: "manual",
        headers: { Cookie: cookieHeader },
      },
    );
    expect(cbRes.status).toBe(302);
    const target = cbRes.headers.get("Location") ?? "";
    const landing = new URL(target, "http://server.test");
    expect(landing.pathname).toBe("/");
    expect(landing.searchParams.get("session")).toBe("cookie");
    expect(landing.searchParams.get("email")).toBe(TEST_USER_EMAIL);
    expect(landing.searchParams.get("expiresIn")).toBe("900");
    expect(landing.searchParams.has("role")).toBe(false);
    expect(landing.searchParams.has("token")).toBe(false);
    const token = authTokenFromSetCookie(cbRes);
    expect(
      cbRes.headers.getSetCookie().some((header) => header.startsWith(`${AUTH_REFRESH_COOKIE}=`)),
    ).toBe(true);

    const decoded = await verifyToken(token, JWT_SECRET);
    expect(decoded.email).toBe(TEST_USER_EMAIL);
    expect(decoded.role).toBe("platform_admin");

    // User row was upserted with externalId.
    const [u] = await db.select().from(users).where(eq(users.email, TEST_USER_EMAIL)).limit(1);
    if (!u) throw new Error("Expected OIDC callback user");
    expect(u?.role).toBe("platform_admin");
    expect(u?.externalId).toBe(oidcExternalIdentityKey("https://idp.example.com", "sub-1"));
    expect(u?.displayName).toBe("Alice");
    expect(decoded.sub).toBe(u.id);
  });

  test("returns a one-time CLI code to loopback and exchanges it for an access token", async () => {
    await seedSso({ groupMapping: { admins: "platform_admin" } });
    setOidcClientImplForTesting(makeImpl({ groups: ["admins"] }));
    const loginApp = makeApp();
    const redirectUri = "http://127.0.0.1:43117/callback";
    const clientState = "cli-state-1234567890abcdef";
    const loginRes = await loginApp.request(
      `/api/auth/oidc/login?redirect_uri=${encodeURIComponent(redirectUri)}&state=${clientState}`,
      { redirect: "manual" },
    );
    const cookieHeader = loginRes.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .filter((cookie) => cookie?.startsWith("kq_oidc_"))
      .join("; ");
    const oidcState = decodeURIComponent(
      loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
    );

    const callback = await loginApp.request(
      `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(oidcState)}`,
      { redirect: "manual", headers: { Cookie: cookieHeader } },
    );
    expect(callback.status).toBe(302);
    expect(
      callback.headers.getSetCookie().some((cookie) => cookie.startsWith("kq_access_token=")),
    ).toBe(false);
    const landing = new URL(callback.headers.get("Location") ?? "http://invalid");
    const code = landing.searchParams.get("code");
    expect(landing.origin + landing.pathname).toBe(redirectUri);
    expect(landing.searchParams.get("state")).toBe(clientState);
    expect(code).toBeTruthy();

    const exchangeBody = { code };
    const exchangeApp = makeApp();
    const exchange = await exchangeApp.request("/api/auth/oidc/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exchangeBody),
    });
    expect(exchange.status).toBe(200);
    const body = (await exchange.json()) as {
      accessToken: string;
      principal: { sub: string; email: string };
    };
    expect(body.principal.email).toBe(TEST_USER_EMAIL);
    const token = await verifyToken(body.accessToken, JWT_SECRET);
    expect(token.role).toBe("platform_admin");
    expect(token.sessionId).toBeDefined();

    const logout = await exchangeApp.request("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${body.accessToken}` },
    });
    expect(logout.status).toBe(200);
    expect(
      await isBrowserSessionActive(db, {
        sessionId: token.sessionId ?? "",
        userId: token.sub,
      }),
    ).toBe(false);

    const replay = await loginApp.request("/api/auth/oidc/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(exchangeBody),
    });
    expect(replay.status).toBe(401);
  });

  test("a normal Web login clears stale CLI flow cookies", async () => {
    await seedSso({});
    setOidcClientImplForTesting(makeImpl({}));
    const res = await makeApp().request("/api/auth/oidc/login", {
      redirect: "manual",
      headers: {
        Cookie:
          "kq_oidc_cli_redirect=http%3A%2F%2F127.0.0.1%3A43117%2Fcallback; kq_oidc_cli_state=stale-cli-state-123456",
      },
    });
    const cookies = res.headers.getSetCookie();
    expect(
      cookies.some(
        (cookie) => cookie.startsWith("kq_oidc_cli_redirect=") && cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
    expect(
      cookies.some(
        (cookie) => cookie.startsWith("kq_oidc_cli_state=") && cookie.includes("Max-Age=0"),
      ),
    ).toBe(true);
  });

  test("updates email by stable externalId and keeps the canonical JWT subject", async () => {
    await seedSso({ groupMapping: {} });

    const completeLogin = async (email: string): Promise<string> => {
      setOidcClientImplForTesting(makeImpl({ sub: "stable-subject", email, groups: [] }));
      const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
      const cookieHeader = loginRes.headers
        .getSetCookie()
        .map((cookie) => cookie.split(";")[0])
        .filter((cookie) => cookie?.startsWith("kq_oidc_"))
        .join("; ");
      const state = decodeURIComponent(
        loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
      );
      const callback = await makeApp().request(
        `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}`,
        { redirect: "manual", headers: { Cookie: cookieHeader } },
      );
      expect(callback.status).toBe(302);
      return authTokenFromSetCookie(callback);
    };

    const firstToken = await completeLogin(TEST_USER_EMAIL);
    const firstDecoded = await verifyToken(firstToken, JWT_SECRET);
    const stableExternalId = oidcExternalIdentityKey("https://idp.example.com", "stable-subject");
    const [firstUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.externalId, stableExternalId))
      .limit(1);
    if (!firstUser) throw new Error("Expected initial external identity");

    const secondToken = await completeLogin(CHANGED_USER_EMAIL);
    const secondDecoded = await verifyToken(secondToken, JWT_SECRET);
    const [updatedUser] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.externalId, stableExternalId))
      .limit(1);

    expect(firstDecoded.sub).toBe(firstUser.id);
    expect(secondDecoded.sub).toBe(firstUser.id);
    expect(updatedUser).toEqual({ id: firstUser.id, email: CHANGED_USER_EMAIL });
  });

  test("migrates a legacy bare subject binding without changing the user id", async () => {
    await seedSso({ groupMapping: {} });
    const [legacyUser] = await db
      .insert(users)
      .values({
        email: LEGACY_USER_EMAIL,
        role: "user",
        externalId: "legacy-subject",
      })
      .returning({ id: users.id });
    if (!legacyUser) throw new Error("Expected legacy OIDC user");

    setOidcClientImplForTesting(
      makeImpl({ sub: "legacy-subject", email: CHANGED_USER_EMAIL, groups: [] }),
    );
    const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    const cookieHeader = loginRes.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .filter((cookie) => cookie?.startsWith("kq_oidc_"))
      .join("; ");
    const state = decodeURIComponent(
      loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
    );
    const callback = await makeApp().request(
      `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { Cookie: cookieHeader } },
    );

    expect(callback.status).toBe(302);
    const decoded = await verifyToken(authTokenFromSetCookie(callback), JWT_SECRET);
    const [migratedUser] = await db
      .select({ id: users.id, email: users.email, externalId: users.externalId })
      .from(users)
      .where(eq(users.id, legacyUser.id))
      .limit(1);
    expect(decoded.sub).toBe(legacyUser.id);
    expect(migratedUser).toEqual({
      id: legacyUser.id,
      email: CHANGED_USER_EMAIL,
      externalId: oidcExternalIdentityKey("https://idp.example.com", "legacy-subject"),
    });
  });

  test("operator group mapping writes platform operator authz outbox rows", async () => {
    await seedSso({ groupMapping: { "kq-operators": "operator" } });
    setOidcClientImplForTesting(makeImpl({ groups: ["kq-operators"] }));

    const loginRes = await makeApp({ mode: "enforce" } as AuthzService).request(
      "/api/auth/oidc/login",
      { redirect: "manual" },
    );
    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies
      .map((c) => c.split(";")[0])
      .filter((c) => c?.startsWith("kq_oidc_"))
      .join("; ");
    const state = decodeURIComponent(
      loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
    );

    const cbRes = await makeApp({ mode: "enforce" } as AuthzService).request(
      `/api/auth/oidc/callback?code=fake-code&state=${encodeURIComponent(state)}`,
      {
        redirect: "manual",
        headers: { Cookie: cookieHeader },
      },
    );
    expect(cbRes.status).toBe(302);
    const token = authTokenFromSetCookie(cbRes);
    const decoded = await verifyToken(token, JWT_SECRET);
    expect(decoded.role).toBe("operator");

    const [u] = await db.select().from(users).where(eq(users.email, TEST_USER_EMAIL)).limit(1);
    expect(u?.role).toBe("operator");
    expect(u?.id).toBeDefined();
    const rows = await db
      .select()
      .from(authzOutbox)
      .where(eq(authzOutbox.subjectId, u?.id ?? ""));
    expect(rows).toContainEqual(
      expect.objectContaining({
        operation: "create",
        resourceType: "platform",
        resourceId: "root",
        relation: "operator",
        subjectType: "user",
      }),
    );
    expect(rows).not.toContainEqual(
      expect.objectContaining({
        operation: "create",
        resourceType: "platform",
        resourceId: "root",
        relation: "admin",
        subjectType: "user",
      }),
    );
  });

  test("defaults to 'user' role when no group matches mapping", async () => {
    await seedSso({ groupMapping: { admins: "platform_admin" } });
    setOidcClientImplForTesting(makeImpl({ groups: ["nope"] }));

    const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies
      .map((c) => c.split(";")[0])
      .filter((c) => c?.startsWith("kq_oidc_"))
      .join("; ");
    const state = decodeURIComponent(
      loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
    );

    const cbRes = await makeApp().request(
      `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { Cookie: cookieHeader } },
    );
    expect(cbRes.status).toBe(302);
    const token = authTokenFromSetCookie(cbRes);
    const decoded = await verifyToken(token, JWT_SECRET);
    expect(decoded.role).toBe("user");
  });

  test("autoCreateUsers=false rejects new identities with 403", async () => {
    await seedSso({
      groupMapping: { admins: "platform_admin" },
      autoCreateUsers: false,
    });
    setOidcClientImplForTesting(makeImpl({ groups: ["admins"] }));

    const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies
      .map((c) => c.split(";")[0])
      .filter((c) => c?.startsWith("kq_oidc_"))
      .join("; ");
    const state = decodeURIComponent(
      loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
    );

    const cbRes = await makeApp().request(
      `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { Cookie: cookieHeader } },
    );
    expect(cbRes.status).toBe(403);
  });

  test("falls back to sub@issuer-host email when IdP doesn't return email", async () => {
    await seedSso({ groupMapping: {} });
    setOidcClientImplForTesting(makeImpl({ sub: "sub-no-email", email: null, groups: [] }));

    const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies
      .map((c) => c.split(";")[0])
      .filter((c) => c?.startsWith("kq_oidc_"))
      .join("; ");
    const state = decodeURIComponent(
      loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
    );

    const cbRes = await makeApp().request(
      `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { Cookie: cookieHeader } },
    );
    expect(cbRes.status).toBe(302);
    const token = authTokenFromSetCookie(cbRes);
    const decoded = await verifyToken(token, JWT_SECRET);
    expect(decoded.email).toBe(FALLBACK_USER_EMAIL);
  });

  test("strips issuer port from fallback email when IdP doesn't return email", async () => {
    await seedSso({ groupMapping: {}, issuerUrl: "http://casdoor.localhost:15180" });
    setOidcClientImplForTesting(makeImpl({ sub: "sub-no-email", email: null, groups: [] }));

    const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies
      .map((c) => c.split(";")[0])
      .filter((c) => c?.startsWith("kq_oidc_"))
      .join("; ");
    const state = decodeURIComponent(
      loginRes.headers.get("Location")?.match(/state=([^&]+)/)?.[1] ?? "",
    );

    const cbRes = await makeApp().request(
      `/api/auth/oidc/callback?code=c&state=${encodeURIComponent(state)}`,
      { redirect: "manual", headers: { Cookie: cookieHeader } },
    );
    expect(cbRes.status).toBe(302);
    const token = authTokenFromSetCookie(cbRes);
    const decoded = await verifyToken(token, JWT_SECRET);
    expect(decoded.email).toBe(FALLBACK_USER_EMAIL_WITH_PORT);
  });

  test("propagates IdP-returned error params as 401", async () => {
    await seedSso({});
    setOidcClientImplForTesting(makeImpl({}));
    // Provide cookies so we get past the missing-state check.
    const loginRes = await makeApp().request("/api/auth/oidc/login", { redirect: "manual" });
    const cookies = loginRes.headers.getSetCookie();
    const cookieHeader = cookies
      .map((c) => c.split(";")[0])
      .filter((c) => c?.startsWith("kq_oidc_"))
      .join("; ");

    const cbRes = await makeApp().request(
      "/api/auth/oidc/callback?error=access_denied&error_description=user_cancelled",
      { redirect: "manual", headers: { Cookie: cookieHeader } },
    );
    expect(cbRes.status).toBe(401);
    const body = (await cbRes.json()) as { error: { message: string } };
    expect(body.error.message).toContain("access_denied");
  });
});
