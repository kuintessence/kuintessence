import type { federationWorkflowBindings } from "@kuintessence/db";
import { usecase, WorkflowExecutionInterrupted } from "@kuintessence/shared";
import {
  FederationEnvironmentLockSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { createPackageResolver, type PackageStore } from "../workflow/package-resolver";
import type { FederationAssetService } from "./assets";

type Snapshot = typeof federationWorkflowBindings.$inferSelect.snapshot;

/** Translate only explicitly approved aliases; normal package policy remains authoritative. */
export function createFederationPackageResolver(
  snapshot: Snapshot,
  assets: Pick<FederationAssetService, "resolve">,
  store: PackageStore,
  canInstall: (assetId: string, spec: string) => Promise<boolean>,
) {
  const environment = FederationEnvironmentLockSchema.parse(snapshot.environment);
  return async (usecaseRevisionId: string, softwareRevisionId: string) => {
    const uc = snapshot.mappings.find(
      (item) => item.reference.kind === "usecase" && item.localRevisionId === usecaseRevisionId,
    );
    const sw = snapshot.mappings.find(
      (item) => item.reference.kind === "software" && item.localRevisionId === softwareRevisionId,
    );
    const entry = environment.software.find(
      (item) => sw && federationCanonicalJson(item.asset) === federationCanonicalJson(sw.reference),
    );
    if (!uc || !sw || !entry?.executionPin)
      throw new WorkflowExecutionInterrupted(
        "Federation software requires a mapped revision and complete execution pin",
        { retryable: false },
      );
    const [usecaseAsset, softwareAsset] = await Promise.all([
      assets.resolve(snapshot.identity, uc.reference),
      assets.resolve(snapshot.identity, sw.reference),
    ]);
    if (
      usecaseAsset.mapping.id !== uc.mappingId ||
      softwareAsset.mapping.id !== sw.mappingId ||
      usecaseAsset.local.kind !== "software" ||
      softwareAsset.local.kind !== "software" ||
      usecaseAsset.local.revision.id !== usecaseRevisionId ||
      softwareAsset.local.revision.id !== softwareRevisionId ||
      usecaseAsset.local.payload.kind !== "usecase" ||
      softwareAsset.local.payload.kind !== "spack-package"
    )
      throw new WorkflowExecutionInterrupted("Federation software mapping changed", {
        retryable: false,
      });
    const localUsecase = usecaseAsset.local;
    const localSoftware = softwareAsset.local;
    const stored = await store.getById(usecaseRevisionId);
    if (!stored?.usecasePackageId || localUsecase.payload.kind !== "usecase")
      throw new WorkflowExecutionInterrupted(
        "Federation usecase lacks its local governed package",
        { retryable: false },
      );
    const pkg = usecase.GovernedUsecasePackageSchema.parse(stored.spec);
    const approved = usecase.GovernedUsecasePackageSchema.parse(localUsecase.payload.spec);
    if (federationCanonicalJson(pkg) !== federationCanonicalJson(approved))
      throw new WorkflowExecutionInterrupted(
        "Federation governed package differs from its approved revision",
        { retryable: false },
      );
    const alias = snapshot.inputs.bindings.some(
      (binding) =>
        binding.sourceSelector &&
        federationCanonicalJson(binding.sourceSelector) ===
          federationCanonicalJson(pkg.softwareRef) &&
        federationCanonicalJson(binding.asset) === federationCanonicalJson(sw.reference),
    );
    const specification = alias
      ? {
          ...pkg,
          softwareRef: {
            source: localSoftware.asset.source,
            name: localSoftware.asset.name,
            version: localSoftware.asset.version,
            ...(localSoftware.asset.providerOrgId
              ? { providerOrgId: localSoftware.asset.providerOrgId }
              : {}),
          },
        }
      : pkg;
    return createPackageResolver(
      {
        getById: async () => ({ ...stored, spec: specification }),
        getSoftwareRevision: async () => ({
          asset: localSoftware.asset,
          payload: localSoftware.payload,
          recipeSha256: localSoftware.revision.recipeSha256,
          contentSha256: localSoftware.revision.contentSha256,
        }),
      },
      canInstall,
      { spec: entry.concreteSpec, pin: entry.executionPin },
    )(usecaseRevisionId, softwareRevisionId);
  };
}
