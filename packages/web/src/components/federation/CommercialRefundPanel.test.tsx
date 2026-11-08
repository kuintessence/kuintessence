import {
  CommercialAgreementApprovalSchema,
  CommercialRefundListSchema,
  CommercialRefundSchema,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialRefundPanel } from "./CommercialRefundPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const refundId = "22222222-2222-4222-8222-222222222222";
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

const refund = CommercialRefundSchema.parse({
  protocolVersion: 1,
  kind: "commercial-refund",
  refundId,
  domainId: userId,
  agreementDigest: digest,
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
  requestDigest: digest,
  cancellationReceiptJws: "signed.cancellation.receipt",
  releasedAmount: "9007199254740993",
  issuedAt: "2026-01-02T01:00:00Z",
  salt: "c".repeat(64),
  reason: "Cancelled before execution",
});
const saved = {
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  operationId: userId,
  refundId,
  payload: refund,
  digest,
  approvalJws: "refund.local.signature",
  counterpartyJws: null,
  approvedBy: userId,
  appliedAt: null,
  createdAt: refund.issuedAt,
};
let rows: ReturnType<typeof CommercialRefundListSchema.parse>;
const base = `/federation/commercial-agreements/${revisionId}`;
function first() {
  const row = rows.data[0];
  if (!row) throw new Error("Missing fixture");
  return row;
}
function mount(props: Partial<Parameters<typeof CommercialRefundPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (extra: Partial<Parameters<typeof CommercialRefundPanel>[0]> = {}) => (
    <QueryClientProvider client={client}>
      <CommercialRefundPanel
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
  vi.spyOn(crypto, "randomUUID").mockReturnValue(refundId);
  await i18n.changeLanguage("en");
  rows = CommercialRefundListSchema.parse({
    data: [{ ...structuredClone(saved), ledger: null }],
    hasMore: false,
  });
  vi.mocked(api.get).mockImplementation(async () => ({ data: rows }));
  vi.mocked(api.post).mockResolvedValue({ data: saved });
});
async function openRefund() {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(refundId) }));
}
async function importRefund(value: unknown = refund) {
  fireEvent.click(await screen.findByRole("button", { name: "Create refund" }));
  fireEvent.change(screen.getByLabelText("Refund JSON"), {
    target: { value: JSON.stringify(value) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read and review" }));
}
function confirm() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
}
test.each([
  "pending",
  "committed",
  "needs_review",
] as const)("exact local refund is independent of %s evidence", async (state) => {
  first().counterpartyJws = "peer.signature";
  first().appliedAt = refund.issuedAt;
  first().ledger = { id: refundId, state, lastError: null };
  mount();
  await openRefund();
  expect(screen.getByText("9007199254740993 credit.micro")).toBeTruthy();
  expect(screen.getByText("Returned", { exact: true })).toBeTruthy();
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
test("source evidence remains unsynchronized", async () => {
  first().localSiteId = source;
  mount({ approval: { ...approval, localSiteId: source } });
  await openRefund();
  expect(screen.getByText("Provider submits evidence; status not synchronized")).toBeTruthy();
});
test("direct cooperation has no ledger wait", async () => {
  const direct = structuredClone(approval);
  direct.terms.agreement.mode = "bilateral_direct";
  first().payload.request.mode = "bilateral_direct";
  mount({ approval: direct });
  await openRefund();
  expect(screen.getByText("Evidence not required")).toBeTruthy();
});
test("source generates a draft without approving and selects the original after confirmation", async () => {
  first().localSiteId = source;
  vi.mocked(api.post).mockImplementation(async (path) => ({
    data: path.endsWith("/draft") ? refund : { ...saved, localSiteId: source },
  }));
  mount({ approval: { ...approval, localSiteId: source } });
  fireEvent.click(await screen.findByRole("button", { name: "Create refund" }));
  fireEvent.change(screen.getByLabelText("Original delegation ID"), { target: { value: userId } });
  fireEvent.change(screen.getByLabelText("Refund reason"), { target: { value: refund.reason } });
  fireEvent.click(screen.getByRole("button", { name: "Calculate draft" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review and approve" }));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith(
    `${base}/refunds/draft`,
    { operationId: userId, refundId, reason: refund.reason },
    scope,
  );
  confirm();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenLastCalledWith(`${base}/refunds/approve`, refund, scope);
  expect(api.get).toHaveBeenLastCalledWith(
    `${base}/refunds?limit=20&offset=0&recordId=${refundId}`,
    scope,
  );
});
test("provider imports the original without source-only drafting", async () => {
  mount();
  await importRefund();
  expect(screen.queryByRole("button", { name: "Calculate draft" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  expect(api.post).not.toHaveBeenCalled();
  confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${base}/refunds/approve`, refund, scope),
  );
});
test.each([
  "domain",
  "digest",
  "mode",
  "party",
  "amount",
])("rejects changed %s before approval", async (field) => {
  const value = structuredClone(refund);
  if (field === "domain") value.domainId = source;
  if (field === "digest") value.agreementDigest = `sha256:${"f".repeat(64)}`;
  if (field === "mode") value.request.mode = "bilateral_direct";
  if (field === "party") value.request.senderSiteId = orgId;
  if (field === "amount") value.releasedAmount = "1";
  mount();
  await importRefund(value);
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  expect(screen.getByText(/Invalid refund or contract mismatch/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
test("changed approval response preserves the unconfirmed intent", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { ...saved, operationId: source } });
  mount();
  await importRefund();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  confirm();
  expect((await screen.findByRole("alert")).textContent).toContain("Action not confirmed");
  expect(screen.getByRole("dialog")).toBeTruthy();
});
test("manual countersignature needs confirmation and response binding", async () => {
  mount();
  await openRefund();
  fireEvent.click(screen.getByText("Signatures and manual import"));
  fireEvent.change(screen.getByLabelText("Counterparty signature"), {
    target: { value: "peer.original.signature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify counterparty signature" }));
  expect(api.post).not.toHaveBeenCalled();
  confirm();
  expect((await screen.findByRole("alert")).textContent).toContain("Action not confirmed");
});
test("permission revocation discards signing intent", async () => {
  const m = mount();
  await importRefund();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  m.rerender(m.view({ writable: false }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Create refund" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("organization and login changes discard old originals", async () => {
  const m = mount();
  await importRefund();
  m.rerender(m.view({ scope: { ...scope, authRevision: "login-2" } }));
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  m.rerender(m.view({ scope: { ...scope, organizationId: source } }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText(refund.reason)).toBeNull();
});
test("coordinated mode offers no separate refund mutation or query", () => {
  const coordinated = structuredClone(approval);
  coordinated.terms.agreement.mode = "ledger_coordinated";
  mount({ approval: coordinated });
  expect(api.get).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Create refund" })).toBeNull();
});

test("revoking permission during drafting cannot restore a stale approval form", async () => {
  first().localSiteId = source;
  const pending = Promise.withResolvers<{ data: typeof refund }>();
  vi.mocked(api.post).mockReturnValue(pending.promise);
  const m = mount({ approval: { ...approval, localSiteId: source } });
  fireEvent.click(await screen.findByRole("button", { name: "Create refund" }));
  fireEvent.change(screen.getByLabelText("Original delegation ID"), { target: { value: userId } });
  fireEvent.change(screen.getByLabelText("Refund reason"), { target: { value: refund.reason } });
  fireEvent.click(screen.getByRole("button", { name: "Calculate draft" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  m.rerender(m.view({ approval: { ...approval, localSiteId: source }, writable: false }));
  await act(async () => {
    pending.resolve({ data: refund });
    await pending.promise;
  });
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("retrying evidence only targets the original submission and does not approve again", async () => {
  first().counterpartyJws = "peer.signature";
  first().appliedAt = refund.issuedAt;
  first().ledger = { id: refundId, state: "needs_review", lastError: "LEDGER_UNAVAILABLE" };
  vi.mocked(api.post).mockResolvedValue({ success: true });
  mount();
  await openRefund();
  fireEvent.click(screen.getByRole("button", { name: "Retry ledger submission" }));
  expect(
    screen.getByText("Retry only the original refund evidence. No additional funds are returned."),
  ).toBeTruthy();
  confirm();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenCalledWith(`${base}/submissions/${refundId}/retry`, {}, scope);
});
