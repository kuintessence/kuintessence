import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), review: vi.fn(), organization: "org-a" }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../lib/active-organization", () => ({
  useActiveOrganizationId: () => mocks.organization,
}));
vi.mock("../../lib/sandbox-client", () => ({
  listSandboxMappingReviewQueue: mocks.list,
  reviewSandboxAccountMapping: mocks.review,
}));

import { SandboxMappingReviewPanel } from "./SandboxMappingReviewPanel";

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}
const row = {
  mapping: { id: "mapping-a", userId: "internal-user-id" },
  account: { displayName: "科研账号", agentId: "slurm", backendType: "unix" },
  applicant: { displayName: "张三", email: "zhang@example.test" },
  canReview: true,
};
beforeEach(() => {
  mocks.organization = "org-a";
  mocks.list.mockReset();
  mocks.review.mockReset().mockResolvedValue(undefined);
});

test("identifies the applicant by name and email and removes a reviewed request", async () => {
  mocks.list.mockResolvedValueOnce([row]).mockResolvedValue([]);
  render(<SandboxMappingReviewPanel />, { wrapper: wrapper() });
  expect(await screen.findByText("张三")).toBeTruthy();
  expect(screen.getByText("zhang@example.test")).toBeTruthy();
  expect(screen.queryByText(/internal-user-id/)).toBeNull();
  fireEvent.click(screen.getByText("sandbox.accounts.approve"));
  await waitFor(() => expect(mocks.review).toHaveBeenCalledWith("mapping-a", "approved"));
  expect(await screen.findByText("sandbox.accounts.reviewEmpty")).toBeTruthy();
});

test("cannot review without delegation and switches the cached queue with the organization", async () => {
  mocks.list.mockResolvedValueOnce([{ ...row, canReview: false }]).mockResolvedValue([]);
  const { rerender } = render(<SandboxMappingReviewPanel />, { wrapper: wrapper() });
  await screen.findByText("张三");
  expect(screen.queryByText("sandbox.accounts.approve")).toBeNull();
  expect(screen.queryByText("sandbox.accounts.reject")).toBeNull();
  expect(screen.getByText("sandbox.accounts.delegationRequired")).toBeTruthy();
  expect(mocks.review).not.toHaveBeenCalled();
  mocks.organization = "org-b";
  rerender(<SandboxMappingReviewPanel />);
  expect(await screen.findByText("sandbox.accounts.reviewEmpty")).toBeTruthy();
  expect(screen.queryByText("张三")).toBeNull();
  expect(mocks.list).toHaveBeenCalledTimes(2);
});
