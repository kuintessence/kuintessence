import { posix } from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import {
  jobDispatchOutbox,
  jobs,
  netdriveFiles,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import { type InputStaging, ServerMessageSchema } from "@kuintessence/proto";
import { type JobSubmission, WorkflowExecutionInterrupted } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";

export async function ownedNetdriveFiles(
  db: PgDb | PgTransaction,
  ids: string[],
  userId: string,
  lock: boolean,
) {
  if (ids.some((id) => !z.uuid().safeParse(id).success))
    throw new FederationError("OPERATION_CONFLICT");
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  const query = db
    .select()
    .from(netdriveFiles)
    .where(inArray(netdriveFiles.id, unique))
    .orderBy(netdriveFiles.id);
  const files = await (lock ? query.for("share", { noWait: true }) : query);
  if (
    files.length !== unique.length ||
    files.some((file) => file.ownerId !== userId || file.deletedAt)
  )
    throw new FederationError("POLICY_DENIED");
  return files;
}

export async function assertNetdriveSnapshots(
  db: PgDb | PgTransaction,
  inputs: readonly InputStaging[],
  userId: string,
  lock = false,
) {
  if (
    inputs.some(
      (input) =>
        !input.netdriveInput ||
        !input.stagePath ||
        posix.isAbsolute(input.stagePath) ||
        input.stagePath.includes("\\") ||
        input.stagePath.includes("\0") ||
        input.stagePath.split("/").some((part) => !part || part === "." || part === "..") ||
        !z.uuid().safeParse(input.deliveryLeaseId).success ||
        !/^[a-f0-9]{64}$/.test(input.expectedSha256) ||
        input.totalBytes < 0n ||
        input.totalBytes > BigInt(Number.MAX_SAFE_INTEGER),
    )
  )
    throw new FederationError("OPERATION_CONFLICT");
  const files = await ownedNetdriveFiles(
    db,
    inputs.map((input) => input.fileMetadataId),
    userId,
    lock,
  );
  for (const input of inputs) {
    const file = files.find((file) => file.id === input.fileMetadataId);
    if (!file || file.sha256 !== input.expectedSha256 || BigInt(file.size) !== input.totalBytes)
      throw new FederationError("POLICY_DENIED");
  }
  return files;
}

/** Running Jobs retain their original files, without requiring a fresh download URL. */
export async function checkFederationNetdriveJob(
  db: PgDb | PgTransaction,
  jobId: string,
  intent: JobSubmission,
  identity: { userId: string; orgId: string },
  lock = false,
): Promise<void> {
  if ("sandbox" in intent) return; // Sandbox checks its signed mounts and file ownership separately.
  const [saved] = await db
    .select({ job: jobs, outbox: jobDispatchOutbox })
    .from(jobs)
    .leftJoin(jobDispatchOutbox, eq(jobDispatchOutbox.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
  if (!saved || !["pending", "queued", "running"].includes(saved.job.status)) return;
  if (saved.job.submittedBy !== identity.userId || saved.job.orgId !== identity.orgId)
    throw new FederationError("OPERATION_CONFLICT");
  if (!saved.outbox) {
    await ownedNetdriveFiles(
      db,
      intent.inputStaging.map((input) => input.fileMetadataId),
      identity.userId,
      lock,
    );
    if (!intent.inputStaging.length || saved.job.status === "pending") return;
    if (saved.job.status === "queued")
      throw new WorkflowExecutionInterrupted("NetDrive dispatch is still being prepared");
    throw new FederationError("OPERATION_CONFLICT");
  }
  const message = fromBinary(
    ServerMessageSchema,
    Buffer.from(saved.outbox.payloadBase64, "base64"),
  );
  if (
    message.payload.case !== "dispatchJob" ||
    !message.payload.value.federationExecution ||
    message.payload.value.jobId !== jobId ||
    message.payload.value.dispatchEpoch !== BigInt(saved.job.dispatchEpoch) ||
    saved.outbox.agentId !== saved.job.agentId ||
    saved.outbox.dispatchEpoch !== saved.job.dispatchEpoch
  )
    throw new FederationError("OPERATION_CONFLICT");
  const inputs = message.payload.value.inputStaging.filter(
    (input) => input.netdriveInput || !input.deliveryLeaseId,
  );
  if (
    inputs.length !== intent.inputStaging.length ||
    new Set(inputs.map((input) => input.stagePath)).size !== inputs.length ||
    inputs.some(
      (input) =>
        !intent.inputStaging.some(
          (original) =>
            original.fileMetadataId === input.fileMetadataId &&
            original.stagePath === input.stagePath,
        ),
    )
  )
    throw new FederationError("OPERATION_CONFLICT");
  await assertNetdriveSnapshots(db, inputs, identity.userId, lock);
}
