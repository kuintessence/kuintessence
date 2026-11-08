import {
  auditLog,
  federationAgreementApprovals,
  federationOutbound,
  federationResultImports,
  federationSites,
  type PgDb,
  type PgTransaction,
  workflowExecutionDelegations,
  workflowRuns,
} from "@kuintessence/db";
import {
  AppError,
  createLogger,
  type NodeInvocation,
  WorkflowNodeWaiting,
} from "@kuintessence/shared";
import {
  assertDelegationPolicy,
  assertDelegationTerms,
  assertFederationStatusQueryFresh,
  assertFederationStatusReport,
  FEDERATION_MATERIAL_CHUNK_BYTES,
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  type FederationAssetRef,
  FederationDataOriginSchema,
  type FederationDelegation,
  FederationDelegationSchema,
  FederationError,
  FederationInputDownloadGrantSchema,
  FederationInputDownloadQuerySchema,
  FederationMaterialChunkSchema,
  type FederationMaterialQuery,
  FederationMaterialQuerySchema,
  type FederationParameterOverrides,
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
  federationCanonicalJson,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import {
  type FederationWorkflowMarket,
  FederationWorkflowMarketSchema,
} from "@kuintessence/shared/federation/market";
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import type { FederationAssetService } from "./assets";
import { cancellationSummary, FederationCancellationSender } from "./cancellation-outbound";
import { allocateTaskCompletion } from "./completion-capacity";
import { type FederationDownloadStorage, signedDownloadExpiry } from "./download-credential";
import type { FederationExecutionConfirmationService } from "./execution-confirmation";
import { stopCancelledExecution } from "./execution-stop";
import { FabricClientFailure } from "./fabric-client";
import { FederationWorkflowInputExports } from "./input-exports";
import type { FederationMarketRequestService } from "./market-requests";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { FederationResultImports } from "./result-imports";
import { FederationResultReader } from "./result-reader";
import { FederationResultReceiptSender } from "./result-receipts";
import {
  type FederationSigningKey,
  type FederationVerificationKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import type { FederationStorageGuard } from "./storage-capacity";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";
import {
  assertWorkflowDelegationCapacity,
  assertWorkflowDelegationOwner,
  bindWorkflowDelegation,
  type WorkflowDelegationPlan,
} from "./workflow-delegations";

type Outbound = typeof federationOutbound.$inferSelect;
const logger = createLogger("federation-outbound");
function summary(row: Outbound) {
  return {
    operationId: row.operationId,
    agreementRevisionId: row.agreementRevisionId,
    taskId: row.taskId,
    attempt: row.attempt,
    state: row.state,
    lastError: row.lastError,
    receipt: row.receipt,
    cancellation: cancellationSummary(row),
    remoteStatus: {
      preparation: row.statusReport?.preparation ?? null,
      workflow: row.statusReport?.workflow ?? null,
      observedAt: row.statusReport?.observedAt ?? null,
      verifiedAt: row.statusVerifiedAt,
      lastError: row.statusLastError,
      nextAttemptAt: row.statusNextAttemptAt,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Durable source delivery. Acceptance is not execution, settlement or permission to retry a task. */
export class FederationOutboundService {
  private readonly trust: FederationTrustRegistry;
  private readonly inputExports = new FederationWorkflowInputExports();
  readonly cancellations: FederationCancellationSender;
  readonly results: FederationResultReader;
  readonly resultReceipts: FederationResultReceiptSender;
  readonly resultImports: FederationResultImports;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly assets: FederationAssetService,
    private readonly clock: () => Date = () => new Date(),
    private readonly confirmations?: FederationExecutionConfirmationService,
    private readonly marketRequests?: FederationMarketRequestService,
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) {
    this.trust = new FederationTrustRegistry(db);
    this.resultReceipts = new FederationResultReceiptSender(db, signingKey, send, clock);
    this.results = new FederationResultReader(db, signingKey, send, clock);
    this.resultImports = new FederationResultImports(db, signingKey.siteId, this.results, clock);
    this.cancellations = new FederationCancellationSender(db, signingKey, send, clock);
  }

  private key(operationId: string) {
    return and(
      eq(federationOutbound.localSiteId, this.signingKey.siteId),
      eq(federationOutbound.operationId, operationId),
    );
  }

  private async materials(actor: FederationActor, request: FederationDelegation) {
    const references = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "delegation.submit");
      const inputs = await this.assets.readMaterial(
        tx,
        actor.orgId,
        this.signingKey.siteId,
        request.inputManifestDigest,
      );
      const environment = await this.assets.readMaterial(
        tx,
        actor.orgId,
        this.signingKey.siteId,
        request.environmentLockDigest,
      );
      if (inputs.kind !== "inputs" || environment.kind !== "environment-lock")
        throw new FederationError("INVALID_MESSAGE");
      return [
        request.template,
        ...inputs.bindings.map((v) => v.asset),
        ...inputs.datasets.map((v) => v.asset),
        ...environment.software.map((v) => v.asset),
      ];
    });
    const selected = new Map<string, FederationAssetRef>(
      references.map((ref) => [federationCanonicalJson(ref), ref]),
    );
    const mappings: Array<{ reference: FederationAssetRef; mappingId: string }> = [];
    for (const reference of selected.values()) {
      const resolved = await this.assets.resolveForDelegation(actor, reference);
      mappings.push({ reference, mappingId: resolved.mapping.id });
    }
    return mappings;
  }

  private async authorize(
    tx: FederationTransaction,
    actor: FederationActor,
    request: FederationDelegation,
    materials: Awaited<ReturnType<FederationOutboundService["materials"]>>,
    allowReplay = false,
  ) {
    const [binding] = await tx
      .select()
      .from(workflowExecutionDelegations)
      .where(
        and(
          eq(workflowExecutionDelegations.localSiteId, this.signingKey.siteId),
          eq(workflowExecutionDelegations.operationId, request.operationId),
        ),
      );
    if (binding) {
      const run = await assertWorkflowDelegationOwner(tx, binding.runId, actor);
      if (run.status !== "running") throw new FederationError("CANCELLATION_REQUESTED");
      if (federationCanonicalJson(binding.request) !== federationCanonicalJson(request))
        throw new FederationError("OPERATION_CONFLICT");
    }
    await requireFederationCapability(tx, actor, "delegation.submit");
    for (const material of materials)
      await this.assets.assertResolved(tx, actor, material.reference, material.mappingId);
    if (request.senderSiteId !== this.signingKey.siteId) throw new FederationError("POLICY_DENIED");
    if (request.mode === "ledger_coordinated" && !this.confirmations)
      throw new FederationError("LEDGER_REQUIRED");
    if (request.mode === "ledger_coordinated")
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${request.agreementRevisionId}, 0))`,
      );
    const confirmation =
      request.mode === "ledger_coordinated"
        ? await this.confirmations?.authorize(
            tx,
            actor.orgId,
            request,
            allowReplay ? "execution" : "admission",
          )
        : undefined;
    const [approval] = await tx
      .select()
      .from(federationAgreementApprovals)
      .where(
        and(
          eq(federationAgreementApprovals.localSiteId, this.signingKey.siteId),
          eq(federationAgreementApprovals.revisionId, request.agreementRevisionId),
          eq(federationAgreementApprovals.localOrgId, actor.orgId),
        ),
      )
      .for("update");
    if (!approval || approval.state !== "active" || !approval.counterpartyApprovalJws)
      throw new FederationError("AGREEMENT_UNAVAILABLE");
    const terms = FederationAgreementSchema.parse(approval.terms);
    const now = this.clock();
    // Expired delivery may only replay the original request to recover an already issued receipt.
    // A receiver that has no reservation still applies the original admission deadline.
    (confirmation ? assertDelegationTerms : assertDelegationPolicy)(
      terms,
      request,
      allowReplay ? new Date(Math.min(now.getTime(), Date.parse(request.expiresAt) - 1)) : now,
    );
    for (const [siteId, jws] of [
      [terms.sourceSiteId, approval.approvalJws],
      [terms.targetSiteId, approval.counterpartyApprovalJws],
    ].sort(([a], [b]) => (a ?? "").localeCompare(b ?? ""))) {
      if (!siteId || !jws) throw new FederationError("AGREEMENT_UNAVAILABLE");
      const keyId = federationMessageKeyId(jws);
      await this.trust.assertKey(tx, siteId, keyId, now);
      const key = await this.trust.resolveKey(siteId, keyId, now, tx);
      const verified = await verifyFederationMessage(FederationAgreementSchema, jws, key, now);
      if (
        verified.digest !== approval.termsDigest ||
        JSON.stringify(verified.payload) !== JSON.stringify(terms)
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    await this.trust.assertKey(tx, this.signingKey.siteId, this.signingKey.keyId, now);
    const ownKey = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      now,
      tx,
    );
    if (!ownKey.allowedKinds.includes("delegation"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const [target] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, terms.targetSiteId));
    if (!target) throw new FederationError("UNTRUSTED_IDENTITY");
    const inputExport = await this.inputExports.forDelegation(tx, actor, request, terms);
    if (confirmation && confirmation.expiresAtUnixMs <= this.clock().getTime())
      throw new FabricClientFailure("LEDGER_PENDING");
    return { terms, ownKey, endpoint: target.endpoint, inputExport, confirmation };
  }

  async enqueue(actor: FederationActor, raw: FederationDelegation) {
    return this.enqueueRequest(actor, raw);
  }

  async enqueueForWorkflow(
    actor: FederationActor,
    lease: LeasedWorkflowJournal,
    nodeId: string,
    invocation: NodeInvocation,
    plan: WorkflowDelegationPlan,
    admissionWindowSec: number,
    parameters: FederationParameterOverrides = {},
    files?: unknown,
    market?: FederationWorkflowMarket,
  ) {
    if (plan.senderSiteId !== this.signingKey.siteId) throw new FederationError("POLICY_DENIED");
    const selection =
      market === undefined ? undefined : FederationWorkflowMarketSchema.parse(market);
    if ((plan.mode === "ledger_coordinated") !== !!selection)
      throw new FederationError("POLICY_DENIED");
    if (selection && !this.marketRequests) throw new FederationError("LEDGER_REQUIRED");
    await assertWorkflowDelegationCapacity(
      lease,
      actor,
      nodeId,
      invocation,
      plan,
      this.storageGuard,
    );
    if (files !== undefined) {
      const snapshot = await this.inputExports.capture(actor, lease, nodeId, invocation, files);
      if (plan.inputFilesDigest && plan.inputFilesDigest !== snapshot.manifestDigest)
        throw new FederationError("OPERATION_CONFLICT");
      plan = { ...plan, inputFilesDigest: snapshot.manifestDigest };
    }
    if (Object.keys(parameters).length) {
      const inputs = await lease.transaction(async (tx) => {
        await assertWorkflowDelegationOwner(tx, lease.runId, actor);
        return this.assets.deriveWorkflowInputs(
          tx,
          actor,
          this.signingKey.siteId,
          plan.inputManifestDigest,
          parameters,
        );
      });
      plan = { ...plan, inputManifestDigest: inputs.digest };
    }
    const request = await bindWorkflowDelegation(
      lease,
      actor,
      nodeId,
      invocation,
      plan,
      admissionWindowSec,
      this.clock,
      selection,
      this.storageGuard,
    );
    return this.enqueueRequest(actor, request, lease, selection);
  }

  private async enqueueRequest(
    actor: FederationActor,
    raw: FederationDelegation,
    lease?: LeasedWorkflowJournal,
    market?: FederationWorkflowMarket,
  ) {
    const request = FederationDelegationSchema.parse(raw);
    const transaction = <T>(operation: (tx: PgTransaction) => Promise<T>) =>
      lease
        ? lease.transaction(async (tx) => {
            await assertWorkflowDelegationOwner(tx, lease.runId, actor);
            return operation(tx);
          })
        : this.db.transaction(operation);
    const prior = await transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "delegation.submit");
      if (!lease) {
        const [binding] = await tx
          .select({ runId: workflowExecutionDelegations.runId })
          .from(workflowExecutionDelegations)
          .where(
            and(
              eq(workflowExecutionDelegations.localSiteId, this.signingKey.siteId),
              eq(workflowExecutionDelegations.operationId, request.operationId),
            ),
          );
        if (binding) throw new FederationError("POLICY_DENIED");
      }
      const [row] = await tx.select().from(federationOutbound).where(this.key(request.operationId));
      if (!row) return undefined;
      if (
        row.localOrgId !== actor.orgId ||
        row.submittedBy !== actor.userId ||
        federationCanonicalJson(row.request) !== federationCanonicalJson(request)
      )
        throw new FederationError("OPERATION_CONFLICT");
      return summary(row);
    });
    if (prior) return prior;
    const materials = await this.materials(actor, request);
    if (lease && market) {
      if (!this.marketRequests) throw new FederationError("LEDGER_REQUIRED");
      const marketRequests = this.marketRequests;
      const ready = await lease.transaction(async (tx) => {
        await assertWorkflowDelegationOwner(tx, lease.runId, actor);
        for (const material of materials)
          await this.assets.assertResolved(tx, actor, material.reference, material.mappingId);
        const environment = await this.assets.readMaterial(
          tx,
          actor.orgId,
          this.signingKey.siteId,
          request.environmentLockDigest,
        );
        if (environment.kind !== "environment-lock") throw new FederationError("INVALID_MESSAGE");
        return marketRequests.prepareWorkflow(
          tx,
          actor,
          lease.runId,
          request,
          market,
          environment.target,
        );
      });
      if (!ready) throw new WorkflowNodeWaiting("LEDGER_WAITING");
    }
    if (request.mode === "ledger_coordinated") {
      if (!this.confirmations) throw new FederationError("LEDGER_REQUIRED");
      await this.confirmations.refreshForExecution(actor.orgId, request, "admission");
    }
    const authorized = await this.db.transaction((tx) =>
      this.authorize(tx, actor, request, materials, true),
    );
    const requestJws = await signFederationMessage(
      FederationDelegationSchema,
      request,
      this.signingKey,
    );
    const verified = await verifyFederationMessage(
      FederationDelegationSchema,
      requestJws,
      authorized.ownKey,
      this.clock(),
    );
    return transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "delegation.submit");
      const existing = async () => {
        const [row] = await tx
          .select()
          .from(federationOutbound)
          .where(this.key(request.operationId));
        if (!row) return undefined;
        if (
          row.localOrgId !== actor.orgId ||
          row.submittedBy !== actor.userId ||
          row.requestDigest !== verified.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
        return summary(row);
      };
      const prior = await existing();
      if (prior) return prior;
      // Workflow bindings and coordinated approvals already accepted this intent durably.
      if (!lease && request.mode !== "ledger_coordinated")
        await this.storageGuard?.assertAdmission(request.mode);
      const { terms, endpoint, confirmation } = await this.authorize(
        tx,
        actor,
        request,
        materials,
        true,
      );
      // Another request can commit while authorization waits for institutional locks.
      const duplicate = await existing();
      if (duplicate) return duplicate;
      (confirmation ? assertDelegationTerms : assertDelegationPolicy)(terms, request, this.clock());
      // One source budget epoch cannot be copied to another agreement or recipient.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${this.signingKey.siteId}:${request.budgetDomainId}:${request.epoch}`}, 0))`,
      );
      const [held] = await tx
        .select({
          conflictingRevision: sql<boolean>`coalesce(bool_or(${federationOutbound.agreementRevisionId} <> ${request.agreementRevisionId}), false)`,
          amount: sql<string>`coalesce(sum(coalesce(${federationOutbound.settledAmount}, ${federationOutbound.amount}) + ${federationOutbound.adjustmentHeldAmount}), 0)::text`,
          count: sql<number>`count(*) FILTER (WHERE ${federationOutbound.settledAmount} IS NULL)::integer`,
        })
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.signingKey.siteId),
            ...(confirmation
              ? [eq(federationOutbound.agreementRevisionId, request.agreementRevisionId)]
              : [
                  eq(federationOutbound.budgetDomainId, request.budgetDomainId),
                  eq(federationOutbound.epoch, request.epoch),
                ]),
          ),
        );
      if (!held) throw new Error("Source budget aggregate is unavailable");
      if (held.conflictingRevision) throw new FederationError("OPERATION_CONFLICT");
      if (
        held.count >= terms.maxReservations ||
        (!confirmation &&
          BigInt(held.amount) + BigInt(request.maxAmount) > BigInt(terms.budgetLimit))
      )
        throw new FederationError("BUDGET_EXHAUSTED");
      if (confirmation) await this.confirmations?.authorize(tx, actor.orgId, request, "admission");
      await allocateTaskCompletion(tx, this.signingKey.siteId, request, this.storageGuard);
      (confirmation ? assertDelegationTerms : assertDelegationPolicy)(terms, request, this.clock());
      const [created] = await tx
        .insert(federationOutbound)
        .values({
          localSiteId: this.signingKey.siteId,
          operationId: request.operationId,
          agreementRevisionId: request.agreementRevisionId,
          localOrgId: actor.orgId,
          submittedBy: actor.userId,
          taskId: request.taskId,
          attempt: request.attempt,
          budgetDomainId: request.budgetDomainId,
          epoch: request.epoch,
          amount: request.maxAmount,
          endpoint,
          request,
          requestJws,
          requestDigest: verified.digest,
          nextAttemptAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning();
      if (!created) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.delegation.enqueue",
        target: request.operationId,
        diff: {
          after: {
            agreementRevisionId: request.agreementRevisionId,
            requestDigest: verified.digest,
          },
        },
      });
      return summary(created);
    });
  }

  /** Called only after the parent run has durably entered cancelling. */
  async cancelWorkflow(runId: string): Promise<void> {
    const operations = await this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, runId))
        .for("update");
      if (run?.status !== "cancelling") throw new FederationError("POLICY_DENIED");
      const bindings = await tx
        .select()
        .from(workflowExecutionDelegations)
        .where(
          and(
            eq(workflowExecutionDelegations.runId, runId),
            eq(workflowExecutionDelegations.localSiteId, this.signingKey.siteId),
          ),
        );
      for (const binding of bindings) {
        if (!run.submittedBy || typeof run.input?.orgId !== "string")
          throw new FederationError("POLICY_DENIED");
        await stopCancelledExecution(
          tx,
          this.signingKey.siteId,
          { userId: run.submittedBy, orgId: run.input.orgId },
          binding.request,
        );
      }
      return tx
        .select({
          operationId: workflowExecutionDelegations.operationId,
          userId: federationOutbound.submittedBy,
          orgId: federationOutbound.localOrgId,
        })
        .from(workflowExecutionDelegations)
        .innerJoin(
          federationOutbound,
          and(
            eq(federationOutbound.localSiteId, workflowExecutionDelegations.localSiteId),
            eq(federationOutbound.operationId, workflowExecutionDelegations.operationId),
          ),
        )
        .where(
          and(
            eq(workflowExecutionDelegations.runId, runId),
            eq(workflowExecutionDelegations.localSiteId, this.signingKey.siteId),
          ),
        );
    });
    let pending = false;
    const errors: unknown[] = [];
    for (const { operationId, userId, orgId } of operations) {
      try {
        const cancellation = await this.cancellations.requestForWorkflow(runId, operationId);
        if (cancellation?.state !== "stopped") pending = true;
      } catch (error) {
        errors.push(error);
      }
      const imports = await this.db
        .select()
        .from(federationResultImports)
        .where(
          and(
            eq(federationResultImports.localSiteId, this.signingKey.siteId),
            eq(federationResultImports.operationId, operationId),
            eq(federationResultImports.requestedBy, userId),
            eq(federationResultImports.localOrgId, orgId),
          ),
        );
      for (const imported of imports) {
        if (imported.state === "available") continue;
        try {
          await this.resultImports.cancel(
            { userId: imported.requestedBy, orgId: imported.localOrgId },
            imported.id,
            operationId,
          );
        } catch (error) {
          const [current] = await this.db
            .select()
            .from(federationResultImports)
            .where(eq(federationResultImports.id, imported.id));
          if (current?.state !== "available") errors.push(error);
        }
      }
    }
    if (errors.length)
      throw new AggregateError(errors, "Workflow remote cancellation could not be queued");
    if (pending) throw new Error("Workflow remote cancellation is awaiting stop confirmation");
  }

  async list(actor: FederationActor, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "delegation.read");
      const rows = await tx
        .select()
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.signingKey.siteId),
            eq(federationOutbound.localOrgId, actor.orgId),
          ),
        )
        .orderBy(desc(federationOutbound.createdAt), desc(federationOutbound.operationId))
        .limit(limit)
        .offset(offset);
      return rows.map(summary);
    });
  }

  async retry(actor: FederationActor, operationId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "delegation.submit");
      const [row] = await tx
        .select()
        .from(federationOutbound)
        .where(and(this.key(operationId), eq(federationOutbound.localOrgId, actor.orgId)))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.cancelState || row.state === "accepted" || row.state === "sending")
        throw new FederationError("OPERATION_CONFLICT");
      const [target] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, row.request.recipientSiteId))
        .for("share");
      if (!target || target.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      await tx
        .update(federationOutbound)
        .set({
          state: "queued",
          endpoint: target.endpoint,
          lastError: null,
          nextAttemptAt: this.clock(),
          updatedAt: this.clock(),
        })
        .where(this.key(operationId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.delegation.retry",
        target: operationId,
        diff: { before: { endpoint: row.endpoint }, after: { endpoint: target.endpoint } },
      });
    });
  }

  /** Only the accepted recipient may retrieve inventory digests bound to its original task. */
  async materialChunk(requestJws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(requestJws),
      this.clock(),
    );
    const { payload: query, digest: queryDigest } = await verifyFederationMessage(
      FederationMaterialQuerySchema,
      requestJws,
      peer,
      this.clock(),
    );
    const authorize = await this.materialAuthorization(query, fingerprint, peer, "material-chunk");
    const { content } = await this.db.transaction(authorize);
    if (query.offset >= content.length) throw new FederationError("INVALID_MESSAGE");
    const report = FederationMaterialChunkSchema.parse({
      protocolVersion: 1,
      kind: "material-chunk",
      queryId: query.queryId,
      operationId: query.operationId,
      agreementRevisionId: query.agreementRevisionId,
      taskId: query.taskId,
      attempt: query.attempt,
      reservationId: query.reservationId,
      requestDigest: query.requestDigest,
      materialDigest: query.materialDigest,
      offset: query.offset,
      senderSiteId: this.signingKey.siteId,
      recipientSiteId: peer.siteId,
      queryDigest,
      observedAt: this.clock().toISOString(),
      totalBytes: content.length,
      bytes: content
        .subarray(query.offset, query.offset + FEDERATION_MATERIAL_CHUNK_BYTES)
        .toString("base64"),
    });
    const signed = await signFederationMessage(
      FederationMaterialChunkSchema,
      report,
      this.signingKey,
    );
    await this.db.transaction(authorize);
    return signed;
  }

  async inputDownload(queryJws: string, fingerprint: string, options: FederationDownloadStorage) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(queryJws),
      this.clock(),
    );
    const { payload: query, digest: queryDigest } = await verifyFederationMessage(
      FederationInputDownloadQuerySchema,
      queryJws,
      peer,
      this.clock(),
    );
    const authorize = await this.materialAuthorization(
      { ...query, materialDigest: query.binding.manifestDigest },
      fingerprint,
      peer,
      "input-download-grant",
    );
    const read = async (tx: FederationTransaction) => {
      const snapshot = await authorize(tx);
      const file = snapshot.inputExport?.bindings.find(
        (file) => file.descriptor === query.binding.descriptor && file.path === query.binding.path,
      );
      if (
        !file ||
        snapshot.inputFilesDigest !== query.binding.manifestDigest ||
        file.sizeBytes !== query.binding.sizeBytes ||
        file.sha256 !== query.binding.sha256
      )
        throw new FederationError("OPERATION_CONFLICT");
      return { file, deadline: snapshot.deadline };
    };
    const first = await this.db.transaction(read);
    // Legacy NetDrive keys contain user IDs; they need an opaque export copy before sharing.
    if (
      !/^(?:netdrive\/objects|federation-results\/[a-f0-9-]{36})\/[a-f0-9-]{36}$/.test(
        first.file.storageKey,
      )
    )
      throw new FederationError("POLICY_DENIED");
    const origins = new Set(
      options.allowedOrigins.map(
        (origin) => new URL(FederationDataOriginSchema.parse(origin)).origin,
      ),
    );
    if (!origins.size) throw new FederationError("POLICY_DENIED");
    const stat = await options.storage.head(first.file.storageKey, first.file.versionId);
    if (!stat || stat.size !== first.file.sizeBytes || stat.versionId !== first.file.versionId)
      throw new FederationError("ASSET_UNAVAILABLE");
    const now = this.clock().getTime();
    const deadline = Math.min(now + 30_000, Date.parse(query.expiresAt), first.deadline);
    const seconds = Math.floor((deadline - now) / 1000);
    if (seconds < 1) throw new FederationError("AUTHORIZATION_EXPIRED");
    const url = await options.storage.presignDownload(
      first.file.storageKey,
      seconds,
      undefined,
      first.file.versionId,
    );
    const parsed = new URL(url);
    if (
      !origins.has(parsed.origin) ||
      parsed.searchParams.getAll("versionId").length !== 1 ||
      parsed.searchParams.get("versionId") !== first.file.versionId
    )
      throw new FederationError("POLICY_DENIED");
    const expiresAt = signedDownloadExpiry(url, this.clock().getTime(), deadline);
    const { issuedAt: _issued, expiresAt: _expires, ...identity } = query;
    const grant = FederationInputDownloadGrantSchema.parse({
      ...identity,
      kind: "input-download-grant",
      senderSiteId: query.recipientSiteId,
      recipientSiteId: query.senderSiteId,
      queryDigest,
      observedAt: this.clock().toISOString(),
      url,
      expiresAt,
    });
    const signed = await signFederationMessage(
      FederationInputDownloadGrantSchema,
      grant,
      this.signingKey,
    );
    await this.db.transaction(async (tx) => {
      const current = await read(tx);
      if (federationCanonicalJson(current.file) !== federationCanonicalJson(first.file))
        throw new FederationError("OPERATION_CONFLICT");
      if (
        Date.parse(expiresAt) <= this.clock().getTime() ||
        Date.parse(expiresAt) > current.deadline
      )
        throw new FederationError("AUTHORIZATION_EXPIRED");
    });
    return signed;
  }

  private async materialAuthorization(
    query: Omit<FederationMaterialQuery, "kind" | "offset">,
    fingerprint: string,
    peer: FederationVerificationKey,
    responseKind: "material-chunk" | "input-download-grant",
  ) {
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signingKey.siteId)
      throw new FederationError("UNTRUSTED_IDENTITY");
    assertFederationStatusQueryFresh(query, this.clock());
    const [saved] = await this.db
      .select()
      .from(federationOutbound)
      .where(this.key(query.operationId));
    if (
      !saved ||
      saved.state !== "accepted" ||
      !saved.receipt ||
      saved.cancelState ||
      query.senderSiteId !== saved.request.recipientSiteId ||
      query.reservationId !== saved.receipt.reservationId ||
      query.requestDigest !== saved.requestDigest ||
      query.agreementRevisionId !== saved.agreementRevisionId ||
      query.taskId !== saved.taskId ||
      query.attempt !== saved.attempt ||
      ![
        saved.request.inputManifestDigest,
        saved.request.environmentLockDigest,
        saved.request.inputFilesDigest,
      ].includes(query.materialDigest)
    )
      throw new FederationError("POLICY_DENIED");
    const actor = { userId: saved.submittedBy, orgId: saved.localOrgId };
    const materials = await this.materials(actor, saved.request);
    if (saved.request.mode === "ledger_coordinated") {
      if (!this.confirmations) throw new FederationError("LEDGER_REQUIRED");
      await this.confirmations.refreshForExecution(actor.orgId, saved.request);
    }
    return async (tx: FederationTransaction) => {
      const { terms, ownKey, endpoint, inputExport, confirmation } = await this.authorize(
        tx,
        actor,
        saved.request,
        materials,
        true,
      );
      if (confirmation && saved.receipt?.reservationId !== confirmation.reservationId)
        throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, this.clock());
      const currentPeer = await this.trust.resolveKey(peer.siteId, peer.keyId, this.clock(), tx);
      const queryKind =
        responseKind === "material-chunk" ? "material-query" : "input-download-query";
      if (
        !ownKey.allowedKinds.includes(responseKind) ||
        !currentPeer.allowedKinds.includes(queryKind)
      )
        throw new FederationError("UNTRUSTED_IDENTITY");
      const [current] = await tx
        .select()
        .from(federationOutbound)
        .where(this.key(saved.operationId))
        .for("share");
      if (
        !current ||
        current.state !== "accepted" ||
        current.cancelState ||
        current.requestDigest !== saved.requestDigest ||
        current.requestJws !== saved.requestJws ||
        current.receiptJws !== saved.receiptJws ||
        current.endpoint !== endpoint
      )
        throw new FederationError("POLICY_DENIED");
      const originalKeyId = federationMessageKeyId(saved.requestJws);
      const originalKey = await this.trust.resolveKey(
        this.signingKey.siteId,
        originalKeyId,
        this.clock(),
        tx,
      );
      await this.trust.assertKey(tx, this.signingKey.siteId, originalKeyId, this.clock());
      const original = await verifyFederationMessage(
        FederationDelegationSchema,
        saved.requestJws,
        originalKey,
        this.clock(),
      );
      if (
        original.digest !== saved.requestDigest ||
        federationCanonicalJson(original.payload) !== federationCanonicalJson(saved.request)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const content =
        query.materialDigest === saved.request.inputFilesDigest && inputExport
          ? inputExport.manifest
          : await this.assets.readMaterial(
              tx,
              actor.orgId,
              this.signingKey.siteId,
              query.materialDigest,
            );
      (confirmation ? assertDelegationTerms : assertDelegationPolicy)(
        terms,
        saved.request,
        this.clock(),
        "execution",
      );
      assertFederationStatusQueryFresh(query, this.clock());
      const now = this.clock();
      if (
        [ownKey, currentPeer, originalKey].some(
          (key) => now < key.validFrom || now >= key.validUntil,
        )
      )
        throw new FederationError("UNTRUSTED_IDENTITY");
      await this.trust.assertPeer(tx, fingerprint, peer.siteId, peer.keyId, now);
      if (confirmation && confirmation.expiresAtUnixMs <= this.clock().getTime())
        throw new FabricClientFailure("LEDGER_PENDING");
      return {
        content: Buffer.from(federationCanonicalJson(content), "utf8"),
        inputExport,
        inputFilesDigest: saved.request.inputFilesDigest,
        deadline: Math.min(
          confirmation?.expiresAtUnixMs ?? Number.POSITIVE_INFINITY,
          federationExecutionDeadline(saved.request),
          Date.parse(terms.validUntil),
          ownKey.validUntil.getTime(),
          currentPeer.validUntil.getTime(),
          originalKey.validUntil.getTime(),
        ),
      };
    };
  }

  remoteStatus(actor: FederationActor, operationId: string) {
    return this.queryStatus(actor, operationId);
  }

  private async queryStatus(actor: FederationActor, operationId: string, claim?: string) {
    const authorize = async (tx: FederationTransaction) => {
      await requireFederationCapability(tx, actor, "delegation.read");
      const [row] = await tx
        .select()
        .from(federationOutbound)
        .where(and(this.key(operationId), eq(federationOutbound.localOrgId, actor.orgId)));
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.state !== "accepted" || !row.receipt) throw new FederationError("OPERATION_CONFLICT");
      const [target] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, row.request.recipientSiteId))
        .for("share");
      if (!target || target.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      if (target.endpoint !== row.endpoint) throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, this.signingKey.siteId, this.signingKey.keyId, this.clock());
      return { row, receipt: row.receipt };
    };
    const { row, receipt } = await this.db.transaction(authorize);
    const ownKey = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    const query = FederationStatusQuerySchema.parse({
      protocolVersion: 1,
      kind: "status-query",
      queryId: crypto.randomUUID(),
      senderSiteId: this.signingKey.siteId,
      recipientSiteId: row.request.recipientSiteId,
      operationId,
      agreementRevisionId: row.agreementRevisionId,
      taskId: row.taskId,
      attempt: row.attempt,
      reservationId: receipt.reservationId,
      requestDigest: row.requestDigest,
      issuedAt: this.clock().toISOString(),
      expiresAt: new Date(this.clock().getTime() + 60_000).toISOString(),
    });
    if (!ownKey.allowedKinds.includes("status-query"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const jws = await signFederationMessage(FederationStatusQuerySchema, query, this.signingKey);
    const verified = await verifyFederationMessage(
      FederationStatusQuerySchema,
      jws,
      ownKey,
      this.clock(),
    );
    await this.db.transaction(authorize);
    const reportJws = await this.send(row.endpoint, jws, "/federation/v1/status");
    const keyId = federationMessageKeyId(reportJws);
    const peer = await this.trust.resolveKey(query.recipientSiteId, keyId, this.clock());
    const { payload: report } = await verifyFederationMessage(
      FederationStatusReportSchema,
      reportJws,
      peer,
      this.clock(),
    );
    assertFederationStatusReport(query, verified.digest, report, this.clock());
    const verifiedAt = await this.db.transaction(async (tx) => {
      await authorize(tx);
      await this.trust.assertKey(tx, peer.siteId, keyId, this.clock());
      if (claim) {
        const [current] = await tx
          .select({ claim: federationOutbound.statusClaim })
          .from(federationOutbound)
          .where(this.key(operationId))
          .for("update");
        if (current?.claim !== claim) throw new FederationError("OPERATION_CONFLICT");
      }
      const now = this.clock();
      // Lock waits must not extend either signing key's validity.
      if ([ownKey, peer].some((key) => now < key.validFrom || now >= key.validUntil))
        throw new FederationError("UNTRUSTED_IDENTITY");
      assertFederationStatusReport(query, verified.digest, report, now);
      if (claim) {
        const terminal =
          report.workflow && ["completed", "failed", "cancelled"].includes(report.workflow.status);
        await tx
          .update(federationOutbound)
          .set({
            statusReport: report,
            statusReportJws: reportJws,
            statusVerifiedAt: now,
            statusLastError: null,
            statusClaim: null,
            statusNextAttemptAt: terminal ? null : new Date(now.getTime() + 30_000),
            updatedAt: now,
          })
          .where(this.key(operationId));
      }
      return now.toISOString();
    });
    return { report, reportJws, verifiedAt };
  }

  async refreshStatusNext(): Promise<boolean> {
    const claim = crypto.randomUUID();
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.signingKey.siteId),
            eq(federationOutbound.state, "accepted"),
            lte(federationOutbound.statusNextAttemptAt, this.clock()),
          ),
        )
        .orderBy(asc(federationOutbound.statusNextAttemptAt), asc(federationOutbound.operationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return undefined;
      await tx
        .update(federationOutbound)
        .set({
          statusClaim: claim,
          statusNextAttemptAt: new Date(this.clock().getTime() + 30_000),
        })
        .where(this.key(row.operationId));
      return row;
    });
    if (!claimed) return false;
    try {
      await this.queryStatus(
        { userId: claimed.submittedBy, orgId: claimed.localOrgId },
        claimed.operationId,
        claim,
      );
    } catch (error) {
      const lastError =
        error instanceof FederationError || error instanceof FederationDeliveryError
          ? error.code
          : error instanceof AppError && error.statusCode === 403
            ? "POLICY_DENIED"
            : "DELIVERY_UNAVAILABLE";
      // Keep the last authenticated observation; transport failure is not computation failure.
      await this.db
        .update(federationOutbound)
        .set({
          statusLastError: lastError,
          statusClaim: null,
          statusNextAttemptAt: new Date(this.clock().getTime() + 30_000),
          updatedAt: this.clock(),
        })
        .where(and(this.key(claimed.operationId), eq(federationOutbound.statusClaim, claim)));
    }
    return true;
  }

  async deliverNext(): Promise<boolean> {
    const leaseOwner = crypto.randomUUID();
    const claimed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.signingKey.siteId),
            lte(federationOutbound.nextAttemptAt, this.clock()),
            isNull(federationOutbound.cancelState),
            or(
              eq(federationOutbound.state, "queued"),
              and(
                eq(federationOutbound.state, "sending"),
                lte(federationOutbound.leaseUntil, this.clock()),
              ),
            ),
          ),
        )
        .orderBy(asc(federationOutbound.nextAttemptAt), asc(federationOutbound.operationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return undefined;
      await tx
        .update(federationOutbound)
        .set({
          state: "sending",
          leaseOwner,
          leaseUntil: new Date(this.clock().getTime() + 60000),
          updatedAt: this.clock(),
        })
        .where(this.key(row.operationId));
      return row;
    });
    if (!claimed) return false;
    try {
      const materials = await this.materials(
        { userId: claimed.submittedBy, orgId: claimed.localOrgId },
        claimed.request,
      );
      if (claimed.request.mode === "ledger_coordinated") {
        if (!this.confirmations) throw new FederationError("LEDGER_REQUIRED");
        await this.confirmations.refreshForExecution(claimed.localOrgId, claimed.request);
      }
      const current = await this.db.transaction(async (tx) => {
        const { ownKey, endpoint, confirmation } = await this.authorize(
          tx,
          { userId: claimed.submittedBy, orgId: claimed.localOrgId },
          claimed.request,
          materials,
          true,
        );
        const [current] = await tx
          .select()
          .from(federationOutbound)
          .where(
            and(
              this.key(claimed.operationId),
              eq(federationOutbound.leaseOwner, leaseOwner),
              eq(federationOutbound.state, "sending"),
              isNull(federationOutbound.cancelState),
            ),
          )
          .for("update");
        if (!current) return;
        if (endpoint !== current.endpoint) throw new FederationError("OPERATION_CONFLICT");
        const originalKey =
          federationMessageKeyId(current.requestJws) === ownKey.keyId
            ? ownKey
            : await this.trust.resolveKey(
                this.signingKey.siteId,
                federationMessageKeyId(current.requestJws),
                this.clock(),
                tx,
              );
        await this.trust.assertKey(tx, originalKey.siteId, originalKey.keyId, this.clock());
        const request = await verifyFederationMessage(
          FederationDelegationSchema,
          current.requestJws,
          originalKey,
          this.clock(),
        );
        if (
          request.digest !== current.requestDigest ||
          JSON.stringify(request.payload) !==
            JSON.stringify(FederationDelegationSchema.parse(current.request))
        )
          throw new FederationError("OPERATION_CONFLICT");
        return { ...current, confirmationReservationId: confirmation?.reservationId };
      });
      if (!current) return true;
      // No network I/O holds a database connection. A lost response replays only this original JWS.
      const receiptJws = await this.send(current.endpoint, current.requestJws);
      const keyId = federationMessageKeyId(receiptJws);
      const key = await this.trust.resolveKey(current.request.recipientSiteId, keyId, this.clock());
      const { payload: receipt } = await verifyFederationMessage(
        FederationAcceptanceSchema,
        receiptJws,
        key,
        this.clock(),
      );
      const expected = current.request;
      if (
        (current.confirmationReservationId !== undefined &&
          receipt.reservationId !== current.confirmationReservationId) ||
        receipt.senderSiteId !== expected.recipientSiteId ||
        receipt.recipientSiteId !== expected.senderSiteId ||
        receipt.requestDigest !== current.requestDigest ||
        receipt.reservedAmount !== expected.maxAmount ||
        receipt.unit !== expected.unit ||
        (
          [
            "operationId",
            "agreementRevisionId",
            "mode",
            "budgetDomainId",
            "epoch",
            "taskId",
            "attempt",
          ] as const
        ).some((field) => receipt[field] !== expected[field]) ||
        Date.parse(receipt.acceptedAt) < Date.parse(expected.issuedAt) - 60000 ||
        Date.parse(receipt.acceptedAt) >= Date.parse(expected.expiresAt) ||
        Date.parse(receipt.acceptedAt) > this.clock().getTime() + 60000
      )
        throw new FederationError("INVALID_MESSAGE");
      await this.db.transaction(async (tx) => {
        await this.trust.assertKey(tx, current.request.recipientSiteId, keyId, this.clock());
        // Recording the observed receipt does not grant further execution after a local revocation.
        await tx
          .update(federationOutbound)
          .set({
            state: "accepted",
            statusNextAttemptAt: this.clock(),
            receipt,
            receiptJws,
            lastError: null,
            leaseOwner: null,
            leaseUntil: null,
            updatedAt: this.clock(),
          })
          .where(and(this.key(current.operationId), eq(federationOutbound.leaseOwner, leaseOwner)));
      });
    } catch (error) {
      const denied = error instanceof AppError && error.statusCode === 403;
      const retry =
        !denied &&
        !(error instanceof FederationError) &&
        !(error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      const lastError =
        error instanceof FederationError ||
        error instanceof FederationDeliveryError ||
        error instanceof FabricClientFailure
          ? error.code
          : denied
            ? "POLICY_DENIED"
            : "DELIVERY_UNAVAILABLE";
      await this.db
        .update(federationOutbound)
        .set({
          state: retry ? "queued" : "needs_review",
          lastError,
          leaseOwner: null,
          leaseUntil: null,
          nextAttemptAt: new Date(this.clock().getTime() + 30000),
          updatedAt: this.clock(),
        })
        .where(
          and(
            this.key(claimed.operationId),
            eq(federationOutbound.leaseOwner, leaseOwner),
            eq(federationOutbound.state, "sending"),
          ),
        );
    }
    return true;
  }
}

export class FederationOutboundWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(private readonly service: FederationOutboundService) {}
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 10000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    const running = this.run()
      .catch(() => {
        logger.error("Federation outbound scan failed; original requests remain durable");
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = running;
    return running;
  }
  private async run() {
    for (let i = 0; i < 8 && !this.stopping; i++) {
      const cancelled = await this.service.cancellations.deliverNext();
      if (this.stopping) break;
      const delivered = await this.service.deliverNext();
      if (this.stopping) break;
      const receipted = await this.service.resultReceipts.deliverNext();
      if (this.stopping) break;
      const refreshed = await this.service.refreshStatusNext();
      if (!cancelled && !delivered && !receipted && !refreshed) break;
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
