import { auditLog, federationOutbound, federationSites, type PgDb } from "@kuintessence/db";
import {
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationError,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, asc, eq, inArray, lte, or } from "drizzle-orm";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

export function cancellationSummary(row: typeof federationOutbound.$inferSelect) {
  return row.cancelState
    ? { state: row.cancelState, lastError: row.cancelLastError, receipt: row.cancelReceipt }
    : null;
}

/** An authorized, durable stop intent survives loss of the human initiator's grant. */
export class FederationCancellationSender {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly send: FederationSend,
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

  async request(actor: FederationActor, operationId: string, retry = false) {
    const authorize = async (tx: FederationTransaction) => {
      await requireFederationCapability(tx, actor, "delegation.cancel");
      const [row] = await tx
        .select()
        .from(federationOutbound)
        .where(and(this.key(operationId), eq(federationOutbound.localOrgId, actor.orgId)))
        .for("update");
      if (!row) throw new FederationError("POLICY_DENIED");
      return row;
    };
    const row = await this.db.transaction(authorize);
    if (row.cancelState && (!retry || row.cancelState === "stopped"))
      return cancellationSummary(row);
    if (retry && (!row.cancelState || row.cancelState === "sending"))
      throw new FederationError("OPERATION_CONFLICT");
    const request =
      row.cancelRequest ??
      FederationCancellationSchema.parse({
        protocolVersion: 1,
        kind: "cancellation",
        operationId,
        senderSiteId: this.signingKey.siteId,
        recipientSiteId: row.request.recipientSiteId,
        agreementRevisionId: row.agreementRevisionId,
        taskId: row.taskId,
        attempt: row.attempt,
        requestDigest: row.requestDigest,
        issuedAt: this.clock().toISOString(),
      });
    const key = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    if (!key.allowedKinds.includes("cancellation")) throw new FederationError("UNTRUSTED_IDENTITY");
    const jws = await signFederationMessage(FederationCancellationSchema, request, this.signingKey);
    const verified = await verifyFederationMessage(
      FederationCancellationSchema,
      jws,
      key,
      this.clock(),
    );
    return this.db.transaction(async (tx) => {
      const current = await authorize(tx);
      if (current.cancelState && (!retry || current.cancelState === "stopped"))
        return cancellationSummary(current);
      if (retry && (current.cancelState === "sending" || current.cancelDigest !== verified.digest))
        throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, this.signingKey.siteId, this.signingKey.keyId, this.clock());
      const [target] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, request.recipientSiteId))
        .for("share");
      if (!target || target.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      const [updated] = await tx
        .update(federationOutbound)
        .set({
          cancelRequest: request,
          cancelJws: jws,
          cancelDigest: verified.digest,
          cancelRequestedBy: current.cancelRequestedBy ?? actor.userId,
          cancelState: "queued",
          cancelLastError: null,
          cancelLeaseOwner: null,
          cancelLeaseUntil: null,
          cancelNextAttemptAt: this.clock(),
          endpoint: target.endpoint,
          updatedAt: this.clock(),
        })
        .where(this.key(operationId))
        .returning();
      if (!updated) throw new Error("Cancellation intent was not saved");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: retry ? "federation.cancellation.retry" : "federation.cancellation.request",
        target: operationId,
        diff: {
          before: { endpoint: current.endpoint },
          after: {
            endpoint: target.endpoint,
            cancellationDigest: verified.digest,
            keyId: key.keyId,
          },
        },
      });
      return cancellationSummary(updated);
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
            lte(federationOutbound.cancelNextAttemptAt, this.clock()),
            or(
              inArray(federationOutbound.cancelState, ["queued", "pending"]),
              and(
                eq(federationOutbound.cancelState, "sending"),
                lte(federationOutbound.cancelLeaseUntil, this.clock()),
              ),
            ),
          ),
        )
        .orderBy(asc(federationOutbound.cancelNextAttemptAt), asc(federationOutbound.operationId))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!row) return;
      await tx
        .update(federationOutbound)
        .set({
          cancelState: "sending",
          cancelLeaseOwner: leaseOwner,
          cancelLeaseUntil: new Date(this.clock().getTime() + 60_000),
          updatedAt: this.clock(),
        })
        .where(this.key(row.operationId));
      return row;
    });
    if (!claimed) return false;
    const owned = and(
      this.key(claimed.operationId),
      eq(federationOutbound.cancelLeaseOwner, leaseOwner),
      eq(federationOutbound.cancelState, "sending"),
    );
    try {
      if (!claimed.cancelRequest || !claimed.cancelJws || !claimed.cancelDigest)
        throw new FederationError("INVALID_MESSAGE");
      const request = claimed.cancelRequest;
      const current = await this.db.transaction(async (tx) => {
        const [target] = await tx
          .select()
          .from(federationSites)
          .where(eq(federationSites.id, request.recipientSiteId))
          .for("share");
        if (!target || target.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
        if (target.endpoint !== claimed.endpoint) throw new FederationError("OPERATION_CONFLICT");
        const keyId = federationMessageKeyId(claimed.cancelJws ?? "");
        await this.trust.assertKey(tx, this.signingKey.siteId, keyId, this.clock());
        const key = await this.trust.resolveKey(this.signingKey.siteId, keyId, this.clock(), tx);
        const checked = await verifyFederationMessage(
          FederationCancellationSchema,
          claimed.cancelJws ?? "",
          key,
          this.clock(),
        );
        if (
          checked.digest !== claimed.cancelDigest ||
          federationCanonicalJson(checked.payload) !== federationCanonicalJson(request)
        )
          throw new FederationError("OPERATION_CONFLICT");
        const [row] = await tx
          .select({ id: federationOutbound.operationId })
          .from(federationOutbound)
          .where(owned);
        return row;
      });
      if (!current) return true;
      const receiptJws = await this.send(
        claimed.endpoint,
        claimed.cancelJws,
        "/federation/v1/cancellations",
      );
      const keyId = federationMessageKeyId(receiptJws);
      const key = await this.trust.resolveKey(request.recipientSiteId, keyId, this.clock());
      const { payload: receipt } = await verifyFederationMessage(
        FederationCancellationReceiptSchema,
        receiptJws,
        key,
        this.clock(),
      );
      if (
        receipt.senderSiteId !== request.recipientSiteId ||
        receipt.recipientSiteId !== request.senderSiteId ||
        receipt.cancellationDigest !== claimed.cancelDigest ||
        (
          ["operationId", "agreementRevisionId", "taskId", "attempt", "requestDigest"] as const
        ).some((field) => receipt[field] !== request[field]) ||
        Date.parse(receipt.recordedAt) < Date.parse(request.issuedAt) - 60_000 ||
        Date.parse(receipt.recordedAt) > Date.parse(receipt.observedAt) ||
        Date.parse(receipt.observedAt) > this.clock().getTime() + 60_000 ||
        (receipt.state === "stopped" &&
          receipt.workflow &&
          !["completed", "failed", "cancelled"].includes(receipt.workflow.status)) ||
        (claimed.receipt && receipt.reservationId !== claimed.receipt.reservationId)
      )
        throw new FederationError("INVALID_MESSAGE");
      await this.db.transaction(async (tx) => {
        await this.trust.assertKey(tx, request.recipientSiteId, keyId, this.clock());
        await tx
          .update(federationOutbound)
          .set({
            cancelState: receipt.state,
            cancelReceipt: receipt,
            cancelReceiptJws: receiptJws,
            cancelLastError: null,
            cancelLeaseOwner: null,
            cancelLeaseUntil: null,
            cancelNextAttemptAt: new Date(this.clock().getTime() + 10_000),
            updatedAt: this.clock(),
          })
          .where(owned);
      });
    } catch (error) {
      const terminal =
        error instanceof FederationError ||
        (error instanceof FederationDeliveryError && error.code === "INVALID_RECEIPT_RESPONSE");
      await this.db
        .update(federationOutbound)
        .set({
          cancelState: terminal ? "needs_review" : "queued",
          cancelLastError:
            error instanceof FederationError || error instanceof FederationDeliveryError
              ? error.code
              : "DELIVERY_UNAVAILABLE",
          cancelLeaseOwner: null,
          cancelLeaseUntil: null,
          cancelNextAttemptAt: new Date(this.clock().getTime() + 30_000),
          updatedAt: this.clock(),
        })
        .where(owned);
    }
    return true;
  }
}
