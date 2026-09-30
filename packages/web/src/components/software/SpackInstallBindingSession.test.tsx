import type { MeCapabilities, SpackInstallBindingView } from "@kuintessence/shared/browser";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ACTIVE_ORGANIZATION_STORAGE_KEY } from "../../lib/active-organization";
import { clearAuth, setAuth } from "../../lib/auth";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import * as client from "../../lib/spack-install-bindings-client";
import * as materials from "../../lib/spack-materials-client";
import { lifecycleFixture } from "./MaterialLifecycle.test-helpers";
import {
  BINDING_ORG,
  bindingUi,
  confirmBinding,
  INSTALL_SPEC,
  inspectBinding,
  installBindingView,
  readyBinding,
  submitBinding,
} from "./SpackInstallBinding.test-helpers";
import {
  capabilities,
  deferred,
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
vi.mock("../../lib/spack-install-bindings-client", async (importOriginal) => ({
  ...(await importOriginal<typeof client>()),
  inspectSpackInstallBinding: vi.fn(),
  changeSpackInstallBinding: vi.fn(),
}));
vi.mock("../../lib/spack-materials-client", () => ({
  uploadSpackMaterial: vi.fn(),
  publishSpackMaterial: vi.fn(),
  getSpackMaterial: vi.fn(),
  listSpackMaterials: vi.fn(),
}));

function verifiedCapabilities(role = "org_admin") {
  const data = capabilities(role);
  data.capabilities = ["workspace.provider.manage"];
  data.contexts = [
    {
      id: `organization:${BINDING_ORG}`,
      type: "organization",
      organizationId: BINDING_ORG,
      membershipRole: "admin",
    },
  ];
  return data;
}

beforeEach(async () => {
  await resetMaterials();
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, BINDING_ORG);
  access.status = "ready";
  access.data = verifiedCapabilities();
  vi.mocked(client.inspectSpackInstallBinding).mockResolvedValue(installBindingView());
  vi.mocked(client.changeSpackInstallBinding).mockResolvedValue(installBindingView(1));
});
afterEach(() => {
  cleanup();
  clearAuth();
  setMobileManagementPolicy(false);
  delete window.__KQ_LOCAL__;
  vi.restoreAllMocks();
});

function mount() {
  return render(<SpackMaterialsPanel canManage />);
}

test("org-admin uses verified active org, not the stored platform role", async () => {
  mount();
  const select = bindingUi().getByLabelText("Binding scope");
  expect(select).toHaveProperty("value", BINDING_ORG);
  expect(select.querySelectorAll("option")).toHaveLength(1);
  expect(bindingUi().queryByRole("option", { name: "Platform default" })).toBeNull();
  fireEvent.change(select, { target: { value: "platform" } });
  expect(select).toHaveProperty("value", BINDING_ORG);
  await readyBinding();
  expect(client.inspectSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
    { scope: BINDING_ORG, spec: INSTALL_SPEC },
    expect.any(AbortSignal),
  );
});

test("platform admin defaults to active org and can explicitly select platform", async () => {
  access.data = verifiedCapabilities("platform_admin");
  vi.mocked(client.inspectSpackInstallBinding).mockResolvedValueOnce(
    installBindingView(0, "platform"),
  );
  mount();
  expect(bindingUi().getByLabelText("Binding scope")).toHaveProperty("value", BINDING_ORG);
  fireEvent.change(bindingUi().getByLabelText("Binding scope"), { target: { value: "platform" } });
  await readyBinding();
  expect(client.inspectSpackInstallBinding).toHaveBeenCalledWith(
    { scope: "platform", spec: INSTALL_SPEC },
    expect.any(AbortSignal),
  );
});

test("without an active organization platform admin defaults to platform", () => {
  access.data = verifiedCapabilities("platform_admin");
  localStorage.removeItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  mount();
  expect(bindingUi().getByLabelText("Binding scope")).toHaveProperty("value", "platform");
  expect(client.inspectSpackInstallBinding).not.toHaveBeenCalled();
});

test.each(["missing-org", "unverified-org", "missing-capability", "local"])(
  "%s fails closed",
  (kind) => {
    if (kind === "missing-org") localStorage.removeItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
    if (kind === "unverified-org" && access.data) access.data.contexts = [];
    if (kind === "missing-capability" && access.data) access.data.capabilities = [];
    if (kind === "local") window.__KQ_LOCAL__ = { baseUrl: "http://localhost:19999" };
    mount();
    expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
    expect(client.inspectSpackInstallBinding).not.toHaveBeenCalled();
  },
);

const changes = [
  "logout",
  "identity",
  "session",
  "organization",
  "role",
  "membership",
  "capability",
  "loading",
  "error",
  "management",
] as const;
async function changeSession(change: (typeof changes)[number], mounted: ReturnType<typeof mount>) {
  await act(async () => {
    if (change === "logout") clearAuth();
    if (change === "identity") setAuth({ email: "other@example.test", role: "platform_admin" });
    if (change === "session") setAuth({ email: "alice@example.test", role: "platform_admin" });
    if (change === "organization") {
      localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "cccccccc-cccc-cccc-cccc-cccccccccccc");
      window.dispatchEvent(new Event("kq:active-organization-change"));
    }
    if (change === "role") access.data = verifiedCapabilities("user");
    if (change === "membership" && access.data) {
      access.data = {
        ...access.data,
        contexts: access.data.contexts.map((context) =>
          context.type === "organization" ? { ...context, membershipRole: "operator" } : context,
        ),
      };
    }
    if (change === "capability" && access.data) {
      access.data = { ...access.data, capabilities: [] };
    }
    if (change === "loading" || change === "error") access.status = change;
    mounted.rerender(<SpackMaterialsPanel canManage={change !== "management"} />);
  });
}

