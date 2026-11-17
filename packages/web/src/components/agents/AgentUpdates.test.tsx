import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import { AgentUpdates } from "./AgentUpdates";

const auth = vi.hoisted(() => ({ role: "org_admin" }));
vi.mock("../../lib/auth", () => ({ getAuthState: () => auth }));
vi.mock("../../lib/api-client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  auth.role = "org_admin";
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <AgentUpdates agentId="site-agent" />
    </QueryClientProvider>,
  );
}

test("a provider sees the platform notice and can request its exact release", async () => {
  const release = "a".repeat(64);
  vi.mocked(api.get).mockResolvedValue({
    supported: true,
    requests: [
      {
        requestId: crypto.randomUUID(),
        kind: "notice",
        release,
        message: "Update recommended",
        state: "requested",
        createdAt: new Date().toISOString(),
      },
    ],
  });
  vi.mocked(api.post).mockResolvedValue({});
  show();
  expect(await screen.findByText("Update recommended")).toBeTruthy();
  expect(screen.queryByText("agents.updater.notify")).toBeNull();
  fireEvent.click(screen.getByText("agents.updater.useRelease"));
  fireEvent.click(screen.getByText("agents.updater.request"));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/agents/site-agent/updates",
      expect.objectContaining({ kind: "update", release, requestId: expect.any(String) }),
    ),
  );
  expect(await screen.findByText("agents.updater.sent")).toBeTruthy();
});

test("the platform can send a notice without executing an update", async () => {
  auth.role = "operator";
  vi.mocked(api.get).mockResolvedValue({ supported: false, requests: [] });
  vi.mocked(api.post).mockResolvedValue({});
  show();
  expect(await screen.findByText("agents.updater.unsupported")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("agents.updater.release"), {
    target: { value: "b".repeat(64) },
  });
  fireEvent.click(screen.getByText("agents.updater.notify"));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/agents/site-agent/updates",
      expect.objectContaining({ kind: "notice" }),
    ),
  );
});

test("query errors do not show stale notifications or action forms", async () => {
  vi.mocked(api.get).mockRejectedValue(new Error("offline"));
  show();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("agents.updater.request")).toBeNull();
});
