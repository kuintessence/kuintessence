import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const activeOrganization = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../lib/active-organization", () => ({
  getActiveOrganizationContext: activeOrganization.get,
  setActiveOrganization: activeOrganization.set,
}));

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
});

describe("ProviderOrganizationSelector", () => {
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
    expect(queryClient.getQueryData(["unrelated", "theme"])).toBe("light");
  });
});
