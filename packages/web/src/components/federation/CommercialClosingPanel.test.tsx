import {
  type ClosingPolicy,
  ClosingPolicySchema,
  CommercialAgreementApprovalSchema,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialClosingPanel } from "./CommercialClosingPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const billId = "11111111-1111-4111-8111-111111111111",
  settlementId = "22222222-2222-4222-8222-222222222222";
const digest = `sha256:${"a".repeat(64)}`;
const scope = { organizationId: orgId, authRevision: "login-1" };
const approval = CommercialAgreementApprovalSchema.parse({
  localSiteId: target,
  localOrgId: orgId,
  revisionId,
  digest,
  approvalJws: "local.signature",
  counterpartyJws: "peer.signature",
  approvedBy: userId,
  createdAt: "2026-01-01T00:00:00Z",
  terms: {
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: userId,
    salt: "b".repeat(64),
    createdAt: "2026-01-01T00:00:00Z",
    consideration: "paid",
    priceVersionId: userId,
    termsText: "Agreed rates",
    prices: [
      {
        metric: "job.elapsed",
        quantityUnit: "job-millisecond",
        perQuantity: "1000",
        amount: "9007199254740993",
      },
    ],
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: revisionId,
      sourceSiteId: source,
      targetSiteId: target,
      mode: "bilateral_attested",
      budgetDomainId: orgId,
      epoch: userId,
      unit: "credit.micro",
      budgetLimit: "99999999999999999999999999999999999999",
      maxTaskAmount: "9007199254740993",
      maxReservations: 10,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
      templates: [{ originSiteId: source, kind: "script", id: userId, revision: "1", digest }],
      resourceLimit: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 30 },
      termsDigest: digest,
    },
  },
});
const base = `/federation/commercial-agreements/${revisionId}`;
const policy: ClosingPolicy = ClosingPolicySchema.parse({
  id: billId,
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  agreementDigest: digest,
  kind: "bill",
  outcomes: ["completed"],
  maxAmount: "9007199254740993",
  maxTotalAmount: "9007199254740999",
  maxRecords: 10,
  approvedAmount: "9007199254740993",
  approvedRecords: 1,
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: "2099-01-01T00:00:00Z",
  grantedBy: userId,
  revokedAt: null,
  revokedBy: null,
});
const task = {
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  kind: "bill",
  referenceId: billId,
  policyId: billId,
  recordId: settlementId,
  state: "complete",
  nextAttemptAt: "2026-01-01T00:00:00Z",
  lastError: null,
  completedAt: "2026-01-02T00:00:00Z",
};
let rows: unknown[];
let tasks: unknown[];
let enabled: boolean;
const onOpenRecord = vi.fn();
function mount(props: Partial<Parameters<typeof CommercialClosingPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (overrides: Partial<Parameters<typeof CommercialClosingPanel>[0]> = {}) => (
    <QueryClientProvider client={client}>
      <CommercialClosingPanel
        approval={approval}
        scope={scope}
        canBill
        canSettle
        busy={false}
        onOpenRecord={onOpenRecord}
        {...props}
        {...overrides}
      />
    </QueryClientProvider>
  );
  return { client, view, ...render(view()) };
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  rows = [];
  tasks = [];
  enabled = true;
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.includes("/closing-policies?")) return { data: rows };
    if (path.includes("/closing-tasks?")) return { data: { enabled, records: tasks } };
    throw new Error(`Unexpected read ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (path, input) => {
    if (path.endsWith("/closing-policies")) {
      const saved = { ...policy, ...(input as object), approvedAmount: "0", approvedRecords: 0 };
      rows = [saved];
      return { data: saved };
    }
    if (path.endsWith("/revoke")) {
      const saved = { ...policy, revokedAt: "2026-11-08T00:00:00Z", revokedBy: userId };
      rows = [saved];
      return { data: saved };
    }
    return { success: true };
  });
});
async function draft(kind = "bills") {
  await waitFor(() =>
    expect(screen.getByRole("button", { name: `Authorize ${kind}` }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: `Authorize ${kind}` }));
  fireEvent.change(screen.getByLabelText("Per-record limit"), {
    target: { value: "9007199254740993" },
  });
  fireEvent.change(screen.getByLabelText("Cumulative limit"), {
    target: { value: "9007199254740999" },
  });
  fireEvent.change(screen.getByLabelText("Expires at (local time)"), {
    target: { value: "2099-01-01T12:00" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review authority" }));
  return screen.findByRole("dialog");
}

test("authority grants preserve exact amounts and selected outcome behind explicit review", async () => {
  mount();
  const dialog = await draft();
  expect(api.post).not.toHaveBeenCalled();
  expect(within(dialog).getByText("9007199254740993")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Active");
  expect(api.post).toHaveBeenCalledWith(
    `${base}/closing-policies`,
    expect.objectContaining({
      kind: "bill",
      maxAmount: "9007199254740993",
      maxTotalAmount: "9007199254740999",
      maxRecords: 1,
      outcomes: ["completed"],
    }),
    scope,
  );
});

test("bill and settlement authority are independent, and permission loss clears a review", async () => {
  const mounted = mount({ canSettle: false });
  expect(screen.queryByRole("button", { name: "Authorize settlements" })).toBeNull();
  await draft();
  mounted.rerender(mounted.view({ canBill: false }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  mounted.rerender(mounted.view({ canBill: true }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("an unconfirmed grant cannot be blindly resent; refresh reconciles the saved authority", async () => {
  mount();
  const dialog = await draft();
  vi.mocked(api.post).mockImplementationOnce(async () => {
    rows = [policy];
    throw new Error("Response lost");
  });
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText(/The grant outcome is unknown/);
  expect(screen.getByRole("button", { name: "Authorize bills" }).hasAttribute("disabled")).toBe(
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Active");
  expect(screen.getByRole("button", { name: "Authorize bills" }).hasAttribute("disabled")).toBe(
    true,
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("revoke targets the original authority and shows that existing signatures survive", async () => {
  rows = [policy];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Revoke authority" }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(/Existing signatures/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Revoked");
  expect(api.post).toHaveBeenCalledWith(`${base}/closing-policies/${policy.id}/revoke`, {}, scope);
});

test.each([
  { localOrgId: source },
  { agreementDigest: `sha256:${"b".repeat(64)}` },
  { approvedAmount: "1e3" },
  { approvedRecords: 11 },
])("invalid or foreign policy data is rejected without showing mutation controls: %j", async (change) => {
  rows = [{ ...policy, ...change }];
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Revoke authority" })).toBeNull();
  expect(screen.getByRole("button", { name: "Authorize bills" }).hasAttribute("disabled")).toBe(
    true,
  );
});

test("institution and login changes discard private drafts and pending reviews", async () => {
  const mounted = mount();
  await draft();
  mounted.rerender(mounted.view({ scope: { ...scope, authRevision: "login-2" } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByLabelText("Per-record limit")).toBeNull();
  await draft();
  mounted.rerender(mounted.view({ scope: { organizationId: source, authRevision: "login-2" } }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("completed task names signature completion and links the exact original record", async () => {
  rows = [policy];
  tasks = [task];
  mount({ canBill: false, canSettle: false });
  await screen.findByText("Bill · Both signatures received");
  fireEvent.click(screen.getByRole("button", { name: "View bill" }));
  expect(onOpenRecord).toHaveBeenCalledWith("bill", settlementId);
  expect(screen.queryByRole("button", { name: "Revoke authority" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry processing" })).toBeNull();
});

test("review retries keep the original reference and independent kind authority", async () => {
  tasks = [{ ...task, state: "needs_review", completedAt: null, lastError: "POLICY_DENIED" }];
  const mounted = mount({ canSettle: false });
  fireEvent.click(await screen.findByRole("button", { name: "Retry processing" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${base}/closing-tasks/bill/${billId}/retry`, {}, scope),
  );
  mounted.rerender(mounted.view({ canBill: false }));
  expect(screen.queryByRole("button", { name: "Retry processing" })).toBeNull();
});

