import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { LicenseEntitlementPanel, RuntimeAndMaterialPanel } from "./EcosystemGovernancePanels";

const softwareClient = vi.hoisted(() => ({
  bindRuntimeContract: vi.fn(),
  decideLicenseEntitlementClaim: vi.fn(),
  listLicenseEntitlementClaims: vi.fn(),
  listLicensedMaterialMappings: vi.fn(),
  listRuntimeContractBindings: vi.fn(),
  registerLicensedMaterialMapping: vi.fn(),
  submitLicenseEntitlementClaim: vi.fn(),
}));

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
  render(<RuntimeAndMaterialPanel />, { wrapper: wrapper() });
  fireEvent.change(screen.getByLabelText("software.license.providerOrg"), {
    target: { value: "provider-1" },
  });
  const agentInput = screen.getByLabelText("software.license.agent");
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
  fireEvent.click(screen.getByRole("button", { name: "software.license.registerMaterial" }));
  await waitFor(() =>
    expect(softwareClient.registerLicensedMaterialMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        elementSet: ["Si", "O"],
        providerOrgId: "provider-1",
      }),
      expect.anything(),
    ),
  );
});
