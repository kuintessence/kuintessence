import type { FederationCapability } from "@kuintessence/shared/federation";
import { CommercialAgreementApprovalSchema } from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisputeResolutionSchema,
  type CommercialDisputeResolutionView,
} from "@kuintessence/shared/federation/dispute-resolution";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialDisputePanel } from "./CommercialDisputePanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = uuid(1),
  target = uuid(2),
  revisionId = uuid(3),
  orgId = uuid(4),
  userId = uuid(5),
  caseId = uuid(6),
  taskId = uuid(7);
const digest = `sha256:${"a".repeat(64)}`,
  date = "2026-01-01T00:00:00.000Z",
  scope = { organizationId: orgId, authRevision: "test-login" };
const approval = CommercialAgreementApprovalSchema.parse({
  localSiteId: source,
  localOrgId: orgId,
  revisionId,
  digest,
  approvalJws: "local.fixture",
  counterpartyJws: "peer.fixture",
  approvedBy: userId,
  createdAt: date,
  terms: {
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: uuid(8),
    createdAt: date,
    salt: "b".repeat(64),
    consideration: "paid",
    priceVersionId: uuid(9),
    termsText: "Private rates",
    prices: [
      { metric: "job.elapsed", quantityUnit: "job-millisecond", perQuantity: "1000", amount: "1" },
    ],
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: revisionId,
      sourceSiteId: source,
      targetSiteId: target,
      mode: "bilateral_attested",
      budgetDomainId: orgId,
      epoch: uuid(10),
      unit: "credit.micro",
      budgetLimit: "99999999999999999999",
      maxTaskAmount: "99999999999999999999",
      maxReservations: 10,
      validFrom: date,
      validUntil: "2099-01-01T00:00:00.000Z",
      templates: [{ originSiteId: source, kind: "script", id: uuid(11), revision: "1", digest }],
      resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 30 },
      termsDigest: digest,
    },
  },
});
const proposal = CommercialDisputeResolutionSchema.parse({
  protocolVersion: 1,
  kind: "commercial-dispute-resolution",
  resolutionId: uuid(12),
  caseId,
  caseDigest: digest,
  domainId: approval.terms.domainId,
  agreementRevisionId: revisionId,
  sourceSiteId: source,
  targetSiteId: target,
  taskId,
  attempt: 1,
  mode: "bilateral_attested",
  decisionId: uuid(13),
  withdrawalDigest: digest,
  headDigest: digest,
  financial: null,
  reason: "Agreed after reviewing original records",
  issuedAt: date,
  salt: "c".repeat(64),
});
const financial = {
  protocolVersion: 1,
  kind: "commercial-adjustment",
  adjustmentId: uuid(14),
  domainId: proposal.domainId,
  agreementRevisionId: revisionId,
  sourceSiteId: source,
  targetSiteId: target,
  billId: uuid(15),
  billDigest: digest,
  settlementId: uuid(16),
  settlementDigest: digest,
  previous: null,
  unit: "credit.micro",
  previousChargedAmount: "9007199254740999",
  chargedAmount: "9007199254740993",
  reason: proposal.reason,
  supportingEvidenceDigest: null,
  issuedAt: date,
  salt: "d".repeat(64),
};
const dispute = {
  protocolVersion: 1,
  kind: "commercial-dispute",
  caseId,
  domainId: proposal.domainId,
  agreementRevisionId: revisionId,
  agreementDigest: digest,
  sourceSiteId: source,
  targetSiteId: target,
  openingSiteId: source,
  taskId,
  attempt: 1,
  subject: { recordType: "bill", recordId: uuid(15), recordDigest: digest },
  reason: "Reconcile disputed charge",
  requestedResolution: "Agree on the final charge",
  issuedAt: date,
  salt: "e".repeat(64),
};
let saved: CommercialDisputeResolutionView | null,
  grants: FederationCapability[],
  withdrawn: boolean;
