import {
  type FederationInputCopyBinding,
  FederationInputCopyGrantSchema,
  type FederationInputCopyTask,
  FederationInputCopyTaskSchema,
} from "@kuintessence/shared/federation";
import {
  copyFederationFile,
  type FederationFileCopyOptions,
  FederationFileTransferError,
} from "./file-copy";

export type FederationInputCopyOptions = Omit<
  FederationFileCopyOptions<FederationInputCopyBinding>,
  "binding" | "partSize" | "availableUntil" | "grantSchema"
> & { task: FederationInputCopyTask };

/** Returns uncommitted parts; the Server must verify the destination before publishing inputs. */
export async function copyFederationInputFile(options: FederationInputCopyOptions) {
  const task = FederationInputCopyTaskSchema.safeParse(options.task);
  if (!task.success) throw new FederationFileTransferError("INVALID_TASK");
  return copyFederationFile({
    ...options,
    ...task.data,
    grantSchema: FederationInputCopyGrantSchema,
  });
}
