import type { federationWorkflowBindings } from "@kuintessence/db";
import { WorkflowExecutionInterrupted } from "@kuintessence/shared";
import { createDatasetPreflight, type DatasetPreflightDeps } from "../workflow/dataset-preflight";
import { type FederationAssetService, federationMaterialDigest } from "./assets";

/** Validate the same receiver projection that execution uses, retaining local data/usecase policy. */
export function createFederationDatasetPreflight(
  snapshot: typeof federationWorkflowBindings.$inferSelect.snapshot,
  assets: Pick<FederationAssetService, "resolve">,
  deps: Omit<DatasetPreflightDeps, "loadUsecasePackage" | "resolveWorkflowVersion">,
): ReturnType<typeof createDatasetPreflight> {
  const validate = createDatasetPreflight({
    ...deps,
    resolveWorkflowVersion: async (id) => snapshot.workflowVersions[id] ?? null,
    loadUsecasePackage: async (id) => {
      const mapping = snapshot.mappings.find(
        (item) => item.reference.kind === "usecase" && item.localRevisionId === id,
      );
      if (!mapping) throw denied("Unmapped federation usecase");
      const resolved = await assets.resolve(snapshot.identity, mapping.reference);
      if (
        resolved.mapping.id !== mapping.mappingId ||
        resolved.local.kind !== "software" ||
        resolved.local.revision.id !== id ||
        resolved.local.payload.kind !== "usecase"
      )
        throw denied("Federation usecase mapping changed");
      return resolved.local.payload.spec;
    },
  });
  return async (workflow, principal) => {
    if (
      principal?.userId !== snapshot.identity.userId ||
      principal.orgId !== snapshot.identity.orgId ||
      (principal.sub && principal.sub !== snapshot.identity.userId) ||
      federationMaterialDigest(workflow) !== federationMaterialDigest(snapshot.workflow)
    )
      throw denied("Federation preflight requires its original workflow and restricted identity");
    await validate(workflow, principal);
  };
}

function denied(message: string) {
  return new WorkflowExecutionInterrupted(message, { retryable: false });
}
