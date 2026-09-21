import type { SpackMaterialLifecycleView } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../../lib/i18n";
import { SoftwareError } from "../../lib/software-client";
import * as client from "../../lib/spack-material-lifecycle-client";
import { MaterialLifecycle } from "./MaterialLifecycle";
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
import { deferred, translation } from "./SpackMaterials.test-helpers";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => translation,
}));
vi.mock("../../lib/spack-material-lifecycle-client", () => ({
  getSpackMaterialLifecycle: vi.fn(),
  changeSpackMaterialLifecycle: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  const f = lifecycleFixture();
  vi.mocked(client.getSpackMaterialLifecycle).mockResolvedValue(f.view);
  vi.mocked(client.changeSpackMaterialLifecycle).mockResolvedValue(
    f.atRevision(1, WITHDRAW_REASON),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(overrides: Partial<ComponentProps<typeof MaterialLifecycle>> = {}) {
  const onInvalidate = vi.fn();
  const view = render(
    <StrictMode>
      <MaterialLifecycle
        initialBinding={lifecycleFixture().binding}
        isCurrent={() => true}
        canWriteRepository={() => true}
        onInvalidate={onInvalidate}
        {...overrides}
      />
    </StrictMode>,
  );
  return { ...view, onInvalidate };
}

function expectNoView() {
  expect(screen.queryByTestId("material-lifecycle-detail")).toBeNull();
  expect(screen.queryByLabelText(labels.lifecycleReason)).toBeNull();
  expect(screen.queryByRole("table", { name: labels.lifecycleHistory })).toBeNull();
}

test("requires an explicit exact-binding GET before showing state or allowing a change", async () => {
  const f = lifecycleFixture();
  mount();
  expect(client.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  expectNoView();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(lifecycleUi().getByText(f.view.repository)).toBeTruthy();
  expect(lifecycleUi().getByText(labels.lifecycleState.available)).toBeTruthy();
  expect(lifecycleUi().getByText(labels.lifecycleHistoryEmpty)).toBeTruthy();
  expect(
    lifecycleUi().getByRole("button", { name: labels.lifecycleAction.withdraw }),
  ).toHaveProperty("disabled", true);
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
});

test.each([
  { repositoryId: "org/org-a/materials" },
  { repositoryId: "a".repeat(63) },
  { manifestDigest: "latest" },
])("rejects a non-exact locator before GET: %j", (patch) => {
  mount({ initialBinding: { ...lifecycleFixture().binding, ...patch } });
  expect(lifecycleUi().getByRole("button", { name: labels.lifecycleInspect })).toHaveProperty(
    "disabled",
    true,
  );
  inspectLifecycle();
  expect(client.getSpackMaterialLifecycle).not.toHaveBeenCalled();
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
});

test.each([
  "",
  " ",
  " leading",
  "trailing ",
  "line\nbreak",
  "tab\tbreak",
  "x".repeat(1001),
])("requires a valid audit reason even with confirmation: %j", async (reason) => {
  mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle(reason);
  expect(lifecycleUi().getByLabelText(labels.lifecycleReason, { exact: true })).toHaveProperty(
    "value",
    reason,
  );
  expect(
    lifecycleUi().getByRole("button", { name: labels.lifecycleAction.withdraw }),
  ).toHaveProperty("disabled", true);
  submitLifecycle();
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
});

test("withdraws and restores with exact revisions and fresh confirmation", async () => {
  const f = lifecycleFixture();
  const { onInvalidate } = mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle("First reason");
  expect(lifecycleUi().getByRole("checkbox")).toHaveProperty("checked", true);
  fireEvent.change(lifecycleUi().getByLabelText(labels.lifecycleReason), {
    target: { value: WITHDRAW_REASON },
  });
  expect(lifecycleUi().getByRole("checkbox")).toHaveProperty("checked", false);
  submitLifecycle();
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  fireEvent.click(lifecycleUi().getByRole("checkbox", { name: labels.lifecycleConfirm.withdraw }));
  submitLifecycle();

  await screen.findByText(labels.lifecycleNotice.changed);
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    { action: "withdraw", expectedRevision: 0, reason: WITHDRAW_REASON },
    expect.any(AbortSignal),
  );
  expect(lifecycleUi().getByLabelText(labels.lifecycleReason)).toHaveProperty("value", "");
  expect(
    lifecycleUi().getByRole("checkbox", { name: labels.lifecycleConfirm.restore }),
  ).toHaveProperty("checked", false);
  expect(
    lifecycleUi().getByRole("button", { name: labels.lifecycleAction.restore }),
  ).toHaveProperty("disabled", true);
  expect(onInvalidate).toHaveBeenCalledTimes(1);

  vi.mocked(client.changeSpackMaterialLifecycle).mockResolvedValueOnce(
    f.atRevision(2, RESTORE_REASON),
  );
  confirmLifecycle(RESTORE_REASON);
  submitLifecycle("restore");
  await screen.findByRole("button", { name: labels.lifecycleAction.withdraw });
  expect(client.changeSpackMaterialLifecycle).toHaveBeenNthCalledWith(
    2,
    f.binding,
    { action: "restore", expectedRevision: 1, reason: RESTORE_REASON },
    expect.any(AbortSignal),
  );
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(2);
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(onInvalidate).toHaveBeenCalledTimes(2);
});

test("StrictMode and two synchronous form submissions produce only one POST", async () => {
  const f = lifecycleFixture();
  const pending = deferred<SpackMaterialLifecycleView>();
  vi.mocked(client.changeSpackMaterialLifecycle).mockReturnValueOnce(pending.promise);
  mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  const form = lifecycleUi()
    .getByRole("button", { name: labels.lifecycleAction.withdraw })
    .closest("form");
  if (!form) throw new Error("Missing lifecycle change form");
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(lifecycleUi().getByLabelText(labels.lifecycleRepositoryId)).toHaveProperty(
    "disabled",
    true,
  );
  expect(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest)).toHaveProperty(
    "disabled",
    true,
  );
  expect(lifecycleUi().getByRole("button", { name: labels.lifecycleInspect })).toHaveProperty(
    "disabled",
    true,
  );
  inspectLifecycle();
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(f.atRevision(1, WITHDRAW_REASON)));
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
});

test.each([
  { code: "MATERIAL_LIFECYCLE_CONFLICT", notice: labels.lifecycleNotice.conflict },
  { code: "MATERIAL_RELEASE_REFERENCED", notice: labels.lifecycleNotice.referenced },
])("$code clears the view and requires a completed GET and fresh confirmation", async ({
  code,
  notice,
}) => {
  const f = lifecycleFixture();
  const recheck = deferred<SpackMaterialLifecycleView>();
  vi.mocked(client.changeSpackMaterialLifecycle).mockRejectedValueOnce(
    new SoftwareError(409, code, "Private backend diagnostic"),
  );
  const { onInvalidate } = mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  submitLifecycle();
  expect((await screen.findByRole("alert")).textContent).toBe(notice);
  expect(screen.queryByText("Private backend diagnostic")).toBeNull();
  expectNoView();
  expect(onInvalidate).not.toHaveBeenCalled();
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);

  vi.mocked(client.getSpackMaterialLifecycle).mockReturnValueOnce(recheck.promise);
  inspectLifecycle();
  expectNoView();
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  await act(async () => recheck.resolve(f.atRevision(2)));
  expect(lifecycleUi().getByLabelText(labels.lifecycleReason)).toHaveProperty("value", "");
  expect(lifecycleUi().getByRole("checkbox")).toHaveProperty("checked", false);
  submitLifecycle();
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  vi.mocked(client.changeSpackMaterialLifecycle).mockResolvedValueOnce(
    f.atRevision(3, WITHDRAW_REASON),
  );
  confirmLifecycle();
  submitLifecycle();
  await screen.findByText(labels.lifecycleNotice.changed);
  expect(client.changeSpackMaterialLifecycle).toHaveBeenLastCalledWith(
    f.binding,
    { action: "withdraw", expectedRevision: 2, reason: WITHDRAW_REASON },
    expect.any(AbortSignal),
  );
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(2);
});

test.each([
  new SoftwareError(503, "MATERIAL_LIFECYCLE_UNAVAILABLE", "Unavailable"),
  new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Invalid receipt"),
  new SoftwareError(401, "REGISTRY_INVALID_RESPONSE", "Invalid authentication response"),
  new SoftwareError(403, "REGISTRY_INVALID_RESPONSE", "Invalid permission response"),
  new TypeError("Connection lost"),
])("uncertain POST requires GET without automatic retries: %s", async (error) => {
  const f = lifecycleFixture();
  vi.mocked(client.changeSpackMaterialLifecycle).mockRejectedValueOnce(error);
  const { onInvalidate } = mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  submitLifecycle();
  expect((await screen.findByRole("alert")).textContent).toBe(labels.lifecycleNotice.uncertain);
  expectNoView();
  expect(onInvalidate).toHaveBeenCalledTimes(1);
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);

  vi.mocked(client.getSpackMaterialLifecycle).mockRejectedValueOnce(
    new SoftwareError(503, "MATERIAL_LIFECYCLE_UNAVAILABLE", "Still unavailable"),
  );
  inspectLifecycle();
  await waitFor(() =>
    expect(lifecycleUi().getByRole("button", { name: labels.lifecycleInspect })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
  expectNoView();
  vi.mocked(client.getSpackMaterialLifecycle).mockResolvedValueOnce(
    f.atRevision(1, WITHDRAW_REASON),
  );
  inspectLifecycle();
  await screen.findByText(labels.lifecycleNotice.rechecked);
  expect(lifecycleUi().getByRole("checkbox")).toHaveProperty("checked", false);
  expect(
    lifecycleUi().getByRole("button", { name: labels.lifecycleAction.restore }),
  ).toHaveProperty("disabled", true);
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(3);
  expect(onInvalidate).toHaveBeenCalledTimes(1);
});

test.each(["stop", "timeout"])("%s preserves uncertainty after a late receipt", async (end) => {
  const f = lifecycleFixture();
  const pending = deferred<SpackMaterialLifecycleView>();
  vi.mocked(client.changeSpackMaterialLifecycle).mockReturnValueOnce(pending.promise);
  const { onInvalidate } = mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  if (end === "timeout") vi.useFakeTimers();
  submitLifecycle();
  const signal = vi.mocked(client.changeSpackMaterialLifecycle).mock.calls[0]?.[2];
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
  if (end === "stop") {
    fireEvent.click(lifecycleUi().getByRole("button", { name: labels.lifecycleStop }));
  } else {
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
  }
  expect(signal?.aborted).toBe(true);
  expectNoView();
  expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
  expect(onInvalidate).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve(f.atRevision(1, WITHDRAW_REASON)));
  expectNoView();
  expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.uncertain);
  expect(onInvalidate).toHaveBeenCalledTimes(1);
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
});

