import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { AuditCapabilityPanel } from "./AuditCapabilityPanel";

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), delete: vi.fn() }));
vi.mock("../../lib/api-client", () => ({ api }));
test("server search and pagination keep the correct user attached to grant actions", async () => {
  const row = {
    id: "target",
    displayName: "目标用户",
    email: "target@example.test",
    role: "user",
    auditReadonly: false,
    grantedBy: null,
    grantedAt: null,
  };
  api.get.mockResolvedValue({ success: true, data: [row], hasMore: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <AuditCapabilityPanel />
    </QueryClientProvider>,
  );
  await screen.findByText("目标用户");
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith(
      "/admin/authz/audit-capabilities?search=&limit=50&offset=50",
    ),
  );
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "target@example.test" } });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith(
      "/admin/authz/audit-capabilities?search=target%40example.test&limit=50&offset=0",
    ),
  );
  fireEvent.click(await screen.findByRole("button", { name: "授予" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith("/admin/authz/audit-capabilities/target"),
  );
  unmount();
  client.clear();
});
