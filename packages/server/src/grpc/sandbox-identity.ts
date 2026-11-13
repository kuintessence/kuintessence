import { create } from "@bufbuild/protobuf";
import {
  SandboxExecutionIdentitySchema,
  SandboxIdentityMode,
  SandboxKubernetesAccountSchema,
  SandboxUnixAccountSchema,
} from "@kuintessence/proto";
import type { SandboxDispatchIdentity } from "@kuintessence/shared";

export function sandboxIdentityToProto(identity: SandboxDispatchIdentity) {
  return create(SandboxExecutionIdentitySchema, {
    mode:
      identity.mode === "SharedService"
        ? SandboxIdentityMode.SHARED_SERVICE
        : SandboxIdentityMode.MAPPED_ACCOUNT,
    accountId: identity.accountId,
    backend:
      identity.backend === "Unix"
        ? {
            case: "unix",
            value: create(SandboxUnixAccountSchema, {
              username: identity.username,
              uid: identity.uid,
              gid: identity.gid,
              schedulerAccount: identity.schedulerAccount ?? "",
              allowedQueues: identity.allowedQueues,
            }),
          }
        : {
            case: "kubernetes",
            value: create(SandboxKubernetesAccountSchema, {
              namespace: identity.namespace,
              serviceAccount: identity.serviceAccount,
              quotaPolicy: identity.quotaPolicy ?? "",
            }),
          },
  });
}
