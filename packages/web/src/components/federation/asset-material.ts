import {
  type FederationAssetRef,
  FederationAssetRefSchema,
  FederationEnvironmentLockSchema,
  FederationInputManifestSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { z } from "zod";

export const AssetMappingSchema = z.object({
  id: z.uuid(),
  localOrgId: z.uuid(),
  originSiteId: z.uuid(),
  kind: FederationAssetRefSchema.shape.kind,
  originId: z.uuid(),
  originRevision: z.string(),
  digest: FederationAssetRefSchema.shape.digest,
  softwareRevisionId: z.uuid().nullable(),
  dataVersionId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type AssetMapping = z.infer<typeof AssetMappingSchema>;
export const AssetMaterialSchema = FederationInputManifestSchema.or(
  FederationEnvironmentLockSchema,
);
export type AssetMaterial = z.infer<typeof AssetMaterialSchema>;
export type AssetAction =
  | { kind: "material"; originSiteId: string; content: AssetMaterial; digest: string }
  | { kind: "mapping"; reference: FederationAssetRef; localRevisionId: string }
  | { kind: "revoke"; mapping: AssetMapping };

export async function materialDigest(content: unknown) {
  const bytes = new TextEncoder().encode(federationCanonicalJson(content));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function mappingReference(row: AssetMapping): FederationAssetRef {
  return {
    originSiteId: row.originSiteId,
    kind: row.kind,
    id: row.originId,
    revision: row.originRevision,
    digest: row.digest,
  };
}
