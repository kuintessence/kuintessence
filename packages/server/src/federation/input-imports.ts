import { auditLog, federationInputImports, type PgDb, type PgTransaction } from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationError,
  FederationInputFilesSchema,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import { and, asc, eq, lte } from "drizzle-orm";
import { lockCloudWrites, StorageQuotaService } from "../services/storage-quota";
import { federationMaterialDigest } from "./assets";
import type { FederationMaterialExchange } from "./material-exchange";
import type { FederationPreparationService } from "./preparation";

type Import = typeof federationInputImports.$inferSelect;
type Scope = Awaited<ReturnType<FederationPreparationService["materialScope"]>>;

/** No byte effects exist in pending yet; future copy attempts must leave this state atomically. */
export async function retirePendingInputImport(
  tx: PgTransaction,
  reservationId: string,
  reason: FederationError["code"],
  now = new Date(),
) {
  const [row] = await tx
    .select()
    .from(federationInputImports)
    .where(eq(federationInputImports.reservationId, reservationId))
    .for("update");
  if (!row || row.state !== "pending") return;
  await lockCloudWrites(tx, row.ownerId);
  await tx
    .update(federationInputImports)
    .set({ state: "cancelled", reservedBytes: 0, lastError: reason, updatedAt: now })
    .where(eq(federationInputImports.id, row.id));
  await tx.insert(auditLog).values({
    actor: row.ownerId,
    orgId: row.localOrgId,
    action: "federation.input.cancel",
    target: row.id,
    diff: { after: { reason } },
  });
}

/** Receiver-local, task-owned inventory and storage reservation. No file is published here. */
export class FederationInputImports {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
    private readonly exchange: FederationMaterialExchange,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async ensure(reservationId: string) {
    const scope = await this.preparation.materialScope(reservationId);
    if (!scope.request.inputFilesDigest) return undefined;
    const prior = await this.db.transaction(async (tx) => {
      await this.preparation.lockMaterialScope(tx, scope);
      return this.existing(tx, scope);
    });
    if (prior) return prior;
    const received = await this.exchange.inputFiles(reservationId);
    return this.db.transaction(async (tx) => {
      await received.authorize(tx);
      const existing = await this.existing(tx, received.scope);
      if (existing) return existing;
      const { request, identity, saved } = received.scope;
      const manifest = received.manifest;
      const digest = federationMaterialDigest(manifest);
      const members = manifest.inputs.flatMap((input) => input.files);
      const policy = FederationAgreementSchema.parse(saved.agreement.terms).inputPolicy;
      const bytes = members.reduce((sum, file) => sum + file.sizeBytes, 0);
      if (
        !policy ||
        digest !== request.inputFilesDigest ||
        members.length > policy.maxFiles ||
        bytes > policy.maxBytes ||
        members.some((file) => file.sizeBytes > 5 * 1024 ** 4)
      )
        throw new FederationError("POLICY_DENIED");
      await lockCloudWrites(tx, identity.userId);
      await new StorageQuotaService(tx, this.clock).assertCloudWritesAllowed(
        identity.userId,
        [],
        bytes,
      );
      const [row] = await tx
        .insert(federationInputImports)
        .values({
          reservationId,
          localSiteId: this.preparation.localSiteId,
          localOrgId: identity.orgId,
          ownerId: identity.userId,
          manifestDigest: digest,
          manifest,
          state: "pending",
          reservedBytes: bytes,
          expiresAt: new Date(federationExecutionDeadline(request)),
          nextCheckAt: this.clock(),
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: identity.userId,
        orgId: identity.orgId,
        action: "federation.input.receive",
        target: row.id,
        diff: { after: { reservationId, manifestDigest: digest, files: members.length, bytes } },
      });
      await received.authorize(tx);
      return this.summary(row);
    });
  }

  private async existing(tx: PgTransaction, scope: Scope) {
    const [row] = await tx
      .select()
      .from(federationInputImports)
      .where(eq(federationInputImports.reservationId, scope.saved.reservation.id))
      .for("update");
    if (!row) return undefined;
    if (
      row.localSiteId !== this.preparation.localSiteId ||
      row.ownerId !== scope.identity.userId ||
      row.localOrgId !== scope.identity.orgId ||
      row.manifestDigest !== scope.request.inputFilesDigest ||
      !FederationInputFilesSchema.safeParse(row.manifest).success ||
      federationMaterialDigest(row.manifest) !== row.manifestDigest
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (row.state === "cancelled") throw new FederationError("CANCELLATION_REQUESTED");
    if (
      row.reservedBytes !==
        row.manifest.inputs
          .flatMap((input) => input.files)
          .reduce((sum, file) => sum + file.sizeBytes, 0) ||
      row.expiresAt.getTime() !== federationExecutionDeadline(scope.request)
    )
      throw new FederationError("OPERATION_CONFLICT");
    return this.summary(row);
  }

  private summary(row: Import) {
    return {
      importId: row.id,
      reservationId: row.reservationId,
      state: row.state,
      manifestDigest: row.manifestDigest,
      reservedBytes: row.reservedBytes,
    };
  }

  /** Bounded reconciliation releases only unstarted reservations after definite authority loss. */
  async sweep() {
    const rows = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(federationInputImports)
        .where(
          and(
            eq(federationInputImports.localSiteId, this.preparation.localSiteId),
            eq(federationInputImports.state, "pending"),
            lte(federationInputImports.nextCheckAt, this.clock()),
          ),
        )
        .orderBy(asc(federationInputImports.nextCheckAt), asc(federationInputImports.id))
        .limit(8)
        .for("update", { skipLocked: true });
      for (const row of rows)
        await tx
          .update(federationInputImports)
          .set({ nextCheckAt: new Date(this.clock().getTime() + 30_000) })
          .where(eq(federationInputImports.id, row.id));
      return rows;
    });
    for (const row of rows) {
      try {
        const scope = await this.preparation.materialScope(row.reservationId);
        await this.db.transaction(async (tx) => {
          await this.preparation.lockMaterialScope(tx, scope);
          await this.existing(tx, scope);
          await tx
            .update(federationInputImports)
            .set({ lastError: null, updatedAt: this.clock() })
            .where(
              and(
                eq(federationInputImports.id, row.id),
                eq(federationInputImports.state, "pending"),
              ),
            );
        });
      } catch (error) {
        if (
          error instanceof FederationError &&
          [
            "CANCELLATION_REQUESTED",
            "AUTHORIZATION_EXPIRED",
            "UNTRUSTED_IDENTITY",
            "AGREEMENT_UNAVAILABLE",
            "POLICY_DENIED",
            "OPERATION_CONFLICT",
          ].includes(error.code)
        )
          await this.db.transaction((tx) =>
            retirePendingInputImport(tx, row.reservationId, error.code, this.clock()),
          );
        else
          await this.db
            .update(federationInputImports)
            .set({ lastError: "AUTHORIZATION_UNAVAILABLE", updatedAt: this.clock() })
            .where(
              and(
                eq(federationInputImports.id, row.id),
                eq(federationInputImports.state, "pending"),
              ),
            );
      }
    }
  }
}
