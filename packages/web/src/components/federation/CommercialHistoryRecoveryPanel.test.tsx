import type { FederationCapability } from "@kuintessence/shared/federation";
import {
  CommercialHistoryRecoverySchema,
  CommercialHistoryRecoveryViewSchema,
} from "@kuintessence/shared/federation/history-recovery";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialHistoryRecoveryImport } from "./CommercialHistoryRecoveryImport";
import { CommercialHistoryRecoveryPanel } from "./CommercialHistoryRecoveryPanel";
import { approval as coordinatedApproval, scope, uuid } from "./governance-test-fixtures";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
const approval = {
  ...coordinatedApproval,
  terms: {
    ...coordinatedApproval.terms,
    agreement: { ...coordinatedApproval.terms.agreement, mode: "bilateral_attested" as const },
  },
};
const submissionId = uuid(50);
const originalInput = '{"preserved":"signed input fixture"}';
const path = `/federation/commercial-agreements/${approval.revisionId}/submissions/${submissionId}/history-recovery`;
const payload = CommercialHistoryRecoverySchema.parse({
  protocolVersion: 1,
  kind: "commercial-history-recovery",
  recoveryId: uuid(51),
  domainId: approval.terms.domainId,
  agreementRevisionId: approval.revisionId,
  sourceSiteId: approval.terms.agreement.sourceSiteId,
  targetSiteId: approval.terms.agreement.targetSiteId,
  mode: "bilateral_attested",
  assertion: "acknowledge-original-record",
  originalOperation: "record-payment",
  originalRecordId: uuid(52),
  originalDigest: `sha256:${"a".repeat(64)}`,
  originalInputDigest: `sha256:${"b".repeat(64)}`,
  reason: "Both institutions verified the preserved original",
  issuedAt: "2026-01-01T00:00:00Z",
  salt: "c".repeat(64),
});
const view = () =>
  CommercialHistoryRecoveryViewSchema.parse({
    payload,
    digest: `sha256:${"d".repeat(64)}`,
    approvalJws: "current.local.approval",
    originalInput,
    counterpartyApproved: false,
    canReauthorize: false,
    approvalHistoryCount: 0,
    original: {
      id: submissionId,
      operation: payload.originalOperation,
      recordId: payload.originalRecordId,
      digest: payload.originalDigest,
      state: "needs_review",
      archiveOnly: false,
    },
    ledger: null,
  });
let saved: ReturnType<typeof view> | null;
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const element = (readOnly = false, grants: FederationCapability[] = ["attestation.recover"]) => (
    <QueryClientProvider client={client}>
      <CommercialHistoryRecoveryPanel
        approval={approval}
        scope={scope}
        submissionId={submissionId}
        grants={grants}
        readOnly={readOnly}
        busy={false}
        onClose={() => {}}
      />
    </QueryClientProvider>
  );
  return { ...render(element()), element, client };
}
const upload = (value: Record<string, unknown>) =>
  fireEvent.change(screen.getByLabelText("Import counterpart approval"), {
    target: {
      files: [
        new File([JSON.stringify({ originalInput, ...value })], "recovery.json", {
          type: "application/json",
        }),
      ],
    },
  });
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  saved = null;
  vi.mocked(api.get).mockImplementation(async () => ({ data: saved }));
  vi.mocked(api.post).mockImplementation(async (url, body) => {
    if (url.endsWith("/draft")) return { data: payload };
    if (url === path) {
      expect(CommercialHistoryRecoverySchema.parse(body)).toEqual(payload);
      saved = view();
      return { data: saved };
    }
    if (url.endsWith("/counterparty") && saved) saved = { ...saved, counterpartyApproved: true };
    return { data: {} };
  });
});

test("counterpart without a local submission reviews the signed archive before approving an import", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onImported = vi.fn();
  vi.mocked(api.post).mockResolvedValue({
    data: {
      ...view(),
      counterpartyApproved: true,
      original: { ...view().original, archiveOnly: true, state: "closed" },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <CommercialHistoryRecoveryImport
        approval={approval}
        scope={scope}
        writable
        busy={false}
        onImported={onImported}
      />
    </QueryClientProvider>,
  );
  upload({ payload, jws: "current.peer.approval" });
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText(payload.originalRecordId)).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(onImported).toHaveBeenCalledWith(submissionId));
  expect(api.post).toHaveBeenCalledWith(
    `/federation/commercial-agreements/${approval.revisionId}/history-recovery/import`,
    { payload, jws: "current.peer.approval", originalInput },
    scope,
  );
});

test("reviews the original and requires confirmation before granting current recovery authority", async () => {
  mount();
  fireEvent.change(await screen.findByLabelText("Recovery reason"), {
    target: { value: payload.reason },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review recovery" }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve historical recovery" }));
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByText(payload.originalRecordId)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Awaiting counterpart recovery approval");
  expect(vi.mocked(api.post).mock.calls.map(([url]) => url)).toEqual([`${path}/draft`, path]);
});

