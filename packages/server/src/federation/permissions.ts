import {
  auditLog,
  federationCapabilities,
  federationPermissionPresets,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import {
  type FederationCapability,
  FederationCapabilitySchema,
  FederationError,
  federationCapabilitySources,
} from "@kuintessence/shared/federation";
import { and, asc, eq, getTableColumns, ilike, inArray, or, sql } from "drizzle-orm";
import type { FederationTransaction } from "./trust-registry";

export {
  type FederationCapability,
  FederationCapabilitySchema,
} from "@kuintessence/shared/federation";
export interface FederationActor {
  userId: string;
  orgId: string;
}

let labDefaultsEnabled = false;

/** Explicitly enabled at startup by experimental deployments, never inferred from a platform role. */
export function configureFederationLabDefaults(enabled: boolean) {
  labDefaultsEnabled = enabled;
}

export function federationLabCapabilities(role: string): FederationCapability[] {
  return role === "super_admin" || role === "platform_admin"
    ? [...FederationCapabilitySchema.options]
    : ["user", "org_admin", "operator"].includes(role)
      ? ["cluster.use"]
      : [];
}

async function requireHumanMember(tx: FederationTransaction, actor: FederationActor) {
  const [member] = await tx
    .select({ id: users.id, role: users.role, membershipId: userOrgMemberships.id })
    .from(users)
    .innerJoin(
      userOrgMemberships,
      and(eq(userOrgMemberships.userId, users.id), eq(userOrgMemberships.orgId, actor.orgId)),
    )
    .where(
      and(eq(users.id, actor.userId), eq(users.suspended, false), eq(users.serviceAccount, false)),
    )
    .for("share", { of: [users, userOrgMemberships] });
  if (!member) throw new FederationError("POLICY_DENIED");
  if (labDefaultsEnabled) {
    const [applied] = await tx
      .insert(federationPermissionPresets)
      .values({ membershipId: member.membershipId, preset: "lab-v1" })
      .onConflictDoNothing()
      .returning();
    if (applied) {
      const capabilities = federationLabCapabilities(member.role);
      if (capabilities.length)
        await tx
          .insert(federationCapabilities)
          .values(
            capabilities.map((capability) => ({
              ...actor,
              capability,
              grantedBy: actor.userId,
            })),
          )
          .onConflictDoNothing();
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.permissions.preset",
        target: member.membershipId,
        diff: { after: { preset: "lab-v1", capabilities } },
      });
    }
  }
}

export async function requireFederationCapability(
  tx: FederationTransaction,
  actor: FederationActor,
  capability: FederationCapability | readonly FederationCapability[],
) {
  await requireHumanMember(tx, actor);
  const allowed =
    typeof capability === "string"
      ? federationCapabilitySources(capability)
      : capability.flatMap(federationCapabilitySources);
  const [grant] = await tx
    .select()
    .from(federationCapabilities)
    .where(
      and(
        eq(federationCapabilities.orgId, actor.orgId),
        eq(federationCapabilities.userId, actor.userId),
        inArray(federationCapabilities.capability, allowed),
      ),
    )
    .for("share");
  if (!grant) throw new FederationError("POLICY_DENIED");
}

/** Cluster users have operation ownership; only explicit business grants have organization scope. */
export async function hasExplicitFederationCapability(
  tx: FederationTransaction,
  actor: FederationActor,
  capability: FederationCapability,
): Promise<boolean> {
  const sources = federationCapabilitySources(capability).filter(
    (source) => source !== "cluster.use",
  );
  if (!sources.length) return false;
  const [row] = await tx
    .select({ capability: federationCapabilities.capability })
    .from(federationCapabilities)
    .where(
      and(
        eq(federationCapabilities.orgId, actor.orgId),
        eq(federationCapabilities.userId, actor.userId),
        inArray(federationCapabilities.capability, sources),
      ),
    )
    .for("share");
  return !!row;
}

/** Called only from the platform permission-management route; never from a peer request. */
export class FederationPermissionService {
  constructor(private readonly db: PgDb) {}

  async list(orgId: string, limit: number, offset: number) {
    return this.db
      .select({
        ...getTableColumns(federationCapabilities),
        email: users.email,
        displayName: users.displayName,
        suspended: users.suspended,
        serviceAccount: users.serviceAccount,
        membershipActive: sql<boolean>`${userOrgMemberships.userId} IS NOT NULL`,
      })
      .from(federationCapabilities)
      .leftJoin(users, eq(users.id, federationCapabilities.userId))
      .leftJoin(
        userOrgMemberships,
        and(
          eq(userOrgMemberships.userId, federationCapabilities.userId),
          eq(userOrgMemberships.orgId, federationCapabilities.orgId),
        ),
      )
      .where(eq(federationCapabilities.orgId, orgId))
      .orderBy(asc(federationCapabilities.userId), asc(federationCapabilities.capability))
      .limit(limit)
      .offset(offset);
  }

  async members(orgId: string, search: string, limit: number, offset: number) {
    const rows = await this.db
      .select({ userId: users.id, email: users.email, displayName: users.displayName })
      .from(users)
      .innerJoin(
        userOrgMemberships,
        and(eq(userOrgMemberships.userId, users.id), eq(userOrgMemberships.orgId, orgId)),
      )
      .where(
        and(
          eq(users.suspended, false),
          eq(users.serviceAccount, false),
          search
            ? or(ilike(users.email, `%${search}%`), ilike(users.displayName, `%${search}%`))
            : undefined,
        ),
      )
      .orderBy(asc(users.email), asc(users.id))
      .limit(limit + 1)
      .offset(offset);
    return { data: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  async current(actor: FederationActor) {
    return this.db.transaction(async (tx) => {
      await requireHumanMember(tx, actor);
      const rows = await tx
        .select({ capability: federationCapabilities.capability })
        .from(federationCapabilities)
        .where(
          and(
            eq(federationCapabilities.orgId, actor.orgId),
            eq(federationCapabilities.userId, actor.userId),
          ),
        )
        .orderBy(asc(federationCapabilities.capability));
      const grants = rows.map((row) => FederationCapabilitySchema.parse(row.capability));
      return {
        ...actor,
        grants,
        effectiveCapabilities: FederationCapabilitySchema.options.filter((capability) =>
          federationCapabilitySources(capability).some(
            (source) =>
              grants.includes(source) &&
              !(capability === "delegation.submit" && source === "cluster.use"),
          ),
        ),
      };
    });
  }

  async set(
    input: FederationActor & { capability: FederationCapability; enabled: boolean },
    grantedBy: string,
  ) {
    await this.db.transaction(async (tx) => {
      try {
        await requireHumanMember(tx, input);
      } catch (error) {
        if (input.enabled || !(error instanceof FederationError) || error.code !== "POLICY_DENIED")
          throw error;
      }
      if (input.enabled) {
        await tx
          .insert(federationCapabilities)
          .values({
            orgId: input.orgId,
            userId: input.userId,
            capability: input.capability,
            grantedBy,
          })
          .onConflictDoNothing();
      } else {
        await tx
          .delete(federationCapabilities)
          .where(
            and(
              eq(federationCapabilities.orgId, input.orgId),
              eq(federationCapabilities.userId, input.userId),
              eq(federationCapabilities.capability, input.capability),
            ),
          );
      }
      await tx.insert(auditLog).values({
        actor: grantedBy,
        orgId: input.orgId,
        action: "federation.capability.set",
        target: input.userId,
        diff: { after: { capability: input.capability, enabled: input.enabled } },
      });
    });
  }
}
