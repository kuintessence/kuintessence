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
const orgA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const orgB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["jobs-list"], { institution: orgA });
  client.setQueryData(["unrelated", "theme"], "dark");
  render(
    <QueryClientProvider client={client}>
      <FederationPage />
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
  mount();
  const selector = await screen.findByLabelText("Current institution");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Commercial contracts" }), {
    button: 0,
    ctrlKey: false,
  });
  const draft = await screen.findByLabelText("Commercial draft");
  fireEvent.change(draft, { target: { value: "private contract" } });
  fireEvent.change(selector, { target: { value: orgB } });
  await waitFor(() => expect(screen.queryByLabelText("Commercial draft")).toBeNull());
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Commercial contracts" }), {
    button: 0,
    ctrlKey: false,
  });
  expect(((await screen.findByLabelText("Commercial draft")) as HTMLInputElement).value).toBe("");
});
