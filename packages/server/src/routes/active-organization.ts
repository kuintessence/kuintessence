import { authSessions, orgs, type PgDb, userOrgMemberships } from "@kuintessence/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { BoundPrincipal } from "../middleware/principal-binder";

const ActiveOrganizationSchema = z.object({
  organizationId: z.string().uuid().nullable(),
});

const PLATFORM_ROLES = new Set(["platform_admin", "super_admin"]);

function requirePrincipal(c: {
  get: (key: never) => unknown;
}): (BoundPrincipal & { userId: string }) | null {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  return principal?.userId ? { ...principal, userId: principal.userId } : null;
}

export function createActiveOrganizationRoutes(db: PgDb) {
  const routes = new Hono();

  routes.get("/me/active-organization", async (c) => {
    const principal = requirePrincipal(c);
    if (!principal) {
      return c.json({ error: { code: "FORBIDDEN", message: "Principal is not bound" } }, 403);
    }
    const organizations = PLATFORM_ROLES.has(principal.role)
      ? (await db.select({ orgId: orgs.id, name: orgs.name }).from(orgs)).map((organization) => ({
          ...organization,
          role: principal.role,
        }))
      : await db
          .select({
            orgId: userOrgMemberships.orgId,
            name: orgs.name,
            role: userOrgMemberships.role,
          })
          .from(userOrgMemberships)
          .innerJoin(orgs, eq(userOrgMemberships.orgId, orgs.id))
          .where(eq(userOrgMemberships.userId, principal.userId));
    return c.json({
      activeOrganizationId: principal.orgId,
      organizations,
    });
  });

  routes.put("/me/active-organization", async (c) => {
    const principal = requirePrincipal(c);
    if (!principal?.userId) {
      return c.json({ error: { code: "FORBIDDEN", message: "Principal is not bound" } }, 403);
    }
    if (!principal.sessionId) {
      return c.json(
        {
          error: {
            code: "SESSION_CONTEXT_REQUIRED",
            message: "An active browser session is required to select an organization",
          },
        },
        409,
      );
    }
    const body = ActiveOrganizationSchema.parse(await c.req.json());
    if (body.organizationId) {
      const selectableOrganization = PLATFORM_ROLES.has(principal.role)
        ? await db
            .select({ orgId: orgs.id })
            .from(orgs)
            .where(eq(orgs.id, body.organizationId))
            .limit(1)
        : await db
            .select({ orgId: userOrgMemberships.orgId })
            .from(userOrgMemberships)
            .where(
              and(
                eq(userOrgMemberships.userId, principal.userId),
                eq(userOrgMemberships.orgId, body.organizationId),
              ),
            )
            .limit(1);
      if (!selectableOrganization[0]) {
        return c.json(
          {
            error: {
              code: "ACTIVE_ORGANIZATION_FORBIDDEN",
              message: "The selected organization is not available to this user",
            },
          },
          403,
        );
      }
    }
    const [updated] = await db
      .update(authSessions)
      .set({ activeOrgId: body.organizationId, lastUsedAt: new Date() })
      .where(
        and(
          eq(authSessions.id, principal.sessionId),
          eq(authSessions.userId, principal.userId),
          isNull(authSessions.revokedAt),
          gt(authSessions.expiresAt, new Date()),
        ),
      )
      .returning({ id: authSessions.id });
    if (!updated) {
      return c.json(
        { error: { code: "SESSION_EXPIRED", message: "The browser session is no longer active" } },
        401,
      );
    }
    return c.json({ activeOrganizationId: body.organizationId });
  });

  return routes;
}
