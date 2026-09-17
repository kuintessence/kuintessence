import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSoftwareOverview: vi.fn(),
  listSandboxMappingReviewQueue: vi.fn(),
}));
const management = vi.hoisted(() => ({
  allowed: true,
  ready: true,
  error: null,
  retry: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/cp-client", () => ({
  getSoftwareOverview: mocks.getSoftwareOverview,
}));

vi.mock("../../lib/sandbox-client", () => ({
  listSandboxMappingReviewQueue: mocks.listSandboxMappingReviewQueue,
}));

vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => management,
}));

import { CpAttentionCards } from "./CpAttentionCards";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  management.allowed = true;
});

describe("CpAttentionCards", () => {
  test("shows scoped approvals and operational alerts", async () => {
    mocks.listSandboxMappingReviewQueue.mockResolvedValue([
      { mapping: { id: "one" } },
      { mapping: { id: "two" } },
    ]);
    mocks.getSoftwareOverview.mockResolvedValue({
      agents: [
        {
          preinstalledMappings: [
            { id: "pending", auditedAt: null },
            { id: "reviewed", auditedAt: "2026-07-22T00:00:00Z" },
          ],
        },
      ],
    });

    render(<CpAttentionCards failedJobs={5} sickAgents={1} offlineAgents={2} />, { wrapper });

    await waitFor(() => {
      expect(screen.getByTestId("cp-approval-attention-accounts").textContent).toContain("2");
    });
    expect(screen.getByTestId("cp-approval-attention-software").textContent).toContain("1");
    expect(screen.getByTestId("cp-alert-attention-failedJobs").textContent).toContain("5");
    expect(screen.getByTestId("cp-alert-attention-sickAgents").textContent).toContain("1");
    expect(screen.getByTestId("cp-alert-attention-offlineAgents").textContent).toContain("2");
  });

  test("does not prefetch management approvals for provider operator membership", () => {
    management.allowed = false;

    render(<CpAttentionCards failedJobs={0} sickAgents={1} offlineAgents={0} />, { wrapper });

    expect(screen.queryByTestId("cp-approval-attention")).toBeNull();
    expect(mocks.listSandboxMappingReviewQueue).not.toHaveBeenCalled();
    expect(mocks.getSoftwareOverview).not.toHaveBeenCalled();
  });
});
