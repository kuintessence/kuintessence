import {
  federationAgreementApprovals,
  federationOutbound,
  federationSites,
  type PgDb,
} from "@kuintessence/db";
import {
  assertFederationReportIdentity,
  FederationError,
  FederationResultQuerySchema,
  FederationResultReportSchema,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import type { FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { requireFederationResultPolicy } from "./result-policy";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

export class FederationResultReader {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async read(actor: FederationActor, operationId: string) {
    const authorize = async (tx: FederationTransaction) => {
      await requireFederationCapability(tx, actor, "result.read");
      const [row] = await tx
        .select()
        .from(federationOutbound)
        .where(
          and(
            eq(federationOutbound.localSiteId, this.signingKey.siteId),
            eq(federationOutbound.localOrgId, actor.orgId),
            eq(federationOutbound.operationId, operationId),
          ),
        );
      if (!row) throw new FederationError("POLICY_DENIED");
      if (row.state !== "accepted" || !row.receipt) throw new FederationError("OPERATION_CONFLICT");
      const [approval] = await tx
        .select()
        .from(federationAgreementApprovals)
        .where(
          and(
            eq(federationAgreementApprovals.localSiteId, this.signingKey.siteId),
            eq(federationAgreementApprovals.localOrgId, actor.orgId),
            eq(federationAgreementApprovals.revisionId, row.agreementRevisionId),
          ),
        )
        .for("share");
      if (!approval?.counterpartyApprovalJws) throw new FederationError("AGREEMENT_UNAVAILABLE");
      const { terms, policy } = await requireFederationResultPolicy(
        tx,
        this.trust,
        {
          ...approval,
          sourceApprovalJws: approval.approvalJws,
          targetApprovalJws: approval.counterpartyApprovalJws,
        },
        this.clock(),
      );
      if (
        terms.agreementRevisionId !== row.agreementRevisionId ||
        terms.sourceSiteId !== this.signingKey.siteId ||
        terms.targetSiteId !== row.request.recipientSiteId
      )
        throw new FederationError("POLICY_DENIED");
      const [target] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, row.request.recipientSiteId))
        .for("share");
      if (!target || target.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
      if (target.endpoint !== row.endpoint) throw new FederationError("OPERATION_CONFLICT");
      await this.trust.assertKey(tx, this.signingKey.siteId, this.signingKey.keyId, this.clock());
      return { row, receipt: row.receipt, policy };
    };
    const { row, receipt, policy } = await this.db.transaction(authorize);
    const ownKey = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    if (!ownKey.allowedKinds.includes("result-query"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const query = FederationResultQuerySchema.parse({
      protocolVersion: 1,
      kind: "result-query",
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
    const jws = await signFederationMessage(FederationResultQuerySchema, query, this.signingKey);
    const verified = await verifyFederationMessage(
      FederationResultQuerySchema,
      jws,
      ownKey,
      this.clock(),
    );
    await this.db.transaction(authorize);
    const reportJws = await this.send(row.endpoint, jws, "/federation/v1/results");
    const keyId = federationMessageKeyId(reportJws);
    const peer = await this.trust.resolveKey(query.recipientSiteId, keyId, this.clock());
    const { payload: report } = await verifyFederationMessage(
      FederationResultReportSchema,
      reportJws,
      peer,
      this.clock(),
    );
    assertFederationReportIdentity(query, verified.digest, report, this.clock());
    const manifest = report.manifest;
    const bytes = manifest.outputs.reduce((sum, output) => sum + output.sizeBytes, 0);
    const files = manifest.outputs.reduce((sum, output) => sum + output.files.length, 0);
    if (
      federationMaterialDigest(manifest) !== report.manifestDigest ||
      federationMaterialDigest(manifest.template) !==
        federationMaterialDigest(row.request.template) ||
      manifest.inputManifestDigest !== row.request.inputManifestDigest ||
      manifest.environmentLockDigest !== row.request.environmentLockDigest ||
      manifest.availableUntil !== policy.availableUntil ||
      !Number.isSafeInteger(bytes) ||
      bytes > policy.maxBytes ||
      files > policy.maxFiles ||
      Date.parse(manifest.completedAt) > Date.parse(report.observedAt) ||
      Date.parse(manifest.completedAt) < Date.parse(receipt.acceptedAt) - 60_000
    )
      throw new FederationError("INVALID_MESSAGE");
    await this.db.transaction(async (tx) => {
      await authorize(tx);
      await this.trust.assertKey(tx, peer.siteId, keyId, this.clock());
      assertFederationReportIdentity(query, verified.digest, report, this.clock());
    });
    return { report, reportJws, verifiedAt: this.clock().toISOString() };
  }
}
