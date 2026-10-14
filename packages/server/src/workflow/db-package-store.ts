import {
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackageRevisions,
  usecasePackages,
} from "@kuintessence/db";
import { SoftwareAssetPayloadSchema } from "@kuintessence/shared";
import { and, eq } from "drizzle-orm";
import type { PackageStore } from "./package-resolver";

/**
 * Server-side PackageStore backed directly by the shared Postgres
 * `usecase_packages` table (server and registry share the same DB, so no
 * HTTP bridge is needed). Feeds createPackageResolver. The stored `spec` is
 * re-validated by UsecasePackageSchema in the resolver.
 *
 * Integration-verified (needs Postgres), mirroring the other Drizzle-backed
 * services in this codebase.
 */
export function createDbPackageStore(db: PgDb): PackageStore {
  return {
    getById: async (id) => {
      const [row] = await db
        .select({ id: usecasePackages.id, spec: usecasePackages.spec })
        .from(usecasePackages)
        .where(eq(usecasePackages.id, id))
        .limit(1);
      if (row) return { spec: row.spec, usecasePackageId: row.id };
      const [revision] = await db
        .select({ payload: softwareAssetRevisions.payload })
        .from(softwareAssetRevisions)
        .innerJoin(softwareAssets, eq(softwareAssetRevisions.assetId, softwareAssets.id))
        .where(and(eq(softwareAssetRevisions.id, id), eq(softwareAssets.kind, "usecase")))
        .limit(1);
      const payload = SoftwareAssetPayloadSchema.safeParse(revision?.payload);
      if (!payload.success || payload.data.kind !== "usecase") return null;
      if (payload.data.usecasePackageRevisionId) {
        if (!payload.data.usecasePackageId)
          throw new Error("Frozen usecase package identity is missing");
        const [frozen] = await db
          .select()
          .from(usecasePackageRevisions)
          .where(
            and(
              eq(usecasePackageRevisions.id, payload.data.usecasePackageRevisionId),
              eq(usecasePackageRevisions.packageId, payload.data.usecasePackageId),
            ),
          )
          .limit(1);
        if (!frozen) throw new Error("Frozen usecase package revision binding is invalid");
        return { spec: frozen.spec, usecasePackageId: frozen.packageId };
      }
      return {
        spec: payload.data.spec,
        ...(payload.data.usecasePackageId
          ? { usecasePackageId: payload.data.usecasePackageId }
          : {}),
      };
    },
    getSoftwareRevision: async (id) => {
      const [row] = await db
        .select({
          asset: {
            id: softwareAssets.id,
            source: softwareAssets.source,
            name: softwareAssets.name,
            version: softwareAssets.version,
            providerOrgId: softwareAssets.providerOrgId,
          },
          payload: softwareAssetRevisions.payload,
          recipeSha256: softwareAssetRevisions.recipeSha256,
          contentSha256: softwareAssetRevisions.contentSha256,
        })
        .from(softwareAssetRevisions)
        .innerJoin(softwareAssets, eq(softwareAssetRevisions.assetId, softwareAssets.id))
        .where(and(eq(softwareAssetRevisions.id, id), eq(softwareAssets.kind, "spack-package")))
        .limit(1);
      return row ?? null;
    },
  };
}
