import {
  auditLog,
  federationInputAttempts,
  federationInputImports,
  federationInputTransfers,
  netdriveFiles,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationAgreementSchema,
  FederationError,
  FederationInputFilesSchema,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import { and, asc, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { lockCloudWrites, StorageQuotaService } from "../services/storage-quota";
import { federationMaterialDigest } from "./assets";
import { renewTaskCompletion } from "./completion-capacity";
import type { FederationMaterialExchange } from "./material-exchange";
import type { FederationPreparationService } from "./preparation";
import type { FederationStorageGuard } from "./storage-capacity";

type Import = typeof federationInputImports.$inferSelect;
type Scope = Awaited<ReturnType<FederationPreparationService["materialScope"]>>;

/** Fences current attempts even after authority is revoked; cleanup alone releases their quota. */
export async function cancelFederationInputImport(
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
  if (!row || row.state === "cancelled") return;
  const members = tx
    .select({ id: federationInputTransfers.id })
    .from(federationInputTransfers)
    .where(eq(federationInputTransfers.importId, row.id));
  if (row.state === "available") {
    await lockCloudWrites(tx, row.ownerId);
    const published = await tx
      .select({ member: federationInputTransfers, attempt: federationInputAttempts })
      .from(federationInputTransfers)
      .innerJoin(
        federationInputAttempts,
        eq(federationInputAttempts.transferId, federationInputTransfers.id),
      )
      .where(
        and(
          eq(federationInputTransfers.importId, row.id),
          eq(federationInputAttempts.state, "available"),
        ),
      );
    // Hide only the original published versions; a later unrelated file must not be overwritten.
    for (const { member, attempt } of published)
      await tx
        .update(netdriveFiles)
        .set({ deletedAt: now })
        .where(
          and(
            eq(netdriveFiles.id, member.id),
            eq(netdriveFiles.ownerId, row.ownerId),
            eq(netdriveFiles.storageKey, attempt.storageKey),
            eq(netdriveFiles.storageVersionId, attempt.destinationVersionId ?? ""),
            isNull(netdriveFiles.deletedAt),
          ),
        );
    const bytes = row.manifest.inputs
      .flatMap((input) => input.files)
      .reduce((sum, file) => sum + file.sizeBytes, 0);
    await tx
      .update(federationInputImports)
      .set({ state: "cancelling", reservedBytes: bytes })
      .where(eq(federationInputImports.id, row.id));
  }
  await tx
    .update(federationInputAttempts)
    .set({ state: "cleanup_pending", updatedAt: now })
    .where(
      and(
        inArray(federationInputAttempts.transferId, members),
        ne(federationInputAttempts.state, "cleaned"),
      ),
    );
  await tx
    .update(federationInputTransfers)
    .set({ state: "cancelled", updatedAt: now })
    .where(eq(federationInputTransfers.importId, row.id));
  await tx
    .update(federationInputImports)
    .set({ state: "cancelling", lastError: reason, updatedAt: now })
    .where(eq(federationInputImports.id, row.id));
  await finishCancelledInputImport(tx, { ...row, state: "cancelling" }, now);
  if (row.state === "cancelling") return;
  await tx.insert(auditLog).values({
    actor: row.ownerId,
    orgId: row.localOrgId,
    action: "federation.input.cancel",
    target: row.id,
    diff: { after: { reason } },
  });
}

/** Requires the import lock; unknown or incomplete storage effects retain the full reservation. */
export async function finishCancelledInputImport(tx: PgTransaction, row: Import, now: Date) {
  if (row.state !== "cancelling") return;
  const [remaining] = await tx
    .select({ generation: federationInputAttempts.generation })
    .from(federationInputAttempts)
    .innerJoin(
      federationInputTransfers,
      eq(federationInputTransfers.id, federationInputAttempts.transferId),
    )
    .where(
      and(
        eq(federationInputTransfers.importId, row.id),
        ne(federationInputAttempts.state, "cleaned"),
      ),
    )
    .limit(1);
  if (remaining) return;
  await lockCloudWrites(tx, row.ownerId);
  await tx
    .update(federationInputImports)
    .set({ state: "cancelled", reservedBytes: 0, updatedAt: now })
    .where(eq(federationInputImports.id, row.id));
}

/** Receiver-local, task-owned inventory and storage reservation. */
export class FederationInputImports {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
    private readonly exchange: FederationMaterialExchange,
    private readonly clock: () => Date = () => new Date(),
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) {}

  async ensure(reservationId: string) {
    const scope = await this.preparation.materialScope(reservationId);
    if (!scope.request.inputFilesDigest) return undefined;
    const prior = await this.db.transaction(async (tx) => {
      await this.preparation.lockMaterialScope(tx, scope);
      return this.existing(tx, scope);
    });
    if (prior) return this.summary(prior);
    const received = await this.exchange.inputFiles(reservationId);
    return this.db.transaction(async (tx) => {
      await received.authorize(tx);
      const existing = await this.existing(tx, received.scope);
      if (existing) return this.summary(existing);
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
      await renewTaskCompletion(tx, request.recipientSiteId, request, this.storageGuard);
      await received.authorize(tx);
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
          nextPublishAt: this.clock(),
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .returning();
      if (!row) throw new FederationError("OPERATION_CONFLICT");
      await this.members(tx, row);
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
    if (["cancelling", "cancelled"].includes(row.state))
      throw new FederationError("CANCELLATION_REQUESTED");
    if (
      row.reservedBytes !==
        (row.state === "available"
          ? 0
          : row.manifest.inputs
              .flatMap((input) => input.files)
              .reduce((sum, file) => sum + file.sizeBytes, 0)) ||
      row.expiresAt.getTime() !== federationExecutionDeadline(scope.request)
    )
      throw new FederationError("OPERATION_CONFLICT");
    await this.members(tx, row);
    return row;
  }

  async lock(tx: PgTransaction, scope: Scope) {
    await this.preparation.lockMaterialScope(tx, scope);
    const row = await this.existing(tx, scope);
    if (!row) throw new FederationError("DATA_WAITING");
    return row;
  }

  private async members(tx: PgTransaction, row: Import) {
    const members = row.manifest.inputs.flatMap((input) =>
      input.files.map((file) => ({ descriptor: input.descriptor, ...file })),
    );
    let saved = await tx
      .select()
      .from(federationInputTransfers)
      .where(eq(federationInputTransfers.importId, row.id));
    // Empty legacy pending imports may be initialized once; never repair a partial or active manifest.
    if (!saved.length && members.length && row.state === "pending") {
      saved = await tx
        .insert(federationInputTransfers)
        .values(
          members.map((file) => ({
            ...file,
            importId: row.id,
            partSize: Math.max(8 * 1024 * 1024, Math.ceil(file.sizeBytes / 10_000)),
            createdAt: this.clock(),
            updatedAt: this.clock(),
          })),
        )
        .returning();
    }
    if (
      saved.length !== members.length ||
      members.some(
        (member) =>
          !saved.some(
            (file) =>
              file.descriptor === member.descriptor &&
              file.path === member.path &&
              file.sizeBytes === member.sizeBytes &&
              file.sha256 === member.sha256 &&
              file.partSize === Math.max(8 * 1024 * 1024, Math.ceil(member.sizeBytes / 10_000)),
          ),
      )
    )
      throw new FederationError("OPERATION_CONFLICT");
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

  /** Bounded reconciliation fences unauthorized work; active effects retain quota for cleanup. */
  async sweep() {
    const rows = await this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(federationInputImports)
        .where(
          and(
            eq(federationInputImports.localSiteId, this.preparation.localSiteId),
            inArray(federationInputImports.state, ["pending", "transferring", "available"]),
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
                inArray(federationInputImports.state, ["pending", "transferring", "available"]),
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
            cancelFederationInputImport(tx, row.reservationId, error.code, this.clock()),
          );
        else
          await this.db
            .update(federationInputImports)
            .set({ lastError: "AUTHORIZATION_UNAVAILABLE", updatedAt: this.clock() })
            .where(
              and(
                eq(federationInputImports.id, row.id),
                inArray(federationInputImports.state, ["pending", "transferring", "available"]),
              ),
            );
      }
    }
  }
}
