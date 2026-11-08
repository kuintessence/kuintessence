import type { FederationAgreementApproval } from "@kuintessence/shared/federation";
import type {
  CommercialAgreement,
  CommercialAgreementApproval,
  CommercialSubmissionsView,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialPanel } from "./CommercialPanel";
import { CommercialUsagePanel } from "./CommercialUsagePanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const device = vi.hoisted(() => ({ readOnly: false }));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({
  useMobileMutationBlocked: () => device.readOnly,
}));
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const scope = { organizationId: orgId, authRevision: "login-1" };
const terms: CommercialAgreement = {
  protocolVersion: 1,
  kind: "commercial-agreement",
  domainId: userId,
  salt: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
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
    validFrom: "2025-01-01T00:00:00.000Z",
    validUntil: "2099-01-01T00:00:00.000Z",
    templates: [
      {
        originSiteId: source,
        kind: "script",
        id: userId,
        revision: "v1",
        digest: `sha256:${"a".repeat(64)}`,
      },
    ],
    resourceLimit: { cpus: 1, memoryMb: 64, gpus: 0, wallTimeSec: 30 },
    termsDigest: `sha256:${"b".repeat(64)}`,
  },
  consideration: "paid",
  priceVersionId: userId,
  prices: [
    {
      metric: "cpu",
      quantityUnit: "core-second",
      perQuantity: "3600",
      amount: "9007199254740993123",
    },
  ],
  termsText: "Private agreed contract terms",
};
const base: FederationAgreementApproval = {
  localSiteId: source,
  localOrgId: orgId,
  revisionId,
  executionUserId: null,
  terms: terms.agreement,
  termsDigest: `sha256:${"c".repeat(64)}`,
  approvalJws: "execution.local.signature",
  counterpartyApprovalJws: null,
  approvedBy: userId,
  state: "active",
  createdAt: terms.createdAt,
};
const original: CommercialAgreementApproval = {
  localSiteId: source,
  localOrgId: orgId,
  revisionId,
  terms,
  digest: `sha256:${"d".repeat(64)}`,
  approvalJws: "commercial.local.signature",
  counterpartyJws: null,
  approvedBy: userId,
  createdAt: terms.createdAt,
};
let row: CommercialAgreementApproval,
  listed: boolean,
  grants: string[],
  status: CommercialSubmissionsView;
