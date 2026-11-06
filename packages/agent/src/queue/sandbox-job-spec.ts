import {
  SandboxDispatchIdentitySchema,
  SandboxDispatchMountSchema,
  SandboxExecutionModeSchema,
  SandboxSelfAccountSchema,
  SandboxTrustedExecutionProfileSchema,
  SandboxUnsignedManifestSchema,
} from "@kuintessence/shared";
import { z } from "zod";
import type { SandboxJobSpec } from "../adapters/base";

/** Recovery validates the materialized spec; it does not grant permission to submit it again. */
export const SandboxJobSpecSchema = z.object({
  language: z.enum(["python", "nodejs", "bash"]),
  entrypoint: z.string(),
  scriptContent: z.string(),
  scriptHostPath: z.string(),
  contextHostPath: z.string(),
  runtimeKind: z.enum(["OCI", "SIF"]),
  runtimePath: z.string(),
  executionMode: SandboxExecutionModeSchema,
  runtimeAttestationId: z.string().optional(),
  selfAccount: SandboxSelfAccountSchema.optional(),
  apptainerPath: z.string().optional(),
  seccompProfilePath: z.string().optional(),
  attestedNodes: z.array(z.string()).optional(),
  executionProfile: SandboxTrustedExecutionProfileSchema.optional(),
  identity: SandboxDispatchIdentitySchema.transform((identity) =>
    identity.backend === "Unix"
      ? { ...identity, schedulerAccount: identity.schedulerAccount ?? undefined }
      : { ...identity, quotaPolicy: identity.quotaPolicy ?? undefined },
  ),
  mounts: z.array(
    SandboxDispatchMountSchema.extend({ hostPath: z.string() }).transform((mount) => ({
      ...mount,
      expectedSha256: mount.expectedSha256 ?? undefined,
      inlineContentBase64: mount.inlineContentBase64 ?? undefined,
    })),
  ),
  limits: SandboxUnsignedManifestSchema.shape.limits,
  kubernetesArtifactPvc: z.string().optional(),
}) satisfies z.ZodType<SandboxJobSpec>;
