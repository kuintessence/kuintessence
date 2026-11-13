import {
  CommercialAgreementApprovalSchema,
  ReservationPolicySchema,
} from "@kuintessence/shared/federation/commercial";
import type { MarketRequest } from "@kuintessence/shared/federation/market-request";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialMarketRequestsPanel } from "./CommercialMarketRequestsPanel";
import { buildMarketRequest, policyUsable } from "./market-request-view";

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

const policy = ReservationPolicySchema.parse({
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
  authorizedAmount: "0",
  authorizedTasks: 0,
  marketAuthorizedAmount: "0",
  marketAuthorizedTasks: 0,
  validFrom: "2026-01-01T00:00:00Z",
  validUntil: "2099-01-01T00:00:00Z",
  grantedBy: user,
  revokedAt: null,
  revokedBy: null,
});
const base = `/federation/commercial-agreements/${revision}/market-requests`;
const inputDigest = `sha256:${"c".repeat(64)}`,
  lockDigest = `sha256:${"d".repeat(64)}`;
function fields() {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    title: "BWA example",
    description: "Public requirements",
    platform: "linux",
    architecture: "x86_64",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    template: "0",
    inputs: inputDigest,
    "environment-lock": lockDigest,
    cpus: "1",
    memoryMb: "128",
    gpus: "0",
    wallTimeSec: "30",
    maxAmount: "9007199254740993",
  }))
    data.set(key, value);
  return data;
}
function record(request: MarketRequest) {
  return {
    reservationId: request.proposal.reservationId,
    demandId: request.demand.demandId,
    agreementRevisionId: revision,
    policyId: policy.id,
    direction: "outbound",
    state: "pending",
    lastError: null,
    marketSubmissionId: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    nextAttemptAt: null,
    request,
  };
}
let rows: ReturnType<typeof record>[];
let options: unknown[];
let enabled: boolean;
const grants = ["agreement.read", "delegation.submit", "agreement.approve"];
function mount(changes: Partial<Parameters<typeof CommercialMarketRequestsPanel>[0]> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (props = {}) => (
    <QueryClientProvider client={client}>
      <CommercialMarketRequestsPanel
        approval={approval}
        scope={scope}
        grants={grants}
        readOnly={false}
        busy={false}
        {...changes}
        {...props}
      />
    </QueryClientProvider>
  );
  const rendered = render(view());
  return {
    ...rendered,
    update: (props: Partial<Parameters<typeof CommercialMarketRequestsPanel>[0]>) =>
      rendered.rerender(view(props)),
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.resetAllMocks();
  rows = [];
  options = [policy];
  enabled = true;
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.includes("/reservation-policies?")) return { data: options };
    if (path.startsWith("/federation/assets/materials"))
      return {
        data: {
          data: [
            {
              localOrgId: org,
              originSiteId: source,
              kind: "inputs",
              digest: inputDigest,
              createdAt: approval.createdAt,
            },
            {
              localOrgId: org,
              originSiteId: source,
              kind: "environment-lock",
              digest: lockDigest,
              createdAt: approval.createdAt,
            },
          ],
          hasMore: false,
        },
      };
    if (path === `/federation/commercial-agreements/${revision}`) return { data: approval };
    if (path.startsWith(`${base}?`)) return { data: { enabled, records: rows } };
    if (path.startsWith(`${base}/`)) {
      const row = rows.find((row) => row.reservationId === path.slice(base.length + 1));
      if (row) return { data: row };
      throw new ApiError(409, "ASSET_UNAVAILABLE", "missing");
    }
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (_path, body) => {
    const request = (body as { request: MarketRequest }).request;
    const row = record(request);
    rows.push(row);
    return { data: row };
  });
});
async function review() {
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Create market request" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Create market request" }));
  await waitFor(() =>
    expect(screen.getByRole("option", { name: new RegExp(policy.id) })).toBeTruthy(),
  );
  fireEvent.change(screen.getByLabelText("Automation policy", { exact: true }), {
    target: { value: policy.id },
  });
  const data = fields();
  for (const [label, name] of [
    ["Title", "title"],
    ["Target platform", "platform"],
    ["Architecture", "architecture"],
    ["Admission deadline (within 1 hour, local time)", "expiresAt"],
    ["Input snapshot", "inputs"],
    ["Environment lock", "environment-lock"],
    ["Maximum charge · credit.micro", "maxAmount"],
  ]) {
    if (!label || !name) throw new Error("Missing field fixture");
    const control = screen.getByLabelText(label, { exact: true });
    const value =
      name === "expiresAt"
        ? new Date(Date.now() + 600000 - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)
        : String(data.get(name));
    fireEvent.change(control, { target: { value } });
  }
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Review request" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review request" }));
  return screen.findByRole("dialog");
}
async function confirm() {
  const dialog = await review();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
}
test("builds one bound intent and preserves large integer amounts without leaking private fields to demand", () => {
  const result = buildMarketRequest(approval, policy, fields());
  expect(result.proposal.reservationId).toBe(result.proposal.request.operationId);
  expect(result.proposal.claimVersion).toBe(2);
  expect(result.proposal.request.maxAmount).toBe("9007199254740993");
  expect(result.demand.resources).toEqual(result.proposal.request.resources);
  expect(Object.keys(result.demand)).not.toContain("maxAmount");
  expect(JSON.stringify(result.demand)).not.toContain("Agreed rates");
});
test("rejects foreign, expired, revoked, exhausted and over-budget authorization and deadlines", () => {
  for (const change of [
    { localOrgId: uuid(90) },
    { allowMarketPublish: false },
    { revokedAt: approval.createdAt },
    { authorizedTasks: 10 },
    { marketAuthorizedTasks: 10 },
    { validUntil: approval.createdAt },
    { maxTaskAmount: "1" },
    { marketAuthorizedAmount: "9007199254740999" },
  ])
    expect(() => buildMarketRequest(approval, { ...policy, ...change }, fields())).toThrow();
  const data = fields();
  data.set("expiresAt", new Date(Date.now() + 7200000).toISOString());
  expect(() => buildMarketRequest(approval, policy, data)).toThrow();
  expect(policyUsable({ ...policy, agreementDigest: lockDigest }, approval)).toBe(false);
});
test("review requires confirmation and submits only the private request endpoint with original scope", async () => {
  mount();
  const dialog = await review();
  expect(api.post).not.toHaveBeenCalled();
  expect(within(dialog).getByText("9007199254740993 credit.micro")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.post).mock.calls[0]?.[0]).toBe(base);
  expect(vi.mocked(api.post).mock.calls[0]?.[2]).toEqual(scope);
  await screen.findByText("BWA example");
  expect(screen.getByText(/Completion confirms market handoff/)).toBeTruthy();
});
test("lost acceptance recovers original record without a second POST", async () => {
  vi.mocked(api.post).mockImplementationOnce(async (_path, body) => {
    rows.push(record((body as { request: MarketRequest }).request));
    throw new Error("lost reply");
  });
  mount();
  await confirm();
  await screen.findAllByText(/Submission outcome unknown/);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Retry original request" }),
  );
  await screen.findByText("BWA example");
  expect(api.post).toHaveBeenCalledTimes(1);
});
test("missing durable acceptance resends exactly the same ID, salt and private body", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("lost before commit"));
  mount();
  await confirm();
  await screen.findAllByText(/Submission outcome unknown/);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Retry original request" }),
  );
  await screen.findByText("BWA example");
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
});
test("unrelated conflicts never authorize resending an uncertain request", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("lost"));
  const original = vi.mocked(api.get).getMockImplementation();
  vi.mocked(api.get).mockImplementation(async (path, requestScope) => {
    if (path.startsWith(`${base}/`)) throw new ApiError(409, "OPERATION_CONFLICT", "conflict");
    if (!original) throw new Error("Missing fixture");
    return original(path, requestScope);
  });
  mount();
  await confirm();
  await screen.findAllByText(/Submission outcome unknown/);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Retry original request" }),
  );
  await waitFor(() =>
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith(`${base}/`))).toBe(true),
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});
test("read-only and missing submit authority preserve browsing without create controls", async () => {
  const result = mount({ readOnly: true });
  await screen.findByText("No market requests.");
  expect(screen.queryByRole("button", { name: "Create market request" })).toBeNull();
  result.unmount();
  mount({ grants: ["agreement.read"] });
  await screen.findByText("No market requests.");
  expect(screen.queryByRole("button", { name: "Create market request" })).toBeNull();
});
test("disabled channel keeps history readable and hides creation", async () => {
  enabled = false;
  rows = [record(buildMarketRequest(approval, policy, fields()))];
  mount();
  await screen.findByText(/market request channel is disabled/);
  expect(screen.queryByRole("button", { name: "Create market request" })).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: new RegExp(rows[0]?.reservationId ?? "missing") }),
  );
  await screen.findByText("BWA example");
});
test("lost retry reply observes pending record and never repeats the recovery POST", async () => {
  const row = { ...record(buildMarketRequest(approval, policy, fields())), state: "needs_review" };
  rows = [row];
  vi.mocked(api.post).mockImplementationOnce(async () => {
    row.state = "pending";
    throw new Error("lost retry reply");
  });
  mount();
  await screen.findByRole("button", { name: new RegExp(row.reservationId) });
  fireEvent.click(screen.getByRole("button", { name: new RegExp(row.reservationId) }));
  fireEvent.click(await screen.findByRole("button", { name: "Retry original request" }));
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm submission" }),
  );
  await screen.findAllByText(/Submission outcome unknown/);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Retry original request" }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("permission loss during contract preflight prevents the private POST", async () => {
  const original = vi.mocked(api.get).getMockImplementation();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checking = false;
  vi.mocked(api.get).mockImplementation(async (path, requestScope) => {
    if (path === `/federation/commercial-agreements/${revision}`) {
      checking = true;
      await gate;
    }
    if (!original) throw new Error("Missing fixture");
    return original(path, requestScope);
  });
  const view = mount();
  await confirm();
  await waitFor(() => expect(checking).toBe(true));
  view.update({ readOnly: true });
  if (!release) throw new Error("Missing preflight release");
  release();
  await screen.findByText(/request could not be submitted/);
  expect(api.post).not.toHaveBeenCalled();
});