test("unconfigured transport still shows original task history", async () => {
  enabled = false;
  tasks = [task];
  mount();
  await screen.findByText(/No sending transport/);
  expect(screen.getByRole("button", { name: "View bill" })).toBeTruthy();
});

test("source refund tasks open the original refund and retry the delegation reference", async () => {
  tasks = [
    {
      ...task,
      localSiteId: source,
      kind: "refund",
      state: "needs_review",
      completedAt: null,
      lastError: "POLICY_DENIED",
    },
  ];
  mount({ approval: { ...approval, localSiteId: source } });
  fireEvent.click(await screen.findByRole("button", { name: "View refund" }));
  expect(onOpenRecord).toHaveBeenCalledWith("refund", settlementId);
  fireEvent.click(screen.getByRole("button", { name: "Retry processing" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `${base}/closing-tasks/refund/${billId}/retry`,
      {},
      scope,
    ),
  );
});

test("refund authority fixes preexecution cancellation and preserves exact limits after review", async () => {
  mount();
  const dialog = await draft("cancellation refunds");
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Completed")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Active");
  expect(api.post).toHaveBeenCalledWith(
    `${base}/closing-policies`,
    expect.objectContaining({
      kind: "refund",
      outcomes: ["cancelled"],
      maxAmount: "9007199254740993",
      maxTotalAmount: "9007199254740999",
      maxRecords: 1,
    }),
    scope,
  );
});

