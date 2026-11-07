import { z } from "zod";
import { FederationInputDescriptorSchema, FederationInputPathSchema } from "./input-files";
import { FederationDigestSchema } from "./references";
import { FederationDownloadUrlSchema } from "./result-transfer";
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
