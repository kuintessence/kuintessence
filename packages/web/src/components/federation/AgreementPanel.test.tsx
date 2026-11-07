import type {
  FederationAgreement,
  FederationAgreementApproval,
} from "@kuintessence/shared/federation";
import type { AgreementApprovalExchangeViewSchema } from "@kuintessence/shared/federation/agreement-exchange";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import type { z } from "zod";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { AgreementPanel } from "./AgreementPanel";

vi.mock("../../lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const device = vi.hoisted(() => ({ readOnly: false }));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({
  useMobileMutationBlocked: () => device.readOnly,
}));
const source = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const target = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const orgId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const userId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const revisionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const scope = { organizationId: orgId, authRevision: "login-1" };
const terms: FederationAgreement = {
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
};
const approval: FederationAgreementApproval = {
  localSiteId: source,
  revisionId,
  localOrgId: orgId,
  executionUserId: null,
  terms,
  termsDigest: `sha256:${"c".repeat(64)}`,
  approvalJws: "local.signed.terms",
  counterpartyApprovalJws: null,
  approvedBy: userId,
  state: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};
let localSiteId: string;
let grants: string[];
let rows: FederationAgreementApproval[];
const pendingExchange = {
  state: "pending" as const,
  lastError: null,
  nextAttemptAt: "2026-11-08T12:00:00.000Z",
  verifiedAt: null,
};
let exchange: z.infer<typeof AgreementApprovalExchangeViewSchema>;
let exchangeError: Error | null;
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
        <AgreementPanel scope={scope} switching={switching} />
      </QueryClientProvider>,
    ),
  };
}
async function importTerms(input: unknown = terms) {
  const button = await screen.findByRole("button", { name: "Import agreement terms" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  fireEvent.change(screen.getByLabelText("Terms JSON"), {
    target: { value: JSON.stringify(input) },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
}
async function openDetail() {
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`${source}.*${target}`) }));
  await screen.findByRole("heading", { name: "Our signature" });
}
beforeEach(async () => {
  vi.resetAllMocks();
  device.readOnly = false;
  localSiteId = source;
  grants = ["agreement.read", "agreement.approve"];
  rows = [];
  exchange = {
    enabled: true,
    sync: {
      state: "pending",
      lastError: null,
      nextAttemptAt: "2026-11-08T12:00:00.000Z",
      verifiedAt: null,
    },
  };
  exchangeError = null;
  await i18n.changeLanguage("en");
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path === "/federation/capabilities")
      return { data: { orgId, userId, grants, effectiveCapabilities: grants } };
    if (path.endsWith("/context"))
      return { data: { localSiteId, supportedModes: ["bilateral_direct", "bilateral_attested"] } };
    if (path.includes("execution-accounts"))
      return {
        data: [{ userId, email: "runner@example.test", displayName: "Restricted runner" }],
        hasMore: false,
      };
    if (path.includes("?limit=")) return { data: rows };
    if (path.endsWith("/exchange")) {
      if (exchangeError) throw exchangeError;
      return { data: exchange };
    }
    return { data: rows.find((row) => path.endsWith(`/${row.revisionId}`)) ?? approval };
  });
  vi.mocked(api.post).mockResolvedValue({ success: true });
});

