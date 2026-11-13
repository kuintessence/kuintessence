import {
  CommercialAgreementApprovalSchema,
  type ReservationPolicy,
  ReservationPolicySchema,
  type TerminalPolicy,
} from "@kuintessence/shared/federation/commercial";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialAutomationPanel } from "./CommercialAutomationPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = uuid(1),
  target = uuid(2),
  org = uuid(3),
  user = uuid(4),
  revision = uuid(5);
const digest = `sha256:${"a".repeat(64)}`;
const scope = { organizationId: org, authRevision: "login-1" };
const approval = CommercialAgreementApprovalSchema.parse({
  localSiteId: source,
  localOrgId: org,
  revisionId: revision,
  digest,
  approvalJws: "local.signature",
  counterpartyJws: "peer.signature",
  approvedBy: user,
  createdAt: "2026-01-01T00:00:00Z",
  terms: {
    protocolVersion: 1,
    kind: "commercial-agreement",
    domainId: user,
    salt: "b".repeat(64),
    createdAt: "2026-01-01T00:00:00Z",
    consideration: "paid",
    priceVersionId: user,
    termsText: "Agreed rates",
    prices: [
      { metric: "job.elapsed", quantityUnit: "job-millisecond", perQuantity: "1000", amount: "1" },
    ],
    agreement: {
      protocolVersion: 1,
      kind: "agreement",
      agreementRevisionId: revision,
      sourceSiteId: source,
      targetSiteId: target,
      mode: "ledger_coordinated",
      budgetDomainId: org,
      epoch: user,
      unit: "credit.micro",
      budgetLimit: "99999999999999999999",
      maxTaskAmount: "9007199254740993",
      maxReservations: 10,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2099-01-01T00:00:00Z",
      templates: [{ originSiteId: source, kind: "script", id: user, revision: "1", digest }],
      resourceLimit: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 30 },
      termsDigest: digest,
    },
  },
});
const base = `/federation/commercial-agreements/${revision}`;
const policy: ReservationPolicy = ReservationPolicySchema.parse({
  id: uuid(6),
  localSiteId: source,
  localOrgId: org,
  agreementRevisionId: revision,
  agreementDigest: digest,
  allowMarketPublish: true,
  allowMarketClaim: false,
  allowActivation: false,
  allowExecutionConfirmation: false,
  maxTaskAmount: "9007199254740993",
  maxTotalAmount: "9007199254740999",
  maxTasks: 10,
  authorizedAmount: "9007199254740993",
  authorizedTasks: 1,
  marketAuthorizedAmount: "9007199254740993",
  marketAuthorizedTasks: 1,
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: "2099-01-01T00:00:00Z",
  grantedBy: user,
  revokedAt: null,
  revokedBy: null,
});
let rows: unknown[];
function mount(props: Partial<Parameters<typeof CommercialAutomationPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (changes = {}) => (
    <QueryClientProvider client={client}>
      <CommercialAutomationPanel
        approval={approval}
        scope={scope}
        writable
        grants={["agreement.approve", "market.publish"]}
        busy={false}
        {...props}
        {...changes}
      />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return {
    client,
    rerender: (changes: Partial<Parameters<typeof CommercialAutomationPanel>[0]>) =>
      rendered.rerender(view(changes)),
  };
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  rows = [];
  vi.mocked(api.get).mockResolvedValue({ data: rows });
  vi.mocked(api.post).mockImplementation(async (path, input) => {
    if (path.endsWith("/revoke")) {
      const saved = { ...policy, revokedAt: "2026-11-11T00:00:00Z", revokedBy: user };
      rows = [saved];
      return { data: saved };
    }
    const saved = { ...policy, ...(input as object), authorizedAmount: "0", authorizedTasks: 0 };
    rows = [saved];
    return { data: saved };
  });
  vi.mocked(api.get).mockImplementation(async () => ({ data: rows }));
});
async function editReservation() {
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Grant authorization" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Grant authorization" }));
  fireEvent.change(screen.getByLabelText("Amount per task"), {
    target: { value: "9007199254740993" },
  });
  fireEvent.change(screen.getByLabelText("Total authorized amount"), {
    target: { value: "9007199254740999" },
  });
  fireEvent.change(screen.getByLabelText("Total tasks"), { target: { value: "10" } });
  fireEvent.change(screen.getByLabelText("Valid until (local time)"), {
    target: { value: "2031-01-01T00:00" },
  });
  fireEvent.click(screen.getByLabelText("Publish demands"));
  fireEvent.click(screen.getByRole("button", { name: "Review authorization" }));
  return screen.findByRole("dialog");
}

