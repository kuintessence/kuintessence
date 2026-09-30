import type { SpackInstallBindingView } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ComponentProps, StrictMode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import i18n from "../../lib/i18n";
import { SoftwareError } from "../../lib/software-client";
import * as client from "../../lib/spack-install-bindings-client";
import {
  BINDING_ORG,
  bindingUi,
  confirmBinding,
  INSTALL_REASON,
  INSTALL_SPEC,
  inspectBinding,
  installBinding,
  installBindingView,
  readyBinding,
  submitBinding,
} from "./SpackInstallBinding.test-helpers";
import { SpackInstallBindingEditor } from "./SpackInstallBindingEditor";
import { deferred, translation } from "./SpackMaterials.test-helpers";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => translation,
}));
vi.mock("../../lib/spack-install-bindings-client", async (importOriginal) => ({
  ...(await importOriginal<typeof client>()),
  inspectSpackInstallBinding: vi.fn(),
  changeSpackInstallBinding: vi.fn(),
}));

beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  vi.mocked(client.inspectSpackInstallBinding).mockResolvedValue(installBindingView());
  vi.mocked(client.changeSpackInstallBinding).mockResolvedValue(installBindingView(1));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(overrides: Partial<ComponentProps<typeof SpackInstallBindingEditor>> = {}) {
  const props = {
    organizationId: BINDING_ORG,
    selection: installBinding,
    isCurrent: () => true,
    canInspectScope: () => true,
    canWriteScope: () => true,
    ...overrides,
  };
  return {
    ...render(<SpackInstallBindingEditor {...props} />, { wrapper: StrictMode }),
    props,
  };
}

test("select labels have exact accessible names without option text", async () => {
  mount();
  const scope = bindingUi().getByRole("combobox", { name: /^Binding scope$/ });
  expect(bindingUi().getByLabelText("Binding scope", { exact: true })).toBe(scope);
  expect(scope).toHaveProperty("value", BINDING_ORG);
  expect(scope.closest("label")).toBeNull();
  await readyBinding();
  const action = bindingUi().getByRole("combobox", { name: /^Binding action$/ });
  expect(bindingUi().getByLabelText("Binding action", { exact: true })).toBe(action);
  expect(action).toHaveProperty("value", "bind");
  expect(action.closest("label")).toBeNull();
  fireEvent.change(action, { target: { value: "disable" } });
  expect(bindingUi().getByRole("combobox", { name: /^Binding action$/ })).toBe(action);
  expect(bindingUi().getByLabelText("Binding action", { exact: true })).toHaveProperty(
    "value",
    "disable",
  );
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
});

test("requires explicit exact spec, inspect, reason and confirmation", async () => {
  mount();
  expect(client.inspectSpackInstallBinding).not.toHaveBeenCalled();
  expect(bindingUi().getByLabelText("Exact installation spec")).toHaveProperty("value", "");
  await readyBinding();
  expect(client.inspectSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
    { scope: BINDING_ORG, spec: INSTALL_SPEC },
    expect.any(AbortSignal),
  );
  expect(bindingUi().getByLabelText("Installation repository ID")).toHaveProperty(
    "value",
    installBinding.repositoryId,
  );
  submitBinding();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
  confirmBinding();
  fireEvent.change(bindingUi().getByLabelText("Installation binding audit reason"), {
    target: { value: " leading" },
  });
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("checked", false);
  fireEvent.click(bindingUi().getByRole("checkbox"));
  submitBinding();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
});

test("binds with the inspected revision and clears consent after success", async () => {
  mount();
  await readyBinding();
  confirmBinding();
  submitBinding();
  await screen.findByText("Installation binding change confirmed.");
  expect(client.changeSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
    {
      scope: BINDING_ORG,
      spec: INSTALL_SPEC,
      action: "bind",
      binding: installBinding,
      expectedRevision: 0,
      reason: INSTALL_REASON,
    },
    expect.any(AbortSignal),
  );
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("checked", false);
  expect(bindingUi().getByLabelText("Installation binding audit reason")).toHaveProperty(
    "value",
    "",
  );
  expect(
    bindingUi().getByRole("table", { name: "Installation binding audit history" }),
  ).toBeTruthy();
});

test("disable sends no binding and changing action clears consent", async () => {
  mount();
  await readyBinding();
  confirmBinding();
  fireEvent.change(bindingUi().getByLabelText("Binding action"), { target: { value: "disable" } });
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("checked", false);
  expect(bindingUi().queryByLabelText("Installation repository ID")).toBeNull();
  fireEvent.click(bindingUi().getByRole("checkbox"));
  submitBinding();
  await waitFor(() => expect(client.changeSpackInstallBinding).toHaveBeenCalledOnce());
  expect(client.changeSpackInstallBinding).toHaveBeenCalledWith(
    {
      scope: BINDING_ORG,
      spec: INSTALL_SPEC,
      action: "disable",
      expectedRevision: 0,
      reason: INSTALL_REASON,
    },
    expect.any(AbortSignal),
  );
});

