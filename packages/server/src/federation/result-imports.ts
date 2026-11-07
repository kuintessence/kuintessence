import {
  agents,
  auditLog,
  federationOutbound,
  federationResultAttempts,
  federationResultImports,
  federationResultTransfers,
  type PgDb,
} from "@kuintessence/db";
import {
  FederationError,
  type FederationResultCopyBinding,
  FederationResultCopyBindingSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { z } from "zod";
import { federationMaterialDigest } from "./assets";
import { type FederationActor, requireFederationCapability } from "./permissions";
import type { FederationResultReader } from "./result-reader";
import type { FederationTransaction } from "./trust-registry";

type Import = typeof federationResultImports.$inferSelect;
type Transfer = typeof federationResultTransfers.$inferSelect;
type Attempt = typeof federationResultAttempts.$inferSelect;
const activeStates = ["preparing", "copying", "assembling", "verifying"];
const CopiedSchema = z.strictObject({
  binding: FederationResultCopyBindingSchema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  parts: z
    .array(
      z.strictObject({
        partNumber: z.number().int().min(1).max(10_000),
        etag: z
          .string()
          .min(1)
          .max(255)
          .refine((value) =>
            Array.from(value).every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127),
          ),
      }),
    )
    .min(1)
    .max(10_000),
});