test("grant reviews exact large amounts and source-specific authority before a separate confirmation", async () => {
  mount();
  const dialog = await editReservation();
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByLabelText("Claim demands")).toBeNull();
  expect(within(dialog).getByText("9007199254740993 credit.micro")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `${base}/reservation-policies`,
      {
        allowMarketPublish: true,
        allowMarketClaim: false,
        allowActivation: false,
        allowExecutionConfirmation: false,
        maxTaskAmount: "9007199254740993",
        maxTotalAmount: "9007199254740999",
        maxTasks: 10,
        validUntil: new Date("2031-01-01T00:00").toISOString(),
      },
      scope,
    ),
  );
  await screen.findByText("Active", { exact: true });
});

test("unknown grant response is never retried automatically and requires a fresh read", async () => {
  vi.mocked(api.post).mockImplementationOnce(async () => {
    rows = [policy];
    throw new Error("response lost");
  });
  mount();
  const dialog = await editReservation();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText(/Authorization outcome unconfirmed/);
  expect(
    (screen.getByRole("button", { name: "Grant authorization" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Active", { exact: true });
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(
    (screen.getByRole("button", { name: "Grant authorization" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("revocation confirms the original policy and keeps execution and market counters separate", async () => {
  rows = [policy];
  mount();
  await screen.findByText("Execution authorizations: 1 tasks · 9007199254740993 credit.micro");
  expect(
    screen.getByText("Market authorizations: 1 tasks · 9007199254740993 credit.micro"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Revoke authorization" }));
  const dialog = await screen.findByRole("dialog");
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Revoked", { exact: true });
  expect(api.post).toHaveBeenCalledWith(
    `${base}/reservation-policies/${policy.id}/revoke`,
    {},
    scope,
  );
});

test.each([
  { localOrgId: uuid(20) },
  { agreementDigest: `sha256:${"f".repeat(64)}` },
])("foreign policy data blocks authority: %j", async (change) => {
  rows = [{ ...policy, ...change }];
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Revoke authorization" })).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Grant authorization" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("revoking management permission dismisses a pending confirmation", async () => {
  const view = mount();
  await editReservation();
  view.rerender({ writable: false });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Grant authorization" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("terminal authorization signs only the selected outcomes", async () => {
  mount();
  await screen.findByText("No authorizations.");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Execution outcomes" }), {
    button: 0,
    ctrlKey: false,
  });
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`${base}/terminal-policies?limit=20&offset=0`, scope),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Grant authorization" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Grant authorization" }));
  fireEvent.change(screen.getByLabelText("Valid until (local time)"), {
    target: { value: "2031-01-01T00:00" },
  });
  const input: Pick<TerminalPolicy, "outcomes" | "validUntil"> = {
    outcomes: ["completed", "failed"],
    validUntil: new Date("2031-01-01T00:00").toISOString(),
  };
  vi.mocked(api.post).mockResolvedValueOnce({
    data: {
      id: uuid(7),
      localSiteId: source,
      localOrgId: org,
      agreementRevisionId: revision,
      agreementDigest: digest,
      validFrom: "2026-01-01T00:00:00Z",
      grantedBy: user,
      revokedAt: null,
      revokedBy: null,
      ...input,
    } satisfies TerminalPolicy,
  });
  fireEvent.click(screen.getByLabelText("Failed", { exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Review authorization" }));
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }),
  );
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(`${base}/terminal-policies`, input, scope),
  );
});

test.each(["unsigned", "direct"])("%s contracts never load coordinated policies", async (state) => {
  mount({
    approval:
      state === "unsigned"
        ? { ...approval, counterpartyJws: null }
        : {
            ...approval,
            terms: {
              ...approval.terms,
              agreement: { ...approval.terms.agreement, mode: "bilateral_direct" },
            },
          },
  });
  await screen.findByText(/Both parties must sign/);
  expect(api.get).not.toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});
