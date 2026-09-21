import type {
  MeCapabilities,
  SpackMaterialLifecycleView,
  SpackMaterialManagementCatalog,
  SpackMaterialManifest,
} from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ACTIVE_ORGANIZATION_STORAGE_KEY } from "../../lib/active-organization";
import { clearAuth, setAuth } from "../../lib/auth";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import { SoftwareError } from "../../lib/software-client";
import * as lifecycle from "../../lib/spack-material-lifecycle-client";
import * as management from "../../lib/spack-material-management-client";
import * as materials from "../../lib/spack-materials-client";
import {
  confirmLifecycle,
  inspectLifecycle,
  labels,
  lifecycleFixture,
  lifecycleUi,
  RESTORE_REASON,
  submitLifecycle,
} from "./MaterialLifecycle.test-helpers";
import {
  capabilities,
  deferred,
  expectNoWrites,
  findRelease,
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
vi.mock("../../lib/spack-material-management-client", () => ({
  listSpackMaterialManagement: vi.fn(),
}));
vi.mock("../../lib/spack-materials-client", () => ({
  uploadSpackMaterial: vi.fn(),
  publishSpackMaterial: vi.fn(),
  getSpackMaterial: vi.fn(),
  listSpackMaterials: vi.fn(),
}));

const f = lifecycleFixture();
const catalog: SpackMaterialManagementCatalog = {
  releases: f.catalog.releases.map((release) => ({
    ...release,
    spec: "management-source@1.0",
    state: "withdrawn",
    revision: 1,
  })),
  nextCursor: `v1.${"z".repeat(64)}`,
};

beforeEach(async () => {
  await resetMaterials();
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-a");
  access.status = "ready";
  access.data = capabilities("org_admin");
  vi.mocked(management.listSpackMaterialManagement).mockResolvedValue(catalog);
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValue(f.atRevision(1));
  vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockResolvedValue(
    f.atRevision(2, RESTORE_REASON),
  );
  vi.mocked(materials.getSpackMaterial).mockResolvedValue(f.manifest);
});
afterEach(() => {
  cleanup();
  clearAuth();
  setMobileManagementPolicy(false);
  delete window.__KQ_LOCAL__;
  vi.restoreAllMocks();
});

function mount(canManage = true) {
  return render(<SpackMaterialsPanel canManage={canManage} />);
}

function search() {
  fireEvent.change(screen.getByLabelText(labels.managementRepository), {
    target: { value: f.view.repository },
  });
  fireEvent.change(screen.getByLabelText(labels.managementState), {
    target: { value: "withdrawn" },
  });
  fireEvent.change(screen.getByLabelText(labels.managementPageSize), { target: { value: "5" } });
  fireEvent.click(screen.getByRole("button", { name: labels.managementSearch }));
}

async function selectManaged() {
  const table = within(await screen.findByRole("table", { name: labels.managementTitle }));
  fireEvent.click(table.getByRole("button", { name: labels.managementManage }));
}

test("withdrawn selection only populates lifecycle, and repeated selection resets manual edits", async () => {
  mount();
  expect(management.listSpackMaterialManagement).not.toHaveBeenCalled();
  search();
  await selectManaged();
  expect(screen.getByLabelText(labels.repositoryId)).toHaveProperty("value", "");
  expect(screen.getByLabelText(labels.manifestDigest)).toHaveProperty("value", "");
  expect(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest)).toHaveProperty(
    "value",
    f.binding.manifestDigest,
  );
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expect(lifecycle.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  fireEvent.change(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest), {
    target: { value: `sha256:${"9".repeat(64)}` },
  });
  await selectManaged();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expectNoWrites();
});

test("management selection aborts an ordinary lookup and suppresses its late manifest", async () => {
  const pending = deferred<SpackMaterialManifest>();
  vi.mocked(materials.getSpackMaterial).mockReturnValueOnce(pending.promise);
  mount();
  findRelease(f.binding);
  const signal = vi.mocked(materials.getSpackMaterial).mock.calls[0]?.[1];
  search();
  await selectManaged();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(f.manifest));
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(materials.getSpackMaterial).toHaveBeenCalledTimes(1);
});

const changes = [
  "logout",
  "identity",
  "same-email session",
  "organization",
  "role",
  "capability revocation",
  "loading",
  "error",
  "management disabled",
] as const;

