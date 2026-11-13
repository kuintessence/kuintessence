import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { GovernanceProgress } from "./GovernanceProgress";
import { policyRow, scope, uuid } from "./governance-test-fixtures";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
});
test("only the selected policy can resume its original signature exchange", async () => {
  vi.mocked(api.get).mockResolvedValue({
    data: {
      enabled: true,
      records: [
        {
          recordKind: "disclosure-policy",
          recordId: policyRow.policyId,
          state: "needs_review",
          lastError: "UNTRUSTED_IDENTITY",
          nextAttemptAt: "2099-01-01T00:00:00Z",
          verifiedAt: null,
        },
        {
          recordKind: "disclosure-policy",
          recordId: uuid(99),
          state: "needs_review",
          lastError: null,
          nextAttemptAt: "2099-01-01T00:00:00Z",
          verifiedAt: null,
        },
      ],
    },
  } as never);
  const retry = vi.fn();
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <GovernanceProgress
        kind="disclosure"
        row={policyRow}
        scope={scope}
        writable
        busy={false}
        onRetry={retry}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Recover original action" }));
  expect(retry).toHaveBeenCalledWith(
    `/federation/commercial-agreements/${policyRow.agreementRevisionId}/approval-exchange/disclosure-policy/${policyRow.policyId}/retry`,
  );
  expect(api.post).not.toHaveBeenCalled();
});
