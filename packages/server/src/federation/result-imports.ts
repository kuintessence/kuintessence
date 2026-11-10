import {
  agents,
  auditLog,
  federationInputAttempts,
  federationOutbound,
  federationResultAttempts,
  federationResultImports,
  federationResultTransfers,
  netdriveFiles,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationResultCopiedSchema as CopiedSchema,
  FederationError,
  type FederationResultCopyBinding,
  FederationResultObjectSchema,
  FederationResultReceiptSchema,
  type FederationResultVerified,
  FederationResultVerifiedSchema,
  type FederationResultVerifyTask,
  FederationResultVerifyTaskSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, gte, inArray, isNull, lte, ne, notExists, or } from "drizzle-orm";
import { z } from "zod";
import { lockCloudWrites, StorageQuotaService } from "../services/storage-quota";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import { federationMaterialDigest } from "./assets";
import { renewTaskCompletion } from "./completion-capacity";
import type { FederationMediaImportOperations } from "./media-import-operations";
import { type FederationActor, requireFederationCapability } from "./permissions";
import type { FederationResultReader } from "./result-reader";
import { federationMessageKeyId } from "./signatures";
import type { FederationStorageGuard } from "./storage-capacity";
import { lockFederationTransferAgent, lockFederationTransferSlot } from "./transfer-agent";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";
import { assertWorkflowDelegationBinding } from "./workflow-delegations";

type Import = typeof federationResultImports.$inferSelect;
type Transfer = typeof federationResultTransfers.$inferSelect;
type Attempt = typeof federationResultAttempts.$inferSelect;
const activeStates = ["preparing", "copying", "assembling", "verifying"];

