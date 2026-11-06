import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { LicenseEntitlementPanel, RuntimeAndMaterialPanel } from "./EcosystemGovernancePanels";

const softwareClient = vi.hoisted(() => ({
  bindRuntimeContract: vi.fn(),
  decideLicenseEntitlementClaim: vi.fn(),
  listLicenseEntitlementClaims: vi.fn(),
  listLicensedMaterialMappings: vi.fn(),
  listRuntimeContractBindings: vi.fn(),
  listSpackCatalog: vi.fn(),
  registerLicensedMaterialMapping: vi.fn(),
  submitLicenseEntitlementClaim: vi.fn(),
}));

const sandbox = vi.hoisted(() => ({
  listSandboxAgentSecurityViews: vi.fn(),
  listSandboxRuntimeProfiles: vi.fn(),
}));
const scope = vi.hoisted(() => ({ org: "provider-1", mobile: false }));
vi.mock("../../lib/active-organization", () => ({ useActiveOrganizationId: () => scope.org }));
vi.mock("../../lib/use-media-query", () => ({ useMediaQuery: () => scope.mobile }));
vi.mock("../../lib/mobile-management-policy", () => ({
  isMobileHighRiskMutationBlocked: () => true,
}));
vi.mock("../../lib/sandbox-client", () => sandbox);
beforeEach(() => {
  scope.org = "provider-1";
  scope.mobile = false;
  sandbox.listSandboxAgentSecurityViews.mockResolvedValue([
    { agentId: "agent-1", providerOrgId: "provider-1", siteName: "Slurm", schedulerType: "slurm" },
    {
      agentId: "agent-2",
      providerOrgId: "provider-1",
      siteName: "Kubernetes",
      schedulerType: "kubernetes",
    },
    {
      agentId: "foreign",
      providerOrgId: "provider-2",
      siteName: "Other organization",
      schedulerType: "slurm",
    },
  ]);
  sandbox.listSandboxRuntimeProfiles.mockResolvedValue([
    {
      id: "profile",
      name: "Python runtime",
      language: "python",
      languageVersion: "3.12.4",
      lifecycle: "active",
      adapters: ["slurm", "kubernetes"],
      sifDigest: "sha256:sif",
      ociDigest: "sha256:oci",
    },
    {
      id: "revoked",
      name: "Revoked runtime",
      language: "python",
      languageVersion: "3.12",
      lifecycle: "revoked",
      adapters: ["slurm"],
      sifDigest: "sha256:old",
    },
  ]);
  softwareClient.listSpackCatalog.mockResolvedValue({
    packages: [
      {
        name: "VASP",
        asset: { id: "vasp-asset", version: "6.5" },
        licensePolicy: { identifiers: [{ value: "VASP" }] },
      },
      { name: "Unmanaged VASP" },
    ],
    hasNext: false,
  });
  softwareClient.listRuntimeContractBindings.mockResolvedValue([]);
  softwareClient.listLicensedMaterialMappings.mockResolvedValue([]);
});
vi.mock("../../lib/software-client", () => softwareClient);
vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => undefined },
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

afterEach(() => {
  vi.resetAllMocks();
});

test("submits a metadata-only consumer entitlement claim", async () => {
  softwareClient.submitLicenseEntitlementClaim.mockResolvedValue({ id: "claim-1" });
  render(<LicenseEntitlementPanel canReview={false} canSubmit={true} defaultClaimantId="org-1" />, {
    wrapper: wrapper(),
  });
  fireEvent.change(screen.getByLabelText("software.license.subject"), {
    target: { value: "VASP-6.5.1" },
  });
  fireEvent.change(screen.getByLabelText("software.license.evidenceReference"), {
    target: { value: "ticket-1024" },
  });
  fireEvent.change(screen.getByLabelText("software.license.evidenceSummary"), {
    target: { value: "Institutional entitlement confirmed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "software.license.submitClaim" }));
  await waitFor(() =>
    expect(softwareClient.submitLicenseEntitlementClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        claimantId: "org-1",
        entitlement: "consumer-use",
        licenseSubject: "VASP-6.5.1",
      }),
      expect.anything(),
    ),
  );
});

test("registers VASP metadata without accepting material bytes", async () => {
  softwareClient.listRuntimeContractBindings.mockResolvedValue([]);
  softwareClient.listLicensedMaterialMappings.mockResolvedValue([]);
  softwareClient.registerLicensedMaterialMapping.mockResolvedValue({ id: "mapping-1" });
  render(<RuntimeAndMaterialPanel canManage />, { wrapper: wrapper() });
  const agentInput = await screen.findByLabelText("cp.accounts.registration.agent");
  fireEvent.change(agentInput, {
    target: { value: "agent-1" },
  });
  fireEvent.change(screen.getByLabelText("software.license.materialSelector"), {
    target: { value: "vasp-potcar-paw-pbe-2025" },
  });
  fireEvent.change(screen.getByLabelText("software.license.materialVersion"), {
    target: { value: "PBE-2025" },
  });
  fireEvent.change(screen.getByLabelText("software.license.elements"), {
    target: { value: "Si, O" },
  });
  fireEvent.change(screen.getByLabelText("software.license.fingerprint"), {
    target: { value: "sha256:local" },
  });
  const submit = screen.getByRole("button", { name: "software.license.registerMaterial" });
  expect(submit).toHaveProperty("disabled", true);
  expect(screen.queryByRole("option", { name: "Unmanaged VASP" })).toBeNull();
  fireEvent.change(screen.getByLabelText("software.license.materialSoftware"), {
    target: { value: "vasp-asset" },
  });
  fireEvent.click(submit);
  await waitFor(() =>
    expect(softwareClient.registerLicensedMaterialMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        assetId: "vasp-asset",
        elementSet: ["Si", "O"],
        providerOrgId: "provider-1",
      }),
      expect.anything(),
    ),
  );
});

