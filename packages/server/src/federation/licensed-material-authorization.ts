import { fromBinary } from "@bufbuild/protobuf";
import { jobDispatchOutbox, jobs, type PgDb, type PgTransaction } from "@kuintessence/db";
import { ServerMessageSchema } from "@kuintessence/proto";
import type { JobSubmission } from "@kuintessence/shared";
import { FederationError, federationCanonicalJson } from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import {
  LicenseRuntimeGovernanceService,
  PgGovernanceRepository,
} from "../services/license-runtime-governance";

/** Compare current grants and local mappings to the material mounts in the original dispatch. */
export async function checkFederationLicensedMaterials(
  db: PgDb | PgTransaction,
  jobId: string,
  intent: JobSubmission,
  identity: { userId: string; orgId: string },
  target: { agentId: string; providerOrgId: string },
  lock = false,
): Promise<number> {
  const query = db
    .select({ job: jobs, outbox: jobDispatchOutbox })
    .from(jobs)
    .leftJoin(jobDispatchOutbox, eq(jobDispatchOutbox.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
  const [saved] = await (lock ? query.for("share", { of: jobs, noWait: true }) : query);
  if (!saved) throw new FederationError("OPERATION_CONFLICT");
  const { job, outbox } = saved;
  const requests = intent.licensedMaterials ?? [];
  if (
    job.submittedBy !== identity.userId ||
    job.orgId !== identity.orgId ||
    job.agentId !== target.agentId
  )
    throw new FederationError("OPERATION_CONFLICT");
  const message = outbox
    ? fromBinary(ServerMessageSchema, Buffer.from(outbox.payloadBase64, "base64"))
    : undefined;
  if (
    message &&
    (message.payload.case !== "dispatchJob" ||
      !message.payload.value.federationExecution ||
      message.payload.value.jobId !== jobId ||
      message.payload.value.dispatchEpoch !== BigInt(job.dispatchEpoch) ||
      outbox?.dispatchEpoch !== job.dispatchEpoch ||
      outbox.agentId !== target.agentId)
  )
    throw new FederationError("OPERATION_CONFLICT");
  const mounts =
    message?.payload.case === "dispatchJob" ? message.payload.value.licensedMaterialMounts : [];
  if (!requests.length && !mounts.length) return Number.POSITIVE_INFINITY;
  if ((!outbox && job.status === "running") || (outbox && mounts.length !== requests.length))
    throw new FederationError("OPERATION_CONFLICT");
  const repository = new PgGovernanceRepository(db, lock);
  const governance = new LicenseRuntimeGovernanceService(repository);
  let expiresAtUnixMs = Number.POSITIVE_INFINITY;
  for (const [index, request] of requests.entries()) {
    const material = await repository.getLicensedMaterial({
      selectorId: request.selector,
      ...target,
    });
    const blocks = await governance.evaluateLicensedMaterial({
      selectorId: request.selector,
      requiredElements: request.requiredElements,
      ...target,
    });
    if (
      !material ||
      blocks.length ||
      (request.licenseSubject && request.licenseSubject !== material.licenseSubject)
    )
      throw new FederationError("POLICY_DENIED");
    const mount = mounts[index];
    if (
      outbox &&
      (!mount ||
        mount.selector !== request.selector ||
        mount.targetPath !== request.targetPath ||
        mount.expectedFingerprint !== material.fingerprint ||
        mount.mappingId !== material.mappingId ||
        mount.assetId !== material.assetId ||
        mount.licenseSubject !== material.licenseSubject ||
        federationCanonicalJson(mount.requiredElements) !==
          federationCanonicalJson(request.requiredElements))
    )
      throw new FederationError("POLICY_DENIED");
    const policy = await governance.getCanonicalLicensePolicy(material.assetId);
    const authorization = await governance.evaluateLicenseAuthorization({
      assetKey: material.licenseSubject,
      assetId: material.assetId,
      policy: policy ?? undefined,
      providerEntitlementSubjectIds: [target.providerOrgId],
      consumerEntitlementSubjectIds: [identity.userId, identity.orgId],
      installRequested: false,
      now: new Date(Date.now()),
    });
    if (authorization.blocks.length) throw new FederationError("POLICY_DENIED");
    expiresAtUnixMs = Math.min(expiresAtUnixMs, authorization.expiresAtUnixMs);
  }
  if (!outbox && job.status === "queued")
    throw new Error("Material dispatch is still being prepared");
  return expiresAtUnixMs;
}
