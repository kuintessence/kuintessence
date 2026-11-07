import {
  auditLog,
  federationAgreements,
  federationOutbound,
  federationReservations,
  federationResultImports,
  federationResultReceipts,
  federationSites,
  federationWorkflowBindings,
  type PgDb,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationError,
  type FederationResultReceipt,
  FederationResultReceiptAckSchema,
  FederationResultReceiptSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

type Import = typeof federationResultImports.$inferSelect;

/** Publication persists the statement; delivery retries the same fact without new data access. */
export class FederationResultReceiptSender {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async retry(actor: FederationActor, operationId: string, importId: string) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "result.read");
      const row = await this.lock(tx, importId);
      if (
        row.localOrgId !== actor.orgId ||
        row.requestedBy !== actor.userId ||
        row.operationId !== operationId
      )
        throw new FederationError("POLICY_DENIED");
      if (row.state !== "available" || !row.receipt)
        throw new FederationError("OPERATION_CONFLICT");
      if (row.receiptAck) return { id: importId, state: "recorded" as const };
      // Keep the historical statement; only its transport signature may change after key rotation.
      await tx
        .update(federationResultImports)
        .set({ receiptJws: null, receiptLastError: null, receiptNextAttemptAt: this.clock() })
        .where(eq(federationResultImports.id, importId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        action: "federation.results.receipt_retry",
        target: importId,
      });
      return { id: importId, state: "pending" as const };
    });
  }

  async deliverNext() {
    const row = await this.db.transaction(async (tx) => {
      const [candidate] = await tx
        .select()
        .from(federationResultImports)
        .where(
          and(
            eq(federationResultImports.localSiteId, this.signingKey.siteId),
            eq(federationResultImports.state, "available"),
            isNotNull(federationResultImports.receipt),
            isNull(federationResultImports.receiptAck),
            lte(federationResultImports.receiptNextAttemptAt, this.clock()),
          ),
        )
        .orderBy(asc(federationResultImports.receiptNextAttemptAt), asc(federationResultImports.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!candidate) return;
      await tx
        .update(federationResultImports)
        .set({ receiptNextAttemptAt: new Date(this.clock().getTime() + 30_000) })
        .where(eq(federationResultImports.id, candidate.id));
      return candidate;
    });
    if (!row) return false;
    try {
      const receipt = FederationResultReceiptSchema.parse(row.receipt);
      const own = await this.trust.resolveKey(
        this.signingKey.siteId,
        this.signingKey.keyId,
        this.clock(),
      );
      if (!own.allowedKinds.includes("result-receipt"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const signed =
        row.receiptJws ??
        (await signFederationMessage(FederationResultReceiptSchema, receipt, this.signingKey));
      const prepared = await this.db.transaction(async (tx) => {
        const current = await this.lock(tx, row.id);
        if (current.receiptAck || current.receiptJws !== row.receiptJws) return;
        const jws = current.receiptJws ?? signed;
        const authorized = await this.authorize(tx, current, receipt, jws);
        await tx
          .update(federationResultImports)
          .set({ receiptJws: jws })
          .where(eq(federationResultImports.id, row.id));
        return { ...authorized, jws };
      });
      if (!prepared) return true;
      const acknowledgementJws = await this.send(
        prepared.endpoint,
        prepared.jws,
        "/federation/v1/result-receipts",
      );
      const keyId = federationMessageKeyId(acknowledgementJws);
      const peer = await this.trust.resolveKey(receipt.recipientSiteId, keyId, this.clock());
      const { payload: ack } = await verifyFederationMessage(
        FederationResultReceiptAckSchema,
        acknowledgementJws,
        peer,
        this.clock(),
      );
      if (
        ack.receiptId !== receipt.receiptId ||
        ack.operationId !== receipt.operationId ||
        ack.receiptDigest !== prepared.digest ||
        ack.senderSiteId !== receipt.recipientSiteId ||
        ack.recipientSiteId !== this.signingKey.siteId ||
        Date.parse(ack.recordedAt) > this.clock().getTime() + 60_000 ||
        Date.parse(ack.recordedAt) < Date.parse(receipt.receivedAt) - 60_000
      )
        throw new FederationError("INVALID_MESSAGE");
      await this.db.transaction(async (tx) => {
        const current = await this.lock(tx, row.id);
        if (current.receiptAck || current.receiptJws !== prepared.jws) return;
        await this.authorize(tx, current, receipt, prepared.jws);
        await this.trust.assertKey(tx, peer.siteId, keyId, this.clock());
        await tx
          .update(federationResultImports)
          .set({ receiptAck: ack, receiptAckJws: acknowledgementJws, receiptLastError: null })
          .where(eq(federationResultImports.id, row.id));
        await tx.insert(auditLog).values({
          actor: row.requestedBy,
          action: "federation.results.receipt_recorded",
          target: row.id,
          diff: { after: { receiptDigest: prepared.digest } },
        });
      });
    } catch (error) {
      const code =
        error instanceof FederationError || error instanceof FederationDeliveryError
          ? error.code
          : "RECEIPT_DELIVERY_FAILED";
      await this.db
        .update(federationResultImports)
        .set({ receiptLastError: code })
        .where(
          and(eq(federationResultImports.id, row.id), isNull(federationResultImports.receiptAck)),
        );
    }
    return true;
  }

  private async lock(tx: FederationTransaction, id: string) {
    const [row] = await tx
      .select()
      .from(federationResultImports)
      .where(
        and(
          eq(federationResultImports.id, id),
          eq(federationResultImports.localSiteId, this.signingKey.siteId),
        ),
      )
      .for("update");
    if (!row) throw new FederationError("POLICY_DENIED");
    return row;
  }
  private async authorize(
    tx: FederationTransaction,
    row: Import,
    receipt: FederationResultReceipt,
    jws: string,
  ) {
    if (
      row.state !== "available" ||
      federationMaterialDigest(row.receipt) !== federationMaterialDigest(receipt)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const keyId = federationMessageKeyId(jws);
    await this.trust.assertKey(tx, this.signingKey.siteId, keyId, this.clock());
    const key = await this.trust.resolveKey(this.signingKey.siteId, keyId, this.clock(), tx);
    const verified = await verifyFederationMessage(
      FederationResultReceiptSchema,
      jws,
      key,
      this.clock(),
    );
    if (federationMaterialDigest(verified.payload) !== federationMaterialDigest(receipt))
      throw new FederationError("OPERATION_CONFLICT");
    const [peer] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, receipt.recipientSiteId))
      .for("share");
    const [outbound] = await tx
      .select()
      .from(federationOutbound)
      .where(
        and(
          eq(federationOutbound.localSiteId, this.signingKey.siteId),
          eq(federationOutbound.operationId, row.operationId),
        ),
      );
    if (
      !peer ||
      peer.state !== "active" ||
      !outbound ||
      outbound.state !== "accepted" ||
      outbound.endpoint !== peer.endpoint ||
      receipt.senderSiteId !== this.signingKey.siteId ||
      receipt.recipientSiteId !== outbound.request.recipientSiteId ||
      receipt.receiptId !== row.id ||
      receipt.manifestDigest !== row.manifestDigest ||
      receipt.requestDigest !== outbound.requestDigest ||
      receipt.reservationId !== outbound.receipt?.reservationId
    )
      throw new FederationError("POLICY_DENIED");
    return { endpoint: peer.endpoint, digest: verified.digest };
  }
}

export class FederationResultReceiptReceiver {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      this.clock(),
    );
    const { payload: receipt, digest } = await verifyFederationMessage(
      FederationResultReceiptSchema,
      jws,
      peer,
      this.clock(),
    );
    if (
      receipt.senderSiteId !== peer.siteId ||
      receipt.recipientSiteId !== this.signingKey.siteId ||
      Date.parse(receipt.receivedAt) > this.clock().getTime() + 60_000
    )
      throw new FederationError("INVALID_MESSAGE");
    const identity = and(
      eq(federationResultReceipts.localSiteId, this.signingKey.siteId),
      eq(federationResultReceipts.senderSiteId, peer.siteId),
      eq(federationResultReceipts.receiptId, receipt.receiptId),
    );
    const authorize = async (tx: FederationTransaction) => {
      for (const site of [peer.siteId, this.signingKey.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, this.clock());
        else await this.trust.assertKey(tx, site, this.signingKey.keyId, this.clock());
      }
      const own = await this.trust.resolveKey(
        this.signingKey.siteId,
        this.signingKey.keyId,
        this.clock(),
        tx,
      );
      if (!own.allowedKinds.includes("result-receipt-ack"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      const [reservation] = await tx
        .select()
        .from(federationReservations)
        .where(eq(federationReservations.id, receipt.reservationId))
        .for("share");
      if (
        !reservation ||
        reservation.state !== "reserved" ||
        reservation.senderSiteId !== peer.siteId ||
        reservation.operationId !== receipt.operationId ||
        reservation.agreementRevisionId !== receipt.agreementRevisionId ||
        reservation.taskId !== receipt.taskId ||
        reservation.attempt !== receipt.attempt ||
        reservation.requestDigest !== receipt.requestDigest ||
        Date.parse(receipt.receivedAt) < Date.parse(reservation.receipt.acceptedAt) - 60_000
      )
        throw new FederationError("OPERATION_CONFLICT");
      const [agreement] = await tx
        .select()
        .from(federationAgreements)
        .where(eq(federationAgreements.revisionId, receipt.agreementRevisionId))
        .for("share");
      const policy = agreement?.terms.resultPolicy;
      if (
        !agreement ||
        agreement.targetSiteId !== this.signingKey.siteId ||
        !policy ||
        receipt.fileCount > policy.maxFiles ||
        receipt.sizeBytes > policy.maxBytes ||
        Date.parse(receipt.receivedAt) >= Date.parse(policy.availableUntil)
      )
        throw new FederationError("POLICY_DENIED");
      const [run] = await tx
        .select({ status: workflowRuns.status, completedAt: workflowRuns.completedAt })
        .from(federationWorkflowBindings)
        .innerJoin(workflowRuns, eq(workflowRuns.id, federationWorkflowBindings.workflowRunId))
        .where(eq(federationWorkflowBindings.reservationId, receipt.reservationId))
        .for("share");
      if (
        !run ||
        run.status !== "completed" ||
        !run.completedAt ||
        run.completedAt.getTime() > Date.parse(receipt.receivedAt) + 60_000
      )
        throw new FederationError("OPERATION_CONFLICT");
      // Past publication can still be recorded after expiry/revocation; no new file grant is issued.
      return reservation;
    };
    const prior = await this.db.transaction(async (tx) => {
      await authorize(tx);
      const [existing] = await tx.select().from(federationResultReceipts).where(identity);
      if (existing && existing.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
      return existing;
    });
    if (prior && federationMessageKeyId(prior.acknowledgementJws) === this.signingKey.keyId)
      return prior.acknowledgementJws;
    const acknowledgement =
      prior?.acknowledgement ??
      FederationResultReceiptAckSchema.parse({
        protocolVersion: 1,
        kind: "result-receipt-ack",
        receiptId: receipt.receiptId,
        operationId: receipt.operationId,
        senderSiteId: this.signingKey.siteId,
        recipientSiteId: peer.siteId,
        receiptDigest: digest,
        recordedAt: this.clock().toISOString(),
      });
    const acknowledgementJws = await signFederationMessage(
      FederationResultReceiptAckSchema,
      acknowledgement,
      this.signingKey,
    );
    return this.db.transaction(async (tx) => {
      await authorize(tx);
      if (prior) {
        await tx
          .update(federationResultReceipts)
          .set({ acknowledgementJws })
          .where(and(identity, eq(federationResultReceipts.digest, digest)));
        return acknowledgementJws;
      }
      const [created] = await tx
        .insert(federationResultReceipts)
        .values({
          localSiteId: this.signingKey.siteId,
          senderSiteId: peer.siteId,
          receiptId: receipt.receiptId,
          reservationId: receipt.reservationId,
          receipt,
          digest,
          receiptJws: jws,
          acknowledgement,
          acknowledgementJws,
        })
        .onConflictDoNothing()
        .returning();
      if (created) return created.acknowledgementJws;
      const [existing] = await tx.select().from(federationResultReceipts).where(identity);
      if (!existing || existing.digest !== digest) throw new FederationError("OPERATION_CONFLICT");
      return existing.acknowledgementJws;
    });
  }
}
