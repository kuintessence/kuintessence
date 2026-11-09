import {
  federationAgreements,
  federationOutbound,
  federationReservations,
  federationResultImports,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationAcceptanceSchema,
  FederationAgreementSchema,
  FederationDelegationSchema,
  FederationError,
  type FederationMediaManifest,
  FederationResultReportSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, eq, ne } from "drizzle-orm";
import { federationMaterialDigest } from "./assets";
import type { FederationInputImports } from "./input-imports";
import { type FederationActor, requireFederationCapability } from "./permissions";
import type { FederationPreparationService } from "./preparation";
import type { FederationResultReader } from "./result-reader";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

export type TaskMediaTarget = {
  manifestContentDigest: string;
  taskInputImportId: string | null;
  taskResultImportId: string | null;
  validUntil: number;
  authorizedUntil: number;
};
export type TaskMediaTargetReader = (tx: PgTransaction) => Promise<TaskMediaTarget>;

/** Original task imports own quota and files; an operator cannot supply a replacement inventory. */
export class FederationTaskMediaTargets {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly preparation: FederationPreparationService,
    private readonly inputs: FederationInputImports,
    private readonly results: FederationResultReader,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async authorize(
    actor: FederationActor,
    manifest: FederationMediaManifest,
  ): Promise<TaskMediaTargetReader> {
    const subject = manifest.subject;
    if (subject.kind === "dataset" || manifest.recipientSiteId !== this.siteId)
      throw new FederationError("POLICY_DENIED");
    await this.db.transaction((tx) => requireFederationCapability(tx, actor, "media.import"));
    if (subject.kind === "task-result") return (tx) => this.result(tx, actor, manifest);
    const [selected] = await this.db
      .select({ id: federationReservations.id })
      .from(federationReservations)
      .innerJoin(
        federationAgreements,
        eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
      )
      .where(
        and(
          eq(federationReservations.operationId, subject.operationId),
          eq(federationReservations.senderSiteId, manifest.senderSiteId),
          eq(federationReservations.agreementRevisionId, manifest.agreementRevisionId),
          eq(federationAgreements.targetSiteId, this.siteId),
          eq(federationAgreements.localOrgId, actor.orgId),
        ),
      );
    if (!selected) throw new FederationError("POLICY_DENIED");
    // Coordinated policy refresh must not run while holding package/import locks.
    const scope = await this.preparation.materialScope(selected.id);
    return async (tx) => {
      await requireFederationCapability(tx, actor, "media.import");
      const row = await this.inputs.lock(tx, scope);
      const request = scope.request;
      if (request.inputDelivery !== "media" || row.localOrgId !== actor.orgId)
        throw new FederationError("POLICY_DENIED");
      if (!["pending", "transferring"].includes(row.state))
        throw new FederationError("OPERATION_CONFLICT");
      this.identity(
        manifest,
        request,
        scope.saved.reservation.requestDigest,
        row.manifestDigest,
        false,
      );
      this.files(
        manifest,
        row.manifest.inputs.flatMap((input) => input.files),
      );
      const requestKey = await this.key(
        tx,
        request.senderSiteId,
        scope.saved.reservation.requestJws,
        "delegation",
      );
      const receiptKey = await this.key(
        tx,
        this.siteId,
        scope.saved.reservation.receiptJws ?? "",
        "acceptance",
      );
      const validUntil = Math.min(
        row.expiresAt.getTime(),
        Date.parse(FederationAgreementSchema.parse(scope.saved.agreement.terms).validUntil),
      );
      return {
        manifestContentDigest: federationMaterialDigest(manifest),
        taskInputImportId: row.id,
        taskResultImportId: null,
        validUntil,
        authorizedUntil: Math.min(
          validUntil,
          row.authorizedUntil,
          requestKey.validUntil.getTime(),
          receiptKey.validUntil.getTime(),
        ),
      };
    };
  }

