import {
  CommercialAdjustmentListSchema,
  CommercialAdjustmentSchema,
  CommercialAgreementApprovalSchema,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialAdjustmentPanel } from "./CommercialAdjustmentPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const settlementId = "44444444-4444-4444-8444-444444444444";
const billId = "11111111-1111-4111-8111-111111111111",
  adjustmentId = "22222222-2222-4222-8222-222222222222";
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
const adjustment = CommercialAdjustmentSchema.parse({
  protocolVersion: 1,
  kind: "commercial-adjustment",
  adjustmentId,
  billId,
  domainId: userId,
  agreementRevisionId: revisionId,
  billDigest: digest,
  sourceSiteId: source,
  targetSiteId: target,
  settlementId,
  settlementDigest: digest,
  previous: null,
  reason: "Agreed correction",
  supportingEvidenceDigest: null,
  unit: "credit.micro",
  previousChargedAmount: "9007199254740999",
  chargedAmount: "9007199254740993",

  issuedAt: "2026-01-02T01:00:00Z",
  salt: "c".repeat(64),
});
const saved = {
  localSiteId: target,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  settlementId,
  adjustmentId,
  number: 1,
  heldAmount: "0",
  payload: adjustment,
  digest,
  approvalJws: "adjustment.local.signature",
  counterpartyJws: null,
  approvedBy: userId,
  appliedAt: null,
  createdAt: adjustment.issuedAt,
};
let rows: ReturnType<typeof CommercialAdjustmentListSchema.parse>;
function first() {
  const row = rows.data[0];
  if (!row) throw new Error("Missing adjustment fixture");
  return row;
}
const base = `/federation/commercial-agreements/${revisionId}`;
function mount(props: Partial<Parameters<typeof CommercialAdjustmentPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  const view = (overrides: Partial<Parameters<typeof CommercialAdjustmentPanel>[0]> = {}) => (
    <QueryClientProvider client={client}>
      <CommercialAdjustmentPanel
        approval={approval}
        scope={scope}
        writable
        busy={false}
        onOpenSettlement={vi.fn()}
        {...props}
        {...overrides}
      />
    </QueryClientProvider>
  );
  return { client, view, ...render(view()) };
}
beforeEach(async () => {
  vi.resetAllMocks();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(adjustmentId);
  await i18n.changeLanguage("en");
  rows = CommercialAdjustmentListSchema.parse({
    data: [{ adjustment: structuredClone(saved), ledger: null }],
    hasMore: false,
  });
  vi.mocked(api.get).mockResolvedValue({ data: rows });
  vi.mocked(api.post).mockResolvedValue({ data: saved });
});
async function openAdjustment() {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(adjustmentId) }));
}
async function importAdjustment(value: unknown = adjustment) {
  fireEvent.click(await screen.findByRole("button", { name: "Create adjustment" }));
  fireEvent.change(screen.getByLabelText("Adjustment JSON"), {
    target: { value: JSON.stringify(value) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Read and review" }));
}
function confirm() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
}
test("keeps exact amounts and distinguishes signatures, evidence and accounting", async () => {
  mount();
  await openAdjustment();
  expect(screen.getByText("New net charge").nextElementSibling?.textContent).toBe(
    "9007199254740993 credit.micro",
  );
  expect(screen.getByText("Previous net charge").nextElementSibling?.textContent).toBe(
    "9007199254740999 credit.micro",
  );
  expect(screen.getByText("Not applied")).toBeTruthy();
  expect(screen.getByText("Awaiting both signatures")).toBeTruthy();
  expect(screen.queryByText("Applied")).toBeNull();
});
test.each([
  "pending",
  "committed",
  "needs_review",
] as const)("attested local accounting is independent of %s evidence", async (state) => {
  first().adjustment.counterpartyJws = "peer.signature";
  first().adjustment.appliedAt = adjustment.issuedAt;
  first().ledger = { id: adjustmentId, state, lastError: null };
  mount();
  await openAdjustment();
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
test("direct adjustment has no chain wait", async () => {
  const direct = structuredClone(approval);
  direct.terms.agreement.mode = "bilateral_direct";
  mount({ approval: direct });
  await openAdjustment();
  expect(screen.getByText("Evidence not required")).toBeTruthy();
});
test("source attestation state remains unknown independently of local accounting", async () => {
  first().adjustment.localSiteId = source;
  mount({ approval: { ...approval, localSiteId: source } });
  await openAdjustment();
  expect(screen.getByText("Provider submits evidence; status not synchronized")).toBeTruthy();
});
test("coordinated source waits for its own VALID and never describes evidence as remote", async () => {
  const coordinated = structuredClone(approval);
  coordinated.localSiteId = source;
  coordinated.terms.agreement.mode = "ledger_coordinated";
  first().adjustment.localSiteId = source;
  first().adjustment.counterpartyJws = "peer.signature";

  first().ledger = { id: adjustmentId, state: "pending", lastError: null };
  mount({ approval: coordinated });
  await openAdjustment();
  expect(screen.getByText("Not applied")).toBeTruthy();
  expect(screen.getByText("Evidence pending")).toBeTruthy();
  expect(screen.queryByText("Provider submits evidence; status not synchronized")).toBeNull();
});
test("draft binds the original bill and explicit confirmation sends the exact adjustment", async () => {
  vi.mocked(api.post)
    .mockResolvedValueOnce({ data: adjustment })
    .mockResolvedValue({ data: saved });
  mount();
  await draftInputs();
  fireEvent.click(await screen.findByRole("button", { name: "Calculate draft" }));
  fireEvent.click(await screen.findByRole("button", { name: "Review and approve" }));
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(api.post).toHaveBeenLastCalledWith(
    `${base}/adjustments/draft`,
    {
      settlementId,
      adjustmentId,
      chargedAmount: adjustment.chargedAmount,
      reason: adjustment.reason,
      supportingEvidenceDigest: null,
    },
    scope,
  );
  confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenLastCalledWith(`${base}/adjustments/approve`, adjustment, scope),
  );
});
test("a lost approval response retries the same original body", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("lost")).mockResolvedValue({ data: saved });
  mount();
  await importAdjustment();
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
  "targetSiteId",
])("rejects imported mismatched %s", async (field) => {
  mount();
  await importAdjustment({
    ...adjustment,
    [field]: field === "unit" ? "other" : orgId,
  });
  expect(screen.getByText(/Invalid adjustment or contract mismatch/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
test.each([
  "localOrgId",
  "localSiteId",
  "settlementId",
] as const)("rejects mismatched response %s", async (field) => {
  first().adjustment[field] = revisionId;
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByText(adjustmentId)).toBeNull();
});
test("read-only users inspect amounts without approval, signature import or retry", async () => {
  first().ledger = { id: adjustmentId, state: "needs_review", lastError: null };
  mount({ writable: false });
  await openAdjustment();
  expect(screen.getByText("New net charge")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Create adjustment" })).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry ledger submission" })).toBeNull();
});
test("revoking adjustment permission clears a pending approval", async () => {
  const page = mount();
  await importAdjustment();
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
  await importAdjustment();
  page.rerender(
    page.view({ scope: { ...scope, [field]: field === "organizationId" ? userId : "login-2" } }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull(),
  );
  expect(api.post).not.toHaveBeenCalled();
});
test("manual attachment requires confirmation and preserves institution scope", async () => {
  vi.mocked(api.post).mockResolvedValue({
    data: { ...saved, counterpartyJws: "peer.original.signature" },
  });
  mount();
  await openAdjustment();
  fireEvent.click(screen.getByText("Signatures and manual import"));
  fireEvent.change(screen.getByLabelText("Counterparty signature"), {
    target: { value: "peer.original.signature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify counterparty signature" }));
  expect(api.post).not.toHaveBeenCalled();
  confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `${base}/adjustments/${adjustmentId}/counterparty`,
      { approvalJws: "peer.original.signature" },
      scope,
    ),
  );
});
test("retry uses the adjustment submission without new approval", async () => {
  first().ledger = {
    id: reportSubmissionId,
    state: "needs_review",
    lastError: "UNTRUSTED_IDENTITY",
  };
  mount();
  await openAdjustment();
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
    expect(api.get).toHaveBeenCalledWith(`${base}/adjustments?limit=20&offset=20`, scope),
  );
});
test("draft rejects a response for a different original", async () => {
  vi.mocked(api.post).mockResolvedValue({ data: { ...adjustment, settlementId: userId } });
  mount();
  await draftInputs();
  fireEvent.click(await screen.findByRole("button", { name: "Calculate draft" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
});

test("closing navigation loads the exact adjustment and back clears its query filter", async () => {
  mount({ recordId: adjustmentId });
  await screen.findByText("Local accounting");
  expect(api.get).toHaveBeenCalledWith(
    `${base}/adjustments?limit=20&offset=0&recordId=${adjustmentId}`,
    scope,
  );
  fireEvent.click(screen.getByRole("button", { name: "Back to adjustments" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${base}/adjustments?limit=20&offset=0`, scope),
  );
});

async function draftInputs() {
  fireEvent.click(await screen.findByRole("button", { name: "Create adjustment" }));
  fireEvent.change(screen.getByLabelText("Settlement ID"), { target: { value: settlementId } });
  fireEvent.change(screen.getByLabelText("New net charge (credit.micro)"), {
    target: { value: adjustment.chargedAmount },
  });
  fireEvent.change(screen.getByLabelText("Reason"), { target: { value: adjustment.reason } });
}

test("settlement history preserves its filter and displays current charge separately from an older record", async () => {
  rows.summary = {
    settlementId,
    originalChargedAmount: "9007199254740999",
    currentChargedAmount: "9007199254740990",
    pendingAdjustmentId: null,
  };
  rows.hasMore = true;
  const open = vi.fn();
  mount({ settlementId, onOpenSettlement: open });
  expect(
    (await screen.findByText("Current local net charge")).nextElementSibling?.textContent,
  ).toBe("9007199254740990 credit.micro");
  expect(api.get).toHaveBeenCalledWith(
    `${base}/adjustments?limit=20&offset=0&settlementId=${settlementId}`,
    scope,
  );
  fireEvent.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      `${base}/adjustments?limit=20&offset=20&settlementId=${settlementId}`,
      scope,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "View original settlement" }));
  expect(open).toHaveBeenCalledWith(settlementId);
});

test.each([
  "chargedAmount",
  "reason",
  "supportingEvidenceDigest",
])("draft rejects changed %s without approval", async (field) => {
  vi.mocked(api.post).mockResolvedValue({
    data: {
      ...adjustment,
      [field]: field === "chargedAmount" ? "1" : field === "reason" ? "Changed" : digest,
    },
  });
  mount();
  await draftInputs();
  fireEvent.click(screen.getByRole("button", { name: "Calculate draft" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
});

test("late draft response after permission revocation cannot restore private review", async () => {
  let resolve: (value: unknown) => void = () => {};
  vi.mocked(api.post).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const page = mount();
  await draftInputs();
  fireEvent.click(screen.getByRole("button", { name: "Calculate draft" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  page.rerender(page.view({ writable: false }));
  resolve({ data: adjustment });
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Create adjustment" })).toBeNull(),
  );
  page.rerender(page.view({ writable: true }));
  fireEvent.click(await screen.findByRole("button", { name: "Create adjustment" }));
  expect(screen.queryByRole("button", { name: "Review and approve" })).toBeNull();
  expect((screen.getByLabelText("Reason") as HTMLTextAreaElement).value).toBe("");
});

test("filtered history rejects importing an adjustment from another settlement", async () => {
  rows.summary = {
    settlementId,
    originalChargedAmount: "9007199254740999",
    currentChargedAmount: "9007199254740993",
    pendingAdjustmentId: null,
  };
  mount({ settlementId });
  await importAdjustment({ ...adjustment, settlementId: userId });
  expect(screen.getByText(/Invalid adjustment or contract mismatch/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

test.each([false, true])("closing confirmation restores focus when applied=%s", async (applied) => {
  mount();
  await importAdjustment();
  const opener = screen.getByRole("button", { name: "Review and approve" });
  opener.focus();
  fireEvent.click(opener);
  if (applied) confirm();
  else fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() =>
    expect(document.activeElement).toBe(
      applied ? screen.getByRole("region", { name: "Adjustments" }) : opener,
    ),
  );
});