async function changeScope(change: (typeof changes)[number], view: ReturnType<typeof mount>) {
  await act(async () => {
    if (change === "logout") clearAuth();
    if (change === "identity") setAuth({ email: "bob@example.test", role: "user" });
    if (change === "same-email session") {
      setAuth({ email: "alice@example.test", role: "platform_admin" });
    }
    if (change === "organization") {
      localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-b");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    }
    if (change === "role") access.data = capabilities("user");
    if (change === "capability revocation") access.data = { ...capabilities(), capabilities: [] };
    if (change === "loading" || change === "error") access.status = change;
    view.rerender(<SpackMaterialsPanel canManage={change !== "management disabled"} />);
  });
}

test.each(
  changes,
)("%s aborts management requests and ignores late private results", async (change) => {
  const pending = deferred<SpackMaterialManagementCatalog>();
  vi.mocked(management.listSpackMaterialManagement).mockReturnValueOnce(pending.promise);
  const view = mount();
  search();
  const signal = vi.mocked(management.listSpackMaterialManagement).mock.calls[0]?.[1];
  await changeScope(change, view);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(catalog));
  expect(screen.queryByRole("table", { name: labels.managementTitle })).toBeNull();
  expect(screen.queryByText("management-source@1.0")).toBeNull();
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(1);
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expectNoWrites();
});

test.each(
  changes,
)("%s clears loaded management rows, filter, cursors and lifecycle selection", async (change) => {
  const view = mount();
  search();
  await selectManaged();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  await changeScope(change, view);
  expect(screen.queryByTestId("material-lifecycle-detail")).toBeNull();
  expect(screen.queryByRole("table", { name: labels.managementTitle })).toBeNull();
  const input = screen.queryByLabelText(labels.managementRepository);
  if (input) expect(input).toHaveProperty("value", "");
  const binding = screen.queryByLabelText(labels.lifecycleManifestDigest);
  if (binding) expect(binding).toHaveProperty("value", "");
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(1);
});

test.each([
  "success",
  "uncertain",
  "stop",
])("%s lifecycle invalidation remounts management, preserving only filters", async (outcome) => {
  const diagnostics = vi.spyOn(console, "error");
  const pending = deferred<SpackMaterialLifecycleView>();
  if (outcome === "uncertain") {
    vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockRejectedValueOnce(
      new SoftwareError(503, "REGISTRY_UNREACHABLE", "Receipt unavailable"),
    );
  }
  if (outcome === "stop") {
    vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockReturnValueOnce(pending.promise);
  }
  mount();
  search();
  await selectManaged();
  const previousCatalog = screen.getByTestId("material-management-catalog");
  const previousOrdinaryFilter = screen.getByLabelText(labels.catalogRepository);
  const editor = screen.getByTestId("material-lifecycle");
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle(RESTORE_REASON);
  submitLifecycle("restore");
  if (outcome === "stop") {
    fireEvent.click(lifecycleUi().getByRole("button", { name: labels.lifecycleStop }));
  }
  await screen.findByText(
    outcome === "success" ? labels.lifecycleNotice.changed : labels.lifecycleNotice.uncertain,
  );
  const currentCatalog = screen.getByTestId("material-management-catalog");
  expect(currentCatalog).not.toBe(previousCatalog);
  expect(previousCatalog.isConnected).toBe(false);
  expect(previousOrdinaryFilter.isConnected).toBe(false);
  expect(screen.getByTestId("material-lifecycle")).toBe(editor);
  expect(screen.queryByRole("table", { name: labels.managementTitle })).toBeNull();
  expect(screen.queryByRole("button", { name: labels.managementNext })).toBeNull();
  expect(screen.getByLabelText(labels.managementRepository)).toHaveProperty(
    "value",
    f.view.repository,
  );
  expect(screen.getByLabelText(labels.managementState)).toHaveProperty("value", "withdrawn");
  expect(screen.getByLabelText(labels.managementPageSize)).toHaveProperty("value", "5");
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(1);
  const refresh = within(currentCatalog).getByRole("button", { name: labels.managementRefresh });
  expect(refresh).toHaveProperty("disabled", false);
  fireEvent.click(refresh);
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(2);
  expect(management.listSpackMaterialManagement).toHaveBeenLastCalledWith(
    { repository: f.view.repository, state: "withdrawn", limit: 5 },
    expect.any(AbortSignal),
  );
  const refreshSignal = vi.mocked(management.listSpackMaterialManagement).mock.calls[1]?.[1];
  expect(refreshSignal?.aborted).toBe(false);
  const table = await within(currentCatalog).findByRole("table", { name: labels.managementTitle });
  expect(screen.getByTestId("material-management-catalog")).toBe(currentCatalog);
  expect(currentCatalog.contains(table)).toBe(true);
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  expect(refreshSignal?.aborted).toBe(false);
  expect(screen.getByTestId("material-lifecycle")).toBe(editor);
  if (outcome !== "success") {
    expect(screen.getByRole("button", { name: labels.managementManage })).toHaveProperty(
      "disabled",
      true,
    );
    expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
    expect(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest)).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("tab", { name: labels.visibilityTab })).toHaveProperty(
      "disabled",
      true,
    );
  }
  await act(async () => pending.resolve(f.atRevision(2)));
  expect(screen.getByRole("table", { name: labels.managementTitle })).toBe(table);
  expect(screen.getByTestId("material-lifecycle")).toBe(editor);
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(2);
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expect(
    diagnostics.mock.calls.filter(([message]) =>
      String(message).includes("Encountered two children with the same key"),
    ),
  ).toEqual([]);
});

