import { afterAll, describe, expect, test } from "bun:test";
import {
  authSessions,
  authzOutbox,
  createPgDb,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { AUTH_REFRESH_COOKIE, AUTH_SESSION_COOKIE } from "../auth/session-cookie";
import { createErrorHandler } from "../middleware/error-handler";
import {
  signSessionRefreshToken,
  signToken,
  verifySessionRefreshToken,
  verifyToken,
} from "../services/auth";
import { createAuthRoutes } from "./auth";

const SECRET = "test-secret-at-least-32-chars-long!!";
const SSO_KEY = "test-sso-wrapping-key-at-least-32-chars!";
const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

const testDb: PgDb = createPgDb(TEST_DB_URL);

function sessionCookieHeader(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${AUTH_SESSION_COOKIE}=`));
  expect(cookie).toBeDefined();
  return cookie?.split(";")[0] ?? "";
}

function sessionCookieHeaders(res: Response): string {
  const cookies = res.headers
    .getSetCookie()
    .filter(
      (header) =>
        header.startsWith(`${AUTH_SESSION_COOKIE}=`) ||
        header.startsWith(`${AUTH_REFRESH_COOKIE}=`),
    )
    .map((header) => header.split(";")[0]);
  expect(cookies).toHaveLength(2);
  return cookies.join("; ");
}

function refreshCookieHeader(res: Response): string {
  const cookie = res.headers
    .getSetCookie()
    .find((header) => header.startsWith(`${AUTH_REFRESH_COOKIE}=`));
  expect(cookie).toBeDefined();
  return cookie?.split(";")[0] ?? "";
}

function tokenFromSessionCookie(cookieHeader: string): string {
  const value = cookieHeader.split("=", 2)[1];
  expect(value).toBeDefined();
  return value ?? "";
}

afterAll(async () => {
  await testDb.delete(users).where(eq(users.email, "user@authtest.example"));
  await testDb.delete(users).where(eq(users.email, "admin@authtest.example"));
});

describe("POST /auth/login", () => {
  function makeApp(options?: { authz: boolean }) {
    const app = new Hono();
    app.onError(createErrorHandler(testLogger));
    const authzEnabled = options?.authz === true;
    const authzRouteOption = authzEnabled
      ? { authz: {} as unknown as Parameters<typeof createAuthRoutes>[2]["authz"] }
      : {};
    app.route(
      "/api",
      createAuthRoutes(SECRET, testDb, { ssoSecretWrappingKey: SSO_KEY, ...authzRouteOption }),
    );
    return app;
  }

  test("issues a valid JWT and upserts user", async () => {
    const res = await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@authtest.example" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string; expiresIn: number };
    expect(body.token).toBeDefined();
    expect(body.expiresIn).toBe(900);
    expect(sessionCookieHeader(res)).toContain(`${AUTH_SESSION_COOKIE}=`);

    const decoded = await verifyToken(body.token, SECRET);
    expect(decoded.email).toBe("user@authtest.example");
    expect(decoded.role).toBe("user");

    // Verify user was upserted into the DB
    const [u] = await testDb
      .select()
      .from(users)
      .where(eq(users.email, "user@authtest.example"))
      .limit(1);
    if (!u) throw new Error("Expected dev login user");
    expect(u?.email).toBe("user@authtest.example");
    expect(decoded.sub).toBe(u.id);
    const memberships = await testDb
      .select({ orgId: userOrgMemberships.orgId })
      .from(userOrgMemberships)
      .where(eq(userOrgMemberships.userId, u.id));
    expect(decoded.orgIds).toEqual(memberships.map(({ orgId }) => orgId));
  });

  test("rejects invalid email", async () => {
    const res = await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
  });

  test("accepts custom role", async () => {
    const res = await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@authtest.example", role: "platform_admin" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    const decoded = await verifyToken(body.token, SECRET);
    expect(decoded.role).toBe("platform_admin");
  });

  test("repeated dev login re-seeds authz outbox for SpiceDB recovery", async () => {
    const repeatEmail = "repeat@authtest.example";
    await testDb.delete(users).where(eq(users.email, repeatEmail));

    const payload = {
      email: repeatEmail,
      role: "platform_admin" as const,
    };

    const first = await makeApp({ authz: true }).request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);

    const [user] = await testDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, repeatEmail))
      .limit(1);
    if (user?.id === undefined) {
      throw new Error("Expected repeat user to be upserted");
    }
    const getOutboxCountForUser = async (userId: string): Promise<number> => {
      const rows = await testDb
        .select()
        .from(authzOutbox)
        .where(and(eq(authzOutbox.subjectType, "user"), eq(authzOutbox.subjectId, userId)));
      return rows.length;
    };

    expect(await getOutboxCountForUser(user.id)).toBeGreaterThan(0);
    await testDb.delete(authzOutbox).where(eq(authzOutbox.subjectId, user.id));

    const second = await makeApp({ authz: true }).request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(200);

    const secondCount = await getOutboxCountForUser(user.id);
    expect(secondCount).toBeGreaterThan(0);

    await testDb.delete(authzOutbox).where(eq(authzOutbox.subjectId, user.id));
    await testDb.delete(users).where(eq(users.email, repeatEmail));
  });

  test("reports and clears cookie-backed sessions", async () => {
    const loginRes = await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@authtest.example" }),
    });
    const cookieHeader = sessionCookieHeaders(loginRes);

    const sessionRes = await makeApp().request("/api/auth/session", {
      headers: { Cookie: cookieHeader },
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      authenticated: boolean;
      user?: { email?: string; role?: string };
    };
    expect(session.authenticated).toBe(true);
    expect(session.user?.email).toBe("user@authtest.example");
    expect(session.user?.role).toBe("user");

    const refreshRes = await makeApp().request("/api/auth/session/refresh", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        Origin: "http://localhost",
      },
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      authenticated: boolean;
      expiresIn?: number;
      user?: { email?: string; role?: string };
    };
    expect(refreshed.authenticated).toBe(true);
    expect(refreshed.expiresIn).toBe(900);
    expect(refreshed.user?.email).toBe("user@authtest.example");
    expect(sessionCookieHeader(refreshRes)).toContain(`${AUTH_SESSION_COOKIE}=`);
    expect(
      refreshRes.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${AUTH_REFRESH_COOKIE}=`)),
    ).toBe(true);
    const refreshedToken = tokenFromSessionCookie(sessionCookieHeader(refreshRes));
    const refreshedPayload = await verifyToken(refreshedToken, SECRET);
    const [sessionUser] = await testDb
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "user@authtest.example"))
      .limit(1);
    if (!sessionUser) throw new Error("Expected refreshed session user");
    const refreshedMemberships = await testDb
      .select({ orgId: userOrgMemberships.orgId })
      .from(userOrgMemberships)
      .where(eq(userOrgMemberships.userId, sessionUser.id));
    expect(refreshedPayload.orgIds).toEqual(refreshedMemberships.map(({ orgId }) => orgId));

    const crossSiteRefresh = await makeApp().request("/api/auth/session/refresh", {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "Sec-Fetch-Site": "cross-site",
      },
    });
    expect(crossSiteRefresh.status).toBe(403);

    const logoutRes = await makeApp().request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: sessionCookieHeaders(refreshRes) },
    });
    expect(logoutRes.status).toBe(200);
    expect(sessionCookieHeader(logoutRes)).toContain(`${AUTH_SESSION_COOKIE}=`);
  });

  test("rotates refresh credentials once and revokes the family on replay", async () => {
    const loginRes = await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@authtest.example" }),
    });
    const originalCookies = sessionCookieHeaders(loginRes);
    const originalRefresh = await verifySessionRefreshToken(
      tokenFromSessionCookie(refreshCookieHeader(loginRes)),
      SECRET,
    );
    expect(originalRefresh.sessionId).toBeDefined();

    const firstRefresh = await makeApp().request("/api/auth/session/refresh", {
      method: "POST",
      headers: { Cookie: originalCookies, Origin: "http://localhost" },
    });
    expect((await firstRefresh.json()) as { authenticated: boolean }).toMatchObject({
      authenticated: true,
    });
    const rotatedCookies = sessionCookieHeaders(firstRefresh);

    const replay = await makeApp().request("/api/auth/session/refresh", {
      method: "POST",
      headers: { Cookie: originalCookies, Origin: "http://localhost" },
    });
    expect((await replay.json()) as { authenticated: boolean }).toEqual({ authenticated: false });

    const afterReplay = await makeApp().request("/api/auth/session/refresh", {
      method: "POST",
      headers: { Cookie: rotatedCookies, Origin: "http://localhost" },
    });
    expect((await afterReplay.json()) as { authenticated: boolean }).toEqual({
      authenticated: false,
    });

    const [session] = await testDb
      .select({ revokedReason: authSessions.revokedReason })
      .from(authSessions)
      .where(eq(authSessions.id, originalRefresh.sessionId ?? ""))
      .limit(1);
    expect(session?.revokedReason).toBe("replay");
  });

  test("logout revokes the current browser session", async () => {
    const loginRes = await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@authtest.example" }),
    });
    const cookies = sessionCookieHeaders(loginRes);
    const refresh = await verifySessionRefreshToken(
      tokenFromSessionCookie(refreshCookieHeader(loginRes)),
      SECRET,
    );

    const logout = await makeApp().request("/api/auth/logout", {
      method: "POST",
      headers: { Cookie: cookies, Origin: "http://localhost" },
    });
    expect(logout.status).toBe(200);

    const [session] = await testDb
      .select({ revokedReason: authSessions.revokedReason })
      .from(authSessions)
      .where(eq(authSessions.id, refresh.sessionId ?? ""))
      .limit(1);
    expect(session?.revokedReason).toBe("logout");
  });

  test("refreshes a session after the access credential has expired", async () => {
    const loginRes = await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@authtest.example" }),
    });

    const refreshRes = await makeApp().request("/api/auth/session/refresh", {
      method: "POST",
      headers: {
        Cookie: refreshCookieHeader(loginRes),
        Origin: "http://localhost",
      },
    });

    expect(refreshRes.status).toBe(200);
    expect(sessionCookieHeader(refreshRes)).toContain(`${AUTH_SESSION_COOKIE}=`);
    expect(refreshCookieHeader(refreshRes)).toContain(`${AUTH_REFRESH_COOKIE}=`);
  });

  test("session resolves role from Server DB while legacy refresh requires a new login", async () => {
    await makeApp().request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@authtest.example", role: "user" }),
    });
    const staleToken = await signToken(
      {
        sub: "user@authtest.example",
        email: "user@authtest.example",
        role: "platform_admin",
      },
      SECRET,
      900,
    );
    const staleRefreshToken = await signSessionRefreshToken(
      {
        sub: "user@authtest.example",
        email: "user@authtest.example",
        role: "platform_admin",
      },
      SECRET,
      3_600,
    );
    const staleCookie = `${AUTH_SESSION_COOKIE}=${staleToken}; ${AUTH_REFRESH_COOKIE}=${staleRefreshToken}`;

    const sessionRes = await makeApp().request("/api/auth/session", {
      headers: { Cookie: staleCookie },
    });
    expect(sessionRes.status).toBe(200);
    const session = (await sessionRes.json()) as {
      authenticated: boolean;
      user?: { email?: string; role?: string };
    };
    expect(session.authenticated).toBe(true);
    expect(session.user?.email).toBe("user@authtest.example");
    expect(session.user?.role).toBe("user");

    const refreshRes = await makeApp().request("/api/auth/session/refresh", {
      method: "POST",
      headers: {
        Cookie: staleCookie,
        Origin: "http://localhost",
      },
    });
    expect(refreshRes.status).toBe(200);
    const refreshed = (await refreshRes.json()) as {
      authenticated: boolean;
    };
    expect(refreshed.authenticated).toBe(false);
    expect(refreshRes.headers.getSetCookie()).toContainEqual(
      expect.stringContaining(`${AUTH_REFRESH_COOKIE}=;`),
    );
  });

  // Security: the passwordless dev login grants a caller-chosen role (incl.
  // super_admin) with no credential — it must be disabled in production. The
  // index.ts bootstrap passes devLoginEnabled = (NODE_ENV !== "production").
  test("is disabled (403) when devLoginEnabled is false", async () => {
    const app = new Hono();
    app.onError(createErrorHandler(testLogger));
    app.route(
      "/api",
      createAuthRoutes(SECRET, testDb, { ssoSecretWrappingKey: SSO_KEY, devLoginEnabled: false }),
    );
    const res = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@authtest.example", role: "super_admin" }),
    });
    expect(res.status).toBe(403);
  });
});
