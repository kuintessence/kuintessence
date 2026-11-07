import {
  FederationInputVerificationGrantSchema,
  type FederationInputVerifyTask,
  FederationInputVerifyTaskSchema,
} from "@kuintessence/shared/federation";
import { type FederationFileVerifyOptions, verifyFederationFile } from "./file-verify";

export function verifyFederationInputFile(
  options: Omit<
    FederationFileVerifyOptions<FederationInputVerifyTask>,
    "taskSchema" | "grantSchema"
  >,
) {
  return verifyFederationFile({
    ...options,
    taskSchema: FederationInputVerifyTaskSchema,
    grantSchema: FederationInputVerificationGrantSchema,
  });
}
