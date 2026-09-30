import type { MeCapabilities, SpackInstallBindingView } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ACTIVE_ORGANIZATION_STORAGE_KEY } from "../../lib/active-organization";
import * as apiClient from "../../lib/api-client";
import { clearAuth, setAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import * as recipes from "../../lib/recipe-repositories-client";
import * as software from "../../lib/software-client";
import * as bindings from "../../lib/spack-install-bindings-client";
import * as materials from "../../lib/spack-materials-client";
import { CpSoftwarePage } from "../../routes/cp.software";
import { SoftwarePage } from "./SoftwarePage";
import {
  bindingUi,
  confirmBinding,
  INSTALL_REASON,
  INSTALL_SPEC,
  inspectBinding,
  installBindingView,
  readyBinding,
  submitBinding,
} from "./SpackInstallBinding.test-helpers";
import { deferred, translation } from "./SpackMaterials.test-helpers";
import { SpackMaterialsPanel } from "./SpackMaterialsPanel";

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => translation,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, ...props }: ComponentProps<"a"> & { to: string }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; hash: string } }) => unknown;
  }) => select({ location: { pathname: "/software", hash: "#spack" } }),
}));

// Keep the CP route and both Spack panels real; policy editing is outside this regression.
vi.mock("../cp/SoftwarePolicyTable", () => ({
  SoftwarePolicyTable: () => null,
}));

const ORGANIZATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function capabilityView(role = "platform_admin", orgId: string | null = null): MeCapabilities {
  return {
    principal: {
      userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      email: "admin@example.test",
      role,
    },
    capabilities: orgId ? ["workspace.provider.manage"] : [],
    contexts: orgId
      ? [
          {
            id: `organization:${orgId}`,
            type: "organization",
            organizationId: orgId,
            membershipRole: "admin",
          },
        ]
      : [{ id: "platform", type: "platform" }],
    activeContextId: orgId ? `organization:${orgId}` : "platform",
    devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

beforeEach(async () => {
  localStorage.clear();
  sessionStorage.clear();
  delete window.__KQ_LOCAL__;
  setAuth({ email: "admin@example.test", role: "platform_admin" });
  await i18n.changeLanguage("en");
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  vi.spyOn(apiClient.api, "get").mockResolvedValue(capabilityView());
  vi.spyOn(apiClient, "listSoftwareReviewQueue").mockResolvedValue([]);
  vi.spyOn(apiClient, "listSoftwareAccessRequests").mockResolvedValue([]);
  vi.spyOn(apiClient, "listSoftwareMirrorCacheStatus").mockResolvedValue([]);
  const page = { tags: [], total: 0, page: 1, pageSize: 24, totalPages: 1, hasNext: false };
  vi.spyOn(software, "listWorkflowTemplatePage").mockResolvedValue({ ...page, templates: [] });
  vi.spyOn(software, "listUsecasePackagePage").mockResolvedValue({ ...page, usecasePackages: [] });
  vi.spyOn(software, "listLicenseEntitlementClaims").mockResolvedValue([]);
  vi.spyOn(software, "listSpackCatalog").mockResolvedValue({
    source: "spack",
    sourceRepository: "public/recipes",
    sourceRef: "main",
    generatedAt: "2026-09-30",
    packageCount: 0,
    upstreamCount: 0,
    customCount: 0,
    totalCount: 0,
    page: 1,
    pageSize: 24,
    totalPages: 1,
    hasNext: false,
    hasPrevious: false,
    packages: [],
  });
  vi.spyOn(recipes, "listRecipeRepositories").mockResolvedValue([]);
  vi.spyOn(materials, "listSpackMaterials").mockResolvedValue({ releases: [] });
  vi.spyOn(bindings, "inspectSpackInstallBinding").mockImplementation(async (query) =>
    installBindingView(0, query.scope),
  );
  vi.spyOn(bindings, "changeSpackInstallBinding").mockImplementation(async (command) => {
    const state = command.action === "bind" ? "enabled" : "disabled";
    const binding = command.action === "bind" ? command.binding : null;
    return {
      ...installBindingView(1, command.scope),
      state,
      binding,
      history: [
        {
          revision: 1,
          state,
          binding,
          source: "web",
          operatorId: capabilityView().principal.userId,
          reason: command.reason,
          createdAt: "2026-09-30T00:00:00.000Z",
        },
      ],
    };
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  clearAuth();
  setMobileManagementPolicy(false);
  vi.restoreAllMocks();
});

async function settledCapabilities() {
  await waitFor(() => {
    expect(
      queryClient.getQueryCache().find({ queryKey: ["me", "capabilities"] })?.state.status,
    ).toBe("success");
  });
}

test("SoftwarePage permits platform binding writes without granting publication", async () => {
  render(<SoftwarePage />, { wrapper });
  await screen.findByTestId("spack-install-binding-editor");
  expect(apiClient.api.get).toHaveBeenCalledWith("/me/capabilities");
  expect(screen.queryByTestId("software-create-spack-package-link")).toBeNull();
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  expect(screen.queryByRole("tab", { name: "Lifecycle" })).toBeNull();
  expect(screen.queryByLabelText("Git bundles")).toBeNull();
  await readyBinding();
  fireEvent.change(bindingUi().getByLabelText("Binding action"), { target: { value: "disable" } });
  confirmBinding();
  submitBinding();
  await screen.findByText("Installation binding change confirmed.");
  expect(bindings.changeSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
    {
      scope: "platform",
      spec: INSTALL_SPEC,
      action: "disable",
      expectedRevision: 0,
      reason: INSTALL_REASON,
    },
    expect.any(AbortSignal),
  );
});

test("SoftwarePage permits the verified CP admin with global user role and no publish capability", async () => {
  setAuth({ email: "admin@example.test", role: "user" });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, ORGANIZATION_ID);
  vi.mocked(apiClient.api.get).mockResolvedValue(capabilityView("user", ORGANIZATION_ID));
  render(<SoftwarePage />, { wrapper });
  await screen.findByTestId("spack-install-binding-editor");
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  expect(screen.queryByLabelText("Git bundles")).toBeNull();
  expect(bindingUi().queryByRole("option", { name: "Platform default" })).toBeNull();
  await readyBinding();
  expect(bindings.inspectSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
    { scope: ORGANIZATION_ID, spec: INSTALL_SPEC },
    expect.any(AbortSignal),
  );
});

test("SoftwarePage cannot authorize bindings from a cached platform role", async () => {
  vi.mocked(apiClient.api.get).mockResolvedValue({
    ...capabilityView("user"),
    capabilities: ["software.publish"],
    contexts: [],
  });
  render(<SoftwarePage />, { wrapper });
  await screen.findByTestId("spack-materials-panel");
  await settledCapabilities();
  expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  expect(bindings.inspectSpackInstallBinding).not.toHaveBeenCalled();
});

test("SoftwarePage waits for canonical capabilities before exposing bindings", async () => {
  const pending = deferred<MeCapabilities>();
  vi.mocked(apiClient.api.get).mockReturnValue(pending.promise);
  render(<SoftwarePage />, { wrapper });
  await screen.findByTestId("spack-materials-panel");
  expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  await act(async () => pending.resolve(capabilityView()));
  await screen.findByTestId("spack-install-binding-editor");
  expect(bindings.inspectSpackInstallBinding).not.toHaveBeenCalled();
});

test("SoftwarePage does not expose binding management when capabilities fail", async () => {
  vi.mocked(apiClient.api.get).mockRejectedValue(new Error("Capabilities unavailable"));
  render(<SoftwarePage />, { wrapper });
  await screen.findByTestId("spack-materials-panel");
  await waitFor(() => {
    expect(
      queryClient.getQueryCache().find({ queryKey: ["me", "capabilities"] })?.state.status,
    ).toBe("error");
  });
  expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  expect(screen.queryByLabelText("Git bundles")).toBeNull();
  expect(bindings.inspectSpackInstallBinding).not.toHaveBeenCalled();
  expect(bindings.changeSpackInstallBinding).not.toHaveBeenCalled();
});

test("SoftwarePage discards a pending write when canonical binding access is revoked", async () => {
  const pending = deferred<SpackInstallBindingView>();
  vi.mocked(bindings.changeSpackInstallBinding).mockReturnValue(pending.promise);
  render(<SoftwarePage />, { wrapper });
  await screen.findByTestId("spack-install-binding-editor");
  await readyBinding();
  fireEvent.change(bindingUi().getByLabelText("Binding action"), { target: { value: "disable" } });
  confirmBinding();
  submitBinding();
  const signal = vi.mocked(bindings.changeSpackInstallBinding).mock.calls[0]?.[1];
  await act(async () => {
    queryClient.setQueriesData({ queryKey: ["me", "capabilities"] }, capabilityView("user"));
  });
  await waitFor(() => {
    expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(installBindingView(1, "platform")));
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
  expect(screen.queryByText("Installation binding change confirmed.")).toBeNull();
  expect(bindings.changeSpackInstallBinding).toHaveBeenCalledOnce();
});

test("the default canManage=false gate still disables bindings", async () => {
  render(<SpackMaterialsPanel canManage={false} />, { wrapper });
  await screen.findByTestId("spack-materials-panel");
  expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  expect(apiClient.api.get).not.toHaveBeenCalled();
});

test("revoking the independent binding gate aborts and clears its session", async () => {
  const pending = deferred<SpackInstallBindingView>();
  vi.mocked(bindings.inspectSpackInstallBinding).mockReturnValue(pending.promise);
  const mounted = render(<SpackMaterialsPanel canManage={false} canManageBindings />, { wrapper });
  await screen.findByTestId("spack-install-binding-editor");
  fireEvent.change(bindingUi().getByLabelText("Exact installation spec"), {
    target: { value: INSTALL_SPEC },
  });
  inspectBinding();
  const signal = vi.mocked(bindings.inspectSpackInstallBinding).mock.calls[0]?.[1];
  mounted.rerender(<SpackMaterialsPanel canManage={false} canManageBindings={false} />);
  expect(signal?.aborted).toBe(true);
  expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  await act(async () => pending.resolve(installBindingView(0, "platform")));
  expect(screen.queryByTestId("spack-install-binding-detail")).toBeNull();
});

test("the CP page retains its provider management gate", async () => {
  setAuth({ email: "admin@example.test", role: "user" });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, ORGANIZATION_ID);
  vi.mocked(apiClient.api.get).mockResolvedValue(capabilityView("user", ORGANIZATION_ID));
  render(<CpSoftwarePage />, { wrapper });
  await screen.findByTestId("spack-install-binding-editor");
  expect(screen.queryByLabelText("Material manifest (JSON)")).toBeNull();
  await readyBinding();
  expect(bindings.inspectSpackInstallBinding).toHaveBeenCalledExactlyOnceWith(
    { scope: ORGANIZATION_ID, spec: INSTALL_SPEC },
    expect.any(AbortSignal),
  );
});

test("the CP page cannot bypass a denied provider management gate", async () => {
  render(<CpSoftwarePage />, { wrapper });
  await screen.findByTestId("spack-materials-panel");
  await settledCapabilities();
  expect(screen.queryByTestId("spack-install-binding-editor")).toBeNull();
  expect(bindings.inspectSpackInstallBinding).not.toHaveBeenCalled();
});
