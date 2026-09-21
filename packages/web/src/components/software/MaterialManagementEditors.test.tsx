import type {
  SpackMaterialLifecycleView,
  SpackMaterialVisibilityView,
} from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../../lib/i18n";
import { SoftwareError } from "../../lib/software-client";
import * as lifecycle from "../../lib/spack-material-lifecycle-client";
import * as visibility from "../../lib/spack-material-visibility-client";
import {
  confirmLifecycle,
  inspectLifecycle,
  labels,
  lifecycleFixture,
  lifecycleUi,
  submitLifecycle,
} from "./MaterialLifecycle.test-helpers";
import { MaterialManagementEditors } from "./MaterialManagementEditors";
import {
  confirmVisibility,
  inspectVisibility,
  selectManagementTab,
  submitVisibility,
  visibilityFixture,
} from "./MaterialVisibility.test-helpers";
import { deferred, translation } from "./SpackMaterials.test-helpers";

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

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValue(lifecycleFixture().view);
  vi.mocked(visibility.getSpackMaterialVisibility).mockResolvedValue(visibilityFixture().view);
  vi.mocked(visibility.changeSpackMaterialVisibility).mockResolvedValue(
    visibilityFixture().atRevision(1),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(isCurrent = () => true) {
  const onSelectionLockChange = vi.fn();
  const onInvalidate = vi.fn();
  const view = render(
    <MaterialManagementEditors
      initialBinding={visibilityFixture().binding}
      isCurrent={isCurrent}
      canWriteRepository={() => true}
      canInspectRepository={() => true}
      onInvalidate={onInvalidate}
      onSelectionLockChange={onSelectionLockChange}
    />,
  );
  return { ...view, onSelectionLockChange, onInvalidate };
}

test("tab switching mounts exactly one editor and never automatically queries either endpoint", () => {
  mount();
  expect(screen.getByTestId("material-lifecycle")).toBeTruthy();
  expect(screen.queryByTestId("material-visibility")).toBeNull();
  selectManagementTab("Visibility");
  expect(screen.getByTestId("material-visibility")).toBeTruthy();
  expect(screen.queryByTestId("material-lifecycle")).toBeNull();
  selectManagementTab("Lifecycle");
  expect(screen.getByTestId("material-lifecycle")).toBeTruthy();
  expect(visibility.getSpackMaterialVisibility).not.toHaveBeenCalled();
  expect(lifecycle.getSpackMaterialLifecycle).not.toHaveBeenCalled();
});

test("the current-session guard rejects tab changes before rerender", () => {
  let current = true;
  mount(() => current);
  current = false;
  selectManagementTab("Visibility");
  expect(screen.queryByTestId("material-visibility")).toBeNull();
});

test("pending and unknown policy writes retain the shared lock", async () => {
  const pending = deferred<SpackMaterialVisibilityView>();
  vi.mocked(visibility.changeSpackMaterialVisibility).mockImplementationOnce(async () => {
    await pending.promise;
    throw new SoftwareError(503, "MATERIAL_VISIBILITY_UNAVAILABLE", "Receipt lost");
  });
  const { onSelectionLockChange } = mount();
  selectManagementTab("Visibility");
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility();
  act(() => {
    submitVisibility();
    selectManagementTab("Lifecycle");
  });
  expect(screen.queryByTestId("material-lifecycle")).toBeNull();
  expect(onSelectionLockChange).toHaveBeenLastCalledWith(true);
  await act(async () => pending.resolve(visibilityFixture().atRevision(1)));
  await screen.findByText(labels.visibilityNotice.uncertain);
  const lifecycleTab = screen.getByRole("tab", { name: labels.lifecycleTab });
  expect(lifecycleTab).toHaveProperty("disabled", true);
  fireEvent.keyDown(lifecycleTab, { key: "Enter" });
  expect(screen.queryByTestId("material-lifecycle")).toBeNull();
  expect(lifecycle.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  expect(visibility.changeSpackMaterialVisibility).toHaveBeenCalledOnce();
});

test.each([
  "503",
  "stop",
  "timeout",
])("%s lifecycle outcome keeps binding and mode locked until same-binding GET", async (outcome) => {
  const f = lifecycleFixture();
  const pending = deferred<SpackMaterialLifecycleView>();
  vi.mocked(lifecycle.changeSpackMaterialLifecycle).mockImplementationOnce(async () => {
    const receipt = await pending.promise;
    if (outcome === "503") {
      throw new SoftwareError(503, "MATERIAL_LIFECYCLE_UNAVAILABLE", "Receipt lost");
    }
    return receipt;
  });
  const { onSelectionLockChange } = mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  if (outcome === "timeout") vi.useFakeTimers();
  act(() => {
    submitLifecycle();
    selectManagementTab("Visibility");
  });
  const signal = vi.mocked(lifecycle.changeSpackMaterialLifecycle).mock.calls[0]?.[2];
  const repository = lifecycleUi().getByLabelText(labels.lifecycleRepositoryId);
  const digest = lifecycleUi().getByLabelText(labels.lifecycleManifestDigest);
  expect(repository).toHaveProperty("disabled", true);
  expect(digest).toHaveProperty("disabled", true);
  expect(screen.queryByTestId("material-visibility")).toBeNull();
  if (outcome === "503") {
    await act(async () => pending.resolve(f.atRevision(1)));
  } else if (outcome === "stop") {
    fireEvent.click(lifecycleUi().getByRole("button", { name: labels.lifecycleStop }));
  } else {
    act(() => vi.advanceTimersByTime(30_000));
    vi.useRealTimers();
  }
  expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
  expect(repository).toHaveProperty("disabled", true);
  expect(digest).toHaveProperty("disabled", true);
  fireEvent.change(repository, { target: { value: "a".repeat(64) } });
  fireEvent.change(digest, { target: { value: `sha256:${"b".repeat(64)}` } });
  expect(repository).toHaveProperty("value", f.binding.repositoryId);
  expect(digest).toHaveProperty("value", f.binding.manifestDigest);
  selectManagementTab("Visibility");
  expect(screen.getByRole("tab", { name: labels.visibilityTab })).toHaveProperty("disabled", true);
  expect(screen.queryByTestId("material-visibility")).toBeNull();
  expect(onSelectionLockChange).toHaveBeenLastCalledWith(true);
  if (outcome !== "503") {
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(f.atRevision(1)));
    expect(onSelectionLockChange).toHaveBeenLastCalledWith(true);
    expect(screen.queryByTestId("material-lifecycle-detail")).toBeNull();
  }
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockRejectedValueOnce(
    new SoftwareError(503, "MATERIAL_LIFECYCLE_UNAVAILABLE", "Still unavailable"),
  );
  await act(async () => inspectLifecycle());
  expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
  expect(onSelectionLockChange).toHaveBeenLastCalledWith(true);
  vi.mocked(lifecycle.getSpackMaterialLifecycle).mockResolvedValueOnce(f.atRevision(1));
  inspectLifecycle();
  await screen.findByText(labels.lifecycleNotice.rechecked);
  expect(lifecycle.getSpackMaterialLifecycle).toHaveBeenLastCalledWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(onSelectionLockChange).toHaveBeenLastCalledWith(false);
  expect(repository).toHaveProperty("disabled", false);
  expect(digest).toHaveProperty("disabled", false);
  selectManagementTab("Visibility");
  expect(screen.getByTestId("material-visibility")).toBeTruthy();
  expect(visibility.getSpackMaterialVisibility).not.toHaveBeenCalled();
  expect(lifecycle.changeSpackMaterialLifecycle).toHaveBeenCalledOnce();
});

test("leaving a read aborts it; its late rejection cannot alter the replacement editor", async () => {
  const old = deferred<void>();
  vi.mocked(visibility.getSpackMaterialVisibility).mockImplementationOnce(async () => {
    await old.promise;
    throw new SoftwareError(503, "MATERIAL_VISIBILITY_UNAVAILABLE", "Late failure");
  });
  const { onSelectionLockChange } = mount();
  selectManagementTab("Visibility");
  inspectVisibility();
  const signal = vi.mocked(visibility.getSpackMaterialVisibility).mock.calls[0]?.[1];
  selectManagementTab("Lifecycle");
  expect(signal?.aborted).toBe(true);
  await act(async () => old.resolve());
  expect(screen.queryByRole("alert")).toBeNull();
  expect(onSelectionLockChange).not.toHaveBeenCalled();
  expect(screen.getByTestId("material-lifecycle")).toBeTruthy();
});
