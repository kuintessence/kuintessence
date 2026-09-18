import type {
  MeCapabilities,
  SpackMaterialBinding,
  SpackMaterialImport,
  SpackMaterialManifest,
  SpackMaterialPublish,
} from "@kuintessence/shared/browser";
import { fireEvent, screen } from "@testing-library/react";
import { expect, vi } from "vitest";
import { setAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import * as client from "../../lib/spack-materials-client";

// Keep t stable like the real hook, including effects that depend on it.
export const translation = { t: i18n.t.bind(i18n) };

export function capabilities(role = "platform_admin"): MeCapabilities {
  return {
    principal: { userId: "alice", email: "alice@example.test", role },
    capabilities: ["software.publish"],
    contexts: ["org-a", "org-b"].map((organizationId) => ({
      id: `organization:${organizationId}`,
      type: "organization",
      organizationId,
      membershipRole: "admin",
    })),
    activeContextId: "platform",
    devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
  };
}

export function materialFixture(repository = "public/materials", count = 1) {
  const source = { digest: `sha256:${"a".repeat(64)}`, size: 6 };
  const lock = { digest: `sha256:${"b".repeat(64)}`, size: 4 };
  const release: SpackMaterialPublish = {
    version: 1,
    repository,
    spec: "private-first@1.0",
    spackVersion: "1.0.0",
    target: "linux-ubuntu24.04-x86_64",
    redistribution: "unrestricted",
    lockfile: lock,
    sources: [{ path: "hello/source.tar.gz", blob: source }],
    recipes: [{ repositoryId: "c".repeat(64), commit: "d".repeat(40), roots: ["."] }],
  };
  const pack: SpackMaterialImport = {
    version: 1,
    files: [
      { path: "source.tar.gz", blob: source },
      { path: "root.lock", blob: lock },
    ],
    releases: Array.from({ length: count }, (_, index) => ({
      ...release,
      spec: index === 0 ? release.spec : `private-next-${index}@1.0`,
    })),
  };
  const binding: SpackMaterialBinding = {
    repositoryId: "e".repeat(64),
    manifestDigest: `sha256:${"f".repeat(64)}`,
  };
  const manifest: SpackMaterialManifest = {
    ...release,
    recipes: release.recipes.map((recipe) => ({
      ...recipe,
      archive: { digest: `sha256:${"1".repeat(64)}`, size: 12 },
    })),
  };
  return {
    pack,
    source,
    lock,
    binding,
    manifest,
    sourceFile: new File(["source"], "source.tar.gz"),
    lockFile: new File(["lock"], "root.lock"),
  };
}

export type MaterialFixture = ReturnType<typeof materialFixture>;

export function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export async function resetMaterials() {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  delete window.__KQ_LOCAL__;
  setAuth({ email: "alice@example.test", role: "platform_admin" });
  localStorage.setItem("kq.lang", "en");
  await i18n.changeLanguage("en");
  const fixture = materialFixture();
  vi.mocked(client.uploadSpackMaterial).mockImplementation(async (_repository, blob) => blob);
  vi.mocked(client.publishSpackMaterial).mockResolvedValue(fixture.binding);
  vi.mocked(client.getSpackMaterial).mockResolvedValue(fixture.manifest);
  vi.mocked(client.listSpackMaterials).mockResolvedValue({ releases: [] });
}

export function expectNoWrites() {
  expect(client.uploadSpackMaterial).not.toHaveBeenCalled();
  expect(client.publishSpackMaterial).not.toHaveBeenCalled();
}

export async function selectManifest(pack: SpackMaterialImport) {
  fireEvent.change(screen.getByLabelText("Material manifest (JSON)"), {
    target: { files: [new File([JSON.stringify(pack)], "manifest.json")] },
  });
  await screen.findByRole("table", { name: "Material import queue" });
}

export function selectFiles(files: File[], mode: "files" | "directory" = "files") {
  fireEvent.change(
    screen.getByLabelText(mode === "files" ? "Material files (flat paths)" : "Material directory"),
    { target: { files } },
  );
}

export async function prepareImport(fixture: MaterialFixture) {
  await selectManifest(fixture.pack);
  selectFiles([fixture.sourceFile, fixture.lockFile]);
}

export function confirmImport() {
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Import materials" }));
}

export function findRelease(binding: SpackMaterialBinding) {
  fireEvent.change(screen.getByLabelText("Repository ID"), {
    target: { value: binding.repositoryId },
  });
  fireEvent.change(screen.getByLabelText("Manifest digest"), {
    target: { value: binding.manifestDigest },
  });
  fireEvent.click(screen.getByRole("button", { name: "Find release" }));
}
