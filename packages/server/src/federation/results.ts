import {
  federationAgreements,
  federationReservations,
  federationWorkflowBindings,
  jobs,
  netdriveFiles,
  type PgDb,
  workflowArtifactFiles,
  workflowArtifacts,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import {
  assertFederationStatusQueryFresh,
  FederationDataOriginSchema,
  FederationDelegationSchema,
  FederationError,
  FederationResultDownloadGrantSchema,
  FederationResultDownloadQuerySchema,
  type FederationResultManifest,
  FederationResultManifestSchema,
  type FederationResultQuery,
  FederationResultQuerySchema,
  FederationResultReportSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { validateArtifactMembers } from "../services/artifact-members";
import { federationMaterialDigest } from "./assets";
import { type FederationDownloadStorage, signedDownloadExpiry } from "./download-credential";
import { requireExecutionIdentity } from "./execution-identity";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { requireFederationResultPolicy } from "./result-policy";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

export type FederationResultDownloadStorage = FederationDownloadStorage;

/** Inventory and short-lived credentials travel separately; bytes never pass through this service. */
export class FederationResultResponder {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signingKey: FederationSigningKey,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async receive(queryJws: string, fingerprint: string) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(queryJws),
      this.clock(),
    );
    const { payload: query, digest } = await verifyFederationMessage(
      FederationResultQuerySchema,
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
    if (!local.allowedKinds.includes("result-report"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const read = async (tx: FederationTransaction) => {
      assertFederationStatusQueryFresh(query, this.clock());
      for (const site of [peer.siteId, this.signingKey.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, this.clock());
        else await this.trust.assertKey(tx, site, this.signingKey.keyId, this.clock());
      }
      return this.manifest(tx, query);
    };
    const { manifest } = await this.db.transaction(read);
    const manifestDigest = federationMaterialDigest(manifest);
    const { issuedAt: _issuedAt, expiresAt: _expiresAt, ...identity } = query;
    const report = FederationResultReportSchema.parse({
      ...identity,
      kind: "result-report",
      senderSiteId: query.recipientSiteId,
      recipientSiteId: query.senderSiteId,
      queryDigest: digest,
      observedAt: this.clock().toISOString(),
      manifestDigest,
      manifest,
    });
    const jws = await signFederationMessage(FederationResultReportSchema, report, this.signingKey);
    // Revocation, deletion or content changes while signing cannot release the older snapshot.
    await this.db.transaction(async (tx) => {
      if (federationMaterialDigest((await read(tx)).manifest) !== manifestDigest)
        throw new FederationError("OPERATION_CONFLICT");
    });
    return jws;
  }

  async receiveDownload(
    queryJws: string,
    fingerprint: string,
    options: FederationResultDownloadStorage,
  ) {
    const peer = await this.trust.resolvePeer(
      fingerprint,
      federationMessageKeyId(queryJws),
      this.clock(),
    );
    const { payload: query, digest } = await verifyFederationMessage(
      FederationResultDownloadQuerySchema,
      queryJws,
      peer,
      this.clock(),
    );
    if (query.senderSiteId !== peer.siteId || query.recipientSiteId !== this.signingKey.siteId)
      throw new FederationError("POLICY_DENIED");
    const read = async (tx: FederationTransaction) => {
      assertFederationStatusQueryFresh(query, this.clock());
      for (const site of [peer.siteId, this.signingKey.siteId].sort()) {
        if (site === peer.siteId)
          await this.trust.assertPeer(tx, fingerprint, site, peer.keyId, this.clock());
        else await this.trust.assertKey(tx, site, this.signingKey.keyId, this.clock());
      }
      const local = await this.trust.resolveKey(
        this.signingKey.siteId,
        this.signingKey.keyId,
        this.clock(),
        tx,
      );
      const sender = await this.trust.resolveKey(peer.siteId, peer.keyId, this.clock(), tx);
      if (
        !local.allowedKinds.includes("result-download-grant") ||
        !sender.allowedKinds.includes("result-download-query")
      )
        throw new FederationError("UNTRUSTED_IDENTITY");
      const snapshot = await this.manifest(tx, query);
      if (snapshot.delivery !== "network") throw new FederationError("POLICY_DENIED");
      const file = snapshot.sources.get(`${query.binding.outputId}/${query.binding.path}`);
      if (
        !file ||
        federationMaterialDigest(snapshot.manifest) !== query.binding.manifestDigest ||
        file.sha256 !== query.binding.sha256 ||
        file.size !== query.binding.sizeBytes
      )
        throw new FederationError("OPERATION_CONFLICT");
      return { file, availableUntil: snapshot.manifest.availableUntil };
    };
    const first = await this.db.transaction(read);
    const origins = new Set(
      options.allowedOrigins.map(
        (origin) => new URL(FederationDataOriginSchema.parse(origin)).origin,
      ),
    );
    if (!origins.size) throw new FederationError("POLICY_DENIED");
    // Head and presign do not hold database locks or read the object body.
    const stat = await options.storage.head(
      first.file.storageKey,
      first.file.storageVersionId ?? undefined,
    );
    if (
      !stat ||
      stat.size !== first.file.size ||
      (first.file.storageVersionId && stat.versionId !== first.file.storageVersionId) ||
      (first.file.etag && stat.etag !== first.file.etag.replace(/^"|"$/g, ""))
    )
      throw new FederationError("ASSET_UNAVAILABLE");
    const now = this.clock().getTime();
    const seconds = Math.floor(
      (Math.min(now + 30_000, Date.parse(query.expiresAt), Date.parse(first.availableUntil)) -
        now) /
        1000,
    );
    if (seconds < 1) throw new FederationError("AUTHORIZATION_EXPIRED");
    const deadline = Math.min(
      now + 30_000,
      Date.parse(query.expiresAt),
      Date.parse(first.availableUntil),
    );
    const url = await options.storage.presignDownload(
      first.file.storageKey,
      seconds,
      undefined,
      stat.versionId,
    );
    const expiresAt = signedDownloadExpiry(url, this.clock().getTime(), deadline);
    const { issuedAt: _issuedAt, expiresAt: _queryExpiresAt, ...identity } = query;
    const grant = FederationResultDownloadGrantSchema.parse({
      ...identity,
      kind: "result-download-grant",
      senderSiteId: query.recipientSiteId,
      recipientSiteId: query.senderSiteId,
      queryDigest: digest,
      observedAt: this.clock().toISOString(),
      url,
      expiresAt,
    });
    if (!origins.has(new URL(grant.url).origin)) throw new FederationError("POLICY_DENIED");
    const signed = await signFederationMessage(
      FederationResultDownloadGrantSchema,
      grant,
      this.signingKey,
    );
    await this.db.transaction(async (tx) => {
      const current = await read(tx);
      if (
        current.file.id !== first.file.id ||
        current.file.storageKey !== first.file.storageKey ||
        current.file.storageVersionId !== first.file.storageVersionId ||
        current.file.etag !== first.file.etag
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (Date.parse(expiresAt) <= this.clock().getTime())
        throw new FederationError("AUTHORIZATION_EXPIRED");
    });
    return signed;
  }

  /** Local operator may release only this organization's original execution results to its requester. */
  async mediaResults(
    tx: FederationTransaction,
    actor: FederationActor,
    input: { operationId: string; agreementRevisionId: string; recipientSiteId: string },
  ) {
    await requireFederationCapability(tx, actor, "media.export");
    const [row] = await tx
      .select({ reservation: federationReservations, agreement: federationAgreements })
      .from(federationReservations)
      .innerJoin(
        federationAgreements,
        eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
      )
      .where(
        and(
          eq(federationReservations.operationId, input.operationId),
          eq(federationReservations.senderSiteId, input.recipientSiteId),
          eq(federationAgreements.revisionId, input.agreementRevisionId),
          eq(federationAgreements.targetSiteId, this.signingKey.siteId),
          eq(federationAgreements.localOrgId, actor.orgId),
        ),
      )
      .for("share", { of: [federationReservations, federationAgreements] });
    if (!row) throw new FederationError("POLICY_DENIED");
    const reservation = row.reservation;
    const query = {
      protocolVersion: 1 as const,
      queryId: crypto.randomUUID(),
      senderSiteId: reservation.senderSiteId,
      recipientSiteId: this.signingKey.siteId,
      agreementRevisionId: reservation.agreementRevisionId,
      operationId: reservation.operationId,
      reservationId: reservation.id,
      requestDigest: reservation.requestDigest,
      taskId: reservation.taskId,
      attempt: reservation.attempt,
      issuedAt: this.clock().toISOString(),
      expiresAt: new Date(this.clock().getTime() + 30_000).toISOString(),
    };
    const snapshot = await this.manifest(tx, query);
    if (snapshot.delivery !== "media") throw new FederationError("POLICY_DENIED");
    return {
      ...snapshot,
      operationId: reservation.operationId,
      taskId: reservation.taskId,
      attempt: reservation.attempt,
      requestDigest: reservation.requestDigest,
    };
  }

  private async manifest(tx: FederationTransaction, query: Omit<FederationResultQuery, "kind">) {
    const [agreement] = await tx
      .select()
      .from(federationAgreements)
      .where(
        and(
          eq(federationAgreements.revisionId, query.agreementRevisionId),
          eq(federationAgreements.sourceSiteId, query.senderSiteId),
          eq(federationAgreements.targetSiteId, query.recipientSiteId),
        ),
      )
      .for("share");
    if (!agreement) throw new FederationError("POLICY_DENIED");
    const { terms, policy, authorizedUntil } = await requireFederationResultPolicy(
      tx,
      this.trust,
      agreement,
      this.clock(),
    );
    if (
      terms.agreementRevisionId !== query.agreementRevisionId ||
      terms.sourceSiteId !== query.senderSiteId ||
      terms.targetSiteId !== query.recipientSiteId
    )
      throw new FederationError("OPERATION_CONFLICT");
    await requireExecutionIdentity(tx, {
      orgId: agreement.localOrgId,
      userId: agreement.executionUserId,
    });
    const [reservation] = await tx
      .select()
      .from(federationReservations)
      .where(
        and(
          eq(federationReservations.id, query.reservationId),
          eq(federationReservations.agreementRevisionId, agreement.revisionId),
          eq(federationReservations.senderSiteId, query.senderSiteId),
          eq(federationReservations.operationId, query.operationId),
          eq(federationReservations.taskId, query.taskId),
          eq(federationReservations.attempt, query.attempt),
          eq(federationReservations.requestDigest, query.requestDigest),
        ),
      )
      .for("share");
    if (!reservation || reservation.state !== "reserved")
      throw new FederationError("POLICY_DENIED");
    const requestKeyId = federationMessageKeyId(reservation.requestJws);
    await this.trust.assertKey(tx, query.senderSiteId, requestKeyId, this.clock());
    const requestKey = await this.trust.resolveKey(
      query.senderSiteId,
      requestKeyId,
      this.clock(),
      tx,
    );
    const signed = await verifyFederationMessage(
      FederationDelegationSchema,
      reservation.requestJws,
      requestKey,
      this.clock(),
    );
    if (signed.digest !== query.requestDigest) throw new FederationError("OPERATION_CONFLICT");
    const request = signed.payload;
    if (
      (
        [
          "operationId",
          "agreementRevisionId",
          "taskId",
          "attempt",
          "senderSiteId",
          "recipientSiteId",
        ] as const
      ).some((field) => request[field] !== query[field])
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (
      request.recipientSiteId !== query.recipientSiteId ||
      request.senderSiteId !== query.senderSiteId ||
      !terms.templates.some(
        (template) =>
          federationMaterialDigest(template) === federationMaterialDigest(request.template),
      )
    )
      throw new FederationError("POLICY_DENIED");
    const [binding] = await tx
      .select()
      .from(federationWorkflowBindings)
      .where(eq(federationWorkflowBindings.reservationId, reservation.id))
      .for("share");
    if (!binding) throw new FederationError("DATA_WAITING");
    if (
      binding.snapshotDigest !== federationMaterialDigest(binding.snapshot) ||
      binding.snapshot.requestDigest !== query.requestDigest ||
      federationMaterialDigest(binding.snapshot.request) !== federationMaterialDigest(request) ||
      binding.snapshot.identity.orgId !== agreement.localOrgId ||
      binding.snapshot.identity.userId !== agreement.executionUserId
    )
      throw new FederationError("OPERATION_CONFLICT");
    const [run] = await tx
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, binding.workflowRunId));
    if (
      !run ||
      run.submittedBy !== agreement.executionUserId ||
      run.input?.federationReservationId !== reservation.id
    )
      throw new FederationError("POLICY_DENIED");
    if (run.status !== "completed" || !run.completedAt) throw new FederationError("DATA_WAITING");
    if (!run.result) throw new FederationError("ASSET_UNAVAILABLE");
    const refs = new Set<string>();
    const pending: unknown[] = Object.values(run.result.values).flatMap((node) =>
      Object.values(node.values),
    );
    while (pending.length) {
      const value = pending.pop();
      if (Array.isArray(value)) {
        pending.push(...value);
        continue;
      }
      if (!value || typeof value !== "object") continue;
      if (
        "artifactId" in value &&
        "type" in value &&
        (value.type === "File" || value.type === "FileBatch")
      ) {
        if (typeof value.artifactId !== "string") throw new FederationError("ASSET_UNAVAILABLE");
        refs.add(value.artifactId);
      }
    }
    // A deleted artifact row must not turn a previously nonempty result into an empty success.
    if (refs.size) {
      const saved = await tx
        .select({ id: workflowArtifacts.id })
        .from(workflowArtifacts)
        .where(
          and(
            eq(workflowArtifacts.workflowRunId, run.id),
            inArray(workflowArtifacts.id, [...refs]),
          ),
        );
      if (saved.length !== refs.size) throw new FederationError("ASSET_UNAVAILABLE");
    }
    const artifacts = await tx
      .select()
      .from(workflowArtifacts)
      .where(
        and(
          eq(workflowArtifacts.workflowRunId, run.id),
          eq(workflowArtifacts.durability, "Persistent"),
          inArray(workflowArtifacts.ioType, ["File", "FileBatch"]),
        ),
      )
      .orderBy(asc(workflowArtifacts.id))
      .limit(257)
      .for("share");
    if (artifacts.length > 256) throw new FederationError("POLICY_DENIED");
    const outputs: FederationResultManifest["outputs"] = [];
    const sources = new Map<string, typeof netdriveFiles.$inferSelect>();
    let totalBytes = 0,
      totalFiles = 0;
    for (const artifact of artifacts) {
      if (!artifact.producerJobId || !artifact.persistentAt)
        throw new FederationError("ASSET_UNAVAILABLE");
      const [producer] = await tx
        .select()
        .from(jobs)
        .where(eq(jobs.id, artifact.producerJobId))
        .for("share");
      if (
        !producer ||
        producer.submittedBy !== agreement.executionUserId ||
        producer.status !== "completed" ||
        producer.restrictedNoEgress
      )
        throw new FederationError("POLICY_DENIED");
      if (!Object.values(run.stepJobs).includes(producer.id)) {
        const [invocation] = await tx
          .select({ id: workflowExecutionJobs.jobId })
          .from(workflowExecutionJobs)
          .where(
            and(
              eq(workflowExecutionJobs.runId, run.id),
              eq(workflowExecutionJobs.jobId, producer.id),
            ),
          )
          .for("share");
        if (!invocation) throw new FederationError("POLICY_DENIED");
      }
      const members = validateArtifactMembers(artifact) ?? [
        { relativePath: "result", sha256: artifact.contentHash, sizeBytes: artifact.sizeBytes },
      ];
      totalFiles += members.length;
      totalBytes += artifact.sizeBytes;
      if (
        totalFiles > policy.maxFiles ||
        !Number.isSafeInteger(totalBytes) ||
        totalBytes > policy.maxBytes
      )
        throw new FederationError("POLICY_DENIED");
      const outputId = federationMaterialDigest({
        operationId: query.operationId,
        artifactId: artifact.id,
      });
      const files = [];
      for (const member of members) {
        let fileId = artifact.netdriveFileId;
        if (artifact.ioType === "FileBatch") {
          const [mapping] = await tx
            .select()
            .from(workflowArtifactFiles)
            .where(
              and(
                eq(workflowArtifactFiles.artifactId, artifact.id),
                eq(workflowArtifactFiles.relativePath, member.relativePath),
              ),
            )
            .for("share");
          fileId = mapping?.netdriveFileId ?? null;
        }
        if (!fileId) throw new FederationError("ASSET_UNAVAILABLE");
        const [file] = await tx
          .select()
          .from(netdriveFiles)
          .where(
            and(
              eq(netdriveFiles.id, fileId),
              eq(netdriveFiles.ownerId, agreement.executionUserId),
              isNull(netdriveFiles.deletedAt),
            ),
          )
          .for("share");
        if (!file || file.size !== member.sizeBytes || file.sha256 !== member.sha256)
          throw new FederationError("ASSET_UNAVAILABLE");
        sources.set(`${outputId}/${member.relativePath}`, file);
        files.push({
          path: member.relativePath,
          sha256: member.sha256,
          sizeBytes: member.sizeBytes,
        });
      }
      outputs.push({
        outputId,
        nodeId: artifact.producerNodeId,
        descriptor: artifact.descriptor,
        type: artifact.ioType === "FileBatch" ? "FileBatch" : "File",
        contentDigest: `sha256:${artifact.contentHash}`,
        sizeBytes: artifact.sizeBytes,
        files,
      });
    }
    const manifest = FederationResultManifestSchema.parse({
      template: request.template,
      inputManifestDigest: request.inputManifestDigest,
      environmentLockDigest: request.environmentLockDigest,
      completedAt: run.completedAt.toISOString(),
      availableUntil: policy.availableUntil,
      outputs,
    });
    return {
      manifest,
      sources,
      delivery: request.resultDelivery ?? "network",
      authorizedUntil: Math.min(authorizedUntil, requestKey.validUntil.getTime()),
    };
  }
}
