import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const access = vi.hoisted(() => ({
  allowed: false,
  ready: true,
  error: null as Error | null,
  retry: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key === "cp.access.manageRequired"
        ? "当前账号只能查看此页面，请联系算力组织管理员开通管理权限。"
        : key,
  }),
}));

vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => access,
}));

import { CpManageBoundary } from "./CpManageBoundary";

describe("CpManageBoundary", () => {
  beforeEach(() => {
    access.allowed = false;
    access.ready = true;
    access.error = null;
    access.retry.mockReset();
  });

  test("keeps provider operator membership out of management pages", () => {
    render(
      <CpManageBoundary>
        <div data-testid="manage-page" />
      </CpManageBoundary>,
    );

    expect(screen.getByTestId("cp-manage-denied").textContent).toContain(
      "请联系算力组织管理员开通管理权限",
    );
    expect(screen.getByTestId("cp-manage-denied").textContent).not.toMatch(
      /Authorization denied|FORBIDDEN|cp\.access/,
    );
    expect(screen.queryByTestId("manage-page")).toBeNull();
  });

  test("allows provider owner or administrator management capability", () => {
    access.allowed = true;

    render(
      <CpManageBoundary>
        <div data-testid="manage-page" />
      </CpManageBoundary>,
    );

    expect(screen.getByTestId("manage-page")).toBeTruthy();
  });
});
