import {
  CommercialAgreementApprovalSchema,
  CommercialPaymentListSchema,
  CommercialPaymentSchema,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialPaymentPanel } from "./CommercialPaymentPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const receiptId = "22222222-2222-4222-8222-222222222222";
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

const billId = "33333333-3333-4333-8333-333333333333";
const paymentId = "44444444-4444-4444-8444-444444444444";
const payment = CommercialPaymentSchema.parse({
  protocolVersion: 1,
  kind: "commercial-payment",
  receiptId,
  paymentId,
  domainId: userId,
  agreementRevisionId: revisionId,
  agreementDigest: digest,
  billId,
  billDigest: digest,
  sourceSiteId: source,
  targetSiteId: target,
  amount: "9007199254740993",
  unit: "credit.micro",
  occurredAt: "2026-01-01T00:00:00Z",
  issuedAt: "2026-01-02T00:00:00Z",
  evidenceDigest: digest,
  previous: null,
  reason: "External payment acknowledged",
  salt: "c".repeat(64),
});
const saved = {
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  receiptId,
  paymentId,
  billId,
  payload: payment,
  digest,
  approvalJws: "payment.local.signature",
  counterpartyJws: null,
  approvedBy: userId,
  current: false,
  confirmedAt: null,
  createdAt: payment.issuedAt,
};
let rows: ReturnType<typeof CommercialPaymentListSchema.parse>;
const base = `/federation/commercial-agreements/${revisionId}`;
function first() {
  const row = rows.data[0];
  if (!row) throw new Error("Missing fixture");
  return row;
}
function mount(props: Partial<Parameters<typeof CommercialPaymentPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (extra: Partial<Parameters<typeof CommercialPaymentPanel>[0]> = {}) => (
    <QueryClientProvider client={client}>
      <CommercialPaymentPanel
        approval={approval}
        scope={scope}
        writable
        busy={false}
        {...props}
        {...extra}
      />
    </QueryClientProvider>
  );
  return { view, client, ...render(view()) };
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  rows = CommercialPaymentListSchema.parse({
    data: [{ payment: structuredClone(saved), ledger: null }],
    hasMore: false,
  });
  vi.mocked(api.get).mockImplementation(async () => ({ data: rows }));
  vi.mocked(api.post).mockResolvedValue({ data: saved });
});
async function openPayment() {
  fireEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`${saved.payload.amount} ${saved.payload.unit}`),
    }),
  );
}
async function importPayment(value: unknown = payment) {
  fireEvent.click(await screen.findByRole("button", { name: "Record payment" }));
  fireEvent.change(screen.getByLabelText("Payment receipt JSON"), {
    target: { value: JSON.stringify(value) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read and review" }));
}
function confirm() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
}
function confirmed() {
  first().payment.counterpartyJws = "peer.signature";
  first().payment.confirmedAt = payment.issuedAt;
  first().payment.current = true;
}

test.each([
  "pending",
  "committed",
  "needs_review",
] as const)("confirmed amount remains independent of %s evidence", async (state) => {
  confirmed();
  first().ledger = { id: receiptId, state, lastError: null };
  mount();
  await openPayment();
  expect(screen.getByText("9007199254740993 credit.micro")).toBeTruthy();
  expect(screen.getByText("Current confirmed amount", { exact: true })).toBeTruthy();
  expect(
    screen.getByText(
      {
        pending: "Evidence pending",
        committed: "Evidence committed",
        needs_review: "Evidence needs review",
      }[state],
    ),
  ).toBeTruthy();
});
test.each([
  "bilateral_attested",
  "ledger_coordinated",
] as const)("source %s does not imply ledger confirmation", async (mode) => {
  confirmed();
  first().payment.localSiteId = source;
  const contract = structuredClone(approval);
  contract.localSiteId = source;
  contract.terms.agreement.mode = mode;
  mount({ approval: contract });
  await openPayment();
  expect(screen.getByText("Provider submits evidence; status not synchronized")).toBeTruthy();
  expect(screen.getByText("Current confirmed amount", { exact: true })).toBeTruthy();
});
test("history keeps superseded amount distinct and retains bill filter", async () => {
  confirmed();
  first().payment.current = false;
  mount({ billId });
  await openPayment();
  expect(screen.getByText("Superseded receipt", { exact: true })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Correct payment" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "View correction history" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith(
      `${base}/payments?limit=20&offset=0&billId=${billId}&paymentId=${paymentId}`,
      scope,
    ),
  );
});
test("only paid agreements can display or create payment receipts", async () => {
  const contract = structuredClone(approval);
  contract.terms.consideration = "charity";
  mount({ approval: contract });
  expect(screen.getByText("Payment receipts require a paid agreement.")).toBeTruthy();
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Record payment" })).toBeNull();
});
test("import refuses wrong contract and scoped bill without writes", async () => {
  mount({ billId });
  await importPayment({ ...payment, billId: userId });
  expect(screen.getByText("Receipt format, bill, or agreement does not match.")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Payment receipt JSON"), {
    target: { value: JSON.stringify({ ...payment, agreementDigest: `sha256:${"b".repeat(64)}` }) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read and review" }));
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("explicit confirmation writes exact payload and selects the saved receipt", async () => {
  mount();
  await importPayment();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  expect(screen.getByText(/Acknowledges an external payment only/)).toBeTruthy();
  confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${base}/payments/approve`, payment, scope),
  );
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith(
      `${base}/payments?limit=20&offset=0&recordId=${receiptId}`,
      scope,
    ),
  );
  expect(await screen.findByText("Awaiting both parties", { exact: true })).toBeTruthy();
});
test("unknown write cannot be resubmitted until original exact receipt is found", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { ...saved, localOrgId: userId } });
  mount();
  await importPayment();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  confirm();
  await screen.findByText(/Write outcome unconfirmed/);
  expect(screen.getByRole("button", { name: "Review and approve" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.post).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Check original receipt" }));
  await waitFor(() => expect(screen.queryByText(/Write outcome unconfirmed/)).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(await screen.findByText("Awaiting both parties", { exact: true })).toBeTruthy();
});
test("failed original lookup keeps write blocked", async () => {
  vi.mocked(api.post).mockRejectedValue(new Error("timeout"));
  mount();
  await importPayment();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  confirm();
  await screen.findByText(/Write outcome unconfirmed/);
  vi.mocked(api.get).mockResolvedValue({ data: { data: [], hasMore: false } });
  fireEvent.click(screen.getByRole("button", { name: "Check original receipt" }));
  await screen.findByText("The original receipt is still unconfirmed. Check again later.");
  expect(screen.getByRole("button", { name: "Review and approve" })).toHaveProperty(
    "disabled",
    true,
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});
test("counterparty response must preserve exact signature and body", async () => {
  mount();
  await openPayment();
  fireEvent.change(screen.getByLabelText("Counterparty signature"), {
    target: { value: "peer.signature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify counterparty signature" }));
  confirm();
  await screen.findByText(/Write outcome unconfirmed/);
  expect(api.post).toHaveBeenCalledWith(
    `${base}/payments/${receiptId}/counterparty`,
    { approvalJws: "peer.signature" },
    scope,
  );
});
test("correction drafts full zero amount under the same identity and predecessor", async () => {
  confirmed();
  const nextId = "55555555-5555-4555-8555-555555555555";
  vi.spyOn(crypto, "randomUUID").mockReturnValue(nextId);
  vi.mocked(api.post).mockImplementation(async (_, input) => ({
    data: { ...payment, ...(input as object), previous: { receiptId, digest } },
  }));
  mount();
  await openPayment();
  fireEvent.click(screen.getByRole("button", { name: "Correct payment" }));
  expect(screen.getByLabelText("Bill ID")).toHaveProperty("disabled", true);
  fireEvent.change(screen.getByLabelText("Payment amount (credit.micro)"), {
    target: { value: "0" },
  });
  fireEvent.change(screen.getByLabelText("Payment time (local time)"), {
    target: { value: "2026-01-01T00:00" },
  });
  fireEvent.change(screen.getByLabelText("Payment evidence SHA-256"), {
    target: { value: digest },
  });
  fireEvent.change(screen.getByLabelText("Reason"), {
    target: { value: "Voided external receipt" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Calculate draft" }));
  await screen.findByText("0 credit.micro");
  expect(api.post).toHaveBeenCalledWith(
    `${base}/payments/draft`,
    expect.objectContaining({ receiptId: nextId, paymentId, billId, amount: "0" }),
    scope,
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});
test("permission revocation clears sensitive editor", async () => {
  const { rerender, view } = mount();
  await importPayment();
  rerender(view({ writable: false }));
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  rerender(view({ writable: true }));
  fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
  expect(screen.getByLabelText("Payment receipt JSON")).toHaveProperty("value", "");
  expect(screen.getByLabelText("Reason")).toHaveProperty("value", "");
});
test("auth or organization change remounts editor", async () => {
  const { rerender, view } = mount();
  await importPayment();
  rerender(view({ scope: { ...scope, authRevision: "login-2" } }));
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("focus refresh does not discard editor", async () => {
  const { client } = mount();
  await importPayment();
  const count = vi.mocked(api.get).mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
  });
  expect(screen.getByRole("button", { name: "Review and approve" })).toBeTruthy();
  expect(api.get).toHaveBeenCalledTimes(count);
  const query = client
    .getQueryCache()
    .findAll()
    .find((entry) => entry.queryKey.includes("payments"));
  expect(query).toBeTruthy();
});
test("list refuses mismatched organization and filter", async () => {
  first().payment.billId = userId;
  first().payment.payload.billId = userId;
  mount({ billId });
  await screen.findByRole("alert");
  expect(screen.queryByText("9007199254740993 credit.micro")).toBeNull();
});

test("late draft cannot repopulate editor after permission revoke and restore", async () => {
  const { rerender, view } = mount();
  let resolve: (value: unknown) => void = () => {
    throw new Error("Missing draft request");
  };
  vi.mocked(api.post).mockImplementation(
    (_, input) =>
      new Promise((done) => {
        resolve = () => done({ data: { ...payment, ...(input as object) } });
      }),
  );
  fireEvent.click(await screen.findByRole("button", { name: "Record payment" }));
  fireEvent.change(screen.getByLabelText("Bill ID"), { target: { value: billId } });
  fireEvent.change(screen.getByLabelText("Payment amount (credit.micro)"), {
    target: { value: "40" },
  });
  fireEvent.change(screen.getByLabelText("Payment time (local time)"), {
    target: { value: "2026-01-01T00:00" },
  });
  fireEvent.change(screen.getByLabelText("Payment evidence SHA-256"), {
    target: { value: digest },
  });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Private payment" } });
  fireEvent.click(screen.getByRole("button", { name: "Calculate draft" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  rerender(view({ writable: false }));
  rerender(view({ writable: true }));
  await act(async () => {
    resolve(undefined);
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Record payment" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  expect(screen.getByLabelText("Reason")).toHaveProperty("value", "");
});

test("creating a different payment from history clears old payment filter", async () => {
  confirmed();
  mount();
  await openPayment();
  fireEvent.click(screen.getByRole("button", { name: "View correction history" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith(
      `${base}/payments?limit=20&offset=0&paymentId=${paymentId}`,
      scope,
    ),
  );
  const next = { ...payment, receiptId: userId, paymentId: "55555555-5555-4555-8555-555555555555" };
  const nextSaved = {
    ...saved,
    receiptId: next.receiptId,
    paymentId: next.paymentId,
    payload: next,
  };
  vi.mocked(api.post).mockImplementation(async () => {
    rows = { data: [{ payment: nextSaved, ledger: null }], hasMore: false };
    return { data: nextSaved };
  });
  await importPayment(next);
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  confirm();
  await waitFor(() =>
    expect(api.get).toHaveBeenLastCalledWith(
      `${base}/payments?limit=20&offset=0&recordId=${next.receiptId}`,
      scope,
    ),
  );
  expect(await screen.findByText("Awaiting both parties", { exact: true })).toBeTruthy();
  expect(screen.getByText(next.paymentId, { exact: true })).toBeTruthy();
});

test.each([400, 403, 409])("explicit API rejection %i remains editable", async (status) => {
  vi.mocked(api.post).mockRejectedValue(new ApiError(status, "POLICY_DENIED", "Rejected"));
  mount();
  await importPayment();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  confirm();
  await screen.findByText(/Approval rejected/);
  expect(screen.queryByRole("button", { name: "Check original receipt" })).toBeNull();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to payments" }));
  fireEvent.click(screen.getByRole("button", { name: "Record payment" }));
  expect(screen.getByLabelText("Reason")).toHaveProperty("disabled", false);
  expect(api.post).toHaveBeenCalledTimes(1);
});
test.each([408, 500])("HTTP %i does not assert a safe rejection", async (status) => {
  vi.mocked(api.post).mockRejectedValue(new ApiError(status, "HTTP_ERROR", "Unknown"));
  mount();
  await importPayment();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  confirm();
  await screen.findByText(/Write outcome unconfirmed/);
  expect(screen.getByRole("button", { name: "Review and approve" })).toHaveProperty(
    "disabled",
    true,
  );
});

test("opens a dispute for the exact selected payment without granting financial approval", async () => {
  const onOpenDispute = vi.fn();
  mount({ writable: false, onOpenDispute });
  await openPayment();
  fireEvent.click(screen.getByRole("button", { name: "Open dispute" }));
  expect(onOpenDispute).toHaveBeenCalledWith({
    recordType: "payment",
    recordId: first().payment.receiptId,
    recordDigest: first().payment.digest,
  });
  expect(api.post).not.toHaveBeenCalled();
});