/** Durable ownership and attempt fencing; storage effects run outside these transactions. */
export class FederationResultImports {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly reader: FederationResultReader,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async enqueue(actor: FederationActor, operationId: string, importId: string) {
    z.uuid().parse(importId);
    z.uuid().parse(operationId);
    const existing = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "result.read");
      const [row] = await tx
        .select()
        .from(federationResultImports)
        .where(eq(federationResultImports.id, importId));
      if (!row) return undefined;
      this.assertOwner(row, actor, operationId);
      return this.summary(tx, row);
    });
    if (existing) return existing;
    const verified = await this.reader.read(actor, operationId);
    const members = verified.report.manifest.outputs.flatMap((output) =>
      output.files.map((file) => ({ outputId: output.outputId, ...file })),
    );
    if (members.some((file) => file.sizeBytes > 5 * 1024 ** 4))
      throw new FederationError("POLICY_DENIED");
    return this.db.transaction(async (tx) => {
      // Serializes concurrent imports of the same remote operation without network under the lock.
      await tx
        .select()
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.siteId),
            eq(federationOutbound.operationId, operationId),
          ),
        )
        .for("update");
      await this.reader.authorize(tx, actor, operationId);
      const [duplicate] = await tx
        .select()
        .from(federationResultImports)
        .where(eq(federationResultImports.id, importId));
      if (duplicate) {
        this.assertOwner(duplicate, actor, operationId);
        return this.summary(tx, duplicate);
      }
      const [sameManifest] = await tx
        .select()
        .from(federationResultImports)
        .where(
          and(
            eq(federationResultImports.localSiteId, this.siteId),
            eq(federationResultImports.operationId, operationId),
            eq(federationResultImports.requestedBy, actor.userId),
            eq(federationResultImports.manifestDigest, verified.report.manifestDigest),
            ne(federationResultImports.state, "cancelled"),
          ),
        );
      if (sameManifest) {
        this.assertOwner(sameManifest, actor, operationId);
        return this.summary(tx, sameManifest);
      }
      const [created] = await tx
        .insert(federationResultImports)
        .values({
          id: importId,
          localSiteId: this.siteId,
          localOrgId: actor.orgId,
          operationId,
          requestedBy: actor.userId,
          report: verified.report,
          reportJws: verified.reportJws,
          manifestDigest: verified.report.manifestDigest,
          state: "pending",
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const [raced] = await tx
          .select()
          .from(federationResultImports)
          .where(eq(federationResultImports.id, importId));
        if (!raced) throw new FederationError("OPERATION_CONFLICT");
        this.assertOwner(raced, actor, operationId);
        return this.summary(tx, raced);
      }
      if (members.length)
        await tx.insert(federationResultTransfers).values(
          members.map((file) => ({
            id: crypto.randomUUID(),
            importId,
            ...file,
            partSize: Math.max(8 * 1024 * 1024, Math.ceil(file.sizeBytes / 10_000)),
            state: "pending",
            createdAt: this.clock(),
            updatedAt: this.clock(),
          })),
        );
      await this.audit(tx, created, "enqueued");
      return this.summary(tx, created);
    });
  }

  async get(actor: FederationActor, importId: string, operationId?: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "result.read");
      const [row] = await tx
        .select()
        .from(federationResultImports)
        .where(eq(federationResultImports.id, importId));
      if (!row) throw new FederationError("POLICY_DENIED");
      this.assertOwner(row, actor, operationId ?? row.operationId);
      return this.summary(tx, row);
    });
  }

  async begin(transferId: string, agentId: string) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockTransfer(tx, transferId);
      await this.authorize(tx, rows.parent);
      const [agent] = await tx
        .select()
        .from(agents)
        .where(eq(agents.agentId, agentId))
        .for("share");
      if (!agent || agent.providerOrgId !== rows.parent.localOrgId || agent.status !== "online")
        throw new FederationError("POLICY_DENIED");
      const [held] = await tx
        .select({ generation: federationResultAttempts.generation })
        .from(federationResultAttempts)
        .where(
          and(
            eq(federationResultAttempts.agentId, agentId),
            ne(federationResultAttempts.state, "cleaned"),
            gte(federationResultAttempts.leaseUntil, this.clock()),
          ),
        )
        .limit(1);
      if (held) throw new FederationError("OPERATION_CONFLICT");
      if (rows.transfer.state !== "pending") throw new FederationError("OPERATION_CONFLICT");
      const [previous] = await tx
        .select()
        .from(federationResultAttempts)
        .where(
          and(
            eq(federationResultAttempts.transferId, transferId),
            ne(federationResultAttempts.state, "cleaned"),
          ),
        );
      if (previous) throw new FederationError("OPERATION_CONFLICT");
      const generation = crypto.randomUUID();
      const [attempt] = await tx
        .insert(federationResultAttempts)
        .values({
          generation,
          transferId,
          agentId,
          storageKey: `federation-results/${rows.parent.id}/${generation}`,
          state: "preparing",
          leaseUntil: this.lease(rows.parent),
          createdAt: this.clock(),
          updatedAt: this.clock(),
        })
        .returning();
      if (!attempt) throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(federationResultTransfers)
        .set({ state: "copying", updatedAt: this.clock() })
        .where(eq(federationResultTransfers.id, transferId));
      await tx
        .update(federationResultImports)
        .set({ state: "transferring", updatedAt: this.clock() })
        .where(eq(federationResultImports.id, rows.parent.id));
      await this.audit(tx, rows.parent, "attempt_started", { transferId, generation, agentId });
      return {
        attempt,
        task: {
          transferId,
          generation,
          report: rows.parent.report,
          outputId: rows.transfer.outputId,
          path: rows.transfer.path,
          partSize: rows.transfer.partSize,
        },
      };
    });
  }

  /** Even an expired allocator must record its late upload ID so cleanup can remove it. */
  async allocated(generation: string, uploadId: string) {
    z.string().min(1).max(2048).parse(uploadId);
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (rows.attempt.uploadId && rows.attempt.uploadId !== uploadId)
        throw new FederationError("OPERATION_CONFLICT");
      if (!["preparing", "copying", "cleanup_pending", "cleaned"].includes(rows.attempt.state))
        throw new FederationError("OPERATION_CONFLICT");
      let active = rows.attempt.leaseUntil > this.clock() && rows.parent.state !== "cancelled";
      if (active) {
        try {
          await this.authorize(tx, rows.parent);
        } catch (error) {
          if (!(error instanceof FederationError)) throw error;
          active = false;
        }
      }
      active &&= rows.attempt.state === "preparing" || rows.attempt.state === "copying";
      await tx
        .update(federationResultAttempts)
        .set({ uploadId, state: active ? "copying" : "cleanup_pending", updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, generation));
      if (!active && !(await this.hasOtherLiveAttempt(tx, rows.attempt)))
        await tx
          .update(federationResultTransfers)
          .set({
            state: rows.parent.state === "cancelled" ? "cancelled" : "cleanup_pending",
            updatedAt: this.clock(),
          })
          .where(eq(federationResultTransfers.id, rows.transfer.id));
      return active;
    });
  }

  async assertCopyLease(agentId: string, binding: FederationResultCopyBinding) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, binding.generation);
      await this.assertAttempt(tx, rows, agentId, "copying");
      if (federationMaterialDigest(this.binding(rows)) !== federationMaterialDigest(binding))
        throw new FederationError("OPERATION_CONFLICT");
      return {
        actor: this.actor(rows.parent),
        operationId: rows.parent.operationId,
        storageKey: rows.attempt.storageKey,
        uploadId: rows.attempt.uploadId,
        leaseUntil: rows.attempt.leaseUntil,
      };
    });
  }

  async renew(agentId: string, generation: string) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      await this.assertAttempt(tx, rows, agentId, "copying");
      const leaseUntil = this.lease(rows.parent);
      await tx
        .update(federationResultAttempts)
        .set({ leaseUntil, updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, generation));
      return leaseUntil;
    });
  }

  async copied(agentId: string, input: z.infer<typeof CopiedSchema>) {
    const receipt = CopiedSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, receipt.binding.generation);
      if (rows.attempt.state !== "copying" && rows.attempt.state !== "assembling")
        throw new FederationError("OPERATION_CONFLICT");
      await this.assertAttempt(tx, rows, agentId, rows.attempt.state);
      const binding = this.binding(rows);
      if (
        federationMaterialDigest(binding) !== federationMaterialDigest(receipt.binding) ||
        receipt.sizeBytes !== binding.sizeBytes ||
        receipt.sha256 !== binding.sha256 ||
        receipt.parts.length !== Math.max(1, Math.ceil(binding.sizeBytes / binding.partSize)) ||
        receipt.parts.some((part, i) => part.partNumber !== i + 1)
      )
        throw new FederationError("INVALID_MESSAGE");
      if (rows.attempt.state === "assembling") {
        if (
          federationMaterialDigest(rows.attempt.parts) !== federationMaterialDigest(receipt.parts)
        )
          throw new FederationError("OPERATION_CONFLICT");
        return { state: "assembling" as const };
      }
      await tx
        .update(federationResultAttempts)
        .set({ state: "assembling", parts: receipt.parts, updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, rows.attempt.generation));
      await tx
        .update(federationResultTransfers)
        .set({ state: "assembling", updatedAt: this.clock() })
        .where(eq(federationResultTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "bytes_copied", {
        transferId: rows.transfer.id,
        generation: rows.attempt.generation,
      });
      // An Agent upload report is not independent destination verification or publication.
      return { state: "assembling" as const };
    });
  }

  async cancel(actor: FederationActor, importId: string, operationId?: string) {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(federationResultImports)
        .where(eq(federationResultImports.id, importId))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      this.assertOwner(row, actor, operationId ?? row.operationId);
      // Stopping an already accepted copy does not require retaining result.read.
      if (row.state === "available") throw new FederationError("OPERATION_CONFLICT");
      if (row.state !== "cancelled") {
        const members = await tx
          .select({ id: federationResultTransfers.id })
          .from(federationResultTransfers)
          .where(eq(federationResultTransfers.importId, row.id));
        if (members.length) {
          await tx
            .update(federationResultAttempts)
            .set({ state: "cleanup_pending", updatedAt: this.clock() })
            .where(
              and(
                inArray(
                  federationResultAttempts.transferId,
                  members.map((m) => m.id),
                ),
                ne(federationResultAttempts.state, "cleaned"),
              ),
            );
          await tx
            .update(federationResultTransfers)
            .set({ state: "cancelled", updatedAt: this.clock() })
            .where(eq(federationResultTransfers.importId, row.id));
        }
        await tx
          .update(federationResultImports)
          .set({ state: "cancelled", updatedAt: this.clock() })
          .where(eq(federationResultImports.id, row.id));
        await this.audit(tx, row, "cancelled");
      }
      return { id: row.id, state: "cancelled" as const };
    });
  }

  async failed(
    agentId: string,
    generation: string,
    reason: "COPY_FAILED" | "STORAGE_FAILED" | "VERIFICATION_FAILED",
  ) {
    z.enum(["COPY_FAILED", "STORAGE_FAILED", "VERIFICATION_FAILED"]).parse(reason);
    await this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (rows.attempt.agentId !== agentId) throw new FederationError("POLICY_DENIED");
      if (rows.attempt.state === "cleanup_pending" || rows.attempt.state === "cleaned") return;
      if (!activeStates.includes(rows.attempt.state))
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(federationResultAttempts)
        .set({ state: "cleanup_pending", lastError: reason, updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, generation));
      await tx
        .update(federationResultTransfers)
        .set({
          state: rows.parent.state === "cancelled" ? "cancelled" : "cleanup_pending",
          updatedAt: this.clock(),
        })
        .where(eq(federationResultTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "attempt_failed", {
        transferId: rows.transfer.id,
        generation,
        reason,
      });
    });
  }

  async expire(limit = 50) {
    z.number().int().min(1).max(100).parse(limit);
    const candidates = await this.db
      .select({ generation: federationResultAttempts.generation })
      .from(federationResultAttempts)
      .innerJoin(
        federationResultTransfers,
        eq(federationResultTransfers.id, federationResultAttempts.transferId),
      )
      .innerJoin(
        federationResultImports,
        eq(federationResultImports.id, federationResultTransfers.importId),
      )
      .where(
        and(
          eq(federationResultImports.localSiteId, this.siteId),
          inArray(federationResultAttempts.state, activeStates),
          lte(federationResultAttempts.leaseUntil, this.clock()),
        ),
      )
      .orderBy(asc(federationResultAttempts.leaseUntil))
      .limit(limit);
    let count = 0;
    for (const candidate of candidates)
      await this.db.transaction(async (tx) => {
        const rows = await this.lockAttempt(tx, candidate.generation);
        if (!activeStates.includes(rows.attempt.state) || rows.attempt.leaseUntil > this.clock())
          return;
        await tx
          .update(federationResultAttempts)
          .set({ state: "cleanup_pending", lastError: "LEASE_EXPIRED", updatedAt: this.clock() })
          .where(eq(federationResultAttempts.generation, candidate.generation));
        if (rows.parent.state !== "cancelled")
          await tx
            .update(federationResultTransfers)
            .set({ state: "cleanup_pending", updatedAt: this.clock() })
            .where(eq(federationResultTransfers.id, rows.transfer.id));
        await this.audit(tx, rows.parent, "lease_expired", {
          transferId: rows.transfer.id,
          generation: candidate.generation,
        });
        count++;
      });
    return count;
  }

  /** Called by the storage cleanup worker only after exact-key uploads and objects are absent. */
  async storageCleaned(generation: string) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (rows.attempt.state === "cleaned") return;
      if (rows.attempt.state !== "cleanup_pending" || rows.attempt.leaseUntil > this.clock())
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(federationResultAttempts)
        .set({ state: "cleaned", updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, generation));
      if (!(await this.hasOtherLiveAttempt(tx, rows.attempt)))
        await tx
          .update(federationResultTransfers)
          .set({
            state: rows.parent.state === "cancelled" ? "cancelled" : "pending",
            updatedAt: this.clock(),
          })
          .where(eq(federationResultTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "storage_cleaned", {
        transferId: rows.transfer.id,
        generation,
      });
    });
  }

  private async hasOtherLiveAttempt(tx: FederationTransaction, attempt: Attempt) {
    const [other] = await tx
      .select({ generation: federationResultAttempts.generation })
      .from(federationResultAttempts)
      .where(
        and(
          eq(federationResultAttempts.transferId, attempt.transferId),
          ne(federationResultAttempts.generation, attempt.generation),
          ne(federationResultAttempts.state, "cleaned"),
          ne(federationResultAttempts.state, "cleanup_pending"),
        ),
      );
    return !!other;
  }

  private async lockTransfer(tx: FederationTransaction, transferId: string) {
    const [lookup] = await tx
      .select()
      .from(federationResultTransfers)
      .where(eq(federationResultTransfers.id, transferId));
    if (!lookup) throw new FederationError("POLICY_DENIED");
    const [parent] = await tx
      .select()
      .from(federationResultImports)
      .where(eq(federationResultImports.id, lookup.importId))
      .for("update");
    const [transfer] = await tx
      .select()
      .from(federationResultTransfers)
      .where(eq(federationResultTransfers.id, transferId))
      .for("update");
    if (!parent || !transfer || parent.localSiteId !== this.siteId)
      throw new FederationError("POLICY_DENIED");
    return { parent, transfer };
  }
  private async lockAttempt(tx: FederationTransaction, generation: string) {
    const [lookup] = await tx
      .select()
      .from(federationResultAttempts)
      .where(eq(federationResultAttempts.generation, generation));
    if (!lookup) throw new FederationError("POLICY_DENIED");
    const rows = await this.lockTransfer(tx, lookup.transferId);
    const [attempt] = await tx
      .select()
      .from(federationResultAttempts)
      .where(eq(federationResultAttempts.generation, generation))
      .for("update");
    if (!attempt) throw new FederationError("POLICY_DENIED");
    return { ...rows, attempt };
  }
  private async assertAttempt(
    tx: FederationTransaction,
    rows: { parent: Import; transfer: Transfer; attempt: Attempt },
    agentId: string,
    state: string,
  ) {
    if (
      rows.attempt.agentId !== agentId ||
      rows.attempt.state !== state ||
      rows.attempt.leaseUntil <= this.clock()
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [agent] = await tx.select().from(agents).where(eq(agents.agentId, agentId)).for("share");
    if (!agent || agent.providerOrgId !== rows.parent.localOrgId || agent.status !== "online")
      throw new FederationError("POLICY_DENIED");
    await this.authorize(tx, rows.parent);
  }
  private async authorize(tx: FederationTransaction, row: Import) {
    if (
      !["pending", "transferring", "verifying"].includes(row.state) ||
      row.localSiteId !== this.siteId
    )
      throw new FederationError("POLICY_DENIED");
    if (federationMaterialDigest(row.report.manifest) !== row.manifestDigest)
      throw new FederationError("OPERATION_CONFLICT");
    await this.reader.authorize(tx, this.actor(row), row.operationId);
  }
  private actor(row: Import) {
    return { orgId: row.localOrgId, userId: row.requestedBy };
  }
  private lease(row: Import) {
    return new Date(
      Math.min(this.clock().getTime() + 120_000, Date.parse(row.report.manifest.availableUntil)),
    );
  }
  private binding(rows: {
    parent: Import;
    transfer: Transfer;
    attempt: Attempt;
  }): FederationResultCopyBinding {
    return {
      transferId: rows.transfer.id,
      generation: rows.attempt.generation,
      operationId: rows.parent.operationId,
      manifestDigest: rows.parent.manifestDigest,
      outputId: rows.transfer.outputId,
      path: rows.transfer.path,
      sizeBytes: rows.transfer.sizeBytes,
      sha256: rows.transfer.sha256,
      partSize: rows.transfer.partSize,
    };
  }
  private assertOwner(row: Import, actor: FederationActor, operationId: string) {
    if (
      row.localSiteId !== this.siteId ||
      row.localOrgId !== actor.orgId ||
      row.requestedBy !== actor.userId ||
      row.operationId !== operationId
    )
      throw new FederationError("POLICY_DENIED");
  }
  private async summary(tx: FederationTransaction, row: Import) {
    const members = await tx
      .select({
        id: federationResultTransfers.id,
        outputId: federationResultTransfers.outputId,
        path: federationResultTransfers.path,
        sizeBytes: federationResultTransfers.sizeBytes,
        sha256: federationResultTransfers.sha256,
        state: federationResultTransfers.state,
      })
      .from(federationResultTransfers)
      .where(eq(federationResultTransfers.importId, row.id))
      .orderBy(asc(federationResultTransfers.outputId), asc(federationResultTransfers.path));
    return {
      id: row.id,
      operationId: row.operationId,
      manifestDigest: row.manifestDigest,
      state: row.state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      members,
    };
  }
  private async audit(
    tx: FederationTransaction,
    row: Import,
    action: string,
    details: Record<string, string> = {},
  ) {
    await tx.insert(auditLog).values({
      actor: row.requestedBy,
      action: `federation.results.${action}`,
      target: row.id,
      diff: { after: details },
    });
  }
}
