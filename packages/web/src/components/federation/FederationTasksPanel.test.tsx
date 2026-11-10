import type { FederationCapability } from "@kuintessence/shared/federation";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { FederationTaskDetail } from "./FederationTaskDetail";
import { FederationTasksPanel } from "./FederationTasksPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const envDigest = `sha256:${"b".repeat(64)}`;
const orgId = uuid(1),
  siteId = uuid(2),
  target = uuid(3),
  operationId = uuid(4),
  taskId = uuid(5),
  revisionId = uuid(6);
const date = "2026-01-01T00:00:00.000Z",
  until = "2099-01-01T00:00:00.000Z";
const scope = { organizationId: orgId, authRevision: "fixture" };
const template = { originSiteId: siteId, kind: "script", id: uuid(7), revision: "1", digest };
const resources = { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 60 };
const approval = {
  localOrgId: orgId,
  localSiteId: siteId,
  revisionId,
  executionUserId: null,
  state: "active",
  termsDigest: digest,
  approvalJws: "fixture.local",
  counterpartyApprovalJws: "fixture.peer",
  approvedBy: uuid(8),
  createdAt: date,
  terms: {
    protocolVersion: 1,
    kind: "agreement",
    agreementRevisionId: revisionId,
    sourceSiteId: siteId,
    targetSiteId: target,
    mode: "bilateral_direct",
    budgetDomainId: orgId,
    epoch: uuid(9),
    unit: "credit.micro",
    budgetLimit: "99999999999999999999",
    maxTaskAmount: "99999999999999999999",
    maxReservations: 10,
    validFrom: date,
    validUntil: until,
    templates: [template],
    resourceLimit: { cpus: 2, memoryMb: 256, gpus: 0, wallTimeSec: 120 },
    termsDigest: digest,
  },
};
function task() {
  return {
    localOrgId: orgId,
    localSiteId: siteId,
    targetSiteId: target,
    operationId,
    taskId,
    agreementRevisionId: revisionId,
    attempt: 1,
    template,
    resources,
    maxAmount: "0",
    unit: "credit.micro",
    state: "queued",
    lastError: null,
    receipt: null,
    cancellation: null as null | { state: string; lastError: null; receipt: null },
    remoteStatus: {
      preparation: null,
      workflow: null as null | { status: string; updatedAt: string },
      observedAt: null as null | string,
      verifiedAt: null,
      lastError: null,
      nextAttemptAt: null,
    },
    createdAt: date,
    updatedAt: date,
  };
}
function transfer() {
  return {
    id: uuid(20),
    operationId,
    manifestDigest: digest,
    state: "available",
    lastError: null,
    delivery: "network",
    receipt: { state: "pending", receivedAt: date, recordedAt: null, lastError: null },
    createdAt: date,
    updatedAt: date,
    members: [
      {
        id: uuid(21),
        outputId: digest,
        path: "result.txt",
        sizeBytes: 3,
        sha256: "a".repeat(64),
        state: "available",
        fileId: uuid(21),
      },
    ],
  };
}
let row = task(),
  transfers: ReturnType<typeof transfer>[],
  grants: FederationCapability[];