function view(value = proposal): CommercialDisputeResolutionView {
  return {
    payload: value,
    digest,
    counterpartyApproved: false,
    appliedAt: null,
    createdAt: date,
    financialApproved: false,
    financialAppliedAt: null,
    exchange: null,
    ledger: null,
  };
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (readOnly = false, capabilities = grants) => (
    <QueryClientProvider client={client}>
      <CommercialDisputePanel
        approval={approval}
        scope={scope}
        grants={capabilities}
        readOnly={readOnly}
        busy={false}
      />
    </QueryClientProvider>
  );
  return { ...render(element()), element, client };
}
async function open() {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Reconcile disputed charge/ }));
  await screen.findByText(withdrawn ? "Permanently withdrawn" : "Not withdrawn", { exact: true });
}
async function importProposal(value: unknown = proposal) {
  const file = new File([JSON.stringify(value)], "proposal.json", { type: "application/json" });
  fireEvent.change(screen.getByLabelText("Import counterpart proposal"), {
    target: { files: [file] },
  });
}
async function confirm() {
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  saved = null;
  withdrawn = true;
  grants = [
    "agreement.read",
    "dispute.read",
    "dispute.resolve",
    "adjustment.approve",
    "arbitration.execute",
  ];
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.includes("disputes?"))
      return {
        data: {
          data: [
            {
              localSiteId: source,
              localOrgId: orgId,
              agreementRevisionId: revisionId,
              caseId,
              taskId,
              attempt: 1,
              payload: dispute,
              digest,
              openingJws: "fixture",
              openedBy: userId,
              acceptanceJws: null,
              receivedAt: null,
              state: "DISPUTED",
              createdAt: date,
            },
          ],
          hasMore: false,
        },
      };
    if (path.endsWith("/arbitration-resolution"))
      return {
        data: {
          payload: {
            decisionId: proposal.decisionId,
            decisionDigest: digest,
            caseId,
            caseDigest: digest,
            domainId: proposal.domainId,
            agreementRevisionId: revisionId,
            sourceSiteId: source,
            targetSiteId: target,
            taskId,
            attempt: 1,
            mode: "bilateral_attested",
            headDigest: digest,
            freezeDigest: digest,
            outcome: {
              action: "settle",
              bill: { recordId: uuid(15), recordDigest: digest },
              chargedAmount: "50",
            },
          },
          appliedAt: null,
          createdAt: date,
          withdrawalRequestedAt: withdrawn ? date : null,
          withdrawnAt: withdrawn ? date : null,
        },
      };
    if (path.endsWith("/financial-view"))
      return {
        data: {
          caseId,
          caseDigest: digest,
          agreementRevisionId: revisionId,
          taskId,
          attempt: 1,
          mode: "bilateral_attested",
          observedAt: date,
          records: [],
          localReady: true,
          headDigest: digest,
          requiresLedgerFreeze: false,
        },
      };
    if (path.endsWith("/resolution")) return { data: saved };
    throw new Error(`Unexpected query: ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    if (path.endsWith("/resolution/draft"))
      return { data: { ...proposal, reason: (body as { reason: string }).reason } };
    if (path.endsWith("/resolution")) {
      saved = view(CommercialDisputeResolutionSchema.parse(body));
      return { data: saved };
    }
    return { data: {} };
  });
});
test("proposes a readable no-finance settlement, preserves exact intent after unknown failure, and never approves money", async () => {
  await open();
  fireEvent.click(screen.getByRole("button", { name: "Propose settlement" }));
  fireEvent.change(screen.getByLabelText("Settlement reason"), {
    target: { value: proposal.reason },
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Review proposal" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review proposal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve settlement" }));
  const impl = vi.mocked(api.post).getMockImplementation();
  let failed = false;
  vi.mocked(api.post).mockImplementation(async (path, body, scope) => {
    if (path.endsWith("/resolution") && !failed) {
      failed = true;
      throw new Error("connection lost");
    }
    return impl?.(path, body, scope);
  });
  await confirm();
  await within(screen.getByRole("dialog")).findByRole("alert");
  await confirm();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const writes = vi.mocked(api.post).mock.calls.filter((c) => c[0].endsWith("/resolution"));
  expect(writes).toHaveLength(2);
  expect(writes[0]?.[1]).toEqual(writes[1]?.[1]);
  expect(
    vi
      .mocked(api.post)
      .mock.calls.some(
        (c) => c[0].includes("/adjustments/approve") || c[0].includes("/settlements/approve"),
      ),
  ).toBe(false);
});
test("imports only the same case and contract and approval does not expose internal signatures", async () => {
  await open();
  await importProposal({ ...proposal, caseId: uuid(50) });
  expect((await screen.findByRole("alert")).textContent).toMatch(/another case/);
  expect(api.post).not.toHaveBeenCalled();
  await importProposal();
  fireEvent.click(await screen.findByRole("button", { name: "Approve settlement" }));
  await confirm();
  await screen.findByText("Awaiting counterpart approval", { exact: true });
  expect(document.body.textContent).not.toContain("local.fixture");
});
test("requires a separate financial confirmation and preserves integers above Number precision", async () => {
  const value = CommercialDisputeResolutionSchema.parse({ ...proposal, financial });
  saved = { ...view(value), counterpartyApproved: true };
  await open();
  expect(screen.getAllByText(/9007199254740993/).length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole("button", { name: "Approve financial record" }));
  expect(api.post).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/adjustments/approve`,
      financial,
      scope,
    ),
  );
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
});
test("permission loss and mobile read-only close approval and remove mutation controls", async () => {
  const m = mount();
  fireEvent.click(await screen.findByRole("button", { name: /Reconcile disputed charge/ }));
  await screen.findByLabelText("Import counterpart proposal");
  await importProposal();
  fireEvent.click(await screen.findByRole("button", { name: "Approve settlement" }));
  m.rerender(m.element(true));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Approve settlement" })).toBeNull();
  expect(screen.queryByLabelText("Import counterpart proposal")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("permanent withdrawal gates proposal creation; requesting it never creates execution consent", async () => {
  withdrawn = false;
  await open();
  expect(screen.queryByRole("button", { name: "Propose settlement" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Withdraw execution commitment" }));
  await confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/disputes/${caseId}/arbitration-resolution/withdraw`,
      {},
      scope,
    ),
  );
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
});
test("closed asynchronous cases show ledger failure separately and retry only their own submission", async () => {
  saved = {
    ...view(),
    counterpartyApproved: true,
    appliedAt: date,
    ledger: {
      id: uuid(21),
      state: "needs_review",
      lastError: "DELIVERY_UNAVAILABLE",
      transactionId: "f".repeat(64),
      blockNumber: null,
    },
  };
  await open();
  expect(screen.getByText("Closed locally", { exact: true })).toBeTruthy();
  expect(screen.getByText("Private attestation needs attention", { exact: true })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry private attestation" }));
  await confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/submissions/${uuid(21)}/retry`,
      {},
      scope,
    ),
  );
});
