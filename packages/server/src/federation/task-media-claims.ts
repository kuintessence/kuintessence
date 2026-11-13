import {
  auditLog,
  federationMediaImportAuthorizations as authorizations,
  federationTaskMediaClaims as claims,
  federationInputAttempts,
  federationInputTransfers,
  federationResultAttempts,
  federationResultTransfers,
  federationMediaImportOperations as operations,
  type PgTransaction,
  federationMediaPackages as packages,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, eq, isNull, ne } from "drizzle-orm";

type Package = typeof packages.$inferSelect;
type Operation = Pick<
  typeof operations.$inferSelect,
  "authorizationId" | "generation" | "requestedBy"
>;

function target(row: Package) {
  if (
    row.manifest.subject.kind === "task-input" &&
    row.taskInputImportId &&
    !row.taskResultImportId
  )
    return {
      input: true,
      importId: row.taskInputImportId,
      condition: eq(claims.taskInputImportId, row.taskInputImportId),
    };
  if (
    row.manifest.subject.kind === "task-result" &&
    row.taskResultImportId &&
    !row.taskInputImportId
  )
    return {
      input: false,
      importId: row.taskResultImportId,
      condition: eq(claims.taskResultImportId, row.taskResultImportId),
    };
  throw new FederationError("OPERATION_CONFLICT");
}

/** The caller first locks and authorizes the original task/import, then the package and operation. */
export async function claimTaskMediaImport(
  tx: PgTransaction,
  row: Package,
  operation: Operation,
  now: Date,
) {
  const selected = target(row);
  const [existing] = await tx
    .select()
    .from(claims)
    .where(and(selected.condition, isNull(claims.releasedAt)))
    .for("update");
  if (
    existing?.authorizationId === operation.authorizationId &&
    existing.generation === operation.generation
  )
    return existing;
  if (existing) {
    const [old] = await tx
      .select({ authorization: authorizations, operation: operations, package: packages })
      .from(authorizations)
      .innerJoin(operations, eq(operations.authorizationId, authorizations.authorizationId))
      .innerJoin(
        packages,
        and(
          eq(packages.localSiteId, authorizations.localSiteId),
          eq(packages.packageId, authorizations.packageId),
        ),
      )
      .where(eq(authorizations.authorizationId, existing.authorizationId));
    if (
      !old ||
      old.operation.generation !== existing.generation ||
      (old.operation.state !== "failed" &&
        !old.authorization.revokedAt &&
        !old.package.revokedAt &&
        old.authorization.expiresAt > now)
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  // No partial old object may be adopted into a replacement package or import generation.
  const attempts = selected.input
    ? await tx
        .select({ generation: federationInputAttempts.generation })
        .from(federationInputAttempts)
        .innerJoin(
          federationInputTransfers,
          eq(federationInputTransfers.id, federationInputAttempts.transferId),
        )
        .where(
          and(
            eq(federationInputTransfers.importId, selected.importId),
            ne(federationInputAttempts.state, "cleaned"),
          ),
        )
        .limit(1)
    : await tx
        .select({ generation: federationResultAttempts.generation })
        .from(federationResultAttempts)
        .innerJoin(
          federationResultTransfers,
          eq(federationResultTransfers.id, federationResultAttempts.transferId),
        )
        .where(
          and(
            eq(federationResultTransfers.importId, selected.importId),
            ne(federationResultAttempts.state, "cleaned"),
          ),
        )
        .limit(1);
  if (attempts.length) throw new FederationError("OPERATION_CONFLICT");
  if (existing) await tx.update(claims).set({ releasedAt: now }).where(eq(claims.id, existing.id));
  const [created] = await tx
    .insert(claims)
    .values({
      taskInputImportId: row.taskInputImportId,
      taskResultImportId: row.taskResultImportId,
      authorizationId: operation.authorizationId,
      generation: operation.generation,
      claimedAt: now,
    })
    .returning();
  if (!created) throw new FederationError("OPERATION_CONFLICT");
  await tx.insert(auditLog).values({
    actor: operation.requestedBy,
    orgId: row.localOrgId,
    action: "federation.media.task_claim",
    target: row.packageId,
    diff: {
      after: {
        authorizationId: operation.authorizationId,
        generation: operation.generation,
        previousAuthorizationId: existing?.authorizationId ?? null,
        previousGeneration: existing?.generation ?? null,
      },
    },
  });
  return created;
}

export async function assertTaskMediaClaim(tx: PgTransaction, row: Package, operation: Operation) {
  const [claim] = await tx
    .select()
    .from(claims)
    .where(
      and(
        target(row).condition,
        eq(claims.authorizationId, operation.authorizationId),
        eq(claims.generation, operation.generation),
        isNull(claims.releasedAt),
      ),
    )
    .for("share");
  if (!claim) throw new FederationError("OPERATION_CONFLICT");
  return claim;
}
