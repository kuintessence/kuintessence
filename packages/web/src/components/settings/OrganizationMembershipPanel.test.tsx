import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import { setLang } from "../../lib/i18n";
import { OrganizationMembershipPanel } from "./OrganizationMembershipPanel";

vi.mock("sonner", () => ({ toast: { success: vi.fn() } }));
const member = {
  id: "membership-1",
  userId: "user-1",
  email: "alice@example.test",
  displayName: "Alice",
  orgId: "org-1",
  orgName: "研究中心",
  role: "admin",
  platformRole: "user",
};
function setup() {
  const get = vi.spyOn(api, "get").mockImplementation(async (path) =>
    path.includes("membership-options")
      ? {
          data: {
            users: [{ id: "user-2", email: "bob@example.test", displayName: "Bob", role: "user" }],
            organizations: [{ id: "org-1", name: "研究中心" }],
            moreUsers: false,
            moreOrganizations: false,
          },
        }
      : { data: [member], hasMore: false },
  );
  const put = vi.spyOn(api, "put").mockResolvedValue({ success: true });
  const remove = vi.spyOn(api, "delete").mockResolvedValue({ success: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <OrganizationMembershipPanel />
    </QueryClientProvider>,
  );
  return { get, put, remove };
}
beforeEach(() => setLang("zh"));

afterEach(() => vi.restoreAllMocks());

test.each([
  "zh",
  "en",
] as const)("%s edits the selected member by name and preserves the target identity", async (lang) => {
  setLang(lang);
  const { put } = setup();
  fireEvent.click(
    await screen.findByRole("button", {
      name: lang === "zh" ? "编辑 Alice 的组织权限" : "Edit organization permissions for Alice",
    }),
  );
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText("研究中心")).toBeTruthy();
  fireEvent.change(
    within(dialog).getByLabelText(lang === "zh" ? "组织角色" : "Organization role"),
    { target: { value: "operator" } },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: lang === "zh" ? "保存" : "Save" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/admin/authz/memberships", {
      userId: "user-1",
      orgId: "org-1",
      role: "operator",
      createOnly: false,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

test("adds by names and keeps an existing membership conflict visible without closing the form", async () => {
  const { put } = setup();
  put.mockRejectedValue(new ApiError(409, "VALIDATION_ERROR", "already exists"));
  fireEvent.click(screen.getByRole("button", { name: "添加成员" }));
  await screen.findByRole("option", { name: "Bob · bob@example.test" });
  fireEvent.change(screen.getByLabelText("用户", { exact: true }), { target: { value: "user-2" } });
  fireEvent.change(screen.getByLabelText("组织", { exact: true }), { target: { value: "org-1" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() =>
    expect(put).toHaveBeenCalledWith("/admin/authz/memberships", {
      userId: "user-2",
      orgId: "org-1",
      role: "member",
      createOnly: true,
    }),
  );
  expect((await screen.findByRole("alert")).textContent).toContain("该用户已属于此组织");
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("confirms removing the selected membership and its federation grants while keeping the account", async () => {
  const { remove } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "移除 Alice 的组织成员资格" }));
  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("保留用户账户");
  expect(screen.getByRole("dialog").textContent).toContain("重新授予联邦权限");
  fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
  await waitFor(() => expect(remove).toHaveBeenCalledWith("/admin/authz/memberships/user-1/org-1"));
});

test("paginates beyond the first page and resets the offset when searching", async () => {
  const { get } = setup();
  await screen.findByText("Alice");
  get.mockResolvedValue({ data: [member], hasMore: true });
  fireEvent.click(screen.getByRole("button", { name: "刷新组织成员" }));
  fireEvent.click(await screen.findByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(get.mock.calls.some(([path]) => path.includes("offset=20"))).toBe(true),
  );
  fireEvent.change(screen.getByLabelText("搜索组织成员"), { target: { value: "Alice" } });
  await waitFor(() =>
    expect(get).toHaveBeenLastCalledWith("/admin/authz/memberships?search=Alice&limit=20&offset=0"),
  );
});

test("does not display old member data after a read error", async () => {
  const { get } = setup();
  await screen.findByText("Alice");
  get.mockRejectedValue(new ApiError(403, "FORBIDDEN", "denied"));
  fireEvent.click(screen.getByRole("button", { name: "刷新组织成员" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("Alice")).toBeNull();
});
