import type {
  MeCapabilities,
  SpackMaterialCatalog,
  SpackMaterialLifecycleView,
  SpackMaterialManifest,
} from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ACTIVE_ORGANIZATION_STORAGE_KEY } from "../../lib/active-organization";
import { clearAuth, setAuth } from "../../lib/auth";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import { SoftwareError } from "../../lib/software-client";
import * as lifecycle from "../../lib/spack-material-lifecycle-client";
import * as materials from "../../lib/spack-materials-client";
import {
  confirmLifecycle,
  inspectLifecycle,
  labels,
  lifecycleFixture,
  lifecycleUi,
  RESTORE_REASON,
  submitLifecycle,
  WITHDRAW_REASON,
} from "./MaterialLifecycle.test-helpers";
import {
  capabilities,
  confirmImport,
  deferred,
  expectNoWrites,
  findRelease,
  prepareImport,
  resetMaterials,
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
vi.mock("../../lib/spack-material-lifecycle-client", () => ({
  getSpackMaterialLifecycle: vi.fn(),
  changeSpackMaterialLifecycle: vi.fn(),
}));
vi.mock("../../lib/spack-materials-client", () => ({
  uploadSpackMaterial: vi.fn(),
  publishSpackMaterial: vi.fn(),
  getSpackMaterial: vi.fn(),
  listSpackMaterials: vi.fn(),
}));

beforeEach(async () => {
  await resetMaterials();
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-a");
  access.status = "ready";
  access.data = capabilities("org_admin");
  const f = lifecycleFixture();
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValue(f.view);
  vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockResolvedValue(
    f.atRevision(1, WITHDRAW_REASON),
  );
  vi.mocked(materials.getSpackMaterial).mockResolvedValue(f.manifest);
});
afterEach(() => {
  cleanup();
  clearAuth();
  setMobileManagementPolicy(false);
  vi.restoreAllMocks();
});

function mount(canManage = true) {
  return render(<SpackMaterialsPanel canManage={canManage} />);
}

const changes = [
  "logout",
  "same-email session",
  "organization",
  "capability revocation",
  "capabilities loading",
  "capabilities error",
] as const;
type ScopeChange = (typeof changes)[number];

async function changeScope(change: ScopeChange, view: ReturnType<typeof mount>) {
  await act(async () => {
    if (change === "logout") clearAuth();
    if (change === "same-email session") {
      setAuth({ email: "alice@example.test", role: "platform_admin" });
    }
    if (change === "organization") {
      localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-b");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    }
    if (change === "capability revocation") {
      access.data = { ...capabilities("org_admin"), capabilities: [] };
      view.rerender(<SpackMaterialsPanel canManage />);
    }
    if (change === "capabilities loading" || change === "capabilities error") {
      access.status = change === "capabilities loading" ? "loading" : "error";
      view.rerender(<SpackMaterialsPanel canManage />);
    }
  });
}

function expectLifecycleCleared() {
  expect(screen.queryByTestId("material-lifecycle-detail")).toBeNull();
  expect(screen.queryByRole("table", { name: labels.lifecycleHistory })).toBeNull();
  expect(screen.queryByLabelText(labels.lifecycleReason)).toBeNull();
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(screen.queryByText(RESTORE_REASON)).toBeNull();
  for (const label of [labels.lifecycleRepositoryId, labels.lifecycleManifestDigest]) {
    const input = screen.queryByLabelText(label);
    if (input) expect(input).toHaveProperty("value", "");
  }
  for (const notice of Object.values(labels.lifecycleNotice)) {
    expect(screen.queryByText(notice)).toBeNull();
  }
}

test("reads withdrawn lifecycle independently of ordinary manifest lookup and its 404", async () => {
  const f = lifecycleFixture();
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValueOnce(f.atRevision(1));
  vi.mocked(materials.getSpackMaterial).mockRejectedValueOnce(
    new SoftwareError(404, "NOT_FOUND", "Material release not found"),
  );
  mount();
  await screen.findByText(labels.catalogEmpty);
  expect(lifecycle.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  inspectLifecycle(f.binding);
  await screen.findByRole("table", { name: labels.lifecycleHistory });
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expect(screen.getByLabelText(labels.repositoryId)).toHaveProperty("value", "");
  findRelease(f.binding);
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(lifecycleUi().getByRole("table", { name: labels.lifecycleHistory })).toBeTruthy();
  expect(
    lifecycleUi().getByRole("button", { name: labels.lifecycleAction.restore }),
  ).toHaveProperty("disabled", true);
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(lifecycle.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  expectNoWrites();
});

test.each(
  changes,
)("%s clears fetched identity, history, reason and confirmation", async (change) => {
  const f = lifecycleFixture();
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValueOnce(f.atRevision(1));
  const view = mount();
  inspectLifecycle(f.binding);
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle(RESTORE_REASON);
  expect(lifecycleUi().getByRole("checkbox")).toHaveProperty("checked", true);
  findRelease(f.binding);
  await screen.findByTestId("material-release-detail");

  await changeScope(change, view);

  expectLifecycleCleared();
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(lifecycle.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  expectNoWrites();
});

const pendingCases = changes.flatMap((change) => [
  { change, stage: "read" as const },
  { change, stage: "write" as const },
]);

test.each(pendingCases)("$change aborts a pending $stage and ignores its late result", async ({
  change,
  stage,
}) => {
  const f = lifecycleFixture();
  const pending = deferred<SpackMaterialLifecycleView>();
  if (stage === "read") {
    vi.mocked(lifecycle.getSpackMaterialLifecycle).mockReturnValueOnce(pending.promise);
  } else {
    vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockReturnValueOnce(pending.promise);
  }
  const view = mount();
  inspectLifecycle(f.binding);
  if (stage === "write") {
    await screen.findByTestId("material-lifecycle-detail");
    confirmLifecycle();
    submitLifecycle();
  }
  const signal =
    stage === "read"
      ? vi.mocked(lifecycle.getSpackMaterialLifecycle).mock.calls[0]?.[1]
      : vi.mocked(lifecycle.changeSpackMaterialLifecycle).mock.calls[0]?.[2];
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);

  await changeScope(change, view);
  expect(signal?.aborted).toBe(true);
  expectLifecycleCleared();
  const catalogReads = vi.mocked(materials.listSpackMaterials).mock.calls.length;
  await act(async () => pending.resolve(f.atRevision(1, WITHDRAW_REASON)));

  expectLifecycleCleared();
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(stage === "write" ? 1 : 0);
  expect(materials.listSpackMaterials).toHaveBeenCalledTimes(catalogReads);
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expectNoWrites();
});

test.each([
  "success",
  "503",
  "invalid-response",
  "stop",
])("%s invalidates the selected ordinary detail and catalog without automatically repeating POST", async (outcome) => {
  const f = lifecycleFixture();
  const refresh = deferred<SpackMaterialCatalog>();
  const pending = deferred<SpackMaterialLifecycleView>();
  vi.mocked(materials.listSpackMaterials).mockResolvedValueOnce(f.catalog);
  if (outcome === "stop") {
    vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockReturnValueOnce(pending.promise);
  } else if (outcome !== "success") {
    vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockRejectedValueOnce(
      new SoftwareError(
        outcome === "503" ? 503 : 502,
        outcome === "503" ? "MATERIAL_LIFECYCLE_UNAVAILABLE" : "REGISTRY_INVALID_RESPONSE",
        "Receipt unavailable",
      ),
    );
  }
  mount();
  const catalog = within(await screen.findByRole("table", { name: labels.catalogTitle }));
  fireEvent.click(catalog.getByRole("button", { name: labels.inspect }));
  await screen.findByTestId("material-release-detail");
  expect(lifecycleUi().getByLabelText(labels.lifecycleRepositoryId)).toHaveProperty(
    "value",
    f.binding.repositoryId,
  );
  expect(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest)).toHaveProperty(
    "value",
    f.binding.manifestDigest,
  );
  expect(lifecycle.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  vi.mocked(materials.listSpackMaterials).mockReturnValueOnce(refresh.promise);
  confirmLifecycle();
  submitLifecycle();
  if (outcome === "stop") {
    fireEvent.click(lifecycleUi().getByRole("button", { name: labels.lifecycleStop }));
    const signal = vi.mocked(lifecycle.changeSpackMaterialLifecycle).mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(true);
  }
  const notice =
    outcome === "success" ? labels.lifecycleNotice.changed : labels.lifecycleNotice.uncertain;
  await screen.findByText(notice);
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(screen.queryByRole("table", { name: labels.catalogTitle })).toBeNull();
  expect(screen.getByLabelText(labels.repositoryId)).toHaveProperty("value", "");
  expect(screen.getByLabelText(labels.manifestDigest)).toHaveProperty("value", "");
  expect(materials.listSpackMaterials).toHaveBeenCalledTimes(2);
  expect(materials.listSpackMaterials).toHaveBeenLastCalledWith({}, expect.any(AbortSignal));
  expect(materials.getSpackMaterial).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    { action: "withdraw", expectedRevision: 0, reason: WITHDRAW_REASON },
    expect.any(AbortSignal),
  );
  await act(async () => {
    refresh.resolve({ releases: [] });
    pending.resolve(f.atRevision(1, WITHDRAW_REASON));
  });
  expect(screen.getByText(labels.catalogEmpty)).toBeTruthy();
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(screen.getByText(notice)).toBeTruthy();
  if (outcome !== "success") {
    expect(screen.queryByTestId("material-lifecycle-detail")).toBeNull();
  }
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(materials.listSpackMaterials).toHaveBeenCalledTimes(2);
  expectNoWrites();
});

test.each(["success", "uncertain"])("%s discards a pending ordinary lookup", async (outcome) => {
  const f = lifecycleFixture();
  const pending = deferred<SpackMaterialManifest>();
  vi.mocked(materials.getSpackMaterial).mockReturnValueOnce(pending.promise);
  if (outcome === "uncertain") {
    vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockRejectedValueOnce(
      new SoftwareError(503, "MATERIAL_LIFECYCLE_UNAVAILABLE", "Unavailable"),
    );
  }
  mount();
  findRelease(f.binding);
  const signal = vi.mocked(materials.getSpackMaterial).mock.calls[0]?.[1];
  expect(signal?.aborted).toBe(false);
  inspectLifecycle(f.binding);
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  submitLifecycle();
  await screen.findByText(
    outcome === "success" ? labels.lifecycleNotice.changed : labels.lifecycleNotice.uncertain,
  );
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(f.manifest));
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(materials.getSpackMaterial).toHaveBeenCalledTimes(1);
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
});

test.each([
  "success",
  "conflict",
  "uncertain then GET",
  "uncertain then edit",
])("%s protects a pending lifecycle write from catalog and import selection attempts", async (outcome) => {
  const f = lifecycleFixture();
  const sibling = lifecycleFixture("org/org-a/alternate");
  const pending = deferred<SpackMaterialLifecycleView>();
  const catalog: SpackMaterialCatalog = {
    releases: [...f.catalog.releases, ...sibling.catalog.releases],
  };
  vi.mocked(materials.listSpackMaterials).mockResolvedValue(catalog);
  vi.mocked(materials.publishSpackMaterial).mockResolvedValueOnce(sibling.binding);
  vi.mocked(materials.getSpackMaterial).mockImplementation(async (binding) =>
    binding.repositoryId === sibling.binding.repositoryId ? sibling.manifest : f.manifest,
  );
  vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockImplementationOnce(async () => {
    const receipt = await pending.promise;
    if (outcome === "conflict") {
      throw new SoftwareError(409, "MATERIAL_LIFECYCLE_CONFLICT", "Revision changed");
    }
    if (outcome.startsWith("uncertain")) {
      throw new SoftwareError(503, "MATERIAL_LIFECYCLE_UNAVAILABLE", "Receipt lost");
    }
    return receipt;
  });
  const catalogSelection = (repository: string) =>
    within(
      within(screen.getByRole("table", { name: labels.catalogTitle })).getByRole("row", {
        name: new RegExp(repository),
      }),
    ).getByRole("button", { name: labels.inspect });
  const importSelection = () =>
    within(screen.getByRole("table", { name: labels.queue })).getByRole("button", {
      name: labels.inspect,
    });
  mount();
  await screen.findByRole("table", { name: labels.catalogTitle });
  await prepareImport(sibling);
  confirmImport();
  await screen.findByText("1 published, 0 failed, 0 unconfirmed");
  fireEvent.click(catalogSelection(f.view.repository));
  await screen.findByTestId("material-release-detail");
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();

  act(() => {
    submitLifecycle();
    fireEvent.click(importSelection());
    fireEvent.click(catalogSelection(sibling.view.repository));
  });
  const signal = vi.mocked(lifecycle.changeSpackMaterialLifecycle).mock.calls[0]?.[2];
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
  expect(lifecycleUi().getByText(labels.lifecycleBusy.write)).toBeTruthy();
  expect(lifecycleUi().getByLabelText(labels.lifecycleRepositoryId)).toHaveProperty(
    "value",
    f.binding.repositoryId,
  );
  expect(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest)).toHaveProperty(
    "value",
    f.binding.manifestDigest,
  );
  expect(catalogSelection(sibling.view.repository)).toHaveProperty("disabled", true);
  expect(materials.getSpackMaterial).toHaveBeenCalledTimes(1);
  expect(materials.listSpackMaterials).toHaveBeenCalledTimes(1);
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);

  await act(async () => pending.resolve(f.atRevision(1, WITHDRAW_REASON)));
  const uncertain = outcome.startsWith("uncertain");
  const notice = uncertain
    ? labels.lifecycleNotice.uncertain
    : outcome === "conflict"
      ? labels.lifecycleNotice.conflict
      : labels.lifecycleNotice.changed;
  await screen.findByText(notice);
  expect(signal?.aborted).toBe(false);
  expect(materials.listSpackMaterials).toHaveBeenCalledTimes(outcome === "conflict" ? 1 : 2);
  if (outcome !== "conflict") {
    expect(screen.queryByTestId("material-release-detail")).toBeNull();
  }
  if (uncertain) {
    expect(catalogSelection(sibling.view.repository)).toHaveProperty("disabled", true);
    fireEvent.click(catalogSelection(sibling.view.repository));
    fireEvent.click(importSelection());
    expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
    expect(lifecycleUi().getByLabelText(labels.lifecycleRepositoryId)).toHaveProperty(
      "value",
      f.binding.repositoryId,
    );
    expect(materials.getSpackMaterial).toHaveBeenCalledTimes(1);
    expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
    if (outcome === "uncertain then GET") {
      const recheck = deferred<SpackMaterialLifecycleView>();
      vi.mocked(lifecycle.getSpackMaterialLifecycle).mockReturnValueOnce(recheck.promise);
      inspectLifecycle();
      fireEvent.click(importSelection());
      expect(catalogSelection(sibling.view.repository)).toHaveProperty("disabled", true);
      await act(async () => recheck.resolve(f.atRevision(1, WITHDRAW_REASON)));
      expect(lifecycleUi().getByText(labels.lifecycleNotice.rechecked)).toBeTruthy();
    } else {
      fireEvent.change(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest), {
        target: { value: sibling.binding.manifestDigest },
      });
      expect(lifecycleUi().queryByRole("alert")).toBeNull();
    }
  }
  expect(catalogSelection(sibling.view.repository)).toHaveProperty("disabled", false);
  fireEvent.click(importSelection());
  await screen.findByTestId("material-release-detail");
  expect(lifecycleUi().getByLabelText(labels.lifecycleRepositoryId)).toHaveProperty(
    "value",
    sibling.binding.repositoryId,
  );
  expect(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest)).toHaveProperty(
    "value",
    sibling.binding.manifestDigest,
  );
  expect(materials.getSpackMaterial).toHaveBeenCalledTimes(2);
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledTimes(
    outcome === "uncertain then GET" ? 2 : 1,
  );
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(materials.publishSpackMaterial).toHaveBeenCalledTimes(1);
});

