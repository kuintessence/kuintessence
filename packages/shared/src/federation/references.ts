import { z } from "zod";

export const FederationDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const FederationAssetRefSchema = z.strictObject({
  originSiteId: z.uuid(),
  kind: z.enum(["workflow", "script", "software", "usecase", "dataset"]),
  id: z.uuid(),
  revision: z.string().min(1).max(128),
  digest: FederationDigestSchema,
});
export type FederationAssetRef = z.infer<typeof FederationAssetRefSchema>;
