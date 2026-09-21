import type {
  MeCapabilities,
  SpackMaterialLifecycleView,
  SpackMaterialVisibilityView,
} from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ACTIVE_ORGANIZATION_STORAGE_KEY } from "../../lib/active-organization";
import { clearAuth, setAuth } from "../../lib/auth";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import { SoftwareError } from "../../lib/software-client";
import * as lifecycle from "../../lib/spack-material-lifecycle-client";
import * as management from "../../lib/spack-material-management-client";
import * as visibility from "../../lib/spack-material-visibility-client";
import * as materials from "../../lib/spack-materials-client";
import {
  confirmLifecycle,
  inspectLifecycle,
  labels,
  lifecycleFixture,
  lifecycleUi,
  submitLifecycle,
} from "./MaterialLifecycle.test-helpers";
import {
  confirmVisibility,
  inspectVisibility,
  selectManagementTab,
  submitVisibility,
  visibilityFixture,
  visibilityUi,
} from "./MaterialVisibility.test-helpers";
import {
  capabilities,
  deferred,
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
vi.mock("../../lib/spack-material-visibility-client", () => ({
  getSpackMaterialVisibility: vi.fn(),
  changeSpackMaterialVisibility: vi.fn(),
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

const f = visibilityFixture();
beforeEach(async () => {
  await resetMaterials();
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-a");
  access.status = "ready";
  access.data = capabilities("org_admin");
  vi.mocked(visibility.getSpackMaterialVisibility).mockResolvedValue(f.view);
  vi.mocked(visibility.changeSpackMaterialVisibility).mockResolvedValue(f.atRevision(1));
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValue(lifecycleFixture().view);
  vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockResolvedValue(
    lifecycleFixture().atRevision(1),
  );
  vi.mocked(management.listSpackMaterialManagement).mockResolvedValue({
    releases: f.catalog.releases.map((release) => ({ ...release, state: "available", revision: 0 })),
    nextCursor: null,
  });
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

async function selectBinding() {
  fireEvent.change(screen.getByLabelText(labels.managementRepository), {
    target: { value: f.view.repository },
  });
  fireEvent.click(screen.getByRole("button", { name: labels.managementSearch }));
  const table = within(await screen.findByRole("table", { name: labels.managementTitle }));
  fireEvent.click(table.getByRole("button", { name: labels.managementManage }));
}

async function readyVisibility() {
  await selectBinding();
  selectManagementTab("Visibility");
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
}

test("management selection supplies visibility without ordinary lookup; only the active editor reads", async () => {
  mount();
  await readyVisibility();
  expect(visibility.getSpackMaterialVisibility).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
  expect(lifecycle.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  expect(screen.queryByTestId("material-lifecycle")).toBeNull();
  selectManagementTab("Lifecycle");
  expect(screen.queryByTestId("material-visibility")).toBeNull();
  expect(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest)).toHaveProperty(
    "value",
    f.binding.manifestDigest,
  );
});

const changes = [
  "logout",
  "identity",
  "organization",
  "role",
  "loading",
  "error",
  "management",
] as const;
async function changeScope(change: (typeof changes)[number], view: ReturnType<typeof mount>) {
  await act(async () => {
    if (change === "logout") clearAuth();
    if (change === "identity") setAuth({ email: "alice@example.test", role: "platform_admin" });
    if (change === "organization") {
      localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-b");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    }
    if (change === "role") access.data = capabilities("user");
    if (change === "loading" || change === "error") access.status = change;
    view.rerender(<SpackMaterialsPanel canManage={change !== "management"} />);
  });
}

test.each(changes)("%s removes private policy, audit and drafts", async (change) => {
  vi.mocked(visibility.getSpackMaterialVisibility).mockResolvedValueOnce(f.atRevision(1));
  const view = mount();
  await readyVisibility();
  confirmVisibility({ mode: "inherit" });
  await changeScope(change, view);
  expect(screen.queryByTestId("material-visibility-detail")).toBeNull();
  expect(screen.queryByLabelText(labels.visibilityReason)).toBeNull();
  expect(screen.queryByRole("table", { name: labels.visibilityHistory })).toBeNull();
  expect(visibility.changeSpackMaterialVisibility).not.toHaveBeenCalled();
});

test.each(
  changes.flatMap((change) => [
    { change, stage: "read" as const },
    { change, stage: "write" as const },
  ]),
)("$change aborts $stage and ignores late data", async ({ change, stage }) => {
  const pending = deferred<SpackMaterialVisibilityView>();
  if (stage === "read") {
    vi.mocked(visibility.getSpackMaterialVisibility).mockReturnValueOnce(pending.promise);
  } else {
    vi.mocked(visibility.changeSpackMaterialVisibility).mockReturnValueOnce(pending.promise);
  }
  const view = mount();
  await selectBinding();
  selectManagementTab("Visibility");
  inspectVisibility();
  if (stage === "write") {
    await screen.findByTestId("material-visibility-detail");
    confirmVisibility();
    submitVisibility();
  }
  const signal =
    stage === "read"
      ? vi.mocked(visibility.getSpackMaterialVisibility).mock.calls[0]?.[1]
      : vi.mocked(visibility.changeSpackMaterialVisibility).mock.calls[0]?.[2];
  await changeScope(change, view);
  expect(signal?.aborted).toBe(true);
  const reads = vi.mocked(materials.listSpackMaterials).mock.calls.length;
  await act(async () => pending.resolve(f.atRevision(1)));
  expect(screen.queryByTestId("material-visibility-detail")).toBeNull();
  expect(materials.listSpackMaterials).toHaveBeenCalledTimes(reads);
});

test.each(["lifecycle", "visibility"])("%s locks editor and catalog selection", async (editor) => {
  const pending = deferred<void>();
  const fail = async () => {
    await pending.promise;
    throw new SoftwareError(503, "REGISTRY_UNREACHABLE", "Uncertain receipt");
  };
  if (editor === "lifecycle") {
    vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockImplementationOnce(fail);
  } else {
    vi.mocked(visibility.changeSpackMaterialVisibility).mockImplementationOnce(fail);
  }
  mount();
  await selectBinding();
  if (editor === "visibility") selectManagementTab("Visibility");
  if (editor === "lifecycle") {
    inspectLifecycle();
    await screen.findByTestId("material-lifecycle-detail");
    confirmLifecycle();
  } else {
    inspectVisibility();
    await screen.findByTestId("material-visibility-detail");
    confirmVisibility();
  }
  const other = editor === "lifecycle" ? "Visibility" : "Lifecycle";
  act(() => {
    if (editor === "lifecycle") submitLifecycle();
    else submitVisibility();
    selectManagementTab(other);
    fireEvent.click(screen.getByRole("button", { name: labels.managementManage }));
  });
  expect(screen.getByRole("tab", { name: other, exact: true })).toHaveProperty("disabled", true);
  expect(
    screen.queryByTestId(`material-${editor === "lifecycle" ? "visibility" : "lifecycle"}`),
  ).toBeNull();
  await act(async () => pending.resolve());
  const notice =
    editor === "lifecycle"
      ? labels.lifecycleNotice.uncertain
      : labels.visibilityNotice.uncertain;
  await screen.findByText(notice);
  selectManagementTab(other);
  fireEvent.click(screen.getByRole("button", { name: labels.managementRefresh }));
  await screen.findByRole("table", { name: labels.managementTitle });
  expect(screen.getByRole("button", { name: labels.managementManage })).toHaveProperty(
    "disabled",
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: labels.managementManage }));
  if (editor === "lifecycle") inspectLifecycle();
  else inspectVisibility();
  await screen.findByText(
    editor === "lifecycle" ? labels.lifecycleNotice.rechecked : labels.visibilityNotice.rechecked,
  );
  expect(screen.getByRole("tab", { name: other, exact: true })).toHaveProperty("disabled", false);
  selectManagementTab(other);
  expect(screen.queryByTestId(`material-${editor}`)).toBeNull();
  expect(materials.getSpackMaterial).not.toHaveBeenCalled();
});

test("a late lifecycle read after tab switching cannot unlock a visibility write", async () => {
  const old = deferred<SpackMaterialLifecycleView>();
  const write = deferred<SpackMaterialVisibilityView>();
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockReturnValueOnce(old.promise);
  vi.mocked(visibility.changeSpackMaterialVisibility).mockReturnValueOnce(write.promise);
  mount();
  await selectBinding();
  inspectLifecycle();
  const signal = vi.mocked(lifecycle.getSpackMaterialLifecycle).mock.calls[0]?.[1];
  selectManagementTab("Visibility");
  expect(signal?.aborted).toBe(true);
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility();
  submitVisibility();
  await act(async () => old.resolve(lifecycleFixture().view));
  expect(screen.getByRole("tab", { name: "Lifecycle", exact: true })).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByRole("button", { name: labels.managementManage })).toHaveProperty(
    "disabled",
    true,
  );
  await act(async () => write.resolve(f.atRevision(1)));
  await screen.findByText(labels.visibilityNotice.changed);
});

test("visibility success invalidates normal details and management rows, retaining the filter", async () => {
  mount();
  findRelease(f.binding);
  await screen.findByTestId("material-release-detail");
  await readyVisibility();
  confirmVisibility();
  submitVisibility();
  await screen.findByText(labels.visibilityNotice.changed);
  expect(screen.queryByTestId("material-release-detail")).toBeNull();
  expect(screen.queryByRole("table", { name: labels.managementTitle })).toBeNull();
  expect(screen.getByLabelText(labels.managementRepository)).toHaveProperty(
    "value",
    f.view.repository,
  );
  expect(management.listSpackMaterialManagement).toHaveBeenCalledOnce();
  expect(materials.listSpackMaterials).toHaveBeenCalledTimes(2);
});

test("mobile permits visibility inspection, not policy writes", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  mount();
  await readyVisibility();
  expect(visibilityUi().getByRole("button", { name: labels.visibilitySave })).toHaveProperty(
    "disabled",
    true,
  );
  expect(visibilityUi().getByLabelText(labels.visibilityPolicy)).toHaveProperty("disabled", true);
  expect(visibility.changeSpackMaterialVisibility).not.toHaveBeenCalled();
});