test("shows automatic exchange waiting without offering an unnecessary retry", async () => {
  rows = [approval];
  mount();
  await openDetail();
  await screen.findByText("Waiting for signature exchange");
  expect(screen.getByText(/Next automatic attempt/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Retry signature exchange" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("reviews retry of the original signatures and refreshes the current agreement scope", async () => {
  rows = [approval];
  exchange.sync = { ...pendingExchange, state: "needs_review", lastError: "UNTRUSTED_IDENTITY" };
  const { client } = mount();
  await openDetail();
  await screen.findByText(/Check the institution certificate/);
  fireEvent.click(screen.getByRole("button", { name: "Retry signature exchange" }));
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog").textContent).toContain("does not sign new terms");
  exchange.sync = { ...pendingExchange, state: "pending", lastError: null };
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/agreements/${revisionId}/exchange/retry`,
      {},
      scope,
    ),
  );
  await screen.findByText("Waiting for signature exchange");
  expect(
    client.getQueryData([
      "federation",
      "agreements",
      orgId,
      scope.authRevision,
      "exchange",
      revisionId,
    ]),
  ).toEqual(exchange);
});

test.each([
  "read-only",
  "mobile",
  "suspended",
  "disabled",
  "complete",
])("does not offer signature retry when %s", async (mode) => {
  rows = [approval];
  exchange.sync = { ...pendingExchange, state: "needs_review", lastError: "POLICY_DENIED" };
  if (mode === "read-only") grants = ["agreement.read"];
  if (mode === "mobile") device.readOnly = true;
  if (mode === "suspended") rows = [{ ...approval, state: "suspended" }];
  if (mode === "disabled") exchange.enabled = false;
  if (mode === "complete")
    exchange.sync = {
      ...pendingExchange,
      state: "complete",
      lastError: null,
      verifiedAt: "2026-11-08T11:00:00.000Z",
    };
  mount();
  await openDetail();
  await screen.findByRole("heading", { name: "Signature exchange" });
  await waitFor(() =>
    expect(api.get).toHaveBeenCalledWith(`/federation/agreements/${revisionId}/exchange`, scope),
  );
  if (mode === "complete") await screen.findByText("Counterparty signature verified and imported");
  else await screen.findByText("Review required");
  expect(screen.queryByRole("button", { name: "Retry signature exchange" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("keeps historical verification visible when communication is disabled", async () => {
  rows = [approval];
  exchange = {
    enabled: false,
    sync: {
      ...pendingExchange,
      state: "complete",
      lastError: null,
      verifiedAt: "2026-11-08T11:00:00.000Z",
    },
  };
  mount();
  await openDetail();
  await screen.findByText("Counterparty signature verified and imported");
  expect(screen.getByText(/Historical status remains available/)).toBeTruthy();
  expect(screen.getByText(/Verified at/)).toBeTruthy();
  expect(screen.queryByText(/Next automatic attempt/)).toBeNull();
});

test("failed status refresh hides stale retry controls and preserves signed terms", async () => {
  rows = [approval];
  exchange.sync = { ...pendingExchange, state: "needs_review", lastError: "OPERATION_CONFLICT" };
  mount();
  await openDetail();
  await screen.findByRole("button", { name: "Retry signature exchange" });
  exchangeError = new Error("permission revoked");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Could not load. Refresh to try again.");
  expect(screen.queryByRole("button", { name: "Retry signature exchange" })).toBeNull();
  expect(screen.getByLabelText("Our signature")).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});

test("reviews exact integer allowances then signs only after explicit confirmation under the captured organization", async () => {
  mount();
  await importTerms();
  expect(screen.getByText("9,007,199,254,740,993 credit.micro")).toBeTruthy();
  expect(
    screen.getByText("99,999,999,999,999,999,999,999,999,999,999,999,999 credit.micro"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sign agreement" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith("/federation/agreements/approve", { terms }, scope),
  );
  expect(api.get).not.toHaveBeenCalledWith(
    expect.stringContaining("execution-accounts"),
    expect.anything(),
  );
});

test("receiver must choose a named eligible local execution identity", async () => {
  localSiteId = target;
  mount();
  await importTerms();
  expect(
    (screen.getByRole("button", { name: "Sign agreement" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(
    await screen.findByRole("radio", { name: "Restricted runner (runner@example.test)" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Sign agreement" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      "/federation/agreements/approve",
      { terms, executionUserId: userId },
      scope,
    ),
  );
});

test.each([
  [{ ...terms, mode: "ledger_coordinated" }, /Ledger coordination is not available/],
  [{ ...terms, validUntil: "2025-01-02T00:00:00.000Z" }, /has expired/],
  [{ ...terms, sourceSiteId: userId }, /not a party/],
  [{ ...terms, budgetLimit: "1" }, /Task limit exceeds budget/],
])("rejects unsupported, expired, foreign and invalid terms without writing", async (input, message) => {
  mount();
  await importTerms(input);
  expect(screen.getByRole("alert").textContent).toMatch(message);
  const sign = screen.queryByRole("button", { name: "Sign agreement" });
  if (sign) expect((sign as HTMLButtonElement).disabled).toBe(true);
  expect(api.post).not.toHaveBeenCalled();
});

test("retains the exact reviewed request when signing fails", async () => {
  vi.mocked(api.post).mockRejectedValueOnce(new Error("permission revoked"));
  mount();
  await importTerms();
  fireEvent.click(screen.getByRole("button", { name: "Sign agreement" }));
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  expect((await dialog.findByRole("alert")).textContent).toContain("entries are retained");
  fireEvent.click(dialog.getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
});

test.each([
  "read-only",
  "mobile",
])("keeps %s access read-only without hiding signatures", async (mode) => {
  rows = [approval];
  if (mode === "mobile") device.readOnly = true;
  else grants = ["agreement.read"];
  mount();
  await openDetail();
  expect(screen.queryByRole("button", { name: "Import agreement terms" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Permanently revoke" })).toBeNull();
  expect((screen.getByLabelText("Our signature") as HTMLTextAreaElement).value).toBe(
    approval.approvalJws,
  );
});

test("blocks ungranted readers before fetching any agreement data", async () => {
  grants = [];
  mount();
  expect((await screen.findByRole("status")).textContent).toMatch(/Loading|no agreement/);
  await screen.findByText(/no agreement viewing grant/);
  expect(api.get).toHaveBeenCalledTimes(1);
});

test("imports counterparty signature and confirms irreversible revoke separately", async () => {
  rows = [approval];
  mount();
  await openDetail();
  fireEvent.change(screen.getByLabelText("Counterparty signature"), {
    target: { value: " peer.signed.terms " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify and import counterparty signature" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/agreements/${revisionId}/counterparty`,
      { approvalJws: "peer.signed.terms" },
      scope,
    ),
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Permanently revoke" }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Permanently revoke" }));
  expect(screen.getByRole("dialog").textContent).toContain("cannot be undone");
  expect(screen.getByRole("dialog").textContent).toContain("does not confirm remote");
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenLastCalledWith(
      `/federation/agreements/${revisionId}/state`,
      { state: "revoked" },
      scope,
    ),
  );
});

