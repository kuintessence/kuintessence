import { z } from "zod";
import { FederationDigestSchema } from "./references";
import { FederationResultQuerySchema, FederationResultReportSchema } from "./results";
import { hasFederationQueryWindow } from "./status";

export const FederationDataOriginSchema = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === "/"
  );
}, "Expected an HTTPS storage origin");

export const FederationResultCopyBindingSchema = z.strictObject({
  transferId: z.uuid(),
  generation: z.uuid(),
  operationId: z.uuid(),
  manifestDigest: FederationDigestSchema,
  outputId: FederationDigestSchema,
  path: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  partSize: z
    .number()
    .int()
    .min(5 * 1024 * 1024)
    .max(5 * 1024 ** 3),
});
export type FederationResultCopyBinding = z.infer<typeof FederationResultCopyBindingSchema>;

export const FederationResultDownloadQuerySchema = z
  .strictObject({
    ...FederationResultQuerySchema.shape,
    kind: z.literal("result-download-query"),
    binding: FederationResultCopyBindingSchema,
  })
  .refine(hasFederationQueryWindow, "Invalid query window")
  .refine((v) => v.operationId === v.binding.operationId, "Mismatched operation");
export type FederationResultDownloadQuery = z.infer<typeof FederationResultDownloadQuerySchema>;

/** Contains a short-lived bearer credential; never log or persist the signed response. */
export const FederationResultDownloadGrantSchema = FederationResultReportSchema.omit({
  manifest: true,
  manifestDigest: true,
}).extend({
  kind: z.literal("result-download-grant"),
  binding: FederationResultCopyBindingSchema,
  url: z
    .url()
    .max(8192)
    .refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && !url.hash;
    }, "Expected HTTPS download URL"),
  expiresAt: z.iso.datetime(),
});
