import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import en from "../../locales/federation.en.json";
import zh from "../../locales/federation.zh.json";
import { FederationTrustPanel } from "./FederationTrustPanel";

vi.mock("../../lib/api-client", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
const device = vi.hoisted(() => ({ readOnly: false }));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({
  useMobileMutationBlocked: () => device.readOnly,
}));
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const base = {
  id,
  name: "Research North",
  endpoint: "https://north.example.org",
  state: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const key = {
  siteId: id,
  keyId: "signing-2026",
  publicKeyPem: "-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----",
  allowedKinds: ["agreement"],
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2036-01-01T00:00:00.000Z",
  revokedAt: null,
};
const details = {
  ...base,
  keys: [key],
  certificates: [
    {
      siteId: id,
      fingerprint: "a".repeat(64),
      certificatePem: "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----",
      validFrom: key.validFrom,
      validUntil: key.validUntil,
      revokedAt: null,
    },
  ],
};
const root = "/admin/federation/sites";
function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <FederationTrustPanel />
    </QueryClientProvider>,
  );
}
async function openSite() {
  fireEvent.click(await screen.findByRole("button", { name: /Research North/ }));
  await screen.findByText("signing-2026");
}
beforeEach(async () => {
  vi.resetAllMocks();
  device.readOnly = false;
  await i18n.changeLanguage("en");
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [base] : details,
  }));
  vi.mocked(api.post).mockResolvedValue({ success: true });
  vi.mocked(api.put).mockResolvedValue({ success: true });
});

test("shows institution trust and scoped signing purposes, with explicit PEM inspection", async () => {
  mount();
  await openSite();
  expect(screen.getByText("Agreement")).toBeTruthy();
  expect(screen.getByText("Client certificates")).toBeTruthy();
  expect(screen.getByText("a".repeat(64))).toBeTruthy();
  expect(screen.getAllByText("View PEM")).toHaveLength(2);
  expect(api.get).toHaveBeenCalledWith(`${root}/${id}`);
});
test("validates registration and sends the institution's fixed site ID", async () => {
  mount();
  await screen.findByRole("button", { name: /Research North/ });
  fireEvent.click(screen.getByRole("button", { name: "Register institution" }));
  fireEvent.change(screen.getByLabelText("Institution name"), {
    target: { value: "New Institute" },
  });
  fireEvent.change(screen.getByLabelText("Site ID"), { target: { value: "invalid" } });
  fireEvent.change(screen.getByLabelText("Federation HTTPS origin"), {
    target: { value: "http://bad.example.org/path" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Site ID"), { target: { value: id } });
  fireEvent.change(screen.getByLabelText("Federation HTTPS origin"), {
    target: { value: base.endpoint },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(root, {
      id,
      name: "New Institute",
      endpoint: base.endpoint,
    }),
  );
});
test("edits name and origin without changing the site ID and preserves a rejected draft", async () => {
  vi.mocked(api.put).mockRejectedValue(new Error("Rejected"));
  mount();
  await openSite();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Site ID") as HTMLInputElement).readOnly).toBe(true);
  fireEvent.change(screen.getByLabelText("Institution name"), {
    target: { value: "Corrected institute" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Institution name") as HTMLInputElement).value).toBe(
    "Corrected institute",
  );
  expect(api.put).toHaveBeenCalledWith(`${root}/${id}`, {
    name: "Corrected institute",
    endpoint: base.endpoint,
  });
});
test("adds a key with explicit purposes and local dates converted to ISO, rejecting private PEM", async () => {
  mount();
  await openSite();
  fireEvent.click(screen.getByRole("button", { name: "Add public key" }));
  expect(
    screen.getAllByRole("checkbox").every((input) => !(input as HTMLInputElement).checked),
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Key ID"), { target: { value: "new-key" } });
  fireEvent.change(screen.getByLabelText("Signing public key (PEM)"), {
    target: { value: "-----BEGIN PRIVATE KEY-----\nsecret" },
  });
  fireEvent.change(screen.getByLabelText("Valid from (local time)"), {
    target: { value: "2026-01-01T12:00" },
  });
  fireEvent.change(screen.getByLabelText("Valid until (local time)"), {
    target: { value: "2030-01-01T12:00" },
  });
  fireEvent.click(screen.getByLabelText("Input download grant"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Signing public key (PEM)"), {
    target: { value: key.publicKeyPem },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${root}/${id}/keys`, {
      keyId: "new-key",
      publicKeyPem: key.publicKeyPem,
      allowedKinds: ["input-download-grant"],
      validFrom: new Date("2026-01-01T12:00").toISOString(),
      validUntil: new Date("2030-01-01T12:00").toISOString(),
    }),
  );
});
test("registers certificates through their dedicated endpoint", async () => {
  mount();
  await openSite();
  fireEvent.click(screen.getByRole("button", { name: "Add certificate" }));
  fireEvent.change(screen.getByLabelText("Institution client certificate (PEM)"), {
    target: { value: details.certificates[0]?.certificatePem },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${root}/${id}/certificates`, {
      certificatePem: details.certificates[0]?.certificatePem,
    }),
  );
});
test("requires target-specific confirmation before revocation and keeps failed confirmation open", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("Rejected"));
  mount();
  await openSite();
  const revoke = screen.getAllByRole("button", { name: "Revoke" })[0];
  if (!revoke) throw new Error("Missing revoke action");
  fireEvent.click(revoke);
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("signing-2026")).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await within(dialog).findByRole("alert");
  expect(api.post).toHaveBeenCalledWith(`${root}/${id}/revoke`, { keyId: "signing-2026" });
  expect(screen.getByRole("dialog")).toBeTruthy();
});
test("mobile view disables trust mutations but keeps institution details readable", async () => {
  device.readOnly = true;
  mount();
  await openSite();
  expect(screen.getByText(/View only on mobile/)).toBeTruthy();
  for (const name of [
    "Register institution",
    "Edit",
    "Suspend trust",
    "Permanently revoke institution",
    "Add public key",
    "Add certificate",
  ]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(api.post).not.toHaveBeenCalled();
});
test("failed refresh hides stale write actions and exposes a retry", async () => {
  mount();
  await openSite();
  vi.mocked(api.get).mockRejectedValue(new Error("Offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Add public key" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Register institution" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [base] : details,
  }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("signing-2026");
});
test("late institution responses cannot replace the currently selected institution", async () => {
  const pending = Promise.withResolvers<unknown>();
  const second = { ...base, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Research South" };
  vi.mocked(api.get).mockImplementation(async (path) =>
    path.includes("?")
      ? { data: [base, second] }
      : path.endsWith(id)
        ? pending.promise
        : { data: { ...second, keys: [], certificates: [] } },
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Research North/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Back to institutions" }));
  fireEvent.click(await screen.findByRole("button", { name: /Research South/ }));
  await screen.findByRole("heading", { name: "Research South" });
  pending.resolve({ data: details });
  await waitFor(() => expect(screen.queryByText("signing-2026")).toBeNull());
  expect(screen.getByRole("heading", { name: "Research South" })).toBeTruthy();
});
test("revoked institutions stay readable but cannot be resumed or edited", async () => {
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [{ ...base, state: "revoked" }] : { ...details, state: "revoked" },
  }));
  mount();
  await openSite();
  expect((screen.getByRole("button", { name: "Resume trust" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
});
test("federation translations cover identical signing purposes in both languages", () => {
  expect(Object.keys(zh.federation.kinds).sort()).toEqual(Object.keys(en.federation.kinds).sort());
  expect(Object.keys(zh.federation).sort()).toEqual(Object.keys(en.federation).sort());
});
