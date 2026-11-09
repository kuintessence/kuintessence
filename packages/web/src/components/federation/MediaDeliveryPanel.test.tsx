import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { MediaDeliveryPanel } from "./MediaDeliveryPanel";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const org = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  site = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  peer = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  user = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  authId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const scope = { organizationId: org, authRevision: "login-1" },
  date = "2026-01-01T00:00:00Z",
  expiry = "2099-01-01T00:00:00Z",
  digest = `sha256:${"a".repeat(64)}`;
const subject = {
  kind: "task-input",
  operationId: user,
  taskId: id,
  attempt: 1,
  requestDigest: digest,
  contentDigest: digest,
};
const manifest = {
  protocolVersion: 1,
  kind: "media-manifest",
  packageId: id,
  senderSiteId: site,
  recipientSiteId: peer,
  agreementRevisionId: user,
  createdAt: date,
  subject,
  files: [
    {
      path: "input.dat",
      sizeBytes: 4,
      sha256: "a".repeat(64),
      license: "CC-BY-4.0",
      provenance: { source: "Institution A" },
    },
  ],
};
const outgoing = {
  packageId: id,
  recipientSiteId: peer,
  agreementRevisionId: user,
  versionId: null,
  locationId: null,
  taskSelection: { kind: "task-input", operationId: user, agentId: "agent-one" },
  manifestDigest: digest,
  approvedAt: date,
  approvedBy: user,
  expiresAt: expiry,
  revokedAt: null,
  revocationReason: null,
};
const incoming = {
  packageId: id,
  senderSiteId: peer,
  recipientSiteId: site,
  agreementRevisionId: user,
  manifestDigest: digest,
  subject,
  fileCount: 1,
  sizeBytes: 4,
  registeredAt: date,
  registeredBy: user,
  revokedAt: null,
  revocationReason: null,
};
const approval = {
  authorizationId: authId,
  packageId: id,
  localSiteId: site,
  agentId: "agent-one",
  managedRootId: user,
  maxBytes: 4,
  expiresAt: expiry,
  approvedAt: date,
  approvedBy: user,
  revokedAt: null,
  revocationReason: null,
};
const exportedOperation = {
  localSiteId: site,
  packageId: id,
  generation: user,
  requestedBy: user,
  state: "queued",
  sha256: null,
  sizeBytes: null,
  updatedAt: date,
};
const importedOperation = {
  authorizationId: authId,
  generation: user,
  requestedBy: user,
  state: "verified",
  verifiedBytes: 4,
  verifiedAt: date,
  updatedAt: date,
};
let grants: string[],
  failList: boolean,
  foreignOptions: boolean,
  failDetail: boolean,
  receivedOperation: object | null,
  expiresAt: string,
  moreOptions: boolean;
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = (nextScope = scope) => (
    <QueryClientProvider client={client}>
      <MediaDeliveryPanel scope={nextScope} switching={false} />
    </QueryClientProvider>
  );
  return { client, view, ...render(view()) };
}
async function clickReady(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
}
async function incomingTab() {
  const tab = await screen.findByRole("tab", { name: "Incoming" });
  fireEvent.mouseDown(tab);
  fireEvent.click(tab);
}
async function openPackage() {
  fireEvent.click(await screen.findByText(id));
  await screen.findByText("File manifest");
}
function form() {
  return screen.getByRole("button", { name: "Cancel" }).closest("form") as HTMLFormElement;
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  grants = ["asset.read", "asset.map", "media.export", "media.import"];
  failList = false;
  foreignOptions = false;
  failDetail = false;
  receivedOperation = null;
  expiresAt = expiry;
  moreOptions = false;
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith("/capabilities"))
      return { data: { orgId: org, userId: user, grants, effectiveCapabilities: grants } };
    if (path.includes("/options?")) {
      const params = new URLSearchParams(path.split("?")[1]),
        kind = params.get("kind");
      return {
        localSiteId: site,
        localOrgId: foreignOptions ? peer : org,
        kind,
        agentId: params.get("agentId"),
        hasMore: moreOptions,
        data:
          kind === "agents"
            ? [{ agentId: "agent-one", name: "Research Agent", status: "online" }]
            : kind === "roots"
              ? [{ id: user, label: "Research inbox" }]
              : [
                  {
                    revisionId: user,
                    peerSiteId: peer,
                    peerName: "Institution B",
                    validFrom: date,
                    validUntil: expiry,
                    resultAvailableUntil: null,
                  },
                ],
      };
    }
    if (path.includes("/operation"))
      return { data: path.includes("/exports/") ? null : receivedOperation };
    if (path.includes("/receipt")) return { data: [] };
    if (path.includes(`/exports/${id}`)) {
      if (failDetail) throw new Error("read revoked");
      return { data: { ...outgoing, expiresAt, manifest, signedManifest: "signature" } };
    }
    if (path.includes(`/packages/${id}`))
      return {
        data: {
          ...incoming,
          manifest: { ...manifest, senderSiteId: peer, recipientSiteId: site },
          signedManifest: "signature",
          authorizations: [approval],
          hasMoreAuthorizations: false,
        },
      };
    if (failList) throw new Error("read revoked");
    return { data: [path.includes("/exports?") ? { ...outgoing, expiresAt } : incoming] };
  });
});

