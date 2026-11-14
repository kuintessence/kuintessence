import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { checkCaseBinding, checkEvidenceScope, EvidenceCaseSchema } from "./evidence-case-view";
import { FederationEvidencePanel } from "./FederationEvidencePanel";
import { evidenceCase, scope, uuid } from "./governance-test-fixtures";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({ useMobileMutationBlocked: () => false }));
let grants: string[];
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  grants = ["disclosure.receive"];
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.endsWith("/capabilities"))
      return {
        data: {
          orgId: scope.organizationId,
          userId: uuid(4),
          grants,
          effectiveCapabilities: grants,
        },
      } as never;
    if (path.includes("/disclosures")) return { data: [], hasMore: false } as never;
    return { data: [evidenceCase], hasMore: false } as never;
  });
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FederationEvidencePanel scope={scope} switching={false} />
    </QueryClientProvider>,
  );
}
test("case receiver can navigate evidence but cannot sign without arbitrator capability", async () => {
  mount();
  fireEvent.click(
    await screen.findByRole("button", {
      name: new RegExp(`Arbitration case.*${evidenceCase.caseId.slice(0, 8)}`),
    }),
  );
  await screen.findByText("No received evidence.");
  expect(screen.queryByRole("button", { name: "Sign decision" })).toBeNull();
  expect(screen.getByRole("button", { name: "Fetch authorized evidence" })).toBeTruthy();
  expect(api.post).not.toHaveBeenCalled();
});
test("cross organization cases never become selectable", async () => {
  vi.mocked(api.get).mockImplementation(async (path) =>
    path.endsWith("/capabilities")
      ? ({
          data: {
            orgId: scope.organizationId,
            userId: uuid(4),
            grants,
            effectiveCapabilities: grants,
          },
        } as never)
      : ({ data: [{ ...evidenceCase, localOrgId: uuid(99) }], hasMore: false } as never),
  );
  mount();
  await screen.findByRole("alert");
  expect(
    screen.queryByRole("button", {
      name: new RegExp(`Arbitration case.*${evidenceCase.caseId.slice(0, 8)}`),
    }),
  ).toBeNull();
});
test("unconfirmed registration retries the same case and immutable context", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Register case" }));
  const labels = [
    "Case ID",
    "Commercial domain ID",
    "Agreement revision ID",
    "Agreement digest",
    "Requesting site ID",
    "Executing site ID",
    "Arbitrator site ID",
  ];
  for (const [index, value] of Object.values(evidenceCase.context).entries())
    fireEvent.change(screen.getByLabelText(labels[index] as string), { target: { value } });
  vi.mocked(api.post)
    .mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(evidenceCase as never);
  fireEvent.click(screen.getAllByRole("button", { name: "Register case" }).at(-1) as HTMLElement);
  await screen.findByText(/Registration is unconfirmed/);
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await screen.findByText("No received evidence.");
  expect(api.post).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.post).mock.calls[0]?.[1]).toEqual(vi.mocked(api.post).mock.calls[1]?.[1]);
});
test("evidence context rejects substituted parties and arbitrator", () => {
  const row = EvidenceCaseSchema.parse(evidenceCase);
  expect(() => checkEvidenceScope({ ...row.context, sourceSiteId: uuid(99) }, row)).toThrow();
  expect(() => checkCaseBinding({ ...row.context, arbitratorSiteId: uuid(99) }, row)).toThrow();
  expect(() =>
    checkCaseBinding({ ...row.context, arbitratorSiteId: row.localSiteId }, row),
  ).not.toThrow();
});
test("capability read failure exposes retry without registering or reading evidence", async () => {
  vi.mocked(api.get).mockRejectedValue(new Error("denied"));
  mount();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
  expect(api.post).not.toHaveBeenCalled();
});
