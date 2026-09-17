import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const access = vi.hoisted(() => ({
  allowed: false,
  ready: true,
  error: null as Error | null,
  retry: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useParams: () => ({ agentId: "a-1" }) }),
  Link: ({ children }: { children: ReactNode }) => <a href="/agents">{children}</a>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../lib/platform-capabilities", () => ({
  usePlatformCapability: () => access,
}));

vi.mock("../components/ssh/SshTerminal", () => ({
  SshTerminal: ({ agentId }: { agentId: string }) => (
    <div data-testid="ssh-terminal">{agentId}</div>
  ),
}));

import { SshRoutePage } from "./agents.$agentId.ssh";

describe("SshRoutePage", () => {
  beforeEach(() => {
    access.allowed = false;
    access.ready = true;
    access.error = null;
    access.retry.mockReset();
  });

  test("waits for terminal capability resolution", () => {
    access.ready = false;

    render(<SshRoutePage agentId="agent-membership" />);

    expect(screen.queryByTestId("ssh-rbac-denied")).toBeNull();
    expect(screen.queryByTestId("ssh-terminal")).toBeNull();
  });

  test("allows provider membership represented by terminal.open", () => {
    access.allowed = true;

    render(<SshRoutePage agentId="agent-membership" />);

    expect(screen.getByTestId("ssh-terminal").textContent).toBe("agent-membership");
    expect(screen.queryByTestId("ssh-rbac-denied")).toBeNull();
  });

  test("shows a stable denial without terminal.open", () => {
    render(<SshRoutePage agentId="agent-denied" />);

    expect(screen.getByTestId("ssh-rbac-denied")).toBeTruthy();
    expect(screen.queryByTestId("ssh-terminal")).toBeNull();
  });

  test("shows a recoverable capability failure instead of an authorization denial", () => {
    access.error = new Error("network unavailable");

    render(<SshRoutePage agentId="agent-membership" />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("ssh-rbac-denied")).toBeNull();
  });
});
