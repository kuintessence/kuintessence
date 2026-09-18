import {
  agentCerts,
  agents,
  type PgDb,
  softwareOperations,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { decideSpackPolicy } from "@kuintessence/shared";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { z } from "zod";
import type { AuthzService } from "../authz/service";
import { deriveCpScope } from "../middleware/cp-rbac";
import { resolveEffectiveSpackPolicy } from "./operation-service";
import type { SpackDeliveryAccess } from "./spack-material-delivery";

export function createSpackDeliveryAccess(
  db: PgDb,
  authz: Pick<AuthzService, "mode" | "requirePermission" | "shadowCheck">,
): SpackDeliveryAccess {
  return {
    async operation(operationId) {
      const [row] = await db
        .select({
          agentId: softwareOperations.agentId,
          requestedBy: softwareOperations.requestedBy,
          spec: softwareOperations.spec,
          action: softwareOperations.action,
          status: softwareOperations.status,
          providerOrgId: agents.providerOrgId,
        })
        .from(softwareOperations)
        .innerJoin(agents, eq(agents.agentId, softwareOperations.agentId))
        .where(eq(softwareOperations.id, operationId))
        .limit(1);
      if (
        !row?.requestedBy ||
        !z.string().uuid().safeParse(row.requestedBy).success ||
        row.action !== "install" ||
        !["queued", "running"].includes(row.status)
      ) {
        return null;
      }
      const [user] = await db
        .select({ role: users.role, suspended: users.suspended })
        .from(users)
        .where(eq(users.id, row.requestedBy))
        .limit(1);
      if (!user || user.suspended) return null;
      const memberships = await db
        .select({ orgId: userOrgMemberships.orgId, role: userOrgMemberships.role })
        .from(userOrgMemberships)
        .where(eq(userOrgMemberships.userId, row.requestedBy));
      const scope = deriveCpScope(
        {
          sub: row.requestedBy,
          role: user.role,
          orgIds: memberships.map((membership) => membership.orgId),
          memberships,
        },
        { allowEmptyScope: true },
      );
      const localAllowed =
        scope.localAllowed !== false &&
        (scope.isPlatformWide ||
          (row.providerOrgId !== null && scope.orgIds.includes(row.providerOrgId)));
      const check = {
        actorUserId: row.requestedBy,
        resource: { type: "agent", id: row.agentId },
        permission: "operate",
        subject: { type: "user", id: row.requestedBy },
        context: { localAllowed, source: "spack-material-delivery" },
        localAllowed,
      };
      if (authz.mode === "enforce") {
        await authz.requirePermission(check, scope.isPlatformWide);
      } else {
        if (!localAllowed) return null;
        if (authz.mode === "shadow") await authz.shadowCheck(check);
      }
      const policy = await resolveEffectiveSpackPolicy(db, row.agentId);
      if (decideSpackPolicy(row.spec, policy) !== "allow") return null;
      return {
        agentId: row.agentId,
        requestedBy: row.requestedBy,
        providerOrgId: row.providerOrgId,
        spec: row.spec,
      };
    },
    async certificate(agentId, fingerprint) {
      const now = new Date();
      const [row] = await db
        .select({ id: agentCerts.id })
        .from(agentCerts)
        .where(
          and(
            eq(agentCerts.agentId, agentId),
            eq(agentCerts.fingerprintSha256, fingerprint),
            isNull(agentCerts.revokedAt),
            lte(agentCerts.issuedAt, now),
            gt(agentCerts.expiresAt, now),
          ),
        )
        .limit(1);
      return row !== undefined;
    },
  };
}
