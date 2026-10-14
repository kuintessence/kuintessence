import {
  ecosystemReleaseAssets,
  ecosystemReleases,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import type { usecase } from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import { SoftwareAssetService } from "../../../packages/registry/src/services/software-asset-service";

export const E2E_SPACK_PACKAGE = "kq-e2e-shell";

export function governedShellPackage(
  pkg: usecase.MaterializationPackage,
): usecase.GovernedUsecasePackage {
  return {
    ...pkg,
    description: "Governed shell package for end-to-end workflow tests.",
    domain: "platform-e2e",
    tags: ["e2e"],
    citations: [],
    softwareRef: {
      source: "official-upstream",
      name: E2E_SPACK_PACKAGE,
      version: "1",
    },
    software: { kind: "Spack", name: E2E_SPACK_PACKAGE, argumentList: [] },
    inputs: [],
    outputs: [],
    resources: {},
    materialMappings: [],
    dataRequirements: [],
    licensedMaterials: [],
    licenseRequirements: [],
  };
}

export async function seedE2eSoftwareRevision(db: PgDb, revisionId: string): Promise<string> {
  await deleteE2eSoftwareRevision(db, revisionId);
  const asset = await new SoftwareAssetService(db).upsertAsset({
    kind: "spack-package",
    source: "official-upstream",
    name: E2E_SPACK_PACKAGE,
    version: "1",
    lifecycle: "published",
    visibility: "platform-public",
    trustedForGlobalUse: true,
    payload: {
      kind: "spack-package",
      spack: {
        packageName: E2E_SPACK_PACKAGE,
        defaultSpec: `${E2E_SPACK_PACKAGE}@1`,
        metadata: {},
        dependencies: [],
        providers: [],
        variants: [],
      },
    },
    provenance: { source: "workflow-e2e" },
  });
  // Keep the fixture's stable revision reference; asset writes use the Registry outbox.
  await db
    .update(softwareAssetRevisions)
    .set({ id: revisionId })
    .where(eq(softwareAssetRevisions.assetId, asset.id));
  const [release] = await db
    .insert(ecosystemReleases)
    .values({
      releaseKey: `e2e-shell-${revisionId}`,
      version: "1",
      artifactDigest: `e2e-shell-${revisionId}`,
      manifest: { fixture: "workflow-e2e" },
      signature: "workflow-e2e",
      signingKeyId: "workflow-e2e",
      status: "active",
      importedBy: "workflow-e2e",
      activatedBy: "workflow-e2e",
      activatedAt: new Date(),
    })
    .returning({ id: ecosystemReleases.id });
  if (!release) {
    throw new Error("Failed to seed the E2E ecosystem release");
  }
  await db.insert(ecosystemReleaseAssets).values({
    releaseId: release.id,
    ecosystemKey: E2E_SPACK_PACKAGE,
    kind: "spack-package",
    name: E2E_SPACK_PACKAGE,
    version: "1",
    payload: {
      kind: "spack-package",
      spack: { packageName: E2E_SPACK_PACKAGE, defaultSpec: `${E2E_SPACK_PACKAGE}@1` },
    },
    licensePolicy: {
      classification: "open-source",
      identifiers: [{ kind: "spdx", value: "MIT" }],
      provenance: { source: "official-upstream", reference: "workflow e2e fixture" },
      acceptanceRequired: false,
      providerEntitlements: [],
      consumerEntitlements: [],
      redistribution: "permitted",
      autoInstall: "allowed",
    },
    assetId: asset.id,
    assetRevisionId: revisionId,
    materializedAt: new Date(),
  });
  return asset.id;
}

export async function deleteE2eSoftwareRevision(db: PgDb, revisionId: string): Promise<void> {
  const [revision] = await db
    .select({ assetId: softwareAssetRevisions.assetId })
    .from(softwareAssetRevisions)
    .where(eq(softwareAssetRevisions.id, revisionId))
    .limit(1);
  if (revision) {
    const releases = await db
      .select({ id: ecosystemReleaseAssets.releaseId })
      .from(ecosystemReleaseAssets)
      .where(eq(ecosystemReleaseAssets.assetId, revision.assetId));
    if (releases.length > 0) {
      await db.delete(ecosystemReleases).where(
        inArray(
          ecosystemReleases.id,
          releases.map((release) => release.id),
        ),
      );
    }
    await db.delete(softwareAssets).where(eq(softwareAssets.id, revision.assetId));
  }
}
