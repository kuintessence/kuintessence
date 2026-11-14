import { CommercialAgreementApprovalSchema } from "@kuintessence/shared/federation/commercial";
import {
  MarketDemandStateSchema,
  type MarketProposalInput,
} from "@kuintessence/shared/federation/market";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { ApiError, api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { setMobileManagementPolicy } from "../../lib/mobile-management-policy";
import { materialDigest } from "./asset-material";
import { FederationMarketPanel } from "./FederationMarketPanel";
import { marketIdentity } from "./market-view";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = uuid(1),
  source = uuid(2),
  provider = uuid(3),
  user = uuid(4),
  revision = uuid(5);
const scope = { organizationId: org, authRevision: "login-1" };
const now = "2026-01-01T00:00:00.000Z",
  expiry = "2099-01-01T00:00:00.000Z";
let site: string, grants: string[], enabled: boolean, loseResponse: boolean, failDirectory: boolean;
let demand: ReturnType<typeof MarketDemandStateSchema.parse>;
let records: Map<string, Awaited<ReturnType<typeof record>>>;
let approval: ReturnType<typeof CommercialAgreementApprovalSchema.parse>;
let inboundRequests: {
  reservationId: string;
  demandId: string;
  agreementRevisionId: string;
  direction: string;
  state: string;
}[];

async function record(input: MarketProposalInput, state = "pending") {
  return {
    ...marketIdentity(input),
    input,
    state,
    digest: await materialDigest(input),
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <FederationMarketPanel scope={scope} switching={false} />
    </QueryClientProvider>,
  );
  return { client, ...view };
}
function clickTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0, ctrlKey: false });
}
async function fillDemand() {
  fireEvent.click(await screen.findByRole("button", { name: "Publish demand" }));
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Sequence alignment" } });
  fireEvent.change(screen.getByLabelText("Target platform"), { target: { value: "linux" } });
  fireEvent.change(screen.getByLabelText("Architecture"), { target: { value: "x86_64" } });
  fireEvent.change(screen.getByLabelText("Expires"), { target: { value: "2099-01-01T00:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Review request" }));
  return screen.findByRole("dialog");
}
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  sessionStorage.clear();
  await i18n.changeLanguage("en");
  site = source;
  grants = ["market.read", "market.publish", "market.claim", "agreement.read"];
  enabled = true;
  loseResponse = false;
  failDirectory = false;
  records = new Map();
  const publicDemand = {
    protocolVersion: 1,
    demandId: uuid(6),
    sourceSiteId: source,
    title: "Public BWA demand",
    description: "Small input",
    createdAt: now,
    expiresAt: expiry,
    platform: "linux",
    architecture: "x86_64",
    resources: { cpus: 1, memoryMb: 128, gpus: 0, wallTimeSec: 60 },
  };
  demand = MarketDemandStateSchema.parse({
    demand: publicDemand,
    digest: await materialDigest(publicDemand),
    version: 1,
    status: "OPEN",
    claim: null,
    cancellation: null,
  });
  inboundRequests = [
    {
      reservationId: uuid(9),
      demandId: demand.demand.demandId,
      agreementRevisionId: revision,
      direction: "inbound",
      state: "pending",
    },
  ];
  const hash = `sha256:${"a".repeat(64)}`;
  approval = CommercialAgreementApprovalSchema.parse({
    localSiteId: provider,
    localOrgId: org,
    revisionId: revision,
    digest: hash,
    approvalJws: "local.signature",
    counterpartyJws: "peer.signature",
    approvedBy: user,
    createdAt: now,
    terms: {
      protocolVersion: 1,
      kind: "commercial-agreement",
      domainId: uuid(7),
      salt: "b".repeat(64),
      createdAt: now,
      consideration: "paid",
      priceVersionId: uuid(8),
      termsText: "Private terms",
      prices: [
        {
          metric: "job.elapsed",
          quantityUnit: "job-millisecond",
          perQuantity: "1000",
          amount: "1",
        },
      ],
      agreement: {
        protocolVersion: 1,
        kind: "agreement",
        agreementRevisionId: revision,
        sourceSiteId: source,
        targetSiteId: provider,
        mode: "ledger_coordinated",
        budgetDomainId: org,
        epoch: user,
        unit: "credit.micro",
        budgetLimit: "100",
        maxTaskAmount: "10",
        maxReservations: 2,
        validFrom: now,
        validUntil: expiry,
        templates: [
          { originSiteId: source, kind: "script", id: user, revision: "1", digest: hash },
        ],
        resourceLimit: publicDemand.resources,
        termsDigest: hash,
      },
    },
  });
  approval.digest = await materialDigest(approval.terms);
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/federation/capabilities")
      return { data: { orgId: org, userId: user, grants, effectiveCapabilities: grants } };
    if (path.endsWith("/market/context")) return { data: { localSiteId: site, enabled } };
    if (path.includes("/market/demands?")) {
      if (failDirectory) throw new ApiError(503, "LEDGER_UNAVAILABLE", "offline");
      return {
        data: {
          operation: "list-demands",
          demands: [demand],
          bookmark: "",
          observedAt: now,
          siteNames: { [source]: "North Research" },
        },
      };
    }
    if (path.includes("/market/demands/"))
      return {
        data: {
          operation: "get-demand",
          demand,
          observedAt: now,
          siteNames: { [source]: "North Research" },
        },
      };
    if (path.includes("/market/operations?"))
      return { data: { enabled, data: [...records.values()], hasMore: false } };
    if (path.includes("/market/operations/")) {
      const row = records.get(path.split("/operations/")[1]?.split("?")[0] ?? "");
      if (!row) throw new ApiError(409, "ASSET_UNAVAILABLE", "missing");
      return { data: { enabled, operation: row, transactions: [], hasMore: false } };
    }
    if (path.includes("/commercial-agreements?"))
      return {
        data: [
          {
            revisionId: revision,
            digest: approval.digest,
            approvedBy: user,
            createdAt: now,
            sourceSiteId: source,
            targetSiteId: provider,
            sourceName: "A",
            targetName: "B",
            mode: "ledger_coordinated",
            consideration: "paid",
            hasCounterpartyApproval: true,
          },
        ],
      };
    if (path.includes(`/commercial-agreements/${revision}/market-requests?`))
      return { data: { enabled: true, records: inboundRequests } };
    if (path.endsWith(`/commercial-agreements/${revision}`)) return { data: approval };
    throw new Error(`Unexpected GET ${path}`);
  });
  vi.mocked(api.post).mockImplementation(async (path, raw) => {
    if (path.endsWith("/retry")) return { success: true };
    const input = raw as MarketProposalInput;
    const row = await record(input);
    records.set(row.id, row);
    if (loseResponse) throw new Error("connection lost after acceptance");
    return {
      data: marketIdentity(input).id
        ? { id: row.id, demandId: row.demandId, state: row.state }
        : null,
    };
  });
});

