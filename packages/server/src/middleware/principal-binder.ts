// Principal binder.
//
// The auth middleware (`auth.ts`) fills `c.var.user` with the JWT payload.
// Downstream consumers need a richer principal with canonical user id,
// Server-local role, and organization memberships. This middleware looks up the
// DB user row by canonical UUID sub when available, otherwise by email, and
// writes a normalised `principal` onto the Hono context.
//
// Lookup is per-request and intentionally simple: the JWT already gates
// authentication, this is a tiny supplemental query. A future cache layer
// can be added without changing the consumer surface.

import {
  authSessions,
  type PgDb,
  userCapabilities,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { recordIdentityFallback } from "../observability/identity-fallback";
import type { TokenPayload } from "../services/auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLATFORM_ROLES = new Set(["platform_admin", "super_admin"]);

export type OrgMembershipRole = "owner" | "admin" | "operator" | "member" | "viewer";

export interface BoundOrgMembership {
  orgId: string;
  role: OrgMembershipRole;
}

export interface BoundPrincipal {
  sub: string;
  role: string;
  email: string;
  userId: string | null;
  sessionId?: string | null;
  orgId: string | null;
  orgIds: string[];
  memberships: BoundOrgMembership[];
  capabilities: string[];
}

export const AUDIT_READONLY_CAPABILITY = "audit_readonly";

export function hasAuditReadonlyCapability(
  principal: Pick<BoundPrincipal, "capabilities"> | { capabilities?: string[] } | undefined,
): boolean {
  return principal?.capabilities?.includes(AUDIT_READONLY_CAPABILITY) ?? false;
}

export function principalActorLookupKey(user: Pick<TokenPayload, "sub" | "email">): string {
  return UUID_RE.test(user.sub) ? user.sub : user.email;
}

export function resolveActiveOrganization(
  role: string,
  sessionOrgId: string | null,
  membershipOrgIds: readonly string[],
): string | null {
  if (!sessionOrgId) return null;
  return PLATFORM_ROLES.has(role) || membershipOrgIds.includes(sessionOrgId) ? sessionOrgId : null;
}

export function principalBinder(db: PgDb): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get("user") as TokenPayload | undefined;
    if (user) {
      let userId: string | null = null;
      let role = "guest";
      let email = user.email;
      let memberships: BoundOrgMembership[] = [];
      let capabilities: string[] = [];
      let sessionOrgId: string | null = null;
      try {
        if (!UUID_RE.test(user.sub)) {
          recordIdentityFallback("rest_principal");
        }
        const lookupKey = principalActorLookupKey(user);
        const [row] = await db
          .select({ id: users.id, role: users.role, email: users.email })
          .from(users)
          .where(UUID_RE.test(lookupKey) ? eq(users.id, lookupKey) : eq(users.email, lookupKey))
          .limit(1);
        userId = row?.id ?? null;
        role = row?.role ?? "guest";
        email = row?.email ?? user.email;
        if (userId) {
          const sessionRows =
            user.sessionId && UUID_RE.test(user.sessionId)
              ? db
                  .select({ activeOrgId: authSessions.activeOrgId })
                  .from(authSessions)
                  .where(
                    and(
                      eq(authSessions.id, user.sessionId),
                      eq(authSessions.userId, userId),
                      isNull(authSessions.revokedAt),
                      gt(authSessions.expiresAt, new Date()),
                    ),
                  )
                  .limit(1)
              : Promise.resolve([]);
          const [rows, capabilityRows, activeSessionRows] = await Promise.all([
            db
              .select({ orgId: userOrgMemberships.orgId, role: userOrgMemberships.role })
              .from(userOrgMemberships)
              .where(eq(userOrgMemberships.userId, userId)),
            db
              .select({ capability: userCapabilities.capability })
              .from(userCapabilities)
              .where(eq(userCapabilities.userId, userId)),
            sessionRows,
          ]);
          memberships = rows.map((membership) => ({
            orgId: membership.orgId,
            role: membership.role as OrgMembershipRole,
          }));
          capabilities = capabilityRows.map((capability) => capability.capability);
          sessionOrgId = activeSessionRows[0]?.activeOrgId ?? null;
        }
      } catch {
        // Lookup failure (transient DB hiccup) shouldn't crash the request —
        // the consumer middleware (cp-rbac) will reject if org membership is required.
        userId = null;
        role = "guest";
        email = user.email;
        memberships = [];
        capabilities = [];
      }
      const orgIds = [...new Set(memberships.map((membership) => membership.orgId))];
      const activeOrgId = resolveActiveOrganization(role, sessionOrgId, orgIds);
      const principal: BoundPrincipal = {
        sub: user.sub,
        role,
        email,
        userId,
        sessionId: user.sessionId ?? null,
        orgId: activeOrgId,
        orgIds,
        memberships,
        capabilities,
      };
      c.set("principal" as never, principal);
    }
    await next();
  };
}
