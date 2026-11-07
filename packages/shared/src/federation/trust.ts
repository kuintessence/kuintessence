import { z } from "zod";

export const FederationSiteInput = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(200),
  endpoint: z
    .string()
    .max(2048)
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/"
      );
    }, "Expected HTTPS origin without credentials, path or query"),
});
export const FederationKeyInput = z
  .strictObject({
    keyId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
    publicKeyPem: z.string().min(1).max(16384),
    allowedKinds: z
      .array(
        z.enum([
          "agreement",
          "delegation",
          "acceptance",
          "evidence-batch",
          "commercial-agreement",
          "commercial-usage",
          "commercial-reservation",
          "commercial-release",
          "commercial-usage-query",
          "commercial-usage-page",
          "status-query",
          "status-report",
          "cancellation",
          "cancellation-receipt",
          "result-query",
          "result-report",
          "result-download-query",
          "result-download-grant",
          "result-receipt",
          "result-receipt-ack",
          "material-query",
          "material-chunk",
          "input-download-query",
          "input-download-grant",
        ]),
      )
      .min(1)
      .max(24),
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime(),
  })
  .refine((v) => Date.parse(v.validFrom) < Date.parse(v.validUntil), "Invalid validity interval");
export const FederationCertificateInput = z.strictObject({
  certificatePem: z.string().min(1).max(16384),
});

export const FederationSiteStateSchema = z.enum(["active", "suspended", "revoked"]);
export const FederationSiteViewSchema = FederationSiteInput.extend({
  state: FederationSiteStateSchema,
  createdAt: z.iso.datetime(),
});
export const FederationSiteDetailsSchema = FederationSiteViewSchema.extend({
  keys: z.array(
    FederationKeyInput.safeExtend({ siteId: z.uuid(), revokedAt: z.iso.datetime().nullable() }),
  ),
  certificates: z.array(
    FederationCertificateInput.extend({
      siteId: z.uuid(),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      validFrom: z.iso.datetime(),
      validUntil: z.iso.datetime(),
      revokedAt: z.iso.datetime().nullable(),
    }),
  ),
});
export type FederationSiteView = z.infer<typeof FederationSiteViewSchema>;
export type FederationSiteDetails = z.infer<typeof FederationSiteDetailsSchema>;
