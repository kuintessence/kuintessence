import {
  federationAgreements,
  federationCancellations,
  federationReservations,
  type PgDb,
} from "@kuintessence/db";
import {
  FederationCancellationReceiptSchema,
  FederationCancellationSchema,
  FederationError,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import { readFederationCancellationState } from "./cancellation-state";
import { renewReservationCompletion } from "./completion-capacity";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import type { FederationStorageGuard } from "./storage-capacity";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

/** Recording the fence is immediate; the existing execution monitor/runner confirms stopping. */
export class FederationCancellationReceiver {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly clock: () => Date = () => new Date(),
    private readonly storageGuard?: Pick<FederationStorageGuard, "assertAdmission">,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async receive(jws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(jws),
      this.clock(),
    );
    const { payload: request, digest } = await verifyFederationMessage(
      FederationCancellationSchema,
      jws,
      peer,
      this.clock(),
    );
    if (peer.siteId !== request.senderSiteId || this.signingKey.siteId !== request.recipientSiteId)
      throw new FederationError("POLICY_DENIED");
    if (Date.parse(request.issuedAt) > this.clock().getTime() + 60_000)
      throw new FederationError("INVALID_MESSAGE");
    const local = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    if (!local.allowedKinds.includes("cancellation-receipt"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const authorize = async (tx: FederationTransaction) => {
      for (const site of [peer.siteId, this.signingKey.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, this.clock());
        else await this.trust.assertKey(tx, site, this.signingKey.keyId, this.clock());
      }
    };
    const saved = await this.db.transaction(async (tx) => {
      await authorize(tx);
      // Same lock as admission and final preparation/dispatch checks. Never lock the run here.
      const [agreement] = await tx
        .select()
        .from(federationAgreements)
        .where(eq(federationAgreements.revisionId, request.agreementRevisionId))
        .for("update");
      if (
        !agreement ||
        agreement.sourceSiteId !== peer.siteId ||
        agreement.targetSiteId !== this.signingKey.siteId
      )
        throw new FederationError("POLICY_DENIED");
      const condition = and(
        eq(federationCancellations.localSiteId, this.signingKey.siteId),
        eq(federationCancellations.senderSiteId, peer.siteId),
        eq(federationCancellations.operationId, request.operationId),
      );
      const [prior] = await tx.select().from(federationCancellations).where(condition);
      if (prior) {
        if (prior.cancellationDigest !== digest) throw new FederationError("OPERATION_CONFLICT");
        return prior;
      }
      const [reservation] = await tx
        .select()
        .from(federationReservations)
        .where(
          and(
            eq(federationReservations.senderSiteId, peer.siteId),
            eq(federationReservations.operationId, request.operationId),
          ),
        );
      if (
        reservation &&
        (reservation.requestDigest !== request.requestDigest ||
          reservation.agreementRevisionId !== request.agreementRevisionId ||
          reservation.taskId !== request.taskId ||
          reservation.attempt !== request.attempt)
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (reservation)
        await renewReservationCompletion(
          tx,
          this.signingKey.siteId,
          reservation.id,
          this.storageGuard,
        );
      await authorize(tx);
      const [created] = await tx
        .insert(federationCancellations)
        .values({
          localSiteId: this.signingKey.siteId,
          senderSiteId: peer.siteId,
          operationId: request.operationId,
          agreementRevisionId: request.agreementRevisionId,
          requestDigest: request.requestDigest,
          cancellationDigest: digest,
          request,
          requestJws: jws,
          recordedAt: this.clock(),
          nextCheckAt: this.clock(),
        })
        .returning();
      if (!created) throw new Error("Cancellation fence was not saved");
      return created;
    });
    const receipt = await this.db.transaction(async (tx) => {
      await authorize(tx);
      const observed = await readFederationCancellationState(tx, request);
      const [confirmed] = await tx
        .select({ at: federationCancellations.confirmedAt })
        .from(federationCancellations)
        .where(
          and(
            eq(federationCancellations.localSiteId, this.signingKey.siteId),
            eq(federationCancellations.senderSiteId, peer.siteId),
            eq(federationCancellations.operationId, request.operationId),
          ),
        );
      const { issuedAt: _issuedAt, ...identity } = request;
      return FederationCancellationReceiptSchema.parse({
        ...identity,
        kind: "cancellation-receipt",
        senderSiteId: this.signingKey.siteId,
        recipientSiteId: peer.siteId,
        cancellationDigest: digest,
        recordedAt: saved.recordedAt.toISOString(),
        observedAt: this.clock().toISOString(),
        reservationId: observed.reservationId,
        state: confirmed?.at && observed.stopped ? "stopped" : "pending",
        workflow: observed.workflow,
      });
    });
    const receiptJws = await signFederationMessage(
      FederationCancellationReceiptSchema,
      receipt,
      this.signingKey,
    );
    await this.db.transaction(authorize);
    return receiptJws;
  }
}
