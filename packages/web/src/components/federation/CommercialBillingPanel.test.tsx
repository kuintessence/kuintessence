import {
  CommercialAgreementApprovalSchema,
  CommercialBillListSchema,
  CommercialBillSchema,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialBillingPanel } from "./CommercialBillingPanel";

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
  reportId = "22222222-2222-4222-8222-222222222222";
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
const bill = CommercialBillSchema.parse({
  protocolVersion: 1,
  kind: "commercial-bill",
  billId,
  domainId: userId,
  agreementDigest: digest,
  priceVersionId: userId,
  reportId,
  reportDigest: digest,
  reservationId: null,
  discount: null,
  salt: "c".repeat(64),
  issuedAt: "2026-01-02T01:00:00Z",
  request: {
    protocolVersion: 1,
    kind: "delegation",
    operationId: userId,
    senderSiteId: source,
    recipientSiteId: target,
    agreementRevisionId: revisionId,
    mode: "bilateral_attested",
    budgetDomainId: orgId,
    epoch: userId,
    taskId: userId,
    attempt: 1,
    issuedAt: "2026-01-02T00:00:00Z",
    expiresAt: "2026-01-02T00:30:00Z",
    template: approval.terms.agreement.templates[0],
    inputManifestDigest: digest,
    environmentLockDigest: digest,
    resources: approval.terms.agreement.resourceLimit,
    maxAmount: "9007199254740993",
    unit: "credit.micro",
  },
  calculation: {
    rounding: "ceil-per-line",
    lines: [
      {
        metric: "job.elapsed",
        quantityUnit: "job-millisecond",
        quantity: "1000",
        perQuantity: "1000",
        rateAmount: "9007199254740993",
        amount: "9007199254740993",
      },
    ],
    grossAmount: "9007199254740993",
    capReduction: "0",
    discountAmount: "0",
    dueAmount: "9007199254740993",
  },
});
const saved = {
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  billId,
  payload: bill,
  digest,
  approvalJws: "bill.local.signature",
  counterpartyJws: null,
  approvedBy: userId,
  createdAt: bill.issuedAt,
};
let rows: ReturnType<typeof CommercialBillListSchema.parse>;
function first() {
  const value = rows.data[0];
  if (!value) throw new Error("Missing bill fixture");
  return value;
}
const base = `/federation/commercial-agreements/${revisionId}`;
function mount(props: Partial<Parameters<typeof CommercialBillingPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const view = (overrides: Partial<Parameters<typeof CommercialBillingPanel>[0]> = {}) => (
    <QueryClientProvider client={client}>
      <CommercialBillingPanel
        approval={approval}
        scope={scope}
        writable
        busy={false}
        {...props}
        {...overrides}
      />
    </QueryClientProvider>
  );
  return { client, view, ...render(view()) };
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(billId);
  await i18n.changeLanguage("en");
  rows = CommercialBillListSchema.parse({
    data: [{ bill: structuredClone(saved), ledger: null }],
    hasMore: false,
  });
  vi.mocked(api.get).mockResolvedValue({ data: rows });
  vi.mocked(api.post).mockResolvedValue({ data: saved });
});
async function openBill() {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(billId) }));
}
async function importBill(value: unknown = bill) {
  fireEvent.click(await screen.findByRole("button", { name: "Create bill" }));
  fireEvent.change(screen.getByLabelText("Bill JSON"), {
    target: { value: JSON.stringify(value) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read and review" }));
}

test("keeps exact amounts and distinguishes local signature from absent ledger evidence", async () => {
  mount();
  await openBill();
  expect(screen.getByText("Amount due").nextElementSibling?.textContent).toBe("9007199254740993");
  expect(screen.getByText("Awaiting both signatures")).toBeTruthy();
  expect(screen.queryByText("Evidence committed")).toBeNull();
  expect(api.get).toHaveBeenCalledWith(`${base}/bills?limit=20&offset=0`, scope);
});
test.each([
  "pending",
  "committed",
  "needs_review",
] as const)("shows %s as ledger status, independently of both approvals", async (state) => {
  first().bill.counterpartyJws = "peer.bill.signature";
  first().ledger = {
    id: billId,
    state,
    lastError: state === "needs_review" ? "UNTRUSTED_IDENTITY" : null,
  };
  mount();
  await openBill();
  expect(screen.getByText("Confirmed by both institutions")).toBeTruthy();
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
test("direct bills never describe ledger absence as pending", async () => {
  const direct = structuredClone(approval);
  direct.terms.agreement.mode = "bilateral_direct";
  first().bill.payload.request.mode = "bilateral_direct";
  mount({ approval: direct });
  await openBill();
  expect(screen.getByText("Evidence not required")).toBeTruthy();
});
test("source shows unsynchronized provider evidence, never a false commitment", async () => {
  const local = { ...approval, localSiteId: source };
  first().bill.localSiteId = source;
  first().bill.counterpartyJws = "peer.bill.signature";
  mount({ approval: local });
  await openBill();
  expect(screen.getByText("Provider submits evidence; status not synchronized")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Import bill" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create bill" })).toBeNull();
});
test("draft reads a real report without approving; explicit confirmation sends the exact body", async () => {
  vi.mocked(api.post).mockResolvedValueOnce({ data: bill }).mockResolvedValue({ data: saved });
  mount({ reportId });
  fireEvent.click(await screen.findByRole("button", { name: "Calculate draft" }));
  await screen.findByRole("button", { name: "Review and approve" });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenLastCalledWith(
    `${base}/bills/draft`,
    { reportId, billId: expect.any(String) },
    scope,
  );
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  expect(api.post).toHaveBeenCalledTimes(1);
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenLastCalledWith(`${base}/bills/approve`, bill, scope),
  );
});
test("unknown approval response preserves the exact original for retry", async () => {
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValue({ data: saved });
  mount();
  await importBill();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await screen.findByRole("alert");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
});
test.each([
  "domainId",
  "agreementDigest",
  "priceVersionId",
] as const)("rejects an imported bill with mismatched %s", async (field) => {
  mount();
  await importBill({
    ...bill,
    [field]: field === "agreementDigest" ? `sha256:${"f".repeat(64)}` : source,
  });
  expect(screen.getByText(/Invalid bill or contract mismatch/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
});
test("rejects bill data from another organization", async () => {
  first().bill.localOrgId = target;
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByText(billId)).toBeNull();
});
test("readonly cannot create, attach or retry, but can inspect original amounts", async () => {
  first().ledger = { id: billId, state: "needs_review", lastError: null };
  mount({ writable: false });
  await openBill();
  expect(screen.getByText("Amount due")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create bill" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("revocation closes the confirmation and discards the private draft", async () => {
  const page = mount();
  await importBill();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  page.rerender(page.view({ writable: false }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("organization or login changes clear imported private drafts", async () => {
  const page = mount();
  await importBill();
  page.rerender(page.view({ scope: { ...scope, authRevision: "login-2" } }));
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull(),
  );
  expect(api.post).not.toHaveBeenCalled();
});
test("manual signature attachment requires confirmation and keeps organization scope", async () => {
  mount();
  await openBill();
  fireEvent.click(screen.getByText("Signatures and manual import"));
  fireEvent.change(screen.getByLabelText("Counterparty signature"), {
    target: { value: "peer.original.signature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify counterparty signature" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `${base}/bills/${billId}/counterparty`,
      { approvalJws: "peer.original.signature" },
      scope,
    ),
  );
});
test("pagination retains scope and distinguishes an empty page", async () => {
  rows.hasMore = true;
  const page = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${base}/bills?limit=20&offset=20`, scope),
  );
  page.client.clear();
});
test("background refresh failure hides stale actions and original fields", async () => {
  const page = mount();
  await openBill();
  vi.mocked(api.get).mockRejectedValue(new Error("read failed"));
  await page.client.invalidateQueries();
  await screen.findByRole("alert");
  expect(screen.queryByText("Amount due")).toBeNull();
  expect(screen.queryByRole("button", { name: "Export bill" })).toBeNull();
});

test("draft response for another report is rejected before review", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { ...bill, reportId: userId } });
  mount({ reportId });
  fireEvent.click(await screen.findByRole("button", { name: "Calculate draft" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
});
test("ledger review retries the selected bill submission with billing approval", async () => {
  first().ledger = { id: userId, state: "needs_review", lastError: "UNTRUSTED_IDENTITY" };
  mount();
  await openBill();
  fireEvent.click(screen.getByRole("button", { name: "Retry ledger submission" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${base}/submissions/${userId}/retry`, {}, scope),
  );
});
test("changing organization clears pending confirmation rather than submitting it with new scope", async () => {
  const page = mount();
  await importBill();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  page.rerender(
    page.view({
      scope: { ...scope, organizationId: target },
      approval: { ...approval, localOrgId: target },
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).not.toHaveBeenCalled();
});

test("only a countersigned bill offers settlement and does not require billing approval", async () => {
  const create = vi.fn();
  const page = mount({ writable: false, onDraftSettlement: create });
  await openBill();
  expect(screen.queryByRole("button", { name: "Create settlement" })).toBeNull();
  first().bill.counterpartyJws = "peer.bill.signature";
  await page.client.invalidateQueries();
  fireEvent.click(await screen.findByRole("button", { name: "Create settlement" }));
  expect(create).toHaveBeenCalledWith(billId);
  expect(api.post).not.toHaveBeenCalled();
});

test("closing navigation loads the exact bill and back clears its query filter", async () => {
  mount({ recordId: billId });
  await screen.findByRole("button", { name: "Back to bills" });
  expect(api.get).toHaveBeenCalledWith(`${base}/bills?limit=20&offset=0&recordId=${billId}`, scope);
  fireEvent.click(screen.getByRole("button", { name: "Back to bills" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${base}/bills?limit=20&offset=0`, scope),
  );
});

test("opens a dispute for the exact selected bill without granting financial approval", async () => {
  const onOpenDispute = vi.fn();
  mount({ writable: false, onOpenDispute });
  await openBill();
  fireEvent.click(screen.getByRole("button", { name: "Open dispute" }));
  expect(onOpenDispute).toHaveBeenCalledWith({
    recordType: "bill",
    recordId: first().bill.billId,
    recordDigest: first().bill.digest,
  });
  expect(api.post).not.toHaveBeenCalled();
});
