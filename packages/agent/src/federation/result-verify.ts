import {
  FederationResultVerificationGrantSchema,
  type FederationResultVerifyTask,
  FederationResultVerifyTaskSchema,
} from "@kuintessence/shared/federation";
import { type FederationFileVerifyOptions, verifyFederationFile } from "./file-verify";

export function verifyFederationResultFile(
  options: Omit<
    FederationFileVerifyOptions<FederationResultVerifyTask>,
    "taskSchema" | "grantSchema"
  >,
) {
  return verifyFederationFile({
    ...options,
    taskSchema: FederationResultVerifyTaskSchema,
    grantSchema: FederationResultVerificationGrantSchema,
  });
}