function mount(switching = false) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <CommercialPanel scope={scope} switching={switching} />
      </QueryClientProvider>,
    ),
  };
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  device.readOnly = false;
  listed = false;
  row = structuredClone(original);
  grants = ["agreement.read", "agreement.approve"];
  status = { enabled: true, submissions: [] };
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/federation/capabilities")
      return { data: { orgId, userId, grants, effectiveCapabilities: grants } };
    if (path.endsWith("/context"))
      return {
        data: { localSiteId: source, supportedModes: ["bilateral_direct", "bilateral_attested"] },
      };
    if (path.startsWith("/federation/agreements?")) return { data: [base] };
    if (
      path.includes("/bills?") ||
      path.includes("/settlements?") ||
      path.includes("/refunds?") ||
      path.includes("/adjustments?")
    )
      return { data: { data: [], hasMore: false } };
    if (path.includes("/submissions?")) return { data: status };
    if (path.includes("/closing-policies?")) return { data: [] };
    if (path.includes("/closing-tasks?")) return { data: { enabled: true, records: [] } };
    if (path.includes("?limit="))
      return {
        data: listed
          ? [
              {
                revisionId,
                digest: row.digest,
                approvedBy: userId,
                createdAt: row.createdAt,
                sourceSiteId: source,
                targetSiteId: target,
                sourceName: "Research A",
                targetName: "Research B",
                mode: row.terms.agreement.mode,
                consideration: row.terms.consideration,
                hasCounterpartyApproval: !!row.counterpartyJws,
              },
            ]
          : [],
      };
    return { data: row };
  });
  vi.mocked(api.post).mockResolvedValue({ success: true });
});
async function create() {
  const button = await screen.findByRole("button", { name: "New contract" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
async function importTerms(value: unknown = terms) {
  await create();
  fireEvent.click(screen.getByRole("radio", { name: "Import complete contract" }));
  fireEvent.change(screen.getByLabelText("Terms JSON"), {
    target: { value: JSON.stringify(value) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Load contract" }));
}
async function openDetail() {
  fireEvent.click(await screen.findByRole("button", { name: /Research A.*Research B/ }));
  await screen.findByRole("button", { name: "Export contract" });
}
test("import, edit and review exact integer prices before signing with the captured organization", async () => {
  mount();
  await importTerms();
  fireEvent.change(screen.getByLabelText("Amount"), { target: { value: "9007199254740993999" } });
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
  const dialog = within(screen.getByRole("dialog"));
  expect(dialog.getByText("9,007,199,254,740,993,999")).toBeTruthy();
  expect(dialog.getByText(/do not authorize execution/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/federation/commercial-agreements/approve",
      { terms: { ...terms, prices: [{ ...terms.prices[0], amount: "9007199254740993999" }] } },
      scope,
    ),
  );
});

test("existing agreement creates fresh protected identifiers, adds/removes prices and keeps charity rates at zero", async () => {
  mount();
  await create();
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`${source}.*${target}`) }));
  fireEvent.change(screen.getByLabelText("Private cooperation domain"), {
    target: { value: userId },
  });
  fireEvent.change(screen.getByLabelText("Contract terms"), {
    target: { value: "Voluntary resource contribution" },
  });
  expect((screen.getByLabelText("Amount") as HTMLInputElement).readOnly).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Add price" }));
  fireEvent.change(screen.getByLabelText("Metric"), {
    target: { value: "storage" },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0] as HTMLElement);
  expect((screen.getByLabelText("Metric") as HTMLInputElement).value).toBe("storage");
  fireEvent.change(screen.getByLabelText("Quantity unit"), { target: { value: "byte-hour" } });
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
  const request = vi.mocked(api.post).mock.calls[0]?.[1] as { terms: CommercialAgreement };
  expect(request.terms.agreement).toEqual(base.terms);
  expect(request.terms.salt).toMatch(/^[a-f0-9]{64}$/);
  expect(request.terms.salt).not.toBe(terms.salt);
  expect(request.terms.priceVersionId).not.toBe(terms.priceVersionId);
  expect(request.terms.prices).toEqual([
    { metric: "storage", quantityUnit: "byte-hour", perQuantity: "1", amount: "0" },
  ]);
});

test.each([
  [{ ...terms, extra: "hidden" }, /do not match/],
  [{ ...terms, agreement: { ...terms.agreement, sourceSiteId: userId } }, /not a party/],
  [
    { ...terms, agreement: { ...terms.agreement, validUntil: "2025-01-02T00:00:00.000Z" } },
    /has expired/,
  ],
  [{ ...terms, createdAt: "2099-01-01T00:00:00.000Z" }, /in the future/],
])("rejects unsupported fields, foreign sites, expired and future-dated imports", async (value, error) => {
  mount();
  await importTerms(value);
  expect(screen.getByRole("alert").textContent).toMatch(error);
  expect(api.post).not.toHaveBeenCalled();
});

test("failure retains the exact reviewed terms and identifiers for retry", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("unconfirmed"));
  mount();
  await importTerms();
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await dialog.findByRole("alert");
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
});

