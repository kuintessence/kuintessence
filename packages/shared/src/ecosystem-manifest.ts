import { z } from "zod";
import { EcosystemMaterialRequirementSchema } from "./ecosystem-materials";

const EcosystemBundleAssetEnvelopeSchema = z.strictObject({
  ecosystemKey: z.string().min(1).max(255),
  kind: z.enum([
    "data-product",
    "site-runtime",
    "spack-package",
    "usecase",
    "workflow-template",
    "sandbox-script",
  ]),
  name: z.string().min(1).max(255),
  version: z.string().min(1).max(100),
  payload: z.record(z.string(), z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
  licensePolicy: z.record(z.string(), z.unknown()),
  specDigest: z
    .string()
    .regex(/^sha256:[a-f0-9]{64}$/)
    .optional(),
});

export const EcosystemManifestEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  releaseKey: z.string().min(1).max(255),
  version: z.string().min(1).max(100),
  provenance: z.record(z.string(), z.unknown()),
  profile: z.literal("scientific-ecosystem-v1").optional(),
  assets: z.array(EcosystemBundleAssetEnvelopeSchema).min(1),
  runtimeReference: z.record(z.string(), z.unknown()).optional(),
  materialRequirements: z.array(EcosystemMaterialRequirementSchema).max(200).optional(),
});

export const SignedEcosystemBundleEnvelopeSchema = z.strictObject({
  manifest: EcosystemManifestEnvelopeSchema,
  signingKeyId: z.string().min(1).max(255),
  signature: z.string().min(1),
});
