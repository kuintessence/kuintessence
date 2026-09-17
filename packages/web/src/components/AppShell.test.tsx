import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveDocsUrl } from "./WorkspaceSidebar";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock("../lib/local-mode", () => ({
  isLocalMode: vi.fn(() => false),
  localApiBase: () => undefined,
  localToken: () => undefined,
  useLocalCapabilities: vi.fn(() => null),
}));

vi.mock("../lib/api-client", () => ({
  api: { get: vi.fn(() => Promise.resolve({})) },
  refreshAuthSession: vi.fn(() => {
    localStorage.setItem("kq_session", "cookie");
    localStorage.setItem("kq_email", "qa@example.com");
    localStorage.setItem("kq_role", "user");
    localStorage.setItem("kq_token_expires_at", String(Date.now() + 900_000));
    return Promise.resolve(true);
  }),
}));

vi.mock("../lib/platform-capabilities", () => ({
  toCapabilitySet: (data: { capabilities?: string[] } | null) => new Set(data?.capabilities ?? []),
  useMeCapabilities: () => {
    const role = localStorage.getItem("kq_role");
    const elevated = role === "super_admin" || role === "platform_admin";
    const platformViewer = elevated || role === "operator";
    const auditReadonly = localStorage.getItem("kq_test_audit_readonly") === "true";
    return {
      status: "ready" as const,
      data: {
        capabilities: [
          "workspace.consumer.access",
          "workspace.ecosystem.view",
          "workspace.personal.access",
          ...(platformViewer
            ? [
                "workspace.platform.view",
                ...(elevated
                  ? [
                      "workspace.provider.view",
                      "workspace.provider.manage",
                      "workspace.platform.manage",
                      "terminal.open",
                    ]
                  : []),
              ]
            : []),
          ...(auditReadonly ? ["workspace.audit.view", "audit.view", "metering.report.view"] : []),
        ],
      },
      error: null,
      retry: vi.fn(),
    };
  },
}));

vi.mock("./ThemeProvider", () => ({
  useTheme: () => ({ theme: "light", setTheme: vi.fn(), resolved: "light" as const }),
}));

const router = vi.hoisted(() => ({ navigate: vi.fn(), pathname: "/", hash: "" }));

// Stub the router so we can render <AppShell /> in isolation without a full
// RouterProvider — we only assert on which sidebar nav links are present.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    hash,
    children,
    ...rest
  }: {
    to: string;
    hash?: string;
    children: ReactNode;
    "data-testid"?: string;
  }) => (
    <a href={`${to}${hash ? `#${hash}` : ""}`} {...rest}>
      {children}
    </a>
  ),
  Outlet: () => null,
  useNavigate: () => router.navigate,
  useRouterState: ({
    select,
  }: {
    select: (state: { location: { pathname: string; hash: string } }) => unknown;
  }) => select({ location: { pathname: router.pathname, hash: router.hash } }),
}));

import { refreshAuthSession } from "../lib/api-client";
import { setAuth } from "../lib/auth";
import { isLocalMode, type LocalCapabilities, useLocalCapabilities } from "../lib/local-mode";
import { AppShell } from "./AppShell";

const mockedIsLocalMode = vi.mocked(isLocalMode);
const mockedUseLocalCapabilities = vi.mocked(useLocalCapabilities);
const mockedRefreshAuthSession = vi.mocked(refreshAuthSession);

const ALL_CAPS: LocalCapabilities = {
  jobs: true,
  submit: true,
  logs: true,
  workflows: true,
  agents: true,
  metrics: true,
  software: true,
  ssh: false,
};

beforeEach(() => {
  // super_admin passes every role-gated nav item (incl. /cp), isolating the
  // local-mode drop from the role filter.
  localStorage.setItem("kq_token", "test-token");
  localStorage.setItem("kq_email", "qa@example.com");
  localStorage.setItem("kq_role", "super_admin");
  localStorage.setItem("kq.sidebar-expanded", "true");
  router.pathname = "/";
  router.hash = "";
});

