import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const access = vi.hoisted(() => ({
  allowed: false,
  ready: true,
  error: null as Error | null,
  retry: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "workspace.capabilitiesFailedDescription": "权限信息暂时无法加载，请重试。",
        "workspace.retryCapabilities": "重新加载",
      })[key] ?? key,
  }),
}));

vi.mock("../lib/platform-capabilities", () => ({
  usePlatformCapability: () => access,
}));

vi.mock("../components/cp/SoftwarePolicyTable", () => ({
  SoftwarePolicyTable: () => <div data-testid="software-policy-table" />,
}));

vi.mock("../components/software/RecipeRepositoriesPanel", () => ({
  RecipeRepositoriesPanel: ({ canManage }: { canManage: boolean }) => (
    <div data-testid="recipe-repositories-panel" data-can-manage={canManage} />
  ),
}));

vi.mock("../components/software/SpackMaterialsPanel", () => ({
  SpackMaterialsPanel: ({ canManage }: { canManage: boolean }) => (
    <div data-testid="spack-materials-panel" data-can-manage={canManage} />
  ),
}));

vi.mock("../components/cp/MeteringPage", () => ({
  MeteringPage: () => <div data-testid="metering-page" />,
}));

import { CpMeteringPage } from "./cp.metering";
import { CpSoftwarePage } from "./cp.software";

describe("CP capability-dependent routes", () => {
  beforeEach(() => {
    access.allowed = false;
    access.ready = true;
    access.error = null;
    access.retry.mockReset();
  });

  test.each([true, false])("mounts recipe management with CP capability %s", (allowed) => {
    access.allowed = allowed;
    render(<CpSoftwarePage />);
    expect(screen.getByTestId("recipe-repositories-panel").getAttribute("data-can-manage")).toBe(
      String(allowed),
    );
    expect(screen.getByTestId("software-policy-table")).toBeTruthy();
    expect(screen.getByTestId("spack-materials-panel").getAttribute("data-can-manage")).toBe(
      String(allowed),
    );
  });

  test.each([
    ["software", CpSoftwarePage, "software-policy-table"],
    ["metering", CpMeteringPage, "metering-page"],
  ])("shows a recoverable %s capability failure", (_name, Page, contentTestId) => {
    access.error = new Error("Authorization denied: FORBIDDEN");

    render(<Page />);

    expect(screen.getByRole("alert").textContent).toContain("权限信息暂时无法加载，请重试。");
    expect(screen.queryByText(/Authorization denied|FORBIDDEN/)).toBeNull();
    expect(screen.queryByTestId(contentTestId)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重新加载" }));
    expect(access.retry).toHaveBeenCalledOnce();
  });
});
