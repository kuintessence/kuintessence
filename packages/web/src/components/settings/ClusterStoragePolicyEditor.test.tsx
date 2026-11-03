import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ClusterStoragePolicyEditor } from "./ClusterStoragePolicyEditor";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
afterEach(() => vi.resetAllMocks());
function setup(failed: string | null) {
  let failure = failed;
  api.get.mockImplementation(async (path: string) => {
    if (failure && path.includes(failure)) throw new Error("unavailable");
    return path.includes("/policy?")
      ? {
          policy: null,
          effectivePolicy: {
            defaultQuotaBytes: 40 * 1024 ** 3,
            maxQuotaBytes: null,
            autoApproveLimitBytes: null,
            requestMode: "manual",
          },
        }
      : { requests: [] };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <ClusterStoragePolicyEditor rootId="root" />
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
test.each([
  "/policy?",
  "/quota-requests?",
])("failed %s read cannot expose zero defaults or mutations; retry recovers", async (failure) => {
  const { client, unmount, recover } = setup(failure);
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "保存策略" })).toBeNull();
  expect(screen.queryByText("待审批 0")).toBeNull();
  expect(api.put).not.toHaveBeenCalled();
  recover();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await screen.findByRole("button", { name: "保存策略" });
  expect(screen.getByLabelText("默认配额（GB）")).toHaveProperty("value", "40");
  unmount();
  client.clear();
});
test("blank default and invalid approval limit are rejected; explicit zero remains supported", async () => {
  const { client, unmount } = setup(null);
  await screen.findByRole("button", { name: "保存策略" });
  fireEvent.change(screen.getByLabelText("默认配额（GB）"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "保存策略" }));
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("默认配额（GB）"), { target: { value: "0" } });
  fireEvent.change(screen.getByLabelText("审批方式"), { target: { value: "auto" } });
  fireEvent.change(screen.getByLabelText("自动审批上限（GB）"), { target: { value: "-1" } });
  fireEvent.click(screen.getByRole("button", { name: "保存策略" }));
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("自动审批上限（GB）"), { target: { value: "2" } });
  fireEvent.click(screen.getByRole("button", { name: "保存策略" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      "/admin/storage/policy",
      expect.objectContaining({ defaultQuotaBytes: 0, autoApproveLimitBytes: 2 * 1024 ** 3 }),
    ),
  );
  unmount();
  client.clear();
});
