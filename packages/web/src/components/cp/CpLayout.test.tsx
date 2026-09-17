import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const capabilityAccess = vi.hoisted(() => ({
  allowed: false,
  ready: true,
  error: null as Error | null,
  retry: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "cp.access.viewRequired"
        ? "当前账号无法进入算力提供方控制台，请联系组织管理员开通访问权限。"
        : key,
  }),
}));

vi.mock("./ProviderOrganizationSelector", () => ({
  ProviderOrganizationSelector: () => <div data-testid="provider-organization-selector" />,
}));

vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => capabilityAccess,
}));

import { CpLayout } from "./CpLayout";

function setRole(role: string | null) {
  localStorage.clear();
  localStorage.setItem("kq_session", "cookie");
  localStorage.setItem("kq_email", "cp-layout@test.local");
  if (role) localStorage.setItem("kq_role", role);
}

describe("CpLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    capabilityAccess.allowed = false;
    capabilityAccess.ready = true;
    capabilityAccess.error = null;
    capabilityAccess.retry.mockReset();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("denies a principal without provider view capability", () => {
    setRole("user");

    render(
      <CpLayout>
        <div data-testid="cp-child" />
      </CpLayout>,
    );

    expect(screen.getByTestId("cp-rbac-denied").textContent).toContain(
      "请联系组织管理员开通访问权限",
    );
    expect(screen.getByTestId("cp-rbac-denied").textContent).not.toMatch(
      /Authorization denied|FORBIDDEN|cp\.access/,
    );
    expect(screen.queryByTestId("cp-child")).toBeNull();
  });

  test("waits for the authoritative capability response", () => {
    capabilityAccess.ready = false;

    render(
      <CpLayout>
        <div data-testid="cp-child" />
      </CpLayout>,
    );

    expect(screen.queryByTestId("cp-rbac-denied")).toBeNull();
    expect(screen.queryByTestId("cp-child")).toBeNull();
  });

  test("allows a technical user with provider organization membership", () => {
    setRole("user");
    capabilityAccess.allowed = true;

    render(
      <CpLayout>
        <div data-testid="cp-child" />
      </CpLayout>,
    );

    expect(screen.queryByTestId("cp-tabs")).toBeNull();
    expect(screen.getByTestId("cp-child")).toBeTruthy();
  });

  test("shows a recoverable capability load failure instead of denying access", () => {
    capabilityAccess.error = new Error("network unavailable");

    render(
      <CpLayout>
        <div data-testid="cp-child" />
      </CpLayout>,
    );

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("cp-rbac-denied")).toBeNull();
  });
});
