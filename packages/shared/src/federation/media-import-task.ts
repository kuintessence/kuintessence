import { z } from "zod";
import { FEDERATION_MEDIA_MAX_BYTES } from "./media";
import { FederationMediaDirectoryExportTaskSchema } from "./media-export-task";
import { FederationMediaKeyQuerySchema, FederationMediaRecipientKeySchema } from "./media-keys";
import { FederationDigestSchema } from "./references";

export const FederationMediaImportBindingSchema = z.strictObject({
  generation: z.uuid(),
  packageId: z.uuid(),
  authorizationId: z.uuid(),
  manifestDigest: FederationDigestSchema,
});
export type FederationMediaImportBinding = z.infer<typeof FederationMediaImportBindingSchema>;
export const FederationMediaImportTaskSchema = z.strictObject({
  ...FederationMediaImportBindingSchema.shape,
  agentId: z.string().min(1).max(255),
  sourceSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  agreementRevisionId: z.uuid(),
  managedRootId: z.uuid(),
  maxBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES),
  signedManifest: z.string().min(1).max(400_000),
  signingKey: FederationMediaDirectoryExportTaskSchema.shape.signingKey,
  expiresAt: z.iso.datetime(),
});
export type FederationMediaImportTask = z.infer<typeof FederationMediaImportTaskSchema>;
export const FederationMediaImportKeyRequestSchema = z.strictObject({
  ...FederationMediaImportBindingSchema.shape,
  recipientKey: FederationMediaRecipientKeySchema,
  purpose: z.literal("task-upload").optional(),
});
export const FederationMediaImportGrantSchema = z.strictObject({
  binding: FederationMediaImportBindingSchema,
  query: FederationMediaKeyQuerySchema,
  queryDigest: FederationDigestSchema,
  signedGrant: z.string().min(1).max(16384),
  signingKey: FederationMediaDirectoryExportTaskSchema.shape.signingKey,
  expiresAt: z.iso.datetime(),
});
export type FederationMediaImportGrant = z.infer<typeof FederationMediaImportGrantSchema>;
export const FederationMediaImportVerifiedSchema = z.strictObject({
  ...FederationMediaImportBindingSchema.shape,
  state: z.literal("verified"),
  queryDigest: FederationDigestSchema,
  sizeBytes: z.number().int().nonnegative().max(FEDERATION_MEDIA_MAX_BYTES),
});
export const FederationMediaImportReportSchema = z.discriminatedUnion("state", [
  FederationMediaImportVerifiedSchema,
  FederationMediaImportBindingSchema.extend({ state: z.literal("failed") }),
]);
export type FederationMediaImportVerified = z.infer<typeof FederationMediaImportVerifiedSchema>;