test("foreign policies fail closed and cannot prepare a request", async () => {
  options = [{ ...policy, localOrgId: uuid(90) }];
  mount();
  await screen.findByText("No market requests.");
  fireEvent.click(screen.getByRole("button", { name: "Create market request" }));
  await screen.findByText(/Could not load prepared resources/);
  expect(
    (screen.getByRole("button", { name: "Review request" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

test("a wrong original private body blocks recovery instead of accepting another intent", async () => {
  vi.mocked(api.post).mockImplementationOnce(async (_path, body) => {
    const row = record((body as { request: MarketRequest }).request);
    row.request = {
      ...row.request,
      demand: { ...row.request.demand, title: "Changed public intent" },
    };
    rows.push(row);
    throw new Error("lost");
  });
  mount();
  await confirm();
  await screen.findAllByText(/Submission outcome unknown/);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Retry original request" }),
  );
  await waitFor(() =>
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith(`${base}/`))).toBe(true),
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("definitive policy rejection allows abandoning the rejected intent", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new ApiError(403, "POLICY_DENIED", "revoked"));
  mount();
  await confirm();
  await screen.findAllByText(/request could not be submitted/);
  expect(screen.queryByText(/Submission outcome unknown/)).toBeNull();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("button", { name: "Review original request" })).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(1);
});

test.each([
  "lookup",
  "resubmit",
])("a denied %s preserves an already uncertain submission", async (phase) => {
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error("lost original response"))
    .mockRejectedValueOnce(new ApiError(403, "POLICY_DENIED", "resubmit denied"));
  const original = vi.mocked(api.get).getMockImplementation();
  vi.mocked(api.get).mockImplementation(async (path, requestScope) => {
    if (path.startsWith(`${base}/`))
      throw new ApiError(
        phase === "lookup" ? 403 : 409,
        phase === "lookup" ? "POLICY_DENIED" : "ASSET_UNAVAILABLE",
        "recovery read",
      );
    if (!original) throw new Error("Missing fixture");
    return original(path, requestScope);
  });
  mount();
  await confirm();
  await screen.findAllByText(/Submission outcome unknown/);
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Retry original request" }),
  );
  await waitFor(() =>
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith(`${base}/`))).toBe(true),
  );
  await waitFor(() =>
    expect(
      (
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Retry original request",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
  expect(screen.getByText(/Submission outcome unknown/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(api.post).toHaveBeenCalledTimes(phase === "lookup" ? 1 : 2);
});