test("publishing requires independent confirmation and local acceptance never claims execution", async () => {
  grants = ["market.read", "market.publish"];
  mount();
  const dialog = await fillDemand();
  expect(api.post).not.toHaveBeenCalled();
  expect(within(dialog).getByText(/public to alliance members/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
  await screen.findByText("No transaction has been prepared yet.");
  expect(screen.getByText("Accepted locally · awaiting ledger")).toBeTruthy();
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes("/agreements/context"))).toBe(
    false,
  );
});

test("lost responses recover the exact original operation by query without a second write", async () => {
  loseResponse = true;
  mount();
  const dialog = await fillDemand();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
  await within(dialog).findByText(/result is unknown/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Find original operation" }));
  await screen.findByText("No transaction has been prepared yet.");
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/result is unknown/)).toBeNull();
});

test("an unsaved request retries the same original body after the server's 409 ASSET_UNAVAILABLE", async () => {
  vi.mocked(api.post).mockImplementationOnce(async () => {
    throw new Error("connection lost before acceptance");
  });
  mount();
  const dialog = await fillDemand();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
  await within(dialog).findByText(/result is unknown/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry original request" }));
  await screen.findByText("No transaction has been prepared yet.");
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
});

async function prepareClaim() {
  site = provider;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Public BWA demand/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Claim demand" }));
  const select = await screen.findByLabelText("Commercial contract");
  await screen.findByRole("option", { name: `A → B · ${revision}` });
  fireEvent.change(select, { target: { value: revision } });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Review request" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Review request" }));
  return screen.findByRole("dialog");
}
test("claim uses a signed matching contract and discloses no prices or contract body to market", async () => {
  const dialog = await prepareClaim();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
  await screen.findByText("No transaction has been prepared yet.");
  const call = vi.mocked(api.post).mock.calls[0];
  if (!call) throw new Error("Expected claim submission");
  const [path, input] = call;
  expect(path).toBe("/federation/market/operations");
  expect(input).toMatchObject({
    operation: "claim-demand",
    claim: {
      commercialDomainId: approval.terms.domainId,
      claimId: uuid(9),
      providerSiteId: provider,
      expectedVersion: 1,
    },
  });
  expect(JSON.stringify(input)).not.toContain("Private terms");
  expect(JSON.stringify(input)).not.toContain("prices");
});