test("imports the counterpart approval, signs the same payload and attaches without financial calls", async () => {
  mount();
  await screen.findByLabelText("Import counterpart approval");
  upload({ payload, jws: "current.peer.approval" });
  fireEvent.click(await screen.findByRole("button", { name: "Approve historical recovery" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await screen.findByText("Both institutions approved historical recovery");
  expect(vi.mocked(api.post).mock.calls.map(([url]) => url)).toEqual([
    path,
    `${path}/counterparty`,
  ]);
  expect(api.post).toHaveBeenLastCalledWith(
    `${path}/counterparty`,
    { jws: "current.peer.approval" },
    scope,
  );
});

test("rejects a foreign proposal and a changed original before attaching a signature", async () => {
  saved = view();
  mount();
  await screen.findByLabelText("Import counterpart approval");
  for (const altered of [
    { ...payload, agreementRevisionId: uuid(99) },
    { ...payload, originalDigest: `sha256:${"e".repeat(64)}` },
  ]) {
    upload({ payload: altered, jws: "foreign.approval" });
    await screen.findByText(
      "The approval file is invalid or refers to another original or contract.",
    );
  }
  expect(api.post).not.toHaveBeenCalled();
});

test("permission loss closes confirmation and mobile remains read only", async () => {
  const m = mount();
  await screen.findByLabelText("Import counterpart approval");
  upload({ payload, jws: "current.peer.approval" });
  fireEvent.click(await screen.findByRole("button", { name: "Approve historical recovery" }));
  m.rerender(m.element(false, []));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.queryByRole("button", { name: "Approve historical recovery" })).toBeNull();
  m.rerender(m.element(true));
  expect(screen.queryByLabelText("Import counterpart approval")).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});

test("shows a separate historical receipt and retries its own checkpoint", async () => {
  saved = {
    ...view(),
    counterpartyApproved: true,
    ledger: {
      id: uuid(53),
      state: "needs_review",
      lastError: "ORDERER_UNAVAILABLE",
      transactionId: "f".repeat(64),
      blockNumber: null,
    },
  };
  mount();
  await screen.findByText("Historical receipt needs attention");
  fireEvent.click(screen.getByRole("button", { name: "Retry ledger submission" }));
  await waitFor(() =>
    expect(api.post).toHaveBeenCalledWith(
      `/federation/commercial-agreements/${approval.revisionId}/submissions/${uuid(53)}/retry`,
      {},
      scope,
    ),
  );
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
});

test("reauthorizes only the unchanged recovery after an explicit confirmation", async () => {
  saved = { ...view(), canReauthorize: true };
  vi.mocked(api.post).mockImplementation(async (url) => {
    if (url !== `${path}/reauthorize`) throw new Error("Unexpected recovery action");
    saved = { ...view(), approvalJws: "new.current.approval", approvalHistoryCount: 1 };
    return { data: saved };
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Reapprove original recovery" }));
  expect(api.post).not.toHaveBeenCalled();
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(`${path}/reauthorize`, {}, scope));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(saved?.payload).toEqual(payload);
  expect(vi.mocked(api.post).mock.calls).toHaveLength(1);
});

test("reapproval keeps import, retry, export and panel dismissal mutually exclusive", async () => {
  saved = { ...view(), canReauthorize: true };
  let finish: ((result: { data: unknown }) => void) | undefined;
  vi.mocked(api.post).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Reapprove original recovery" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText("Import counterpart approval")).toHaveProperty("disabled", true);
  expect(
    screen.getByRole("button", { name: "Download signed approval", hidden: true }),
  ).toHaveProperty("disabled", true);
  for (const button of screen.getAllByRole("button", { name: "Cancel", hidden: true }))
    expect(button).toHaveProperty("disabled", true);
  await act(async () => {
    finish?.({ data: saved });
  });
});

test("revoked authority stops the second import step after local approval returns", async () => {
  let finish: ((result: { data: unknown }) => void) | undefined;
  vi.mocked(api.post).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const m = mount();
  await screen.findByLabelText("Import counterpart approval");
  upload({ payload, jws: "current.peer.approval" });
  fireEvent.click(await screen.findByRole("button", { name: "Approve historical recovery" }));
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith(path, payload, scope));
  m.rerender(m.element(false, []));
  saved = view();
  await act(async () => {
    finish?.({ data: saved });
  });
  expect(vi.mocked(api.post).mock.calls.map(([url]) => url)).toEqual([path]);
});

test("a completed import cannot select a submission after leaving its organization view", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onImported = vi.fn();
  let finish: ((result: { data: unknown }) => void) | undefined;
  vi.mocked(api.post).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const m = render(
    <QueryClientProvider client={client}>
      <CommercialHistoryRecoveryImport
        approval={approval}
        scope={scope}
        writable
        busy={false}
        onImported={onImported}
      />
    </QueryClientProvider>,
  );
  upload({ payload, jws: "current.peer.approval" });
  fireEvent.click(
    within(await screen.findByRole("dialog")).getByRole("button", { name: "Confirm" }),
  );
  await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
  m.unmount();
  await act(async () => {
    finish?.({ data: view() });
  });
  expect(onImported).not.toHaveBeenCalled();
});
