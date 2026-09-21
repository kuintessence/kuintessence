import { eq } from "drizzle-orm";
import type { PgDb } from "./index";
import { userOrgMemberships, users } from "./schema";
import { SpackMaterialLifecycleError } from "./spack-material-lifecycle-state";

export interface SpackMaterialLifecyclePrincipal {
  sub: string;
  role: string;
  orgIds: string[];
}

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

/** Only in-memory authorization may run while canonical identity rows are locked. */
export async function authorizeSpackMaterialPrincipal(
  tx: Transaction,
  subject: string,
  authorize: (principal: SpackMaterialLifecyclePrincipal) => Promise<void>,
) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(subject)) {
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
  }
  const [actor] = await tx
    .select({ sub: users.id, role: users.role, suspended: users.suspended })
    .from(users)
    .where(eq(users.id, subject))
    .for("share");
  if (!actor || actor.suspended) {
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
  }
  const memberships = await tx
    .select({ orgId: userOrgMemberships.orgId })
    .from(userOrgMemberships)
    .where(eq(userOrgMemberships.userId, subject))
    .for("share");
  try {
    await authorize({
      sub: actor.sub,
      role: actor.role,
      orgIds: memberships.map((membership) => membership.orgId),
    });
  } catch (error) {
    if (error instanceof SpackMaterialLifecycleError) throw error;
    throw new SpackMaterialLifecycleError("MATERIAL_LIFECYCLE_FORBIDDEN");
  }
}