test("ledger-coordinated commercial signing is available without claiming execution activation", async () => {
  mount();
  await importTerms({ ...terms, agreement: { ...terms.agreement, mode: "ledger_coordinated" } });
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
  expect(within(screen.getByRole("dialog")).getByText(/do not authorize execution/)).toBeTruthy();
  expect(
    (
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Confirm",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

test("signature attachment and ledger retry use explicit confirmation and scoped routes", async () => {
  listed = true;
  mount();
  await openDetail();
  fireEvent.change(screen.getByLabelText("Counterparty signature"), {
    target: { value: "peer.reviewed.signature" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify counterparty signature" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/counterparty`,
      { approvalJws: "peer.reviewed.signature" },
      scope,
    ),
  );
});

test("submitted but unconfirmed transactions never appear recorded, and retry preserves the original record identity", async () => {
  listed = true;
  row.counterpartyJws = "peer.reviewed.signature";
  status = {
    enabled: true,
    submissions: [
      {
        id: userId,
        state: "needs_review",
        lastError: "INVALID_ADAPTER_RESPONSE",
        createdAt: terms.createdAt,
        updatedAt: terms.createdAt,
        transaction: {
          transactionId: "a".repeat(64),
          stage: "transaction",
          validationCode: null,
          blockNumber: null,
        },
      },
    ],
  };
  mount();
  await openDetail();
  fireEvent.click(await screen.findByRole("button", { name: "Retry ledger submission" }));
  expect(screen.queryByText("Recorded on ledger")).toBeNull();
  expect(screen.getByText("Unconfirmed")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/submissions/${userId}/retry`,
      {},
      scope,
    ),
  );
});

test.each([
  "mobile",
  "read",
  "switching",
])("%s prevents signing and counterpart changes", async (condition) => {
  listed = true;
  device.readOnly = condition === "mobile";
  if (condition === "read") grants = ["agreement.read"];
  mount(condition === "switching");
  await openDetail();
  const createButton = screen.queryByRole("button", { name: "New contract" });
  if (condition === "switching") expect((createButton as HTMLButtonElement).disabled).toBe(true);
  else expect(createButton).toBeNull();
  const attach = screen.queryByRole("button", { name: "Verify counterparty signature" });
  if (condition === "switching") expect((attach as HTMLButtonElement).disabled).toBe(true);
  else expect(attach).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("scope-mismatched detail is rejected before showing private terms", async () => {
  listed = true;
  row.localOrgId = userId;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Research A.*Research B/ }));
  await screen.findByRole("alert");
  expect(screen.queryByText(terms.termsText)).toBeNull();
});

function usageSetup(provider = true, state: "reported" | "missing_data" = "reported") {
  const approval: CommercialAgreementApproval = {
    ...structuredClone(original),
    localSiteId: provider ? target : source,
    counterpartyJws: "peer.signature",
  };
  approval.terms.prices = [
    { metric: "cpu.time", quantityUnit: "cpu-millisecond", perQuantity: "1000", amount: "1" },
  ];
  const record = {
    number: 1,
    report: {
      protocolVersion: 1 as const,
      kind: "commercial-usage" as const,
      reportId: userId,
      domainId: terms.domainId,
      agreementRevisionId: revisionId,
      agreementDigest: approval.digest,
      sourceSiteId: source,
      targetSiteId: target,
      taskId: orgId,
      attempt: 1,
      salt: "a".repeat(64),
      reportedAt: "2026-11-01T02:00:00.000Z",
      periodStart: "2026-11-01T00:00:00.000Z",
      periodEnd: "2026-11-01T01:00:00.000Z",
      measurements: [
        {
          metric: "cpu.time",
          quantityUnit: "cpu-millisecond",
          quantity: "9007199254740993",
          evidenceDigest: `sha256:${"a".repeat(64)}`,
        },
      ],
    },
    reportJws: "fixture.signed.report",
    digest: `sha256:${"b".repeat(64)}`,
    correctionEvidence: null,
    submissionId: userId,
    ledgerState: null as "pending" | "committed" | "needs_review" | null,
    lastError: null,
  };
  const task = {
    reservationId: orgId,
    localSiteId: target,
    localOrgId: orgId,
    agreementRevisionId: revisionId,
    state,
    gaps:
      state === "missing_data"
        ? [{ metric: "cpu.time", reason: "MISSING_ACCOUNTING", missingJobs: 2 }]
        : [],
    lastError: state === "missing_data" ? "MISSING_ACCOUNTING" : null,
    updatedAt: terms.createdAt,
  };
  const sync = {
    operationId: orgId,
    number: 1,
    lastReportId: record.report.reportId,
    state: "pending",
    providerState: state,
    lastError: null,
    verifiedAt: terms.createdAt,
    nextAttemptAt: terms.createdAt,
  };
  const detail = provider
    ? { task, reports: state === "reported" ? [record] : [], hasMore: false }
    : { sync, syncEnabled: true, reports: [record], hasMore: false };
  const path = `/federation/commercial-agreements/${revisionId}/${provider ? "usage" : "received-usage"}`;
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: url.startsWith(`${path}?`) ? [provider ? task : sync] : detail,
  }));
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const renderPanel = (writable = true, busy = false, onDraftBill?: (id: string) => void) => (
    <QueryClientProvider client={client}>
      <CommercialUsagePanel
        approval={approval}
        scope={scope}
        writable={writable}
        busy={busy}
        onDraftBill={onDraftBill}
      />
    </QueryClientProvider>
  );
  return { approval, record, task, sync, detail, path, client, renderPanel };
}
async function openUsage(provider = true) {
  fireEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`^${provider ? "Reservation" : "Delegation"}`),
    }),
  );
  await screen.findByRole("button", { name: "Back to usage list" });
}
async function fillCorrection() {
  fireEvent.click(await screen.findByRole("button", { name: "Add technical correction" }));
  fireEvent.change(screen.getByLabelText(/^Corrected usage/), {
    target: { value: "9007199254741999" },
  });
  fireEvent.change(screen.getByLabelText("Supporting SHA-256 digest"), {
    target: { value: `sha256:${"c".repeat(64)}` },
  });
  fireEvent.change(screen.getByLabelText("Correction reason"), {
    target: { value: "Verified delayed accounting" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review and sign correction" }));
  return within(await screen.findByRole("dialog"));
}

test("usage report keeps exact integers and separates local signatures from pending ledger and received state", async () => {
  const f = usageSetup();
  f.record.ledgerState = "pending";
  render(f.renderPanel());
  await openUsage();
  expect(await screen.findByText(/9,007,199,254,740,993 CPU milliseconds/)).toBeTruthy();
  expect(screen.getByText("Awaiting ledger submission")).toBeTruthy();
  expect(screen.queryByText("Recorded on ledger")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
  expect(vi.mocked(api.get).mock.calls.every((call) => call[1] === scope)).toBe(true);
});

test("usage correction review preserves the same signed intent after an unconfirmed request", async () => {
  const f = usageSetup();
  vi.mocked(api.post).mockRejectedValueOnce(new Error("response lost"));
  render(f.renderPanel());
  await openUsage();
  const dialog = await fillCorrection();
  expect(dialog.getByText(/9,007,199,254,741,999/)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await dialog.findByRole("alert");
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
  expect(vi.mocked(api.post).mock.calls[0]).toEqual([
    `${f.path}/${orgId}/corrections`,
    {
      reportId: expect.any(String),
      correctionOf: f.record.report.reportId,
      reason: "Verified delayed accounting",
      measurements: [
        {
          metric: "cpu.time",
          quantityUnit: "cpu-millisecond",
          quantity: "9007199254741999",
          supportingEvidenceDigest: `sha256:${"c".repeat(64)}`,
        },
      ],
    },
    scope,
  ]);
});

test("usage correction rejects fractional quantities and malformed supporting hashes without posting", async () => {
  const f = usageSetup();
  render(f.renderPanel());
  await openUsage();
  fireEvent.click(await screen.findByRole("button", { name: "Add technical correction" }));
  fireEvent.change(screen.getByLabelText(/^Corrected usage/), { target: { value: "1.5" } });
  fireEvent.change(screen.getByLabelText("Supporting SHA-256 digest"), {
    target: { value: "bad" },
  });
  fireEvent.change(screen.getByLabelText("Correction reason"), {
    target: { value: "A correction" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review and sign correction" }));
  expect(screen.getByRole("alert").textContent).toContain("complete integer quantities");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("missing usage remains missing and recheck cannot overwrite quantities", async () => {
  const f = usageSetup(true, "missing_data");
  render(f.renderPanel());
  await openUsage();
  expect(await screen.findByText(/Scheduler accounting missing/)).toBeTruthy();
  expect(screen.getByText("No report available yet")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add technical correction" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Recheck accounting" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${f.path}/${orgId}/retry`, {}, scope));
});

test("received usage can request synchronization but cannot correct the provider's report", async () => {
  const f = usageSetup(false);
  render(f.renderPanel());
  await openUsage(false);
  expect(await screen.findByText("Received and signature verified")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Add technical correction" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Sync provider reports" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${f.path}/${orgId}/refresh`, {}, scope),
  );
});

test("usage permission loss closes a correction review and read-only mode never offers mutations", async () => {
  const f = usageSetup();
  const view = render(f.renderPanel());
  await openUsage();
  await fillCorrection();
  view.rerender(f.renderPanel(false));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Add technical correction" })).toBeNull();
  expect(screen.queryByLabelText("Correction reason")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("usage detail rejects foreign contract records and offers refresh without stale correction controls", async () => {
  const f = usageSetup();
  f.record.report.agreementRevisionId = userId;
  render(f.renderPanel());
  await openUsage();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Add technical correction" })).toBeNull();
  expect(screen.queryByText(/9,007,199,254,740,993/)).toBeNull();
});

test("usage history pagination preserves scope and disables correction on older pages", async () => {
  const f = usageSetup();
  f.detail.hasMore = true;
  render(f.renderPanel());
  await openUsage();
  fireEvent.click(await screen.findByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${f.path}/${orgId}?limit=10&offset=10`, scope),
  );
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: "Add technical correction" })).toBeNull(),
  );
});

