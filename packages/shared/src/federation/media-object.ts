import { z } from "zod";
import { FEDERATION_MEDIA_MAX_FILES } from "./media";
import {
  FederationMediaExportBindingSchema,
  FederationMediaObjectMemberSchema,
} from "./media-export-task";
import { FederationDownloadUrlSchema } from "./result-transfer";

/** Agent-local object version binding; keys and bearer URLs never enter portable media manifests. */
export const FederationMediaObjectBindingSchema = FederationMediaExportBindingSchema.extend({
  fileIndex: z
    .number()
    .int()
    .nonnegative()
    .max(FEDERATION_MEDIA_MAX_FILES - 1),
  ...FederationMediaObjectMemberSchema.shape,
});
export type FederationMediaObjectBinding = z.infer<typeof FederationMediaObjectBindingSchema>;

/** Transient, authenticated control-channel response; do not persist or log this credential. */
export const FederationMediaObjectGrantSchema = z.strictObject({
  binding: FederationMediaObjectBindingSchema,
  url: FederationDownloadUrlSchema,
  expiresAt: z.iso.datetime(),
});
export type FederationMediaObjectGrant = z.infer<typeof FederationMediaObjectGrantSchema>;