/** Durable ownership and attempt fencing; storage effects run outside these transactions. */
export class FederationResultImports {
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly reader: FederationResultReader,
    private readonly clock: () => Date = () => new Date(),
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
    private readonly media?: () => FederationMediaImportOperations | undefined,
  ) {}

  async enqueue(
    actor: FederationActor,
    operationId: string,
    importId: string,
    lease?: LeasedWorkflowJournal,
  ) {
    z.uuid().parse(importId);
    z.uuid().parse(operationId);
    const transaction = <T>(operation: (tx: PgTransaction) => Promise<T>) =>
      lease
        ? lease.transaction(async (tx) => {
            await assertWorkflowDelegationBinding(tx, lease.runId, actor, this.siteId, operationId);
            return operation(tx);
          })
        : this.db.transaction(operation);
    const existing = await transaction(async (tx) => {
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
    return transaction(async (tx) => {
      // Serializes concurrent imports of the same remote operation without network under the lock.
      const [outbound] = await tx
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
      if (!outbound) throw new FederationError("ASSET_UNAVAILABLE");
      await renewTaskCompletion(tx, this.siteId, outbound.request, this.storageGuard);
      await this.reader.authorize(tx, actor, operationId);
      const reservedBytes = members.reduce((sum, file) => sum + file.sizeBytes, 0);
      await lockCloudWrites(tx, actor.userId);
      await new StorageQuotaService(tx, this.clock).assertCloudWritesAllowed(
        actor.userId,
        [],
        reservedBytes,
      );
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
          delivery: outbound.request.resultDelivery ?? "network",
          manifestDigest: verified.report.manifestDigest,
          reservedBytes,
          state: "pending",
          nextAttemptAt: this.clock(),
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

  async list(actor: FederationActor, operationId: string, limit = 20, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "result.read");
      const [outbound] = await tx
        .select({ id: federationOutbound.operationId })
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.siteId),
            eq(federationOutbound.localOrgId, actor.orgId),
            eq(federationOutbound.operationId, operationId),
          ),
        );
      if (!outbound) throw new FederationError("POLICY_DENIED");
      const rows = await tx
        .select()
        .from(federationResultImports)
        .where(
          and(
            eq(federationResultImports.localSiteId, this.siteId),
            eq(federationResultImports.localOrgId, actor.orgId),
            eq(federationResultImports.operationId, operationId),
            eq(federationResultImports.requestedBy, actor.userId),
          ),
        )
        .orderBy(asc(federationResultImports.createdAt), asc(federationResultImports.id))
        .limit(limit + 1)
        .offset(offset);
      const data = [];
      for (const row of rows.slice(0, limit)) data.push(await this.summary(tx, row));
      return { data, hasMore: rows.length > limit };
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

  async begin(transferId: string, agentId: string, mediaClaimId?: string) {
    const authorize = await this.transferAuthorization(transferId, agentId, mediaClaimId);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      await this.authorize(tx, rows.parent);
      if (rows.parent.reservedBytes === 0) {
        const bytes = rows.parent.report.manifest.outputs.reduce(
          (sum, output) => sum + output.sizeBytes,
          0,
        );
        await lockCloudWrites(tx, rows.parent.requestedBy);
        await new StorageQuotaService(tx, this.clock).assertCloudWritesAllowed(
          rows.parent.requestedBy,
          [],
          bytes,
        );
        await tx
          .update(federationResultImports)
          .set({ reservedBytes: bytes })
          .where(eq(federationResultImports.id, rows.parent.id));
      }
      const [agent] = await tx
        .select()
        .from(agents)
        .where(eq(agents.agentId, agentId))
        .for("share");
      if (!agent || agent.providerOrgId !== rows.parent.localOrgId || agent.status !== "online")
        throw new FederationError("POLICY_DENIED");
      await lockFederationTransferAgent(tx, agentId, this.clock());
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
      this.assertMediaDeadline(rows.authorizedUntil);
      const generation = crypto.randomUUID();
      const [attempt] = await tx
        .insert(federationResultAttempts)
        .values({
          generation,
          mediaClaimId: rows.mediaClaimId,
          transferId,
          agentId,
          storageKey: `federation-results/${rows.parent.id}/${generation}`,
          state: "preparing",
          leaseUntil: this.lease(rows.parent, rows.authorizedUntil),
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
        .set({ state: "transferring", lastError: null, updatedAt: this.clock() })
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
    const authorize = await this.attemptAuthorization(binding.generation, agentId, false);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
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
    const authorize = await this.attemptAuthorization(generation, agentId, false);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      await lockFederationTransferSlot(tx, agentId);
      await this.assertAttempt(tx, rows, agentId, "copying");
      const leaseUntil = this.lease(rows.parent, rows.authorizedUntil);
      await tx
        .update(federationResultAttempts)
        .set({ leaseUntil, updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, generation));
      return leaseUntil;
    });
  }

  async copied(agentId: string, input: z.infer<typeof CopiedSchema>) {
    const receipt = CopiedSchema.parse(input);
    const authorize = await this.attemptAuthorization(receipt.binding.generation, agentId, false);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      if (!["copying", "assembling", "verifying", "verified"].includes(rows.attempt.state))
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
      if (rows.attempt.state !== "copying") {
        if (
          federationMaterialDigest(rows.attempt.parts) !== federationMaterialDigest(receipt.parts)
        )
          throw new FederationError("OPERATION_CONFLICT");
        return { state: rows.attempt.state };
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

  async assembling(agentId: string, generation: string) {
    const authorize = await this.attemptAuthorization(generation, agentId, false);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      await this.assertAttempt(tx, rows, agentId, "assembling");
      return { ...rows, binding: this.binding(rows) };
    });
  }

  async assembled(
    agentId: string,
    generation: string,
    object: z.infer<typeof FederationResultObjectSchema>,
  ) {
    const pin = FederationResultObjectSchema.parse(object);
    const authorize = await this.attemptAuthorization(generation, agentId, true);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      await lockFederationTransferSlot(tx, agentId);
      await this.assertAttempt(tx, rows, agentId, "assembling");
      const leaseUntil = this.lease(rows.parent, rows.authorizedUntil);
      await tx
        .update(federationResultAttempts)
        .set({
          destinationVersionId: pin.versionId,
          destinationEtag: pin.etag,
          state: "verifying",
          leaseUntil,
          updatedAt: this.clock(),
        })
        .where(eq(federationResultAttempts.generation, generation));
      await tx
        .update(federationResultTransfers)
        .set({ state: "verifying", updatedAt: this.clock() })
        .where(eq(federationResultTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "assembled", { generation });
      return {
        task: {
          binding: this.binding(rows),
          object: pin,
          availableUntil: rows.parent.report.manifest.availableUntil,
        },
        leaseExpiresAt: leaseUntil.toISOString(),
      };
    });
  }

  async verificationTask(agentId: string, generation: string) {
    const authorize = await this.attemptAuthorization(generation, agentId, true);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      await this.assertAttempt(tx, rows, agentId, "verifying");
      const task = FederationResultVerifyTaskSchema.parse({
        binding: this.binding(rows),
        object: {
          etag: rows.attempt.destinationEtag,
          versionId: rows.attempt.destinationVersionId,
        },
        availableUntil: rows.parent.report.manifest.availableUntil,
      });
      return { task, leaseExpiresAt: rows.attempt.leaseUntil.toISOString() };
    });
  }

  async verification(agentId: string, input: FederationResultVerifyTask, renew = false) {
    const task = FederationResultVerifyTaskSchema.parse(input);
    const authorize = await this.attemptAuthorization(task.binding.generation, agentId, renew);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      if (!(renew ? ["verifying"] : ["verifying", "verified"]).includes(rows.attempt.state))
        throw new FederationError("OPERATION_CONFLICT");
      if (renew) await lockFederationTransferSlot(tx, agentId);
      await this.assertAttempt(tx, rows, agentId, rows.attempt.state);
      this.assertVerification(rows, task);
      const leaseUntil = renew
        ? this.lease(rows.parent, rows.authorizedUntil)
        : rows.attempt.leaseUntil;
      if (renew)
        await tx
          .update(federationResultAttempts)
          .set({ leaseUntil, updatedAt: this.clock() })
          .where(eq(federationResultAttempts.generation, task.binding.generation));
      return { storageKey: rows.attempt.storageKey, leaseUntil, state: rows.attempt.state };
    });
  }

  async verified(agentId: string, input: FederationResultVerified) {
    const receipt = FederationResultVerifiedSchema.parse(input);
    const authorize = await this.attemptAuthorization(receipt.binding.generation, agentId, true);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      if (!["verifying", "verified"].includes(rows.attempt.state))
        throw new FederationError("OPERATION_CONFLICT");
      await this.assertAttempt(tx, rows, agentId, rows.attempt.state);
      this.assertVerification(rows, receipt);
      if (receipt.sha256 !== rows.transfer.sha256 || receipt.sizeBytes !== rows.transfer.sizeBytes)
        throw new FederationError("INVALID_MESSAGE");
      if (rows.attempt.state === "verified") return;
      await tx
        .update(federationResultAttempts)
        .set({ state: "verified", verifiedAt: this.clock(), updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, receipt.binding.generation));
      await tx
        .update(federationResultTransfers)
        .set({ state: "verified", updatedAt: this.clock() })
        .where(eq(federationResultTransfers.id, rows.transfer.id));
      await this.audit(tx, rows.parent, "destination_verified", {
        generation: receipt.binding.generation,
      });
    });
  }

  private assertVerification(
    rows: { parent: Import; transfer: Transfer; attempt: Attempt },
    task: FederationResultVerifyTask,
  ) {
    if (
      federationMaterialDigest(this.binding(rows)) !== federationMaterialDigest(task.binding) ||
      rows.attempt.destinationEtag !== task.object.etag ||
      rows.attempt.destinationVersionId !== task.object.versionId ||
      task.availableUntil !== rows.parent.report.manifest.availableUntil
    )
      throw new FederationError("OPERATION_CONFLICT");
  }

  /** Snapshot for storage checks; no network operations run under these locks. */
  async publication(actor: FederationActor, importId: string) {
    const media = await this.publicationAuthorization(actor, importId);
    return this.db.transaction(async (tx) => {
      const permit = await media?.(tx);
      const parent = await this.lockImport(tx, actor, importId);
      await requireFederationCapability(tx, actor, "result.read");
      if (parent.state === "available")
        return { state: "available" as const, summary: await this.summary(tx, parent) };
      await this.authorize(tx, parent);
      return {
        state: "ready" as const,
        operationId: parent.operationId,
        manifestDigest: parent.manifestDigest,
        mediaClaimId: permit?.claimId ?? null,
        files: await this.publicationFiles(tx, parent, permit?.claimId),
      };
    });
  }

  /** Internal commit after fresh peer authorization and version-pinned storage checks. */
  async publish(
    actor: FederationActor,
    importId: string,
    snapshot: Extract<
      Awaited<ReturnType<FederationResultImports["publication"]>>,
      { state: "ready" }
    >,
    verified: Awaited<ReturnType<FederationResultReader["read"]>>,
  ) {
    const media = await this.publicationAuthorization(actor, importId, snapshot.mediaClaimId);
    return this.db.transaction(async (tx) => {
      const permit = await media?.(tx);
      const parent = await this.lockImport(tx, actor, importId);
      await requireFederationCapability(tx, actor, "result.read");
      if (parent.state === "available") return this.summary(tx, parent);
      await this.authorize(tx, parent);
      const report = verified.report;
      const assertFresh = () => {
        this.assertMediaDeadline(permit?.authorizedUntil);
        const verifiedAt = Date.parse(verified.verifiedAt);
        if (
          !Number.isFinite(verifiedAt) ||
          verifiedAt > this.clock().getTime() ||
          verifiedAt + 30_000 <= this.clock().getTime() ||
          Date.parse(parent.report.manifest.availableUntil) <= this.clock().getTime()
        )
          throw new FederationError("AUTHORIZATION_EXPIRED");
      };
      assertFresh();
      if (
        report.operationId !== parent.operationId ||
        report.manifestDigest !== parent.manifestDigest ||
        federationMaterialDigest(report.manifest) !== parent.manifestDigest ||
        snapshot.operationId !== parent.operationId ||
        snapshot.manifestDigest !== parent.manifestDigest ||
        report.senderSiteId !== parent.report.senderSiteId ||
        report.recipientSiteId !== this.siteId
      )
        throw new FederationError("OPERATION_CONFLICT");
      await new FederationTrustRegistry(this.db).assertKey(
        tx,
        report.senderSiteId,
        federationMessageKeyId(verified.reportJws),
        this.clock(),
      );
      const files = await this.publicationFiles(tx, parent, permit?.claimId);
      if (federationMaterialDigest(files) !== federationMaterialDigest(snapshot.files))
        throw new FederationError("OPERATION_CONFLICT");
      await lockCloudWrites(tx, actor.userId);
      if (files.length) {
        const [collision] = await tx
          .select({ id: netdriveFiles.id })
          .from(netdriveFiles)
          .where(
            and(
              eq(netdriveFiles.ownerId, actor.userId),
              isNull(netdriveFiles.deletedAt),
              inArray(
                netdriveFiles.path,
                files.map((file) => file.path),
              ),
            ),
          )
          .limit(1);
        if (collision) throw new FederationError("OPERATION_CONFLICT");
      }
      // Reservation and all visible files change atomically, so quota is counted exactly once.
      await tx
        .update(federationResultImports)
        .set({ reservedBytes: 0 })
        .where(eq(federationResultImports.id, parent.id));
      await new StorageQuotaService(tx, this.clock).assertCloudWritesAllowed(actor.userId, files);
      if (files.length) {
        await tx.insert(netdriveFiles).values(
          files.map((file) => ({
            id: file.id,
            ownerId: actor.userId,
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            storageKey: file.storageKey,
            storageVersionId: file.versionId,
            etag: file.etag,
            mtime: this.clock(),
            createdAt: this.clock(),
          })),
        );
        await tx
          .update(federationResultAttempts)
          .set({ state: "available", updatedAt: this.clock() })
          .where(
            inArray(
              federationResultAttempts.generation,
              files.map((file) => file.generation),
            ),
          );
        await tx
          .update(federationResultTransfers)
          .set({ state: "available", updatedAt: this.clock() })
          .where(eq(federationResultTransfers.importId, parent.id));
      }
      assertFresh();
      const receipt = FederationResultReceiptSchema.parse({
        protocolVersion: 1,
        kind: "result-receipt",
        receiptId: parent.id,
        senderSiteId: this.siteId,
        recipientSiteId: report.senderSiteId,
        operationId: parent.operationId,
        agreementRevisionId: report.agreementRevisionId,
        taskId: report.taskId,
        attempt: report.attempt,
        reservationId: report.reservationId,
        requestDigest: report.requestDigest,
        manifestDigest: parent.manifestDigest,
        fileCount: files.length,
        sizeBytes: files.reduce((sum, file) => sum + file.size, 0),
        receivedAt: this.clock().toISOString(),
      });
      const [published] = await tx
        .update(federationResultImports)
        .set({
          state: "available",
          receipt,
          receiptNextAttemptAt: this.clock(),
          lastError: null,
          updatedAt: this.clock(),
        })
        .where(eq(federationResultImports.id, parent.id))
        .returning();
      if (!published) throw new FederationError("OPERATION_CONFLICT");
      await this.audit(tx, parent, "published", { manifestDigest: parent.manifestDigest });
      return this.summary(tx, published);
    });
  }

  private async lockImport(tx: FederationTransaction, actor: FederationActor, importId: string) {
    const [parent] = await tx
      .select()
      .from(federationResultImports)
      .where(eq(federationResultImports.id, importId))
      .for("update");
    if (!parent) throw new FederationError("POLICY_DENIED");
    this.assertOwner(parent, actor, parent.operationId);
    return parent;
  }

  private async publicationAuthorization(
    actor: FederationActor,
    importId: string,
    claimId?: string | null,
  ) {
    // Check the original owner and current permission before triggering any source refresh.
    const parent = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "result.read");
      const [row] = await tx
        .select()
        .from(federationResultImports)
        .where(eq(federationResultImports.id, importId));
      if (!row) throw new FederationError("POLICY_DENIED");
      this.assertOwner(row, actor, row.operationId);
      if (row.state !== "available") await this.authorize(tx, row);
      return row;
    });
    if (parent.state === "available") return undefined;
    if (parent.delivery !== "media") {
      if (claimId) throw new FederationError("OPERATION_CONFLICT");
      return undefined;
    }
    if (claimId === null) throw new FederationError("OPERATION_CONFLICT");
    const operations = this.media?.();
    if (!operations) throw new FederationError("POLICY_DENIED");
    return operations.uploadForImport({ kind: "task-result", importId, claimId, refresh: true });
  }

  private async publicationFiles(tx: FederationTransaction, parent: Import, claimId?: string) {
    if ((parent.delivery === "media") !== !!claimId)
      throw new FederationError("OPERATION_CONFLICT");
    const members = await tx
      .select()
      .from(federationResultTransfers)
      .where(eq(federationResultTransfers.importId, parent.id))
      .orderBy(asc(federationResultTransfers.outputId), asc(federationResultTransfers.path));
    const expected = parent.report.manifest.outputs.flatMap((output) =>
      output.files.map((file) => ({ outputId: output.outputId, ...file })),
    );
    if (
      members.length !== expected.length ||
      members.some(
        (member) =>
          !expected.some(
            (file) =>
              file.outputId === member.outputId &&
              file.path === member.path &&
              file.sizeBytes === member.sizeBytes &&
              file.sha256 === member.sha256,
          ),
      )
    )
      throw new FederationError("OPERATION_CONFLICT");
    const attempts = members.length
      ? await tx
          .select()
          .from(federationResultAttempts)
          .where(
            and(
              inArray(
                federationResultAttempts.transferId,
                members.map((member) => member.id),
              ),
              eq(federationResultAttempts.state, "verified"),
            ),
          )
      : [];
    return members.map((member) => {
      const attempt = attempts.find((row) => row.transferId === member.id);
      if (member.state !== "verified" || !attempt?.verifiedAt || !attempt.destinationEtag)
        throw new FederationError("DATA_WAITING");
      if (
        attempt.mediaClaimId !== (claimId ?? null) ||
        attempt.storageKey !== `federation-results/${parent.id}/${attempt.generation}`
      )
        throw new FederationError("OPERATION_CONFLICT");
      // Cloud downloads must keep serving the verified bytes after a same-key overwrite.
      if (!attempt.destinationVersionId || attempt.destinationVersionId === "null")
        throw new FederationError("POLICY_DENIED");
      return {
        id: member.id,
        generation: attempt.generation,
        path: `federation-results/${parent.id}/${member.outputId.replace("sha256:", "")}/${member.path}`,
        size: member.sizeBytes,
        sha256: member.sha256,
        storageKey: attempt.storageKey,
        versionId: attempt.destinationVersionId,
        etag: attempt.destinationEtag,
      };
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
        await this.releaseCancelledReservation(tx, { ...row, state: "cancelled" });
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
      await this.releaseCancelledReservation(tx, rows.parent);
      await this.audit(tx, rows.parent, "storage_cleaned", {
        transferId: rows.transfer.id,
        generation,
      });
    });
  }

  private async releaseCancelledReservation(tx: FederationTransaction, parent: Import) {
    if (parent.state !== "cancelled" || parent.reservedBytes === 0) return;
    const [remaining] = await tx
      .select({ generation: federationResultAttempts.generation })
      .from(federationResultAttempts)
      .innerJoin(
        federationResultTransfers,
        eq(federationResultTransfers.id, federationResultAttempts.transferId),
      )
      .where(
        and(
          eq(federationResultTransfers.importId, parent.id),
          ne(federationResultAttempts.state, "cleaned"),
        ),
      )
      .limit(1);
    if (!remaining)
      await tx
        .update(federationResultImports)
        .set({ reservedBytes: 0 })
        .where(eq(federationResultImports.id, parent.id));
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

  async pending(onlineAgentIds: readonly string[], limit = 20) {
    if (!onlineAgentIds.length) return [];
    z.number().int().min(1).max(100).parse(limit);
    return this.db
      .select({
        transferId: federationResultTransfers.id,
        importId: federationResultImports.id,
        agentId: agents.agentId,
      })
      .from(federationResultTransfers)
      .innerJoin(
        federationResultImports,
        eq(federationResultImports.id, federationResultTransfers.importId),
      )
      .innerJoin(agents, eq(agents.providerOrgId, federationResultImports.localOrgId))
      .where(
        and(
          eq(federationResultImports.localSiteId, this.siteId),
          inArray(federationResultImports.state, ["pending", "transferring"]),
          eq(federationResultImports.delivery, "network"),
          eq(federationResultTransfers.state, "pending"),
          lte(federationResultImports.nextAttemptAt, this.clock()),
          notExists(
            this.db
              .select({ id: federationResultAttempts.generation })
              .from(federationResultAttempts)
              .where(
                and(
                  eq(federationResultAttempts.agentId, agents.agentId),
                  inArray(federationResultAttempts.state, [...activeStates, "cleanup_pending"]),
                  gte(federationResultAttempts.leaseUntil, this.clock()),
                ),
              ),
          ),
          notExists(
            this.db
              .select({ id: federationInputAttempts.generation })
              .from(federationInputAttempts)
              .where(
                and(
                  eq(federationInputAttempts.agentId, agents.agentId),
                  inArray(federationInputAttempts.state, [...activeStates, "cleanup_pending"]),
                  gte(federationInputAttempts.leaseUntil, this.clock()),
                ),
              ),
          ),
          inArray(agents.agentId, [...onlineAgentIds]),
          eq(agents.status, "online"),
        ),
      )
      .orderBy(
        asc(federationResultTransfers.createdAt),
        asc(federationResultTransfers.id),
        asc(agents.agentId),
      )
      .limit(limit);
  }

  async nextPublication() {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(federationResultImports)
        .where(
          and(
            eq(federationResultImports.localSiteId, this.siteId),
            inArray(federationResultImports.state, ["pending", "transferring", "verifying"]),
            lte(federationResultImports.nextAttemptAt, this.clock()),
            notExists(
              tx
                .select({ id: federationResultTransfers.id })
                .from(federationResultTransfers)
                .where(
                  and(
                    eq(federationResultTransfers.importId, federationResultImports.id),
                    ne(federationResultTransfers.state, "verified"),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(federationResultImports.nextAttemptAt), asc(federationResultImports.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      await tx
        .update(federationResultImports)
        .set({ nextAttemptAt: new Date(this.clock().getTime() + 30_000) })
        .where(eq(federationResultImports.id, row.id));
      return { id: row.id, actor: this.actor(row) };
    });
  }

  async processingFailed(importId: string, code: string) {
    await this.db
      .update(federationResultImports)
      .set({ lastError: code, nextAttemptAt: new Date(this.clock().getTime() + 30_000) })
      .where(
        and(
          eq(federationResultImports.id, importId),
          eq(federationResultImports.localSiteId, this.siteId),
          inArray(federationResultImports.state, ["pending", "transferring", "verifying"]),
        ),
      );
  }

  async preparing(agentId: string, generation: string) {
    const authorize = await this.attemptAuthorization(generation, agentId, false);
    return this.db.transaction(async (tx) => {
      const rows = await authorize(tx);
      await this.assertAttempt(tx, rows, agentId, "preparing");
      return { ...rows, actor: this.actor(rows.parent), binding: this.binding(rows) };
    });
  }

  async cleanupCandidates(limit = 20) {
    z.number().int().min(1).max(100).parse(limit);
    // Revisit cleaned keys: an S3 create can finish after a lost response and a process crash.
    return this.db
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
          lte(federationResultAttempts.leaseUntil, this.clock()),
          or(
            eq(federationResultAttempts.state, "cleanup_pending"),
            and(
              eq(federationResultAttempts.state, "cleaned"),
              lte(
                federationResultAttempts.updatedAt,
                new Date(this.clock().getTime() - 24 * 60 * 60_000),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(federationResultAttempts.updatedAt), asc(federationResultAttempts.generation))
      .limit(limit);
  }

  async beginCleanup(generation: string) {
    return this.db.transaction(async (tx) => {
      const rows = await this.lockAttempt(tx, generation);
      if (
        !["cleanup_pending", "cleaned"].includes(rows.attempt.state) ||
        rows.attempt.leaseUntil > this.clock()
      )
        throw new FederationError("OPERATION_CONFLICT");
      await tx
        .update(federationResultAttempts)
        .set({ state: "cleanup_pending", updatedAt: this.clock() })
        .where(eq(federationResultAttempts.generation, generation));
      if (!(await this.hasOtherLiveAttempt(tx, rows.attempt)))
        await tx
          .update(federationResultTransfers)
          .set({
            state: rows.parent.state === "cancelled" ? "cancelled" : "cleanup_pending",
            updatedAt: this.clock(),
          })
          .where(eq(federationResultTransfers.id, rows.transfer.id));
      return { storageKey: rows.attempt.storageKey, uploadId: rows.attempt.uploadId };
    });
  }

  private async transferAuthorization(
    transferId: string,
    agentId: string,
    claimId?: string | null,
    refresh = false,
  ) {
    const [selected] = await this.db
      .select({ parent: federationResultImports })
      .from(federationResultTransfers)
      .innerJoin(
        federationResultImports,
        eq(federationResultImports.id, federationResultTransfers.importId),
      )
      .where(eq(federationResultTransfers.id, transferId));
    if (!selected || selected.parent.localSiteId !== this.siteId)
      throw new FederationError("POLICY_DENIED");
    const operations = this.media?.();
    if (selected.parent.delivery === "media" ? !claimId || !operations : !!claimId)
      throw new FederationError("POLICY_DENIED");
    const media =
      selected.parent.delivery === "media" && operations
        ? await operations.uploadForImport({
            kind: "task-result",
            importId: selected.parent.id,
            agentId,
            claimId: claimId ?? undefined,
            refresh,
          })
        : undefined;
    return async (tx: PgTransaction) => {
      const permit = await media?.(tx);
      const rows = await this.lockTransfer(tx, transferId);
      if (rows.parent.id !== selected.parent.id || (rows.parent.delivery === "media") !== !!permit)
        throw new FederationError("OPERATION_CONFLICT");
      this.assertMediaDeadline(permit?.authorizedUntil);
      return {
        ...rows,
        mediaClaimId: permit?.claimId ?? null,
        authorizedUntil: permit?.authorizedUntil,
      };
    };
  }

  private async attemptAuthorization(generation: string, agentId: string, refresh = false) {
    const [attempt] = await this.db
      .select()
      .from(federationResultAttempts)
      .where(eq(federationResultAttempts.generation, generation));
    if (!attempt) throw new FederationError("POLICY_DENIED");
    if (attempt.agentId !== agentId) throw new FederationError("OPERATION_CONFLICT");
    const authorize = await this.transferAuthorization(
      attempt.transferId,
      agentId,
      attempt.mediaClaimId,
      refresh,
    );
    return async (tx: PgTransaction) => {
      const permit = await authorize(tx);
      const rows = await this.lockAttempt(tx, generation);
      if (
        rows.transfer.id !== permit.transfer.id ||
        rows.attempt.mediaClaimId !== permit.mediaClaimId ||
        rows.attempt.storageKey !== `federation-results/${rows.parent.id}/${generation}`
      )
        throw new FederationError("OPERATION_CONFLICT");
      this.assertMediaDeadline(permit.authorizedUntil);
      return {
        ...rows,
        attempt: {
          ...rows.attempt,
          leaseUntil: new Date(
            Math.min(rows.attempt.leaseUntil.getTime(), permit.authorizedUntil ?? Infinity),
          ),
        },
        authorizedUntil: permit.authorizedUntil,
      };
    };
  }

  private assertMediaDeadline(authorizedUntil?: number) {
    if (authorizedUntil !== undefined && authorizedUntil <= this.clock().getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");
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
    rows: { parent: Import; transfer: Transfer; attempt: Attempt; authorizedUntil?: number },
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
    this.assertMediaDeadline(rows.authorizedUntil);
  }
  private async authorize(tx: FederationTransaction, row: Import) {
    if (
      !["pending", "transferring", "verifying"].includes(row.state) ||
      row.localSiteId !== this.siteId
    )
      throw new FederationError("POLICY_DENIED");
    if (federationMaterialDigest(row.report.manifest) !== row.manifestDigest)
      throw new FederationError("OPERATION_CONFLICT");
    const { row: outbound } = await this.reader.authorize(tx, this.actor(row), row.operationId);
    if (row.delivery !== (outbound.request.resultDelivery ?? "network"))
      throw new FederationError("OPERATION_CONFLICT");
  }
  private actor(row: Import) {
    return { orgId: row.localOrgId, userId: row.requestedBy };
  }
  private lease(row: Import, authorizedUntil = Infinity) {
    return new Date(
      Math.min(
        this.clock().getTime() + 120_000,
        Date.parse(row.report.manifest.availableUntil),
        authorizedUntil,
      ),
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
      lastError: row.lastError,
      delivery: row.delivery,
      receipt: row.receipt
        ? {
            state: row.receiptAck ? "recorded" : "pending",
            receivedAt: row.receipt.receivedAt,
            recordedAt: row.receiptAck?.recordedAt ?? null,
            lastError: row.receiptLastError,
          }
        : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      members: members.map((member) => ({
        ...member,
        fileId: member.state === "available" ? member.id : null,
      })),
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