test("organization switching disables signing controls", async () => {
  mount(true);
  await screen.findByText("No cooperation agreements");
  expect(
    (screen.getByRole("button", { name: "Import agreement terms" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test("a slow file read cannot overwrite subsequently pasted terms", async () => {
  mount();
  const button = await screen.findByRole("button", { name: "Import agreement terms" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  const file = new File(["{}"], "terms.json", { type: "application/json" });
  const read = Promise.withResolvers<string>();
  vi.spyOn(file, "text").mockReturnValue(read.promise);
  fireEvent.change(screen.getByLabelText("Terms file"), { target: { files: [file] } });
  const pasted = JSON.stringify(terms);
  fireEvent.change(screen.getByLabelText("Terms JSON"), { target: { value: pasted } });
  read.resolve("stale file content");
  await read.promise;
  expect((screen.getByLabelText("Terms JSON") as HTMLTextAreaElement).value).toBe(pasted);
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
  expect(screen.getByText("9,007,199,254,740,993 credit.micro")).toBeTruthy();
});

test("rejects oversized UTF-8 terms with the size error, without signing", async () => {
  mount();
  await importTerms({ ...terms, extra: "中".repeat(200000) });
  expect(screen.getByRole("alert").textContent).toContain("550 KB");
  expect(api.post).not.toHaveBeenCalled();
});

test("a failed context load leaves refresh usable and blocks signing", async () => {
  const original = vi.mocked(api.get).getMockImplementation();
  let failure = true;
  vi.mocked(api.get).mockImplementation(async (path, scope) => {
    if (path.endsWith("/context") && failure) throw new Error("offline");
    return original?.(path, scope);
  });
  mount();
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("button", { name: "Import agreement terms" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  const refresh = screen.getByRole("button", { name: "Refresh" });
  expect((refresh as HTMLButtonElement).disabled).toBe(false);
  failure = false;
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Import agreement terms" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
});
