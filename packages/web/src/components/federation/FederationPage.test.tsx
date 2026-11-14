import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  ACTIVE_ORGANIZATION_STORAGE_KEY,
  getActiveOrganizationContext,
  setActiveOrganization,
} from "../../lib/active-organization";
import { setAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import { FederationPage } from "./FederationPage";

vi.mock("../../lib/active-organization", async (original) => ({
  ...(await original<typeof import("../../lib/active-organization")>()),
  getActiveOrganizationContext: vi.fn(),
  setActiveOrganization: vi.fn(),
}));
vi.mock("./AgreementPanel", () => ({
  AgreementPanel: ({
    scope,
    switching,
  }: {
    scope: { organizationId: string; authRevision: string | null };
    switching: boolean;
  }) => (
    <div>
      <output>{`${scope.organizationId}:${scope.authRevision}`}</output>
      <input aria-label="Draft" disabled={switching} />
    </div>
  ),
}));
vi.mock("./CommercialPanel", () => ({
  CommercialPanel: () => <input aria-label="Commercial draft" />,
}));
vi.mock("./FederationAssetsPanel", () => ({
  FederationAssetsPanel: () => <div>Asset list</div>,
}));
const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function mount(section?: "commercial") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["jobs-list"], { institution: orgA });
  client.setQueryData(["unrelated", "theme"], "dark");
  render(
    <QueryClientProvider client={client}>
      <FederationPage section={section} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(async () => {
  vi.resetAllMocks();
  localStorage.clear();
  setAuth({ token: null, email: "member@example.test", role: "user" });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, orgA);
  await i18n.changeLanguage("en");
  vi.mocked(getActiveOrganizationContext).mockImplementation(async () => ({
    activeOrganizationId: localStorage.getItem(ACTIVE_ORGANIZATION_STORAGE_KEY),
    organizations: [
      { orgId: orgA, name: "Research center", role: "member" },
      { orgId: orgB, name: "Research center", role: "member" },
    ],
  }));
  vi.mocked(setActiveOrganization).mockImplementation(async (id) => {
    if (id) localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, id);
    window.dispatchEvent(new Event("kq:active-organization-change"));
  });
});

test("ordinary members can select their institutions and switching discards the previous draft and resource cache", async () => {
  const client = mount();
  const selector = await screen.findByLabelText("Current institution");
  expect(screen.getByRole("option", { name: `Research center · ${orgB}` })).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "old reviewed terms" } });
  fireEvent.change(selector, { target: { value: orgB } });
  await waitFor(() => expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(""));
  expect(setActiveOrganization).toHaveBeenCalledWith(orgB, expect.anything());
  await waitFor(() => expect(client.getQueryData(["jobs-list"])).toBeUndefined());
  expect(client.getQueryData(["unrelated", "theme"])).toBe("dark");
});

test("the module heading replaces duplicate in-page navigation", async () => {
  mount();
  await screen.findByLabelText("Draft");
  expect(screen.getByRole("heading", { level: 1, name: "Agreements" })).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
});

test("no organization retains the workspace heading without exposing institution panels", async () => {
  localStorage.removeItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  vi.mocked(getActiveOrganizationContext).mockResolvedValue({
    activeOrganizationId: null,
    organizations: [],
  });
  mount();
  await screen.findByLabelText("Current institution");
  expect(screen.getByRole("heading", { name: "Agreements" })).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Choose institution");
});

test("distinct institution names omit identifiers from the selector", async () => {
  vi.mocked(getActiveOrganizationContext).mockResolvedValue({
    activeOrganizationId: orgA,
    organizations: [{ orgId: orgA, name: "Research center", role: "member" }],
  });
  mount();
  await screen.findByLabelText("Draft");
  expect(screen.getByRole("option", { name: "Research center" })).toBeTruthy();
  expect(screen.queryByRole("option", { name: `Research center · ${orgA}` })).toBeNull();
});

test("login identity changes remount the agreement form", async () => {
  mount();
  const draft = await screen.findByLabelText("Draft");
  fireEvent.change(draft, { target: { value: "old reviewed terms" } });
  act(() => setAuth({ token: null, email: "other@example.test", role: "user" }));
  await waitFor(() => expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(""));
  expect(getActiveOrganizationContext).toHaveBeenCalledTimes(2);
});

test("another tab's institution selection also replaces the draft and clears resource caches", async () => {
  const client = mount();
  await screen.findByLabelText("Draft");
  fireEvent.change(screen.getByLabelText("Draft"), { target: { value: "old terms" } });
  localStorage.setItem(ACTIVE_ORGANIZATION_STORAGE_KEY, orgB);
  fireEvent(
    window,
    new StorageEvent("storage", {
      key: ACTIVE_ORGANIZATION_STORAGE_KEY,
      storageArea: localStorage,
    }),
  );
  await waitFor(() => expect((screen.getByLabelText("Draft") as HTMLInputElement).value).toBe(""));
  await waitFor(() => expect(client.getQueryData(["jobs-list"])).toBeUndefined());
  expect(setActiveOrganization).not.toHaveBeenCalled();
});

test("commercial drafts are discarded with an institution change", async () => {
  mount("commercial");
  const selector = await screen.findByLabelText("Current institution");
  const draft = await screen.findByLabelText("Commercial draft");
  fireEvent.change(draft, { target: { value: "private contract" } });
  fireEvent.change(selector, { target: { value: orgB } });
  await waitFor(() =>
    expect((screen.getByLabelText("Commercial draft") as HTMLInputElement).value).toBe(""),
  );
  expect(screen.getByRole("heading", { level: 1, name: "Commercial contracts" })).toBeTruthy();
});

vi.mock("./MediaDeliveryPanel", () => ({
  MediaDeliveryPanel: ({
    exportFrom,
  }: {
    exportFrom?: { workflowRunId: string; taskKind: string };
  }) => (
    <div>
      <output aria-label="Workflow selection">
        {exportFrom ? `${exportFrom.workflowRunId}:${exportFrom.taskKind}` : "all"}
      </output>
      <input aria-label="Media draft" />
    </div>
  ),
}));

test("workflow navigation opens scoped delivery and replaces drafts on the next workflow", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (workflowRunId: string) => (
    <QueryClientProvider client={client}>
      <FederationPage mediaExport={{ workflowRunId, taskKind: "task-input" }} />
    </QueryClientProvider>
  );
  const rendered = render(view(orgA));
  await screen.findByLabelText("Workflow selection");
  expect(screen.getByRole("heading", { level: 1, name: "Media delivery" })).toBeTruthy();
  expect(screen.queryByRole("tablist")).toBeNull();
  expect(screen.getByLabelText("Workflow selection").textContent).toBe(`${orgA}:task-input`);
  fireEvent.change(screen.getByLabelText("Media draft"), { target: { value: "old draft" } });
  rendered.rerender(view(orgB));
  await waitFor(() =>
    expect(screen.getByLabelText("Workflow selection").textContent).toBe(`${orgB}:task-input`),
  );
  expect((screen.getByLabelText("Media draft") as HTMLInputElement).value).toBe("");
});
