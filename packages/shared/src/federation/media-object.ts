import { z } from "zod";
import { FederationInputPathSchema } from "./input-files";
import { FEDERATION_MEDIA_MAX_BYTES, FEDERATION_MEDIA_MAX_FILES } from "./media";
import { FederationMediaExportBindingSchema } from "./media-export-task";
import { FederationDownloadUrlSchema } from "./result-transfer";

/** Agent-local object version binding; keys and bearer URLs never enter portable media manifests. */
export const FederationMediaObjectBindingSchema = FederationMediaExportBindingSchema.extend({
  fileIndex: z
    .number()
    .int()
    .nonnegative()
    .max(FEDERATION_MEDIA_MAX_FILES - 1),
  path: FederationInputPathSchema,
  sizeBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  versionId: z
    .string()
    .min(1)
    .max(1024)
    .refine((value) => value !== "null"),
});
export type FederationMediaObjectBinding = z.infer<typeof FederationMediaObjectBindingSchema>;

/** Transient, authenticated control-channel response; do not persist or log this credential. */
export const FederationMediaObjectGrantSchema = z.strictObject({
  binding: FederationMediaObjectBindingSchema,
  url: FederationDownloadUrlSchema,
  expiresAt: z.iso.datetime(),
});
export type FederationMediaObjectGrant = z.infer<typeof FederationMediaObjectGrantSchema>;
