import {
  agents,
  auditLog,
  federationInputAttempts,
  federationInputImports,
  federationInputTransfers,
  federationReservations,
  federationResultAttempts,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationError,
  FederationInputCopiedSchema,
  type FederationInputCopyBinding,
  FederationInputCopyBindingSchema,
  FederationInputCopyTaskSchema,
  type FederationInputVerified,
  FederationInputVerifiedSchema,
  type FederationInputVerifyTask,
  FederationInputVerifyTaskSchema,
  FederationResultObjectSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, notExists, or } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { readFederationExecutionStopState } from "./cancellation-state";
import { type FederationInputImports, finishCancelledInputImport } from "./input-imports";
import type { FederationPreparationService } from "./preparation";
import { lockFederationTransferAgent, lockFederationTransferSlot } from "./transfer-agent";

type Parent = typeof federationInputImports.$inferSelect;
type Transfer = typeof federationInputTransfers.$inferSelect;
type Attempt = typeof federationInputAttempts.$inferSelect;
type Rows = { parent: Parent; transfer: Transfer; attempt: Attempt };
const activeStates = ["preparing", "copying", "assembling", "verifying"];

type Scope = Awaited<ReturnType<FederationPreparationService["materialScope"]>>;

/** Receiver-owned input attempts; all storage I/O must happen outside these transactions. */
export class FederationInputTransfers {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
    private readonly imports: FederationInputImports,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async pending(onlineAgentIds: readonly string[], limit = 20) {
    z.number().int().min(1).max(100).parse(limit);
    if (!onlineAgentIds.length) return [];
    return this.db
      .select({
        transferId: federationInputTransfers.id,
        agentId: agents.agentId,
      })
      .from(federationInputTransfers)
      .innerJoin(
        federationInputImports,
        eq(federationInputImports.id, federationInputTransfers.importId),
      )
      .innerJoin(agents, eq(agents.providerOrgId, federationInputImports.localOrgId))
      .where(
        and(
          eq(federationInputImports.localSiteId, this.preparation.localSiteId),
          inArray(federationInputImports.state, ["pending", "transferring"]),
          eq(federationInputTransfers.state, "pending"),
          lte(federationInputTransfers.updatedAt, new Date(this.clock().getTime() - 30_000)),
          inArray(agents.agentId, [...onlineAgentIds]),
          eq(agents.status, "online"),
          ...[federationInputAttempts, federationResultAttempts].map((attempts) =>
            notExists(
              this.db
                .select({ id: attempts.generation })
                .from(attempts)
                .where(
                  and(
                    eq(attempts.agentId, agents.agentId),
                    inArray(attempts.state, [...activeStates, "cleanup_pending"]),
                    gte(attempts.leaseUntil, this.clock()),
                  ),
                ),
            ),
          ),
        ),
      )
      .orderBy(
        asc(federationInputTransfers.updatedAt),
        asc(federationInputTransfers.id),
        asc(agents.agentId),
      )
      .limit(limit);
  }

  async processingFailed(transferId: string, code: string) {
    await this.db.transaction(async (tx) => {
      const rows = await this.lockTransfer(tx, transferId);
      if (!["pending", "transferring"].includes(rows.parent.state)) return;
      await tx
        .update(federationInputTransfers)
        .set({ updatedAt: this.clock() })
        .where(eq(federationInputTransfers.id, transferId));
      await tx
        .update(federationInputImports)
        .set({ lastError: code, updatedAt: this.clock() })
        .where(eq(federationInputImports.id, rows.parent.id));
    });
  }

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