test("a new selection changes the draft only on explicit copy and clears consent", async () => {
  const mounted = mount();
  await readyBinding();
  confirmBinding();
  const next = { ...installBinding, manifestDigest: `sha256:${"c".repeat(64)}` };
  mounted.rerender(<SpackInstallBindingEditor {...mounted.props} selection={next} />);
  expect(bindingUi().getByLabelText("Installation manifest digest")).toHaveProperty(
    "value",
    installBinding.manifestDigest,
  );
  fireEvent.click(bindingUi().getByRole("button", { name: "Use selected material binding" }));
  expect(bindingUi().getByLabelText("Installation manifest digest")).toHaveProperty(
    "value",
    next.manifestDigest,
  );
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("checked", false);
  submitBinding();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
});

test.each([
  { status: 403, code: "INSTALL_BINDING_FORBIDDEN", text: "Binding management is unavailable" },
  { status: 422, code: "INSTALL_BINDING_INVALID", text: "Binding rejected" },
])("$code removes the write form without retrying", async ({ status, code, text }) => {
  vi.mocked(client.changeSpackInstallBinding).mockRejectedValueOnce(
    new SoftwareError(status, code, "Private backend detail"),
  );
  mount();
  await readyBinding();
  confirmBinding();
  submitBinding();
  expect((await bindingUi().findByRole("alert")).textContent).toContain(text);
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
  expect(client.inspectSpackInstallBinding).toHaveBeenCalledOnce();
  expect(client.changeSpackInstallBinding).toHaveBeenCalledOnce();
});

test("failed inspection exposes no writable snapshot and never retries", async () => {
  vi.mocked(client.inspectSpackInstallBinding).mockRejectedValueOnce(
    new SoftwareError(503, "INSTALL_BINDING_UNAVAILABLE", "Private rollout state"),
  );
  mount();
  fireEvent.change(bindingUi().getByLabelText("Exact installation spec"), {
    target: { value: INSTALL_SPEC },
  });
  inspectBinding();
  expect((await bindingUi().findByRole("alert")).textContent).toContain(
    "Could not inspect the binding",
  );
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
  expect(client.inspectSpackInstallBinding).toHaveBeenCalledOnce();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
});

test("409 conflict requires another inspect and fresh confirmation", async () => {
  vi.mocked(client.changeSpackInstallBinding).mockRejectedValueOnce(
    new SoftwareError(409, "INSTALL_BINDING_CONFLICT", "Private detail"),
  );
  mount();
  await readyBinding();
  confirmBinding();
  submitBinding();
  await screen.findByText("The binding revision changed. Inspect again before submitting.");
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
  vi.mocked(client.inspectSpackInstallBinding).mockResolvedValueOnce(installBindingView(2));
  inspectBinding();
  await screen.findByTestId("spack-install-binding-detail");
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("checked", false);
  fireEvent.change(bindingUi().getByLabelText("Binding action"), { target: { value: "disable" } });
  confirmBinding();
  submitBinding();
  await waitFor(() => expect(client.changeSpackInstallBinding).toHaveBeenCalledTimes(2));
  expect(client.changeSpackInstallBinding).toHaveBeenLastCalledWith(
    expect.objectContaining({ expectedRevision: 2, action: "disable" }),
    expect.any(AbortSignal),
  );
});

