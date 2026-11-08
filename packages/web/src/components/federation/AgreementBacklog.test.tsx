import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { AgreementBacklog } from "./AgreementBacklog";

vi.mock("../../lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn() },
}));
const revisionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const scope = { organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", authRevision: "session-1" };
const data = {
  agreementRevisionId: revisionId,
  unit: "credit.micro",
  limits: {
    maxOutstandingTasks: 2,
    maxOutstandingAmount: "9007199254740993001",
    maxOutstandingAgeSec: 3600,
  },
  outstandingTasks: 2,
  outstandingAmount: "9007199254740993000",
  oldestPendingAt: "2026-11-08T00:00:00.000Z",
  oldestAgeSec: 3600,
  observedAt: "2026-11-08T01:00:00.000Z",
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <AgreementBacklog scope={scope} revisionId={revisionId} />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
});
test("backlog displays precise scoped amounts and refreshes without hiding loaded values", async () => {
  vi.mocked(api.get).mockResolvedValue({ data });
  mount();
  await screen.findByText("2 / 2");
  expect(
    screen.getByText("9,007,199,254,740,993,000 / 9,007,199,254,740,993,001 credit.micro"),
  ).toBeTruthy();
  expect(screen.getByText("3,600 seconds / 3,600 seconds")).toBeTruthy();
  expect(api.get).toHaveBeenCalledWith(`/federation/agreements/${revisionId}/backlog`, scope);
  let release: (value: unknown) => void = () => {};
  vi.mocked(api.get).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(screen.getByText("2 / 2")).toBeTruthy();
  expect(screen.queryByText("Loading…")).toBeNull();
  release({ data: { ...data, outstandingTasks: 1 } });
  await screen.findByText("1 / 2");
});
test("backlog absence of limits and absence of obligations remain distinct", async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: {
      ...data,
      limits: null,
      outstandingTasks: 0,
      outstandingAmount: "0",
      oldestPendingAt: null,
      oldestAgeSec: null,
    },
  });
  mount();
  await screen.findByText("No attestation backlog limits in this agreement");
  expect(screen.getByText("No outstanding tasks")).toBeTruthy();
  expect(screen.getByText("0 credit.micro")).toBeTruthy();
});
test("backlog errors conceal cached figures and a successful retry restores them", async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ data }).mockRejectedValueOnce(new Error("revoked"));
  mount();
  await screen.findByText("2 / 2");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByRole("alert");
  expect(screen.queryByText("2 / 2")).toBeNull();
  vi.mocked(api.get).mockResolvedValue({ data });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("2 / 2");
});
test("backlog rejects a response belonging to another agreement", async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: { ...data, agreementRevisionId: scope.organizationId },
  });
  mount();
  await screen.findByRole("alert");
  expect(screen.queryByText("2 / 2")).toBeNull();
});