test("another provider winning before confirmation blocks the stale claim without posting", async () => {
  const dialog = await prepareClaim();
  demand = { ...demand, version: 2, status: "CLAIMED" };
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
  await within(dialog).findByText(/Submission failed/);
  expect(api.post).not.toHaveBeenCalled();
  expect(within(dialog).queryByText(/result is unknown/)).toBeNull();
});

test("revoked publishing permission closes a pending confirmation", async () => {
  const { client } = mount();
  await fillDemand();
  act(() =>
    client.setQueryData(["federation", "current-capabilities", org, "login-1"], {
      orgId: org,
      userId: user,
      grants: ["market.read"],
      effectiveCapabilities: ["market.read"],
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).not.toHaveBeenCalled();
});

test("direct mode never queries the ledger directory and still permits inspecting local history", async () => {
  enabled = false;
  mount();
  await screen.findByText("The ledger market is not enabled on this platform.");
  expect(screen.queryByRole("button", { name: "Publish demand" })).toBeNull();
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes("/market/demands"))).toBe(
    false,
  );
  clickTab("Institution operations");
  await screen.findByText("No operations on this page.");
});

test("ledger outages and corrupt demand digests are failures rather than empty directories", async () => {
  demand = { ...demand, digest: `sha256:${"0".repeat(64)}` };
  mount();
  await screen.findByText(/demand could not be read/);
  expect(screen.queryByText("No demands on this page.")).toBeNull();
  expect(screen.queryByRole("button", { name: /Public BWA demand/ })).toBeNull();
});

test("needs-review operations resume the same ID after independent confirmation", async () => {
  const row = await record({ operation: "publish-demand", demand: demand.demand }, "needs_review");
  records.set(row.id, row);
  mount();
  await screen.findByRole("tab", { name: "Institution operations" });
  clickTab("Institution operations");
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(row.id) }));
  fireEvent.click(await screen.findByRole("button", { name: "Resume original transaction" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm submission" }),
  );
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/market/operations/${row.id}/retry`,
      {},
      scope,
    ),
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("a lost retry reply recovers the now-pending original transaction without another POST", async () => {
  const row = await record({ operation: "publish-demand", demand: demand.demand }, "needs_review");
  records.set(row.id, row);
  vi.mocked(api.post).mockImplementation(async () => {
    records.set(row.id, { ...row, state: "pending" });
    throw new Error("retry accepted but response lost");
  });
  mount();
  await screen.findByRole("tab", { name: "Institution operations" });
  clickTab("Institution operations");
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(row.id) }));
  fireEvent.click(await screen.findByRole("button", { name: "Resume original transaction" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm submission" }));
  await within(dialog).findByText(/result is unknown/);
  fireEvent.click(within(dialog).getByRole("button", { name: "Retry original request" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await screen.findByText("Accepted locally · awaiting ledger");
  expect(api.post).toHaveBeenCalledTimes(1);
});

test("phone management restrictions preserve market reading and prevent writes", async () => {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as MediaQueryList);
  setMobileManagementPolicy(true);
  mount();
  await screen.findByRole("button", { name: /Public BWA demand/ });
  expect(screen.queryByRole("button", { name: "Publish demand" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("missing private requests cannot create arbitrary market claims", async () => {
  inboundRequests = [];
  site = provider;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Public BWA demand/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Claim demand" }));
  const select = await screen.findByLabelText("Commercial contract");
  await screen.findByRole("option", { name: `A → B · ${revision}` });
  fireEvent.change(select, { target: { value: revision } });
  await screen.findByText(/Waiting for the original private request/);
  expect(
    (screen.getByRole("button", { name: "Review request" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

test("an expired open demand can still be cancelled using its exact current version", async () => {
  demand.demand.expiresAt = "2026-02-01T00:00:00.000Z";
  demand.digest = await materialDigest(demand.demand);
  const published = await record(
    { operation: "publish-demand", demand: demand.demand },
    "committed",
  );
  records.set(published.id, published);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Public BWA demand/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel open demand" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm submission" }),
  );
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({
    operation: "cancel-open-demand",
    cancellation: { demandId: demand.demand.demandId, expectedVersion: 1 },
  });
});

test("market details pair the source name with its full ID and keep the signed demand unchanged", async () => {
  const before = JSON.stringify(demand);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Public BWA demand/ }));
  await screen.findByText("North Research");
  expect(screen.getByText(source)).toBeTruthy();
  expect(JSON.stringify(demand)).toBe(before);
  expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
});
