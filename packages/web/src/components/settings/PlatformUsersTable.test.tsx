import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setLang } from "../../lib/i18n";
import { PlatformUsersTable } from "./PlatformUsersTable";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("../../lib/active-organization", () => ({ useActiveOrganizationId: () => null }));
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
  expect(screen.getAllByRole("button", { name: "停用账号" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "停用账号" }));
  expect(screen.getByRole("button", { name: "确认" }).hasAttribute("disabled")).toBe(true);
  fireEvent.change(screen.getByLabelText("操作原因"), { target: { value: "账号访问审查" } });
  fireEvent.click(screen.getByRole("button", { name: "确认" }));
  await waitFor(() =>
    expect(api.patch).toHaveBeenCalledWith("/platform/users/user/status", {
      suspended: true,
      reason: "账号访问审查",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.change(screen.getByRole("textbox", { name: "搜索成员" }), {
    target: { value: "researcher" },
  });
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining("search=researcher")),
  );
  view.unmount();
  client.clear();
});
