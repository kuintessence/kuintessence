import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthState: vi.fn(),
  isLocalMode: vi.fn(),
  useMeCapabilities: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "workflows.newWorkflowTitle": "新建工作流",
        "workflows.title": "工作流",
        "workflows.creation.accessDenied": "当前账号无权创建工作流",
        "workflows.creation.accessGuidance": "请联系组织管理员申请工作流提交权限。",
        "workspace.capabilitiesFailedDescription": "权限信息暂时无法加载，请重试。",
        "workspace.retryCapabilities": "重新加载",
      })[key] ?? key,
  }),
}));

vi.mock("../../components/ProtectedRoute", () => ({
  ProtectedRoute: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock("../../components/workflows/NewWorkflowPage", () => ({
  NewWorkflowPage: () => <div data-testid="new-workflow-page" />,
}));

vi.mock("../../lib/auth", () => ({ getAuthState: mocks.getAuthState }));
vi.mock("../../lib/local-mode", () => ({ isLocalMode: mocks.isLocalMode }));
vi.mock("../../lib/platform-capabilities", () => ({
  toCapabilitySet: (data: { capabilities?: string[] } | null) => new Set(data?.capabilities ?? []),
  useMeCapabilities: mocks.useMeCapabilities,
}));

import { Route } from "./new";

function renderRoute() {
  const component = (Route as unknown as { options: { component: () => ReactNode } }).options
    .component;
  return render(component());
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("workflow creation route", () => {
  test("does not render the editor while a remote session capability check is loading", () => {
    mocks.getAuthState.mockReturnValue({ isAuthenticated: true });
    mocks.isLocalMode.mockReturnValue(false);
    mocks.useMeCapabilities.mockReturnValue({ status: "loading", data: null });

    renderRoute();

    expect(screen.queryByTestId("new-workflow-page")).toBeNull();
    expect(screen.queryByTestId("workflow-create-capability-error")).toBeNull();
  });

  test("shows a recoverable capability failure and retries without exposing internal errors", () => {
    const retry = vi.fn();
    mocks.getAuthState.mockReturnValue({ isAuthenticated: true });
    mocks.isLocalMode.mockReturnValue(false);
    mocks.useMeCapabilities.mockReturnValue({
      status: "error",
      data: null,
      error: new Error("Authorization denied"),
      retry,
    });

    renderRoute();

    expect(screen.getByTestId("workflow-create-capability-error")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("权限信息暂时无法加载，请重试。");
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText("Authorization denied")).toBeNull();
    expect(screen.queryByTestId("new-workflow-page")).toBeNull();
  });

  test("shows a clear denial for a remote user without workflow submission capability", () => {
    mocks.getAuthState.mockReturnValue({ isAuthenticated: true });
    mocks.isLocalMode.mockReturnValue(false);
    mocks.useMeCapabilities.mockReturnValue({
      status: "ready",
      data: { capabilities: [] },
      error: null,
      retry: vi.fn(),
    });

    renderRoute();

    expect(screen.getByTestId("workflow-create-denied")).toBeTruthy();
    expect(screen.getByText("当前账号无权创建工作流")).toBeTruthy();
    expect(screen.getByText("请联系组织管理员申请工作流提交权限。")).toBeTruthy();
    expect(screen.queryByText(/Authorization denied|FORBIDDEN/)).toBeNull();
    expect(screen.queryByTestId("new-workflow-page")).toBeNull();
  });

  test("renders the editor when the workflow submission capability is ready", () => {
    mocks.getAuthState.mockReturnValue({ isAuthenticated: true });
    mocks.isLocalMode.mockReturnValue(false);
    mocks.useMeCapabilities.mockReturnValue({
      status: "ready",
      data: { capabilities: ["workflow.submit"] },
      error: null,
      retry: vi.fn(),
    });

    renderRoute();

    expect(screen.getByTestId("new-workflow-page")).toBeTruthy();
  });

  test("keeps the local workflow creation path available", () => {
    mocks.getAuthState.mockReturnValue({ isAuthenticated: true });
    mocks.isLocalMode.mockReturnValue(true);
    mocks.useMeCapabilities.mockReturnValue({ status: "idle", data: null });

    renderRoute();

    expect(screen.getByTestId("new-workflow-page")).toBeTruthy();
  });
});
