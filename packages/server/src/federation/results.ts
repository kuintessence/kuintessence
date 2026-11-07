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
  FederationDelegationSchema,
  FederationError,
  type FederationResultManifest,
  FederationResultManifestSchema,
  type FederationResultQuery,
  FederationResultQuerySchema,
  FederationResultReportSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { validateArtifactMembers } from "../services/artifact-members";
import { federationMaterialDigest } from "./assets";
import { requireExecutionIdentity } from "./execution-identity";
import { requireFederationResultPolicy } from "./result-policy";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { type FederationTransaction, FederationTrustRegistry } from "./trust-registry";

/** Signed inventory only. No storage path, local identity, download credential or file bytes. */
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
    const manifest = await this.db.transaction(read);
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
      if (federationMaterialDigest(await read(tx)) !== manifestDigest)
        throw new FederationError("OPERATION_CONFLICT");
    });
    return jws;
  }

  private async manifest(tx: FederationTransaction, query: FederationResultQuery) {
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
    const { terms, policy } = await requireFederationResultPolicy(
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
        files.push({
          path: member.relativePath,
          sha256: member.sha256,
          sizeBytes: member.sizeBytes,
        });
      }
      outputs.push({
        outputId: federationMaterialDigest({
          operationId: query.operationId,
          artifactId: artifact.id,
        }),
        nodeId: artifact.producerNodeId,
        descriptor: artifact.descriptor,
        type: artifact.ioType === "FileBatch" ? "FileBatch" : "File",
        contentDigest: `sha256:${artifact.contentHash}`,
        sizeBytes: artifact.sizeBytes,
        files,
      });
    }
    return FederationResultManifestSchema.parse({
      template: request.template,
      inputManifestDigest: request.inputManifestDigest,
      environmentLockDigest: request.environmentLockDigest,
      completedAt: run.completedAt.toISOString(),
      availableUntil: policy.availableUntil,
      outputs,
    });
  }
}
