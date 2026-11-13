import {
  federationPreparations,
  federationReservations,
  federationWorkflowBindings,
  type PgDb,
  workflowRuns,
} from "@kuintessence/db";
import {
  assertFederationStatusQueryFresh,
  FederationAcceptanceSchema,
  FederationError,
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

/** Status reads do not authorize execution or require an unexpired execution agreement. */
export class FederationStatusResponder {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async receive(queryJws: string, fingerprint: string): Promise<string> {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(queryJws),
      this.clock(),
    );
    const { payload: query, digest } = await verifyFederationMessage(
      FederationStatusQuerySchema,
      queryJws,
      peer,
      this.clock(),
    );
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signingKey.siteId)
      throw new FederationError("POLICY_DENIED");
    const local = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    if (!local.allowedKinds.includes("status-report"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const authorize = async (tx: FederationTransaction) => {
      assertFederationStatusQueryFresh(query, this.clock());
      for (const site of [peer.siteId, this.signingKey.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, this.clock());
        else await this.trust.assertKey(tx, site, this.signingKey.keyId, this.clock());
      }
    };
    const report = await this.db.transaction(async (tx) => {
      await authorize(tx);
      const [row] = await tx
        .select({
          receipt: federationReservations.receipt,
          receiptState: federationReservations.state,
          requestDigest: federationReservations.requestDigest,
          preparation: {
            state: federationPreparations.state,
            updatedAt: federationPreparations.updatedAt,
          },
          workflow: { status: workflowRuns.status, updatedAt: workflowRuns.updatedAt },
        })
        .from(federationReservations)
        .leftJoin(
          federationPreparations,
          eq(federationPreparations.reservationId, federationReservations.id),
        )
        .leftJoin(
          federationWorkflowBindings,
          eq(federationWorkflowBindings.reservationId, federationReservations.id),
        )
        .leftJoin(workflowRuns, eq(workflowRuns.id, federationWorkflowBindings.workflowRunId))
        .where(
          and(
            eq(federationReservations.id, query.reservationId),
            eq(federationReservations.senderSiteId, peer.siteId),
            eq(federationReservations.operationId, query.operationId),
            eq(federationReservations.agreementRevisionId, query.agreementRevisionId),
            eq(federationReservations.taskId, query.taskId),
            eq(federationReservations.attempt, query.attempt),
          ),
        );
      if (!row || row.receiptState !== "reserved" || row.requestDigest !== query.requestDigest)
        throw new FederationError("POLICY_DENIED");
      const receipt = FederationAcceptanceSchema.parse(row.receipt);
      if (
        receipt.senderSiteId !== this.signingKey.siteId ||
        receipt.recipientSiteId !== peer.siteId
      )
        throw new FederationError("POLICY_DENIED");
      return FederationStatusReportSchema.parse({
        protocolVersion: 1,
        kind: "status-report",
        queryId: query.queryId,
        senderSiteId: this.signingKey.siteId,
        recipientSiteId: peer.siteId,
        operationId: query.operationId,
        agreementRevisionId: query.agreementRevisionId,
        taskId: query.taskId,
        attempt: query.attempt,
        reservationId: query.reservationId,
        requestDigest: query.requestDigest,
        queryDigest: digest,
        observedAt: this.clock().toISOString(),
        preparation: row.preparation
          ? {
              state: row.preparation.state,
              updatedAt: row.preparation.updatedAt.toISOString(),
            }
          : null,
        workflow: row.workflow
          ? {
              status: row.workflow.status,
              updatedAt: row.workflow.updatedAt.toISOString(),
            }
          : null,
      });
    });
    const jws = await signFederationMessage(FederationStatusReportSchema, report, this.signingKey);
    // Revocation during signing must not release the snapshot to the former peer.
    await this.db.transaction(authorize);
    return jws;
  }
}