test("invalidation aborts a pending management page and ignores its late result", async () => {
  const pending = deferred<SpackMaterialManagementCatalog>();
  vi.mocked(management.listSpackMaterialManagement)
    .mockResolvedValueOnce(catalog)
    .mockReturnValueOnce(pending.promise);
  mount();
  search();
  await selectManaged();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  fireEvent.click(screen.getByRole("button", { name: labels.managementNext }));
  const signal = vi.mocked(management.listSpackMaterialManagement).mock.calls[1]?.[1];
  confirmLifecycle(RESTORE_REASON);
  submitLifecycle("restore");
  await screen.findByText(labels.lifecycleNotice.changed);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(catalog));
  expect(screen.queryByRole("table", { name: labels.managementTitle })).toBeNull();
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(2);
});

test("pending write and uncertain receipt block management selection until explicit recheck", async () => {
  const pending = deferred<SpackMaterialLifecycleView>();
  vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockImplementationOnce(async () => {
    await pending.promise;
    throw new SoftwareError(503, "REGISTRY_UNREACHABLE", "Receipt unavailable");
  });
  mount();
  search();
  await selectManaged();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle(RESTORE_REASON);
  act(() => {
    submitLifecycle("restore");
    fireEvent.click(screen.getByRole("button", { name: labels.managementManage }));
  });
  const signal = vi.mocked(lifecycle.changeSpackMaterialLifecycle).mock.calls[0]?.[2];
  expect(signal?.aborted).toBe(false);
  expect(screen.getByRole("button", { name: labels.managementManage })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => pending.resolve(f.atRevision(2)));
  await screen.findByText(labels.lifecycleNotice.uncertain);
  fireEvent.click(screen.getByRole("button", { name: labels.managementRefresh }));
  await screen.findByRole("table", { name: labels.managementTitle });
  fireEvent.click(screen.getByRole("button", { name: labels.managementManage }));
  expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  inspectLifecycle();
  await screen.findByText(labels.lifecycleNotice.rechecked);
  expect(screen.getByRole("button", { name: labels.managementManage })).toHaveProperty(
    "disabled",
    false,
  );
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
});

test("organization changes before rerender block management requests and visible row selections", async () => {
  mount();
  search();
  await screen.findByRole("table", { name: labels.managementTitle });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-b");
  fireEvent.click(screen.getByRole("button", { name: labels.managementManage }));
  fireEvent.click(screen.getByRole("button", { name: labels.managementRefresh }));
  expect(lifecycleUi().getByLabelText(labels.lifecycleRepositoryId)).toHaveProperty("value", "");
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(1);
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
});

test.each([
  "signed out",
  "local",
  "reader",
  "non-member",
  "management disabled",
])("%s has no management catalog or management reads", (mode) => {
  if (mode === "signed out") clearAuth();
  if (mode === "local") window.__KQ_LOCAL__ = { baseUrl: "http://localhost:19999" };
  if (mode === "reader") access.data = capabilities("user");
  if (mode === "non-member") access.data = { ...capabilities("org_admin"), contexts: [] };
  mount(mode !== "management disabled");
  expect(screen.queryByTestId("material-management-catalog")).toBeNull();
  expect(management.listSpackMaterialManagement).not.toHaveBeenCalled();
});

test("mobile management reads remain available while lifecycle mutations stay blocked", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  mount();
  search();
  await selectManaged();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  expect(
    lifecycleUi().getByRole("button", { name: labels.lifecycleAction.restore }),
  ).toHaveProperty("disabled", true);
  expect(management.listSpackMaterialManagement).toHaveBeenCalledTimes(1);
  expect(lifecycle.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expectNoWrites();
});