afterEach(() => {
  vi.clearAllMocks();
  mockedIsLocalMode.mockReturnValue(false);
  mockedUseLocalCapabilities.mockReturnValue(null);
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("AppShell sidebar — Server mode", () => {
  test("shows permission-scoped workspace domains and consumer navigation", () => {
    mockedIsLocalMode.mockReturnValue(false);
    // Server mode must not consult capabilities, even if the hook somehow returns
    // a restrictive set.
    mockedUseLocalCapabilities.mockReturnValue({ ...ALL_CAPS, agents: false, software: false });
    render(<AppShell />);
    expect(screen.queryByTestId("workspace-domain-provider")).toBeTruthy();
    expect(screen.queryByTestId("workspace-domain-platform")).toBeTruthy();
    expect(screen.queryByTestId("workspace-domain-ecosystem")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-nav-terminal")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-nav-files")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-nav-jobs")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-nav-workflows")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-nav-agents")).toBeTruthy();
    expect(screen.queryByTestId("env-badge")).toBeNull();
    expect(screen.queryByText(window.location.host)).toBeNull();
  });

  test("hides the command console from ordinary users", () => {
    localStorage.setItem("kq_role", "user");

    render(<AppShell />);

    expect(screen.queryByTestId("workspace-domain-provider")).toBeNull();
    expect(screen.queryByTestId("workspace-domain-platform")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-terminal")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-files")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-nav-jobs")).toBeTruthy();
  });

  test("gives an audit-readonly user a platform audit context without management", () => {
    localStorage.setItem("kq_role", "user");
    localStorage.setItem("kq_test_audit_readonly", "true");
    router.pathname = "/operations";
    router.hash = "#audit";

    render(<AppShell />);

    expect(screen.getByTestId("workspace-domain-platform")).toBeTruthy();
    expect(screen.getByTestId("workspace-nav-settings-operations-link-audit-title")).toBeTruthy();
    expect(
      screen.getByTestId("workspace-nav-settings-operations-link-metering-title"),
    ).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-workspace-nav-operationsOverview")).toBeNull();
    expect(screen.queryByTestId("workspace-domain-provider")).toBeNull();
  });

  test("moves sidebar collapse to the bottom and removes version metadata", () => {
    render(<AppShell />);

    expect(screen.queryByText(/v\d+\.\d+\.\d+/)).toBeNull();
    expect(screen.queryByText("workspace.currentBoundary")).toBeNull();
    expect(screen.getByText("Kuintessence")).toBeTruthy();
    expect(screen.getByTestId("sidebar").getAttribute("data-expanded")).toBe("true");
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(screen.getByTestId("sidebar").getAttribute("data-expanded")).toBe("false");
  });

  test("opens the published documentation from the help control", () => {
    render(<AppShell />);

    const help = screen.getByTestId("workspace-help-link");
    expect(help.getAttribute("href")).toBe("https://kuintessence.github.io/kuintessence/");
    expect(help.getAttribute("target")).toBe("_blank");
    expect(help.getAttribute("rel")).toBe("noreferrer");
    expect(resolveDocsUrl("   ")).toBe("https://kuintessence.github.io/kuintessence/");
    expect(resolveDocsUrl("https://docs.example.test/guide")).toBe(
      "https://docs.example.test/guide",
    );
  });

  test("updates workspace navigation immediately after an auth role change", async () => {
    setAuth({ email: "qa@example.com", expiresIn: 900, role: "user" });
    render(<AppShell />);
    expect(screen.queryByTestId("workspace-domain-provider")).toBeNull();

    setAuth({ email: "qa@example.com", expiresIn: 900, role: "super_admin" });

    await waitFor(() => expect(screen.getByTestId("workspace-domain-provider")).toBeTruthy());
  });

  test("keeps the desktop sidebar expanded after workspace navigation", () => {
    render(<AppShell />);

    fireEvent.click(screen.getByTestId("workspace-nav-nav-jobs"));

    expect(screen.getByTestId("sidebar").getAttribute("data-expanded")).toBe("true");
  });

  test("closes the overlay sidebar after mobile workspace navigation", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          addEventListener: vi.fn(),
          matches: query === "(max-width: 767px)",
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    render(<AppShell />);

    expect(screen.getByTestId("sidebar-backdrop")).toBeTruthy();
    fireEvent.click(screen.getByTestId("workspace-nav-nav-jobs"));

    expect(screen.getByTestId("sidebar").getAttribute("data-expanded")).toBe("false");
    expect(screen.queryByTestId("sidebar-backdrop")).toBeNull();
  });

  test("keeps expanded content aligned with the actual sidebar width", () => {
    const { container } = render(<AppShell />);

    const content = container.querySelector(".flex.min-h-screen.flex-col");
    expect(content?.className).toContain("md:pl-64");
    expect(content?.className).toContain("xl:pl-72");
    expect(content?.className).not.toContain("xl:pl-96");
  });

  test("navigates to the parent catalog tab instead of toggling the sidebar", () => {
    router.pathname = "/software/scripts/script-1";
    render(<AppShell />);

    fireEvent.click(screen.getByTestId("navigate-parent"));
    expect(router.navigate).toHaveBeenCalledWith({ to: "/software", hash: "scripts" });
    expect(screen.getByTestId("sidebar").getAttribute("data-expanded")).toBe("true");
  });

  test("switches the single provider entrance to its canonical overview", () => {
    render(<AppShell />);

    fireEvent.click(screen.getByTestId("workspace-domain-provider"));

    expect(router.navigate).toHaveBeenCalledWith({ to: "/cp" });
  });

  test("combines provider operations and technical entries in one context menu", () => {
    router.pathname = "/cp/infrastructure";
    render(<AppShell />);

    expect(screen.getByTestId("workspace-context-header").textContent).toContain(
      "workspace.domain.provider",
    );
    expect(screen.queryByTestId("workspace-nav-cp-nav-infrastructure")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-cp-nav-users")).toBeTruthy();
  });

  test("opens platform capabilities from the platform context card", async () => {
    router.pathname = "/operations";
    router.hash = "#overview";
    render(<AppShell />);

    fireEvent.pointerDown(screen.getByTestId("workspace-platform-capabilities-trigger"), {
      button: 0,
      ctrlKey: false,
    });

    const authz = await screen.findByTestId("platform-capability-authz");
    const metering = screen.getByTestId("platform-capability-metering");
    expect(authz.getAttribute("href")).toBe("/settings#security/authz");
    expect(authz.getAttribute("target")).toBe("_blank");
    expect(metering.getAttribute("href")).toBe("/cp/metering");
    expect(screen.queryByTestId("workspace-nav-workspace-nav-operationsSecurity")).toBeNull();
  });

  test("routes operator read-only capabilities outside the CP management shell", async () => {
    localStorage.setItem("kq_role", "operator");
    router.pathname = "/operations";
    render(<AppShell />);

    fireEvent.pointerDown(screen.getByTestId("workspace-platform-capabilities-trigger"), {
      button: 0,
      ctrlKey: false,
    });

    expect((await screen.findByTestId("platform-capability-metering")).getAttribute("href")).toBe(
      "/operations#metering",
    );
    expect(screen.getByTestId("platform-capability-audit").getAttribute("href")).toBe(
      "/operations#audit",
    );
    expect(screen.queryByTestId("platform-capability-authz")).toBeNull();
  });

  test("displays the username in the topbar instead of the full email", () => {
    render(<AppShell />);

    const userMenu = screen.getByTestId("user-menu");
    expect(userMenu.textContent).toContain("qa");
    expect(userMenu.textContent).not.toContain("qa@example.com");
  });
});

describe("AppShell sidebar — local mode", () => {
  test("hides Server-only domains and routes while retaining local workspaces", () => {
    mockedIsLocalMode.mockReturnValue(true);
    mockedUseLocalCapabilities.mockReturnValue(ALL_CAPS);
    render(<AppShell />);
    expect(screen.queryByTestId("workspace-domain-provider")).toBeNull();
    expect(screen.queryByTestId("workspace-domain-platform")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-terminal")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-files")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-jobs")).toBeTruthy();
    expect(screen.queryByTestId("workspace-domain-personal")).toBeTruthy();
  });

  test("hides nav items whose backing capability is false", () => {
    mockedIsLocalMode.mockReturnValue(true);
    mockedUseLocalCapabilities.mockReturnValue({
      ...ALL_CAPS,
      agents: false,
      workflows: true,
      software: false,
    });
    render(<AppShell />);
    expect(screen.queryByTestId("workspace-nav-nav-agents")).toBeNull();
    expect(screen.queryByTestId("workspace-domain-ecosystem")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-workflows")).toBeTruthy();
    expect(screen.queryByTestId("workspace-nav-nav-jobs")).toBeTruthy();
  });

  test("hides agents/workflows/software until capabilities are known", () => {
    mockedIsLocalMode.mockReturnValue(true);
    mockedUseLocalCapabilities.mockReturnValue(null);
    render(<AppShell />);
    expect(screen.queryByTestId("workspace-nav-nav-agents")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-workflows")).toBeNull();
    expect(screen.queryByTestId("workspace-domain-ecosystem")).toBeNull();
    expect(screen.queryByTestId("workspace-nav-nav-jobs")).toBeTruthy();
    expect(screen.queryByTestId("workspace-domain-personal")).toBeTruthy();
  });
});

describe("AppShell auth metadata", () => {
  test("does not trust role from a cookie-session landing URL", async () => {
    mockedIsLocalMode.mockReturnValue(false);
    window.history.replaceState(
      {},
      "",
      "/?session=cookie&email=qa%40example.com&expiresIn=900&role=platform_admin",
    );

    render(<AppShell />);

    expect(localStorage.getItem("kq_role")).toBeNull();
    expect(screen.queryByTestId("workspace-domain-provider")).toBeNull();
    await waitFor(() => expect(mockedRefreshAuthSession).toHaveBeenCalled());
    await waitFor(() => expect(localStorage.getItem("kq_role")).toBe("user"));
    expect(screen.queryByTestId("workspace-domain-provider")).toBeNull();
  });
});
