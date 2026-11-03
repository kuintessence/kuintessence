import { EMPTY_PLATFORM_BRANDING } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CloudStorageGovernancePanel } from "./CloudStorageGovernancePanel";
import { CostRatesForm } from "./CostRatesForm";
import { FileTransferAuditConfigPanel } from "./FileTransferAuditConfigPanel";
import { PlatformBrandingForm } from "./PlatformBrandingForm";
import { SSOConfigForm } from "./SSOConfigForm";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
const translate = vi.hoisted(() => (key: string) => key);
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
const cases = [
  {
    id: "platform-branding-form",
    error: "platform-branding-load-error",
    path: "/admin/branding",
    form: <PlatformBrandingForm />,
    data: EMPTY_PLATFORM_BRANDING,
    save: "platform-branding-save",
  },
  {
    id: "sso-config-form",
    error: "sso-load-error",
    path: "/admin/sso/config",
    form: <SSOConfigForm />,
    data: {
      enabled: false,
      providerType: "oidc",
      issuerUrl: "https://example.test",
      clientId: "review",
      clientSecret: "",
      groupMapping: {},
      autoCreateUsers: false,
    },
    save: "sso-save",
  },
  {
    id: "file-transfer-audit-config",
    error: "file-transfer-audit-load-error",
    path: "/admin/file-transfer-audit/config",
    form: <FileTransferAuditConfigPanel canManage />,
    data: {
      policyVersion: 1,
      userPlatformRetentionDays: 365,
      platformClusterRetentionDays: 180,
      downloadEvidenceMode: "controlled_gateway",
    },
    save: "file-transfer-audit-save",
  },
  {
    id: "cost-rates-form",
    error: "cost-rates-load-error",
    path: "/preferences/global",
    form: <CostRatesForm />,
    data: { spec: { costRates: { cluster: 1 } } },
    save: "cost-rates-save",
  },
];
test.each(
  cases,
)("$id can recover from a failed read without page reload or configuration writes", async (item) => {
  api.get.mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(item.data);
  render(item.form);
  await screen.findByTestId(item.error);
  expect(screen.queryByTestId(item.save)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
  await screen.findByTestId(item.save);
  expect(screen.queryByTestId(item.error)).toBeNull();
  expect(api.get).toHaveBeenCalledTimes(2);
  expect(api.get).toHaveBeenLastCalledWith(item.path);
  expect(api.put).not.toHaveBeenCalled();
});
test.each(cases)("$id is read-only under mobile configuration policy", async (item) => {
  sessionStorage.setItem("kq.mobile-management-policy", "observe-approve");
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  api.get.mockResolvedValue(item.data);
  render(item.form);
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  if (item.id === "file-transfer-audit-config") {
    await screen.findByText("settings.operations.fileTransferAudit.readOnly");
    expect(screen.queryByTestId(item.save)).toBeNull();
  } else {
    const save = await screen.findByTestId(item.save);
    expect(save.closest("fieldset")).toHaveProperty("disabled", true);
  }
  expect(api.put).not.toHaveBeenCalled();
});
test("mobile storage configuration remains readable with write controls disabled", async () => {
  sessionStorage.setItem("kq.mobile-management-policy", "observe-approve");
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  api.get.mockImplementation(async (path: string) =>
    path.includes("membership-options")
      ? { data: { users: [], moreUsers: false } }
      : path.includes("/policy?")
        ? {
            policy: null,
            effectivePolicy: {
              defaultQuotaBytes: 40 * 1024 ** 3,
              maxQuotaBytes: null,
              requestMode: "manual",
              autoApproveLimitBytes: null,
            },
          }
        : path.includes("quota-requests")
          ? { requests: [] }
          : { usedBytes: 0, fileCount: 0 },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CloudStorageGovernancePanel />
    </QueryClientProvider>,
  );
  const save = await screen.findByRole("button", { name: "保存策略" });
  expect(save.closest("fieldset")).toHaveProperty("disabled", true);
  expect(screen.getByLabelText("默认配额（GB）")).toHaveProperty("value", "40");
  expect(api.put).not.toHaveBeenCalled();
  view.unmount();
  client.clear();
});
