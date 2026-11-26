import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  ACTIVE_ORGANIZATION_STORAGE_KEY,
  getStoredActiveOrganizationId,
  setActiveOrganization,
  useActiveOrganizationId,
} from "../lib/active-organization";
import { getAuthState, setAuth } from "../lib/auth";
import { CpLayout } from "./cp/CpLayout";
import { OrganizationQueryScope } from "./OrganizationQueryScope";

vi.mock("../lib/platform-capabilities", () => ({
  usePlatformCapability: () => ({
    allowed: true,
    ready: getStoredActiveOrganizationId() !== pendingCapabilityOrganization,
    error: null,
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const initialUrl = "/cp/agents?organizationId=org-b&tab=details#agents";
const consumedUrl = "/cp/agents?tab=details#agents";
const request = vi.fn<typeof fetch>();
let client: QueryClient;
let pendingCapabilityOrganization: string | null;

beforeEach(() => {
  pendingCapabilityOrganization = null;
  setAuth({ token: null, email: "member@example.test", role: "org_admin" });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, "org-a");
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  request.mockImplementation(async (input, init) => {
    if (!String(input).endsWith("/me/active-organization") || init?.method !== "PUT") {
      throw new Error(`Unexpected request ${String(input)}`);
    }
    const { organizationId } = JSON.parse(String(init.body)) as { organizationId: string };
    return Response.json({ activeOrganizationId: organizationId });
  });
  vi.stubGlobal("fetch", request);
});

afterEach(() => {
  cleanup();
  client.clear();
  localStorage.clear();
  request.mockReset();
  vi.unstubAllGlobals();
});

function ScopedContent() {
  return <p>Scoped content for {useActiveOrganizationId()}</p>;
}

function mount({ cached = false, entry = initialUrl } = {}) {
  const history = createMemoryHistory({ initialEntries: [entry] });
  const root = createRootRoute({
    component: () => (
      <>
        <button type="button" onClick={() => void setActiveOrganization("org-c")}>
          Switch to org-c
        </button>
        <Outlet />
      </>
    ),
  });
  const cp = createRoute({
    getParentRoute: () => root,
    path: "/cp",
    component: () => (
      <CpLayout>
        <Outlet />
      </CpLayout>
    ),
  });
  const agents = createRoute({
    getParentRoute: () => cp,
    path: "/agents",
    component: () => (
      <OrganizationQueryScope>
        <ScopedContent />
      </OrganizationQueryScope>
    ),
  });
  const interconnect = createRoute({
    getParentRoute: () => cp,
    path: "/interconnect",
    component: () => <p>Interconnect</p>,
  });
  const router = createRouter({
    history,
    routeTree: root.addChildren([cp.addChildren([agents, interconnect])]),
  });
  const queryKey = [
    "directory-organization-scope",
    "org-b",
    getAuthState().revision,
    history.location.state.__TSR_key,
  ];
  if (cached) client.setQueryData(queryKey, "org-b");
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { history, router, queryKey };
}

function delaySelection() {
  const response = Promise.withResolvers<Response>();
  request.mockImplementationOnce(() => response.promise);
  return response;
}

test("selects the linked organization once and keeps later manual switches through CpLayout remounts", async () => {
  const selection = delaySelection();
  const { history } = mount();

  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(history.location.href).toBe(initialUrl);
  expect(screen.queryByText(/Scoped content/)).toBeNull();
  await act(async () => selection.resolve(Response.json({ activeOrganizationId: "org-b" })));
  expect(await screen.findByText("Scoped content for org-b")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Switch to org-c" }));
  expect(await screen.findByText("Scoped content for org-c")).toBeTruthy();
  expect(getStoredActiveOrganizationId()).toBe("org-c");
  expect(request).toHaveBeenCalledTimes(2);
  expect(history.location.href).toBe(consumedUrl);
  expect(history.length).toBe(1);
});

test("consumes the link while CpLayout reloads capabilities for the linked organization", async () => {
  pendingCapabilityOrganization = "org-b";
  const { history } = mount();

  await waitFor(() => expect(history.location.href).toBe(consumedUrl));
  expect(getStoredActiveOrganizationId()).toBe("org-b");
  expect(screen.queryByTestId("cp-layout")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Switch to org-c" }));
  expect(await screen.findByText("Scoped content for org-c")).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(2);
});

test("consumes the link using the router's case-insensitive route match", async () => {
  const { history } = mount({ entry: "/CP/AGENTS?organizationId=org-b&tab=details#agents" });

  expect(await screen.findByText("Scoped content for org-b")).toBeTruthy();
  expect(history.location.href).toBe("/CP/AGENTS?tab=details#agents");
});

test("keeps an unauthorized organization link available for retry and blocks its contents", async () => {
  request.mockResolvedValueOnce(Response.json({ error: "Denied" }, { status: 403 }));
  const { history } = mount();

  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(/Scoped content/)).toBeNull();
  expect(getStoredActiveOrganizationId()).toBe("org-a");
  expect(history.location.href).toBe(initialUrl);

  fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
  expect(await screen.findByText("Scoped content for org-b")).toBeTruthy();
  expect(history.location.href).toBe(consumedUrl);
});

test("cached success still waits for the current authorized organization switch", async () => {
  const selection = delaySelection();
  mount({ cached: true });

  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  expect(screen.queryByText(/Scoped content/)).toBeNull();
  await act(async () => selection.resolve(Response.json({ activeOrganizationId: "org-b" })));
  expect(await screen.findByText("Scoped content for org-b")).toBeTruthy();
});

test("a late directory selection preserves a newer page's organization filter", async () => {
  const selection = delaySelection();
  const { history, router, queryKey } = mount();
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

  const newerUrl = "/cp/interconnect?organizationId=org-c&tab=details#zones";
  await act(async () => router.navigate({ href: newerUrl }));
  expect(screen.getByText("Interconnect")).toBeTruthy();

  await act(async () => selection.resolve(Response.json({ activeOrganizationId: "org-b" })));
  await waitFor(() => expect(client.getQueryState(queryKey)).toMatchObject({ status: "success" }));
  expect(request).toHaveBeenCalledTimes(1);
  expect(history.location.href).toBe(newerUrl);
  expect(history.length).toBe(2);
});

test("a newer entry for the same organization shares its in-flight switch", async () => {
  const selection = delaySelection();
  const { history, router } = mount();
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));

  const newerUrl = "/cp/agents?organizationId=org-b&tab=summary#summary";
  await act(async () => router.navigate({ href: newerUrl }));
  expect(history.location.href).toBe(newerUrl);

  await act(async () => selection.resolve(Response.json({ activeOrganizationId: "org-b" })));
  expect(await screen.findByText("Scoped content for org-b")).toBeTruthy();
  expect(request).toHaveBeenCalledTimes(1);
  expect(history.location.href).toBe("/cp/agents?tab=summary#summary");
  expect(history.length).toBe(2);
});
