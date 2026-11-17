import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

const state = vi.hoisted(() => ({
  search: "?organizationId=org-b",
  active: "org-a",
  switchOrganization: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useRouterState: ({
    select,
  }: {
    select: (value: { location: { searchStr: string } }) => unknown;
  }) => select({ location: { searchStr: state.search } }),
}));
vi.mock("../lib/active-organization", () => ({
  useActiveOrganizationId: () => state.active,
  setActiveOrganization: state.switchOrganization,
}));
vi.mock("../lib/auth", () => ({ getAuthState: () => ({ revision: "test" }) }));

import { OrganizationQueryScope } from "./OrganizationQueryScope";

afterEach(() => {
  vi.clearAllMocks();
  state.active = "org-a";
  state.search = "?organizationId=org-b";
});

test("waits for authorized organization selection and allows subsequent manual switches", async () => {
  let complete: (() => void) | undefined;
  state.switchOrganization.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fixture = (
    <QueryClientProvider client={client}>
      <OrganizationQueryScope>
        <div>Scoped content</div>
      </OrganizationQueryScope>
    </QueryClientProvider>
  );
  const view = render(fixture);
  await waitFor(() => expect(state.switchOrganization).toHaveBeenCalledWith("org-b"));
  expect(screen.queryByText("Scoped content")).toBeNull();
  await act(async () => {
    state.active = "org-b";
    complete?.();
  });
  expect(await screen.findByText("Scoped content")).toBeTruthy();
  state.active = "org-c";
  view.rerender(
    <QueryClientProvider client={client}>
      <OrganizationQueryScope>
        <div>Scoped content</div>
      </OrganizationQueryScope>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Scoped content")).toBeTruthy();
  expect(state.switchOrganization).toHaveBeenCalledTimes(1);
  client.clear();
});

test("an unauthorized target never mounts the requested resource", async () => {
  state.switchOrganization.mockRejectedValue(new Error("Denied"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OrganizationQueryScope>
        <div>Scoped content</div>
      </OrganizationQueryScope>
    </QueryClientProvider>,
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Scoped content")).toBeNull();
  client.clear();
});

test("cached success still waits for the current authorized organization switch", async () => {
  let complete: (() => void) | undefined;
  state.switchOrganization.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["directory-organization-scope", "org-b", "test"], "org-b");
  render(
    <QueryClientProvider client={client}>
      <OrganizationQueryScope>
        <div>Scoped content</div>
      </OrganizationQueryScope>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(state.switchOrganization).toHaveBeenCalledWith("org-b"));
  expect(screen.queryByText("Scoped content")).toBeNull();
  await act(async () => {
    state.active = "org-b";
    complete?.();
  });
  expect(await screen.findByText("Scoped content")).toBeTruthy();
  client.clear();
});