function mount(element: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (value: ReactNode) => (
    <QueryClientProvider client={client}>{value}</QueryClientProvider>
  );
  return { ...render(wrap(element)), wrap, client };
}
function detail(capabilities = grants, readOnly = false) {
  return (
    <FederationTaskDetail
      scope={scope}
      operationId={operationId}
      grants={capabilities}
      readOnly={readOnly}
      busy={false}
      onBack={vi.fn()}
    />
  );
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  row = task();
  transfers = [];
  grants = [
    "delegation.read",
    "delegation.submit",
    "delegation.cancel",
    "agreement.read",
    "asset.read",
    "result.read",
  ];
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/federation/capabilities")
      return { data: { orgId, userId: uuid(8), grants, effectiveCapabilities: grants } };
    if (path.endsWith("/context"))
      return { data: { localSiteId: siteId, supportedModes: ["bilateral_direct"] } };
    if (path.includes("/agreements?")) return { data: [approval] };
    if (path.includes("/assets/materials?"))
      return {
        data: {
          data: [
            { localOrgId: orgId, originSiteId: siteId, kind: "inputs", digest, createdAt: date },
            {
              localOrgId: orgId,
              originSiteId: siteId,
              kind: "environment-lock",
              digest: envDigest,
              createdAt: date,
            },
          ],
          hasMore: false,
        },
      };
    if (path.includes("/result-imports?")) return { data: { data: transfers, hasMore: false } };
    if (path.includes("/outbound?")) return { data: [row] };
    if (path.endsWith(operationId)) return { data: row };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    if (path === "/federation/outbound")
      return {
        data: {
          ...row,
          ...(body as object),
          localOrgId: orgId,
          localSiteId: siteId,
          targetSiteId: target,
        },
      };
    if (path.endsWith("/cancel")) {
      row.cancellation = { state: "pending", lastError: null, receipt: null };
      return { data: row.cancellation };
    }
    return { data: {} };
  });
});
async function prepare() {
  const create = await screen.findByRole("button", { name: "New task" });
  await waitFor(() => expect(create.hasAttribute("disabled")).toBe(false));
  fireEvent.click(create);
  await waitFor(() =>
    expect(screen.getByLabelText("Execution agreement").querySelectorAll("option")).toHaveLength(2),
  );
  fireEvent.change(screen.getByLabelText("Execution agreement"), { target: { value: revisionId } });
  fireEvent.change(screen.getByLabelText("Input snapshot"), { target: { value: digest } });
  fireEvent.change(screen.getByLabelText("Environment lock"), { target: { value: envDigest } });
  fireEvent.change(screen.getByLabelText(/Maximum charge/), {
    target: { value: "9007199254740993" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review task" }));
  return screen.findByRole("dialog");
}

test("submits the selected immutable resources only after confirmation and retries an unknown response with the same IDs", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("response lost"));
  mount(<FederationTasksPanel scope={scope} switching={false} />);
  const dialog = await prepare();
  expect(api.post).not.toHaveBeenCalled();
  expect(dialog.textContent).toContain("9007199254740993");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await within(dialog).findByText(/response is unknown/);
  const first = vi.mocked(api.post).mock.calls[0];
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(first);
  expect(first?.[1]).toMatchObject({
    inputManifestDigest: digest,
    environmentLockDigest: envDigest,
    maxAmount: "9007199254740993",
    resources,
  });
});

test("submission permission loss dismisses confirmation and prevents sending", async () => {
  const m = mount(<FederationTasksPanel scope={scope} switching={false} />);
  await prepare();
  grants = ["delegation.read"];
  await act(async () => {
    await m.client.invalidateQueries({ queryKey: ["federation", "current-capabilities"] });
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).not.toHaveBeenCalled();
});

test("acceptance stays separate from completion and a cancel request waits for stop confirmation", async () => {
  row.state = "accepted";
  mount(detail());
  await screen.findByText("Accepted by execution site", { exact: true });
  expect(screen.queryByText("Completed", { exact: true })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Cancel task" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Waiting for stop confirmation", { exact: true });
  expect(screen.queryByText("Stop confirmed", { exact: true })).toBeNull();
  expect(api.post).toHaveBeenCalledWith(`/federation/outbound/${operationId}/cancel`, {}, scope);
});

test("reopening a task recovers stored result transfers and retries only their delivery receipt", async () => {
  transfers = [transfer()];
  vi.mocked(api.post).mockResolvedValue({ data: { id: transfers[0]?.id, state: "pending" } });
  const m = mount(detail());
  await screen.findByText("result.txt");
  expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry delivery receipt" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenCalledWith(
    `/federation/outbound/${operationId}/result-imports/${transfers[0]?.id}/receipt-retry`,
    {},
    scope,
  );
  m.unmount();
  mount(detail());
  await screen.findByText("result.txt");
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("revoked result permission hides cached files and closes a transfer confirmation", async () => {
  transfers = [{ ...transfer(), state: "transferring" }];
  const m = mount(detail());
  fireEvent.click(await screen.findByRole("button", { name: "Cancel transfer" }));
  m.rerender(m.wrap(detail(["delegation.read"])));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("result.txt")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("foreign organization task data is rejected before it can be acted on", async () => {
  row.localOrgId = uuid(99);
  mount(detail());
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Cancel task" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
