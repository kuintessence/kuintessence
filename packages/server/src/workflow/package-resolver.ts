import { type ResolvedPackage, SoftwareAssetPayloadSchema, usecase } from "@kuintessence/shared";

export interface StoredSoftwareRevision {
  asset: {
    id: string;
    source: string;
    name: string;
    version: string;
    providerOrgId: string | null;
  };
  payload: unknown;
  recipeSha256: string | null;
  contentSha256: string | null;
}

/** Storage interface for usecase packages and their pinned software revisions. */
export interface PackageStore {
  getById(id: string): Promise<{ spec: unknown; usecasePackageId?: string } | null>;
  getSoftwareRevision?(id: string): Promise<StoredSoftwareRevision | null>;
}

/**
 * Build the executor's `resolvePackage`: fetch the stored package by usecase
 * version id and validate its spec with UsecasePackageSchema. The validated,
 * structured package is structurally a ResolvedPackage, so it feeds the
 * usecase executor directly.
 */
export function createPackageResolver(
  store: PackageStore,
): (usecaseVersionId: string, softwareVersionId: string) => Promise<ResolvedPackage> {
  return async (usecaseVersionId, softwareVersionId) => {
    const row = await store.getById(usecaseVersionId);
    if (!row) {
      throw new Error(`usecase package not found: ${usecaseVersionId}`);
    }
    const pkg = usecase.UsecasePackageSchema.parse(row.spec);
    if (!("softwareRef" in pkg)) {
      throw new Error(
        "Workflow execution requires a governed usecase package with a software selector",
      );
    }
    if (!store.getSoftwareRevision) {
      throw new Error("package store cannot load frozen software revisions");
    }
    const revision = await store.getSoftwareRevision(softwareVersionId);
    if (!revision) {
      throw new Error(`frozen software revision not found: ${softwareVersionId}`);
    }
    if (!sameSelector(pkg.softwareRef, revision.asset)) {
      throw new Error("frozen software revision does not match the usecase software selector");
    }
    const payload = SoftwareAssetPayloadSchema.parse(revision.payload);
    if (payload.kind !== "spack-package") {
      throw new Error("frozen software revision is not a Spack package");
    }
    if (payload.spack.packageName !== revision.asset.name) {
      throw new Error("frozen software revision package name does not match its asset");
    }
    if (pkg.software.kind !== "Spack") {
      throw new Error("a frozen Spack software revision requires a Spack usecase package");
    }
    return {
      ...pkg,
      ...(row.usecasePackageId ? { usecasePackageId: row.usecasePackageId } : {}),
      software: {
        ...pkg.software,
        name: payload.spack.defaultSpec ?? `${payload.spack.packageName}@${revision.asset.version}`,
      },
      softwareRequirements: [
        {
          assetId: revision.asset.id,
          name: payload.spack.packageName,
          version: revision.asset.version,
          installable: false,
        },
      ],
    };
  };
}

function sameSelector(
  selector: { source: string; name: string; version: string; providerOrgId?: string },
  asset: StoredSoftwareRevision["asset"],
): boolean {
  return (
    selector.source === asset.source &&
    selector.name === asset.name &&
    selector.version === asset.version &&
    (selector.providerOrgId ?? null) === asset.providerOrgId
  );
}
