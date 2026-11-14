import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { api } from "../../lib/api-client";
import i18n from "../../lib/i18n";
import { FederationClustersPanel } from "./FederationClustersPanel";

vi.mock("../../lib/api-client", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
vi.mock("../../lib/active-organization", () => ({
  useActiveOrganizationId: () => "11111111-1111-4111-8111-111111111111",
}));
vi.mock("../federation/FederationLayout", async (original) => ({
  ...(await original<typeof import("../federation/FederationLayout")>()),
  useFederationAuthRevision: () => "session-1",
}));
const device = vi.hoisted(() => ({ blocked: false }));
vi.mock("../../lib/use-mobile-mutation-blocked", () => ({
  useMobileMutationBlocked: () => device.blocked,
}));
const orgId = "11111111-1111-4111-8111-111111111111";
const sourceSiteId = "22222222-2222-4222-8222-222222222222";
const targetSiteId = "33333333-3333-4333-8333-333333333333";
const revisionId = "44444444-4444-4444-8444-444444444444";
const digest = `sha256:${"a".repeat(64)}`;
const template = {
  originSiteId: sourceSiteId,
  kind: "script",
  id: "55555555-5555-4555-8555-555555555555",
  revision: "1",
  digest,
};
const executionTarget = {
  providerOrgId: orgId,
  clusterId: "partner-cpu",
  agentId: "partner-agent",
  queueId: "remote-batch",
};
const config = {
  localOrgId: orgId,
  name: "Partner CPU",
  clusterName: "Partner CPU",
  queueName: "batch",
  schedulerType: "slurm",
  agreementRevisionId: revisionId,
  executionTarget,
  allowAllMembers: true,
  allowedUserIds: [],
  showPartnerLabel: true,
  enabled: true,
  profiles: [
    {
      id: "66666666-6666-4666-8666-666666666666",
      name: "Read count",
      source: { kind: "command", commandParameter: "command" },
      template,
      inputManifestDigest: digest,
      environmentLockDigest: digest,
      maxAmount: "10",
      outputs: [],
    },
  ],
};
const agreement = {
  localSiteId: sourceSiteId,
  localOrgId: orgId,
  revisionId,
  executionUserId: null,
  approvedBy: orgId,
  state: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
  termsDigest: digest,
  approvalJws: "source-signature",
  counterpartyApprovalJws: "target-signature",
  targetName: "Partner institute",
  terms: {
    protocolVersion: 1,
    kind: "agreement",
    agreementRevisionId: revisionId,
    sourceSiteId,
    targetSiteId,
    mode: "bilateral_direct",
    budgetDomainId: orgId,
    epoch: revisionId,
    unit: "credit.micro",
    budgetLimit: "100",
    maxTaskAmount: "60",
    maxReservations: 10,
    validFrom: "2025-01-01T00:00:00.000Z",
    validUntil: "2027-01-01T00:00:00.000Z",
    templates: [template],
    resourceLimit: { cpus: 2, memoryMb: 256, gpus: 0, wallTimeSec: 60 },
    executionTargets: [executionTarget],
    termsDigest: digest,
  },
};
const row = {
  id: "77777777-7777-4777-8777-777777777777",
  config,
  partnerName: "Partner institute",
  targetSiteId,
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const root = "/admin/federation/clusters";
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <FederationClustersPanel />
    </QueryClientProvider>,
  );
}
beforeEach(async () => {
  vi.resetAllMocks();
  device.blocked = false;
  await i18n.changeLanguage("en");
  vi.mocked(api.get).mockImplementation(async (path) =>
    path === root
      ? { data: [row] }
      : path.startsWith("/federation/agreements")
        ? { success: true, data: [agreement] }
        : path.startsWith("/federation/assets")
          ? { data: { data: [] } }
          : { data: [], hasMore: false },
  );
  vi.mocked(api.put).mockResolvedValue({ data: row });
});
test("saves the label switch and explicit member scope without changing the authorized target", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Partner CPU/ }));
  await screen.findByRole("option", { name: /Partner institute/ });
  fireEvent.click(screen.getByRole("switch", { name: "Show federation label" }));
  fireEvent.click(screen.getByLabelText("All members of this organization"));
  fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
  await waitFor(() =>
    expect(api.put).toHaveBeenCalledWith(
      `${root}/${row.id}`,
      { ...config, showPartnerLabel: false, allowAllMembers: false },
      { organizationId: orgId, authRevision: "session-1" },
    ),
  );
});
test("failed writes keep the configuration editable", async () => {
  vi.mocked(api.put).mockRejectedValue(new Error("Save failed"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Partner CPU/ }));
  await screen.findByRole("option", { name: /Partner institute/ });
  fireEvent.change(screen.getByLabelText("Cluster name"), { target: { value: "Genome CPU" } });
  fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form")!);
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Cluster name") as HTMLInputElement).value).toBe("Genome CPU");
});
test("mobile management remains read-only", async () => {
  device.blocked = true;
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Partner CPU/ }));
  expect(screen.getByLabelText("Cluster name").closest("fieldset")?.disabled).toBe(true);
  expect(api.put).not.toHaveBeenCalled();
});
