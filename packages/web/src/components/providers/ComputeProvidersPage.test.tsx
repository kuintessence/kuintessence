import type { ComputeProviderDirectory } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setLang } from "../../lib/i18n";
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
afterEach(() => vi.clearAllMocks());
function setup(mode: "provider" | "operator") {
  setLang("zh");
  api.get.mockResolvedValue(directory);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ComputeProvidersPage mode={mode} />
    </QueryClientProvider>,
  );
  return { client, ...view };
}
test("provider edits its profile without create/delete controls and refreshes organization names", async () => {
  const { client, unmount } = setup("provider");
  expect(await screen.findByText("研究中心")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "新增提供者" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "编辑资料" }));
  expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "更新的中心" } });
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
  api.delete.mockRejectedValueOnce(new Error("该提供者仍有关联成员、资源或历史业务记录，不能删除"));
  fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "该提供者仍有关联成员、资源或历史业务记录，不能删除",
  );
  expect(screen.getByRole("dialog")).toBeTruthy();
  unmount();
  client.clear();
});
test("online revocation and query errors discard editor drafts", async () => {
  const { client, unmount } = setup("operator");
  fireEvent.click(await screen.findByRole("button", { name: "编辑资料" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "旧草稿" } });
  api.get.mockResolvedValue({ ...directory, canManage: false });
  await act(() => client.invalidateQueries({ queryKey: ["compute-providers"] }));
  await waitFor(() => expect(screen.queryByLabelText("名称")).toBeNull());
  api.get.mockResolvedValue(directory);
  await act(() => client.invalidateQueries({ queryKey: ["compute-providers"] }));
  fireEvent.click(await screen.findByRole("button", { name: "编辑资料" }));
  expect(screen.getByLabelText("名称")).toHaveProperty("value", "研究中心");
  api.get.mockRejectedValue(new Error("断网"));
  await act(() => client.invalidateQueries({ queryKey: ["compute-providers"] }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).toBeNull();
  unmount();
  client.clear();
});
