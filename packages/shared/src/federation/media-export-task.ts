import { z } from "zod";
import { FederationDigestSchema } from "./references";

export const FederationMediaExportBindingSchema = z.strictObject({
  generation: z.uuid(),
  packageId: z.uuid(),
  manifestDigest: FederationDigestSchema,
});
export const FederationMediaExportTaskSchema = z.strictObject({
  ...FederationMediaExportBindingSchema.shape,
  agentId: z.string().min(1).max(255),
  sourceSiteId: z.uuid(),
  recipientSiteId: z.uuid(),
  managedRootId: z.uuid(),
  relativePath: z.string().min(1).max(4096),
  recipient: z.string().regex(/^age1[0-9a-z]{58}$/),
  signedManifest: z.string().min(1).max(400_000),
  signingKey: z.strictObject({
    keyId: z.string().min(1).max(255),
    publicKeyPem: z.string().min(1).max(16384),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
  }),
  expiresAt: z.iso.datetime(),
});
export type FederationMediaExportTask = z.infer<typeof FederationMediaExportTaskSchema>;
export const FederationMediaExportLeaseSchema = z.strictObject({
  ...FederationMediaExportBindingSchema.shape,
  expiresAt: z.iso.datetime(),
});
export const FederationMediaExportReceiptSchema = z.strictObject({
  ...FederationMediaExportBindingSchema.shape,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(6 * 1024 ** 4),
});
export type FederationMediaExportReceipt = z.infer<typeof FederationMediaExportReceiptSchema>;
