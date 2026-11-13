import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { MediaLogisticsPanel } from "./MediaLogisticsPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
}));
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  site = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  peer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  user = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const scope = { organizationId: org, authRevision: "login-1" };
const digest = `sha256:${"a".repeat(64)}`,
  date = "2026-01-01T00:00:00Z";
const device = {
  localSiteId: site,
  localOrgId: org,
  deviceId: id,
  name: "Drive 1",
  assetTag: "D-1",
  capacityBytes: 2 ** 30,
  state: "active",
  version: 1,
  registrationDigest: digest,
  createdBy: user,
  createdAt: date,
  updatedAt: date,
};
const pkg = {
  packageId: id,
  manifestDigest: digest,
  agreementRevisionId: user,
  senderSiteId: site,
  recipientSiteId: peer,
  senderName: "Institute A",
  recipientName: "Institute B",
  subjectKind: "dataset",
  createdAt: date,
  revokedAt: null,
};
const shipment = {
  localSiteId: site,
  localOrgId: org,
  shipmentId: id,
  name: "Daily transfer",
  senderSiteId: site,
  recipientSiteId: peer,
  senderName: "Institute A",
  recipientName: "Institute B",
  packages: [{ packageId: id, manifestDigest: digest, agreementRevisionId: user }],
  state: "prepared",
  version: 1,
  registrationDigest: digest,
  createdBy: user,
  createdAt: date,
  updatedAt: date,
};
let failList = false,
  foreign = false,
  granted = true;
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <MediaLogisticsPanel scope={scope} switching={false} />
    </QueryClientProvider>,
  );
  return { client, ...result };
}
beforeEach(async () => {
  vi.resetAllMocks();
  failList = false;
  foreign = false;
  granted = true;
  await i18n.changeLanguage("en");
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith("/capabilities"))
      return {
        data: {
          orgId: org,
          userId: user,
          grants: granted ? ["media.logistics"] : [],
          effectiveCapabilities: granted ? ["media.logistics"] : [],
        },
      };
    if (path.endsWith("/logistics-context"))
      return { data: { localOrgId: org, localSiteId: site } };
    if (path.includes("/transport-packages?"))
      return { localOrgId: org, localSiteId: site, data: [pkg], hasMore: false };
    if (path.includes("/devices?"))
      return { data: [{ device, activeShipmentId: null }], hasMore: false };
    if (path.includes(`/shipments/${id}?`))
      return {
        data: { shipment, devices: [{ device, active: true }], events: [], hasMore: false },
      };
    if (failList) throw new Error("permission revoked");
    return { data: [{ ...shipment, localOrgId: foreign ? peer : org }], hasMore: false };
  });
});
test("failed device registration preserves the original ID and body for retry", async () => {
  mount();
  await screen.findByRole("button", { name: "New shipment" });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Devices" }));
  fireEvent.click(screen.getByRole("tab", { name: "Devices" }));
  fireEvent.click(await screen.findByRole("button", { name: "Register device" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New drive" } });
  fireEvent.change(screen.getByLabelText("Asset tag"), { target: { value: "D-2" } });
  fireEvent.change(screen.getByLabelText("Registered capacity (GiB)"), { target: { value: "10" } });
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error("lost response"))
    .mockImplementationOnce(async (_path, body) => ({ data: { ...device, ...(body as object) } }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Retry original request" });
  expect(screen.getByLabelText("Name").closest("fieldset")?.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
  expect(vi.mocked(api.post).mock.calls[0]?.[2]).toEqual({ ...scope, localSiteId: site });
});
test("shipment picker selects existing objects and submits their IDs", async () => {
  mount();
  await screen.findByText("Daily transfer");
  fireEvent.click(screen.getByRole("button", { name: "New shipment" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Research delivery" } });
  const checkboxes = await screen.findAllByRole("checkbox");
  for (const box of checkboxes) fireEvent.click(box);
  vi.mocked(api.post).mockImplementation(async (_path, body) => ({
    data: { ...shipment, ...(body as object) },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({
    deviceIds: [id],
    packageIds: [id],
    name: "Research delivery",
  });
});
test("sender cannot skip dispatch", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Daily transfer/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Record handoff" }));
  expect(screen.queryByRole("option", { name: "Received" })).toBeNull();
  expect(screen.getByRole("option", { name: "Dispatched" })).toBeTruthy();
});
test("foreign responses and revoked permission hide records and writes", async () => {
  foreign = true;
  const { client } = mount();
  await screen.findByRole("alert");
  expect(screen.queryByText("Daily transfer")).toBeNull();
  expect((screen.getByRole("button", { name: "New shipment" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  granted = false;
  await client.invalidateQueries({ queryKey: ["federation", "current-capabilities"] });
  await screen.findByText("Media transport permission is not granted in this organization.");
  expect(screen.queryByRole("button", { name: "New shipment" })).toBeNull();
});
test("background refresh retains content until an error, then removes stale private records", async () => {
  const { client } = mount();
  await screen.findByText("Daily transfer");
  failList = true;
  await client.invalidateQueries({ queryKey: ["federation", "media"] });
  await screen.findByRole("alert");
  expect(screen.queryByText("Daily transfer")).toBeNull();
});

test("picker pagination keeps selected devices and does not submit the form", async () => {
  const original = vi.mocked(api.get).getMockImplementation();
  const second = { ...device, deviceId: user, name: "Drive 2", assetTag: "D-2" };
  vi.mocked(api.get).mockImplementation(async (path, pinned) => {
    if (path.includes("/devices?"))
      return {
        data: [{ device: path.includes("offset=20") ? second : device, activeShipmentId: null }],
        hasMore: !path.includes("offset=20"),
      };
    return original?.(path, pinned);
  });
  mount();
  await screen.findByText("Daily transfer");
  fireEvent.click(screen.getByRole("button", { name: "New shipment" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Two-drive delivery" } });
  fireEvent.click(await screen.findByRole("checkbox", { name: "Drive 1 · D-1" }));
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  fireEvent.click(await screen.findByRole("checkbox", { name: "Drive 2 · D-2" }));
  expect(screen.getByRole("button", { name: "Remove Drive 1" })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox", { name: /Institute A/ }));
  vi.mocked(api.post).mockRejectedValueOnce(new Error("response lost"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Retry original request" });
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({
    deviceIds: [id, user],
    packageIds: [id],
  });
});

test("changing login remounts and clears the unfinished form", async () => {
  const { rerender, client } = mount();
  await screen.findByText("Daily transfer");
  fireEvent.click(screen.getByRole("button", { name: "New shipment" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Private draft" } });
  rerender(
    <QueryClientProvider client={client}>
      <MediaLogisticsPanel scope={{ ...scope, authRevision: "login-2" }} switching={false} />
    </QueryClientProvider>,
  );
  await screen.findByText("Daily transfer");
  expect(screen.queryByDisplayValue("Private draft")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("handoff with an altered confirmation remains unconfirmed and keeps the original event", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Daily transfer/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Record handoff" }));
  fireEvent.change(screen.getByLabelText("Handoff note"), {
    target: { value: "Seal intact" },
  });
  vi.mocked(api.post).mockImplementation(async (_path, body) => ({
    data: {
      localSiteId: peer,
      shipmentId: id,
      eventId: (body as { eventId: string }).eventId,
      payload: body,
      version: 2,
      recordedBy: user,
      recordedAt: date,
    },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("button", { name: "Retry original request" });
  fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
});
