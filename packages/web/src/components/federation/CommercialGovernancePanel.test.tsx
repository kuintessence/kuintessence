import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { CommercialGovernancePanel } from "./CommercialGovernancePanel";
import { approval, disclosurePolicy, policyRow, scope, uuid } from "./governance-test-fixtures";

vi.mock("../../lib/api-client", async (original) => ({
  ...(await original<typeof import("../../lib/api-client")>()),
  api: { get: vi.fn(), post: vi.fn() },
}));
let records: unknown[], failLookup: boolean;
beforeEach(async () => {
  vi.resetAllMocks();
  await i18n.changeLanguage("en");
  records = [];
  failLookup = false;
  vi.mocked(api.get).mockImplementation(async (path) => {
    if (path.includes("approval-exchange"))
      return { data: { enabled: false, records: [] } } as never;
    if (failLookup) throw new Error("read denied");
    return { data: { data: records, hasMore: false } } as never;
  });
});
function mount(
  grants = ["agreement.read", "arbitration.approve", "disclosure.approve", "case.publish"],
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <CommercialGovernancePanel
        approval={approval}
        scope={scope}
        grants={grants}
        readOnly={false}
        busy={false}
      />
    </QueryClientProvider>,
  );
}
async function importPolicy() {
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Disclosure policies" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No records.");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByText("Import counterparty terms"));
  fireEvent.change(screen.getByLabelText("Terms to sign"), {
    target: { value: JSON.stringify(disclosurePolicy) },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Review terms" }).at(-1) as HTMLElement);
  await screen.findByRole("dialog");
}
test("lost approval recovers the original ID without another signature", async () => {
  mount();
  await importPolicy();
  vi.mocked(api.post).mockImplementation(async () => {
    records = [policyRow];
    throw new Error("response lost");
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm signing" }),
  );
  await screen.findByText(/outcome is unconfirmed/);
  failLookup = true;
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await waitFor(() => expect(api.get).toHaveBeenCalledTimes(4));
  expect(
    (screen.getAllByRole("button", { name: "Cancel" }).at(-1) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(api.post).toHaveBeenCalledTimes(1);
  failLookup = false;
  fireEvent.click(screen.getByRole("button", { name: "Recover original action" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(api.post).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("Local signature") as HTMLTextAreaElement).value).toBe(
    "policy.local.signature",
  );
});
test("cross contract imports never reach approval", async () => {
  mount();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Disclosure policies" }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No records.");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  fireEvent.click(screen.getByText("Import counterparty terms"));
  fireEvent.change(screen.getByLabelText("Terms to sign"), {
    target: { value: JSON.stringify({ ...disclosurePolicy, agreementRevisionId: uuid(99) }) },
  });
  fireEvent.click(screen.getAllByRole("button", { name: "Review terms" }).at(-1) as HTMLElement);
  await screen.findByRole("alert");
  expect(api.post).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
test("read-only role cannot create or sign", async () => {
  mount(["agreement.read"]);
  await screen.findByText("No records.");
  expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  expect(screen.queryByRole("tab", { name: "Disclosures" })).toBeNull();
});
test("revoked authority blocks an approval after its lookup resolves", async () => {
  const view = mount();
  await importPolicy();
  let release: (value: unknown) => void = () => {};
  vi.mocked(api.get).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }) as never,
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm signing" }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view.rerender(
    <QueryClientProvider client={client}>
      <CommercialGovernancePanel
        approval={approval}
        scope={scope}
        grants={[]}
        readOnly={false}
        busy={false}
      />
    </QueryClientProvider>,
  );
  await act(async () => release({ data: { data: [], hasMore: false } }));
  expect(api.post).not.toHaveBeenCalled();
});
test("losing disclosure authority removes the selected private panel", async () => {
  const view = mount();
  fireEvent.mouseDown(screen.getByRole("tab", { name: /^Disclosures$/ }), {
    button: 0,
    ctrlKey: false,
  });
  await screen.findByText("No records.");
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  expect(screen.getByLabelText("Record digest")).toBeTruthy();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  view.rerender(
    <QueryClientProvider client={client}>
      <CommercialGovernancePanel
        approval={approval}
        scope={scope}
        grants={["agreement.read"]}
        readOnly={false}
        busy={false}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.queryByLabelText("Record digest")).toBeNull());
  expect(screen.queryByRole("tab", { name: /^Disclosures$/ })).toBeNull();
});
