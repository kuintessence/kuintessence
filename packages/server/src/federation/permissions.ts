import {
  auditLog,
  federationCapabilities,
  type PgDb,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { FederationTransaction } from "./trust-registry";

export const FederationCapabilitySchema = z.enum(["agreement.read", "agreement.approve"]);
export type FederationCapability = z.infer<typeof FederationCapabilitySchema>;
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
  capability: FederationCapability,
) {
  await requireHumanMember(tx, actor);
  const allowed =
    capability === "agreement.read" ? ["agreement.read", "agreement.approve"] : [capability];
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
      .select()
      .from(federationCapabilities)
      .where(eq(federationCapabilities.orgId, orgId))
      .orderBy(asc(federationCapabilities.userId), asc(federationCapabilities.capability))
      .limit(limit)
      .offset(offset);
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