test("delivery read access is independent from logistics and write capabilities", async () => {
  grants = ["asset.read"];
  mount();
  await screen.findByText(id);
  expect(screen.queryByRole("button", { name: "Approve export" })).toBeNull();
  await openPackage();
  expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes("logistics"))).toBe(false);
});
test("foreign option scope never opens the delivery inventory", async () => {
  foreignOptions = true;
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByText(id)).toBeNull();
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path.includes("/exports?"))).toBe(false);
});
test("refresh failure removes stale records and disables creation", async () => {
  const { client } = mount();
  await screen.findByText(id);
  failList = true;
  await client.invalidateQueries({ queryKey: ["federation", "media"] });
  await screen.findByRole("alert");
  expect(screen.queryByText(id)).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Approve export" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
test("export selects agreement and Agent, and preserves original intent after unknown write", async () => {
  mount();
  await clickReady("Approve export");
  await screen.findByRole("option", { name: /Institution B/ });
  fireEvent.change(screen.getByLabelText("Cooperation agreement"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Execution Agent"), { target: { value: "agent-one" } });
  fireEvent.change(screen.getByLabelText("Delegation ID"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Expires at"), { target: { value: "2099-01-01T12:00" } });
  vi.mocked(api.post).mockRejectedValue(new Error("lost response"));
  fireEvent.submit(form());
  await screen.findByRole("button", { name: "Retry original request" });
  const first = vi.mocked(api.post).mock.calls[0];
  expect(first?.[1]).toMatchObject({
    agreementRevisionId: user,
    recipientSiteId: peer,
    agentId: "agent-one",
    kind: "task-input",
    operationId: user,
  });
  expect(first?.[2]).toEqual({ ...scope, localSiteId: site });
  expect(form().querySelector("fieldset")?.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[1]).toEqual(first);
});
test("import approval selects the directory of its Agent and does not run implicitly", async () => {
  mount();
  await incomingTab();
  await openPackage();
  fireEvent.click(screen.getByRole("button", { name: "Approve receipt" }));
  await screen.findByRole("option", { name: /Research Agent/ });
  fireEvent.change(screen.getByLabelText("Execution Agent"), { target: { value: "agent-one" } });
  await screen.findByRole("option", { name: "Research inbox" });
  fireEvent.change(screen.getByLabelText("Managed directory"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Expires at"), { target: { value: "2099-01-01T12:00" } });
  vi.mocked(api.post).mockImplementation(async (_path, body) => ({
    data: { ...approval, ...(body as object) },
  }));
  fireEvent.submit(form());
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
  expect(vi.mocked(api.post).mock.calls[0]?.[0]).toBe(
    `/federation/media/packages/${id}/import-authorizations`,
  );
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toMatchObject({
    agentId: "agent-one",
    managedRootId: user,
    maxBytes: 4,
  });
});
test("verified private import is distinct from published or completed job and cannot rerun", async () => {
  receivedOperation = importedOperation;
  mount();
  await incomingTab();
  await openPackage();
  fireEvent.click(screen.getByText(authId));
  await screen.findByText(/Files are verified in private quarantine/);
  expect((screen.getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(true);
});
test("expired export disables run while retaining history and revocation", async () => {
  expiresAt = date;
  mount();
  await openPackage();
  const button = await screen.findByRole("button", { name: "Run" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Revoke" }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});
test("run validates response identity and preserves an unconfirmed action", async () => {
  mount();
  await openPackage();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  vi.mocked(api.post).mockResolvedValue({ data: { ...exportedOperation, packageId: user } });
  fireEvent.submit(form());
  await screen.findByRole("button", { name: "Retry original request" });
  expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
  expect(api.post).toHaveBeenCalledTimes(1);
});
test("permission changes disable a preserved mutation, including explicit retries", async () => {
  const { client } = mount();
  await openPackage();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  vi.mocked(api.post).mockRejectedValue(new Error("lost response"));
  fireEvent.submit(form());
  await screen.findByRole("button", { name: "Retry original request" });
  grants = ["asset.read"];
  await client.invalidateQueries({ queryKey: ["federation", "current-capabilities"] });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Retry original request" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  expect(api.post).toHaveBeenCalledTimes(1);
});
test("detail refresh failure preserves original request but hides stale resource details", async () => {
  const { client } = mount();
  await openPackage();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  vi.mocked(api.post).mockRejectedValue(new Error("lost response"));
  fireEvent.submit(form());
  await screen.findByRole("button", { name: "Retry original request" });
  failDetail = true;
  await client.invalidateQueries({ queryKey: ["federation", "media"] });
  await waitFor(() => expect(screen.queryByText("File manifest")).toBeNull());
  expect(
    (screen.getByRole("button", { name: "Retry original request" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  failDetail = false;
  await client.invalidateQueries({ queryKey: ["federation", "media"] });
  await screen.findByText("File manifest");
  fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
});
test("authentication scope change discards previous package selection and drafts", async () => {
  const view = mount();
  await openPackage();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  view.rerender(view.view({ ...scope, authRevision: "login-2" }));
  await screen.findByRole("button", { name: "Approve export" });
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("registration validates signed file and requires explicit confirmation", async () => {
  mount();
  await incomingTab();
  await clickReady("Register received package");
  const file = new File(
    [JSON.stringify({ senderSiteId: peer, signedManifest: "signature" })],
    "manifest.json",
    { type: "application/json" },
  );
  fireEvent.change(screen.getByLabelText("Signed manifest file"), { target: { files: [file] } });
  await waitFor(() =>
    expect(
      (
        within(form()).getByRole("button", {
          name: "Register received package",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  expect(api.post).not.toHaveBeenCalled();
  vi.mocked(api.post).mockResolvedValue({ data: incoming });
  fireEvent.submit(form());
  await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toEqual({
    senderSiteId: peer,
    signedManifest: "signature",
  });
});
test("option pagination is scoped and bounded", async () => {
  moreOptions = true;
  mount();
  await clickReady("Approve export");
  await screen.findByRole("option", { name: /Institution B/ });
  const picker = screen.getByLabelText("Cooperation agreement").parentElement;
  if (!picker) throw new Error("Missing agreement picker");
  fireEvent.click(within(picker).getByRole("button", { name: "Next" }));
  await waitFor(() =>
    expect(
      vi
        .mocked(api.get)
        .mock.calls.some(
          ([path, requestScope]) =>
            path.includes("kind=agreements&limit=20&offset=20") &&
            requestScope?.organizationId === org,
        ),
    ).toBe(true),
  );
});

test("revoking an approval names its scope and submits only the approval path", async () => {
  mount();
  await incomingTab();
  await openPackage();
  fireEvent.click(screen.getByText(authId));
  fireEvent.click(await screen.findByRole("button", { name: "Revoke approval" }));
  expect(within(form()).getByText(authId)).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Revocation reason"), {
    target: { value: "Recipient consent withdrawn" },
  });
  vi.mocked(api.post).mockResolvedValue({ success: true });
  fireEvent.submit(form());
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(vi.mocked(api.post).mock.calls[0]?.slice(0, 2)).toEqual([
    `/federation/media/packages/${id}/import-authorizations/${authId}/revoke`,
    { reason: "Recipient consent withdrawn" },
  ]);
});
test("registration rejects malformed and oversized files before contacting the server", async () => {
  mount();
  await incomingTab();
  await clickReady("Register received package");
  for (const file of [
    new File(["{}"], "empty.json"),
    new File(["a".repeat(530_001)], "oversized.json"),
  ]) {
    fireEvent.change(screen.getByLabelText("Signed manifest file"), { target: { files: [file] } });
    await screen.findByRole("alert");
    expect(
      (
        within(form()).getByRole("button", {
          name: "Register received package",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  }
  expect(api.post).not.toHaveBeenCalled();
});
test("registration does not accept a response for a different signed manifest", async () => {
  mount();
  await incomingTab();
  await clickReady("Register received package");
  const file = new File(
    [JSON.stringify({ senderSiteId: peer, signedManifest: "different-signature" })],
    "manifest.json",
  );
  fireEvent.change(screen.getByLabelText("Signed manifest file"), { target: { files: [file] } });
  await waitFor(() =>
    expect(
      (
        within(form()).getByRole("button", {
          name: "Register received package",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  );
  vi.mocked(api.post).mockResolvedValue({ data: incoming });
  fireEvent.submit(form());
  await screen.findByRole("button", { name: "Retry original request" });
  expect(screen.getByRole("alert").textContent).toContain("unconfirmed");
});
test("receipt view rejects mismatched generations without offering receipt retries", async () => {
  const get = vi.mocked(api.get).getMockImplementation();
  if (!get) throw new Error("Missing API fixture");
  const receipt = {
    protocolVersion: 1,
    kind: "media-import-receipt",
    receiptId: authId,
    generation: id,
    senderSiteId: site,
    recipientSiteId: peer,
    packageId: id,
    agreementRevisionId: user,
    manifestDigest: digest,
    keyQueryId: user,
    keyQueryDigest: digest,
    state: "verified-private",
    fileCount: 1,
    sizeBytes: 4,
    receivedAt: date,
  };
  vi.mocked(api.get).mockImplementation(async (...args) =>
    args[0].endsWith("/receipt")
      ? {
          data: {
            state: "pending",
            receipt,
            signedReceipt: "signed",
            acknowledgement: null,
            signedAcknowledgement: null,
            lastError: null,
            nextAttemptAt: date,
          },
        }
      : get(...args),
  );
  receivedOperation = importedOperation;
  mount();
  await incomingTab();
  await openPackage();
  fireEvent.click(screen.getByText(authId));
  const summary = await screen.findByText("Signed receipts");
  const details = summary.closest("details");
  if (!details) throw new Error("Missing receipts");
  details.open = true;
  fireEvent(details, new Event("toggle"));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Resend receipt" })).toBeNull();
});

test("a run confirmation is disabled if its export expires during refresh", async () => {
  const { client } = mount();
  await openPackage();
  fireEvent.click(await screen.findByRole("button", { name: "Run" }));
  expiresAt = date;
  await client.invalidateQueries({ queryKey: ["federation", "media"] });
  await waitFor(() =>
    expect(
      (within(form()).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled,
    ).toBe(true),
  );
  fireEvent.submit(form());
  expect(api.post).not.toHaveBeenCalled();
});

test("failed option refresh blocks stale selections and can recover without losing the intent", async () => {
  const get = vi.mocked(api.get).getMockImplementation();
  if (!get) throw new Error("Missing API fixture");
  let failed = false;
  vi.mocked(api.get).mockImplementation(async (...args) => {
    if (failed && args[0].includes("kind=agreements")) throw new Error("option read failed");
    return get(...args);
  });
  const { client } = mount();
  await clickReady("Approve export");
  await screen.findByRole("option", { name: /Institution B/ });
  fireEvent.change(screen.getByLabelText("Cooperation agreement"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Execution Agent"), { target: { value: "agent-one" } });
  fireEvent.change(screen.getByLabelText("Delegation ID"), { target: { value: user } });
  fireEvent.change(screen.getByLabelText("Expires at"), { target: { value: "2099-01-01T12:00" } });
  vi.mocked(api.post).mockRejectedValue(new Error("lost response"));
  fireEvent.submit(form());
  await screen.findByRole("button", { name: "Retry original request" });
  failed = true;
  await client.invalidateQueries({
    queryKey: ["federation", "media", org, "login-1", "options", "agreements"],
  });
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Retry original request" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true),
  );
  expect(screen.queryByRole("option", { name: /Institution B/ })).toBeNull();
  failed = false;
  const refresh = within(form())
    .getAllByRole("button", { name: "Refresh" })
    .find((button) => !button.closest("fieldset") && !(button as HTMLButtonElement).disabled);
  if (!refresh) throw new Error("No enabled refresh for preserved request");
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Retry original request" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry original request" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.post).mock.calls[0]).toEqual(vi.mocked(api.post).mock.calls[1]);
});
