import { z } from "zod";
import { FederationInputDescriptorSchema, FederationInputPathSchema } from "./input-files";
import { FederationDigestSchema } from "./references";
import {
  FederationDownloadUrlSchema,
  FederationResultCopiedSchema,
  FederationResultCopyTaskSchema,
  FederationResultObjectSchema,
} from "./result-transfer";
import {
  FederationStatusQuerySchema,
  FederationStatusReportSchema,
  hasFederationQueryWindow,
} from "./status";

export const FederationInputCopyBindingSchema = z.strictObject({
  transferId: z.uuid(),
  generation: z.uuid(),
  operationId: z.uuid(),
  manifestDigest: FederationDigestSchema,
  descriptor: FederationInputDescriptorSchema,
  path: FederationInputPathSchema,
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type FederationInputCopyBinding = z.infer<typeof FederationInputCopyBindingSchema>;

export const FederationInputDownloadQuerySchema = z
  .strictObject({
    ...FederationStatusQuerySchema.shape,
    kind: z.literal("input-download-query"),
    binding: FederationInputCopyBindingSchema,
  })
  .refine(hasFederationQueryWindow)
  .refine((query) => query.operationId === query.binding.operationId, "Mismatched operation");
export type FederationInputDownloadQuery = z.infer<typeof FederationInputDownloadQuerySchema>;

/** A short-lived bearer credential, never persisted or included in logs. */
export const FederationInputDownloadGrantSchema = z.strictObject({
  ...FederationStatusReportSchema.omit({ preparation: true, workflow: true }).shape,
  kind: z.literal("input-download-grant"),
  binding: FederationInputCopyBindingSchema,
  url: FederationDownloadUrlSchema,
  expiresAt: z.iso.datetime(),
});

/** Authenticated receiver-to-Agent task; the receiver pins membership and storage attempts. */
export const FederationInputCopyTaskSchema = z.strictObject({
  binding: FederationInputCopyBindingSchema,
  partSize: FederationResultCopyTaskSchema.shape.partSize,
  availableUntil: z.iso.datetime(),
});
export type FederationInputCopyTask = z.infer<typeof FederationInputCopyTaskSchema>;

export const FederationInputCopyGrantSchema = z
  .strictObject({
    binding: FederationInputCopyBindingSchema,
    direction: z.enum(["download", "upload"]),
    partNumber: z.number().int().min(1).max(10_000).optional(),
    url: FederationDownloadUrlSchema,
    expiresAt: z.iso.datetime(),
  })
  .refine((v) => (v.direction === "upload") === (v.partNumber !== undefined));
export type FederationInputCopyGrant = z.infer<typeof FederationInputCopyGrantSchema>;

export const FederationInputCopiedSchema = z.strictObject({
  binding: FederationInputCopyBindingSchema,
  sizeBytes: FederationInputCopyBindingSchema.shape.sizeBytes,
  sha256: FederationInputCopyBindingSchema.shape.sha256,
  parts: FederationResultCopiedSchema.shape.parts,
});

/** Input publication requires a pinned destination version, including for empty files. */
export const FederationInputVerifyTaskSchema = z.strictObject({
  binding: FederationInputCopyBindingSchema,
  object: FederationResultObjectSchema.extend({
    versionId: FederationResultObjectSchema.shape.versionId.unwrap().refine((v) => v !== "null"),
  }),
  availableUntil: z.iso.datetime(),
});
export type FederationInputVerifyTask = z.infer<typeof FederationInputVerifyTaskSchema>;

export const FederationInputVerificationGrantSchema = FederationInputVerifyTaskSchema.extend({
  direction: z.literal("verify"),
  url: FederationDownloadUrlSchema,
  expiresAt: z.iso.datetime(),
});
export type FederationInputVerificationGrant = z.infer<
  typeof FederationInputVerificationGrantSchema
>;

export const FederationInputVerifiedSchema = FederationInputVerifyTaskSchema.extend({
  sizeBytes: FederationInputCopyBindingSchema.shape.sizeBytes,
  sha256: FederationInputCopyBindingSchema.shape.sha256,
});
export type FederationInputVerified = z.infer<typeof FederationInputVerifiedSchema>;
