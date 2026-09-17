import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { CpInfrastructurePage } from "./CpInfrastructurePage";

const mocks = vi.hoisted(() => ({
  agentsRefetch: vi.fn(),
  softwareRefetch: vi.fn(),
  useCpAgents: vi.fn(),
  useCpSoftwareOverview: vi.fn(),
  role: "platform_admin",
}));

vi.mock("../../lib/use-cp-agents", () => ({ useCpAgents: mocks.useCpAgents }));
vi.mock("../../lib/use-cp-software", () => ({
  useCpSoftwareOverview: mocks.useCpSoftwareOverview,
}));
vi.mock("../../lib/auth", () => ({ getAuthState: () => ({ role: mocks.role }) }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, hash }: { children: React.ReactNode; to: string; hash?: string }) => (
    <a href={`${to}${hash ? `#${hash}` : ""}`}>{children}</a>
  ),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("CpInfrastructurePage", () => {
  beforeEach(() => {
    mocks.agentsRefetch.mockReset();
    mocks.softwareRefetch.mockReset();
    mocks.useCpAgents.mockReset();
    mocks.useCpSoftwareOverview.mockReset();
    mocks.role = "platform_admin";
  });

  test("distinguishes unavailable metrics from a real zero and retries failed sources", () => {
    mocks.useCpAgents.mockReturnValue({
      data: undefined,
      isError: true,
      isSuccess: false,
      refetch: mocks.agentsRefetch,
    });
    mocks.useCpSoftwareOverview.mockReturnValue({
      data: { summary: { clusters: 2, installedSpecs: 7 } },
      isError: false,
      isSuccess: true,
      refetch: mocks.softwareRefetch,
    });

    render(<CpInfrastructurePage />);

    expect(screen.getByTestId("cp-infrastructure-error")).toBeTruthy();
    expect(screen.getByText("--")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();

    fireEvent.click(screen.getByText("common.retry"));
    expect(mocks.agentsRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.softwareRefetch).not.toHaveBeenCalled();
  });

  test("links the Sandbox card to the security Settings section", () => {
    mocks.useCpAgents.mockReturnValue({
      data: [],
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    });
    mocks.useCpSoftwareOverview.mockReturnValue({
      data: { summary: { clusters: 0, installedSpecs: 0 } },
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    });

    render(<CpInfrastructurePage />);

    expect(screen.getByText("cp.infrastructure.link.sandbox.title").closest("a")).toHaveProperty(
      "href",
      "http://localhost:3000/settings#security/sandbox-security",
    );
  });

  test("replaces the Sandbox Settings dead link with platform-admin guidance for CP admins", () => {
    mocks.role = "org_admin";
    mocks.useCpAgents.mockReturnValue({
      data: [],
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    });
    mocks.useCpSoftwareOverview.mockReturnValue({
      data: { summary: { clusters: 0, installedSpecs: 0 } },
      isError: false,
      isSuccess: true,
      refetch: vi.fn(),
    });

    render(<CpInfrastructurePage />);

    expect(screen.getByTestId("cp-infrastructure-sandbox-restricted")).toBeTruthy();
    expect(screen.queryByText("cp.infrastructure.link.sandbox.title")?.closest("a")).toBeNull();
    expect(screen.getByText("cp.infrastructure.link.sandbox.restricted")).toBeTruthy();
  });
});
