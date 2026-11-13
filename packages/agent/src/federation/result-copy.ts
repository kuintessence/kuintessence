import { createHash } from "node:crypto";
import {
  FederationResultCopyBindingSchema as BindingSchema,
  type FederationResultCopyBinding,
  type FederationResultCopyTask,
  federationCanonicalJson,
  FederationResultCopyGrantSchema as GrantSchema,
  FederationResultCopyTaskSchema as TaskSchema,
} from "@kuintessence/shared/federation";
import {
  copyFederationFile,
  type FederationFileCopyOptions,
  FederationFileTransferError,
} from "./file-copy";

export {
  boundedAuthorization,
  FederationFileTransferError as FederationResultCopyError,
  origins,
} from "./file-copy";
export type FederationResultCopyOptions = Omit<
  FederationFileCopyOptions<FederationResultCopyBinding>,
  "binding" | "partSize" | "availableUntil" | "grantSchema"
> & { task: FederationResultCopyTask };

/** Agent-side byte movement only: returns uncommitted S3 parts, never publishes a usable replica. */
export async function copyFederationResultFile(opts: FederationResultCopyOptions) {
  const parsed = TaskSchema.safeParse(opts.task);
  if (!parsed.success) throw new FederationFileTransferError("INVALID_TASK");
  const task = parsed.data;
  const digest = `sha256:${createHash("sha256").update(federationCanonicalJson(task.report.manifest)).digest("hex")}`;
  const output = task.report.manifest.outputs.find((item) => item.outputId === task.outputId);
  const member = output?.files.find((item) => item.path === task.path);
  if (!member || digest !== task.report.manifestDigest)
    throw new FederationFileTransferError("INVALID_TASK");
  const binding = BindingSchema.parse({
    transferId: task.transferId,
    generation: task.generation,
    operationId: task.report.operationId,
    manifestDigest: digest,
    outputId: task.outputId,
    path: task.path,
    sizeBytes: member.sizeBytes,
    sha256: member.sha256,
    partSize: task.partSize,
  });
  return copyFederationFile({
    ...opts,
    binding,
    partSize: task.partSize,
    availableUntil: task.report.manifest.availableUntil,
    grantSchema: GrantSchema,
  });
}

export type {
  FederationResultCopyBinding,
  FederationResultCopyGrant,
  FederationResultCopyTask,
} from "@kuintessence/shared/federation";
