import {
  CommercialAgreementApprovalSchema,
  CommercialSettlementListSchema,
  CommercialSettlementSchema,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialSettlementPanel } from "./CommercialSettlementPanel";

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
const settlement = CommercialSettlementSchema.parse({
  protocolVersion: 1,
  kind: "commercial-settlement",
  settlementId,
  billId,
  domainId: userId,
  agreementRevisionId: revisionId,
  billDigest: digest,
  sourceSiteId: source,
  targetSiteId: target,
  reservationId: null,
  terminal: null,
  unit: "credit.micro",
  reservedAmount: "9007199254740999",
  chargedAmount: "9007199254740993",
  releasedAmount: "6",
  issuedAt: "2026-01-02T01:00:00Z",
  salt: "c".repeat(64),
});
const saved = {
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  billId,
  settlementId,
  payload: settlement,
  digest,
  approvalJws: "settlement.local.signature",
  counterpartyJws: null,
  approvedBy: userId,
  appliedAt: null,
  createdAt: settlement.issuedAt,
};
let rows: ReturnType<typeof CommercialSettlementListSchema.parse>;
function first() {
  const row = rows.data[0];
  if (!row) throw new Error("Missing settlement fixture");
  return row;
}
const base = `/federation/commercial-agreements/${revisionId}`;
function mount(props: Partial<Parameters<typeof CommercialSettlementPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const view = (overrides: Partial<Parameters<typeof CommercialSettlementPanel>[0]> = {}) => (
    <QueryClientProvider client={client}>
      <CommercialSettlementPanel
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
  vi.spyOn(crypto, "randomUUID").mockReturnValue(settlementId);
  await i18n.changeLanguage("en");
  rows = CommercialSettlementListSchema.parse({
    data: [{ settlement: structuredClone(saved), ledger: null }],
    hasMore: false,
  });
  vi.mocked(api.get).mockResolvedValue({ data: rows });
  vi.mocked(api.post).mockResolvedValue({ data: saved });
});
async function openSettlement() {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(settlementId) }));
}
async function importSettlement(value: unknown = settlement) {
  fireEvent.click(await screen.findByRole("button", { name: "Create settlement" }));
  fireEvent.change(screen.getByLabelText("Settlement JSON"), {
    target: { value: JSON.stringify(value) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read and review" }));
}
function confirm() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
}
test("keeps exact amounts and distinguishes signatures, evidence and accounting", async () => {
  mount();
  await openSettlement();
  expect(screen.getByText("Consumed amount").nextElementSibling?.textContent).toBe(
    "9007199254740993",
  );
  expect(screen.getByText("Returned amount").nextElementSibling?.textContent).toBe("6");
  expect(screen.getByText("Not applied")).toBeTruthy();
  expect(screen.getByText("Awaiting both signatures")).toBeTruthy();
  expect(screen.queryByText("Applied")).toBeNull();
});
test.each([
  "pending",
  "committed",
  "needs_review",
] as const)("attested local accounting is independent of %s evidence", async (state) => {
  first().settlement.counterpartyJws = "peer.signature";
  first().settlement.appliedAt = settlement.issuedAt;
  first().ledger = { id: settlementId, state, lastError: null };
  mount();
  await openSettlement();
  expect(screen.getByText("Applied")).toBeTruthy();
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
test("direct settlement has no chain wait", async () => {
  const direct = structuredClone(approval);
  direct.terms.agreement.mode = "bilateral_direct";
  mount({ approval: direct });
  await openSettlement();
  expect(screen.getByText("Evidence not required")).toBeTruthy();
});
test("source attestation state remains unknown independently of local accounting", async () => {
  first().settlement.localSiteId = source;
  mount({ approval: { ...approval, localSiteId: source } });
  await openSettlement();
  expect(screen.getByText("Provider submits evidence; status not synchronized")).toBeTruthy();
});
test("coordinated source waits for its own VALID and never describes evidence as remote", async () => {
  const coordinated = structuredClone(approval);
  coordinated.localSiteId = source;
  coordinated.terms.agreement.mode = "ledger_coordinated";
  first().settlement.localSiteId = source;
  first().settlement.counterpartyJws = "peer.signature";
  first().settlement.payload.reservationId = userId;
  first().settlement.payload.terminal = { terminalId: userId, digest };
  first().ledger = { id: settlementId, state: "pending", lastError: null };
  mount({ approval: coordinated });
  await openSettlement();
  expect(screen.getByText("Not applied")).toBeTruthy();
  expect(screen.getByText("Evidence pending")).toBeTruthy();
  expect(screen.queryByText("Provider submits evidence; status not synchronized")).toBeNull();
});
test("draft binds the original bill and explicit confirmation sends the exact settlement", async () => {
  vi.mocked(api.post)
    .mockResolvedValueOnce({ data: settlement })
    .mockResolvedValue({ data: saved });
  mount({ billId });
  fireEvent.click(await screen.findByRole("button", { name: "Calculate draft" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review and approve" }));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenLastCalledWith(
    `${base}/settlements/draft`,
    { billId, settlementId },
    scope,
  );
  confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenLastCalledWith(`${base}/settlements/approve`, settlement, scope),
  );
});
test("a lost approval response retries the same original body", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("lost")).mockResolvedValue({ data: saved });
  mount();
  await importSettlement();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  confirm();
  await screen.findByRole("alert");
  confirm();
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
});
test.each([
  "domainId",
  "agreementRevisionId",
  "sourceSiteId",
  "unit",
  "chargedAmount",
])("rejects imported mismatched %s", async (field) => {
  mount();
  await importSettlement({
    ...settlement,
    [field]: field === "chargedAmount" ? "1" : field === "unit" ? "other" : orgId,
  });
  expect(screen.getByText(/Invalid settlement, amounts or contract mismatch/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
test.each([
  "localOrgId",
  "localSiteId",
  "billId",
] as const)("rejects mismatched response %s", async (field) => {
  first().settlement[field] = revisionId;
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByText(settlementId)).toBeNull();
});
test("read-only users inspect amounts without approval, signature import or retry", async () => {
  first().ledger = { id: settlementId, state: "needs_review", lastError: null };
  mount({ writable: false });
  await openSettlement();
  expect(screen.getByText("Consumed amount")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create settlement" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry ledger submission" })).toBeNull();
});
test("revoking settlement permission clears a pending approval", async () => {
  const page = mount();
  await importSettlement();
  fireEvent.click(screen.getByRole("button", { name: "Review and approve" }));
  page.rerender(page.view({ writable: false }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).not.toHaveBeenCalled();
});
test.each([
  "organizationId",
  "authRevision",
] as const)("switching %s clears private drafts", async (field) => {
  const page = mount();
  await importSettlement();
  page.rerender(
    page.view({ scope: { ...scope, [field]: field === "organizationId" ? userId : "login-2" } }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull(),
  );
  expect(api.post).not.toHaveBeenCalled();
});
test("manual attachment requires confirmation and preserves institution scope", async () => {
  mount();
  await openSettlement();
  fireEvent.click(screen.getByText("Signatures and manual import"));
  fireEvent.change(screen.getByLabelText("Counterparty signature"), {
    target: { value: "peer.original.signature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify counterparty signature" }));
  expect(api.post).not.toHaveBeenCalled();
  confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `${base}/settlements/${settlementId}/counterparty`,
      { approvalJws: "peer.original.signature" },
      scope,
    ),
  );
});
test("retry uses the settlement submission without new approval", async () => {
  first().ledger = {
    id: reportSubmissionId,
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
  };
  mount();
  await openSettlement();
  fireEvent.click(screen.getByRole("button", { name: "Retry ledger submission" }));
  confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `${base}/submissions/${reportSubmissionId}/retry`,
      {},
      scope,
    ),
  );
});
const reportSubmissionId = "33333333-3333-4333-8333-333333333333";
test("pagination retains contract and organization scope", async () => {
  rows.hasMore = true;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${base}/settlements?limit=20&offset=20`, scope),
  );
});
test("draft rejects a response for a different bill", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { ...settlement, billId: userId } });
  mount({ billId });
  fireEvent.click(await screen.findByRole("button", { name: "Calculate draft" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
});

test("closing navigation loads the exact settlement and back clears its query filter", async () => {
  mount({ recordId: settlementId });
  await screen.findByText("Local accounting");
  expect(api.get).toHaveBeenCalledWith(
    `${base}/settlements?limit=20&offset=0&recordId=${settlementId}`,
    scope,
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to settlements" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${base}/settlements?limit=20&offset=0`, scope),
  );
});
