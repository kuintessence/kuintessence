import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isMobileHighRiskMutationBlocked,
  setMobileManagementPolicy,
} from "./mobile-management-policy";

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("mobile management policy", () => {
  test("blocks high-risk administration changes on compact screens", () => {
    vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true } as MediaQueryList);
    setMobileManagementPolicy(true);
    expect(isMobileHighRiskMutationBlocked("/admin/sso")).toBe(true);
    expect(isMobileHighRiskMutationBlocked("/cp/queues/q1")).toBe(true);
    expect(isMobileHighRiskMutationBlocked("/software/workflow-templates")).toBe(true);
  });

  test("keeps approval actions and desktop changes available", () => {
    const media = vi.spyOn(window, "matchMedia");
    media.mockReturnValue({ matches: true } as MediaQueryList);
    setMobileManagementPolicy(true);
    expect(isMobileHighRiskMutationBlocked("/admin/access-requests/r1/approve")).toBe(false);
    expect(isMobileHighRiskMutationBlocked("/cp/software/preinstalled/r1/review")).toBe(false);
    media.mockReturnValue({ matches: false } as MediaQueryList);
    expect(isMobileHighRiskMutationBlocked("/admin/sso")).toBe(false);
  });
});