test("usage ledger retry references the report submission rather than contract registration", async () => {
  const f = usageSetup();
  f.record.ledgerState = "needs_review";
  render(f.renderPanel());
  await openUsage();
  fireEvent.click(await screen.findByRole("button", { name: "Retry ledger submission" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/submissions/${userId}/retry`,
      {},
      scope,
    ),
  );
});

test("new commercial meters bind unit atomically while imported legacy meter values stay intact", async () => {
  mount();
  await create();
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`${source}.*${target}`) }));
  expect((screen.getByLabelText("Meter") as HTMLSelectElement).value).toBe("cpu.time");
  fireEvent.change(screen.getByLabelText("Meter"), { target: { value: "cpu.allocated" } });
  fireEvent.change(screen.getByLabelText("Private cooperation domain"), {
    target: { value: userId },
  });
  fireEvent.change(screen.getByLabelText("Contract terms"), {
    target: { value: "Allocated CPU-time meter" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
  expect(within(screen.getByRole("dialog")).getByText("Allocated CPU time")).toBeTruthy();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledOnce());
  const request = vi.mocked(api.post).mock.calls[0]?.[1] as { terms: CommercialAgreement };
  expect(request.terms.prices[0]).toEqual({
    metric: "cpu.allocated",
    quantityUnit: "core-millisecond",
    perQuantity: "1000",
    amount: "0",
  });
});

test("usage received history stays readable with transport disabled and no misleading refresh action", async () => {
  const f = usageSetup(false);
  if (!("syncEnabled" in f.detail)) throw new Error("Expected received detail");
  f.detail.syncEnabled = false;
  render(f.renderPanel());
  await openUsage(false);
  expect(
    await screen.findByText(
      "Institution transport is not configured. Saved reports remain available.",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Received and signature verified")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Sync provider reports" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test.each([
  { capabilities: ["agreement.read", "agreement.approve"], mobile: false, canBill: false },
  { capabilities: ["agreement.read", "billing.approve"], mobile: false, canBill: true },
  { capabilities: ["agreement.read", "billing.approve"], mobile: true, canBill: false },
])("billing tab respects its independent permission and device policy: %j", async ({
  capabilities,
  mobile,
  canBill,
}) => {
  listed = true;
  row.counterpartyJws = "peer.signature";
  grants = capabilities;
  device.readOnly = mobile;
  mount();
  await openDetail();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Bills" }), { button: 0, ctrlKey: false });
  await screen.findByText("No approved bills");
  expect(!!screen.queryByRole("button", { name: "Import bill" })).toBe(canBill);
  expect(api.post).not.toHaveBeenCalled();
});

test("latest provider report opens a bill draft without granting correction permission", async () => {
  const fixture = usageSetup();
  const draft = vi.fn();
  render(fixture.renderPanel(false, false, draft));
  await openUsage();
  fireEvent.click(await screen.findByRole("button", { name: "Create bill" }));
  expect(draft).toHaveBeenCalledWith(fixture.record.report.reportId);
  expect(screen.queryByRole("button", { name: "Add technical correction" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test.each([
  {
    capabilities: ["agreement.read", "agreement.approve", "billing.approve"],
    mobile: false,
    canSettle: false,
  },
  { capabilities: ["agreement.read", "settlement.approve"], mobile: false, canSettle: true },
  { capabilities: ["agreement.read", "settlement.approve"], mobile: true, canSettle: false },
])("settlement tab respects independent permission and mobile policy: %j", async ({
  capabilities,
  mobile,
  canSettle,
}) => {
  listed = true;
  row.counterpartyJws = "peer.signature";
  grants = capabilities;
  device.readOnly = mobile;
  mount();
  await openDetail();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Settlements" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No approved settlements");
  expect(!!screen.queryByRole("button", { name: "Create settlement" })).toBe(canSettle);
  expect(api.post).not.toHaveBeenCalled();
});

test.each([
  {
    capabilities: ["agreement.read", "agreement.approve"],
    mobile: false,
    bill: false,
    settlement: false,
  },
  {
    capabilities: ["agreement.read", "billing.approve"],
    mobile: false,
    bill: true,
    settlement: false,
  },
  {
    capabilities: ["agreement.read", "settlement.approve"],
    mobile: false,
    bill: false,
    settlement: true,
  },
  {
    capabilities: ["agreement.read", "billing.approve", "settlement.approve"],
    mobile: true,
    bill: false,
    settlement: false,
  },
])("closing tab separates financial permissions and keeps mobile read-only: %j", async ({
  capabilities,
  mobile,
  bill,
  settlement,
}) => {
  listed = true;
  row.counterpartyJws = "peer.signature";
  grants = capabilities;
  device.readOnly = mobile;
  mount();
  await openDetail();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Automatic approvals" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No automatic approval authority granted");
  expect(!!screen.queryByRole("button", { name: "Authorize bills" })).toBe(bill);
  expect(!!screen.queryByRole("button", { name: "Authorize settlements" })).toBe(settlement);
  expect(!!screen.queryByRole("button", { name: "Authorize cancellation refunds" })).toBe(
    settlement,
  );
});

test.each([
  {
    capabilities: ["agreement.read", "agreement.approve", "billing.approve", "settlement.approve"],
    mobile: false,
    canAdjust: false,
  },
  { capabilities: ["agreement.read", "adjustment.approve"], mobile: false, canAdjust: true },
  { capabilities: ["agreement.read", "adjustment.approve"], mobile: true, canAdjust: false },
])("adjustment tab respects independent permission and mobile policy: %j", async ({
  capabilities,
  mobile,
  canAdjust,
}) => {
  listed = true;
  row.counterpartyJws = "peer.signature";
  grants = capabilities;
  device.readOnly = mobile;
  mount();
  await openDetail();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Adjustments" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No approved adjustments");
  expect(!!screen.queryByRole("button", { name: "Create adjustment" })).toBe(canAdjust);
  expect(api.post).not.toHaveBeenCalled();
});

test.each([
  {
    capabilities: ["agreement.read", "agreement.approve", "billing.approve"],
    mobile: false,
    canSettle: false,
  },
  { capabilities: ["agreement.read", "settlement.approve"], mobile: false, canSettle: true },
  { capabilities: ["agreement.read", "settlement.approve"], mobile: true, canSettle: false },
])("refund tab respects independent permission and mobile policy: %j", async ({
  capabilities,
  mobile,
  canSettle,
}) => {
  listed = true;
  row.counterpartyJws = "peer.signature";
  grants = capabilities;
  device.readOnly = mobile;
  mount();
  await openDetail();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Refunds" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No approved refunds");
  expect(!!screen.queryByRole("button", { name: "Create refund" })).toBe(canSettle);
  expect(api.post).not.toHaveBeenCalled();
});

test("source closing history navigates to the original refund with its filter", async () => {
  listed = true;
  row.counterpartyJws = "peer.signature";
  const refundId = "33333333-3333-4333-8333-333333333333";
  const originalGet = vi.mocked(api.get).getMockImplementation();
  if (!originalGet) throw new Error("Missing API fixture");
  vi.mocked(api.get).mockImplementation(async (path, scope) =>
    path.includes("/closing-tasks?")
      ? {
          data: {
            enabled: true,
            records: [
              {
                localSiteId: row.localSiteId,
                localOrgId: orgId,
                agreementRevisionId: revisionId,
                kind: "refund",
                referenceId: userId,
                policyId: userId,
                recordId: refundId,
                state: "complete",
                nextAttemptAt: terms.createdAt,
                completedAt: terms.createdAt,
                lastError: null,
              },
            ],
          },
        }
      : originalGet(path, scope),
  );
  mount();
  await openDetail();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Automatic approvals" }), {
    button: 0,
    ctrlKey: false,
  });
  fireEvent.click(await screen.findByRole("button", { name: "View refund" }));
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${revisionId}/refunds?limit=20&offset=0&recordId=${refundId}`,
      scope,
    ),
  );
  expect(screen.getByRole("tab", { name: "Refunds" }).getAttribute("aria-selected")).toBe("true");
});