  private async result(
    tx: PgTransaction,
    actor: FederationActor,
    manifest: FederationMediaManifest,
  ): Promise<TaskMediaTarget> {
    const subject = manifest.subject;
    if (subject.kind !== "task-result") throw new FederationError("POLICY_DENIED");
    await requireFederationCapability(tx, actor, "media.import");
    await tx
      .select({ operationId: federationOutbound.operationId })
      .from(federationOutbound)
      .where(
        and(
          eq(federationOutbound.localSiteId, this.siteId),
          eq(federationOutbound.localOrgId, actor.orgId),
          eq(federationOutbound.operationId, subject.operationId),
        ),
      )
      .for("share");
    const scope = await this.results.authorize(tx, actor, subject.operationId);
    const outbound = scope.row;
    if (outbound.cancelState) throw new FederationError("CANCELLATION_REQUESTED");
    if (
      outbound.submittedBy !== actor.userId ||
      outbound.request.resultDelivery !== "media" ||
      !outbound.receiptJws
    )
      throw new FederationError("POLICY_DENIED");
    const requestKey = await this.key(tx, this.siteId, outbound.requestJws);
    const receiptKey = await this.key(tx, manifest.senderSiteId, outbound.receiptJws);
    const signed = await verifyFederationMessage(
      FederationDelegationSchema,
      outbound.requestJws,
      requestKey,
      this.clock(),
    );
    const { payload: receipt } = await verifyFederationMessage(
      FederationAcceptanceSchema,
      outbound.receiptJws,
      receiptKey,
      this.clock(),
    );
    const request = signed.payload;
    if (
      signed.digest !== outbound.requestDigest ||
      federationCanonicalJson(request) !== federationCanonicalJson(outbound.request) ||
      federationCanonicalJson(receipt) !== federationCanonicalJson(outbound.receipt) ||
      receipt.requestDigest !== signed.digest ||
      receipt.senderSiteId !== request.recipientSiteId ||
      receipt.recipientSiteId !== request.senderSiteId ||
      receipt.reservedAmount !== request.maxAmount ||
      receipt.unit !== request.unit ||
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
      ).some((field) => receipt[field] !== request[field])
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [row] = await tx
      .select()
      .from(federationResultImports)
      .where(
        and(
          eq(federationResultImports.localSiteId, this.siteId),
          eq(federationResultImports.localOrgId, actor.orgId),
          eq(federationResultImports.requestedBy, actor.userId),
          eq(federationResultImports.operationId, request.operationId),
          eq(federationResultImports.manifestDigest, subject.contentDigest),
          ne(federationResultImports.state, "cancelled"),
        ),
      )
      .for("update");
    if (!row) throw new FederationError("DATA_WAITING");
    if (row.delivery !== "media" || !["pending", "transferring", "verifying"].includes(row.state))
      throw new FederationError("OPERATION_CONFLICT");
    const reportKey = await this.key(tx, manifest.senderSiteId, row.reportJws);
    const { payload: report } = await verifyFederationMessage(
      FederationResultReportSchema,
      row.reportJws,
      reportKey,
      this.clock(),
    );
    const content = report.manifest;
    const files = content.outputs.flatMap((output) => output.files);
    const bytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
    if (
      federationCanonicalJson(report) !== federationCanonicalJson(row.report) ||
      federationMaterialDigest(content) !== row.manifestDigest ||
      report.manifestDigest !== row.manifestDigest ||
      report.requestDigest !== signed.digest ||
      report.reservationId !== receipt.reservationId ||
      report.senderSiteId !== request.recipientSiteId ||
      report.recipientSiteId !== this.siteId ||
      (["operationId", "agreementRevisionId", "taskId", "attempt"] as const).some(
        (field) => report[field] !== request[field],
      ) ||
      federationMaterialDigest(content.template) !== federationMaterialDigest(request.template) ||
      content.inputManifestDigest !== request.inputManifestDigest ||
      content.environmentLockDigest !== request.environmentLockDigest ||
      content.availableUntil !== scope.policy.availableUntil ||
      files.length > scope.policy.maxFiles ||
      bytes > scope.policy.maxBytes ||
      row.reservedBytes !== bytes
    )
      throw new FederationError("OPERATION_CONFLICT");
    this.identity(manifest, request, signed.digest, row.manifestDigest, true);
    this.files(manifest, files);
    const validUntil = Date.parse(scope.policy.availableUntil);
    return {
      manifestContentDigest: federationMaterialDigest(manifest),
      taskInputImportId: null,
      taskResultImportId: row.id,
      validUntil,
      authorizedUntil: Math.min(
        validUntil,
        scope.authorizedUntil,
        requestKey.validUntil.getTime(),
        receiptKey.validUntil.getTime(),
        reportKey.validUntil.getTime(),
      ),
    };
  }

  private identity(
    manifest: FederationMediaManifest,
    request: ReturnType<typeof FederationDelegationSchema.parse>,
    requestDigest: string,
    contentDigest: string,
    reverse: boolean,
  ) {
    const subject = manifest.subject;
    if (
      subject.kind === "dataset" ||
      manifest.senderSiteId !== (reverse ? request.recipientSiteId : request.senderSiteId) ||
      manifest.recipientSiteId !== (reverse ? request.senderSiteId : request.recipientSiteId) ||
      manifest.agreementRevisionId !== request.agreementRevisionId ||
      subject.operationId !== request.operationId ||
      subject.taskId !== request.taskId ||
      subject.attempt !== request.attempt ||
      subject.requestDigest !== requestDigest ||
      subject.contentDigest !== contentDigest
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private files(
    manifest: FederationMediaManifest,
    files: Array<{ sha256: string; sizeBytes: number }>,
  ) {
    if (
      manifest.files.length !== files.length ||
      manifest.files.some(
        (file, index) =>
          file.path !== `objects/${index.toString().padStart(6, "0")}` ||
          file.sha256 !== files[index]?.sha256 ||
          file.sizeBytes !== files[index]?.sizeBytes,
      )
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  private async key(
    tx: PgTransaction,
    siteId: string,
    jws: string,
    kind?: "delegation" | "acceptance",
  ) {
    const keyId = federationMessageKeyId(jws);
    await this.trust.assertKey(tx, siteId, keyId, this.clock());
    const key = await this.trust.resolveKey(siteId, keyId, this.clock(), tx);
    if (kind && !key.allowedKinds.includes(kind)) throw new FederationError("UNTRUSTED_IDENTITY");
    return key;
  }
}
