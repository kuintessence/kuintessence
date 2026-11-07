import {
  federationAgreementApprovals,
  federationOutbound,
  federationSites,
  type PgDb,
} from "@kuintessence/db";
import {
  assertFederationReportIdentity,
  FederationDataOriginSchema,
  FederationError,
  type FederationResultCopyBinding,
  FederationResultCopyBindingSchema,
  FederationResultDownloadGrantSchema,
  FederationResultDownloadQuerySchema,
  FederationResultQuerySchema,
  FederationResultReportSchema,
} from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import type { FederationSend } from "./outbound-client";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { signedDownloadExpiry } from "./result-download-credential";
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
    const authorize = (tx: FederationTransaction) => this.authorize(tx, actor, operationId);
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

  /** Internal transfer bridge: return only a currently authorized, verified storage credential. */
  async downloadGrant(
    actor: FederationActor,
    input: FederationResultCopyBinding,
    allowedOrigins: readonly string[],
  ) {
    const binding = FederationResultCopyBindingSchema.parse(input);
    const authorize = (tx: FederationTransaction) => this.authorize(tx, actor, binding.operationId);
    const { row, receipt, policy } = await this.db.transaction(authorize);
    const origins = new Set(
      allowedOrigins.map((value) => new URL(FederationDataOriginSchema.parse(value)).origin),
    );
    if (!origins.size || binding.sizeBytes > policy.maxBytes)
      throw new FederationError("POLICY_DENIED");
    const ownKey = await this.trust.resolveKey(
      this.signingKey.siteId,
      this.signingKey.keyId,
      this.clock(),
    );
    if (!ownKey.allowedKinds.includes("result-download-query"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const query = FederationResultDownloadQuerySchema.parse({
      protocolVersion: 1,
      kind: "result-download-query",
      queryId: crypto.randomUUID(),
      senderSiteId: this.signingKey.siteId,
      recipientSiteId: row.request.recipientSiteId,
      operationId: row.operationId,
      agreementRevisionId: row.agreementRevisionId,
      taskId: row.taskId,
      attempt: row.attempt,
      reservationId: receipt.reservationId,
      requestDigest: row.requestDigest,
      issuedAt: this.clock().toISOString(),
      expiresAt: new Date(
        Math.min(this.clock().getTime() + 60_000, Date.parse(policy.availableUntil)),
      ).toISOString(),
      binding,
    });
    const requestJws = await signFederationMessage(
      FederationResultDownloadQuerySchema,
      query,
      this.signingKey,
    );
    const verified = await verifyFederationMessage(
      FederationResultDownloadQuerySchema,
      requestJws,
      ownKey,
      this.clock(),
    );
    await this.db.transaction(authorize);
    const response = await this.send(row.endpoint, requestJws, "/federation/v1/result-downloads");
    const keyId = federationMessageKeyId(response);
    const peer = await this.trust.resolveKey(query.recipientSiteId, keyId, this.clock());
    const { payload: grant } = await verifyFederationMessage(
      FederationResultDownloadGrantSchema,
      response,
      peer,
      this.clock(),
    );
    const validate = () => {
      assertFederationReportIdentity(query, verified.digest, grant, this.clock());
      const expires = Date.parse(grant.expiresAt);
      if (
        signedDownloadExpiry(
          grant.url,
          this.clock().getTime(),
          Math.min(
            Date.parse(query.expiresAt),
            Date.parse(policy.availableUntil),
            this.clock().getTime() + 30_000,
          ),
        ) !== grant.expiresAt
      )
        throw new FederationError("INVALID_MESSAGE");
      if (
        federationMaterialDigest(grant.binding) !== federationMaterialDigest(binding) ||
        !origins.has(new URL(grant.url).origin) ||
        expires <= this.clock().getTime() ||
        expires > Date.parse(query.expiresAt) ||
        expires > Date.parse(policy.availableUntil) ||
        expires > Date.parse(grant.observedAt) + 30_000 ||
        expires > this.clock().getTime() + 30_000
      )
        throw new FederationError("INVALID_MESSAGE");
    };
    validate();
    await this.db.transaction(async (tx) => {
      await authorize(tx);
      await this.trust.assertKey(tx, peer.siteId, keyId, this.clock());
      const currentPeer = await this.trust.resolveKey(peer.siteId, keyId, this.clock(), tx);
      const currentOwn = await this.trust.resolveKey(
        this.signingKey.siteId,
        this.signingKey.keyId,
        this.clock(),
        tx,
      );
      if (
        !currentPeer.allowedKinds.includes("result-download-grant") ||
        !currentOwn.allowedKinds.includes("result-download-query")
      )
        throw new FederationError("UNTRUSTED_IDENTITY");
      validate();
    });
    // Signed URL and JWS must stay out of durable records, logs and ordinary inventory responses.
    return {
      binding: grant.binding,
      direction: "download" as const,
      url: grant.url,
      expiresAt: grant.expiresAt,
    };
  }

  private async authorize(tx: FederationTransaction, actor: FederationActor, operationId: string) {
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
  }
}
