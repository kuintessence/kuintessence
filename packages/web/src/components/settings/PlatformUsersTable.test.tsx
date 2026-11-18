import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setLang } from "../../lib/i18n";
import { nativeControl } from "../../lib/test-resource-field";
import { PlatformUsersTable } from "./PlatformUsersTable";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("../../lib/active-organization", () => ({
  useActiveOrganizationId: () => null,
  getActiveOrganizationContext: vi.fn(),
}));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({ useMobileMutationBlocked: () => false }));
afterEach(() => vi.resetAllMocks());

test("shows provider ownership and requires a reason before changing a user's status", async () => {
  setLang("zh");
  api.get.mockResolvedValue({
    total: 2,
    items: [
      {
        id: "user",
        email: "researcher@example.test",
        displayName: "研究用户",
        role: "user",
        suspended: false,
        canManage: true,
        organizations: [{ id: "p", name: "研究中心" }],
      },
      {
        id: "admin",
        email: "admin@example.test",
        role: "platform_admin",
        suspended: false,
        canManage: false,
        organizations: [],
      },
    ],
  });
  api.patch.mockResolvedValue({ id: "user", suspended: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PlatformUsersTable />
    </QueryClientProvider>,
  );
  await screen.findByText("研究中心");
  fireEvent.click(screen.getByRole("button", { name: "成员" }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith(expect.stringContaining("sort=member")));
  fireEvent.change(screen.getByRole("combobox", { name: "状态" }), {
    target: { value: "enabled" },
  });
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("status=enabled")),
  );
  await screen.findByText("研究中心");
  expect(screen.getAllByRole("button", { name: "停用" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "停用" }));
  expect(screen.getByRole("button", { name: "确认" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(nativeControl(screen.getByLabelText("操作原因")), {
    target: { value: "账号访问审查" },
  });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() =>
    expect(api.patch).toHaveBeenCalledWith("/platform/users/user/status", {
      suspended: true,
      reason: "账号访问审查",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.change(nativeControl(screen.getByRole("textbox", { name: "搜索成员" })), {
    target: { value: "researcher" },
  });
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("search=researcher")),
  );
  view.unmount();
  client.clear();
});

test("provisions an account, edits its name and confirms its deletion", async () => {
  setLang("zh");
  const user = {
    id: "researcher",
    email: "new@example.test",
    displayName: "研究员",
    role: "user",
    suspended: false,
    canEdit: true,
    canManage: true,
    organizations: [],
  };
  api.get.mockResolvedValueOnce({ canCreate: true, total: 0, items: [] });
  api.get.mockResolvedValue({ canCreate: true, total: 1, items: [user] });
  api.post.mockResolvedValue({ id: user.id });
  api.patch.mockResolvedValue({ id: user.id, displayName: "新名称" });
  api.delete.mockResolvedValue({ id: user.id });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <PlatformUsersTable />
    </QueryClientProvider>,
  );

  fireEvent.click(await screen.findByRole("button", { name: "新增用户" }));
  fireEvent.change(nativeControl(screen.getByLabelText("登录邮箱")), {
    target: { value: user.email },
  });
  fireEvent.change(nativeControl(screen.getByLabelText("显示名称")), {
    target: { value: user.displayName },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith("/platform/users", {
      email: user.email,
      displayName: user.displayName,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "编辑" }));
  fireEvent.change(nativeControl(screen.getByLabelText("显示名称")), {
    target: { value: "新名称" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(api.patch).toHaveBeenCalledWith("/platform/users/researcher", {
      displayName: "新名称",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "删除" }));
  expect(api.delete).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));
  await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/platform/users/researcher"));
  view.unmount();
  client.clear();
});
