import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import en from "../../locales/cp/en.json";
import zh from "../../locales/cp/zh.json";

const router = vi.hoisted(() => ({
  hash: "",
  role: "super_admin",
  expiresAt: null as number | null,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (state: { location: { hash: string } }) => unknown }) =>
    select({ location: { hash: router.hash } }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) =>
      options?.count === undefined ? key : `${key}:${options.count}`,
  }),
}));
vi.mock("../../lib/auth", () => ({
  clearAuth: vi.fn(),
  clearServerAuthSession: vi.fn(),
  getAuthState: () => ({
    role: router.role,
    email: "admin@example.test",
    expiresAt: router.expiresAt,
  }),
  setAuth: vi.fn(),
  subscribeAuthState: () => () => undefined,
}));
vi.mock("../ThemeProvider", () => ({ useTheme: () => ({ theme: "system", setTheme: vi.fn() }) }));

vi.mock("./FederationPermissionsPanel", () => ({
  FederationPermissionsPanel: () => <div data-testid="FederationPermissionsPanel" />,
}));
vi.mock("./FederationStoragePanel", () => ({
  FederationStoragePanel: () => <div data-testid="FederationStoragePanel" />,
}));
vi.mock("./FederationTrustPanel", () => ({
  FederationTrustPanel: () => <div data-testid="FederationTrustPanel" />,
}));
vi.mock("./AgentCertsPanel", () => ({
  AgentCertsPanel: () => <div data-testid="AgentCertsPanel" />,
}));
vi.mock("./AuthzAdminPanel", () => ({
  AuthzAdminPanel: () => <div data-testid="AuthzAdminPanel" />,
}));
vi.mock("./ClusterFileRootsPanel", () => ({
  ClusterFileRootsPanel: () => <div data-testid="ClusterFileRootsPanel" />,
}));
vi.mock("./CostRatesForm", () => ({ CostRatesForm: () => <div data-testid="CostRatesForm" /> }));
vi.mock("./DesensitizeAdminPanel", () => ({
  DesensitizeAdminPanel: () => <div data-testid="DesensitizeAdminPanel" />,
}));
vi.mock("./PlatformBrandingForm", () => ({
  PlatformBrandingForm: () => <div data-testid="PlatformBrandingForm" />,
}));
vi.mock("./SandboxAccountMappingsPanel", () => ({
  SandboxAccountMappingsPanel: () => <div data-testid="SandboxAccountMappingsPanel" />,
}));
vi.mock("./SandboxSecurityPanel", () => ({
  SandboxSecurityPanel: () => <div data-testid="SandboxSecurityPanel" />,
}));
vi.mock("./SSOConfigForm", () => ({ SSOConfigForm: () => <div data-testid="SSOConfigForm" /> }));
vi.mock("./SshActiveSessions", () => ({
  SshActiveSessions: () => <div data-testid="SshActiveSessions" />,
}));
vi.mock("./SshCredentialsForm", () => ({
  SshCredentialsForm: () => <div data-testid="SshCredentialsForm" />,
}));
vi.mock("./SshRecordingPlayer", () => ({
  SshRecordingPlayer: () => <div data-testid="SshRecordingPlayer" />,
}));

import { SettingsPage } from "./SettingsPage";

describe("SettingsPage deep links", () => {
  beforeEach(() => {
    router.hash = "";
    router.expiresAt = null;
    router.role = "super_admin";
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => vi.unstubAllGlobals());

  test.each([
    ["#infrastructure/cluster-file-roots", "cluster-file-roots", "ClusterFileRootsPanel"],
    ["#security/sandbox-security", "sandbox-security", "SandboxSecurityPanel"],
    ["#security/federation-permissions", "federation-permissions", "FederationPermissionsPanel"],
    ["#security/federation-storage", "federation-storage", "FederationStoragePanel"],
    ["#security/federation-trust", "federation-trust", "FederationTrustPanel"],
  ])("opens and scrolls to the requested section after a refresh: %s", async (hash, sectionId, panel) => {
    router.hash = hash;
    render(<SettingsPage />);

    const section = await screen.findByTestId(panel);
    expect(section.closest("section")?.id).toBe(sectionId);
    expect(section.closest("section")?.hidden).toBe(false);
    expect(document.getElementById("branding")).toBeNull();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  test.each([
    "#branding",
    "#security/branding",
  ])("opens branding outside security at %s", (hash) => {
    router.hash = hash;
    render(<SettingsPage />);
    expect(screen.getByRole("heading", { name: "settings.tabs.branding" })).toBeTruthy();
    expect(document.getElementById("branding")).toBeTruthy();
    expect(screen.queryByTestId("settings-section-navigation")).toBeNull();
  });

  test("ships localized agent labels in both supported CP locales", () => {
    expect(en.cp.common.agentStatus).toMatchObject({ online: "Online", sick: "Unhealthy" });
    expect(zh.cp.common.agentStatus).toMatchObject({ online: "在线", sick: "异常" });
  });

  test.each([
    "#infrastructure/cluster-file-roots",
    "#security/sandbox-security",
    "#security/federation-trust",
    "#security/federation-storage",
    "#security/federation-permissions",
  ])("keeps a restricted platform hash explicit instead of falling back to personal settings: %s", (hash) => {
    router.hash = hash;
    router.role = "org_admin";
    render(<SettingsPage />);

    expect(screen.getByTestId("settings-restricted-deep-link")).toBeTruthy();
    expect(screen.queryByText("settings.personalSections.account.title")).toBeNull();
    expect(screen.getByText("settings.restrictedDeepLink.returnToAccessible")).toBeTruthy();
  });
});

vi.mock("../function-maps/FunctionMaps", () => ({ FunctionMaps: () => null }));

test.each([
  [522_000, "settings.sessionMinutes:9"],
  [0, "settings.sessionExpired"],
])("shows session validity in whole minutes: %s", (remaining, label) => {
  router.hash = "#personal/account";
  router.expiresAt = Date.now() + remaining;
  render(<SettingsPage />);
  expect(screen.getByTestId("settings-expiry-value").textContent).toBe(label);
  expect(screen.getByText("settings.tokenExpiresIn")).toBeTruthy();
});
