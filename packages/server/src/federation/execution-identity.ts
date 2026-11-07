import { type PgDb, userOrgMemberships, users } from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";

type Transaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];
export type ExecutionIdentity = { orgId: string; userId: string };

export function executionIdentityEligibility() {
  return and(
    eq(users.role, "user"),
    eq(users.serviceAccount, true),
    eq(users.suspended, false),
    eq(userOrgMemberships.role, "member"),
  );
}

export async function requireExecutionIdentity(tx: Transaction, identity: ExecutionIdentity) {
  const [user] = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(
      userOrgMemberships,
      and(eq(userOrgMemberships.userId, users.id), eq(userOrgMemberships.orgId, identity.orgId)),
    )
    .where(and(eq(users.id, identity.userId), executionIdentityEligibility()))
    .for("share", { of: [users, userOrgMemberships] });
  if (!user) throw new FederationError("POLICY_DENIED");
}
