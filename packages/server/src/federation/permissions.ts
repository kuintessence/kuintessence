import {
  auditLog,
  federationCapabilities,
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

async function requireHumanMember(tx: FederationTransaction, actor: FederationActor) {
  const [member] = await tx
    .select({ id: users.id })
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
          federationCapabilitySources(capability).some((source) => grants.includes(source)),
        ),
      };
    });
  }

  async set(
    input: FederationActor & { capability: FederationCapability; enabled: boolean },
    grantedBy: string,
  ) {
    await this.db.transaction(async (tx) => {
      if (input.enabled) {
        await requireHumanMember(tx, input);
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
