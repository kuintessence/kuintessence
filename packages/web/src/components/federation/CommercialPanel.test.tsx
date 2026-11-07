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
    if (path.includes("/submissions?")) return { data: status };
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
  fireEvent.change(screen.getAllByLabelText("Metric")[1] as HTMLElement, {
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