test.each(changes)("%s clears binding details, history, spec and reason", async (change) => {
  vi.mocked(client.inspectSpackInstallBinding).mockResolvedValueOnce(installBindingView(1));
  const mounted = mount();
  await readyBinding();
  confirmBinding();
  await changeSession(change, mounted);
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
  expect(screen.queryByLabelText("Installation binding audit reason")).toBeNull();
  expect(screen.queryByDisplayValue(INSTALL_SPEC)).toBeNull();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
});

test.each(
  changes.flatMap((change) => [
    { change, stage: "read" as const },
    { change, stage: "write" as const },
  ]),
)("$change aborts $stage and ignores late results", async ({ change, stage }) => {
  const pending = deferred<SpackInstallBindingView>();
  if (stage === "read") {
    vi.mocked(client.inspectSpackInstallBinding).mockReturnValueOnce(pending.promise);
  } else {
    vi.mocked(client.changeSpackInstallBinding).mockReturnValueOnce(pending.promise);
  }
  const mounted = mount();
  fireEvent.change(bindingUi().getByLabelText("Exact installation spec"), {
    target: { value: INSTALL_SPEC },
  });
  inspectBinding();
  if (stage === "write") {
    await screen.findByTestId("spack-install-binding-detail");
    fireEvent.change(bindingUi().getByLabelText("Binding action"), {
      target: { value: "disable" },
    });
    confirmBinding();
    submitBinding();
  }
  const signal =
    stage === "read"
      ? vi.mocked(client.inspectSpackInstallBinding).mock.calls[0]?.[1]
      : vi.mocked(client.changeSpackInstallBinding).mock.calls[0]?.[1];
  await changeSession(change, mounted);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(installBindingView(1)));
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
  expect(screen.queryByText("Installation binding change confirmed.")).toBeNull();
});

test("mobile allows inspection but disables mutation controls", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
  setMobileManagementPolicy(true);
  mount();
  await readyBinding();
  expect(bindingUi().getByRole("checkbox")).toHaveProperty("disabled", true);
  expect(bindingUi().getByLabelText("Binding action")).toHaveProperty("disabled", true);
  submitBinding();
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
});

test.each(["owner", "admin"] as const)(
  "role=user CP %s manages bindings without software.publish or lifecycle access",
  async (membershipRole) => {
    access.data = verifiedCapabilities("user");
    access.data.contexts = [
      {
        id: `organization:${BINDING_ORG}`,
        type: "organization",
        organizationId: BINDING_ORG,
        membershipRole,
      },
    ];
    setAuth({ email: "alice@example.test", role: "user" });
    mount();
    expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
    expect(screen.queryByLabelText("Management repository")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Lifecycle" })).toBeNull();
    expect(bindingUi().queryByRole("option", { name: "Platform default" })).toBeNull();
    await readyBinding();
    fireEvent.change(bindingUi().getByLabelText("Binding action"), {
      target: { value: "disable" },
    });
    confirmBinding();
    submitBinding();
    await screen.findByText("Installation binding change confirmed.");
    expect(client.changeSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ scope: BINDING_ORG, action: "disable", expectedRevision: 0 }),
      expect.any(AbortSignal),
    );
  },
);

test.each(["platform_admin", "super_admin"])(
  "%s can manage platform bindings without publishing or provider capabilities",
  async (role) => {
    access.data = verifiedCapabilities(role);
    access.data.capabilities = [];
    localStorage.removeItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
    vi.mocked(client.inspectSpackInstallBinding).mockResolvedValueOnce(
      installBindingView(0, "platform"),
    );
    mount();
    expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
    await readyBinding();
    expect(client.inspectSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
      { scope: "platform", spec: INSTALL_SPEC },
      expect.any(AbortSignal),
    );
  },
);

test("software.publish alone does not grant binding management to a CP admin", () => {
  access.data = verifiedCapabilities("user");
  access.data.capabilities = ["software.publish"];
  mount();
  expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  expect(client.inspectSpackInstallBinding).not.toHaveBeenCalled();
});

test("catalog selection prefills only the immutable binding, never guesses the spec", async () => {
  const fixture = lifecycleFixture(`org/${BINDING_ORG}/materials`);
  vi.mocked(materials.listSpackMaterials).mockResolvedValueOnce(fixture.catalog);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Inspect release" }));
  expect(bindingUi().getByLabelText("Exact installation spec")).toHaveProperty("value", "");
  expect(client.inspectSpackInstallBinding).not.toHaveBeenCalled();
  await readyBinding();
  expect(bindingUi().getByLabelText("Installation repository ID")).toHaveProperty(
    "value",
    fixture.binding.repositoryId,
  );
  expect(bindingUi().getByLabelText("Installation manifest digest")).toHaveProperty(
    "value",
    fixture.binding.manifestDigest,
  );
  expect(client.changeSpackInstallBinding).not.toHaveBeenCalled();
});