test("runtime selection derives scheduler digest, excludes revoked profiles and resets on scope changes", async () => {
  const view = render(<RuntimeAndMaterialPanel canManage />, { wrapper: wrapper() });
  const agent = await screen.findByLabelText("cp.accounts.registration.agent");
  expect(screen.queryByRole("option", { name: /Other organization/ })).toBeNull();
  fireEvent.change(agent, { target: { value: "agent-1" } });
  expect(screen.queryByRole("option", { name: /Revoked/ })).toBeNull();
  fireEvent.change(screen.getByLabelText("software.license.runtimeProfile"), {
    target: { value: "profile" },
  });
  fireEvent.click(screen.getByRole("button", { name: "software.license.bindRuntime" }));
  await waitFor(() =>
    expect(softwareClient.bindRuntimeContract).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", runtimeDigest: "sha256:sif" }),
      expect.anything(),
    ),
  );
  fireEvent.change(agent, { target: { value: "agent-2" } });
  expect(screen.getByLabelText("software.license.runtimeProfile")).toHaveProperty("value", "");
  fireEvent.change(screen.getByLabelText("software.license.runtimeProfile"), {
    target: { value: "profile" },
  });
  fireEvent.click(screen.getByRole("button", { name: "software.license.bindRuntime" }));
  await waitFor(() =>
    expect(softwareClient.bindRuntimeContract).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "agent-2", runtimeDigest: "sha256:oci" }),
      expect.anything(),
    ),
  );
  scope.org = "provider-2";
  view.rerender(<RuntimeAndMaterialPanel canManage />);
  await waitFor(() =>
    expect(screen.getByLabelText("cp.accounts.registration.agent")).toHaveProperty("value", ""),
  );
  fireEvent.click(screen.getByRole("button", { name: "software.license.bindRuntime" }));
  expect(softwareClient.bindRuntimeContract).toHaveBeenCalledTimes(2);
});
test("runtime read failure is not rendered as an empty configuration", async () => {
  softwareClient.listRuntimeContractBindings.mockRejectedValue(new Error("unavailable"));
  render(<RuntimeAndMaterialPanel canManage />, { wrapper: wrapper() });
  await screen.findByRole("alert");
  expect(screen.queryByText("software.license.noRuntimeBindings")).toBeNull();
  expect(screen.queryByRole("button", { name: "software.license.bindRuntime" })).toBeNull();
});
test("mobile and revoked management permission block runtime writes", async () => {
  scope.mobile = true;
  const view = render(<RuntimeAndMaterialPanel canManage />, { wrapper: wrapper() });
  fireEvent.change(await screen.findByLabelText("cp.accounts.registration.agent"), {
    target: { value: "agent-1" },
  });
  expect(screen.getByTestId("runtime-material-readonly-summary")).toBeTruthy();
  expect(screen.queryByLabelText("software.license.runtimeProfile")).toBeNull();
  expect(screen.queryByLabelText("software.license.materialSelector")).toBeNull();
  expect(screen.queryByRole("button", { name: "software.license.bindRuntime" })).toBeNull();
  expect(softwareClient.listSpackCatalog).not.toHaveBeenCalled();
  scope.mobile = false;
  view.rerender(<RuntimeAndMaterialPanel canManage={false} />);
  expect(screen.getByLabelText("software.license.runtimeProfile")).toHaveProperty("disabled", true);
  expect(softwareClient.bindRuntimeContract).not.toHaveBeenCalled();
});

test("mobile runtime summaries keep existing bindings and filter by agent", async () => {
  scope.mobile = true;
  softwareClient.listRuntimeContractBindings.mockResolvedValue([
    {
      runtimeContractRef: "python-3.12-stdlib-v1",
      runtimeProfileId: "profile",
      agentId: "agent-1",
    },
    { runtimeContractRef: "other-runtime", runtimeProfileId: "profile", agentId: "agent-2" },
  ]);
  softwareClient.listLicensedMaterialMappings.mockResolvedValue([
    { selector: "local-pbe", materialVersion: "2025", elementSet: ["Si"], agentId: "agent-1" },
  ]);
  render(<RuntimeAndMaterialPanel canManage />, { wrapper: wrapper() });
  await screen.findByText(/local-pbe/);
  expect(screen.getByText(/other-runtime/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("cp.accounts.registration.agent"), {
    target: { value: "agent-1" },
  });
  expect(screen.queryByText(/other-runtime/)).toBeNull();
  expect(screen.getByText(/python-3.12-stdlib-v1/)).toBeTruthy();
  expect(softwareClient.bindRuntimeContract).not.toHaveBeenCalled();
  expect(softwareClient.registerLicensedMaterialMapping).not.toHaveBeenCalled();
});