test("refund authority requires financial permission and is unavailable in coordinated mode", async () => {
  const mounted = mount({ canSettle: false });
  expect(screen.queryByRole("button", { name: "Authorize cancellation refunds" })).toBeNull();
  mounted.rerender(
    mounted.view({
      canSettle: true,
      approval: {
        ...approval,
        terms: {
          ...approval.terms,
          agreement: { ...approval.terms.agreement, mode: "ledger_coordinated" },
        },
      },
    }),
  );
  expect(screen.queryByRole("button", { name: "Authorize cancellation refunds" })).toBeNull();
});

test("expired authority cannot silently renew; zero-value authority is not exhausted by amount alone", async () => {
  rows = [{ ...policy, validUntil: "2026-01-02T00:00:00Z" }];
  const mounted = mount();
  await screen.findByText("Expired");
  expect(screen.getByRole("button", { name: "Authorize bills" }).hasAttribute("disabled")).toBe(
    true,
  );
  rows = [{ ...policy, maxAmount: "0", maxTotalAmount: "0", approvedAmount: "0" }];
  mounted.rerender(mounted.view({ scope: { ...scope, authRevision: "login-2" } }));
  await screen.findByText("Active");
});

test("form rejects fractional amounts, contract overflow and missing outcomes without creating authority", async () => {
  mount();
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Authorize settlements" }).hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Authorize settlements" }));
  fireEvent.change(screen.getByLabelText("Expires at (local time)"), {
    target: { value: "2099-01-01T12:00" },
  });
  for (const amount of ["1.1", "9007199254740994"]) {
    fireEvent.change(screen.getByLabelText("Per-record limit"), { target: { value: amount } });
    fireEvent.change(screen.getByLabelText("Cumulative limit"), {
      target: { value: "9007199254740999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review authority" }));
    await screen.findByRole("alert");
    expect(screen.queryByRole("dialog")).toBeNull();
  }
  fireEvent.change(screen.getByLabelText("Per-record limit"), { target: { value: "0" } });
  fireEvent.click(screen.getByLabelText("Completed"));
  fireEvent.click(screen.getByRole("button", { name: "Review authority" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("paginated authority and tasks keep organization, contract and separate offsets", async () => {
  rows = Array.from({ length: 20 }, (_, i) => ({
    ...policy,
    id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    revokedAt: policy.validFrom,
    revokedBy: userId,
  }));
  mount();
  const section = screen.getByRole("region", { name: "Institution authority" });
  fireEvent.click(await within(section).findByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${base}/closing-policies?limit=20&offset=20`, scope),
  );
  expect(api.get).not.toHaveBeenCalledWith(`${base}/closing-tasks?limit=20&offset=20`, scope);
});
