// CP-RBAC middleware — gates `/api/cp/*` routes.
//
// CP (Compute Provider) is a business role overlaid on the technical
// RBAC matrix. A principal qualifies as CP if:
//   - role >= ORG_ADMIN  AND
//   - principal has at least one orgId
//
// SUPER_ADMIN can act as CP for any org (orgIds=['*'] semantics handled
// downstream).
//
// The middleware:
//   1. Reads the JWT principal from c.get('principal') (set by upstream auth)
//   2. Verifies CP eligibility
//   3. Attaches `cpScope = { orgIds, principal }` to the request context
//
// Routes downstream MUST scope every DB query by `cpScope.orgIds` to
// preserve multi-tenant isolation.

import type { MiddlewareHandler } from "hono";

export interface CpScope {
  /** Org ids the CP can operate on. SUPER_ADMIN: pass-through to global. */
  orgIds: string[];
  /** True if the caller has cross-org reach (super_admin / platform_admin). */
  isPlatformWide: boolean;
  /** False when local CP eligibility is intentionally deferred to SpiceDB. */
  localAllowed?: boolean;
  /** True when the local role or membership may change provider state. */
  canManage?: boolean;
  /** Explicitly selected provider organization, when one is active. */
  activeOrganizationId?: string | null;
  /** Original JWT principal. */
  principal: { sub: string; role: string; orgIds?: string[] };
}

export interface PrincipalLike {
  sub: string;
  role: string;
  orgId?: string | null;
  orgIds?: string[];
  memberships?: Array<{ orgId: string; role: string }>;
}

const PLATFORM_ROLES = new Set(["super_admin", "platform_admin"]);
const CP_ELIGIBLE_MEMBERSHIP_ROLES = new Set(["owner", "admin", "operator"]);
const CP_MANAGE_MEMBERSHIP_ROLES = new Set(["owner", "admin"]);

export interface CpRbacOptions {
  allowEmptyScope?: boolean | CpEmptyScopePolicy;
  activeOrganizationId?: string | null;
}

export type CpEmptyScopePolicy = (request: {
  method: string;
  path: string;
  url: string;
}) => boolean;

export class CpRbacError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CpRbacError";
  }
}

/**
 * Pure check function (exported for testing without a Hono context).
 */
export function deriveCpScope(
  principal: PrincipalLike | undefined,
  options: CpRbacOptions = {},
): CpScope {
  if (!principal) {
    throw new CpRbacError(401, "UNAUTHENTICATED", "missing principal");
  }
  const requestedOrganizationId = options.activeOrganizationId?.trim() || null;
  const membershipOrgIds = (principal.memberships ?? [])
    .filter((membership) => CP_ELIGIBLE_MEMBERSHIP_ROLES.has(membership.role))
    .map((membership) => membership.orgId);
  const legacyOrgIds =
    principal.role === "org_admin"
      ? (principal.orgIds ?? (principal.orgId ? [principal.orgId] : []))
      : [];
  const localOrgIds = membershipOrgIds.length > 0 ? [...new Set(membershipOrgIds)] : legacyOrgIds;
  const manageableOrgIds = new Set(
    (principal.memberships ?? [])
      .filter((membership) => CP_MANAGE_MEMBERSHIP_ROLES.has(membership.role))
      .map((membership) => membership.orgId),
  );
  const persistedOrganizationId =
    principal.orgId && localOrgIds.includes(principal.orgId) ? principal.orgId : null;

  if (
    requestedOrganizationId &&
    !PLATFORM_ROLES.has(principal.role) &&
    !localOrgIds.includes(requestedOrganizationId)
  ) {
    throw new CpRbacError(
      403,
      "ACTIVE_ORGANIZATION_FORBIDDEN",
      "selected organization is not available for compute-provider operations",
    );
  }

  if (PLATFORM_ROLES.has(principal.role)) {
    // Platform-wide reach. Specific org filtering is done at query time.
    return {
      orgIds: requestedOrganizationId ? [requestedOrganizationId] : (principal.orgIds ?? []),
      isPlatformWide: !requestedOrganizationId,
      localAllowed: true,
      canManage: true,
      activeOrganizationId: requestedOrganizationId ?? persistedOrganizationId,
      principal: { sub: principal.sub, role: principal.role, orgIds: principal.orgIds },
    };
  }

  const orgIds = requestedOrganizationId
    ? [requestedOrganizationId]
    : persistedOrganizationId
      ? [persistedOrganizationId]
      : localOrgIds;
  const canManage =
    principal.role === "org_admin" || orgIds.some((orgId) => manageableOrgIds.has(orgId));
  if (orgIds.length === 0) {
    if (options.allowEmptyScope) {
      return {
        orgIds: [],
        isPlatformWide: false,
        localAllowed: false,
        canManage: false,
        activeOrganizationId: null,
        principal: { sub: principal.sub, role: principal.role, orgIds: [] },
      };
    }
    throw new CpRbacError(403, "NO_ORG_MEMBERSHIP", "principal has no CP org membership");
  }
  return {
    orgIds,
    isPlatformWide: false,
    localAllowed: true,
    canManage,
    activeOrganizationId: requestedOrganizationId ?? persistedOrganizationId,
    principal: { sub: principal.sub, role: principal.role, orgIds },
  };
}

/**
 * Hono middleware factory. Reads `principal` from the context, attaches
 * `cpScope`, or short-circuits with a JSON error envelope.
 */
export function cpRbac(options: CpRbacOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    let scope: CpScope;
    try {
      const p = c.get("principal" as never) as PrincipalLike | undefined;
      const allowEmptyScope =
        typeof options.allowEmptyScope === "function"
          ? options.allowEmptyScope({ method: c.req.method, path: c.req.path, url: c.req.url })
          : options.allowEmptyScope;
      scope = deriveCpScope(p, {
        ...options,
        allowEmptyScope,
        activeOrganizationId: c.req.header("x-kq-active-organization") ?? undefined,
      });
    } catch (err) {
      if (err instanceof CpRbacError) {
        return c.json(
          {
            error: { code: err.code, message: err.message },
          },
          err.status as 401 | 403,
        );
      }
      throw err;
    }
    c.set("cpScope" as never, scope);
    await next();
  };
}