test.each(["stop", "edit", "timeout"])("%s aborts reads and ignores late state", async (end) => {
  const f = lifecycleFixture();
  const pending = deferred<SpackMaterialLifecycleView>();
  vi.mocked(client.getSpackMaterialLifecycle).mockReturnValueOnce(pending.promise);
  const { onInvalidate } = mount();
  if (end === "timeout") vi.useFakeTimers();
  inspectLifecycle();
  const signal = vi.mocked(client.getSpackMaterialLifecycle).mock.calls[0]?.[1];
  expect(signal).toBeInstanceOf(AbortSignal);
  expect(signal?.aborted).toBe(false);
  if (end === "stop") {
    fireEvent.click(lifecycleUi().getByRole("button", { name: labels.lifecycleStop }));
  }
  if (end === "edit") {
    fireEvent.change(lifecycleUi().getByLabelText(labels.lifecycleManifestDigest), {
      target: { value: `sha256:${"2".repeat(64)}` },
    });
  }
  if (end === "timeout") await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(f.atRevision(1)));
  expectNoView();
  if (end === "edit") {
    expect(lifecycleUi().queryByRole("alert")).toBeNull();
  } else {
    expect(lifecycleUi().getByRole("alert").textContent).toBe(labels.lifecycleNotice.unavailable);
  }
  expect(onInvalidate).not.toHaveBeenCalled();
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
});

