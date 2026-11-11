import {
  ArbitrationDecisionInputSchema,
  ArbitrationDecisionIntentSchema,
} from "@kuintessence/shared/federation/arbitration-decision";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { ArbitrationDecisionPanel } from "./ArbitrationDecisionPanel";
import {
  arbitrationBinding,
  arbitrationReview,
  evidenceCase,
  scope,
  uuid,
} from "./governance-test-fixtures";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
let saved: unknown, denyRead: boolean;
const { observedAt: _observed, ...binding } = arbitrationBinding;
const intent = ArbitrationDecisionIntentSchema.parse({
  decisionId: uuid(37),
  binding,
  subject: arbitrationReview.context.subject,
  financial: arbitrationReview.context.financial,
  evidence: arbitrationReview.evidence,
  outcome: {
    action: "settle",
    bill: arbitrationReview.context.financial.targets[0]?.bill,
    chargedAmount: "9007199254740993",
  },
  reason: "Agreed evidence",
  salt: "e".repeat(64),
});
let currentIntent = intent;
beforeEach(async () => {
  currentIntent = intent;
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  saved = null;
  denyRead = false;
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (denyRead) throw new Error("denied");
    if (path.endsWith("/delivery"))
      return {
        enabled: true,
        data: [
          {
            receivingSiteId: evidenceCase.context.sourceSiteId,
            deliveryId: uuid(38),
            state: "received",
            lastError: null,
            acknowledgedAt: "2026-01-01T00:00:00Z",
          },
        ],
      } as never;
    if (path.endsWith("/ledger")) return { data: null } as never;
    return { data: saved } as never;
  });
  vi.mocked(api.post).mockImplementation(async (path, body) => {
    if (path.endsWith("/arbitration-review")) return { data: arbitrationReview } as never;
    if (path.endsWith("/draft")) {
      currentIntent = {
        ...intent,
        decisionId: ArbitrationDecisionInputSchema.parse(body).decisionId,
      };
      return { data: currentIntent } as never;
    }
    saved = {
      payload: {
        protocolVersion: 1,
        kind: "arbitration-decision",
        intent: currentIntent,
        issuedAt: "2026-01-01T00:00:00Z",
        basisDigest: evidenceCase.context.agreementDigest,
        basisExpiresAt: "2099-01-01T00:00:00Z",
      },
      digest: evidenceCase.context.agreementDigest,
      approvedAt: "2026-01-01T00:00:00Z",
    };
    throw new Error("lost response");
  });
});
function mount(grants = ["arbitration.read", "arbitration.decide", "disclosure.receive"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ArbitrationDecisionPanel
        row={evidenceCase}
        scope={scope}
        grants={grants}
        grantIds={[uuid(39)]}
        readOnly={false}
        busy={false}
      />
    </QueryClientProvider>,
  );
}
test("R reviews, drafts a large amount, and recovers the same award after response loss", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review party state and selected evidence" }),
  );
  await screen.findByText(/Review valid until/);
  fireEvent.change(screen.getByLabelText("Outcome"), { target: { value: "settle" } });
  fireEvent.change(screen.getByLabelText("Target bill"), { target: { value: uuid(36) } });
  fireEvent.change(screen.getByLabelText(/Charged amount/), {
    target: { value: "9007199254740993" },
  });
  fireEvent.change(screen.getByLabelText("Decision reason"), {
    target: { value: "Agreed evidence" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Review terms" }));
  await screen.findByRole("dialog");
  expect(within(screen.getByRole("dialog")).getByText("Charged amount")).toBeTruthy();
  expect(
    within(screen.getByRole("dialog")).getByText("9007199254740993 · credit.micro"),
  ).toBeTruthy();
  expect(within(screen.getByRole("dialog")).getByText("Agreed evidence")).toBeTruthy();
  expect(vi.mocked(api.post).mock.calls[1]?.[1]).toMatchObject({
    outcome: { chargedAmount: "9007199254740993" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm signing" }),
  );
  await screen.findByText(/outcome is unconfirmed/);
  denyRead = true;
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
  expect(api.post).toHaveBeenCalledTimes(3);
  denyRead = false;
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(3);
  await screen.findByText("Received");
});
test("arbitration readers cannot issue or publish a decision", async () => {
  mount(["arbitration.read"]);
  await screen.findByRole("button", { name: "Review party state and selected evidence" });
  expect(screen.queryByRole("button", { name: "Sign decision" })).toBeNull();
  expect(api.post).not.toHaveBeenCalled();
});
test("substituted case context is rejected before decision drafting", async () => {
  vi.mocked(api.post).mockResolvedValueOnce({
    data: {
      ...arbitrationReview,
      context: {
        ...arbitrationReview.context,
        binding: { ...arbitrationBinding, caseId: uuid(99) },
      },
    },
  } as never);
  mount();
  fireEvent.click(
    await screen.findByRole("button", { name: "Review party state and selected evidence" }),
  );
  await screen.findByRole("alert");
  expect(screen.queryByLabelText("Decision reason")).toBeNull();
});
