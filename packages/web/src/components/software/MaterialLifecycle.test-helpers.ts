import { createHash } from "node:crypto";
import type {
  SpackMaterialBinding,
  SpackMaterialCatalog,
  SpackMaterialLifecycleView,
} from "@kuintessence/shared/browser";
import { fireEvent, screen, within } from "@testing-library/react";
import materialsEn from "../../locales/materials.en.json";
import { materialFixture } from "./SpackMaterials.test-helpers";

export const labels = materialsEn.materials;
export const WITHDRAW_REASON = "Review source provenance";
export const RESTORE_REASON = "Source provenance verified";

export function lifecycleFixture(repository = "org/org-a/materials") {
  const material = materialFixture(repository);
  const binding: SpackMaterialBinding = {
    repositoryId: createHash("sha256").update(repository).digest("hex"),
    manifestDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(material.manifest))
      .digest("hex")}`,
  };
  const state = (revision: number): SpackMaterialLifecycleView["state"] =>
    revision % 2 === 0 ? "available" : "withdrawn";
  const atRevision = (
    revision: number,
    reason = `Audit revision ${revision}`,
  ): SpackMaterialLifecycleView => ({
    binding,
    repository,
    revision,
    state: state(revision),
    history: Array.from({ length: Math.min(revision, 100) }, (_, index) => ({
      revision: revision - index,
      state: state(revision - index),
      operatorId: "44444444-4444-4444-8444-444444444444",
      reason: index === 0 ? reason : `Audit revision ${revision - index}`,
      epoch: "11111111-1111-4111-8111-111111111111",
      rolloutRevision: 2,
      createdAt: "2026-09-21T00:00:00.000Z",
    })),
    historyTruncated: revision > 100,
  });
  const catalog: SpackMaterialCatalog = {
    releases: [
      {
        ...binding,
        repository,
        spec: material.manifest.spec,
        target: material.manifest.target,
        spackVersion: material.manifest.spackVersion,
        redistribution: material.manifest.redistribution,
        sourceCount: material.manifest.sources.length,
        totalBytes:
          material.lock.size +
          material.source.size +
          material.manifest.recipes.reduce((sum, recipe) => sum + recipe.archive.size, 0),
      },
    ],
  };
  return { ...material, binding, view: atRevision(0), atRevision, catalog };
}

export function lifecycleUi() {
  return within(screen.getByTestId("material-lifecycle"));
}

export function inspectLifecycle(binding?: SpackMaterialBinding) {
  const ui = lifecycleUi();
  if (binding) {
    fireEvent.change(ui.getByLabelText(labels.lifecycleRepositoryId), {
      target: { value: binding.repositoryId },
    });
    fireEvent.change(ui.getByLabelText(labels.lifecycleManifestDigest), {
      target: { value: binding.manifestDigest },
    });
  }
  fireEvent.click(ui.getByRole("button", { name: labels.lifecycleInspect }));
}

export function confirmLifecycle(reason = WITHDRAW_REASON) {
  const ui = lifecycleUi();
  fireEvent.change(ui.getByLabelText(labels.lifecycleReason), { target: { value: reason } });
  fireEvent.click(ui.getByRole("checkbox"));
}

export function submitLifecycle(action: "withdraw" | "restore" = "withdraw") {
  fireEvent.click(lifecycleUi().getByRole("button", { name: labels.lifecycleAction[action] }));
}
