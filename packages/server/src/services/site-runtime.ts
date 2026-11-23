import { createHash } from "node:crypto";
import {
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackageRevisions,
} from "@kuintessence/db";
import { ecosystemCanonicalJson, SoftwareAssetPayloadSchema } from "@kuintessence/shared";
import { and, eq, exists, sql } from "drizzle-orm";

import { verifyReleaseSignature } from "./release-signature";

export type ReleaseBoundSoftwareKind =
  | "usecase"
  | "site-runtime"
  | "spack-package"
  | "sandbox-script";

export function releaseBoundSoftwareKind(
  kind: string,
  name: string,
  payload: Record<string, unknown>,
) {
  if (kind === "site-runtime") return kind;
  if (kind !== "spack-package") return undefined;
  const spack = payload.spack;
  if (
    spack &&
    typeof spack === "object" &&
    "packageName" in spack &&
    typeof spack.packageName === "string" &&
    spack.packageName !== name
  )
    return kind;
  return undefined;
}

/** A signed, active release must bind exactly the bytes used by the frozen revision. */
export async function activeSoftwareReleaseRevision(
  db: PgDb,
  assetId: string,
  kind: ReleaseBoundSoftwareKind,
  keys: Readonly<Record<string, string>>,
) {
  // Activation adds the local package IDs to a usecase asset revision. The signed spec
  // must also match the package revision that the executor will read through those IDs.
  const expectedPayload =
    kind === "usecase"
      ? sql`${ecosystemReleaseAssets.payload} || jsonb_build_object(
        'usecasePackageId', ${ecosystemReleaseAssets.usecasePackageId},
        'usecasePackageRevisionId', ${ecosystemReleaseAssets.usecasePackageRevisionId})`
      : ecosystemReleaseAssets.payload;
  const boundUsecase = db
    .select({ id: usecasePackageRevisions.id })
    .from(usecasePackageRevisions)
    .where(
      and(
        eq(usecasePackageRevisions.id, ecosystemReleaseAssets.usecasePackageRevisionId),
        eq(usecasePackageRevisions.packageId, ecosystemReleaseAssets.usecasePackageId),
        eq(usecasePackageRevisions.spec, sql`${ecosystemReleaseAssets.payload}->'spec'`),
      ),
    );
  const bindings = await db
    .select({
      manifest: ecosystemReleases.manifest,
      signature: ecosystemReleases.signature,
      signingKeyId: ecosystemReleases.signingKeyId,
      releaseKey: ecosystemReleases.releaseKey,
      ecosystemKey: ecosystemReleaseAssets.ecosystemKey,
      name: ecosystemReleaseAssets.name,
      version: ecosystemReleaseAssets.version,
      licensePolicy: ecosystemReleaseAssets.licensePolicy,
      digest: ecosystemReleaseAssets.manifestEntryDigest,
      payload: ecosystemReleaseAssets.payload,
      revisionPayload: softwareAssetRevisions.payload,
      revisionId: softwareAssetRevisions.id,
      revision: softwareAssetRevisions.revision,
    })
    .from(ecosystemReleaseAssets)
    .innerJoin(ecosystemReleases, eq(ecosystemReleaseAssets.releaseId, ecosystemReleases.id))
    .innerJoin(
      softwareAssets,
      and(
        eq(softwareAssets.id, ecosystemReleaseAssets.assetId),
        eq(softwareAssets.name, ecosystemReleaseAssets.name),
        eq(softwareAssets.version, ecosystemReleaseAssets.version),
        eq(softwareAssets.kind, kind),
        eq(softwareAssets.source, "platform-fork"),
        eq(softwareAssets.lifecycle, "published"),
        eq(softwareAssets.trustedForGlobalUse, true),
      ),
    )
    .innerJoin(
      softwareAssetRevisions,
      and(
        eq(ecosystemReleaseAssets.assetRevisionId, softwareAssetRevisions.id),
        eq(softwareAssetRevisions.assetId, ecosystemReleaseAssets.assetId),
        eq(softwareAssetRevisions.payload, expectedPayload),
      ),
    )
    .where(
      and(
        eq(ecosystemReleaseAssets.assetId, assetId),
        eq(ecosystemReleaseAssets.kind, kind),
        eq(ecosystemReleases.status, "active"),
        kind === "usecase" ? exists(boundUsecase) : undefined,
      ),
    )
    .limit(2);
  const row = bindings.length === 1 ? bindings[0] : undefined;
  if (
    !row ||
    row.manifest.releaseKey !== row.releaseKey ||
    !Array.isArray(row.manifest.assets) ||
    !verifyReleaseSignature(row, keys)
  )
    return null;
  const entry = row.manifest.assets.find(
    (item: unknown) =>
      typeof item === "object" &&
      item &&
      "ecosystemKey" in item &&
      item.ecosystemKey === row.ecosystemKey,
  );
  if (
    !entry ||
    entry.kind !== kind ||
    entry.name !== row.name ||
    entry.version !== row.version ||
    `sha256:${createHash("sha256").update(ecosystemCanonicalJson(entry)).digest("hex")}` !==
      row.digest ||
    ecosystemCanonicalJson(entry.payload) !== ecosystemCanonicalJson(row.payload) ||
    ecosystemCanonicalJson(entry.licensePolicy) !== ecosystemCanonicalJson(row.licensePolicy)
  )
    return null;
  const payload = SoftwareAssetPayloadSchema.safeParse(row.revisionPayload);
  if (!payload.success || payload.data.kind !== kind) return null;
  return {
    name: row.name,
    version: row.version,
    revisionId: row.revisionId,
    revision: row.revision,
    payload: payload.data,
  };
}
