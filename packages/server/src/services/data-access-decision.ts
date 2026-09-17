import { authzOutbox, dataAccessPolicies, dataGrants, type PgDb } from "@kuintessence/db";
import { and, eq, isNull, or } from "drizzle-orm";
import { dataAssetGrantTuples } from "../authz/projection";
import type { AuthzTuple } from "../authz/service";

export interface ActiveDataAccessInput {
  assetId: string;
  versionId?: string;
  actorUserId: string;
  orgIds: string[];
  capability: "view" | "use";
  now?: Date;
}

export async function hasActiveDataAccess(
  db: PgDb,
  input: ActiveDataAccessInput,
): Promise<boolean> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const subject = or(
      and(eq(dataGrants.subjectKind, "user"), eq(dataGrants.subjectId, input.actorUserId)),
      ...input.orgIds.map((orgId) =>
        and(eq(dataGrants.subjectKind, "org"), eq(dataGrants.subjectId, orgId)),
      ),
    );
    const version = input.versionId
      ? or(
          isNull(dataGrants.dataAssetVersionId),
          eq(dataGrants.dataAssetVersionId, input.versionId),
        )
      : isNull(dataGrants.dataAssetVersionId);
    const grants = await tx
      .select()
      .from(dataGrants)
      .where(
        and(
          eq(dataGrants.dataAssetId, input.assetId),
          eq(dataGrants.status, "active"),
          version,
          subject,
        ),
      );
    const policySubject = or(
      and(
        eq(dataAccessPolicies.subjectKind, "user"),
        eq(dataAccessPolicies.subjectId, input.actorUserId),
      ),
      ...input.orgIds.map((orgId) =>
        and(eq(dataAccessPolicies.subjectKind, "org"), eq(dataAccessPolicies.subjectId, orgId)),
      ),
    );
    const policyVersion = input.versionId
      ? or(
          isNull(dataAccessPolicies.dataAssetVersionId),
          eq(dataAccessPolicies.dataAssetVersionId, input.versionId),
        )
      : isNull(dataAccessPolicies.dataAssetVersionId);
    const policies = await tx
      .select()
      .from(dataAccessPolicies)
      .where(
        and(
          eq(dataAccessPolicies.dataAssetId, input.assetId),
          eq(dataAccessPolicies.status, "active"),
          policyVersion,
          policySubject,
        ),
      );

    const expiredGrants = grants.filter(
      (grant) => grant.expiresAt !== null && grant.expiresAt <= now,
    );
    for (const grant of expiredGrants) {
      await tx.update(dataGrants).set({ status: "expired" }).where(eq(dataGrants.id, grant.id));
      await enqueueDeletes(
        tx,
        grant.dataAssetId,
        grant.subjectKind,
        grant.subjectId,
        grant.capabilities,
      );
    }
    const expiredPolicies = policies.filter(
      (policy) => policy.expiresAt !== null && policy.expiresAt <= now,
    );
    for (const policy of expiredPolicies) {
      await tx
        .update(dataAccessPolicies)
        .set({ status: "disabled", updatedAt: now })
        .where(eq(dataAccessPolicies.id, policy.id));
      if (policy.effect === "allow") {
        await enqueueDeletes(
          tx,
          policy.dataAssetId,
          policy.subjectKind,
          policy.subjectId,
          policy.capabilities,
        );
      }
    }

    const activePolicies = policies.filter(
      (policy) => policy.expiresAt === null || policy.expiresAt > now,
    );
    if (
      activePolicies.some(
        (policy) => policy.effect === "deny" && allows(policy.capabilities, input.capability),
      )
    ) {
      return false;
    }
    return (
      grants.some(
        (grant) =>
          grant.startsAt <= now &&
          (grant.expiresAt === null || grant.expiresAt > now) &&
          allows(grant.capabilities, input.capability),
      ) ||
      activePolicies.some(
        (policy) => policy.effect === "allow" && allows(policy.capabilities, input.capability),
      )
    );
  });
}

function allows(capabilities: string[], requested: "view" | "use"): boolean {
  if (requested === "view") {
    return capabilities.some((capability) =>
      ["view", "use", "download", "derive", "manage"].includes(capability),
    );
  }
  return capabilities.some((capability) =>
    ["use", "download", "derive", "manage"].includes(capability),
  );
}

type DbTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

async function enqueueDeletes(
  tx: DbTransaction,
  assetId: string,
  subjectKind: string,
  subjectId: string,
  capabilities: string[],
): Promise<void> {
  const tuples = dataAssetGrantTuples({
    assetId,
    subjectKind,
    subjectId,
    capabilities,
    operation: "delete",
  });
  await insertOutbox(tx, tuples);
}

async function insertOutbox(tx: DbTransaction, tuples: AuthzTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  await tx.insert(authzOutbox).values(
    tuples.map((tuple) => ({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    })),
  );
}
