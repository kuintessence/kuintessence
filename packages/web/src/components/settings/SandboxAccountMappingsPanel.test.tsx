import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const sandboxClient = vi.hoisted(() => ({
  listMappings: vi.fn(),
  listCandidates: vi.fn(),
  requestMapping: vi.fn(),
  setDefault: vi.fn(),
}));
const providerManagement = vi.hoisted(() => ({ allowed: true, ready: true }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/sandbox-client", () => ({
  listSandboxAccountMappings: sandboxClient.listMappings,
  listSandboxAccountCandidates: sandboxClient.listCandidates,
  requestSandboxAccountMapping: sandboxClient.requestMapping,
  setDefaultSandboxAccountMapping: sandboxClient.setDefault,
}));

vi.mock("../../lib/platform-capabilities", () => ({
  usePlatformCapability: () => providerManagement,
}));

import { SandboxAccountMappingsPanel } from "./SandboxAccountMappingsPanel";

function Wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const candidate = {
  id: "account-1",
  providerOrgId: "provider-1",
  agentId: "agent-1",
  displayName: "科研队列账号",
  backendType: "unix" as const,
  schedulerType: "slurm",
  siteName: "示例站点",
};

beforeEach(() => {
  localStorage.setItem("kq_role", "platform_admin");
  providerManagement.allowed = true;
  providerManagement.ready = true;
  sandboxClient.listMappings.mockReset();
  sandboxClient.listCandidates.mockReset();
  sandboxClient.requestMapping.mockReset();
  sandboxClient.setDefault.mockReset();
});

describe("SandboxAccountMappingsPanel", () => {
  test("explains the provider prerequisite when no account has been published", async () => {
    sandboxClient.listMappings.mockResolvedValue([]);
    sandboxClient.listCandidates.mockResolvedValue([]);

    render(<SandboxAccountMappingsPanel />, { wrapper: Wrapper });

    expect(await screen.findByText("sandbox.accounts.noPublishedTitle")).toBeTruthy();
    const manageLink = screen.getByText("sandbox.accounts.manageCatalog").closest("a");
    expect(manageLink?.getAttribute("href")).toBe("/cp/accounts");
    expect(screen.getByLabelText("sandbox.accounts.candidate").hasAttribute("disabled")).toBe(true);
  });

  test("offers catalog management to a provider membership capability", async () => {
    localStorage.setItem("kq_role", "user");
    sandboxClient.listMappings.mockResolvedValue([]);
    sandboxClient.listCandidates.mockResolvedValue([]);

    render(<SandboxAccountMappingsPanel />, { wrapper: Wrapper });

    const manageLink = (await screen.findByText("sandbox.accounts.manageCatalog")).closest("a");
    expect(manageLink?.getAttribute("href")).toBe("/cp/accounts");
  });

  test.each([
    "rejected",
    "expired",
  ])("allows a %s mapping to be requested again", async (status) => {
    sandboxClient.listMappings.mockResolvedValue([
      {
        mapping: {
          id: "mapping-1",
          userId: "user-1",
          accountId: candidate.id,
          status,
          isDefault: false,
          requestedAt: "2026-07-22T00:00:00.000Z",
          expiresAt: null,
        },
        account: {
          ...candidate,
          username: "researcher",
          schedulerAccount: "science",
          allowedQueues: ["normal"],
          namespace: null,
          serviceAccount: null,
          enabled: true,
        },
      },
    ]);
    sandboxClient.listCandidates.mockResolvedValue([candidate]);

    render(<SandboxAccountMappingsPanel />, { wrapper: Wrapper });

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "示例站点 · 科研队列账号 · slurm" })).toBeTruthy();
    });
    expect(screen.getByLabelText("sandbox.accounts.candidate").hasAttribute("disabled")).toBe(
      false,
    );
  });
  test("refreshes approval status when the user returns to the window", async () => {
    const mapping = {
      id: "mapping-1",
      accountId: candidate.id,
      status: "pending",
      isDefault: false,
    };
    sandboxClient.listMappings.mockResolvedValue([{ account: candidate, mapping }]);
    sandboxClient.listCandidates.mockResolvedValue([candidate]);
    render(<SandboxAccountMappingsPanel />, { wrapper: Wrapper });
    expect(await screen.findByText("sandbox.accounts.status.pending")).toBeTruthy();
    sandboxClient.listMappings.mockResolvedValue([
      { account: candidate, mapping: { ...mapping, status: "approved" } },
    ]);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      expect(await screen.findByText("sandbox.accounts.status.approved")).toBeTruthy();
      expect(screen.queryByText("sandbox.accounts.status.pending")).toBeNull();
    } finally {
      focusManager.setFocused(undefined);
    }
  });
  test("disables a selected candidate after another session gets it approved", async () => {
    sandboxClient.listMappings.mockResolvedValue([]);
    sandboxClient.listCandidates.mockResolvedValue([candidate]);
    render(<SandboxAccountMappingsPanel />, { wrapper: Wrapper });
    await screen.findByRole("option", { name: "示例站点 · 科研队列账号 · slurm" });
    fireEvent.change(screen.getByLabelText("sandbox.accounts.candidate"), {
      target: { value: candidate.id },
    });
    expect((screen.getByText("sandbox.accounts.request") as HTMLButtonElement).disabled).toBe(
      false,
    );
    sandboxClient.listMappings.mockResolvedValue([
      {
        account: candidate,
        mapping: {
          id: "mapping-1",
          accountId: candidate.id,
          status: "approved",
          isDefault: false,
        },
      },
    ]);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await screen.findByText("sandbox.accounts.status.approved");
      expect((screen.getByText("sandbox.accounts.request") as HTMLButtonElement).disabled).toBe(
        true,
      );
      expect(sandboxClient.requestMapping).not.toHaveBeenCalled();
    } finally {
      focusManager.setFocused(undefined);
    }
  });
});
