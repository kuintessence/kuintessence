import type { InterconnectSnapshot } from "@kuintessence/shared/browser";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { InterconnectDashboard } from "./InterconnectDashboard";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
vi.mock("../../lib/active-organization", () => ({ useActiveOrganizationId: () => null }));
vi.mock("../../lib/auth", () => ({ getAuthState: () => ({ revision: "review" }) }));
vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => ({ allowed: true, ready: true, error: null }),
}));
vi.mock("../ThemeProvider", () => ({ useTheme: () => ({ resolved: "light" }) }));
vi.mock("echarts-for-react", () => ({ default: () => null }));
vi.mock("./InterconnectMap", () => ({ InterconnectMap: () => null }));

const snapshot: InterconnectSnapshot = {
  centers: [],
  clusters: [],
  links: [],
  agents: [],
  organizations: [{ id: "00000000-0000-4000-8000-000000000001", name: "提供者" }],
  defaultView: null,
  generatedAt: "2026-11-01T00:00:00.000Z",
  canManage: true,
};

afterEach(() => vi.clearAllMocks());

test.each([
  "provider",
  "operator",
] as const)("%s closes a metadata editor on revocation and starts a fresh edit after regrant", async (mode) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.get.mockResolvedValue(snapshot);
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <InterconnectDashboard mode={mode} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "新增中心" }));
  fireEvent.change(screen.getByLabelText("名称"), { target: { value: "未保存草稿" } });

  api.get.mockResolvedValue({ ...snapshot, canManage: false });
  await act(() => client.invalidateQueries({ queryKey: ["interconnect"] }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByTestId("interconnect-dashboard")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "新增中心" })).toBeNull();

  api.get.mockResolvedValue(snapshot);
  await act(() => client.invalidateQueries({ queryKey: ["interconnect"] }));
  const add = await screen.findByRole("button", { name: "新增中心" });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(add);
  expect(screen.getByLabelText("名称")).toHaveProperty("value", "");

  api.get.mockRejectedValue(new Error("资源读取失败"));
  await act(() => client.invalidateQueries({ queryKey: ["interconnect"] }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).toBeNull();
  api.get.mockResolvedValue(snapshot);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "新增中心" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  unmount();
  client.clear();
});