test.each([
  new SoftwareError(502, "REGISTRY_INVALID_RESPONSE", "Bad receipt"),
  new SoftwareError(503, "INSTALL_BINDING_UNAVAILABLE", "Unavailable"),
  new SoftwareError(403, "REGISTRY_INVALID_RESPONSE", "Untrusted rejection"),
  new TypeError("Lost response"),
])("uncertain writes lock the query until a successful inspect: %s", async (error) => {
  vi.mocked(client.changeSpackInstallBinding).mockRejectedValueOnce(error);
  const mounted = mount();
  await readyBinding();
  confirmBinding();
  submitBinding();
  await screen.findByText(
    "Submission outcome unconfirmed. Inspect this exact scope and spec before submitting again.",
  );
  expect(bindingUi().getByLabelText("Exact installation spec")).toHaveProperty("disabled", true);
  expect(bindingUi().getByLabelText("Binding scope")).toHaveProperty("disabled", true);
  mounted.rerender(
    <SpackInstallBindingEditor
      {...mounted.props}
      selection={{ ...installBinding, manifestDigest: `sha256:${"c".repeat(64)}` }}
    />,
  );
  fireEvent.change(bindingUi().getByLabelText("Exact installation spec"), {
    target: { value: "other@1" },
  });
  expect(bindingUi().getByLabelText("Exact installation spec")).toHaveProperty(
    "value",
    INSTALL_SPEC,
  );
  vi.mocked(client.inspectSpackInstallBinding).mockRejectedValueOnce(new Error("Offline"));
  inspectBinding();
  await waitFor(() =>
    expect(
      bindingUi().getByRole("button", { name: "Inspect installation binding" }),
    ).toHaveProperty("disabled", false),
  );
  expect(bindingUi().getByLabelText("Binding scope")).toHaveProperty("disabled", true);
  vi.mocked(client.inspectSpackInstallBinding).mockResolvedValueOnce(installBindingView(1));
  inspectBinding();
  await screen.findByText(
    "Current binding retrieved. Check the audit history before submitting another change.",
  );
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("checked", false);
  expect(client.changeSpackInstallBinding).toHaveBeenCalledOnce();
  expect(client.inspectSpackInstallBinding).toHaveBeenLastCalledWith(
    { scope: BINDING_ORG, spec: INSTALL_SPEC },
    expect.any(AbortSignal),
  );
});

test.each(["stop", "timeout"])("%s preserves uncertainty and ignores late success", async (end) => {
  const pending = deferred<SpackInstallBindingView>();
  vi.mocked(client.changeSpackInstallBinding).mockReturnValueOnce(pending.promise);
  mount();
  await readyBinding();
  confirmBinding();
  if (end === "timeout") vi.useFakeTimers();
  submitBinding();
  const signal = vi.mocked(client.changeSpackInstallBinding).mock.calls[0]?.[1];
  if (end === "stop") {
    fireEvent.click(bindingUi().getByRole("button", { name: "Stop waiting for binding" }));
  } else {
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
  }
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(installBindingView(1)));
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
  expect(bindingUi().getByRole("alert").textContent).toContain("Submission outcome unconfirmed");
  expect(client.changeSpackInstallBinding).toHaveBeenCalledOnce();
});

test("synchronous duplicate submissions cannot issue duplicate writes", async () => {
  const pending = deferred<SpackInstallBindingView>();
  vi.mocked(client.changeSpackInstallBinding).mockReturnValueOnce(pending.promise);
  mount();
  await readyBinding();
  confirmBinding();
  const form = bindingUi()
    .getByRole("button", { name: "Save installation binding" })
    .closest("form");
  if (!form) throw new Error("Missing binding form");
  act(() => {
    fireEvent.submit(form);
    fireEvent.submit(form);
  });
  expect(client.changeSpackInstallBinding).toHaveBeenCalledOnce();
  await act(async () => pending.resolve(installBindingView(1)));
});

test("editing spec aborts the old read and drops its late result", async () => {
  const pending = deferred<SpackInstallBindingView>();
  vi.mocked(client.inspectSpackInstallBinding).mockReturnValueOnce(pending.promise);
  mount();
  fireEvent.change(bindingUi().getByLabelText("Exact installation spec"), {
    target: { value: INSTALL_SPEC },
  });
  inspectBinding();
  const signal = vi.mocked(client.inspectSpackInstallBinding).mock.calls[0]?.[1];
  fireEvent.change(bindingUi().getByLabelText("Exact installation spec"), {
    target: { value: "other@1" },
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(installBindingView()));
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
});

test("read-only access and late permission revocation cannot write", async () => {
  let allowed = false;
  const mounted = mount({ canWriteScope: () => allowed });
  await readyBinding();
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("disabled", true);
  submitBinding();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
  allowed = true;
  mounted.rerender(<SpackInstallBindingEditor {...mounted.props} />);
  confirmBinding();
  allowed = false;
  submitBinding();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
});

test("audit is paginated locally and marks truncated history", async () => {
  vi.mocked(client.inspectSpackInstallBinding).mockResolvedValueOnce(installBindingView(101));
  mount();
  await readyBinding();
  expect(bindingUi().getByRole("table").querySelectorAll("tbody tr")).toHaveLength(10);
  expect(
    bindingUi().getByText("Latest 100 events; earlier events remain in the database."),
  ).toBeTruthy();
  for (let index = 0; index < 9; index++) {
    fireEvent.click(bindingUi().getByRole("button", { name: "Next audit events" }));
  }
  expect(bindingUi().getByRole("button", { name: "Next audit events" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(client.inspectSpackInstallBinding).toHaveBeenCalledOnce();
});
