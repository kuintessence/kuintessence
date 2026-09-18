import type { MeCapabilities, SpackMaterialBlob } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { clearAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import { SoftwareError } from "../../lib/software-client";
import * as client from "../../lib/spack-materials-client";
import materialsEn from "../../locales/materials.en.json";
import materialsZh from "../../locales/materials.zh.json";
import {
  capabilities,
  confirmImport,
  deferred,
  expectNoWrites,
  findRelease,
  materialFixture,
  prepareImport,
  resetMaterials,
  selectFiles,
  selectManifest,
  translation,
} from "./SpackMaterials.test-helpers";
import { SpackMaterialsPanel } from "./SpackMaterialsPanel";

const access = vi.hoisted(() => ({
  status: "ready" as "ready" | "loading" | "error",
  data: null as MeCapabilities | null,
}));
vi.mock("../../lib/platform-capabilities", () => ({
  useMeCapabilities: (enabled: boolean) => (enabled ? access : { status: "idle", data: null }),
}));
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => translation,
}));
vi.mock("../../lib/spack-materials-client", () => ({
  uploadSpackMaterial: vi.fn(),
  publishSpackMaterial: vi.fn(),
  getSpackMaterial: vi.fn(),
  listSpackMaterials: vi.fn(),
}));

beforeEach(async () => {
  await resetMaterials();
  access.status = "ready";
  access.data = capabilities();
});
afterEach(() => {
  cleanup();
  clearAuth();
  delete window.__KQ_LOCAL__;
  vi.restoreAllMocks();
});

function mount(canManage = true) {
  return render(<SpackMaterialsPanel canManage={canManage} />);
}

