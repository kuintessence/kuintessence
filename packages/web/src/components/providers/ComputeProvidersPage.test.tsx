import type { ComputeProviderDirectory } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setLang } from "../../lib/i18n";
import { nativeControl } from "../../lib/test-resource-field";
import { ComputeProvidersPage } from "./ComputeProvidersPage";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("../../lib/active-organization", () => ({ useActiveOrganizationId: () => "org-a" }));
vi.mock("../../lib/auth", () => ({ getAuthState: () => ({ revision: "test" }) }));
vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => ({ ready: true, allowed: true, error: null }),
}));
const directory: ComputeProviderDirectory = {
  canManage: true,
  total: 1,
  items: [
    {
      id: "org-a",
      name: "研究中心",
      profile: {
        description: "简介",
        contactName: "甲",
        email: "a@example.test",
        phone: "123",
        address: "地址",
        website: "https://example.test",
      },
      createdAt: "2026-11-03T00:00:00Z",
      updatedAt: "2026-11-03T00:00:00Z",
      agentCount: 4,
      centerCount: 1,
      memberCount: 2,
    },
  ],
};
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
function setup(mode: "provider" | "operator", response = directory) {
  setLang("zh");
  api.get.mockResolvedValue(response);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ComputeProvidersPage mode={mode} />
    </QueryClientProvider>,
  );
  return { client, ...view };
}
test.each([
  "provider",
  "operator",
] as const)("%s links center counts to the organization's existing resource management, including zero", async (mode) => {
  const { client, unmount } = setup(mode, {
    ...directory,
    canManage: false,
    items: directory.items.map((provider) => ({ ...provider, centerCount: 0 })),
  });
  expect(await screen.findByRole("columnheader", { name: "可用区" })).toBeTruthy();
  const link = await screen.findByRole("link", { name: "查看研究中心的可用区（0）" });
  expect(link.getAttribute("href")).toBe(
    `${mode === "operator" ? "/interconnect" : "/cp/interconnect"}?organizationId=org-a#availability-zones`,
  );
  expect(
    screen.getByText("算力中心下设可用区，集群归属于可用区。点击数量查看或配置。"),
  ).toBeTruthy();
  unmount();
  client.clear();
});
test("provider edits its profile without create/delete controls and refreshes organization names", async () => {
  const { client, unmount } = setup("provider");
  expect(await screen.findByText("研究中心")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "新增算力中心" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  fireEvent.change(nativeControl(screen.getByLabelText("名称")), {
    target: { value: "更新的中心" },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith("/compute-providers/provider/organizations/org-a", {
      name: "更新的中心",
      profile: directory.items[0]?.profile,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ["me", "active-organization"] });
  unmount();
  client.clear();
});
test("platform deletion requires confirmation and shows dependency failures", async () => {
  const { client, unmount } = setup("operator");
  fireEvent.click(await screen.findByRole("button", { name: "编辑资料" }));
  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(api.delete).not.toHaveBeenCalled();
  api.delete.mockRejectedValueOnce({ status: 409, message: "internal dependency constraint" });
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "该算力中心仍有关联成员、资源或历史业务记录，不能删除",
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  unmount();
  client.clear();
});
test("online revocation and query errors discard editor drafts", async () => {
  const { client, unmount } = setup("operator");
  fireEvent.click(await screen.findByRole("button", { name: "编辑资料" }));
  fireEvent.change(nativeControl(screen.getByLabelText("名称")), { target: { value: "旧草稿" } });
  api.get.mockResolvedValue({ ...directory, canManage: false });
  await act(() => client.invalidateQueries({ queryKey: ["compute-providers"] }));
  await waitFor(() => expect(screen.queryByLabelText("名称")).toBeNull());
  api.get.mockResolvedValue(directory);
  await act(() => client.invalidateQueries({ queryKey: ["compute-providers"] }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑资料" }));
  expect(nativeControl(screen.getByLabelText("名称"))).toHaveProperty("value", "研究中心");
  api.get.mockRejectedValue(new Error("断网"));
  await act(() => client.invalidateQueries({ queryKey: ["compute-providers"] }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  client.clear();
});

test("mobile policy keeps profile reads available without opening forbidden editors", async () => {
  sessionStorage.setItem("kq.mobile-management-policy", "observe-approve");
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const { client, unmount } = setup("operator");
  await screen.findByText("研究中心");
  expect(screen.getByText("请在电脑端编辑算力中心资料。")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "新增算力中心" })).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑资料" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "研究中心" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "编辑资料" })).toBeNull();
  unmount();
  client.clear();
});

test.each([
  "provider",
  "operator",
] as const)("%s links agent/member counts and offers view for read-only users", async (mode) => {
  const { client, unmount } = setup(mode, { ...directory, canManage: false });
  const agents = await screen.findByRole("link", { name: "查看研究中心的集群（4）" });
  const members = screen.getByRole("link", { name: "查看研究中心的成员（2）" });
  expect(agents.getAttribute("href")).toBe(
    mode === "operator"
      ? "/operations?organizationId=org-a#clusters"
      : "/cp/agents?organizationId=org-a",
  );
  expect(members.getAttribute("href")).toBe(
    mode === "operator"
      ? "/operations?organizationId=org-a#users"
      : "/cp/users?organizationId=org-a",
  );
  fireEvent.click(screen.getByRole("button", { name: "查看" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  unmount();
  client.clear();
});
