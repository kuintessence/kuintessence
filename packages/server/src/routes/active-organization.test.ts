import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  authSessions,
  createPgDb,
  orgs,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { createActiveOrganizationRoutes } from "./active-organization";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const PROVIDER_A = "00000000-0000-4000-8000-00000000c0a1";
const PROVIDER_B = "00000000-0000-4000-8000-00000000c0b2";
const PLATFORM_SESSION = "00000000-0000-4000-8000-00000000c101";
const USER_SESSION = "00000000-0000-4000-8000-00000000c102";
const testLogger = pino({ level: "silent" });

interface TestPrincipal {
  role: string;
  userId: string;
  sessionId: string;
  orgId: string | null;
  orgIds: string[];
  memberships: Array<{ orgId: string; role: string }>;
}

function makeApp(db: PgDb, principal: TestPrincipal) {
  const app = new Hono();
  app.onError(createErrorHandler(testLogger));
  app.use("*", async (c, next) => {
    c.set("principal" as never, {
      sub: principal.userId,
      email: `${principal.role}@active-organization.test`,
      ...principal,
    });
    await next();
  });
  app.route("/api", createActiveOrganizationRoutes(db));
  return app;
}

describe("Active organization routes", () => {
  const db = createPgDb(TEST_DB_URL);
  let platformUserId: string;
  let regularUserId: string;

  beforeAll(async () => {
    await db
      .insert(orgs)
      .values([
        { id: PROVIDER_A, name: "active-org-provider-a" },
        { id: PROVIDER_B, name: "active-org-provider-b" },
      ])
      .onConflictDoNothing();
    const [platformUser] = await db
      .insert(users)
      .values({ email: "platform@active-organization.test", role: "platform_admin" })
      .onConflictDoUpdate({ target: users.email, set: { role: "platform_admin" } })
      .returning({ id: users.id });
    const [regularUser] = await db
      .insert(users)
      .values({ email: "user@active-organization.test", role: "user", orgId: PROVIDER_A })
      .onConflictDoUpdate({ target: users.email, set: { role: "user", orgId: PROVIDER_A } })
      .returning({ id: users.id });
    if (!platformUser || !regularUser)
      throw new Error("Failed to create active organization users");
    platformUserId = platformUser.id;
    regularUserId = regularUser.id;
    await db
      .insert(userOrgMemberships)
      .values({ userId: regularUserId, orgId: PROVIDER_A, role: "member" })
      .onConflictDoNothing();
    const expiresAt = new Date(Date.now() + 60_000);
    await db
      .insert(authSessions)
      .values([
        {
          id: PLATFORM_SESSION,
          userId: platformUserId,
          familyId: "00000000-0000-4000-8000-00000000cf01",
          currentRefreshJtiHash: "active-org-platform-refresh",
          expiresAt,
        },
        {
          id: USER_SESSION,
          userId: regularUserId,
          familyId: "00000000-0000-4000-8000-00000000cf02",
          currentRefreshJtiHash: "active-org-user-refresh",
          expiresAt,
        },
      ])
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await db.delete(authSessions).where(eq(authSessions.id, PLATFORM_SESSION));
    await db.delete(authSessions).where(eq(authSessions.id, USER_SESSION));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, regularUserId));
    await db.delete(users).where(eq(users.email, "platform@active-organization.test"));
    await db.delete(users).where(eq(users.email, "user@active-organization.test"));
    await db.delete(orgs).where(eq(orgs.id, PROVIDER_A));
    await db.delete(orgs).where(eq(orgs.id, PROVIDER_B));
  });

  test("platform administrator can list and select any provider organization", async () => {
    const app = makeApp(db, {
      role: "platform_admin",
      userId: platformUserId,
      sessionId: PLATFORM_SESSION,
      orgId: null,
      orgIds: [],
      memberships: [],
    });
    const listed = await app.request("/api/me/active-organization");
    expect(listed.status).toBe(200);
    const listBody = (await listed.json()) as {
      organizations: Array<{ name: string; orgId: string; role: string }>;
    };
    expect(listBody.organizations).toContainEqual({
      orgId: PROVIDER_B,
      name: "active-org-provider-b",
      role: "platform_admin",
    });

    const selected = await app.request("/api/me/active-organization", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: PROVIDER_B }),
    });
    expect(selected.status).toBe(200);
    const [session] = await db
      .select({ activeOrgId: authSessions.activeOrgId })
      .from(authSessions)
      .where(eq(authSessions.id, PLATFORM_SESSION));
    expect(session?.activeOrgId).toBe(PROVIDER_B);
  });

  test("regular user sees memberships only and cannot select another organization", async () => {
    const app = makeApp(db, {
      role: "user",
      userId: regularUserId,
      sessionId: USER_SESSION,
      orgId: PROVIDER_A,
      orgIds: [PROVIDER_A],
      memberships: [{ orgId: PROVIDER_A, role: "member" }],
    });
    const listed = await app.request("/api/me/active-organization");
    const listBody = (await listed.json()) as { organizations: Array<{ orgId: string }> };
    expect(listBody.organizations.map(({ orgId }) => orgId)).toEqual([PROVIDER_A]);

    const selected = await app.request("/api/me/active-organization", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ organizationId: PROVIDER_B }),
    });
    expect(selected.status).toBe(403);
    expect(await selected.json()).toEqual({
      error: {
        code: "ACTIVE_ORGANIZATION_FORBIDDEN",
        message: "The selected organization is not available to this user",
      },
    });
  });
});
