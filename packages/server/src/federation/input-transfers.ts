import {
  agents,
  auditLog,
  federationInputAttempts,
  federationInputImports,
  federationInputTransfers,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationError,
  type FederationInputCopyBinding,
  FederationInputCopyBindingSchema,
  FederationInputCopyTaskSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { type FederationInputImports, finishCancelledInputImport } from "./input-imports";
import type { FederationPreparationService } from "./preparation";
import { lockFederationTransferAgent, lockFederationTransferSlot } from "./transfer-agent";

type Parent = typeof federationInputImports.$inferSelect;
type Transfer = typeof federationInputTransfers.$inferSelect;
type Attempt = typeof federationInputAttempts.$inferSelect;
type Rows = { parent: Parent; transfer: Transfer; attempt: Attempt };
type Scope = Awaited<ReturnType<FederationPreparationService["materialScope"]>>;

/** Receiver-owned input attempts; all storage I/O must happen outside these transactions. */
export class FederationInputTransfers {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
    private readonly imports: FederationInputImports,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async begin(transferId: string, agentId: string) {
    const scope = await this.scope(transferId);
    return this.db.transaction(async (tx) => {
      await this.imports.lock(tx, scope);
      const { parent, transfer } = await this.lockTransfer(tx, transferId);
      if (parent.reservationId !== scope.saved.reservation.id)
        throw new FederationError("OPERATION_CONFLICT");
      await this.agent(tx, agentId, parent);
      await lockFederationTransferAgent(tx, agentId, this.clock());
      if (transfer.state !== "pending") throw new FederationError("OPERATION_CONFLICT");
      const [prior] = await tx
        .select()
        .from(federationInputAttempts)
        .where(
          and(
            eq(federationInputAttempts.transferId, transferId),
            ne(federationInputAttempts.state, "cleaned"),
          ),
        )
        .limit(1);
      if (prior) throw new FederationError("OPERATION_CONFLICT");
      const generation = crypto.randomUUID();
      const [attempt] = await tx
        .insert(federationInputAttempts)
        .values({
          generation,
          transferId,
          agentId,
          state: "preparing",
          storageKey: `federation-inputs/${parent.id}/${generation}`,
          leaseUntil: this.lease(parent),
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .returning();
      if (!attempt) throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(federationInputTransfers)
        .set({ state: "copying", updatedAt: this.clock() })
        .where(eq(federationInputTransfers.id, transferId));
      await tx
        .update(federationInputImports)
        .set({ state: "transferring", lastError: null, updatedAt: this.clock() })
        .where(eq(federationInputImports.id, parent.id));
      await this.audit(tx, parent, "attempt_started", { transferId, generation, agentId });
      return {
        attempt,
        task: FederationInputCopyTaskSchema.parse({
          binding: this.binding({ parent, transfer, attempt }, scope),
          partSize: transfer.partSize,
          availableUntil: parent.expiresAt.toISOString(),
        }),
      };
    });
  }

  /** One durable permit per generation, before issuing CreateMultipartUpload. Never re-issue after a crash. */
  async preparing(agentId: string, generation: string) {
    const scope = await this.attemptScope(generation);
    return this.db.transaction(async (tx) => {
      await this.imports.lock(tx, scope);
      const rows = await this.lockAttempt(tx, generation);
      if (rows.parent.reservationId !== scope.saved.reservation.id)
        throw new FederationError("OPERATION_CONFLICT");
      await this.assertAttempt(tx, rows, agentId, "preparing");
      if (rows.attempt.allocationStartedAt) throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(federationInputAttempts)
        .set({ allocationStartedAt: this.clock(), updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, generation));
      return { storageKey: rows.attempt.storageKey, leaseUntil: rows.attempt.leaseUntil };
    });
  }

  /** Always records a returned upload ID, including after cancellation, expiry or authority loss. */
  async allocated(generation: string, uploadId: string) {
    z.string().min(1).max(2048).parse(uploadId);
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      const { attempt, parent } = rows;
      if (!attempt.allocationStartedAt || (attempt.uploadId && attempt.uploadId !== uploadId))
        throw new FederationError("OPERATION_CONFLICT");
      if (attempt.uploadId)
        return (
          attempt.state === "copying" &&
          attempt.leaseUntil > this.clock() &&
          parent.state === "transferring"
        );
      if (attempt.state !== "preparing" && attempt.state !== "cleanup_pending")
        throw new FederationError("OPERATION_CONFLICT");
      const active =
        attempt.state === "preparing" &&
        parent.state === "transferring" &&
        attempt.leaseUntil > this.clock();
      await tx
        .update(federationInputAttempts)
        .set({
          uploadId,
          state: active ? "copying" : "cleanup_pending",
          cleanupToken: null,
          updatedAt: this.clock(),
        })
        .where(eq(federationInputAttempts.generation, generation));
      if (!active && parent.state === "transferring")
        await tx
          .update(federationInputTransfers)
          .set({ state: "cleanup_pending", updatedAt: this.clock() })
          .where(eq(federationInputTransfers.id, rows.transfer.id));
      return active;
    });
  }

  async assertCopyLease(agentId: string, input: FederationInputCopyBinding, renew = false) {
    const current = await this.copyAuthorization(agentId, input, renew);
    return this.db.transaction(current.authorize);
  }

  /** Lets a remote grant reader hold transfer and trust locks together for its final disclosure check. */
  async copyAuthorization(agentId: string, input: FederationInputCopyBinding, renew = false) {
    const binding = FederationInputCopyBindingSchema.parse(input);
    const scope = await this.attemptScope(binding.generation);
    const authorize = async (tx: PgTransaction) => {
      await this.imports.lock(tx, scope);
      const rows = await this.lockAttempt(tx, binding.generation);
      if (rows.parent.reservationId !== scope.saved.reservation.id)
        throw new FederationError("OPERATION_CONFLICT");
      if (renew) await lockFederationTransferSlot(tx, agentId);
      await this.assertAttempt(tx, rows, agentId, "copying");
      if (federationMaterialDigest(this.binding(rows, scope)) !== federationMaterialDigest(binding))
        throw new FederationError("OPERATION_CONFLICT");
      const leaseUntil = renew ? this.lease(rows.parent) : rows.attempt.leaseUntil;
      if (renew)
        await tx
          .update(federationInputAttempts)
          .set({ leaseUntil, updatedAt: this.clock() })
          .where(eq(federationInputAttempts.generation, binding.generation));
      return {
        reservationId: rows.parent.reservationId,
        storageKey: rows.attempt.storageKey,
        uploadId: rows.attempt.uploadId,
        partSize: rows.transfer.partSize,
        leaseUntil,
      };
    };
    return { scope, binding, authorize };
  }

  async failed(agentId: string, generation: string) {
    await this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (rows.attempt.agentId !== agentId) throw new FederationError("POLICY_DENIED");
      if (["cleanup_pending", "cleaned"].includes(rows.attempt.state)) return;
      await this.fence(
        tx,
        rows,
        rows.attempt.allocationStartedAt && !rows.attempt.uploadId
          ? "ALLOCATION_UNCONFIRMED"
          : "TRANSFER_FAILED",
      );
    });
  }

  async expire(limit = 20) {
    z.number().int().min(1).max(100).parse(limit);
    const candidates = await this.db
      .select({ generation: federationInputAttempts.generation })
      .from(federationInputAttempts)
      .innerJoin(
        federationInputTransfers,
        eq(federationInputTransfers.id, federationInputAttempts.transferId),
      )
      .innerJoin(
        federationInputImports,
        eq(federationInputImports.id, federationInputTransfers.importId),
      )
      .where(
        and(
          eq(federationInputImports.localSiteId, this.preparation.localSiteId),
          inArray(federationInputAttempts.state, ["preparing", "copying"]),
          lte(federationInputAttempts.leaseUntil, this.clock()),
        ),
      )
      .orderBy(asc(federationInputAttempts.leaseUntil))
      .limit(limit);
    for (const candidate of candidates)
      await this.db.transaction(async (tx) => {
        const rows = await this.lockAttempt(tx, candidate.generation);
        if (
          !["preparing", "copying"].includes(rows.attempt.state) ||
          rows.attempt.leaseUntil > this.clock()
        )
          return;
        await this.fence(
          tx,
          rows,
          rows.attempt.allocationStartedAt && !rows.attempt.uploadId
            ? "ALLOCATION_UNCONFIRMED"
            : "LEASE_EXPIRED",
        );
      });
  }

  async cleanupCandidates(limit = 20) {
    z.number().int().min(1).max(100).parse(limit);
    return this.db
      .select({ generation: federationInputAttempts.generation })
      .from(federationInputAttempts)
      .innerJoin(
        federationInputTransfers,
        eq(federationInputTransfers.id, federationInputAttempts.transferId),
      )
      .innerJoin(
        federationInputImports,
        eq(federationInputImports.id, federationInputTransfers.importId),
      )
      .where(
        and(
          eq(federationInputImports.localSiteId, this.preparation.localSiteId),
          eq(federationInputAttempts.state, "cleanup_pending"),
          lte(federationInputAttempts.leaseUntil, this.clock()),
          or(
            isNull(federationInputAttempts.allocationStartedAt),
            isNotNull(federationInputAttempts.uploadId),
          ),
        ),
      )
      .orderBy(asc(federationInputAttempts.updatedAt), asc(federationInputAttempts.generation))
      .limit(limit);
  }

  async beginCleanup(generation: string) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      this.assertCleanable(rows.attempt);
      const token = crypto.randomUUID();
      await tx
        .update(federationInputAttempts)
        .set({ cleanupToken: token, updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, generation));
      return {
        storageKey: rows.attempt.storageKey,
        uploadId: rows.attempt.uploadId,
        allocationStarted: rows.attempt.allocationStartedAt !== null,
        token,
      };
    });
  }

  /** Internal storage worker only: positive exact-key object/part absence, never a timeout or Agent report. */
  async storageCleaned(generation: string, token: string) {
    z.uuid().parse(token);
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (rows.attempt.cleanupToken !== token) throw new FederationError("OPERATION_CONFLICT");
      if (rows.attempt.state === "cleaned") return;
      this.assertCleanable(rows.attempt);
      await tx
        .update(federationInputAttempts)
        .set({ state: "cleaned", updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, generation));
      await tx
        .update(federationInputTransfers)
        .set({
          state: rows.parent.state === "cancelling" ? "cancelled" : "pending",
          updatedAt: this.clock(),
        })
        .where(eq(federationInputTransfers.id, rows.transfer.id));
      await finishCancelledInputImport(tx, rows.parent, this.clock());
      await this.audit(tx, rows.parent, "storage_cleaned", {
        transferId: rows.transfer.id,
        generation,
      });
    });
  }

  private assertCleanable(attempt: Attempt) {
    if (attempt.state !== "cleanup_pending" || attempt.leaseUntil > this.clock())
      throw new FederationError("OPERATION_CONFLICT");
    // A lost create response cannot be proven harmless by one empty object listing.
    if (attempt.allocationStartedAt && !attempt.uploadId) throw new FederationError("DATA_WAITING");
  }

  private async fence(tx: PgTransaction, rows: Rows, reason: string) {
    await tx
      .update(federationInputAttempts)
      .set({ state: "cleanup_pending", lastError: reason, updatedAt: this.clock() })
      .where(eq(federationInputAttempts.generation, rows.attempt.generation));
    await tx
      .update(federationInputTransfers)
      .set({
        state: rows.parent.state === "cancelling" ? "cancelled" : "cleanup_pending",
        updatedAt: this.clock(),
      })
      .where(eq(federationInputTransfers.id, rows.transfer.id));
    await this.audit(tx, rows.parent, "attempt_stopped", {
      transferId: rows.transfer.id,
      generation: rows.attempt.generation,
      reason,
    });
  }

  private async scope(transferId: string) {
    const [row] = await this.db
      .select({ parent: federationInputImports })
      .from(federationInputTransfers)
      .innerJoin(
        federationInputImports,
        eq(federationInputImports.id, federationInputTransfers.importId),
      )
      .where(eq(federationInputTransfers.id, transferId));
    if (!row || row.parent.localSiteId !== this.preparation.localSiteId)
      throw new FederationError("POLICY_DENIED");
    return this.preparation.materialScope(row.parent.reservationId);
  }
  private async attemptScope(generation: string) {
    const [attempt] = await this.db
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.generation, generation));
    if (!attempt) throw new FederationError("POLICY_DENIED");
    return this.scope(attempt.transferId);
  }
  private async lockTransfer(tx: PgTransaction, transferId: string) {
    const [lookup] = await tx
      .select()
      .from(federationInputTransfers)
      .where(eq(federationInputTransfers.id, transferId));
    if (!lookup) throw new FederationError("POLICY_DENIED");
    const [parent] = await tx
      .select()
      .from(federationInputImports)
      .where(eq(federationInputImports.id, lookup.importId))
      .for("update");
    const [transfer] = await tx
      .select()
      .from(federationInputTransfers)
      .where(eq(federationInputTransfers.id, transferId))
      .for("update");
    if (!parent || !transfer || parent.localSiteId !== this.preparation.localSiteId)
      throw new FederationError("POLICY_DENIED");
    return { parent, transfer };
  }
  private async lockAttempt(tx: PgTransaction, generation: string): Promise<Rows> {
    const [lookup] = await tx
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.generation, generation));
    if (!lookup) throw new FederationError("POLICY_DENIED");
    const rows = await this.lockTransfer(tx, lookup.transferId);
    const [attempt] = await tx
      .select()
      .from(federationInputAttempts)
      .where(eq(federationInputAttempts.generation, generation))
      .for("update");
    if (!attempt || attempt.storageKey !== `federation-inputs/${rows.parent.id}/${generation}`)
      throw new FederationError("OPERATION_CONFLICT");
    return { ...rows, attempt };
  }
  private async agent(tx: PgTransaction, agentId: string, parent: Parent) {
    const [agent] = await tx.select().from(agents).where(eq(agents.agentId, agentId)).for("share");
    if (!agent || agent.providerOrgId !== parent.localOrgId || agent.status !== "online")
      throw new FederationError("POLICY_DENIED");
  }
  private async assertAttempt(tx: PgTransaction, rows: Rows, agentId: string, state: string) {
    if (
      rows.parent.state !== "transferring" ||
      rows.transfer.state !== "copying" ||
      rows.attempt.agentId !== agentId ||
      rows.attempt.state !== state ||
      rows.attempt.leaseUntil <= this.clock()
    )
      throw new FederationError("OPERATION_CONFLICT");
    await this.agent(tx, agentId, rows.parent);
  }
  private lease(parent: Parent) {
    return new Date(Math.min(this.clock().getTime() + 120_000, parent.expiresAt.getTime()));
  }
  private binding(rows: Rows, scope: Scope): FederationInputCopyBinding {
    return {
      transferId: rows.transfer.id,
      generation: rows.attempt.generation,
      operationId: scope.request.operationId,
      manifestDigest: rows.parent.manifestDigest,
      descriptor: rows.transfer.descriptor,
      path: rows.transfer.path,
      sizeBytes: rows.transfer.sizeBytes,
      sha256: rows.transfer.sha256,
    };
  }
  private async audit(
    tx: PgTransaction,
    parent: Parent,
    action: string,
    detail: Record<string, string>,
  ) {
    await tx.insert(auditLog).values({
      actor: parent.ownerId,
      orgId: parent.localOrgId,
      action: `federation.input.${action}`,
      target: parent.id,
      diff: { after: detail },
    });
  }
}
