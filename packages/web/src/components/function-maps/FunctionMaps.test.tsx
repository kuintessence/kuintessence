import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ACTIVE_ORGANIZATION_STORAGE_KEY } from "../../lib/active-organization";
import { clearAuth, setAuth } from "../../lib/auth";
import { setLang } from "../../lib/i18n";
import { FunctionMaps } from "./FunctionMaps";
import type { MapNode } from "./model";
import { DEFAULT_MAP_PREFERENCES } from "./preferences";

const orgA = "00000000-0000-4000-8000-000000000001";
const orgB = "00000000-0000-4000-8000-000000000002";
const clients: QueryClient[] = [];
let grants = ["delegation.read", "delegation.submit", "asset.read", "result.read"];
let delayedB: ((response: Response) => void) | null = null;
function response(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
beforeEach(() => {
  setLang("zh");
  localStorage.clear();
  setAuth({ token: null, email: "member@example.test", role: "user" });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, orgA);
  grants = ["delegation.read", "delegation.submit", "asset.read", "result.read"];
  delayedB = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/me/capabilities"))
        return response({
          principal: { userId: orgA, email: "member@example.test", role: "user" },
          capabilities: [
            "workspace.consumer.access",
            "workspace.ecosystem.view",
            "workspace.personal.access",
          ],
          contexts: [],
          activeContextId: "personal",
          devicePolicy: { highRiskMutations: "desktop-only", mobileMode: "observe-approve" },
        });
      if (url.endsWith("/federation/capabilities")) {
        const org = (init?.headers as Record<string, string>)["X-KQ-Active-Organization"];
        if (org === orgB)
          return new Promise<Response>((resolve) => {
            delayedB = resolve;
          });
        return response({
          data: { orgId: orgA, userId: orgA, grants, effectiveCapabilities: grants },
        });
      }
      throw new Error(`Unexpected request ${url}`);
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  clearAuth();
  vi.unstubAllGlobals();
});
function mount(
  ids: string[],
  onOpen?: (node: MapNode) => boolean,
  entry = "/?projectId=p&region=east",
  dashboard?: ReactNode,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const root = createRootRoute({
    component: () => <FunctionMaps ids={ids} onOpen={onOpen} dashboard={dashboard} />,
  });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}
async function expandMap() {
  const toggle = await screen.findByRole("button", { name: "展开" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
}
test("explains nodes before navigation and retains project/region scope", async () => {
  const { router } = mount(["D01"]);
  await expandMap();
  const node = await screen.findAllByRole("button", { name: /作业/ });
  fireEvent.click(node[0] as HTMLElement);
  expect(screen.getByRole("heading", { name: "作业" })).toBeTruthy();
  expect(router.state.location.pathname).toBe("/");
  fireEvent.click(screen.getByRole("button", { name: "打开已有入口" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
  expect(router.state.location.search).toMatchObject({ projectId: "p", region: "east" });
});
test("opens an existing form callback without navigation or production mutation", async () => {
  const onOpen = vi.fn(() => true);
  const { router } = mount(["G01"], onOpen);
  await expandMap();
  const nodes = await screen.findAllByRole("button", { name: /资源选择/ });
  fireEvent.click(nodes[0] as HTMLElement);
  fireEvent.click(screen.getByRole("button", { name: "打开已有入口" }));
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "g01.n2" }));
  expect(router.state.location.pathname).toBe("/");
  expect(
    vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET"),
  ).toBe(true);
});
test("replaces selection immediately on organization change and waits for that organization's grants", async () => {
  mount(["G21"]);
  await expandMap();
  const nodes = await screen.findAllByRole("button", { name: /提交委派/ });
  fireEvent.click(nodes[0] as HTMLElement);
  expect(screen.getByRole("heading", { name: "提交委派" })).toBeTruthy();
  act(() => {
    localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, orgB);
    window.dispatchEvent(new Event("kq:active-organization-change"));
  });
  expect(screen.queryByRole("heading", { name: "提交委派" })).toBeNull();
  await waitFor(() => expect(delayedB).not.toBeNull());
  await act(async () => {
    delayedB?.(
      response({ data: { orgId: orgB, userId: orgA, grants: [], effectiveCapabilities: [] } }),
    );
  });
  expect(screen.queryByRole("button", { name: /提交委派/ })).toBeNull();
});
test("removes revoked nodes and their explanation after a permission refresh fails", async () => {
  const { client } = mount(["G21"]);
  await expandMap();
  const nodes = await screen.findAllByRole("button", { name: /取回云盘/ });
  fireEvent.click(nodes[0] as HTMLElement);
  vi.mocked(fetch).mockImplementation(async (input) => {
    if (String(input).endsWith("/federation/capabilities"))
      return new Response(JSON.stringify({ error: { code: "FORBIDDEN", message: "denied" } }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    throw new Error("Unexpected request");
  });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ["federation", "current-capabilities"] });
  });
  await waitFor(() => expect(screen.queryByRole("heading", { name: "取回云盘" })).toBeNull());
  expect(screen.queryByRole("button", { name: /取回云盘/ })).toBeNull();
});

const preferenceKey = "kq.function-maps.v1:member%40example.test";
test("an authorized node target overrides URL and fixed defaults without rewriting them", async () => {
  const stored = { ...DEFAULT_MAP_PREFERENCES, dual: { mode: "fixed", fixed: "data" } };
  localStorage.setItem(preferenceKey, JSON.stringify(stored));
  mount(["D01"], undefined, "/?mapNode=d01.n1&mapView=data", <p>已有数据概览</p>);
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
    "资源关系",
  );
  expect(localStorage.getItem(preferenceKey)).toBe(JSON.stringify(stored));
});
test.each([
  "missing-node",
  "g21.n4",
])("invalid or unauthorized target %s does not force the diagram", async (mapNode) => {
  grants = ["delegation.read"];
  const stored = { ...DEFAULT_MAP_PREFERENCES, pages: { G21: { last: "data" } } };
  localStorage.setItem(preferenceKey, JSON.stringify(stored));
  mount(["G21"], undefined, `/?mapNode=${mapNode}&mapView=data`, <p>已有数据概览</p>);
  await waitFor(() =>
    expect(screen.getByRole("tab", { name: "数据概览" }).getAttribute("aria-selected")).toBe(
      "true",
    ),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(localStorage.getItem(preferenceKey)).toBe(JSON.stringify(stored));
});