  async copied(agentId: string, input: z.infer<typeof FederationInputCopiedSchema>) {
    const receipt = FederationInputCopiedSchema.parse(input);
    const scope = await this.attemptScope(receipt.binding.generation);
    return this.db.transaction(async (tx) => {
      const rows = await this.authorizedAttempt(tx, scope, receipt.binding.generation, agentId, [
        "copying",
        "assembling",
        "verifying",
        "verified",
        "available",
      ]);
      const binding = this.binding(rows, scope);
      if (
        federationMaterialDigest(binding) !== federationMaterialDigest(receipt.binding) ||
        receipt.sizeBytes !== binding.sizeBytes ||
        receipt.sha256 !== binding.sha256 ||
        receipt.parts.length !==
          Math.max(1, Math.ceil(binding.sizeBytes / rows.transfer.partSize)) ||
        receipt.parts.some((part, i) => part.partNumber !== i + 1)
      )
        throw new FederationError("INVALID_MESSAGE");
      if (rows.attempt.state !== "copying") {
        if (
          federationMaterialDigest(rows.attempt.parts) !== federationMaterialDigest(receipt.parts)
        )
          throw new FederationError("OPERATION_CONFLICT");
        return { state: rows.attempt.state };
      }
      await tx
        .update(federationInputAttempts)
        .set({ state: "assembling", parts: receipt.parts, updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, receipt.binding.generation));
      await tx
        .update(federationInputTransfers)
        .set({ state: "assembling", updatedAt: this.clock() })
        .where(eq(federationInputTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "bytes_copied", { generation: rows.attempt.generation });
      return { state: "assembling" };
    });
  }

  async assembling(agentId: string, generation: string) {
    const scope = await this.attemptScope(generation);
    return this.db.transaction(async (tx) => {
      const rows = await this.authorizedAttempt(tx, scope, generation, agentId, [
        "assembling",
        "verifying",
      ]);
      return { ...rows, binding: this.binding(rows, scope) };
    });
  }

  /** One CompleteMultipart request per generation; retries inspect its object instead of reissuing it. */
  async startCompletion(agentId: string, generation: string) {
    // shortcut: no positive storage evidence means retained quota; add operator-confirmed reconciliation.
    const scope = await this.attemptScope(generation);
    return this.db.transaction(async (tx) => {
      const rows = await this.authorizedAttempt(tx, scope, generation, agentId, [
        "assembling",
        "verifying",
      ]);
      if (rows.attempt.completionStartedAt) return false;
      await tx
        .update(federationInputAttempts)
        .set({ completionStartedAt: this.clock(), updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, generation));
      return true;
    });
  }

  /** Records a positive storage outcome even after cancellation; never grants use or skips verification. */
  async completed(generation: string, object: z.infer<typeof FederationResultObjectSchema>) {
    const pin = FederationResultObjectSchema.parse(object);
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (!rows.attempt.completionStartedAt) throw new FederationError("OPERATION_CONFLICT");
      if (rows.attempt.completionSettledAt) {
        if (
          rows.attempt.destinationVersionId !== pin.versionId ||
          rows.attempt.destinationEtag !== pin.etag
        )
          throw new FederationError("OPERATION_CONFLICT");
        return;
      }
      if (!["assembling", "cleanup_pending"].includes(rows.attempt.state))
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(federationInputAttempts)
        .set({
          completionSettledAt: this.clock(),
          destinationVersionId: pin.versionId,
          destinationEtag: pin.etag,
          updatedAt: this.clock(),
        })
        .where(eq(federationInputAttempts.generation, generation));
    });
  }

  async assembled(agentId: string, generation: string) {
    const scope = await this.attemptScope(generation);
    return this.db.transaction(async (tx) => {
      const rows = await this.authorizedAttempt(
        tx,
        scope,
        generation,
        agentId,
        ["assembling", "verifying"],
        true,
      );
      if (!rows.attempt.completionSettledAt) throw new FederationError("DATA_WAITING");
      const task = this.verificationTask(rows, scope);
      if (rows.attempt.state === "verifying")
        return { task, leaseExpiresAt: rows.attempt.leaseUntil.toISOString() };
      const leaseUntil = this.lease(rows.parent);
      await tx
        .update(federationInputAttempts)
        .set({ state: "verifying", leaseUntil, updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, generation));
      await tx
        .update(federationInputTransfers)
        .set({ state: "verifying", updatedAt: this.clock() })
        .where(eq(federationInputTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "assembled", { generation });
      return { task, leaseExpiresAt: leaseUntil.toISOString() };
    });
  }

  async verification(agentId: string, input: FederationInputVerifyTask, renew = false) {
    const task = FederationInputVerifyTaskSchema.parse(input);
    const scope = await this.attemptScope(task.binding.generation);
    return this.db.transaction(async (tx) => {
      const rows = await this.authorizedAttempt(
        tx,
        scope,
        task.binding.generation,
        agentId,
        renew ? ["verifying"] : ["verifying", "verified", "available"],
        renew,
      );
      if (
        federationMaterialDigest(this.verificationTask(rows, scope)) !==
        federationMaterialDigest(task)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const leaseUntil = renew ? this.lease(rows.parent) : rows.attempt.leaseUntil;
      if (renew)
        await tx
          .update(federationInputAttempts)
          .set({ leaseUntil, updatedAt: this.clock() })
          .where(eq(federationInputAttempts.generation, task.binding.generation));
      return { storageKey: rows.attempt.storageKey, leaseUntil, state: rows.attempt.state };
    });
  }

  async verified(agentId: string, input: FederationInputVerified) {
    const receipt = FederationInputVerifiedSchema.parse(input);
    const scope = await this.attemptScope(receipt.binding.generation);
    await this.db.transaction(async (tx) => {
      const rows = await this.authorizedAttempt(tx, scope, receipt.binding.generation, agentId, [
        "verifying",
        "verified",
        "available",
      ]);
      if (
        federationMaterialDigest(this.verificationTask(rows, scope)) !==
          federationMaterialDigest({
            binding: receipt.binding,
            object: receipt.object,
            availableUntil: receipt.availableUntil,
          }) ||
        receipt.sizeBytes !== rows.transfer.sizeBytes ||
        receipt.sha256 !== rows.transfer.sha256
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (["verified", "available"].includes(rows.attempt.state)) return;
      await tx
        .update(federationInputAttempts)
        .set({ state: "verified", verifiedAt: this.clock(), updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, receipt.binding.generation));
      await tx
        .update(federationInputTransfers)
        .set({ state: "verified", updatedAt: this.clock() })
        .where(eq(federationInputTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "destination_verified", {
        generation: receipt.binding.generation,
      });
    });
  }

  async completionCandidates(limit = 8) {
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
          inArray(federationInputAttempts.state, ["assembling", "cleanup_pending"]),
          isNotNull(federationInputAttempts.completionStartedAt),
          isNull(federationInputAttempts.completionSettledAt),
        ),
      )
      .orderBy(asc(federationInputAttempts.updatedAt), asc(federationInputAttempts.generation))
      .limit(limit);
  }

  async completionPending(generation: string) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (
        !["assembling", "cleanup_pending"].includes(rows.attempt.state) ||
        !rows.attempt.completionStartedAt ||
        rows.attempt.completionSettledAt
      )
        return undefined;
      await tx
        .update(federationInputAttempts)
        .set({ updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, generation));
      return { storageKey: rows.attempt.storageKey };
    });
  }

  private async authorizedAttempt(
    tx: PgTransaction,
    scope: Scope,
    generation: string,
    agentId: string,
    states: readonly string[],
    renewing = false,
  ) {
    await this.imports.lock(tx, scope);
    const rows = await this.lockAttempt(tx, generation);
    if (
      rows.parent.reservationId !== scope.saved.reservation.id ||
      !states.includes(rows.attempt.state)
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (renewing) await lockFederationTransferSlot(tx, agentId);
    await this.assertAttempt(tx, rows, agentId, rows.attempt.state);
    return rows;
  }

  private verificationTask(rows: Rows, scope: Scope) {
    const task = FederationInputVerifyTaskSchema.safeParse({
      binding: this.binding(rows, scope),
      object: { versionId: rows.attempt.destinationVersionId, etag: rows.attempt.destinationEtag },
      availableUntil: rows.parent.expiresAt.toISOString(),
    });
    if (!task.success) throw new FederationError("OPERATION_CONFLICT");
    return task.data;
  }

  async failed(agentId: string, generation: string) {
    await this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (rows.attempt.agentId !== agentId) throw new FederationError("POLICY_DENIED");
      if (["cleanup_pending", "cleaned"].includes(rows.attempt.state)) return;
      if (!activeStates.includes(rows.attempt.state))
        throw new FederationError("OPERATION_CONFLICT");
      await this.fence(
        tx,
        rows,
        rows.attempt.completionStartedAt && !rows.attempt.completionSettledAt
          ? "COMPLETION_UNCONFIRMED"
          : rows.attempt.allocationStartedAt && !rows.attempt.uploadId
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
          inArray(federationInputAttempts.state, activeStates),
          lte(federationInputAttempts.leaseUntil, this.clock()),
        ),
      )
      .orderBy(asc(federationInputAttempts.leaseUntil))
      .limit(limit);
    for (const candidate of candidates)
      await this.db.transaction(async (tx) => {
        const rows = await this.lockAttempt(tx, candidate.generation);
        if (!activeStates.includes(rows.attempt.state) || rows.attempt.leaseUntil > this.clock())
          return;
        await this.fence(
          tx,
          rows,
          rows.attempt.completionStartedAt && !rows.attempt.completionSettledAt
            ? "COMPLETION_UNCONFIRMED"
            : rows.attempt.allocationStartedAt && !rows.attempt.uploadId
              ? "ALLOCATION_UNCONFIRMED"
              : "LEASE_EXPIRED",
        );
      });
  }

  async allocationCandidates(limit = 8) {
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
          isNotNull(federationInputAttempts.allocationStartedAt),
          isNull(federationInputAttempts.uploadId),
        ),
      )
      .orderBy(asc(federationInputAttempts.updatedAt), asc(federationInputAttempts.generation))
      .limit(limit);
  }

  async allocationPending(generation: string) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (
        rows.attempt.state !== "cleanup_pending" ||
        rows.attempt.leaseUntil > this.clock() ||
        !rows.attempt.allocationStartedAt ||
        rows.attempt.uploadId
      )
        return undefined;
      await tx
        .update(federationInputAttempts)
        .set({ updatedAt: this.clock() })
        .where(eq(federationInputAttempts.generation, generation));
      return { storageKey: rows.attempt.storageKey };
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
          or(
            isNull(federationInputAttempts.completionStartedAt),
            isNotNull(federationInputAttempts.completionSettledAt),
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
      if (rows.parent.publishedAt) {
        const [reservation] = await tx
          .select({
            senderSiteId: federationReservations.senderSiteId,
            operationId: federationReservations.operationId,
          })
          .from(federationReservations)
          .where(eq(federationReservations.id, rows.parent.reservationId));
        if (!reservation || !(await readFederationExecutionStopState(tx, reservation)).stopped)
          throw new FederationError("DATA_WAITING");
      }
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
    if (
      (attempt.allocationStartedAt && !attempt.uploadId) ||
      (attempt.completionStartedAt && !attempt.completionSettledAt)
    )
      throw new FederationError("DATA_WAITING");
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
      rows.parent.state !== (state === "available" ? "available" : "transferring") ||
      rows.transfer.state !== (state === "preparing" ? "copying" : state) ||
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
