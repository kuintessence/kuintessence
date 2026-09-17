import { type PgDb, userOrgMemberships } from "@kuintessence/db";
import {
  AppError,
  ErrorCode,
  hasRole,
  PreferenceSpecSchema,
  type RoleName,
} from "@kuintessence/shared";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { requirePlatformPermission } from "../authz/platform-guard";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { kqValidator } from "../middleware/validator";
import type { PreferenceService } from "../preferences/preference-service";

/**
 * REST endpoints for scheduling preferences.
 *
 * GET  /api/preferences/global           → any authenticated
 * PUT  /api/preferences/global           → super_admin + platform#manage
 * GET  /api/preferences/org/:orgId       → platform_admin or org_admin of that org
 * PUT  /api/preferences/org/:orgId       → platform_admin or org_admin of that org
 * GET  /api/preferences/user/:userId     → platform_admin, org_admin, or the user themselves
 * PUT  /api/preferences/user/:userId     → platform_admin, org_admin, or the user themselves
 */
export interface PreferenceRouteOptions {
  authz?: AuthzService;
}

export function createPreferenceRoutes(
  service: PreferenceService,
  db: PgDb,
  options: PreferenceRouteOptions = {},
) {
  const r = new Hono();

  // ── Global ────────────────────────────────────────────────────────────────

  r.get("/preferences/global", async (c) => {
    const spec = await service.loadGlobal();
    return c.json({ spec: spec ?? null });
  });

  r.put(
    "/preferences/global",
    kqValidator("json", PreferenceSpecSchema, "Invalid preference spec"),
    async (c) => {
      const actorUserId = requireCanonicalSuperAdmin(c);
      await requirePlatformPermission(c, options.authz, "manage", "preferences");
      await service.upsertGlobal(c.req.valid("json"), actorUserId);
      const spec = await service.loadGlobal();
      return c.json({ spec: spec ?? null });
    },
  );

  // ── Org ───────────────────────────────────────────────────────────────────

  r.get("/preferences/org/:orgId", async (c) => {
    const orgId = c.req.param("orgId");
    const user = c.get("user");
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    const localAllowed = canAccessOrgPrefs(user, principal, orgId);
    if (!(await authorizeOrgPreference(c, options.authz, orgId, "view", localAllowed))) {
      throw new AppError(ErrorCode.FORBIDDEN, "Cannot access preferences for this org", 403);
    }
    const spec = await service.loadScoped("org", orgId);
    return c.json({ spec: spec ?? null });
  });

  r.put(
    "/preferences/org/:orgId",
    kqValidator("json", PreferenceSpecSchema, "Invalid preference spec"),
    async (c) => {
      const orgId = c.req.param("orgId");
      const user = c.get("user");
      const principal = c.get("principal" as never) as BoundPrincipal | undefined;
      const localAllowed = canAccessOrgPrefs(user, principal, orgId);
      if (!(await authorizeOrgPreference(c, options.authz, orgId, "manage", localAllowed))) {
        throw new AppError(ErrorCode.FORBIDDEN, "Cannot update preferences for this org", 403);
      }
      await service.upsertScoped("org", orgId, c.req.valid("json"));
      const spec = await service.loadScoped("org", orgId);
      return c.json({ spec: spec ?? null });
    },
  );

  // ── User ──────────────────────────────────────────────────────────────────

  r.get("/preferences/user/:userId", async (c) => {
    const userId = c.req.param("userId");
    const user = c.get("user");
    const principal = c.get("principal" as never) as BoundPrincipal | undefined;
    if (!(await canAccessUserPrefs(user, principal, userId, db))) {
      throw new AppError(ErrorCode.FORBIDDEN, "Cannot access preferences for this user", 403);
    }
    const spec = await service.loadScoped("user", userId);
    return c.json({ spec: spec ?? null });
  });

  r.put(
    "/preferences/user/:userId",
    kqValidator("json", PreferenceSpecSchema, "Invalid preference spec"),
    async (c) => {
      const userId = c.req.param("userId");
      const user = c.get("user");
      const principal = c.get("principal" as never) as BoundPrincipal | undefined;
      if (!(await canAccessUserPrefs(user, principal, userId, db))) {
        throw new AppError(ErrorCode.FORBIDDEN, "Cannot update preferences for this user", 403);
      }
      await service.upsertScoped("user", userId, c.req.valid("json"));
      const spec = await service.loadScoped("user", userId);
      return c.json({ spec: spec ?? null });
    },
  );

  return r;
}

// ─── RBAC helpers ─────────────────────────────────────────────────────────────

function requireCanonicalSuperAdmin(c: Context): string {
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  if (principal?.role !== "super_admin" || !principal.userId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Need super_admin", 403);
  }
  return principal.userId;
}

function canAccessOrgPrefs(
  user: { role: string; email: string },
  principal: BoundPrincipal | undefined,
  orgId: string,
): boolean {
  const role = localPreferenceRole(user, principal);
  if (hasRole(role, "platform_admin")) return true;
  if (hasRole(role, "org_admin")) return principalOrgIds(principal).includes(orgId);
  return false;
}

async function canAccessUserPrefs(
  user: { role: string; email: string },
  principal: BoundPrincipal | undefined,
  userId: string,
  db: PgDb,
): Promise<boolean> {
  const role = localPreferenceRole(user, principal);
  if (hasRole(role, "platform_admin")) return true;
  if (principal?.userId === userId) return true;
  if (!hasRole(role, "org_admin")) return false;
  const callerOrgIds = principalOrgIds(principal);
  if (callerOrgIds.length === 0) return false;
  const targetMemberships = await db
    .select({ orgId: userOrgMemberships.orgId })
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, userId));
  return targetMemberships.some((membership) => callerOrgIds.includes(membership.orgId));
}

export function localPreferenceRole(
  _user: { role: string },
  principal: Pick<BoundPrincipal, "role"> | undefined,
): RoleName {
  return (principal?.role ?? "guest") as RoleName;
}

async function authorizeOrgPreference(
  c: Context,
  authz: AuthzService | undefined,
  orgId: string,
  permission: "view" | "manage",
  localAllowed: boolean,
): Promise<boolean> {
  if (!authz || authz.mode === "off") return localAllowed;
  const principal = c.get("principal" as never) as BoundPrincipal | undefined;
  const user = c.get("user") as { sub: string; email?: string; role: RoleName };
  const subjectId = principal?.userId;
  if (!subjectId) {
    throw new AppError(ErrorCode.FORBIDDEN, "Authorization principal is not bound", 403);
  }
  const check = {
    actorUserId: subjectId,
    actorEmail: principal?.email ?? null,
    resource: { type: "organization", id: orgId },
    permission,
    subject: { type: "user", id: subjectId },
    context: { localAllowed, source: "preferences" },
    localAllowed,
  };
  if (authz.mode === "shadow") {
    await authz.shadowCheck(check);
    return localAllowed;
  }
  try {
    await authz.requirePermission(
      check,
      hasRole(localPreferenceRole(user, principal), "platform_admin"),
    );
    return true;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 403) return false;
    throw err;
  }
}

function principalOrgIds(principal: BoundPrincipal | undefined): string[] {
  const membershipOrgIds =
    principal?.memberships
      .filter((membership) => ["owner", "admin", "operator"].includes(membership.role))
      .map((membership) => membership.orgId) ?? [];
  const orgIds = membershipOrgIds.length > 0 ? membershipOrgIds : (principal?.orgIds ?? []);
  return [...new Set(orgIds)];
}
