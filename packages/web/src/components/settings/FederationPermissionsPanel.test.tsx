import { FederationCapabilitySchema } from "@kuintessence/shared/federation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import { clearAuth, setAuth } from "../../lib/auth";
import i18n from "../../lib/i18n";
import { FederationPermissionsPanel } from "./FederationPermissionsPanel";

vi.mock("../../lib/api-client", () => ({ api: { get: vi.fn(), put: vi.fn() } }));
const device = vi.hoisted(() => ({ readOnly: false }));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({
  useMobileMutationBlocked: () => device.readOnly,
}));
const orgId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const secondOrgId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const root = "/admin/federation/capabilities";
const grant = {
  orgId,
  userId,
  capability: "agreement.read",
  grantedBy: userId,
  grantedAt: "2026-01-01T00:00:00.000Z",
  email: "researcher@example.test",
  displayName: "Researcher",
  suspended: false,
  serviceAccount: false,
  membershipActive: true,
};
const directory = {
  data: {
    organizations: [
      { id: orgId, name: "Research North" },
      { id: secondOrgId, name: "Research South" },
    ],
    moreOrganizations: false,
  },
};
const members = {
  data: [{ userId, email: grant.email, displayName: grant.displayName }],
  hasMore: false,
};
function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <FederationPermissionsPanel />
    </QueryClientProvider>,
  );
  return client;
}
async function open() {
  fireEvent.click(await screen.findByRole("button", { name: "Research North" }));
  await screen.findByText("View agreements");
}
async function startGrant() {
  fireEvent.click(screen.getByRole("button", { name: "Grant permission" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Researcher (researcher@example.test)" }),
  );
  fireEvent.change(screen.getByLabelText("Permission"), { target: { value: "agreement.approve" } });
}
beforeEach(async () => {
  vi.resetAllMocks();
  device.readOnly = false;
  await i18n.changeLanguage("en");
  vi.mocked(api.get).mockImplementation(async (path) =>
    path.startsWith("/admin/authz")
      ? directory
      : path.startsWith(`${root}/members`)
        ? members
        : { data: [grant] },
  );
  vi.mocked(api.put).mockResolvedValue({ success: true });
});

test("grants only the selected capability to a named member in the selected organization", async () => {
  mount();
  await open();
  expect(api.get).toHaveBeenCalledWith(`${root}?orgId=${orgId}&limit=20&offset=0`);
  fireEvent.click(screen.getByRole("button", { name: "Grant permission" }));
  const form = screen.getByLabelText("Permission").closest("form");
  if (!form) throw new Error("Expected grant form");
  expect(
    within(form).getByRole("button", { name: "Grant permission" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(
    await screen.findByRole("button", { name: "Researcher (researcher@example.test)" }),
  );
  fireEvent.change(screen.getByLabelText("Permission"), { target: { value: "agreement.approve" } });
  expect(screen.getByText(/Platform roles do not automatically/)).toBeTruthy();
  fireEvent.click(within(form).getByRole("button", { name: "Grant permission" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(root, {
      orgId,
      userId,
      capability: "agreement.approve",
      enabled: true,
    }),
  );
  expect(api.get).toHaveBeenCalledWith(`${root}/members?orgId=${orgId}&search=&limit=20&offset=0`);
});

test("failed saves retain the member and capability and keep navigation from discarding the draft", async () => {
  vi.mocked(api.put).mockRejectedValue(new Error("write failed"));
  mount();
  await open();
  await startGrant();
  expect(
    screen.getByRole("button", { name: "Back to organizations" }).hasAttribute("disabled"),
  ).toBe(true);
  const form = screen.getByLabelText("Permission").closest("form");
  if (!form) throw new Error("Expected form");
  fireEvent.click(within(form).getByRole("button", { name: "Grant permission" }));
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Permission") as HTMLSelectElement).value).toBe(
    "agreement.approve",
  );
  expect(screen.getByText("Researcher (researcher@example.test)")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Permission")).toBeNull();
});

test("removal confirms one direct grant and can revoke grants belonging to a former member", async () => {
  vi.mocked(api.get).mockImplementation(async (path) =>
    path.startsWith("/admin/authz") ? directory : { data: [{ ...grant, membershipActive: false }] },
  );
  mount();
  await open();
  expect(screen.getByText("Member no longer eligible")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Remove grant" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(/other grants may still include/)).toBeTruthy();
  expect(api.put).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(root, {
      orgId,
      userId,
      capability: "agreement.read",
      enabled: false,
    }),
  );
});

test("mobile users can inspect grants but cannot create or remove them", async () => {
  device.readOnly = true;
  mount();
  await open();
  expect(screen.getByText(/Read-only on mobile/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "Grant permission" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(screen.getByRole("button", { name: "Remove grant" }).hasAttribute("disabled")).toBe(true);
  expect(api.put).not.toHaveBeenCalled();
});

test.each([
  "hard",
  "transport",
])("%s refresh failure blocks writes without trapping a draft", async (kind) => {
  const client = mount();
  await open();
  await startGrant();
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.startsWith(`${root}?`))
      throw kind === "transport" ? new TypeError("offline") : new Error("invalid response");
    return members;
  });
  await client.invalidateQueries({ queryKey: ["federation", "grants", orgId, 0] });
  if (kind === "transport") {
    await screen.findByText("Refresh failed. Showing the previously loaded data.");
    expect(screen.getByRole("button", { name: "Remove grant" }).hasAttribute("disabled")).toBe(
      true,
    );
  } else {
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Remove grant" })).toBeNull();
  }
  expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByLabelText("Permission")).toBeNull();
  expect(api.put).not.toHaveBeenCalled();
});

test("switching organizations cannot show a late response from the previous organization", async () => {
  let finish: (value: unknown) => void = () => {
    throw new Error("No pending request");
  };
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.startsWith("/admin/authz")) return directory;
    if (path.includes(secondOrgId))
      return { data: [{ ...grant, orgId: secondOrgId, displayName: "South Member" }] };
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Research North" }));
  fireEvent.click(await screen.findByRole("button", { name: "Back to organizations" }));
  const next = await screen.findByRole("button", { name: "Research South" });
  await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));
  fireEvent.click(next);
  await screen.findByText("South Member");
  finish({ data: [grant] });
  await waitFor(() => expect(screen.queryByText("Researcher")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Remove grant" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }),
  );
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(root, {
      orgId: secondOrgId,
      userId,
      capability: "agreement.read",
      enabled: false,
    }),
  );
});

test("every explicit capability has a translated label and effect in both languages", async () => {
  for (const lng of ["zh", "en"]) {
    await i18n.changeLanguage(lng);
    for (const capability of FederationCapabilitySchema.options) {
      expect(i18n.exists(`federation.permissions.capabilities.${capability}`, { lng })).toBe(true);
      expect(i18n.exists(`federation.permissions.effects.${capability}`, { lng })).toBe(true);
    }
  }
});

test("distinguishes organizations with the same name before granting authority", async () => {
  vi.mocked(api.get).mockImplementation(async (path) =>
    path.startsWith("/admin/authz")
      ? {
          data: {
            organizations: directory.data.organizations.map((org) => ({
              ...org,
              name: "Same Institute",
            })),
            moreOrganizations: false,
          },
        }
      : { data: [] },
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(secondOrgId) }));
  await screen.findByText("No federation grants in this organization");
  expect(screen.getByText(secondOrgId)).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith(`${root}?orgId=${secondOrgId}&limit=20&offset=0`);
});

test("changing login discards prior grants and drafts when the new session cannot refresh", async () => {
  mount();
  await open();
  await startGrant();
  vi.mocked(api.get).mockRejectedValue(new TypeError("offline"));
  try {
    act(() => setAuth({ email: "another@example.test", role: "admin" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Remove grant" })).toBeNull();
    expect(screen.queryByLabelText("Permission")).toBeNull();
    expect(screen.queryByText("Research North")).toBeNull();
    expect(api.put).not.toHaveBeenCalled();
  } finally {
    act(() => clearAuth());
  }
});
