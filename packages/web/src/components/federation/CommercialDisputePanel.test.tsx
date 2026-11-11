import type { FederationCapability } from "@kuintessence/shared/federation";
import { ArbitrationDecisionSchema } from "@kuintessence/shared/federation/arbitration-decision";
import type { ArbitrationResolutionView } from "@kuintessence/shared/federation/arbitration-resolution";
import { CommercialAgreementApprovalSchema } from "@kuintessence/shared/federation/commercial";
import {
  CommercialDisputeResolutionSchema,
  type CommercialDisputeResolutionView,
} from "@kuintessence/shared/federation/dispute-resolution";
import type { CommercialDispute } from "@kuintessence/shared/federation/disputes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialArbitrationPanel } from "./CommercialArbitrationPanel";
import { CommercialDisputeCreate } from "./CommercialDisputeCreate";
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
const dispute: CommercialDispute = {
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
  withdrawn: boolean,
  hasExecution: boolean,
  agreementMode: "bilateral_attested" | "ledger_coordinated";
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
    authorizationLedger: null,
  };
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (readOnly = false, capabilities = grants) => (
    <QueryClientProvider client={client}>
      <CommercialDisputePanel
        approval={{
          ...approval,
          terms: {
            ...approval.terms,
            agreement: { ...approval.terms.agreement, mode: agreementMode },
          },
        }}
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
  if (hasExecution)
    await screen.findByText(withdrawn ? "Permanently withdrawn" : "Not withdrawn", { exact: true });
  else await screen.findByText(saved ? "Both parties approved" : "Not approved", { exact: true });
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
  hasExecution = true;
  agreementMode = "bilateral_attested";
  grants = [
    "agreement.read",
    "dispute.read",
    "dispute.resolve",
    "adjustment.approve",
    "arbitration.execute",
  ];
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith("/resolution/context"))
      return {
        data: {
          canDraft: !saved && (!hasExecution || withdrawn),
          blockedReason: saved
            ? "RESOLUTION_EXISTS"
            : hasExecution && !withdrawn
              ? "DATA_WAITING"
              : null,
          protocolVersion: hasExecution ? 1 : 2,
          mode: agreementMode,
        },
      };
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
    if (path.endsWith("/delivery"))
      return {
        data: { enabled: true, sync: { state: "received", lastError: null, nextAttemptAt: date } },
      };
    if (path.endsWith("/freeze"))
      return {
        data: {
          enabled: true,
          sync: {
            state: "confirmed",
            lastError: null,
            nextAttemptAt: date,
            confirmedAt: date,
            headDigest: digest,
          },
          attestation: null,
        },
      };
    if (path.endsWith("/arbitration-decision")) return { data: null };
    if (path.endsWith("/arbitration-resolution"))
      return !hasExecution
        ? { data: null }
        : {
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
              approvedHeldAmount: "0",
              lastError: null,
              nextAttemptAt: null,
              ledger: null,
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
      return {
        data: {
          ...proposal,
          ...(!hasExecution
            ? {
                protocolVersion: 2,
                decisionId: null,
                withdrawalDigest: null,
                freezeDigest: agreementMode === "ledger_coordinated" ? digest : null,
                mode: agreementMode,
              }
            : {}),
          reason: (body as { reason: string }).reason,
        },
      };
    if (path.endsWith("/resolution")) {
      saved = view(CommercialDisputeResolutionSchema.parse(body));
      return { data: saved };
    }
    return { data: {} };
  });
});
test("proposes a general settlement without inventing an old decision or withdrawal", async () => {
  hasExecution = false;
  withdrawn = false;
  await open();
  expect(screen.queryByText("Execution withdrawal")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Propose settlement" }));
  fireEvent.change(screen.getByLabelText("Settlement reason"), {
    target: { value: "Both institutions reconciled the originals" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Review proposal" })).toHaveProperty(
      "disabled",
      false,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review proposal" }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve settlement" }));
  await confirm();
  await waitFor(() => expect(saved?.payload.protocolVersion).toBe(2));
  expect(saved?.payload.decisionId).toBeNull();
  expect(saved?.payload.withdrawalDigest).toBeNull();
  expect(
    vi.mocked(api.post).mock.calls.some(([path]) => path.includes("arbitration-resolution")),
  ).toBe(false);
});
test("coordinated settlement waits for its exact chain authorization before financial approval", async () => {
  hasExecution = false;
  agreementMode = "ledger_coordinated";
  saved = {
    ...view(
      CommercialDisputeResolutionSchema.parse({
        ...proposal,
        protocolVersion: 2,
        decisionId: null,
        withdrawalDigest: null,
        freezeDigest: digest,
        mode: agreementMode,
        financial,
      }),
    ),
    counterpartyApproved: true,
    authorizationLedger: {
      id: uuid(25),
      state: "pending",
      lastError: null,
      transactionId: "f".repeat(64),
      blockNumber: null,
    },
  };
  const m = mount();
  fireEvent.click(await screen.findByRole("button", { name: /Reconcile disputed charge/ }));
  await screen.findByText("Settlement chain authorization");
  expect(screen.getByText("Awaiting chain confirmation to continue")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve financial record" })).toBeNull();
  saved = {
    ...saved,
    authorizationLedger: {
      id: uuid(25),
      state: "committed",
      lastError: null,
      transactionId: "f".repeat(64),
      blockNumber: "4",
    },
  };
  await act(async () => {
    await m.client.invalidateQueries({ queryKey: ["federation"] });
  });
  fireEvent.click(await screen.findByRole("button", { name: "Approve financial record" }));
  expect(api.post).not.toHaveBeenCalled();
  await confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/adjustments/approve`,
      financial,
      scope,
    ),
  );
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

function surface(element: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrap = (child: ReactNode) => (
    <QueryClientProvider client={client}>{child}</QueryClientProvider>
  );
  return { ...render(wrap(element)), wrap };
}
const caseRecord = (value = dispute) => ({
  localSiteId: source,
  localOrgId: orgId,
  agreementRevisionId: revisionId,
  caseId: value.caseId,
  taskId,
  attempt: 1,
  payload: value,
  digest,
  openingJws: "private.fixture",
  openedBy: userId,
  acceptanceJws: null,
  receivedAt: null,
  state: "FREEZE_PENDING",
  createdAt: date,
});
test("opens a dispute from the selected original only after confirmation and recovers a lost response with the same case", async () => {
  const onOpened = vi.fn();
  let original: typeof dispute | undefined;
  let lost = false;
  vi.mocked(api.post).mockImplementation(async (path, raw) => {
    if (path.endsWith("/draft")) {
      original = { ...dispute, ...(raw as object) };
      return { data: original };
    }
    if (!lost) {
      lost = true;
      throw new Error("response lost after commit");
    }
    return { data: caseRecord(original) };
  });
  surface(
    <CommercialDisputeCreate
      subject={dispute.subject}
      approval={approval}
      scope={scope}
      writable
      busy={false}
      onCancel={vi.fn()}
      onOpened={onOpened}
    />,
  );
  fireEvent.change(screen.getByLabelText("Reason for dispute"), {
    target: { value: dispute.reason },
  });
  fireEvent.change(screen.getByLabelText("Requested resolution"), {
    target: { value: dispute.requestedResolution },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dispute" }));
  await screen.findByRole("dialog");
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({ subject: dispute.subject });
  await confirm();
  await screen.findAllByRole("alert");
  await confirm();
  await waitFor(() => expect(onOpened).toHaveBeenCalledWith(original?.caseId));
  const posts = vi.mocked(api.post).mock.calls.filter(([path]) => path.endsWith("/open"));
  expect(posts).toHaveLength(2);
  expect(posts[0]).toEqual(posts[1]);
  expect(posts[0]?.[2]).toEqual(scope);
  expect(screen.queryByText("private.fixture")).toBeNull();
});
test("rejects a draft for another original before allowing dispute submission", async () => {
  vi.mocked(api.post).mockResolvedValue({
    data: { ...dispute, subject: { ...dispute.subject, recordId: uuid(999) } },
  });
  surface(
    <CommercialDisputeCreate
      subject={dispute.subject}
      approval={approval}
      scope={scope}
      writable
      busy={false}
      onCancel={vi.fn()}
      onOpened={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByLabelText("Reason for dispute"), {
    target: { value: dispute.reason },
  });
  fireEvent.change(screen.getByLabelText("Requested resolution"), {
    target: { value: dispute.requestedResolution },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dispute" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
});
test("a draft arriving after permission was revoked and restored cannot reopen confirmation", async () => {
  let complete!: (value: { data: unknown }) => void;
  vi.mocked(api.post).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const element = (writable: boolean) => (
    <CommercialDisputeCreate
      subject={dispute.subject}
      approval={approval}
      scope={scope}
      writable={writable}
      busy={false}
      onCancel={vi.fn()}
      onOpened={vi.fn()}
    />
  );
  const m = surface(element(true));
  fireEvent.change(screen.getByLabelText("Reason for dispute"), {
    target: { value: dispute.reason },
  });
  fireEvent.change(screen.getByLabelText("Requested resolution"), {
    target: { value: dispute.requestedResolution },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review dispute" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  const input = vi.mocked(api.post).mock.calls[0]?.[1] as Record<string, unknown>;
  m.rerender(m.wrap(element(false)));
  m.rerender(m.wrap(element(true)));
  await act(async () => complete({ data: { ...dispute, ...input } }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

const decision = ArbitrationDecisionSchema.parse({
  protocolVersion: 1,
  kind: "arbitration-decision",
  issuedAt: date,
  basisDigest: digest,
  basisExpiresAt: "2026-01-01T00:01:00.000Z",
  intent: {
    decisionId: uuid(13),
    salt: "a".repeat(64),
    reason: "Reviewed authorized billing evidence",
    binding: {
      caseId,
      caseDigest: digest,
      domainId: proposal.domainId,
      agreementRevisionId: revisionId,
      agreementDigest: digest,
      sourceSiteId: source,
      targetSiteId: target,
      arbitratorSiteId: uuid(70),
      taskId,
      attempt: 1,
      operationId: uuid(71),
      reservationId: uuid(72),
      requestDigest: digest,
      acceptanceDigest: digest,
      policyId: uuid(73),
      policyDigest: digest,
      mode: "bilateral_attested",
      unit: "credit.micro",
    },
    subject: dispute.subject,
    financial: {
      headDigest: digest,
      freezeDigest: digest,
      records: [],
      evidenceReferences: [],
      targets: [],
      ledgerReceipt: null,
    },
    evidence: [],
    outcome: {
      action: "adjust",
      bill: { recordId: uuid(15), recordDigest: digest },
      settlement: { recordId: uuid(16), recordDigest: digest },
      previousAdjustment: null,
      chargedAmount: "9007199254740993",
    },
  },
});
function executionView(mode = approval.terms.agreement.mode): ArbitrationResolutionView {
  return {
    payload: {
      decisionId: uuid(13),
      decisionDigest: digest,
      caseId,
      caseDigest: digest,
      domainId: proposal.domainId,
      agreementRevisionId: revisionId,
      sourceSiteId: source,
      targetSiteId: target,
      taskId,
      attempt: 1,
      mode,
      headDigest: digest,
      freezeDigest: digest,
      outcome: decision.intent.outcome,
    },
    approvedHeldAmount: "10",
    lastError: null,
    nextAttemptAt: date,
    ledger: null,
    appliedAt: null,
    createdAt: date,
    withdrawalRequestedAt: null,
    withdrawnAt: null,
  };
}
function arbitrationProps() {
  return {
    approval,
    dispute,
    scope,
    caseDigest: digest,
    grants: ["arbitration.execute"] as FederationCapability[],
    readOnly: false,
    busy: false,
    resolved: false,
    execution: null,
    onChanged: vi.fn().mockResolvedValue(undefined),
  };
}
test("reviews the exact large charge before institution approval and keeps a lost-response retry on the original decision", async () => {
  vi.mocked(api.get).mockResolvedValue({ data: { payload: decision, digest, receivedAt: date } });
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValue({ data: executionView() });
  const p = arbitrationProps();
  surface(<CommercialArbitrationPanel {...p} />);
  await screen.findByText(/9007199254740993/);
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Approve decision execution" }));
  expect(within(screen.getByRole("dialog")).getByText(/9007199254740993/)).toBeTruthy();
  await confirm();
  await screen.findByRole("alert");
  await confirm();
  await waitFor(() => expect(p.onChanged).toHaveBeenCalledOnce());
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
  expect(api.post).toHaveBeenCalledWith(
    `/federation/commercial-agreements/${revisionId}/disputes/${caseId}/arbitration-resolution`,
    {},
    scope,
  );
});
test("coordinated authorization stays distinct from local application and retries only its saved ledger item", async () => {
  const p = arbitrationProps();
  const coordinated = {
    ...approval,
    terms: {
      ...approval.terms,
      agreement: { ...approval.terms.agreement, mode: "ledger_coordinated" as const },
    },
  };
  const original = {
    ...decision,
    intent: {
      ...decision.intent,
      binding: { ...decision.intent.binding, mode: "ledger_coordinated" },
    },
  };
  vi.mocked(api.get).mockResolvedValue({ data: { payload: original, digest, receivedAt: date } });
  const value = {
    ...executionView("ledger_coordinated"),
    ledger: { id: uuid(90), state: "needs_review" as const, lastError: "DELIVERY_UNAVAILABLE" },
  };
  const c = <CommercialArbitrationPanel {...p} approval={coordinated} execution={value} />;
  surface(c);
  await screen.findByText("Approved; awaiting execution", { exact: true });
  expect(screen.queryByText("Applied locally", { exact: true })).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve decision execution" })).toBeNull();
  vi.mocked(api.post).mockResolvedValue({ data: {} });
  fireEvent.click(screen.getByRole("button", { name: "Retry private attestation" }));
  await confirm();
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/submissions/${uuid(90)}/retry`,
      {},
      scope,
    ),
  );
});
test("revoking execution permission closes confirmation and mobile remains read only", async () => {
  vi.mocked(api.get).mockResolvedValue({ data: { payload: decision, digest, receivedAt: date } });
  const p = arbitrationProps();
  const m = surface(<CommercialArbitrationPanel {...p} />);
  fireEvent.click(await screen.findByRole("button", { name: "Approve decision execution" }));
  m.rerender(m.wrap(<CommercialArbitrationPanel {...p} grants={["arbitration.approve"]} />));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  m.rerender(m.wrap(<CommercialArbitrationPanel {...p} readOnly />));
  expect(screen.queryByRole("button", { name: "Approve decision execution" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("a decision from another task is rejected without showing its amounts or an execution action", async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: {
      payload: {
        ...decision,
        intent: { ...decision.intent, binding: { ...decision.intent.binding, taskId: uuid(888) } },
      },
      digest,
      receivedAt: date,
    },
  });
  surface(<CommercialArbitrationPanel {...arbitrationProps()} />);
  await screen.findByRole("alert");
  expect(screen.queryByText(/9007199254740993/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Approve decision execution" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("a locally resolved asynchronous case keeps polling its pending attestation until confirmed", async () => {
  grants.push("arbitration.approve");
  const get = vi.mocked(api.get).getMockImplementation();
  let committed = false;
  vi.mocked(api.get).mockImplementation(async (path, requestScope) => {
    if (path.endsWith("/arbitration-decision"))
      return { data: { payload: decision, digest, receivedAt: date } };
    if (path.endsWith("/arbitration-resolution"))
      return {
        data: {
          ...executionView(),
          appliedAt: date,
          nextAttemptAt: null,
          ledger: { id: uuid(90), state: committed ? "committed" : "pending", lastError: null },
        },
      };
    const value = await get?.(path, requestScope);
    if (path.includes("disputes?"))
      return { data: { data: [{ ...caseRecord(), state: "RESOLVED" }], hasMore: false } };
    return value;
  });
  vi.useFakeTimers();
  const m = mount();
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    fireEvent.click(screen.getByRole("button", { name: /Reconcile disputed charge/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getAllByText("Applied locally", { exact: true }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Ledger record.*Awaiting chain confirmation/)).toBeTruthy();
    committed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(screen.getByText(/Confirmed on chain/)).toBeTruthy();
  } finally {
    m.unmount();
    vi.useRealTimers();
  }
});
