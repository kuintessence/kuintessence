import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { setLang } from "../../lib/i18n";
import { CpAccountsPage } from "./CpAccountsPage";

const api = vi.hoisted(() => ({
  listSandboxExecutionAccounts: vi.fn(),
  updateSandboxAccountQueues: vi.fn(),
}));
vi.mock("../../lib/sandbox-client", () => api);
vi.mock("../../lib/use-organization-name", () => ({
  useOrganizationName: () => (id: string) => id,
}));
vi.mock("../../lib/active-organization", () => ({ useActiveOrganizationId: () => "org-a" }));
vi.mock("../../lib/auth", () => ({ getAuthState: () => ({ revision: "test" }) }));
vi.mock("./SandboxMappingReviewPanel", () => ({ SandboxMappingReviewPanel: () => null }));
vi.mock("./RegisterExecutionAccount", () => ({
  RegisterExecutionAccount: () => <div role="dialog">Register form</div>,
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  sessionStorage.clear();
});
function setup(ids: string[]) {
  setLang("zh");
  api.listSandboxExecutionAccounts.mockResolvedValue({ data: [], manageableProviderOrgIds: ids });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CpAccountsPage />
    </QueryClientProvider>,
  );
  return { ...view, client };
}
test("directory management permission gates registration and closes the editor on revocation", async () => {
  const { client, unmount } = setup([]);
  await screen.findByText("尚未登记集群执行账号。");
  expect(screen.queryByRole("button", { name: "登记账号" })).toBeNull();
  api.listSandboxExecutionAccounts.mockResolvedValue({
    data: [],
    manageableProviderOrgIds: ["org-a"],
  });
  await act(() => client.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] }));
  fireEvent.click(await screen.findByRole("button", { name: "登记账号" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  api.listSandboxExecutionAccounts.mockResolvedValue({ data: [], manageableProviderOrgIds: [] });
  await act(() => client.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  unmount();
  client.clear();
});
test("mobile policy prevents opening an account registration form", async () => {
  sessionStorage.setItem("kq.mobile-management-policy", "observe-approve");
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  const { client, unmount } = setup(["org-a"]);
  await screen.findByText("尚未登记集群执行账号。");
  expect(screen.queryByRole("button", { name: "登记账号" })).toBeNull();
  expect(screen.getByText("请在电脑端管理集群账号。")).toBeTruthy();
  unmount();
  client.clear();
});

test("an empty account queue allowlist is not presented as unrestricted access", async () => {
  const { client, unmount } = setup(["org-a"]);
  await screen.findByText("尚未登记集群执行账号。");
  api.listSandboxExecutionAccounts.mockResolvedValue({
    manageableProviderOrgIds: ["org-a"],
    data: [
      {
        id: "account",
        displayName: "Researcher",
        agentId: "slurm",
        backendType: "unix",
        enabled: true,
        sharedService: false,
        username: "user",
        uid: 2000,
        gid: 2000,
        allowedQueues: [],
      },
    ],
  });
  await act(() => client.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] }));
  await screen.findByText("未授权具名队列");
  expect(screen.queryByText("所有队列")).toBeNull();
  unmount();
  client.clear();
});

test("queue editor preserves existing names, retries errors, saves through scoped endpoint and closes on revocation", async () => {
  const { client, unmount } = setup(["org-a"]);
  await screen.findByText("尚未登记集群执行账号。");
  const account = {
    id: "account",
    providerOrgId: "org-a",
    displayName: "User",
    agentId: "slurm",
    backendType: "unix",
    enabled: true,
    sharedService: false,
    username: "user",
    uid: 2000,
    gid: 2000,
    allowedQueues: ["old-queue", "batch"],
  };
  api.listSandboxExecutionAccounts.mockResolvedValue({
    data: [account],
    manageableProviderOrgIds: ["org-a"],
  });
  await act(() => client.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] }));
  fireEvent.click(await screen.findByRole("button", { name: "修改队列授权" }));
  const input = screen.getByLabelText("允许队列（逗号分隔）");
  expect(input).toHaveProperty("value", "old-queue, batch");
  api.updateSandboxAccountQueues.mockRejectedValueOnce(new Error("temporary failure"));
  fireEvent.change(input, { target: { value: "batch, debug, batch" } });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await screen.findByRole("alert");
  expect(input).toHaveProperty("value", "batch, debug, batch");
  api.updateSandboxAccountQueues.mockResolvedValue(undefined);
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.updateSandboxAccountQueues).toHaveBeenLastCalledWith("account", ["batch", "debug"]);
  fireEvent.click(screen.getByRole("button", { name: "修改队列授权" }));
  api.listSandboxExecutionAccounts.mockResolvedValue({
    data: [account],
    manageableProviderOrgIds: [],
  });
  await act(() => client.invalidateQueries({ queryKey: ["sandbox-execution-accounts"] }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "修改队列授权" })).toBeNull();
  unmount();
  client.clear();
});