test.each([
  { status: 401, code: "UNAUTHORIZED", notice: labels.lifecycleNotice.forbidden },
  { status: 401, code: "INVALID_TOKEN", notice: labels.lifecycleNotice.forbidden },
  { status: 403, code: "MATERIAL_LIFECYCLE_FORBIDDEN", notice: labels.lifecycleNotice.forbidden },
  {
    status: 503,
    code: "MATERIAL_LIFECYCLE_UNAVAILABLE",
    notice: labels.lifecycleNotice.unavailable,
  },
  { status: 502, code: "REGISTRY_INVALID_RESPONSE", notice: labels.lifecycleNotice.unavailable },
])("GET $code never exposes prior state or enables writes", async ({ status, code, notice }) => {
  const { onInvalidate } = mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  vi.mocked(client.getSpackMaterialLifecycle).mockRejectedValueOnce(
    new SoftwareError(status, code, "Private service diagnostic"),
  );
  inspectLifecycle();
  expect((await screen.findByRole("alert")).textContent).toBe(notice);
  expectNoView();
  expect(screen.queryByText("Private service diagnostic")).toBeNull();
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(2);
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
  expect(onInvalidate).not.toHaveBeenCalled();
});

test.each([
  { status: 401, code: "UNAUTHORIZED" },
  { status: 401, code: "INVALID_TOKEN" },
  { status: 403, code: "FORBIDDEN" },
  { status: 403, code: "MATERIAL_LIFECYCLE_FORBIDDEN" },
])("POST $code is a definitive auth rejection without retry or uncertainty", async ({
  status,
  code,
}) => {
  vi.mocked(client.changeSpackMaterialLifecycle).mockRejectedValueOnce(
    new SoftwareError(status, code, "Private auth diagnostic"),
  );
  const { onInvalidate } = mount();
  inspectLifecycle();
  await screen.findByTestId("material-lifecycle-detail");
  confirmLifecycle();
  submitLifecycle();
  expect((await screen.findByRole("alert")).textContent).toBe(labels.lifecycleNotice.forbidden);
  expect(screen.queryByText(labels.lifecycleNotice.uncertain)).toBeNull();
  expect(screen.queryByText("Private auth diagnostic")).toBeNull();
  expectNoView();
  expect(onInvalidate).not.toHaveBeenCalled();
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(client.changeSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
});

test("read-only access shows history but cannot submit a confirmed reason", async () => {
  const f = lifecycleFixture();
  vi.mocked(client.getSpackMaterialLifecycle).mockResolvedValueOnce(f.atRevision(1));
  mount({ canInspectRepository: () => true, canWriteRepository: () => false });
  inspectLifecycle();
  await screen.findByRole("table", { name: labels.lifecycleHistory });
  confirmLifecycle(RESTORE_REASON);
  expect(
    lifecycleUi().getByRole("button", { name: labels.lifecycleAction.restore }),
  ).toHaveProperty("disabled", true);
  submitLifecycle("restore");
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
});

test.each([21, 101])("pages %i-revision history locally with fixed bounds", async (revision) => {
  const f = lifecycleFixture();
  vi.mocked(client.getSpackMaterialLifecycle).mockResolvedValueOnce(f.atRevision(revision));
  mount();
  inspectLifecycle();
  const table = within(await screen.findByRole("table", { name: labels.lifecycleHistory }));
  const previous = lifecycleUi().getByRole("button", { name: labels.lifecyclePrevious });
  const next = lifecycleUi().getByRole("button", { name: labels.lifecycleNext });
  expect(table.getAllByRole("row")).toHaveLength(11);
  expect(table.getByText(`Audit revision ${revision}`)).toBeTruthy();
  expect(table.queryByText(`Audit revision ${revision - 10}`)).toBeNull();
  expect(previous).toHaveProperty("disabled", true);
  fireEvent.click(previous);
  fireEvent.click(next);
  expect(table.getByText(`Audit revision ${revision - 10}`)).toBeTruthy();
  expect(table.queryByText(`Audit revision ${revision}`)).toBeNull();
  const count = Math.min(revision, 100);
  const pages = Math.ceil(count / 10);
  for (let page = 2; page < pages; page++) fireEvent.click(next);
  expect(lifecycleUi().getByText(`${pages} / ${pages}`)).toBeTruthy();
  expect(table.getAllByRole("row")).toHaveLength(((count - 1) % 10) + 2);
  expect(table.getByText(`Audit revision ${revision - count + 1}`)).toBeTruthy();
  expect(next).toHaveProperty("disabled", true);
  fireEvent.click(next);
  expect(lifecycleUi().getByText(`${pages} / ${pages}`)).toBeTruthy();
  fireEvent.click(previous);
  expect(lifecycleUi().getByText(`${pages - 1} / ${pages}`)).toBeTruthy();
  expect(lifecycleUi().queryByText(labels.lifecycleHistoryTruncated) !== null).toBe(revision > 100);
  expect(client.getSpackMaterialLifecycle).toHaveBeenCalledTimes(1);
  expect(client.changeSpackMaterialLifecycle).not.toHaveBeenCalled();
});
