import {
  auditLog,
  federationAgreementApprovals,
  federationOutbound,
  federationSites,
  type PgDb,
} from "@kuintessence/db";
import { AppError, createLogger } from "@kuintessence/shared";
import {
  assertDelegationPolicy,
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  type FederationAssetRef,
  type FederationDelegation,
  FederationDelegationSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, asc, desc, eq, lte, or, sql } from "drizzle-orm";
import type { FederationAssetService } from "./assets";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Durable source delivery. Acceptance is not execution, settlement or permission to retry a task. */
export class FederationOutboundService {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly assets: FederationAssetService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
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
    await requireFederationCapability(tx, actor, "delegation.submit");
    for (const material of materials)
      await this.assets.assertResolved(tx, actor, material.reference, material.mappingId);
    if (request.senderSiteId !== this.signingKey.siteId) throw new FederationError("POLICY_DENIED");
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
    assertDelegationPolicy(
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
    return { terms, ownKey, endpoint: target.endpoint };
  }

  async enqueue(actor: FederationActor, raw: FederationDelegation) {
    const request = FederationDelegationSchema.parse(raw);
    const prior = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "delegation.submit");
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
    return this.db.transaction(async (tx) => {
      const { terms, endpoint } = await this.authorize(tx, actor, request, materials, true);
      const [existing] = await tx
        .select()
        .from(federationOutbound)
        .where(this.key(request.operationId));
      if (existing) {
        if (
          existing.localOrgId !== actor.orgId ||
          existing.submittedBy !== actor.userId ||
          existing.requestDigest !== verified.digest
        )
          throw new FederationError("OPERATION_CONFLICT");
        return summary(existing);
      }
      assertDelegationPolicy(terms, request, this.clock());
      // One source budget epoch cannot be copied to another agreement or recipient.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${this.signingKey.siteId}:${request.budgetDomainId}:${request.epoch}`}, 0))`,
      );
      const [held] = await tx
        .select({
          conflictingRevision: sql<boolean>`coalesce(bool_or(${federationOutbound.agreementRevisionId} <> ${request.agreementRevisionId}), false)`,
          amount: sql<string>`coalesce(sum(${federationOutbound.amount}), 0)::text`,
          count: sql<number>`count(*)::integer`,
        })
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.signingKey.siteId),
            eq(federationOutbound.budgetDomainId, request.budgetDomainId),
            eq(federationOutbound.epoch, request.epoch),
          ),
        );
      if (!held) throw new Error("Source budget aggregate is unavailable");
      if (held.conflictingRevision) throw new FederationError("OPERATION_CONFLICT");
      if (
        held.count >= terms.maxReservations ||
        BigInt(held.amount) + BigInt(request.maxAmount) > BigInt(terms.budgetLimit)
      )
        throw new FederationError("BUDGET_EXHAUSTED");
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
      if (row.state === "accepted" || row.state === "sending")
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
      const current = await this.db.transaction(async (tx) => {
        const { ownKey, endpoint } = await this.authorize(
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
        return current;
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
        error instanceof FederationError || error instanceof FederationDeliveryError
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
    for (let i = 0; i < 8 && !this.stopping && (await this.service.deliverNext()); i++) {}
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
