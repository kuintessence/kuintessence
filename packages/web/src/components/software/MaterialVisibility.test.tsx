import type { SpackMaterialVisibilityView } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type ComponentProps, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../../lib/i18n";
import { SoftwareError } from "../../lib/software-client";
import * as client from "../../lib/spack-material-visibility-client";
import { labels } from "./MaterialLifecycle.test-helpers";
import { MaterialVisibility } from "./MaterialVisibility";
import {
  allowlist,
  confirmVisibility,
  inspectVisibility,
  submitVisibility,
  USER_ID,
  VISIBILITY_REASON,
  visibilityFixture,
  visibilityUi,
} from "./MaterialVisibility.test-helpers";
import { deferred, translation } from "./SpackMaterials.test-helpers";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => translation,
}));
vi.mock("../../lib/spack-material-visibility-client", () => ({
  getSpackMaterialVisibility: vi.fn(),
  changeSpackMaterialVisibility: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  const f = visibilityFixture();
  vi.mocked(client.getSpackMaterialVisibility).mockResolvedValue(f.view);
  vi.mocked(client.changeSpackMaterialVisibility).mockResolvedValue(f.atRevision(1));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(overrides: Partial<ComponentProps<typeof MaterialVisibility>> = {}) {
  const props = {
    initialBinding: visibilityFixture().binding,
    isCurrent: vi.fn(() => true),
    canWriteRepository: vi.fn(() => true),
    canInspectRepository: vi.fn(() => true),
    onInvalidate: vi.fn(),
    onSelectionLockChange: vi.fn(),
    ...overrides,
  };
  const view = render(
    <StrictMode>
      <MaterialVisibility {...props} />
    </StrictMode>,
  );
  return { ...view, props };
}

test("requires explicit GET, policy change, valid reason and confirmation", async () => {
  const f = visibilityFixture();
  mount();
  expect(client.getSpackMaterialVisibility).not.toHaveBeenCalled();
  expect(screen.queryByTestId("material-visibility-detail")).toBeNull();
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  expect(client.getSpackMaterialVisibility).toHaveBeenCalledExactlyOnceWith(
    f.binding,
    expect.any(AbortSignal),
  );
  confirmVisibility({ mode: "inherit" });
  submitVisibility();
  expect(client.changeSpackMaterialVisibility).not.toHaveBeenCalled();
  confirmVisibility();
  expect(visibilityUi().getByRole("button", { name: labels.visibilitySave })).toHaveProperty(
    "disabled",
    false,
  );
  fireEvent.change(visibilityUi().getByLabelText(labels.visibilityReason), {
    target: { value: " leading" },
  });
  expect(visibilityUi().getByRole("checkbox")).toHaveProperty("checked", false);
  fireEvent.click(visibilityUi().getByRole("checkbox"));
  submitVisibility();
  expect(client.changeSpackMaterialVisibility).not.toHaveBeenCalled();
});

test("saves deny-all and inherit using fresh revisions without ordinary manifest requests", async () => {
  const f = visibilityFixture();
  const denied = { mode: "allowlist" as const, userIds: [], orgIds: [] };
  vi.mocked(client.changeSpackMaterialVisibility)
    .mockResolvedValueOnce(f.atRevision(1, denied))
    .mockResolvedValueOnce(f.atRevision(2));
  const { props } = mount();
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility(denied);
  expect(visibilityUi().getByText(labels.visibilityDenyAll)).toBeTruthy();
  submitVisibility();
  await screen.findByText(labels.visibilityNotice.changed);
  expect(client.changeSpackMaterialVisibility).toHaveBeenNthCalledWith(
    1,
    f.binding,
    { policy: denied, expectedRevision: 0, reason: VISIBILITY_REASON },
    expect.any(AbortSignal),
  );
  expect(visibilityUi().getByLabelText(labels.visibilityReason)).toHaveProperty("value", "");
  expect(visibilityUi().getByRole("checkbox")).toHaveProperty("checked", false);
  confirmVisibility({ mode: "inherit" });
  submitVisibility();
  await waitFor(() => expect(props.onInvalidate).toHaveBeenCalledTimes(2));
  expect(client.changeSpackMaterialVisibility).toHaveBeenNthCalledWith(
    2,
    f.binding,
    { policy: { mode: "inherit" }, expectedRevision: 1, reason: VISIBILITY_REASON },
    expect.any(AbortSignal),
  );
});

test.each([
  "not-a-uuid",
  USER_ID.toUpperCase(),
  `${USER_ID}\n${USER_ID}`,
  Array.from(
    { length: 101 },
    (_, i) => `${i.toString(16).padStart(8, "0")}-1111-1111-1111-111111111111`,
  ).join("\n"),
])("invalid user list cannot be submitted: %s", async (value) => {
  mount();
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility();
  fireEvent.change(visibilityUi().getByLabelText(labels.visibilityPrincipals.userIds), {
    target: { value },
  });
  fireEvent.click(visibilityUi().getByRole("checkbox"));
  submitVisibility();
  expect(visibilityUi().getByText(labels.visibilityInvalidPolicy)).toBeTruthy();
  expect(client.changeSpackMaterialVisibility).not.toHaveBeenCalled();
});

test.each([
  { status: 409, code: "MATERIAL_VISIBILITY_CONFLICT", notice: labels.visibilityNotice.conflict },
  { status: 422, code: "MATERIAL_VISIBILITY_INVALID", notice: labels.visibilityNotice.invalid },
  { status: 403, code: "MATERIAL_VISIBILITY_FORBIDDEN", notice: labels.visibilityNotice.forbidden },
])("$code requires GET and fresh confirmation", async ({ status, code, notice }) => {
  const f = visibilityFixture();
  vi.mocked(client.changeSpackMaterialVisibility).mockRejectedValueOnce(
    new SoftwareError(status, code, "Private backend detail"),
  );
  const { props } = mount();
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility();
  submitVisibility();
  expect((await visibilityUi().findByRole("alert")).textContent).toBe(notice);
  expect(screen.queryByTestId("material-visibility-detail")).toBeNull();
  expect(props.onInvalidate).not.toHaveBeenCalled();
  expect(props.onSelectionLockChange).toHaveBeenLastCalledWith(false);
  vi.mocked(client.getSpackMaterialVisibility).mockResolvedValueOnce(f.atRevision(2));
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  submitVisibility();
  expect(client.changeSpackMaterialVisibility).toHaveBeenCalledTimes(1);
  confirmVisibility();
  submitVisibility();
  await waitFor(() => expect(client.changeSpackMaterialVisibility).toHaveBeenCalledTimes(2));
  expect(client.changeSpackMaterialVisibility).toHaveBeenLastCalledWith(
    f.binding,
    { policy: allowlist, expectedRevision: 2, reason: VISIBILITY_REASON },
    expect.any(AbortSignal),
  );
});

test.each([
  new SoftwareError(503, "MATERIAL_VISIBILITY_UNAVAILABLE", "Not policy-ready"),
  new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Invalid receipt"),
  new SoftwareError(403, "REGISTRY_INVALID_RESPONSE", "Invalid auth receipt"),
  new TypeError("Disconnected"),
])("unknown POST retains binding and selection lock until verified GET: %s", async (error) => {
  const f = visibilityFixture();
  vi.mocked(client.changeSpackMaterialVisibility).mockRejectedValueOnce(error);
  const { props } = mount();
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility();
  submitVisibility();
  expect((await visibilityUi().findByRole("alert")).textContent).toBe(
    labels.visibilityNotice.uncertain,
  );
  expect(props.onInvalidate).toHaveBeenCalledOnce();
  expect(props.onSelectionLockChange).toHaveBeenLastCalledWith(true);
  expect(screen.queryByTestId("material-visibility-detail")).toBeNull();
  const locator = visibilityUi().getByLabelText(labels.visibilityManifestDigest);
  expect(locator).toHaveProperty("disabled", true);
  fireEvent.change(locator, { target: { value: `sha256:${"9".repeat(64)}` } });
  expect(locator).toHaveProperty("value", f.binding.manifestDigest);
  vi.mocked(client.getSpackMaterialVisibility).mockRejectedValueOnce(
    new SoftwareError(503, "MATERIAL_VISIBILITY_UNAVAILABLE", "Not ready"),
  );
  inspectVisibility();
  await waitFor(() =>
    expect(visibilityUi().getByRole("button", { name: labels.visibilityInspect })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  expect(props.onSelectionLockChange).toHaveBeenLastCalledWith(true);
  vi.mocked(client.getSpackMaterialVisibility).mockResolvedValueOnce(f.atRevision(1));
  inspectVisibility();
  await screen.findByText(labels.visibilityNotice.rechecked);
  expect(props.onSelectionLockChange).toHaveBeenLastCalledWith(false);
  expect(visibilityUi().getByRole("checkbox")).toHaveProperty("checked", false);
  expect(client.changeSpackMaterialVisibility).toHaveBeenCalledTimes(1);
});

test.each(["stop", "timeout"])("%s aborts writes and discards late receipts", async (end) => {
  const pending = deferred<SpackMaterialVisibilityView>();
  vi.mocked(client.changeSpackMaterialVisibility).mockReturnValueOnce(pending.promise);
  const { props } = mount();
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility();
  if (end === "timeout") vi.useFakeTimers();
  submitVisibility();
  const signal = vi.mocked(client.changeSpackMaterialVisibility).mock.calls[0]?.[2];
  if (end === "stop") {
    fireEvent.click(visibilityUi().getByRole("button", { name: labels.visibilityStop }));
  } else {
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
  }
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(visibilityFixture().atRevision(1)));
  expect(visibilityUi().getByRole("alert").textContent).toBe(labels.visibilityNotice.uncertain);
  expect(props.onSelectionLockChange).toHaveBeenLastCalledWith(true);
  expect(props.onInvalidate).toHaveBeenCalledOnce();
  expect(client.changeSpackMaterialVisibility).toHaveBeenCalledOnce();
});

test.each([
  "edit",
  "unmount",
  "session",
  "permission",
])("%s discards a late read", async (change) => {
  const pending = deferred<SpackMaterialVisibilityView>();
  vi.mocked(client.getSpackMaterialVisibility).mockReturnValueOnce(pending.promise);
  let current = true;
  let permitted = true;
  const view = mount({ isCurrent: () => current, canInspectRepository: () => permitted });
  inspectVisibility();
  const signal = vi.mocked(client.getSpackMaterialVisibility).mock.calls[0]?.[1];
  if (change === "edit") {
    fireEvent.change(visibilityUi().getByLabelText(labels.visibilityManifestDigest), {
      target: { value: "" },
    });
  }
  if (change === "unmount") view.unmount();
  if (change === "session") current = false;
  if (change === "permission") permitted = false;
  await act(async () => pending.resolve(visibilityFixture().atRevision(1)));
  expect(screen.queryByTestId("material-visibility-detail")).toBeNull();
  if (change === "edit" || change === "unmount") expect(signal?.aborted).toBe(true);
});

test("503 GET has no snapshot or write form and never auto-retries", async () => {
  vi.mocked(client.getSpackMaterialVisibility).mockRejectedValue(
    new SoftwareError(503, "MATERIAL_VISIBILITY_UNAVAILABLE", "Private rollout state"),
  );
  mount();
  inspectVisibility();
  expect((await visibilityUi().findByRole("alert")).textContent).toBe(
    labels.visibilityNotice.unavailable,
  );
  expect(screen.queryByTestId("material-visibility-detail")).toBeNull();
  expect(screen.queryByRole("button", { name: labels.visibilitySave })).toBeNull();
  expect(client.getSpackMaterialVisibility).toHaveBeenCalledOnce();
  expect(client.changeSpackMaterialVisibility).not.toHaveBeenCalled();
});

test("double synchronous submissions send one POST; read-only mode cannot submit", async () => {
  const pending = deferred<SpackMaterialVisibilityView>();
  vi.mocked(client.changeSpackMaterialVisibility).mockReturnValueOnce(pending.promise);
  const view = mount();
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  confirmVisibility();
  const form = visibilityUi().getByRole("button", { name: labels.visibilitySave }).closest("form");
  if (!form) throw new Error("Missing policy form");
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(client.changeSpackMaterialVisibility).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => pending.resolve(visibilityFixture().atRevision(1)));
  mount({ canWriteRepository: () => false });
  inspectVisibility();
  await screen.findByTestId("material-visibility-detail");
  expect(visibilityUi().getByLabelText(labels.visibilityPolicy)).toHaveProperty("disabled", true);
  submitVisibility();
  expect(client.changeSpackMaterialVisibility).toHaveBeenCalledOnce();
});

test("audit pagination retains bounded principal snapshots and truncation", async () => {
  vi.mocked(client.getSpackMaterialVisibility).mockResolvedValueOnce(
    visibilityFixture().atRevision(101),
  );
  mount();
  inspectVisibility();
  const table = within(await screen.findByRole("table", { name: labels.visibilityHistory }));
  expect(table.getAllByRole("row")).toHaveLength(11);
  expect(visibilityUi().getByText(labels.lifecycleHistoryTruncated)).toBeTruthy();
  fireEvent.click(visibilityUi().getByRole("button", { name: labels.visibilityNext }));
  expect(table.getByText("Visibility audit 91")).toBeTruthy();
  for (let index = 2; index < 10; index++) {
    fireEvent.click(visibilityUi().getByRole("button", { name: labels.visibilityNext }));
  }
  expect(visibilityUi().getByRole("button", { name: labels.visibilityNext })).toHaveProperty(
    "disabled",
    true,
  );
  expect(client.getSpackMaterialVisibility).toHaveBeenCalledOnce();
});
