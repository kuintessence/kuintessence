import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { FederationStoragePanel } from "./FederationStoragePanel";

vi.mock("../../lib/api-client", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const device = vi.hoisted(() => ({ readOnly: false }));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({
  useMobileMutationBlocked: () => device.readOnly,
}));
const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const root = "/admin/federation/input-reconciliation";
const digest = `sha256:${"b".repeat(64)}`;
const base = {
  generation,
  importId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  reservationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  localSiteId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  transferId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  storageKey: "federation-inputs/attempt/input.dat",
  sizeBytes: 12,
  sha256: "a".repeat(64),
  allocationStartedAt: "2020-01-01T00:00:00.000Z",
  leaseUntil: "2020-01-01T00:01:00.000Z",
  uploadId: null,
  completionStartedAt: null,
  completionSettledAt: null,
  destinationVersionId: null,
  destinationEtag: null,
  state: "cleanup_pending",
  importState: "cancelling",
  executionStopped: true,
  snapshotDigest: digest,
  reconciliation: null,
};
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, refetchOnWindowFocus: false },
            mutations: { retry: false },
          },
        })
      }
    >
      <FederationStoragePanel />
    </QueryClientProvider>,
  );
}
async function open() {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(generation) }));
  await screen.findByText(base.storageKey);
}
function fill() {
  fireEvent.change(screen.getByLabelText("Incident ID"), { target: { value: "INC-42" } });
  fireEvent.change(screen.getByLabelText("Evidence SHA-256"), { target: { value: digest } });
  fireEvent.change(screen.getByLabelText("Writers stopped and requests drained at (local)"), {
    target: { value: "2020-01-02T12:00:00" },
  });
  fireEvent.click(screen.getByLabelText(/All original writers/));
  fireEvent.click(screen.getByLabelText(/Storage-side in-flight requests/));
}
beforeEach(async () => {
  vi.resetAllMocks();
  device.readOnly = false;
  await i18n.changeLanguage("en");
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [base] : base,
  }));
  vi.mocked(api.post).mockResolvedValue({ success: true });
});

test("shows the exact request snapshot and never equates unknown outcomes with stopped requests", async () => {
  mount();
  await open();
  expect(screen.getByText(base.importId)).toBeTruthy();
  expect(screen.getByText(/Empty listings or timeouts do not prove/)).toBeTruthy();
  expect(screen.getByText(digest)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Record drain attestation" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

test("requires both unchecked attestations and confirmation, binding the original snapshot", async () => {
  mount();
  await open();
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Record drain attestation" }));
  const dialog = await screen.findByRole("dialog");
  expect(api.post).not.toHaveBeenCalled();
  expect(within(dialog).getByText(generation)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Record attestation" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${root}/${generation}`, {
      snapshotDigest: digest,
      incidentId: "INC-42",
      evidenceDigest: digest,
      stoppedAt: new Date("2020-01-02T12:00:00").toISOString(),
      allWritersStopped: true,
      storageRequestsDrained: true,
    }),
  );
});

test.each([
  "2099-01-01T12:00:00",
  "2019-01-01T12:00:00",
])("rejects a stop time outside the expired-lease interval: %s", async (time) => {
  mount();
  await open();
  fill();
  fireEvent.change(screen.getByLabelText("Writers stopped and requests drained at (local)"), {
    target: { value: time },
  });
  fireEvent.click(screen.getByRole("button", { name: "Record drain attestation" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("blocks requests whose execution has not stopped", async () => {
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [base] : { ...base, executionStopped: false },
  }));
  mount();
  await open();
  expect(screen.getByText(/Not eligible:/)).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Record drain attestation" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(screen.getByLabelText("Incident ID").closest("fieldset")?.disabled).toBe(true);
});

test("keeps the same attestation after a failed response and clears it when a refreshed snapshot changes", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("conflict"));
  mount();
  await open();
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Record drain attestation" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Record attestation" }),
  );
  expect(await screen.findByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Record attestation" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect((screen.getByLabelText("Incident ID") as HTMLInputElement).value).toBe("INC-42");
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [base] : { ...base, snapshotDigest: `sha256:${"c".repeat(64)}` },
  }));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect((screen.getByLabelText("Incident ID") as HTMLInputElement).value).toBe(""),
  );
  expect((screen.getByLabelText(/All original writers/) as HTMLInputElement).checked).toBe(false);
});

test("shows recorded decisions and cleanup status without offering another write", async () => {
  const plan = {
    ...base,
    reconciliation: {
      snapshotDigest: digest,
      stoppedAt: "2020-01-02T12:00:00.000Z",
      incidentId: "INC-42",
      evidenceDigest: digest,
      allWritersStopped: true,
      storageRequestsDrained: true,
      actorId: generation,
      recordedAt: "2020-01-02T13:00:00.000Z",
    },
  };
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [plan] : plan,
  }));
  mount();
  await open();
  expect(screen.getByText("INC-42")).toBeTruthy();
  expect(screen.getByText(/Actual storage cleanup is still required/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record drain attestation" })).toBeNull();
});

test("supports direct lookup after a request leaves the pending list and rejects invalid IDs", async () => {
  vi.mocked(api.get).mockImplementation(async (path) => ({
    data: path.includes("?") ? [] : { ...base, state: "cleaned", importState: "cancelled" },
  }));
  mount();
  await screen.findByText("No unknown storage requests to reconcile");
  fireEvent.change(screen.getByLabelText("Attempt generation"), { target: { value: "invalid" } });
  fireEvent.click(screen.getByRole("button", { name: "Look up" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(api.get).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Attempt generation"), { target: { value: generation } });
  fireEvent.click(screen.getByRole("button", { name: "Look up" }));
  await screen.findByText("Cleaned");
  expect(api.get).toHaveBeenCalledWith(`${root}/${generation}`);
  expect(
    screen.getByRole("button", { name: "Record drain attestation" }).hasAttribute("disabled"),
  ).toBe(true);
});

test("keeps mobile read-only and hides old write controls when refresh fails", async () => {
  device.readOnly = true;
  mount();
  await open();
  expect(screen.getByText(/Read-only on mobile/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Record drain attestation" })).toBeNull();
  vi.mocked(api.get).mockRejectedValue(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(screen.queryByText(base.storageKey)).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