test("requires redistribution confirmation and uploads original files sequentially before publishing", async () => {
  const f = materialFixture();
  const pending = deferred<SpackMaterialBlob>();
  vi.mocked(client.uploadSpackMaterial).mockReturnValueOnce(pending.promise);
  mount();
  await prepareImport(f);
  expect(screen.getByRole("button", { name: "Import materials" })).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Import materials" }));
  expectNoWrites();
  confirmImport();
  await waitFor(() => expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(client.uploadSpackMaterial).mock.calls[0]?.[3];
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
  expect(client.uploadSpackMaterial).toHaveBeenNthCalledWith(
    1,
    f.manifest.repository,
    f.lock,
    f.lockFile,
    signal,
  );
  expect(client.publishSpackMaterial).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Material files (flat paths)")).toHaveProperty("disabled", true);
  expect(screen.getByRole("checkbox")).toHaveProperty("disabled", true);
  await act(async () => pending.resolve(f.lock));
  await screen.findByText("1 published, 0 failed, 0 unconfirmed");
  expect(client.uploadSpackMaterial).toHaveBeenNthCalledWith(
    2,
    f.manifest.repository,
    f.source,
    f.sourceFile,
    signal,
  );
  expect(client.publishSpackMaterial).toHaveBeenCalledExactlyOnceWith(f.pack.releases[0], signal);
  expect(screen.getByRole("button", { name: "Retry unfinished releases" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("imports a directory using relative paths and ignores only its selected manifest", async () => {
  const f = materialFixture();
  f.pack.files[0] = { path: "blobs/source.tar.gz", blob: f.source };
  const manifestFile = new File([JSON.stringify(f.pack)], "manifest.json");
  Object.defineProperty(f.sourceFile, "webkitRelativePath", { value: "pack/blobs/source.tar.gz" });
  Object.defineProperty(f.lockFile, "webkitRelativePath", { value: "pack/root.lock" });
  Object.defineProperty(manifestFile, "webkitRelativePath", { value: "pack/manifest.json" });
  mount();
  await selectManifest(f.pack);
  selectFiles([manifestFile, f.sourceFile, f.lockFile], "directory");
  confirmImport();
  await screen.findByText("1 published, 0 failed, 0 unconfirmed");
  expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(2);
  expect(client.uploadSpackMaterial).toHaveBeenCalledWith(
    f.manifest.repository,
    f.source,
    f.sourceFile,
    expect.any(AbortSignal),
  );
});

test.each([
  "missing",
  "wrong-size",
  "extra",
  "duplicate",
])("blocks a %s file selection before sending any bytes", async (kind) => {
  const f = materialFixture();
  mount();
  await selectManifest(f.pack);
  const files = [f.sourceFile, f.lockFile];
  if (kind === "missing") files.pop();
  if (kind === "wrong-size") files[0] = new File(["bad"], "source.tar.gz");
  if (kind === "extra") files.push(new File(["extra"], "extra.tar.gz"));
  if (kind === "duplicate") files.push(f.sourceFile);
  selectFiles(files);
  expect(screen.getByRole("alert").textContent).toContain(materialsEn.materials.invalidFiles);
  confirmImport();
  expect(screen.getByRole("button", { name: "Import materials" })).toHaveProperty("disabled", true);
  expectNoWrites();
});

test.each([
  "malformed",
  "schema",
  "unsafe-path",
  "missing-binding",
  "oversized",
])("rejects a %s manifest and removes a previously valid queue and confirmation", async (kind) => {
  const f = materialFixture();
  mount();
  await prepareImport(f);
  fireEvent.click(screen.getByRole("checkbox"));
  if (kind === "unsafe-path") f.pack.files[0] = { path: "../source.tar.gz", blob: f.source };
  if (kind === "missing-binding") f.pack.files.pop();
  const content =
    kind === "malformed"
      ? "{"
      : kind === "schema"
        ? '{"version":2}'
        : kind === "oversized"
          ? " ".repeat(2 * 1024 ** 2 + 1)
          : JSON.stringify(f.pack);
  fireEvent.change(screen.getByLabelText("Material manifest (JSON)"), {
    target: { files: [new File([content], "invalid.json")] },
  });
  expect((await screen.findByRole("alert")).textContent).toContain(
    materialsEn.materials.invalidManifest,
  );
  expect(screen.queryByRole("table", { name: "Material import queue" })).toBeNull();
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  expect(screen.getByRole("button", { name: "Import materials" })).toHaveProperty("disabled", true);
  expectNoWrites();
});

test("reselecting files requires fresh redistribution confirmation", async () => {
  const f = materialFixture();
  mount();
  await prepareImport(f);
  fireEvent.click(screen.getByRole("checkbox"));
  expect(screen.getByRole("button", { name: "Import materials" })).toHaveProperty(
    "disabled",
    false,
  );
  selectFiles([f.sourceFile, f.lockFile]);
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  expect(screen.getByRole("button", { name: "Import materials" })).toHaveProperty("disabled", true);
  expectNoWrites();
});

test("continues a partially failed batch and retries only unfinished releases", async () => {
  const f = materialFixture("public/materials", 3);
  vi.mocked(client.publishSpackMaterial)
    .mockResolvedValueOnce(f.binding)
    .mockRejectedValueOnce(new SoftwareError(422, "VALIDATION_ERROR", "invalid release"))
    .mockResolvedValue(f.binding);
  mount();
  await prepareImport(f);
  confirmImport();
  await screen.findByText("2 published, 1 failed, 0 unconfirmed");
  const rows = within(screen.getByRole("table", { name: "Material import queue" })).getAllByRole(
    "row",
  );
  expect(rows).toHaveLength(4);
  for (const [index, row] of rows.slice(1).entries()) {
    expect(within(row).getByText(index === 1 ? "Failed" : "Published")).toBeTruthy();
  }
  expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(2);
  expect(vi.mocked(client.publishSpackMaterial).mock.calls.map(([release]) => release)).toEqual(
    f.pack.releases,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry unfinished releases" }));
  await screen.findByText("3 published, 0 failed, 0 unconfirmed");
  expect(client.publishSpackMaterial).toHaveBeenCalledTimes(4);
  expect(client.publishSpackMaterial).toHaveBeenLastCalledWith(
    f.pack.releases[1],
    expect.any(AbortSignal),
  );
  expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(4);
});

test("replacing files in the same manifest retains successful bindings and only retries unfinished releases", async () => {
  const f = materialFixture("public/materials", 2);
  vi.mocked(client.publishSpackMaterial)
    .mockResolvedValueOnce(f.binding)
    .mockRejectedValueOnce(new SoftwareError(422, "VALIDATION_ERROR", "invalid release"))
    .mockResolvedValue(f.binding);
  mount();
  await prepareImport(f);
  confirmImport();
  await screen.findByText("1 published, 1 failed, 0 unconfirmed");
  selectFiles([new File(["source"], "source.tar.gz"), f.lockFile]);
  expect(screen.getByRole("button", { name: "Copy release binding" })).toBeTruthy();
  expect(screen.getByRole("checkbox")).toHaveProperty("checked", false);
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "Retry unfinished releases" }));
  await screen.findByText("2 published, 0 failed, 0 unconfirmed");
  expect(
    vi.mocked(client.publishSpackMaterial).mock.calls.map(([release]) => release.spec),
  ).toEqual([f.pack.releases[0]?.spec, f.pack.releases[1]?.spec, f.pack.releases[1]?.spec]);
});

test("a failed retry cannot clear an earlier unconfirmed publication outcome", async () => {
  const f = materialFixture();
  vi.mocked(client.publishSpackMaterial).mockRejectedValueOnce(
    new SoftwareError(503, "UNAVAILABLE"),
  );
  mount();
  await prepareImport(f);
  confirmImport();
  await screen.findByText("0 published, 0 failed, 1 unconfirmed");
  vi.mocked(client.uploadSpackMaterial).mockRejectedValueOnce(
    new SoftwareError(422, "VALIDATION_ERROR", "checksum"),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry unfinished releases" }));
  await screen.findByText("Material validation or publication failed");
  expect(screen.getByText("Publication outcome unconfirmed")).toBeTruthy();
  expect(screen.getByText("0 published, 0 failed, 1 unconfirmed")).toBeTruthy();
  expect(client.publishSpackMaterial).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry unfinished releases" }));
  await screen.findByText("1 published, 0 failed, 0 unconfirmed");
  expect(screen.queryByText("Publication outcome unconfirmed")).toBeNull();
});

test.each([
  "network",
  "503",
])("keeps a lost %s publication response uncertain until explicit retry", async (kind) => {
  const f = materialFixture();
  vi.mocked(client.publishSpackMaterial).mockRejectedValueOnce(
    kind === "network" ? new TypeError("response lost") : new SoftwareError(503, "UNAVAILABLE"),
  );
  mount();
  await prepareImport(f);
  confirmImport();
  await screen.findByText("0 published, 0 failed, 1 unconfirmed");
  expect(screen.getByText("Publication outcome unconfirmed")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Copy release binding" })).toBeNull();
  expect(client.publishSpackMaterial).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry unfinished releases" }));
  await screen.findByText("1 published, 0 failed, 0 unconfirmed");
  expect(client.publishSpackMaterial).toHaveBeenCalledTimes(2);
});

test.each([
  "upload",
  "publish",
])("stop aborts the %s signal and prevents queued writes after a late response", async (stage) => {
  const f = materialFixture("public/materials", 2);
  const upload = deferred<SpackMaterialBlob>();
  const publish = deferred<typeof f.binding>();
  if (stage === "upload") vi.mocked(client.uploadSpackMaterial).mockReturnValueOnce(upload.promise);
  else vi.mocked(client.publishSpackMaterial).mockReturnValueOnce(publish.promise);
  mount();
  await prepareImport(f);
  confirmImport();
  await waitFor(() =>
    expect(
      stage === "upload" ? client.uploadSpackMaterial : client.publishSpackMaterial,
    ).toHaveBeenCalledTimes(1),
  );
  const signal =
    stage === "upload"
      ? vi.mocked(client.uploadSpackMaterial).mock.calls[0]?.[3]
      : vi.mocked(client.publishSpackMaterial).mock.calls[0]?.[1];
  fireEvent.click(screen.getByRole("button", { name: "Stop import" }));
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    upload.resolve(f.lock);
    publish.resolve(f.binding);
  });
  expect(
    await screen.findByText(stage === "upload" ? "Interrupted" : "Publication outcome unconfirmed"),
  ).toBeTruthy();
  expect(client.uploadSpackMaterial).toHaveBeenCalledTimes(stage === "upload" ? 1 : 2);
  expect(client.publishSpackMaterial).toHaveBeenCalledTimes(stage === "upload" ? 0 : 1);
  expect(screen.queryByRole("button", { name: "Inspect release" })).toBeNull();
});

test("inspects and copies the returned binding and paginates the fetched manifest", async () => {
  const f = materialFixture();
  const manifest = {
    ...f.manifest,
    sources: Array.from({ length: 21 }, (_, index) => ({
      path: `source-${index}.tar.gz`,
      blob: f.source,
    })),
  };
  vi.mocked(client.getSpackMaterial).mockResolvedValue(manifest);
  const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  mount();
  await prepareImport(f);
  confirmImport();
  await screen.findByText("1 published, 0 failed, 0 unconfirmed");
  fireEvent.click(screen.getByRole("button", { name: "Copy release binding" }));
  expect(copy).toHaveBeenCalledExactlyOnceWith(JSON.stringify(f.binding, null, 2));
  fireEvent.click(screen.getByRole("button", { name: "Inspect release" }));
  const detail = within(await screen.findByTestId("material-release-detail"));
  expect(client.getSpackMaterial).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(screen.getByLabelText("Repository ID")).toHaveProperty("value", f.binding.repositoryId);
  expect(screen.getByLabelText("Manifest digest")).toHaveProperty(
    "value",
    f.binding.manifestDigest,
  );
  expect(detail.getByText(f.lock.digest)).toBeTruthy();
  expect(detail.getByRole("list", { name: "Pinned recipe snapshots" }).textContent).toContain(
    "d".repeat(40),
  );
  expect(
    within(detail.getByRole("table", { name: "Source materials" })).getAllByRole("row"),
  ).toHaveLength(21);
  expect(detail.queryByText("source-20.tar.gz")).toBeNull();
  expect(detail.getByRole("button", { name: "Previous sources" })).toHaveProperty("disabled", true);
  fireEvent.click(detail.getByRole("button", { name: "Next sources" }));
  expect(detail.getByText("source-20.tar.gz")).toBeTruthy();
  expect(detail.queryByText("source-0.tar.gz")).toBeNull();
  expect(detail.getByRole("button", { name: "Next sources" })).toHaveProperty("disabled", true);
  fireEvent.click(detail.getByRole("button", { name: "Previous sources" }));
  expect(detail.getByText("source-0.tar.gz")).toBeTruthy();
  expect(client.getSpackMaterial).toHaveBeenCalledTimes(1);
});

test.each([
  false,
  true,
])("ordinary users remain read-only with canManage=%s but can inspect bindings", async (canManage) => {
  access.data = capabilities("user");
  mount(canManage);
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  findRelease(materialFixture().binding);
  await screen.findByTestId("material-release-detail");
  expectNoWrites();
});

test.each([
  "public/materials",
  "org/org-b/materials",
  "org/org-a/materials",
])("checks every org_admin batch destination including %s", async (repository) => {
  access.data = capabilities("org_admin");
  localStorage.setItem("kq_active_organization_id", "org-a");
  const f = materialFixture("org/org-a/materials", 2);
  const first = f.pack.releases[0];
  if (!first) throw new Error("Missing release fixture");
  f.pack.releases[1] = {
    ...first,
    repository,
    spec: "second@1.0",
  };
  mount();
  await prepareImport(f);
  confirmImport();
  if (repository === "org/org-a/materials") {
    await screen.findByText("2 published, 0 failed, 0 unconfirmed");
    expect(client.publishSpackMaterial).toHaveBeenCalledTimes(2);
  } else {
    expect(screen.getByRole("alert").textContent).toContain(materialsEn.materials.accessChanged);
    expect(screen.getByRole("button", { name: "Import materials" })).toHaveProperty(
      "disabled",
      true,
    );
    expectNoWrites();
  }
});

test.each([
  "loading",
  "error",
  "revoked",
  "non-member",
])("fails closed for %s capabilities despite stored admin role", async (state) => {
  access.data = capabilities("org_admin");
  localStorage.setItem("kq_active_organization_id", "org-a");
  if (state === "loading" || state === "error") access.status = state;
  if (state === "revoked") access.data.capabilities = [];
  if (state === "non-member") access.data.contexts = [];
  mount();
  await screen.findByText("No materials found");
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  expect(screen.getByRole("button", { name: "Find release" })).toHaveProperty("disabled", true);
  expectNoWrites();
});

test.each(["anonymous", "local"])("%s mode offers no material operations or requests", (mode) => {
  if (mode === "anonymous") clearAuth();
  else window.__KQ_LOCAL__ = { baseUrl: "http://localhost:19999" };
  mount();
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  expect(client.getSpackMaterial).not.toHaveBeenCalled();
  expectNoWrites();
});

test("the mobile management policy hides uploads while retaining authorized lookup", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  mount();
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  findRelease(materialFixture().binding);
  await screen.findByTestId("material-release-detail");
  expectNoWrites();
});

test("Chinese and English material messages have matching keys and interpolation fields", async () => {
  expect(Object.keys(materialsEn.materials).sort()).toEqual(
    Object.keys(materialsZh.materials).sort(),
  );
  for (const key of Object.keys(materialsEn.materials) as Array<
    keyof typeof materialsEn.materials
  >) {
    expect(materialsEn.materials[key].match(/\{\{\w+\}\}/g) ?? []).toEqual(
      materialsZh.materials[key].match(/\{\{\w+\}\}/g) ?? [],
    );
  }
  await i18n.changeLanguage("zh");
  mount();
  await screen.findByText("未找到材料");
  expect(screen.getByRole("heading", { name: "Spack 材料" })).toBeTruthy();
  expect(screen.getByLabelText("材料清单（JSON）")).toBeTruthy();
});
