import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SoftwarePublisherRoute } from "./SoftwarePublisherRoute";

const mocks = vi.hoisted(() => ({
  getAuthState: vi.fn(),
  useSoftwarePublishingAccess: vi.fn(),
  retryCapabilities: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, hash, to }: { children: ReactNode; hash?: string; to: string }) => (
    <a href={`${to}${hash ? `#${hash}` : ""}`}>{children}</a>
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "software.manage.publishAccessTitle": "软件发布权限",
        "software.manage.publishAccessDenied": "当前账号无权发布软件",
        "software.manage.publishAccessGuidance": "请联系组织管理员申请软件发布权限。",
        "software.manage.backToSoftware": "返回软件中心",
        "workspace.capabilitiesFailedDescription": "权限信息暂时无法加载，请重试。",
        "workspace.retryCapabilities": "重新加载",
      })[key] ?? key,
  }),
}));

vi.mock("../../lib/software-publishing-access", () => ({
  useSoftwarePublishingAccess: mocks.useSoftwarePublishingAccess,
}));

vi.mock("../../lib/auth", () => ({
  getAuthState: mocks.getAuthState,
}));

beforeEach(() => {
  mocks.getAuthState.mockReturnValue({ role: "platform_admin" });
  mocks.retryCapabilities.mockReset();
  mocks.useSoftwarePublishingAccess.mockReturnValue({
    canPublish: false,
    ready: false,
    error: null,
    retry: mocks.retryCapabilities,
  });
});

describe("SoftwarePublisherRoute", () => {
  test("renders nothing until capabilities are ready", () => {
    const { container } = render(
      <SoftwarePublisherRoute>
        <div data-testid="publisher-content" />
      </SoftwarePublisherRoute>,
    );

    expect(container.childElementCount).toBe(0);
  });

  test("shows a recoverable capability failure without exposing internal errors", () => {
    const internalError = "Authorization denied";
    mocks.useSoftwarePublishingAccess.mockReturnValue({
      canPublish: false,
      ready: true,
      error: new Error(internalError),
      retry: mocks.retryCapabilities,
    });

    render(
      <SoftwarePublisherRoute>
        <div data-testid="publisher-content" />
      </SoftwarePublisherRoute>,
    );

    expect(screen.getByTestId("software-publisher-capability-error")).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("权限信息暂时无法加载，请重试。");
    expect(screen.getByRole("button", { name: "重新加载" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(mocks.retryCapabilities).toHaveBeenCalledOnce();
    expect(screen.queryByText(internalError)).toBeNull();
    expect(screen.queryByTestId("publisher-content")).toBeNull();
  });

  test("renders publisher content with software.publish", () => {
    mocks.useSoftwarePublishingAccess.mockReturnValue({
      canPublish: true,
      ready: true,
      error: null,
      retry: mocks.retryCapabilities,
    });

    render(
      <SoftwarePublisherRoute>
        <div data-testid="publisher-content" />
      </SoftwarePublisherRoute>,
    );

    expect(screen.getByTestId("publisher-content")).toBeDefined();
    expect(screen.queryByTestId("software-publisher-denied")).toBeNull();
  });

  test("shows a clear denial for organization publishers on platform-only publication", () => {
    mocks.getAuthState.mockReturnValue({ role: "org_admin" });
    mocks.useSoftwarePublishingAccess.mockReturnValue({
      canPublish: true,
      ready: true,
      error: null,
      retry: mocks.retryCapabilities,
    });

    render(
      <SoftwarePublisherRoute platformOnly returnSection="usecases">
        <div data-testid="publisher-content" />
      </SoftwarePublisherRoute>,
    );

    expect(screen.getByTestId("software-publisher-denied")).toBeDefined();
    expect(screen.getByText("当前账号无权发布软件")).toBeDefined();
    expect(screen.getByText("请联系组织管理员申请软件发布权限。")).toBeDefined();
    expect(screen.queryByText(/Authorization denied|FORBIDDEN/)).toBeNull();
    expect(screen.queryByTestId("publisher-content")).toBeNull();
    expect(screen.getByRole("link", { name: "返回软件中心" }).getAttribute("href")).toBe(
      "/software#usecases",
    );
  });
});
