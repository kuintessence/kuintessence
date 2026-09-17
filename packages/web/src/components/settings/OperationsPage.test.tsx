import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const router = vi.hoisted(() => ({ hash: "" }));
const capabilityOverride = vi.hoisted(() => ({ values: null as string[] | null }));

vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({ select }: { select: (state: { location: { hash: string } }) => unknown }) =>
    select({ location: { hash: router.hash } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/local-mode", () => ({ isLocalMode: () => false }));

vi.mock("../../lib/platform-capabilities", () => ({
  toCapabilitySet: (data: { capabilities?: string[] } | null) => new Set(data?.capabilities ?? []),
  useMeCapabilities: () => {
    const role = localStorage.getItem("kq_role");
    const platform = role === "operator" || role === "platform_admin" || role === "super_admin";
    const elevated = role === "platform_admin" || role === "super_admin";
    return {
      status: "ready" as const,
      data: {
        capabilities: capabilityOverride.values ?? [
          ...(platform
            ? [
                "workspace.platform.view",
                "workspace.audit.view",
                "audit.view",
                "metering.report.view",
              ]
            : []),
          ...(elevated ? ["workspace.platform.manage"] : []),
        ],
      },
      error: null,
      retry: vi.fn(),
    };
  },
}));

vi.mock("./CloudStorageGovernancePanel", () => ({
  CloudStorageGovernancePanel: () => <div data-testid="cloud-storage-governance-panel" />,
}));

vi.mock("./ClusterFileRootsPanel", () => ({
  ClusterFileRootsPanel: () => <div data-testid="cluster-file-roots-panel" />,
}));

vi.mock("./AuthzAdminPanel", () => ({
  AuthzAdminPanel: ({ showBreakGlass }: { showBreakGlass?: boolean }) => (
    <div data-testid="authz-admin-panel" data-show-break-glass={String(showBreakGlass)} />
  ),
}));

vi.mock("./CostRatesForm", () => ({
  CostRatesForm: () => <div data-testid="cost-rates-form" />,
}));

vi.mock("./SandboxSecurityPanel", () => ({
  SandboxSecurityPanel: () => <div data-testid="sandbox-security-panel" />,
}));

vi.mock("./SSOConfigForm", () => ({
  SSOConfigForm: () => <div data-testid="sso-config-form" />,
}));

vi.mock("./OperationsAttentionCards", () => ({
  OperationsAttentionCards: () => <div data-testid="operations-attention-cards" />,
}));

vi.mock("./AuditLogPanel", () => ({
  AuditLogPanel: () => <div data-testid="platform-audit-log" />,
}));

vi.mock("./FileTransferAuditConfigPanel", () => ({
  FileTransferAuditConfigPanel: ({ canManage }: { canManage: boolean }) => (
    <div data-testid="file-transfer-audit-config" data-can-manage={String(canManage)} />
  ),
}));

vi.mock("../cp/MeteringPage", () => ({
  MeteringPage: ({ showWebhooks }: { showWebhooks?: boolean }) => (
    <div data-testid="operator-metering-report" data-show-webhooks={String(showWebhooks)} />
  ),
}));

import { canAccessOperations, OperationsPage } from "./OperationsPage";

describe("OperationsPage", () => {
  beforeEach(() => {
    localStorage.setItem("kq_role", "super_admin");
    router.hash = "";
    capabilityOverride.values = null;
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("keeps approvals and alerts on the overview while capability links live in the sidebar menu", () => {
    render(<OperationsPage />);

    expect(screen.getByTestId("operations-attention-cards")).toBeTruthy();
    expect(screen.queryByTestId("settings-operations-map")).toBeNull();
  });

  test("renders only the selected operations area for a section hash", () => {
    router.hash = "#compute";
    render(<OperationsPage />);

    expect(screen.getByTestId("operations-area-compute")).toBeTruthy();
    expect(screen.queryByTestId("operations-area-security")).toBeNull();
    expect(screen.queryByTestId("settings-ops-summary")).toBeNull();
    expect(screen.queryByTestId("operations-attention-cards")).toBeNull();
  });

  test("denies direct route access without a platform management role", () => {
    localStorage.setItem("kq_role", "user");

    render(<OperationsPage />);

    expect(screen.getByTestId("operations-access-denied")).toBeTruthy();
    expect(screen.queryByTestId("operations-page")).toBeNull();
    expect(screen.queryByTestId("settings-ops-summary")).toBeNull();
  });

  test("opens the audit surface for an audit-readonly user without management panels", () => {
    localStorage.setItem("kq_role", "user");
    capabilityOverride.values = ["workspace.audit.view", "audit.view", "metering.report.view"];

    render(<OperationsPage />);

    expect(canAccessOperations("user", new Set(capabilityOverride.values))).toBe(true);
    expect(screen.getByTestId("platform-audit-log")).toBeTruthy();
    expect(screen.getByTestId("file-transfer-audit-config").dataset.canManage).toBe("false");
    expect(screen.queryByTestId("operations-attention-cards")).toBeNull();
    expect(screen.queryByTestId("authz-admin-panel")).toBeNull();
  });

  test("allows operators to inspect the platform overview without management panels", () => {
    localStorage.setItem("kq_role", "operator");

    render(<OperationsPage />);

    expect(canAccessOperations("operator")).toBe(true);
    expect(screen.getByTestId("operations-page")).toBeTruthy();
    expect(screen.getByTestId("settings-ops-summary")).toBeTruthy();
    expect(screen.getByTestId("operations-attention-cards")).toBeTruthy();
  });

  test("allows platform admins to manage file-transfer audit policy", () => {
    localStorage.setItem("kq_role", "platform_admin");
    router.hash = "#audit";

    render(<OperationsPage />);

    expect(screen.getByTestId("file-transfer-audit-config").dataset.canManage).toBe("true");
    expect(screen.getByTestId("platform-audit-log")).toBeTruthy();
  });

  test("does not expose provider configuration to a read-only platform operator", () => {
    localStorage.setItem("kq_role", "operator");
    router.hash = "#compute";

    render(<OperationsPage />);

    expect(screen.queryByTestId("cluster-file-roots-panel")).toBeNull();
    expect(screen.getByTestId("operations-area-compute")).toBeTruthy();
  });

  test("renders the operator metering report without webhook management", () => {
    localStorage.setItem("kq_role", "operator");
    router.hash = "#metering";

    render(<OperationsPage />);

    expect(screen.getByTestId("operator-metering-report").dataset.showWebhooks).toBe("false");
    expect(screen.queryByTestId("operations-metering-configuration")).toBeNull();
  });

  test("keeps cost rates and break-glass exclusive to super_admin", () => {
    localStorage.setItem("kq_role", "platform_admin");
    router.hash = "#security";
    const view = render(<OperationsPage />);

    expect(screen.getByTestId("authz-admin-panel").dataset.showBreakGlass).toBe("false");

    router.hash = "#metering";
    view.rerender(<OperationsPage />);
    expect(screen.queryByTestId("cost-rates-form")).toBeNull();

    localStorage.setItem("kq_role", "super_admin");
    router.hash = "#security";
    view.rerender(<OperationsPage />);
    expect(screen.getByTestId("authz-admin-panel").dataset.showBreakGlass).toBe("true");

    router.hash = "#metering";
    view.rerender(<OperationsPage />);
    expect(screen.getByTestId("cost-rates-form")).toBeTruthy();
  });
});
