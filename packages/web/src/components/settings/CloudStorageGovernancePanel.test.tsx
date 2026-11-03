import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { CloudStorageGovernancePanel } from "./CloudStorageGovernancePanel";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
const policy = {
  policy: null,
  effectivePolicy: {
    defaultQuotaBytes: 80 * 1024 ** 3,
    maxQuotaBytes: null,
    requestMode: "manual",
    autoApproveLimitBytes: null,
  },
};
function setup(failed: string | null) {
  let failure = failed;
  api.get.mockImplementation(async (path: string) => {
    if (path.includes(failure ?? "never-match")) throw new Error("unavailable");
    if (path.includes("/policy")) return policy;
    if (path.includes("/overview"))
      return {
        usedBytes: 1024,
        fileCount: 1,
        uploadedBytes30d: 0,
        downloadedBytes30d: 0,
        storedByteHours30d: 0,
      };
    return { requests: [] };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <CloudStorageGovernancePanel />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    recover: () => {
      failure = null;
    },
  };
}
afterEach(() => vi.clearAllMocks());
test.each([
  "/policy",
  "/overview",
  "/quota-requests",
])("failed %s reads cannot display fabricated zeros or save defaults; retry recovers", async (path) => {
  const { client, unmount, recover } = setup(path);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "保存策略" })).toBeNull();
  expect(screen.queryByText("当前没有待审批的配额申请。")).toBeNull();
  expect(screen.queryByText("0 KB")).toBeNull();
  expect(api.put).not.toHaveBeenCalled();
  recover();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "保存策略" });
  expect(screen.getByLabelText("默认配额（GB）")).toHaveProperty("value", "80");
  unmount();
  client.clear();
});
test("a cleared quota is not silently saved as zero", async () => {
  const { client, unmount } = setup(null);
  await screen.findByRole("button", { name: "保存策略" });
  fireEvent.change(screen.getByLabelText("默认配额（GB）"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存策略" }));
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("默认配额（GB）"), { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "保存策略" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      "/admin/storage/policy",
      expect.objectContaining({ defaultQuotaBytes: 12 * 1024 ** 3 }),
    ),
  );
  unmount();
  client.clear();
});
