import {
  type ResolvedPackage,
  SoftwareAssetPayloadSchema,
  type SpackExecutionPin,
  SpackExecutionPinSchema,
  SpackExecutionSchema,
  usecase,
} from "@kuintessence/shared";

export interface StoredSoftwareRevision {
  signedRelease?: boolean;
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
  canInstall?: (assetId: string, spec: string) => Promise<boolean>,
  lockedExecution?: { spec: string; pin: SpackExecutionPin },
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
    if (payload.kind === "site-runtime") {
      if (!row.usecasePackageId || lockedExecution || revision.asset.source !== "platform-fork") {
        throw new Error("Site runtimes require a locally authorized signed release");
      }
      usecase.assertSiteRuntimeMatches(pkg.software, pkg.usecase.commandFile, payload.runtime);
      return {
        ...pkg,
        usecaseVersionId,
        ...(row.usecasePackageId ? { usecasePackageId: row.usecasePackageId } : {}),
        siteRuntime: payload.runtime,
        softwareRequirements: [
          {
            assetId: revision.asset.id,
            siteRuntimeRevisionId: softwareVersionId,
            name: revision.asset.name,
            version: revision.asset.version,
            installable: false,
          },
        ],
      };
    }
    if (payload.kind !== "spack-package") {
      throw new Error("frozen software revision is not a Spack package");
    }
    if (payload.spack.packageName !== revision.asset.name && !revision.signedRelease) {
      throw new Error("frozen software revision package name does not match its asset");
    }
    if (pkg.software.kind !== "Spack") {
      throw new Error("a frozen Spack software revision requires a Spack usecase package");
    }
    const spackSpec = (
      payload.spack.defaultSpec ?? `${payload.spack.packageName}@${revision.asset.version}`
    ).trim();
    const pin = lockedExecution ? SpackExecutionPinSchema.parse(lockedExecution.pin) : undefined;
    const installationSpec = SpackExecutionSchema.shape.spec.parse(
      [spackSpec, ...pkg.software.argumentList].join(" "),
    );
    if (
      lockedExecution &&
      installationSpec !== SpackExecutionSchema.shape.spec.parse(lockedExecution.spec)
    )
      throw new Error("Frozen software specification differs from the authorized environment lock");
    return {
      ...pkg,
      ...(pin ? { spackExecutionPin: pin } : {}),
      usecaseVersionId,
      ...(row.usecasePackageId ? { usecasePackageId: row.usecasePackageId } : {}),
      software: {
        ...pkg.software,
        name: spackSpec,
      },
      softwareRequirements: [
        {
          assetId: revision.asset.id,
          spec: installationSpec,
          name: revision.asset.name,
          version: revision.asset.version,
          installable: (await canInstall?.(revision.asset.id, installationSpec)) ?? false,
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
