import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { SandboxSecurityPanel } from "./SandboxSecurityPanel";

const sandboxClient = vi.hoisted(() => ({
  getEffectiveSandboxPolicy: vi.fn(),
  listSandboxAgentSecurityViews: vi.fn(),
  listSandboxPolicyOverlays: vi.fn(),
  updatePlatformSandboxPolicy: vi.fn(),
}));

vi.mock("../../lib/sandbox-client", () => sandboxClient);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => vi.clearAllMocks());

describe("SandboxSecurityPanel", () => {
  test("preserves limits and runtime denies when updating platform switches", async () => {
    sandboxClient.listSandboxAgentSecurityViews.mockResolvedValue([]);
    sandboxClient.listSandboxPolicyOverlays.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000001",
        scope: "platform",
        providerOrgId: null,
        clusterId: null,
        agentId: null,
        policy: {
          sandboxEnabled: true,
          sharedServiceAllowed: true,
          limits: { maxCpuCores: 16, maxOutputBytes: 1_048_576 },
          disabledRuntimeProfileIds: ["00000000-0000-4000-8000-000000000010"],
        },
      },
    ]);
    sandboxClient.updatePlatformSandboxPolicy.mockResolvedValue(undefined);

    render(<SandboxSecurityPanel />, { wrapper });

    const sharedSwitch = await screen.findByLabelText("sandbox.security.shared");
    await waitFor(() => expect((sharedSwitch as HTMLInputElement).checked).toBe(true));
    fireEvent.click(sharedSwitch);
    fireEvent.click(screen.getByText("sandbox.security.saveUpperBound"));

    await waitFor(() => {
      expect(sandboxClient.updatePlatformSandboxPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          sharedServiceAllowed: false,
          limits: { maxCpuCores: 16, maxOutputBytes: 1_048_576 },
          disabledRuntimeProfileIds: ["00000000-0000-4000-8000-000000000010"],
        }),
      );
    });
  });
});