test("a repository outside the active organization reveals no identity or audit view", async () => {
  const f = lifecycleFixture("org/org-b/private");
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValueOnce(f.atRevision(1));
  mount();
  inspectLifecycle(f.binding);
  expect((await lifecycleUi().findByRole("alert")).textContent).toBe(
    labels.lifecycleNotice.forbidden,
  );
  expect(screen.queryByTestId("material-lifecycle-detail")).toBeNull();
  expect(screen.queryByText(f.view.repository)).toBeNull();
  expect(screen.queryByRole("table", { name: labels.lifecycleHistory })).toBeNull();
  expect(screen.queryByLabelText(labels.lifecycleReason)).toBeNull();
  expect(lifecycle.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
});

test.each([
  "org/org-a/materials",
  "org/org-b/materials",
])("mobile policy permits only manageable namespace audit reads, never writes: %s", async (repository) => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  const f = lifecycleFixture(repository);
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValueOnce(f.atRevision(1));
  mount();
  expect(screen.queryByLabelText(labels.manifestFile)).toBeNull();
  inspectLifecycle(f.binding);
  if (repository === "org/org-a/materials") {
    await screen.findByRole("table", { name: labels.lifecycleHistory });
    confirmLifecycle(RESTORE_REASON);
    expect(
      lifecycleUi().getByRole("button", { name: labels.lifecycleAction.restore }),
    ).toHaveProperty("disabled", true);
    submitLifecycle("restore");
  } else {
    expect((await lifecycleUi().findByRole("alert")).textContent).toBe(
      labels.lifecycleNotice.forbidden,
    );
    expect(screen.queryByTestId("material-lifecycle-detail")).toBeNull();
  }
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(lifecycle.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  expectNoWrites();
});

test.each([
  "management disabled",
  "reader",
  "non-member",
])("%s exposes no lifecycle operation despite stored admin authentication", async (mode) => {
  if (mode === "reader") access.data = capabilities("user");
  if (mode === "non-member") access.data = { ...capabilities("org_admin"), contexts: [] };
  mount(mode !== "management disabled");
  await screen.findByText(labels.catalogEmpty);
  expect(screen.queryByTestId("material-lifecycle")).toBeNull();
  expect(lifecycle.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  expect(lifecycle.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  expectNoWrites();
});
