import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const activeOrganization = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));
const apiGet = vi.hoisted(() => vi.fn());
vi.mock("../../lib/api-client", () => ({ api: { get: apiGet } }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/active-organization", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/active-organization")>()),
  getActiveOrganizationContext: activeOrganization.get,
  setActiveOrganization: activeOrganization.set,
}));

import { getStoredActiveOrganizationId } from "../../lib/active-organization";
import { useMeCapabilities } from "../../lib/platform-capabilities";
import { ProviderOrganizationSelector } from "./ProviderOrganizationSelector";

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={createClient()}>{children}</QueryClientProvider>;
}

function createClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("ProviderOrganizationSelector", () => {
  test("finishes a live organization switch with mounted capability consumers", async () => {
    localStorage.setItem("kq_active_organization_id", "org-a");
    activeOrganization.get.mockResolvedValue({
      activeOrganizationId: "org-a",
      organizations: [
        { orgId: "org-a", name: "Provider A", role: "admin" },
        { orgId: "org-b", name: "Provider B", role: "operator" },
      ],
    });
    activeOrganization.set.mockImplementation(async (id: string) => {
      localStorage.setItem("kq_active_organization_id", id);
      window.dispatchEvent(new Event("kq:active-organization-change"));
    });
    apiGet.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        principal: {
          userId: "00000000-0000-4000-8000-000000000001",
          email: "a@test.local",
          role: "user",
        },
        capabilities:
          getStoredActiveOrganizationId() === "org-a"
            ? ["workspace.provider.view", "workspace.provider.manage"]
            : ["workspace.provider.view"],
        contexts: [{ id: "personal", type: "personal" }],
        activeContextId: "personal",
        devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
      };
    });
    function Consumer({ selector = false }: { selector?: boolean }) {
      const state = useMeCapabilities(true);
      return (
        <>
          <output data-testid="capability-consumer">
            {state.status}:
            {String(state.data?.capabilities.includes("workspace.provider.manage") ?? false)}
          </output>
          {selector && state.status === "ready" ? <ProviderOrganizationSelector /> : null}
        </>
      );
    }
    render(
      <>
        <Consumer />
        <Consumer selector />
      </>,
      { wrapper },
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("capability-consumer").map((item) => item.textContent)).toEqual([
        "ready:true",
        "ready:true",
      ]),
    );
    fireEvent.change(await screen.findByLabelText("cp.organizationSelector.ariaLabel"), {
      target: { value: "org-b" },
    });
    await waitFor(() =>
      expect(screen.getAllByTestId("capability-consumer").map((item) => item.textContent)).toEqual([
        "ready:false",
        "ready:false",
      ]),
    );
  });

  test("lets a platform administrator select any returned provider organization", async () => {
    activeOrganization.get.mockResolvedValue({
      activeOrganizationId: null,
      organizations: [
        { orgId: "org-a", name: "Provider A", role: "platform_admin" },
        { orgId: "org-b", name: "Provider B", role: "platform_admin" },
      ],
    });
    activeOrganization.set.mockResolvedValue(undefined);

    render(<ProviderOrganizationSelector />, { wrapper });

    const selector = (await screen.findByTestId("cp-organization-selector")) as HTMLLabelElement;
    const select = selector.querySelector("select");
    expect(select?.textContent).toContain("Provider A");
    expect(select?.textContent).toContain("Provider B");

    if (!select) throw new Error("organization select was not rendered");
    fireEvent.change(select, { target: { value: "org-b" } });
    await waitFor(() =>
      expect(activeOrganization.set).toHaveBeenCalledWith("org-b", expect.anything()),
    );
  });

  test("surfaces organization context failures", async () => {
    activeOrganization.get.mockRejectedValue(new Error("organization unavailable"));

    render(<ProviderOrganizationSelector />, { wrapper });

    const error = await screen.findByTestId("cp-organization-selector-error");
    expect(error.textContent).toContain("cp.organizationSelector.loadFailed");
    expect(error.textContent).not.toContain("organization unavailable");
  });

  test("lets an operator retry an initial organization context failure", async () => {
    activeOrganization.get
      .mockRejectedValueOnce(new Error("organization unavailable"))
      .mockResolvedValueOnce({
        activeOrganizationId: "org-a",
        organizations: [{ orgId: "org-a", name: "Provider A", role: "operator" }],
      });

    render(<ProviderOrganizationSelector />, { wrapper });

    fireEvent.click(await screen.findByTestId("cp-organization-selector-retry"));

    expect(await screen.findByTestId("cp-organization-selector")).toBeTruthy();
    expect(activeOrganization.get).toHaveBeenCalledTimes(2);
  });

  test("keeps the selector available after an organization update fails", async () => {
    activeOrganization.get.mockResolvedValue({
      activeOrganizationId: "org-a",
      organizations: [
        { orgId: "org-a", name: "Provider A", role: "operator" },
        { orgId: "org-b", name: "Provider B", role: "operator" },
      ],
    });
    activeOrganization.set.mockRejectedValueOnce(new Error("update unavailable"));

    render(<ProviderOrganizationSelector />, { wrapper });

    const select = (await screen.findByLabelText(
      "cp.organizationSelector.ariaLabel",
    )) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "org-b" } });

    const error = await screen.findByTestId("cp-organization-selector-update-error");
    expect(error.textContent).toContain("cp.organizationSelector.updateFailed");
    expect(error.textContent).not.toContain("update unavailable");
    expect(screen.getByTestId("cp-organization-selector")).toBeTruthy();
    expect(select.value).toBe("org-a");

    activeOrganization.set.mockResolvedValueOnce(undefined);
    fireEvent.change(select, { target: { value: "org-b" } });
    await waitFor(() =>
      expect(activeOrganization.set).toHaveBeenLastCalledWith("org-b", expect.anything()),
    );
  });

  test("clears organization-sensitive cached data before refetching the new scope", async () => {
    activeOrganization.get.mockResolvedValue({
      activeOrganizationId: "org-a",
      organizations: [
        { orgId: "org-a", name: "Provider A", role: "operator" },
        { orgId: "org-b", name: "Provider B", role: "operator" },
      ],
    });
    activeOrganization.set.mockResolvedValue(undefined);
    const queryClient = createClient();
    queryClient.setQueryData(["cp", "dashboard"], { jobsCompleted: 9 });
    queryClient.setQueryData(["cp-data", "org-a", "assets"], { assets: ["a"] });
    queryClient.setQueryData(["metering", "query", { orgIds: ["org-a"] }], { rows: [] });
    queryClient.setQueryData(["job-logs", "job-a"], { text: "organization-scoped log" });
    queryClient.setQueryData(["job-files-netdrive", "job-a", "completed"], { files: ["artifact"] });
    queryClient.setQueryData(["unrelated", "theme"], "light");

    render(
      <QueryClientProvider client={queryClient}>
        <ProviderOrganizationSelector />
      </QueryClientProvider>,
    );

    fireEvent.change(await screen.findByLabelText("cp.organizationSelector.ariaLabel"), {
      target: { value: "org-b" },
    });

    await waitFor(() =>
      expect(activeOrganization.set).toHaveBeenCalledWith("org-b", expect.anything()),
    );
    await waitFor(() => expect(queryClient.getQueryData(["cp", "dashboard"])).toBeUndefined());
    expect(queryClient.getQueryData(["cp-data", "org-a", "assets"])).toBeUndefined();
    expect(queryClient.getQueryData(["metering", "query", { orgIds: ["org-a"] }])).toBeUndefined();
    expect(queryClient.getQueryData(["job-logs", "job-a"])).toBeUndefined();
    expect(queryClient.getQueryData(["job-files-netdrive", "job-a", "completed"])).toBeUndefined();
    expect(queryClient.getQueryData(["unrelated", "theme"])).toBe("light");
  });
});
