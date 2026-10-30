import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useOrganizationName } from "./use-organization-name";

vi.mock("./active-organization", () => ({
  getActiveOrganizationContext: async () => ({
    activeOrganizationId: "allowed-org",
    organizations: [{ orgId: "allowed-org", name: "Compute team", role: "member" }],
  }),
}));

test("resolves authorized organization names and preserves unknown identifiers", async () => {
  function Names() {
    const name = useOrganizationName();
    return (
      <div>
        {name("allowed-org")} / {name("other-org")}
      </div>
    );
  }
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Names />
    </QueryClientProvider>,
  );
  expect(await screen.findByText("Compute team / other-org")).toBeTruthy();
});
