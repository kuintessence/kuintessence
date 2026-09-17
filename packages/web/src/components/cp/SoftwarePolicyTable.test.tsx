import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  CpSoftwareOverview,
  SoftwareAvailabilityPreview,
  SoftwareOperation,
} from "../../lib/cp-client";
import { SoftwarePolicyTable } from "./SoftwarePolicyTable";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) => {
      const templates: Record<string, string> = {
        "cp.software.operations.batchPartialFailed":
          "{{accepted}}/{{total}} accepted, {{failed}} failed: {{first}}",
        "cp.software.operations.batchPartialFailedWithIgnored":
          "{{accepted}}/{{total}} accepted, {{failed}} failed, ignored {{ignoredEmpty}} blank and {{ignoredDuplicate}} duplicate: {{first}}",
        "cp.software.operations.batchPolicyRejectedCount": "{{count}} rejected: {{first}}",
        "cp.software.operations.policyReason.allowList":
          "not included in the current software allow list",
        "cp.software.operations.policyReason.denyList": "blocked by the current software deny list",
        "cp.software.operations.policyReason.generic": "does not meet the current software policy",
        "cp.software.operations.batchQueuedWithIgnored":
          "{{count}} queued, ignored {{ignoredEmpty}} blank and {{ignoredDuplicate}} duplicate",
        "cp.software.operations.catalogBatchAdded": "added {{spec}} to batch",
        "cp.software.operations.catalogSingleSelected": "selected {{spec}}",
        "cp.software.operations.policyRejectedBatch": "{{count}} rejected in batch: {{first}}",
        "cp.software.edit.specConflict": "spec conflict: {{items}}",
        "cp.software.edit.usecaseConflict": "usecase conflict: {{items}}",
        "cp.software.operations.historyShowAll": "show all {{count}}",
      };
      const template = templates[key] ?? key;
      if (key.startsWith("cp.software.operations.policyReason.")) return template;
      if (!vars) return key;
      return Object.entries(vars).reduce(
        (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
        template,
      );
    },
  }),
}));

const cpClient = vi.hoisted(() => ({
  getSoftwareOverview: vi.fn(),
  previewSoftwareAvailability: vi.fn(),
  saveProviderSoftwarePolicy: vi.fn(),
  saveClusterSoftwarePolicy: vi.fn(),
  saveAgentSoftwarePolicy: vi.fn(),
  listSoftwarePolicies: vi.fn(),
  editSoftwarePolicy: vi.fn(),
  listSoftwareOperations: vi.fn(),
  requestSoftwareOperation: vi.fn(),
  requestSoftwareOperationsBatch: vi.fn(),
  reviewPreinstalledMapping: vi.fn(),
}));

const softwareClient = vi.hoisted(() => ({
  bindRuntimeContract: vi.fn(),
  listSpackCatalog: vi.fn(),
  listLicensedMaterialMappings: vi.fn(),
  listRuntimeContractBindings: vi.fn(),
  registerLicensedMaterialMapping: vi.fn(),
}));
const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("../../lib/cp-client", () => cpClient);
vi.mock("../../lib/software-client", () => softwareClient);
vi.mock("sonner", () => ({ toast }));

function makeWrapper() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

const overviewAgents: CpSoftwareOverview["agents"] = [
  {
    agentId: "agent-a",
    cluster: "cluster-a",
    siteId: "site-a",
    providerOrgId: "00000000-0000-0000-0000-00000000c0a1",
    status: "online",
    runtimeStatus: "online",
    controlChannelOnline: true,
    lastHeartbeat: "2026-06-22T00:00:00.000Z",
    schedulerType: "slurm",
    schedulerVersion: "23.02",
    providerPolicy: null,
    clusterPolicy: null,
    agentPolicy: null,
    effectivePolicy: {
      installMode: "explicit-install-grant",
      allowList: [],
      denyList: [],
      lockEnabled: false,
      trustedPublicAutoInstall: false,
      usecaseDefaultAllow: true,
      usecaseAllowList: [],
      usecaseDenyList: [],
      mirrors: [],
      preinstallList: [],
    },
    installedCount: 1,
    installedSpecs: ["openmpi@4.1.6"],
    preinstalledMappings: [],
  },
];

const overview: CpSoftwareOverview = {
  providerOrgIds: ["00000000-0000-0000-0000-00000000c0a1"],
  providerPolicy: null,
  clusters: [
    {
      cluster: "cluster-a",
      providerOrgId: "00000000-0000-0000-0000-00000000c0a1",
      lockedAgents: 0,
      mirrorCount: 0,
      preinstallCount: 0,
      installedCount: 1,
      installModes: ["explicit-install-grant"],
      clusterPolicy: null,
      agents: overviewAgents,
    },
  ],
  agents: overviewAgents,
  summary: {
    clusters: 1,
    agents: 1,
    lockedAgents: 0,
    overrides: 0,
    mirrors: 0,
    preinstalledSpecs: 0,
    installedSpecs: 1,
  },
};

const preview: SoftwareAvailabilityPreview = {
  spec: "openmpi@4.1.6",
  installedAvailable: [
    {
      agentId: "agent-a",
      siteName: "cluster-a",
      providerOrgId: "00000000-0000-0000-0000-00000000c0a1",
      status: "online",
      installedSpec: "openmpi@4.1.6",
      installMode: "explicit-install-grant",
      reasons: [],
    },
  ],
  installableAvailable: [],
  blocked: [
    {
      agentId: "agent-b",
      siteName: "cluster-b",
      providerOrgId: "00000000-0000-0000-0000-00000000c0a1",
      status: "online",
      installMode: "preinstalled-only",
      reasons: ["provider policy only allows preinstalled software"],
    },
  ],
  explanations: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("SoftwarePolicyTable", () => {
  test("keeps cluster actions reachable in a local horizontal scroller", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);

    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    await screen.findByTestId("cp-software-agent-agent-a");
    const scroller = screen.getByTestId("cp-software-cluster-table-scroll-cluster-a");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.querySelector("table")?.className).toContain("min-w-[58rem]");
  });

  test("renders overview query errors without showing an empty software state", async () => {
    cpClient.getSoftwareOverview.mockRejectedValueOnce(new Error("not authorized"));

    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    expect(await screen.findByText("cp.software.loadFailed")).toBeTruthy();
    expect(screen.queryByText("not authorized")).toBeNull();
    expect(screen.queryByTestId("cp-software-empty")).toBeNull();
    expect(screen.queryByText("cp.software.provider.title")).toBeNull();
  });

  test("hides stale software governance actions when overview refresh fails", async () => {
    cpClient.getSoftwareOverview
      .mockResolvedValueOnce(overview)
      .mockRejectedValueOnce(new Error("Authorization principal is not bound"));
    cpClient.listSoftwareOperations.mockResolvedValue([]);

    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    expect(await screen.findByTestId("cp-software-agent-agent-a")).toBeTruthy();
    fireEvent.click(screen.getByText("cp.software.agent.inspect"));
    expect(await screen.findByTestId("cp-software-agent-sheet")).toBeTruthy();

    fireEvent.click(screen.getByText("cp.software.refresh"));

    expect(await screen.findByText("cp.software.loadFailed")).toBeTruthy();
    expect(screen.queryByText("Authorization principal is not bound")).toBeNull();
    expect(screen.queryByText("cp.software.provider.title")).toBeNull();
    expect(screen.queryByTestId("cp-software-preview-input")).toBeNull();
    expect(screen.queryByTestId("cp-software-agent-agent-a")).toBeNull();
    expect(screen.queryByTestId("cp-software-agent-sheet")).toBeNull();
    expect(screen.queryByText("cp.software.operations.submit")).toBeNull();
  });

  test("shows registered agents even when no legacy software policy row exists", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    expect(await screen.findByTestId("cp-software-agent-agent-a")).toBeTruthy();
    expect(screen.queryByTestId("cp-software-empty")).toBeNull();
    expect(screen.getByText("agent-a")).toBeTruthy();
    expect(screen.getByText("cp.software.policy.unconfigured")).toBeTruthy();
    expect(screen.queryByTestId("cp-software-control-channel-notice")).toBeNull();
  });

  test("keeps software operations available while hiding governance from provider operators", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);

    render(<SoftwarePolicyTable canManage={false} />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));

    expect(await screen.findByText("cp.software.operations.submit")).toBeTruthy();
    expect(screen.queryByText("cp.software.agent.editOverride")).toBeNull();
    expect(screen.queryByText("cp.software.cluster.editOverride")).toBeNull();
    expect(screen.queryByText("cp.common.edit")).toBeNull();
  });

  test("shows a top-level notice when all agent control channels are offline", async () => {
    const offlineAgents = overviewAgents.map((agent) => ({
      ...agent,
      runtimeStatus: "offline",
      controlChannelOnline: false,
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: offlineAgents,
      clusters: overview.clusters.map((cluster) => ({
        ...cluster,
        agents: offlineAgents,
      })),
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    expect(await screen.findByTestId("cp-software-control-channel-notice")).toBeTruthy();
    expect(screen.getByText("cp.software.controlChannelNotice.title")).toBeTruthy();
  });

  test("shows and expands long usecase policy lists", async () => {
    const usecaseAllowList = Array.from({ length: 10 }, (_, index) => `usecase:${index + 1}`);
    const policyAgents = overviewAgents.map((agent) => ({
      ...agent,
      effectivePolicy: {
        ...agent.effectivePolicy,
        usecaseDefaultAllow: false,
        usecaseAllowList,
      },
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: policyAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: policyAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));

    expect(await screen.findByText("usecase:8")).toBeTruthy();
    expect(screen.queryByText("usecase:9")).toBeNull();
    expect(screen.getByText("cp.software.usecase.listCountHint")).toBeTruthy();
    fireEvent.click(screen.getByText("cp.software.usecase.showAll"));
    expect(screen.getByText("usecase:10")).toBeTruthy();
  });

  test("saves cluster policy overrides", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.saveClusterSoftwarePolicy.mockResolvedValue(overview);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.cluster.editOverride"));
    fireEvent.click(screen.getByText("cp.common.save"));

    await waitFor(() => {
      expect(cpClient.saveClusterSoftwarePolicy).toHaveBeenCalledWith("cluster-a", {
        installMode: "explicit-install-grant",
        allowList: [],
        denyList: [],
        lockEnabled: false,
        trustedPublicAutoInstall: false,
        usecaseDefaultAllow: true,
        usecaseAllowList: [],
        usecaseDenyList: [],
        mirrors: [],
        preinstallList: [],
      });
    });
  });

  test("normalizes duplicate policy editor lines and preserves mirror priority zero", async () => {
    const baseCluster = overview.clusters[0];
    if (!baseCluster) throw new Error("test overview must include a cluster");
    const overviewWithClusterPolicy: CpSoftwareOverview = {
      ...overview,
      clusters: [
        {
          ...baseCluster,
          clusterPolicy: {
            scope: "cluster",
            providerOrgId: "00000000-0000-0000-0000-00000000c0a1",
            clusterId: "cluster-a",
            agentId: null,
            version: "v-policy",
            updatedAt: "2026-06-22T00:00:00.000Z",
            installMode: "explicit-install-grant",
            allowList: ["zlib", "zlib", " openmpi "],
            denyList: ["lammps", "lammps"],
            lockEnabled: false,
            trustedPublicAutoInstall: false,
            usecaseDefaultAllow: false,
            usecaseAllowList: ["usecase:foam", "usecase:foam"],
            usecaseDenyList: ["asset:blocked", "asset:blocked"],
            mirrors: [{ name: "local", url: "https://mirror.example/spack", priority: 0 }],
            preinstallList: ["zlib", "zlib"],
          },
        },
      ],
    };
    cpClient.getSoftwareOverview.mockResolvedValue(overviewWithClusterPolicy);
    cpClient.saveClusterSoftwarePolicy.mockResolvedValue(overviewWithClusterPolicy);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.cluster.editOverride"));
    fireEvent.click(screen.getByText("cp.common.save"));

    await waitFor(() => {
      expect(cpClient.saveClusterSoftwarePolicy).toHaveBeenCalledWith("cluster-a", {
        installMode: "explicit-install-grant",
        allowList: ["zlib", "openmpi"],
        denyList: ["lammps"],
        lockEnabled: false,
        trustedPublicAutoInstall: false,
        usecaseDefaultAllow: false,
        usecaseAllowList: ["usecase:foam"],
        usecaseDenyList: ["asset:blocked"],
        mirrors: [{ name: "local", url: "https://mirror.example/spack", priority: 0 }],
        preinstallList: ["zlib"],
      });
    });
  });

  test("saves provider policy overrides for the explicitly selected provider org", async () => {
    const providerA = "00000000-0000-0000-0000-00000000c0a1";
    const providerB = "00000000-0000-0000-0000-00000000c0b2";
    const multiProviderOverview: CpSoftwareOverview = {
      ...overview,
      providerOrgIds: [providerA, providerB],
    };
    cpClient.getSoftwareOverview.mockResolvedValue(multiProviderOverview);
    cpClient.saveProviderSoftwarePolicy.mockResolvedValue(multiProviderOverview);

    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    const editButtons = await screen.findAllByText("cp.common.edit");
    const providerEditButton = editButtons[0];
    if (!providerEditButton) throw new Error("provider edit button was not rendered");
    fireEvent.click(providerEditButton);
    fireEvent.change(screen.getByLabelText("cp.software.edit.providerOrg"), {
      target: { value: providerB },
    });
    fireEvent.click(screen.getByText("cp.common.save"));

    await waitFor(() => {
      expect(cpClient.saveProviderSoftwarePolicy).toHaveBeenCalledWith({
        providerOrgId: providerB,
        installMode: "explicit-install-grant",
        allowList: [],
        denyList: [],
        lockEnabled: false,
        trustedPublicAutoInstall: false,
        usecaseDefaultAllow: true,
        usecaseAllowList: [],
        usecaseDenyList: [],
        mirrors: [],
        preinstallList: [],
      });
    });
  });

  test("blocks saving policy overrides with conflicting Spack allow and deny entries", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.saveClusterSoftwarePolicy.mockResolvedValue(overview);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.cluster.editOverride"));
    fireEvent.change(screen.getByTestId("cp-software-policy-allow"), {
      target: { value: "zlib\nopenmpi" },
    });
    fireEvent.change(screen.getByTestId("cp-software-policy-deny"), {
      target: { value: " zlib " },
    });

    expect(screen.getByText("spec conflict: zlib")).toBeTruthy();
    fireEvent.click(screen.getByText("cp.common.save"));

    expect(cpClient.saveClusterSoftwarePolicy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("spec conflict: zlib");
  });

  test("blocks saving policy overrides with conflicting usecase allow and deny entries", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.saveClusterSoftwarePolicy.mockResolvedValue(overview);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.cluster.editOverride"));
    fireEvent.change(screen.getByTestId("cp-software-policy-usecase-allow"), {
      target: { value: "usecase:foam\nasset:ok" },
    });
    fireEvent.change(screen.getByTestId("cp-software-policy-usecase-deny"), {
      target: { value: " usecase:foam " },
    });

    expect(screen.getByText("usecase conflict: usecase:foam")).toBeTruthy();
    fireEvent.click(screen.getByText("cp.common.save"));

    expect(cpClient.saveClusterSoftwarePolicy).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("usecase conflict: usecase:foam");
  });

  test("warns when usecase default allow is disabled without any grant entries", async () => {
    const baseCluster = overview.clusters[0];
    if (!baseCluster) throw new Error("test overview must include a cluster");
    const overviewWithNoGrantPolicy: CpSoftwareOverview = {
      ...overview,
      clusters: [
        {
          ...baseCluster,
          clusterPolicy: {
            scope: "cluster",
            providerOrgId: "00000000-0000-0000-0000-00000000c0a1",
            clusterId: "cluster-a",
            agentId: null,
            version: "v-policy",
            updatedAt: "2026-06-22T00:00:00.000Z",
            installMode: "explicit-install-grant",
            allowList: [],
            denyList: [],
            lockEnabled: false,
            trustedPublicAutoInstall: false,
            usecaseDefaultAllow: false,
            usecaseAllowList: [],
            usecaseDenyList: [],
            mirrors: [],
            preinstallList: [],
          },
        },
      ],
    };
    cpClient.getSoftwareOverview.mockResolvedValue(overviewWithNoGrantPolicy);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.cluster.editOverride"));

    expect(screen.getByText("cp.software.edit.usecaseNoGrant")).toBeTruthy();
  });

  test("clears software operation drafts when inspecting another agent", async () => {
    const baseAgent = overviewAgents[0];
    if (!baseAgent) throw new Error("test overview must include an agent");
    const agentB = {
      ...baseAgent,
      agentId: "agent-b",
      cluster: "cluster-a",
      installedSpecs: ["hdf5@1.14.3"],
    };
    const overviewWithTwoAgents: CpSoftwareOverview = {
      ...overview,
      agents: [...overviewAgents, agentB],
      clusters: overview.clusters.map((cluster) => ({
        ...cluster,
        agents: [...overviewAgents, agentB],
      })),
      summary: {
        ...overview.summary,
        agents: 2,
      },
    };
    cpClient.getSoftwareOverview.mockResolvedValue(overviewWithTwoAgents);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    const inspectButtons = await screen.findAllByText("cp.software.agent.inspect");
    const firstInspect = inspectButtons[0];
    const secondInspect = inspectButtons[1];
    if (!firstInspect || !secondInspect) {
      throw new Error("two inspect buttons were not rendered");
    }
    fireEvent.click(firstInspect);
    const specInput = screen.getByPlaceholderText("cp.software.operations.specPlaceholder");
    fireEvent.change(specInput, { target: { value: "zlib@1.3" } });
    fireEvent.change(screen.getByTestId("cp-software-batch-specs"), {
      target: { value: "openmpi@4.1.6" },
    });

    fireEvent.click(secondInspect);

    await waitFor(() => {
      expect(screen.getByPlaceholderText("cp.software.operations.specPlaceholder")).toHaveProperty(
        "value",
        "",
      );
    });
    expect(screen.getByTestId("cp-software-batch-specs")).toHaveProperty("value", "");
  });

  test("clears installed software filters when inspecting another agent", async () => {
    const baseAgent = overviewAgents[0];
    if (!baseAgent) throw new Error("test overview must include an agent");
    const agentAInstalled = Array.from({ length: 65 }, (_, index) => `a-pkg-${index}@1.0`);
    const agentBInstalled = [
      "hdf5@1.14.3",
      ...Array.from({ length: 64 }, (_, index) => `b-pkg-${index}@1.0`),
    ];
    const agentA = {
      ...baseAgent,
      installedCount: agentAInstalled.length,
      installedSpecs: agentAInstalled,
    };
    const agentB = {
      ...baseAgent,
      agentId: "agent-b",
      cluster: "cluster-a",
      installedCount: agentBInstalled.length,
      installedSpecs: agentBInstalled,
    };
    const overviewWithTwoAgents: CpSoftwareOverview = {
      ...overview,
      agents: [agentA, agentB],
      clusters: overview.clusters.map((cluster) => ({
        ...cluster,
        agents: [agentA, agentB],
      })),
      summary: {
        ...overview.summary,
        agents: 2,
        installedSpecs: agentAInstalled.length + agentBInstalled.length,
      },
    };
    cpClient.getSoftwareOverview.mockResolvedValue(overviewWithTwoAgents);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    const inspectButtons = await screen.findAllByText("cp.software.agent.inspect");
    const firstInspect = inspectButtons[0];
    const secondInspect = inspectButtons[1];
    if (!firstInspect || !secondInspect) {
      throw new Error("two inspect buttons were not rendered");
    }

    fireEvent.click(firstInspect);
    fireEvent.change(screen.getByTestId("cp-software-installed-filter"), {
      target: { value: "a-pkg-64" },
    });
    expect(screen.getByText("a-pkg-64@1.0")).toBeTruthy();

    fireEvent.click(secondInspect);

    await waitFor(() => {
      expect(screen.getByTestId("cp-software-installed-filter")).toHaveProperty("value", "");
    });
    expect(screen.getByText("hdf5@1.14.3")).toBeTruthy();
  });

  test("closes the agent sheet when the selected agent disappears after refresh", async () => {
    const baseAgent = overviewAgents[0];
    if (!baseAgent) throw new Error("test overview must include an agent");
    const agentB = {
      ...baseAgent,
      agentId: "agent-b",
      cluster: "cluster-a",
      installedSpecs: ["hdf5@1.14.3"],
    };
    const overviewWithTwoAgents: CpSoftwareOverview = {
      ...overview,
      agents: [...overviewAgents, agentB],
      clusters: overview.clusters.map((cluster) => ({
        ...cluster,
        agents: [...overviewAgents, agentB],
      })),
      summary: {
        ...overview.summary,
        agents: 2,
      },
    };
    cpClient.getSoftwareOverview
      .mockResolvedValueOnce(overviewWithTwoAgents)
      .mockResolvedValueOnce(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    const inspectButtons = await screen.findAllByText("cp.software.agent.inspect");
    const secondInspect = inspectButtons[1];
    if (!secondInspect) throw new Error("second inspect button was not rendered");
    fireEvent.click(secondInspect);
    await waitFor(() => {
      expect(screen.getAllByText("agent-b").length).toBeGreaterThan(1);
    });

    fireEvent.click(screen.getByText("cp.software.refresh"));

    await waitFor(() => {
      expect(screen.queryAllByText("agent-b")).toHaveLength(0);
    });
    expect(screen.queryByTestId("cp-software-agent-agent-b")).toBeNull();
  });

  test("renders availability preview buckets", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.previewSoftwareAvailability.mockResolvedValue(preview);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    const input = await screen.findByTestId("cp-software-preview-input");
    fireEvent.change(input, { target: { value: "openmpi@4.1.6" } });
    fireEvent.click(screen.getByText("cp.software.preview.submit"));

    await waitFor(() => {
      expect(cpClient.previewSoftwareAvailability).toHaveBeenCalledWith({
        rawSpec: "openmpi@4.1.6",
        installable: true,
      });
    });
    expect(await screen.findByTestId("cp-software-preview-result")).toBeTruthy();
    expect(screen.getByText("agent-b")).toBeTruthy();
    expect(screen.getByText("software.availabilityReason.preinstalledOnly")).toBeTruthy();
  });

  test("passes usecase context to the availability preview", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.previewSoftwareAvailability.mockResolvedValue(preview);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.change(await screen.findByTestId("cp-software-preview-input"), {
      target: { value: "openfoam@11" },
    });
    fireEvent.change(screen.getByTestId("cp-software-preview-usecase"), {
      target: { value: "usecase:openfoam-cavity" },
    });
    fireEvent.change(screen.getByTestId("cp-software-preview-usecase-version"), {
      target: { value: "v1" },
    });
    fireEvent.click(screen.getByText("cp.software.preview.submit"));

    await waitFor(() => {
      expect(cpClient.previewSoftwareAvailability).toHaveBeenCalledWith({
        rawSpec: "openfoam@11",
        installable: true,
        usecaseRef: {
          name: "openfoam-cavity",
          version: "v1",
        },
      });
    });
  });

  test("submits newline separated batch preinstall specs", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperationsBatch.mockResolvedValue([
      {
        id: "op-1",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "install",
        spec: "gromacs@2024.1 +mpi",
        status: "queued",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: null,
        requestedAt: "2026-06-18T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        updatedAt: "2026-06-18T00:00:00.000Z",
      },
      {
        id: "op-2",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "install",
        spec: "openmpi@4.1.6",
        status: "queued",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: null,
        requestedAt: "2026-06-18T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        updatedAt: "2026-06-18T00:00:00.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const textarea = await screen.findByTestId("cp-software-batch-specs");
    fireEvent.change(textarea, {
      target: { value: "gromacs@2024.1 +mpi\n\nopenmpi@4.1.6\n openmpi@4.1.6 " },
    });
    expect(screen.getByText("cp.software.operations.batchParsedCount")).toBeTruthy();
    expect(screen.getByText("cp.software.operations.batchDuplicateCount")).toBeTruthy();
    fireEvent.click(screen.getByText("cp.software.operations.batchSubmit"));

    await waitFor(() => {
      expect(cpClient.requestSoftwareOperationsBatch).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "install",
        idempotencyKey: expect.stringMatching(UUID_PATTERN),
        specs: ["gromacs@2024.1 +mpi", "", "openmpi@4.1.6", " openmpi@4.1.6 "],
      });
    });
  });

  test("shows server batch normalization in the success toast", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperationsBatch.mockResolvedValue({
      items: [
        {
          id: "op-1",
          agentId: "agent-a",
          requestedBy: "admin",
          action: "install",
          spec: "zlib",
          status: "queued",
          stdout: null,
          stderr: null,
          exitCode: null,
          error: null,
          requestedAt: "2026-06-18T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-06-18T00:00:00.000Z",
        },
      ],
      summary: {
        inputCount: 3,
        nonEmptyCount: 2,
        uniqueSpecCount: 1,
        ignoredEmptyCount: 1,
        ignoredDuplicateCount: 1,
      },
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.change(await screen.findByTestId("cp-software-batch-specs"), {
      target: { value: "zlib\n\nzlib" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.batchSubmit"));

    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("1 queued, ignored 1 blank and 1 duplicate");
    });
  });

  test("treats an empty successful batch response as an error", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperationsBatch.mockResolvedValue({
      items: [],
      summary: {
        inputCount: 1,
        nonEmptyCount: 1,
        uniqueSpecCount: 1,
        ignoredEmptyCount: 0,
        ignoredDuplicateCount: 0,
      },
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const textarea = await screen.findByTestId("cp-software-batch-specs");
    fireEvent.change(textarea, { target: { value: "zlib" } });
    fireEvent.click(screen.getByText("cp.software.operations.batchSubmit"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("cp.software.operations.batchEmptyResult");
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect((textarea as HTMLTextAreaElement).value).toBe("zlib");
  });

  test("switches batch copy between install and preinstalled import", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(screen.getByText("cp.software.operations.batchInstallTitle")).toBeTruthy();
    expect(screen.getByText("cp.software.operations.batchInstallSubtitle")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("cp.software.operations.batchInstallPlaceholder"),
    ).toBeTruthy();

    fireEvent.change(await screen.findByTestId("cp-software-batch-action"), {
      target: { value: "import_preinstalled" },
    });

    expect(screen.getByText("cp.software.operations.batchImportTitle")).toBeTruthy();
    expect(screen.getByText("cp.software.operations.batchImportSubtitle")).toBeTruthy();
    expect(
      screen.getByPlaceholderText("cp.software.operations.batchImportPlaceholder"),
    ).toBeTruthy();
  });

  test("blocks batch submission when the unique spec count exceeds the limit", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.change(await screen.findByTestId("cp-software-batch-specs"), {
      target: {
        value: Array.from({ length: 201 }, (_, index) => `pkg-${index}`).join("\n"),
      },
    });

    expect(screen.getByText("cp.software.operations.batchLimitExceeded")).toBeTruthy();
    const submit = screen
      .getByText("cp.software.operations.batchSubmit")
      .closest("button") as HTMLButtonElement | null;
    if (!submit) throw new Error("batch submit button was not rendered");
    expect(submit.disabled).toBe(true);

    const form = screen.getByTestId("cp-software-batch-form");
    fireEvent.submit(form);
    expect(cpClient.requestSoftwareOperationsBatch).not.toHaveBeenCalled();
  });

  test("keeps batch specs when any submitted operation fails", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperationsBatch.mockResolvedValue([
      {
        id: "op-failed",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "install",
        spec: "zlib",
        status: "failed",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: "agent dispatch failed: stream closed",
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: null,
        finishedAt: "2026-06-22T00:00:01.000Z",
        updatedAt: "2026-06-22T00:00:01.000Z",
      },
      {
        id: "op-queued",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "install",
        spec: "hdf5",
        status: "queued",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: null,
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const textarea = await screen.findByTestId("cp-software-batch-specs");
    fireEvent.change(textarea, { target: { value: "zlib\nhdf5" } });
    fireEvent.click(screen.getByText("cp.software.operations.batchSubmit"));

    await waitFor(() => {
      expect(cpClient.requestSoftwareOperationsBatch).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "install",
        idempotencyKey: expect.stringMatching(UUID_PATTERN),
        specs: ["zlib", "hdf5"],
      });
    });
    expect((textarea as HTMLTextAreaElement).value).toBe("zlib\nhdf5");
    expect(toast.error).toHaveBeenCalledWith(
      "1/2 accepted, 1 failed: zlib: cp.software.operations.failed",
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      expect.stringContaining("agent dispatch failed: stream closed"),
    );
  });

  test("blocks batch submission when pasted raw lines exceed the server limit", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.change(await screen.findByTestId("cp-software-batch-specs"), {
      target: {
        value: Array.from({ length: 2001 }, (_, index) => (index === 0 ? "zlib" : "")).join("\n"),
      },
    });

    expect(screen.getByText("cp.software.operations.batchRawLimitExceeded")).toBeTruthy();
    const form = screen.getByTestId("cp-software-batch-form");
    fireEvent.submit(form);
    expect(cpClient.requestSoftwareOperationsBatch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("cp.software.operations.batchRawLimitExceeded");
  });

  test("shows failed operation summaries directly in operation history", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([
      {
        id: "op-failed-summary",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "install",
        spec: "zlib",
        status: "failed",
        stdout: null,
        stderr: "spack install failed",
        exitCode: 1,
        error: null,
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: "2026-06-22T00:00:00.000Z",
        finishedAt: "2026-06-22T00:00:01.000Z",
        updatedAt: "2026-06-22T00:00:01.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));

    expect(
      (await screen.findByTestId("cp-software-operation-error-summary-op-failed-summary"))
        .textContent,
    ).toBe("cp.software.operations.failed");
    expect(screen.queryByText("spack install failed")).toBeNull();
  });

  test("truncates long failed operation summaries while keeping full output details", async () => {
    const longStdout = Array.from(
      { length: 40 },
      (_, index) => `remote: Counting objects: ${index}% (item-${index})`,
    ).join("\n");
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([
      {
        id: "op-long-failed-summary",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "install",
        spec: "zlib",
        status: "failed",
        stdout: longStdout,
        stderr: null,
        exitCode: 1,
        error: null,
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: "2026-06-22T00:00:00.000Z",
        finishedAt: "2026-06-22T00:00:01.000Z",
        updatedAt: "2026-06-22T00:00:01.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));

    expect(
      (await screen.findByTestId("cp-software-operation-error-summary-op-long-failed-summary"))
        .textContent,
    ).toBe("cp.software.operations.failed");
    expect(screen.queryByText("remote: Counting objects")).toBeNull();
    expect(screen.queryByText("item-39")).toBeNull();
  });

  test("blocks concurrent software submissions while a batch operation is pending", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    let resolveBatch: (items: SoftwareOperation[]) => void = () => {};
    cpClient.requestSoftwareOperationsBatch.mockImplementation(
      () =>
        new Promise<SoftwareOperation[]>((resolve) => {
          resolveBatch = resolve;
        }),
    );
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.change(await screen.findByTestId("cp-software-batch-specs"), {
      target: { value: "zlib" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.batchSubmit"));

    await waitFor(() => {
      expect(cpClient.requestSoftwareOperationsBatch).toHaveBeenCalledTimes(1);
    });
    fireEvent.change(screen.getByPlaceholderText("cp.software.operations.specPlaceholder"), {
      target: { value: "openmpi" },
    });
    const singleSubmit = screen
      .getByText("cp.software.operations.submit")
      .closest("button") as HTMLButtonElement | null;
    const singleCatalog = screen
      .getByText("cp.software.operations.catalogOpen")
      .closest("button") as HTMLButtonElement | null;
    const batchCatalog = screen
      .getByText("cp.software.operations.catalogAdd")
      .closest("button") as HTMLButtonElement | null;
    if (!singleSubmit || !singleCatalog || !batchCatalog) {
      throw new Error("operation buttons were not rendered");
    }

    await waitFor(() => {
      expect(singleSubmit.disabled).toBe(true);
    });
    expect(singleCatalog.disabled).toBe(true);
    expect(batchCatalog.disabled).toBe(true);
    const form = screen
      .getByPlaceholderText("cp.software.operations.specPlaceholder")
      .closest("form");
    if (!form) throw new Error("software operation form was not rendered");
    fireEvent.submit(form);
    expect(cpClient.requestSoftwareOperation).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("cp.software.operations.pending");

    resolveBatch([
      {
        id: "op-pending-batch",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "install",
        spec: "zlib",
        status: "queued",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: null,
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]);
  });

  test("keeps the selected batch action when adding a catalog spec", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperationsBatch.mockResolvedValue([
      {
        id: "op-import",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "import_preinstalled",
        spec: "hdf5@1.14.3",
        status: "queued",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: null,
        requestedAt: "2026-06-18T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        updatedAt: "2026-06-18T00:00:00.000Z",
      },
    ]);
    softwareClient.listSpackCatalog.mockResolvedValue({
      source: "spack",
      sourceRepository: "spack/spack-packages",
      sourceRef: "develop",
      generatedAt: "2026-06-18T00:00:00.000Z",
      packageCount: 1,
      upstreamCount: 1,
      customCount: 0,
      totalCount: 1,
      page: 1,
      pageSize: 18,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
      packages: [
        {
          name: "hdf5",
          source: "upstream",
          description: "HDF5",
          tags: [],
          metadata: {
            versions: ["1.14.3"],
            variants: [],
            dependencies: [],
            provides: [],
            conflicts: [],
            licenses: [],
            maintainers: [],
          },
        },
      ],
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.change(await screen.findByTestId("cp-software-batch-action"), {
      target: { value: "import_preinstalled" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.catalogAdd"));
    fireEvent.click(await screen.findByTestId("cp-software-catalog-package-upstream-hdf5"));
    fireEvent.change(await screen.findByTestId("cp-software-catalog-version"), {
      target: { value: "1.14.3" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.catalogUseSpec"));
    expect(toast.success).toHaveBeenCalledWith("added hdf5@1.14.3 to batch");
    fireEvent.click(screen.getByText("cp.software.operations.batchSubmit"));

    await waitFor(() => {
      expect(cpClient.requestSoftwareOperationsBatch).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "import_preinstalled",
        idempotencyKey: expect.stringMatching(UUID_PATTERN),
        specs: ["hdf5@1.14.3"],
      });
    });
  });

  test("builds catalog specs with free-form value variants", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    softwareClient.listSpackCatalog.mockResolvedValue({
      source: "spack",
      sourceRepository: "spack/spack-packages",
      sourceRef: "develop",
      generatedAt: "2026-06-23T00:00:00.000Z",
      packageCount: 1,
      upstreamCount: 1,
      customCount: 0,
      totalCount: 1,
      page: 1,
      pageSize: 18,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
      packages: [
        {
          name: "gromacs",
          source: "upstream",
          description: "Molecular dynamics",
          tags: [],
          metadata: {
            versions: ["2024.1"],
            variants: [
              {
                name: "cuda_arch",
                default: "none",
                description: "CUDA architecture",
                values: ["70", "80", "90"],
              },
            ],
            dependencies: [],
            provides: [],
            conflicts: [],
            licenses: [],
            maintainers: [],
          },
        },
      ],
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(screen.getByText("cp.software.operations.catalogOpen"));
    fireEvent.click(await screen.findByTestId("cp-software-catalog-package-upstream-gromacs"));
    fireEvent.change(await screen.findByTestId("cp-software-catalog-version"), {
      target: { value: "2024.1" },
    });
    fireEvent.change(screen.getByTestId("cp-software-catalog-variant-cuda_arch"), {
      target: { value: "70 80" },
    });

    expect(await screen.findByTestId("cp-software-catalog-spec-validation")).toBeTruthy();
    const useSpecButton = screen
      .getByText("cp.software.operations.catalogUseSpec")
      .closest("button");
    expect(useSpecButton).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByTestId("cp-software-catalog-variant-cuda_arch"), {
      target: { value: "80" },
    });
    expect(screen.queryByTestId("cp-software-catalog-spec-validation")).toBeNull();
    expect(useSpecButton).toHaveProperty("disabled", false);

    expect(screen.getByTestId("cp-software-catalog-spec")).toHaveProperty(
      "value",
      "gromacs@2024.1 cuda_arch=80",
    );
    fireEvent.click(screen.getByText("cp.software.operations.catalogUseSpec"));

    expect(screen.getByPlaceholderText("cp.software.operations.specPlaceholder")).toHaveProperty(
      "value",
      "gromacs@2024.1 cuda_arch=80",
    );
  });

  test("clears selected catalog specs when search results change", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    softwareClient.listSpackCatalog.mockImplementation((query: string) =>
      Promise.resolve({
        source: "spack",
        sourceRepository: "spack/spack-packages",
        sourceRef: "develop",
        generatedAt: "2026-06-23T00:00:00.000Z",
        packageCount: 1,
        upstreamCount: 1,
        customCount: 0,
        totalCount: 1,
        page: 1,
        pageSize: 18,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
        packages:
          query === "gromacs"
            ? [
                {
                  name: "gromacs",
                  source: "upstream",
                  description: "Molecular dynamics",
                  tags: [],
                  metadata: {
                    versions: ["2024.1"],
                    variants: [],
                    dependencies: [],
                    provides: [],
                    conflicts: [],
                    licenses: [],
                    maintainers: [],
                  },
                },
              ]
            : [
                {
                  name: "hdf5",
                  source: "upstream",
                  description: "HDF5",
                  tags: [],
                  metadata: {
                    versions: ["1.14.3"],
                    variants: [],
                    dependencies: [],
                    provides: [],
                    conflicts: [],
                    licenses: [],
                    maintainers: [],
                  },
                },
              ],
      }),
    );
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(screen.getByText("cp.software.operations.catalogOpen"));
    fireEvent.click(await screen.findByTestId("cp-software-catalog-package-upstream-hdf5"));
    fireEvent.change(await screen.findByTestId("cp-software-catalog-version"), {
      target: { value: "1.14.3" },
    });
    expect(screen.getByTestId("cp-software-catalog-spec")).toHaveProperty("value", "hdf5@1.14.3");

    fireEvent.change(screen.getByTestId("cp-software-catalog-search"), {
      target: { value: "gromacs" },
    });

    expect(await screen.findByTestId("cp-software-catalog-package-upstream-gromacs")).toBeTruthy();
    expect(screen.queryByTestId("cp-software-catalog-spec")).toBeNull();
    expect(screen.getByText("cp.software.operations.catalogSpecEmpty")).toBeTruthy();
  });

  test("can expand and collapse long installed software lists", async () => {
    const installedSpecs = Array.from({ length: 65 }, (_, index) => `pkg-${index}@1.0`);
    const agent = overview.agents[0];
    const cluster = overview.clusters[0];
    if (!agent || !cluster) throw new Error("overview fixture is missing agent or cluster");
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      summary: {
        ...overview.summary,
        installedSpecs: installedSpecs.length,
      },
      agents: [
        {
          ...agent,
          installedCount: installedSpecs.length,
          installedSpecs,
        },
      ],
      clusters: [
        {
          ...cluster,
          installedCount: installedSpecs.length,
          agents: [
            {
              ...agent,
              installedCount: installedSpecs.length,
              installedSpecs,
            },
          ],
        },
      ],
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(screen.getByText("pkg-0@1.0")).toBeTruthy();
    expect(screen.queryByText("pkg-64@1.0")).toBeNull();
    expect(screen.getByText("cp.software.agent.installedCountHint")).toBeTruthy();

    fireEvent.click(screen.getByText("cp.software.agent.installedShowAll"));
    expect(screen.getByText("pkg-64@1.0")).toBeTruthy();

    fireEvent.click(screen.getByText("cp.software.agent.installedShowLess"));
    expect(screen.queryByText("pkg-64@1.0")).toBeNull();

    fireEvent.change(screen.getByTestId("cp-software-installed-filter"), {
      target: { value: "pkg-64" },
    });
    expect(screen.queryByText("pkg-0@1.0")).toBeNull();
    expect(screen.getByText("pkg-64@1.0")).toBeTruthy();

    fireEvent.change(screen.getByTestId("cp-software-installed-filter"), {
      target: { value: "missing" },
    });
    expect(screen.getByText("cp.software.agent.installedFilterEmpty")).toBeTruthy();
  });

  test("shows operation metadata details when a succeeded operation has no output", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([
      {
        id: "op-success-empty-output",
        agentId: "agent-a",
        requestedBy: "admin@test",
        action: "load",
        spec: "openmpi@4.1.6",
        status: "succeeded",
        stdout: null,
        stderr: null,
        exitCode: 0,
        error: null,
        requestedAt: "2026-06-18T00:00:00.000Z",
        startedAt: "2026-06-18T00:00:01.000Z",
        finishedAt: "2026-06-18T00:00:02.000Z",
        updatedAt: "2026-06-18T00:00:02.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("cp.software.operations.details")).toBeTruthy();
    expect(screen.getByText("admin@test")).toBeTruthy();
    expect(
      screen.getByText(/cp\.software\.operations\.exitCode/).parentElement?.textContent,
    ).toContain("0");
  });

  test("approves a preinstalled mapping from the agent sheet", async () => {
    const baseAgent = overviewAgents[0];
    if (!baseAgent) throw new Error("test overview must include an agent");
    const mappingOverview: CpSoftwareOverview = {
      ...overview,
      agents: [
        {
          ...baseAgent,
          preinstalledMappings: [
            {
              id: "mapping-approve-1",
              localSpec: "openmpi@4.1.6",
              assetId: "00000000-0000-0000-0000-00000000aa01",
              confidence: "declared",
              auditedBy: null,
              auditedAt: null,
            },
          ],
        },
      ],
      clusters: overview.clusters.map((cluster) => ({
        ...cluster,
        agents: [
          {
            ...baseAgent,
            preinstalledMappings: [
              {
                id: "mapping-approve-1",
                localSpec: "openmpi@4.1.6",
                assetId: "00000000-0000-0000-0000-00000000aa01",
                confidence: "declared",
                auditedBy: null,
                auditedAt: null,
              },
            ],
          },
        ],
      })),
    };
    const approvedOverview: CpSoftwareOverview = {
      ...mappingOverview,
      agents: mappingOverview.agents.map((agent) => ({
        ...agent,
        preinstalledMappings: agent.preinstalledMappings.map((mapping) => ({
          ...mapping,
          confidence: "platform-locked",
          auditedBy: "reviewer-user",
          auditedAt: "2026-07-07T00:00:00.000Z",
        })),
      })),
      clusters: mappingOverview.clusters.map((cluster) => ({
        ...cluster,
        agents: cluster.agents.map((agent) => ({
          ...agent,
          preinstalledMappings: agent.preinstalledMappings.map((mapping) => ({
            ...mapping,
            confidence: "platform-locked",
            auditedBy: "reviewer-user",
            auditedAt: "2026-07-07T00:00:00.000Z",
          })),
        })),
      })),
    };
    cpClient.getSoftwareOverview.mockResolvedValue(mappingOverview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.reviewPreinstalledMapping.mockResolvedValue(approvedOverview);

    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(
      await screen.findByTestId("cp-software-preinstalled-approve-mapping-approve-1"),
    );

    await waitFor(() => {
      expect(cpClient.reviewPreinstalledMapping).toHaveBeenCalledWith({
        agentId: "agent-a",
        mappingId: "mapping-approve-1",
        decision: "approve",
      });
    });
    expect(await screen.findByText("platform-locked")).toBeTruthy();
    expect(screen.queryByTestId("cp-software-preinstalled-approve-mapping-approve-1")).toBeNull();
  });

  test("rejects a preinstalled mapping from the agent sheet", async () => {
    const baseAgent = overviewAgents[0];
    if (!baseAgent) throw new Error("test overview must include an agent");
    const mappingOverview: CpSoftwareOverview = {
      ...overview,
      agents: [
        {
          ...baseAgent,
          preinstalledMappings: [
            {
              id: "mapping-reject-1",
              localSpec: "bad-mapping@1",
              assetId: "00000000-0000-0000-0000-00000000aa02",
              confidence: "declared",
              auditedBy: null,
              auditedAt: null,
            },
          ],
        },
      ],
      clusters: overview.clusters.map((cluster) => ({
        ...cluster,
        agents: [
          {
            ...baseAgent,
            preinstalledMappings: [
              {
                id: "mapping-reject-1",
                localSpec: "bad-mapping@1",
                assetId: "00000000-0000-0000-0000-00000000aa02",
                confidence: "declared",
                auditedBy: null,
                auditedAt: null,
              },
            ],
          },
        ],
      })),
    };
    const rejectedOverview: CpSoftwareOverview = {
      ...mappingOverview,
      agents: mappingOverview.agents.map((agent) => ({ ...agent, preinstalledMappings: [] })),
      clusters: mappingOverview.clusters.map((cluster) => ({
        ...cluster,
        agents: cluster.agents.map((agent) => ({ ...agent, preinstalledMappings: [] })),
      })),
    };
    cpClient.getSoftwareOverview.mockResolvedValue(mappingOverview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.reviewPreinstalledMapping.mockResolvedValue(rejectedOverview);

    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(await screen.findByTestId("cp-software-preinstalled-reject-mapping-reject-1"));

    await waitFor(() => {
      expect(cpClient.reviewPreinstalledMapping).toHaveBeenCalledWith({
        agentId: "agent-a",
        mappingId: "mapping-reject-1",
        decision: "reject",
      });
    });
    expect(await screen.findByText("cp.software.agent.noMappings")).toBeTruthy();
    expect(screen.queryByText("bad-mapping@1")).toBeNull();
  });

  test("manually refreshes software operation history", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([
      {
        id: "op-refresh",
        agentId: "agent-a",
        requestedBy: "admin@test",
        action: "install",
        spec: "zlib",
        status: "succeeded",
        stdout: null,
        stderr: null,
        exitCode: 0,
        error: null,
        requestedAt: "2026-06-18T00:00:00.000Z",
        startedAt: "2026-06-18T00:00:01.000Z",
        finishedAt: "2026-06-18T00:00:02.000Z",
        updatedAt: "2026-06-18T00:00:02.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("zlib")).toBeTruthy();
    fireEvent.click(await screen.findByText("cp.software.operations.historyRefresh"));

    await waitFor(() => {
      expect(cpClient.listSoftwareOperations).toHaveBeenCalledTimes(2);
    });
  });

  test("keeps operation history refresh available after a query error", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce([
        {
          id: "op-refresh-after-error",
          agentId: "agent-a",
          requestedBy: "admin@test",
          action: "install",
          spec: "zlib",
          status: "succeeded",
          stdout: null,
          stderr: null,
          exitCode: 0,
          error: null,
          requestedAt: "2026-06-18T00:00:00.000Z",
          startedAt: "2026-06-18T00:00:01.000Z",
          finishedAt: "2026-06-18T00:00:02.000Z",
          updatedAt: "2026-06-18T00:00:02.000Z",
        },
      ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("cp.software.operations.failed")).toBeTruthy();
    expect(screen.queryByText("history unavailable")).toBeNull();
    fireEvent.click(screen.getByText("cp.software.operations.historyRefresh"));

    expect(await screen.findByText("zlib")).toBeTruthy();
    expect(cpClient.listSoftwareOperations).toHaveBeenCalledTimes(2);
  });

  test("keeps stale operation history visible when a manual refresh fails", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations
      .mockResolvedValueOnce([
        {
          id: "op-stale-after-error",
          agentId: "agent-a",
          requestedBy: "admin@test",
          action: "install",
          spec: "zlib",
          status: "succeeded",
          stdout: null,
          stderr: null,
          exitCode: 0,
          error: null,
          requestedAt: "2026-06-18T00:00:00.000Z",
          startedAt: "2026-06-18T00:00:01.000Z",
          finishedAt: "2026-06-18T00:00:02.000Z",
          updatedAt: "2026-06-18T00:00:02.000Z",
        },
      ])
      .mockRejectedValueOnce(new Error("refresh failed"));
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("zlib")).toBeTruthy();
    fireEvent.click(screen.getByText("cp.software.operations.historyRefresh"));

    await waitFor(() => {
      expect(cpClient.listSoftwareOperations).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByText("zlib")).toBeTruthy();
    expect(await screen.findByText("cp.software.operations.failed")).toBeTruthy();
    expect(screen.queryByText("refresh failed")).toBeNull();
  });

  test("disables retry actions when stale operation history is shown after a refresh failure", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations
      .mockResolvedValueOnce([
        {
          id: "op-stale-retry-denied",
          agentId: "agent-a",
          requestedBy: "admin@test",
          action: "install",
          spec: "zlib",
          status: "failed",
          stdout: null,
          stderr: "spack failed",
          exitCode: 1,
          error: null,
          requestedAt: "2026-06-18T00:00:00.000Z",
          startedAt: "2026-06-18T00:00:01.000Z",
          finishedAt: "2026-06-18T00:00:02.000Z",
          updatedAt: "2026-06-18T00:00:02.000Z",
        },
      ])
      .mockRejectedValueOnce(new Error("Authorization principal is not bound"));
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("zlib")).toBeTruthy();
    fireEvent.click(screen.getByText("cp.software.operations.historyRefresh"));

    expect(
      await screen.findByTestId("cp-software-operation-error-summary-op-stale-retry-denied"),
    ).toBeTruthy();
    expect(screen.queryByText("Authorization principal is not bound")).toBeNull();
    expect(screen.getByText("zlib")).toBeTruthy();
    const retry = await screen.findByTestId("cp-software-operation-retry-op-stale-retry-denied");
    expect(retry).toHaveProperty("disabled", true);
    fireEvent.click(retry);
    expect(screen.getByPlaceholderText("cp.software.operations.specPlaceholder")).toHaveProperty(
      "value",
      "",
    );
    expect(toast.success).not.toHaveBeenCalledWith("cp.software.operations.retryFilled");
  });

  test("can expand and collapse long software operation history", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue(
      Array.from({ length: 15 }, (_, index) => ({
        id: `op-history-${index}`,
        agentId: "agent-a",
        requestedBy: "admin@test",
        action: "install",
        spec: `pkg-${index}`,
        status: "succeeded",
        stdout: null,
        stderr: null,
        exitCode: 0,
        error: null,
        requestedAt: new Date(Date.parse("2026-06-18T00:00:00.000Z") - index * 1000).toISOString(),
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date(Date.parse("2026-06-18T00:00:01.000Z") - index * 1000).toISOString(),
      })),
    );
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("pkg-0")).toBeTruthy();
    expect(screen.getByText("pkg-11")).toBeTruthy();
    expect(screen.queryByText("pkg-14")).toBeNull();

    fireEvent.click(screen.getByText("show all 15"));
    expect(await screen.findByText("pkg-14")).toBeTruthy();

    fireEvent.click(screen.getByText("cp.software.operations.historyShowLess"));
    await waitFor(() => {
      expect(screen.queryByText("pkg-14")).toBeNull();
    });
  });

  test("filters software operation history by action through the server query", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    const installOperation: SoftwareOperation = {
      id: "op-action-install",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "zlib",
      status: "succeeded",
      stdout: null,
      stderr: null,
      exitCode: 0,
      error: null,
      requestedAt: "2026-06-18T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      updatedAt: "2026-06-18T00:00:01.000Z",
    };
    const importOperation: SoftwareOperation = {
      id: "op-action-import",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "import_preinstalled",
      spec: "hdf5@1.14.3",
      status: "succeeded",
      stdout: null,
      stderr: null,
      exitCode: 0,
      error: null,
      requestedAt: "2026-06-18T00:01:00.000Z",
      startedAt: null,
      finishedAt: null,
      updatedAt: "2026-06-18T00:01:01.000Z",
    };
    cpClient.listSoftwareOperations
      .mockResolvedValueOnce([installOperation, importOperation])
      .mockResolvedValueOnce([importOperation])
      .mockResolvedValueOnce([installOperation, importOperation]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("zlib")).toBeTruthy();
    fireEvent.change(screen.getByTestId("cp-software-operation-action-filter"), {
      target: { value: "import_preinstalled" },
    });

    await waitFor(() => {
      expect(cpClient.listSoftwareOperations).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "import_preinstalled",
        limit: 200,
      });
    });
    expect(await screen.findByText("hdf5@1.14.3")).toBeTruthy();
    expect(screen.queryByText("zlib")).toBeNull();
    expect(screen.getByTestId("cp-software-operation-action-filter-clear")).toBeTruthy();

    fireEvent.click(screen.getByTestId("cp-software-operation-action-filter-clear"));

    await waitFor(() => {
      expect(cpClient.listSoftwareOperations).toHaveBeenCalledWith({
        agentId: "agent-a",
        limit: 200,
      });
    });
    expect(await screen.findByText("zlib")).toBeTruthy();
  });

  test("shows a filtered empty state when server-side action filtering returns no operations", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations
      .mockResolvedValueOnce([
        {
          id: "op-action-install-only",
          agentId: "agent-a",
          requestedBy: "admin@test",
          action: "install",
          spec: "zlib",
          status: "succeeded",
          stdout: null,
          stderr: null,
          exitCode: 0,
          error: null,
          requestedAt: "2026-06-18T00:00:00.000Z",
          startedAt: null,
          finishedAt: null,
          updatedAt: "2026-06-18T00:00:01.000Z",
        },
      ])
      .mockResolvedValueOnce([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("zlib")).toBeTruthy();
    fireEvent.change(screen.getByTestId("cp-software-operation-action-filter"), {
      target: { value: "load" },
    });

    await waitFor(() => {
      expect(cpClient.listSoftwareOperations).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "load",
        limit: 200,
      });
    });
    expect(await screen.findByText("cp.software.operations.historyFilterEmpty")).toBeTruthy();
    expect(screen.queryByText("cp.software.operations.empty")).toBeNull();
  });

  test("shows a status summary for software operation history", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    const queuedOperation: SoftwareOperation = {
      id: "op-summary-queued",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "zlib",
      status: "queued",
      stdout: null,
      stderr: null,
      exitCode: null,
      error: null,
      requestedAt: "2026-06-18T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      updatedAt: "2026-06-18T00:00:00.000Z",
    };
    const runningOperation: SoftwareOperation = {
      id: "op-summary-running",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "hdf5",
      status: "running",
      stdout: null,
      stderr: null,
      exitCode: null,
      error: null,
      requestedAt: "2026-06-18T00:00:01.000Z",
      startedAt: "2026-06-18T00:00:02.000Z",
      finishedAt: null,
      updatedAt: "2026-06-18T00:00:02.000Z",
    };
    const succeededOperation: SoftwareOperation = {
      id: "op-summary-succeeded",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "openmpi",
      status: "succeeded",
      stdout: null,
      stderr: null,
      exitCode: 0,
      error: null,
      requestedAt: "2026-06-18T00:00:03.000Z",
      startedAt: "2026-06-18T00:00:04.000Z",
      finishedAt: "2026-06-18T00:00:05.000Z",
      updatedAt: "2026-06-18T00:00:05.000Z",
    };
    const failedOperation: SoftwareOperation = {
      id: "op-summary-failed",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "bad",
      status: "failed",
      stdout: null,
      stderr: "failed",
      exitCode: 1,
      error: null,
      requestedAt: "2026-06-18T00:00:06.000Z",
      startedAt: null,
      finishedAt: "2026-06-18T00:00:07.000Z",
      updatedAt: "2026-06-18T00:00:07.000Z",
    };
    const rejectedOperation: SoftwareOperation = {
      id: "op-summary-rejected",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "denied",
      status: "rejected",
      stdout: null,
      stderr: null,
      exitCode: null,
      error: "denied",
      requestedAt: "2026-06-18T00:00:08.000Z",
      startedAt: null,
      finishedAt: "2026-06-18T00:00:09.000Z",
      updatedAt: "2026-06-18T00:00:09.000Z",
    };
    const allOperations = [
      queuedOperation,
      runningOperation,
      succeededOperation,
      failedOperation,
      rejectedOperation,
    ];
    cpClient.listSoftwareOperations
      .mockResolvedValueOnce(allOperations)
      .mockResolvedValueOnce([failedOperation])
      .mockResolvedValueOnce(allOperations);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const summary = await screen.findByTestId("cp-software-operation-status-summary");

    expect(summary.textContent).toContain("cp.software.operations.status.queued: 1");
    expect(summary.textContent).toContain("cp.software.operations.status.running: 1");
    expect(summary.textContent).toContain("cp.software.operations.status.succeeded: 1");
    expect(summary.textContent).toContain("cp.software.operations.status.failed: 1");
    expect(summary.textContent).toContain("cp.software.operations.status.rejected: 1");

    fireEvent.click(screen.getByTestId("cp-software-operation-status-summary-failed"));

    await waitFor(() => {
      expect(cpClient.listSoftwareOperations).toHaveBeenCalledWith({
        agentId: "agent-a",
        status: "failed",
        limit: 200,
      });
    });
    expect(screen.queryByTestId("cp-software-operation-history-filter")).toBeNull();
    expect(await screen.findByText("bad")).toBeTruthy();
    expect(screen.queryByText("openmpi")).toBeNull();

    fireEvent.click(screen.getByTestId("cp-software-operation-status-filter-clear"));

    await waitFor(() => {
      expect(cpClient.listSoftwareOperations).toHaveBeenCalledWith({
        agentId: "agent-a",
        limit: 200,
      });
    });
    expect(await screen.findByText("openmpi")).toBeTruthy();
  });

  test("filters long software operation history across collapsed rows", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue(
      Array.from({ length: 15 }, (_, index) => ({
        id: `op-history-filter-${index}`,
        agentId: "agent-a",
        requestedBy: index === 14 ? "ops-admin" : "admin@test",
        action: index === 14 ? "import_preinstalled" : "install",
        spec: index === 14 ? "elpa@2024.05" : `pkg-${index}`,
        status: index === 14 ? "failed" : "succeeded",
        stdout: null,
        stderr: index === 14 ? "not found" : null,
        exitCode: index === 14 ? 1 : 0,
        error: null,
        requestedAt: new Date(Date.parse("2026-06-18T00:00:00.000Z") - index * 1000).toISOString(),
        startedAt: null,
        finishedAt: null,
        updatedAt: new Date(Date.parse("2026-06-18T00:00:01.000Z") - index * 1000).toISOString(),
      })),
    );
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(await screen.findByText("pkg-0")).toBeTruthy();
    expect(screen.queryByText("elpa@2024.05")).toBeNull();

    fireEvent.change(await screen.findByTestId("cp-software-operation-history-filter"), {
      target: { value: "failed" },
    });

    expect(await screen.findByText("elpa@2024.05")).toBeTruthy();
    expect(screen.getByText("cp.software.operations.historyFilterCount")).toBeTruthy();
    expect(screen.queryByText("pkg-0")).toBeNull();

    fireEvent.change(screen.getByTestId("cp-software-operation-history-filter"), {
      target: { value: "pkg-" },
    });

    expect(await screen.findByText("pkg-0")).toBeTruthy();
    expect(screen.getByText("show all 14")).toBeTruthy();
    expect(screen.queryByText("elpa@2024.05")).toBeNull();

    fireEvent.change(screen.getByTestId("cp-software-operation-history-filter"), {
      target: { value: "missing" },
    });
    expect(await screen.findByText("cp.software.operations.historyFilterEmpty")).toBeTruthy();
  });

  test("fills the operation form from a failed history row for retry", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([
      {
        id: "op-load-failed",
        agentId: "agent-a",
        requestedBy: "admin",
        action: "load",
        spec: "openmpi@4.1.6",
        status: "failed",
        stdout: null,
        stderr: "module not found",
        exitCode: 1,
        error: null,
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: "2026-06-22T00:00:01.000Z",
        finishedAt: "2026-06-22T00:00:02.000Z",
        updatedAt: "2026-06-22T00:00:02.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(await screen.findByText("cp.software.operations.retry"));

    const [actionSelect] = screen.getAllByRole("combobox");
    if (!actionSelect) throw new Error("single-operation action select was not rendered");
    expect((actionSelect as HTMLSelectElement).value).toBe("load");
    expect(
      (screen.getByPlaceholderText("cp.software.operations.specPlaceholder") as HTMLInputElement)
        .value,
    ).toBe("openmpi@4.1.6");
    expect(cpClient.requestSoftwareOperation).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("cp.software.operations.retryFilled");
  });

  test("disables software operations when the agent control channel is offline", async () => {
    const offlineAgents = overviewAgents.map((agent) => ({
      ...agent,
      runtimeStatus: "offline",
      controlChannelOnline: false,
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: offlineAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: offlineAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    expect(screen.getAllByText("offline").length).toBeGreaterThan(0);
    expect(
      await screen.findByText("cp.software.operations.controlChannelOfflineHint"),
    ).toBeTruthy();
    const specInput = screen.getByPlaceholderText("cp.software.operations.specPlaceholder");
    fireEvent.change(specInput, {
      target: { value: "zlib" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.submit"));
    const form = specInput.closest("form");
    if (!form) throw new Error("software operation form was not rendered");
    fireEvent.submit(form);

    expect(cpClient.requestSoftwareOperation).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("cp.software.operations.controlChannelOfflineHint");
  });

  test("shows feedback when submitting empty software operation forms", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));

    const specInput = screen.getByPlaceholderText("cp.software.operations.specPlaceholder");
    const singleForm = specInput.closest("form");
    if (!singleForm) throw new Error("software operation form was not rendered");
    fireEvent.submit(singleForm);

    expect(cpClient.requestSoftwareOperation).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("cp.software.operations.specRequired");

    const batchForm = screen.getByTestId("cp-software-batch-form");
    fireEvent.submit(batchForm);

    expect(cpClient.requestSoftwareOperationsBatch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("cp.software.operations.batchEmptyHint");
  });

  test("prevents single software operations rejected by the effective policy", async () => {
    const lockedAgents = overviewAgents.map((agent) => ({
      ...agent,
      effectivePolicy: {
        ...agent.effectivePolicy,
        lockEnabled: true,
        allowList: ["gromacs@*"],
      },
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: lockedAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: lockedAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const [actionSelect] = screen.getAllByRole("combobox");
    if (!actionSelect) throw new Error("single-operation action select was not rendered");
    fireEvent.change(actionSelect, { target: { value: "uninstall" } });
    const specInput = screen.getByPlaceholderText("cp.software.operations.specPlaceholder");
    fireEvent.change(specInput, { target: { value: "lammps@2024.1" } });

    expect(await screen.findByText("cp.software.operations.policyRejected")).toBeTruthy();
    const submitButton = screen.getByText("cp.software.operations.submit").closest("button");
    expect(submitButton).toHaveProperty("disabled", true);
    const form = specInput.closest("form");
    if (!form) throw new Error("software operation form was not rendered");
    fireEvent.submit(form);

    expect(cpClient.requestSoftwareOperation).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("cp.software.operations.policyRejected");
  });

  test("allows full Spack specs when policy allowList uses a bare package name", async () => {
    const lockedAgents = overviewAgents.map((agent) => ({
      ...agent,
      effectivePolicy: {
        ...agent.effectivePolicy,
        lockEnabled: true,
        allowList: ["gromacs"],
      },
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: lockedAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: lockedAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperation.mockResolvedValue({
      id: "op-gromacs-full-spec",
      agentId: "agent-a",
      requestedBy: "admin",
      action: "install",
      spec: "gromacs@2024.1 +mpi",
      status: "queued",
      stdout: null,
      stderr: null,
      exitCode: null,
      error: null,
      requestedAt: "2026-06-18T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      updatedAt: "2026-06-18T00:00:00.000Z",
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const specInput = screen.getByPlaceholderText("cp.software.operations.specPlaceholder");
    fireEvent.change(specInput, { target: { value: "gromacs@2024.1 +mpi" } });
    const submitButton = screen.getByText("cp.software.operations.submit").closest("button");
    expect(submitButton).toHaveProperty("disabled", false);
    const form = specInput.closest("form");
    if (!form) throw new Error("software operation form was not rendered");
    fireEvent.submit(form);

    await waitFor(() => {
      expect(cpClient.requestSoftwareOperation).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "install",
        idempotencyKey: expect.stringMatching(UUID_PATTERN),
        spec: "gromacs@2024.1 +mpi",
      });
    });
  });

  test("prevents batch installs containing specs rejected by the effective policy", async () => {
    const lockedAgents = overviewAgents.map((agent) => ({
      ...agent,
      effectivePolicy: {
        ...agent.effectivePolicy,
        lockEnabled: true,
        allowList: ["gromacs@*"],
      },
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: lockedAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: lockedAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const batchText = await screen.findByTestId("cp-software-batch-specs");
    fireEvent.change(batchText, {
      target: { value: "gromacs@2024.1\nlammps@2024.1\nzlib@1.3" },
    });

    const rejectionHint = await screen.findByText(/2 rejected: lammps@2024\.1:/);
    expect(rejectionHint.textContent).not.toContain("allowList");
    expect(rejectionHint.textContent).not.toContain("denyList");
    expect(rejectionHint.textContent).toContain("not included in the current software allow list");
    const rejectionPreview = screen.getByTestId("cp-software-batch-policy-rejections");
    expect(rejectionPreview.textContent).toContain("lammps@2024.1");
    expect(rejectionPreview.textContent).toContain("zlib@1.3");
    const batchButton = screen.getByText("cp.software.operations.batchSubmit").closest("button");
    expect(batchButton).toHaveProperty("disabled", true);
    const form = batchText.closest("form");
    if (!form) throw new Error("batch operation form was not rendered");
    fireEvent.submit(form);

    expect(cpClient.requestSoftwareOperationsBatch).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining("2 rejected in batch: lammps@2024.1:"),
    );
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("allowList"));
    expect(toast.error).not.toHaveBeenCalledWith(expect.stringContaining("denyList"));
  });

  test("prevents installed-spec quick actions rejected by the effective policy", async () => {
    const lockedAgents = overviewAgents.map((agent) => ({
      ...agent,
      effectivePolicy: {
        ...agent.effectivePolicy,
        lockEnabled: true,
        allowList: ["gromacs@*"],
      },
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: lockedAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: lockedAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const loadButton = await screen.findByTestId("cp-software-installed-load-openmpi@4.1.6");
    expect(loadButton).toHaveProperty("disabled", true);
    expect(loadButton.getAttribute("title")).not.toContain("allowList");
    expect(loadButton.getAttribute("title")).not.toContain("denyList");
    fireEvent.click(loadButton);

    expect(cpClient.requestSoftwareOperation).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  test("uses a friendly failed toast instead of installed-spec stdout", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperation.mockResolvedValue({
      id: "op-quick-stdout",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "load",
      spec: "openmpi@4.1.6",
      status: "failed",
      stdout: "spack load failed",
      stderr: null,
      exitCode: 1,
      error: null,
      requestedAt: "2026-06-22T00:00:00.000Z",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:01.000Z",
      updatedAt: "2026-06-22T00:00:01.000Z",
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(await screen.findByTitle("cp.software.operations.action.load"));

    await waitFor(() => {
      expect(cpClient.requestSoftwareOperation).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "load",
        idempotencyKey: expect.stringMatching(UUID_PATTERN),
        spec: "openmpi@4.1.6",
      });
    });
    expect(toast.error).toHaveBeenCalledWith("cp.software.operations.failed");
    expect(toast.error).not.toHaveBeenCalledWith("spack load failed");
  });

  test("allows batch import_preinstalled in a locked policy", async () => {
    const lockedAgents = overviewAgents.map((agent) => ({
      ...agent,
      effectivePolicy: {
        ...agent.effectivePolicy,
        lockEnabled: true,
        allowList: ["gromacs@*"],
      },
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: lockedAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: lockedAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperationsBatch.mockResolvedValue([
      {
        id: "op-import-locked",
        agentId: "agent-a",
        requestedBy: "admin@test",
        action: "import_preinstalled",
        spec: "openmpi@4.1.6",
        status: "queued",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: null,
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const batchAction = await screen.findByTestId("cp-software-batch-action");
    fireEvent.change(batchAction, { target: { value: "import_preinstalled" } });
    fireEvent.change(screen.getByTestId("cp-software-batch-specs"), {
      target: { value: "openmpi@4.1.6" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.batchSubmit"));

    await waitFor(() =>
      expect(cpClient.requestSoftwareOperationsBatch).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "import_preinstalled",
        idempotencyKey: expect.stringMatching(UUID_PATTERN),
        specs: ["openmpi@4.1.6"],
      }),
    );
    expect(screen.queryByText(/rejected:/)).toBeNull();
  });

  test("explains queued operations when the agent control channel goes offline", async () => {
    const offlineAgents = overviewAgents.map((agent) => ({
      ...agent,
      runtimeStatus: "offline",
      controlChannelOnline: false,
    }));
    cpClient.getSoftwareOverview.mockResolvedValue({
      ...overview,
      agents: offlineAgents,
      clusters: overview.clusters.map((cluster) => ({ ...cluster, agents: offlineAgents })),
    });
    cpClient.listSoftwareOperations.mockResolvedValue([
      {
        id: "op-queued-offline",
        agentId: "agent-a",
        requestedBy: "admin@test",
        action: "install",
        spec: "zlib@1.3",
        status: "queued",
        stdout: null,
        stderr: null,
        exitCode: null,
        error: null,
        requestedAt: "2026-06-22T00:00:00.000Z",
        startedAt: null,
        finishedAt: null,
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    ]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));

    expect(await screen.findByText("cp.software.operations.details")).toBeTruthy();
    expect(
      screen.getByTestId("cp-software-operation-delivery-summary-op-queued-offline").textContent,
    ).toBe("cp.software.operations.queuedDeliveryUncertainShort");
    expect(screen.getByText("cp.software.operations.queuedDeliveryUncertain")).toBeTruthy();
  });

  test("selects an install spec from the Spack catalog picker", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    softwareClient.listSpackCatalog.mockResolvedValue({
      source: "spack",
      sourceRepository: "spack/spack-packages",
      sourceRef: "develop",
      generatedAt: "2026-06-18T00:00:00.000Z",
      packageCount: 1,
      upstreamCount: 1,
      customCount: 0,
      totalCount: 1,
      page: 1,
      pageSize: 18,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
      packages: [
        {
          name: "gromacs",
          source: "upstream",
          description: "Molecular dynamics",
          tags: ["md"],
          metadata: {
            versions: ["2024.1"],
            variants: [
              {
                name: "mpi",
                default: "False",
                description: "Enable MPI support",
                values: ["True", "False"],
              },
              {
                name: "cuda_arch",
                default: "none",
                description: "CUDA architecture",
                values: ["70", "80"],
              },
            ],
            dependencies: [],
            provides: [],
            conflicts: [],
            licenses: [],
            maintainers: [],
          },
        },
      ],
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(screen.getByText("cp.software.operations.catalogOpen"));
    const picker = await screen.findByTestId("cp-software-catalog-picker");
    expect(picker.className).toContain("h-[min(88vh,860px)]");
    expect(picker.className).toContain("overflow-hidden");
    expect((await screen.findByTestId("cp-software-catalog-grid")).className).toContain(
      "overflow-auto",
    );
    fireEvent.change(await screen.findByTestId("cp-software-catalog-search"), {
      target: { value: "gromacs" },
    });
    fireEvent.click(await screen.findByTestId("cp-software-catalog-package-upstream-gromacs"));
    fireEvent.change(await screen.findByTestId("cp-software-catalog-version"), {
      target: { value: "2024.1" },
    });
    fireEvent.change(await screen.findByTestId("cp-software-catalog-variant-mpi"), {
      target: { value: "+" },
    });
    fireEvent.change(await screen.findByTestId("cp-software-catalog-variant-cuda_arch"), {
      target: { value: "80" },
    });
    expect(screen.getByDisplayValue("gromacs@2024.1 +mpi cuda_arch=80")).toBeTruthy();
    expect(screen.queryByText("cp.software.operations.catalogUseName")).toBeNull();
    fireEvent.click(screen.getByText("cp.software.operations.catalogUseSpec"));

    await waitFor(() => {
      expect(screen.getByDisplayValue("gromacs@2024.1 +mpi cuda_arch=80")).toBeTruthy();
    });
  });

  test("retries loading the Spack catalog from the picker error state", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    softwareClient.listSpackCatalog
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({
        source: "spack",
        sourceRepository: "spack/spack-packages",
        sourceRef: "develop",
        generatedAt: "2026-06-18T00:00:00.000Z",
        packageCount: 1,
        upstreamCount: 1,
        customCount: 0,
        totalCount: 1,
        page: 1,
        pageSize: 18,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
        packages: [
          {
            name: "hdf5",
            source: "upstream",
            description: "Data model",
            tags: ["io"],
            metadata: {
              versions: ["1.14.3"],
              variants: [],
              dependencies: [],
              provides: [],
              conflicts: [],
              licenses: [],
              maintainers: [],
            },
          },
        ],
      });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(screen.getByText("cp.software.operations.catalogOpen"));

    expect(await screen.findByTestId("cp-software-catalog-retry")).toBeTruthy();
    expect(screen.queryByText("catalog unavailable")).toBeNull();
    fireEvent.click(screen.getByTestId("cp-software-catalog-retry"));

    expect(await screen.findByTestId("cp-software-catalog-package-upstream-hdf5")).toBeTruthy();
    expect(softwareClient.listSpackCatalog).toHaveBeenCalledTimes(2);
  });

  test("clears stale catalog picker rows when a refetch fails", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    softwareClient.listSpackCatalog
      .mockResolvedValueOnce({
        source: "spack",
        sourceRepository: "spack/spack-packages",
        sourceRef: "develop",
        generatedAt: "2026-06-18T00:00:00.000Z",
        packageCount: 1,
        upstreamCount: 1,
        customCount: 0,
        totalCount: 1,
        page: 1,
        pageSize: 18,
        totalPages: 1,
        hasNext: false,
        hasPrevious: false,
        packages: [
          {
            name: "hdf5",
            source: "upstream",
            description: "Data model",
            tags: ["io"],
            metadata: {
              versions: ["1.14.3"],
              variants: [],
              dependencies: [],
              provides: [],
              conflicts: [],
              licenses: [],
              maintainers: [],
            },
          },
        ],
      })
      .mockRejectedValueOnce(new Error("catalog read forbidden"));
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(screen.getByText("cp.software.operations.catalogOpen"));
    expect(await screen.findByTestId("cp-software-catalog-package-upstream-hdf5")).toBeTruthy();

    fireEvent.change(screen.getByTestId("cp-software-catalog-search"), {
      target: { value: "vendor" },
    });

    expect(await screen.findByTestId("cp-software-catalog-retry")).toBeTruthy();
    expect(screen.queryByText("catalog read forbidden")).toBeNull();
    await waitFor(() => {
      expect(softwareClient.listSpackCatalog).toHaveBeenCalledTimes(2);
    });
    expect(screen.queryByTestId("cp-software-catalog-package-upstream-hdf5")).toBeNull();
    expect(screen.getByTestId("cp-software-catalog-grid").textContent).toContain(
      "cp.software.operations.catalogEmpty",
    );
  });

  test("limits the single-operation catalog picker to install and import actions", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const [actionSelect] = screen.getAllByRole("combobox");
    if (!actionSelect) throw new Error("single-operation action select was not rendered");
    const catalogButton = screen.getByText("cp.software.operations.catalogOpen").closest("button");
    if (!catalogButton) throw new Error("single-operation catalog button was not rendered");

    expect(catalogButton).toHaveProperty("disabled", false);
    fireEvent.change(actionSelect, { target: { value: "load" } });
    expect(catalogButton).toHaveProperty("disabled", true);
    expect(catalogButton.getAttribute("title")).toBe(
      "cp.software.operations.catalogUnavailableForAction",
    );
    fireEvent.change(actionSelect, { target: { value: "uninstall" } });
    expect(catalogButton).toHaveProperty("disabled", true);
    fireEvent.change(actionSelect, { target: { value: "import_preinstalled" } });
    expect(catalogButton).toHaveProperty("disabled", false);
  });

  test("clears catalog-derived specs when switching single operation to load or uninstall", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    softwareClient.listSpackCatalog.mockResolvedValue({
      source: "spack",
      sourceRepository: "spack/spack-packages",
      sourceRef: "develop",
      generatedAt: "2026-06-18T00:00:00.000Z",
      packageCount: 1,
      upstreamCount: 1,
      customCount: 0,
      totalCount: 1,
      page: 1,
      pageSize: 18,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
      packages: [
        {
          name: "gromacs",
          source: "upstream",
          description: "Molecular dynamics",
          tags: [],
          metadata: {
            versions: ["2024.1"],
            variants: [],
            dependencies: [],
            provides: [],
            conflicts: [],
            licenses: [],
            maintainers: [],
          },
        },
      ],
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.click(screen.getByText("cp.software.operations.catalogOpen"));
    fireEvent.click(await screen.findByTestId("cp-software-catalog-package-upstream-gromacs"));
    fireEvent.change(await screen.findByTestId("cp-software-catalog-version"), {
      target: { value: "2024.1" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.catalogUseSpec"));
    expect(screen.getByDisplayValue("gromacs@2024.1")).toBeTruthy();

    const [actionSelect] = screen.getAllByRole("combobox");
    if (!actionSelect) throw new Error("single-operation action select was not rendered");
    fireEvent.change(actionSelect, { target: { value: "load" } });
    expect(screen.getByPlaceholderText("cp.software.operations.specPlaceholder")).toHaveProperty(
      "value",
      "",
    );

    const specInput = screen.getByPlaceholderText("cp.software.operations.specPlaceholder");
    fireEvent.change(specInput, { target: { value: "openmpi@4.1.6" } });
    fireEvent.change(actionSelect, { target: { value: "uninstall" } });
    expect(specInput).toHaveProperty("value", "openmpi@4.1.6");
  });

  test("keeps the selected single-operation action when choosing a catalog spec", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperation.mockResolvedValue({
      id: "op-single-import",
      agentId: "agent-a",
      requestedBy: "admin",
      action: "import_preinstalled",
      spec: "hdf5@1.14.3",
      status: "queued",
      stdout: null,
      stderr: null,
      exitCode: null,
      error: null,
      requestedAt: "2026-06-18T00:00:00.000Z",
      startedAt: null,
      finishedAt: null,
      updatedAt: "2026-06-18T00:00:00.000Z",
    });
    softwareClient.listSpackCatalog.mockResolvedValue({
      source: "spack",
      sourceRepository: "spack/spack-packages",
      sourceRef: "develop",
      generatedAt: "2026-06-18T00:00:00.000Z",
      packageCount: 1,
      upstreamCount: 1,
      customCount: 0,
      totalCount: 1,
      page: 1,
      pageSize: 18,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
      packages: [
        {
          name: "hdf5",
          source: "upstream",
          description: "HDF5",
          tags: [],
          metadata: {
            versions: ["1.14.3"],
            variants: [],
            dependencies: [],
            provides: [],
            conflicts: [],
            licenses: [],
            maintainers: [],
          },
        },
      ],
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    const [actionSelect] = screen.getAllByRole("combobox");
    if (!actionSelect) throw new Error("single-operation action select was not rendered");
    fireEvent.change(actionSelect, { target: { value: "import_preinstalled" } });
    fireEvent.click(screen.getByText("cp.software.operations.catalogOpen"));
    fireEvent.click(await screen.findByTestId("cp-software-catalog-package-upstream-hdf5"));
    fireEvent.change(await screen.findByTestId("cp-software-catalog-version"), {
      target: { value: "1.14.3" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.catalogUseSpec"));
    fireEvent.click(screen.getByText("cp.software.operations.submit"));

    await waitFor(() => {
      expect(cpClient.requestSoftwareOperation).toHaveBeenCalledWith({
        agentId: "agent-a",
        action: "import_preinstalled",
        idempotencyKey: expect.stringMatching(UUID_PATTERN),
        spec: "hdf5@1.14.3",
      });
    });
  });

  test("shows an error toast when an operation cannot be dispatched", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperation.mockResolvedValue({
      id: "op-offline",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "zlib",
      status: "failed",
      stdout: null,
      stderr: null,
      exitCode: null,
      error: "agent is offline",
      requestedAt: "2026-06-22T00:00:00.000Z",
      startedAt: null,
      finishedAt: "2026-06-22T00:00:01.000Z",
      updatedAt: "2026-06-22T00:00:01.000Z",
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.change(screen.getByPlaceholderText("cp.software.operations.specPlaceholder"), {
      target: { value: "zlib" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.submit"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("cp.software.operations.failed");
      expect(toast.error).not.toHaveBeenCalledWith("agent is offline");
    });
    expect(toast.success).not.toHaveBeenCalledWith(
      expect.stringContaining("cp.software.operations.queued"),
    );
    expect(
      (screen.getByPlaceholderText("cp.software.operations.specPlaceholder") as HTMLInputElement)
        .value,
    ).toBe("zlib");
  });

  test("uses a friendly failed toast instead of operation stderr", async () => {
    cpClient.getSoftwareOverview.mockResolvedValue(overview);
    cpClient.listSoftwareOperations.mockResolvedValue([]);
    cpClient.requestSoftwareOperation.mockResolvedValue({
      id: "op-single-stderr",
      agentId: "agent-a",
      requestedBy: "admin@test",
      action: "install",
      spec: "zlib",
      status: "failed",
      stdout: null,
      stderr: "spack install failed",
      exitCode: 1,
      error: null,
      requestedAt: "2026-06-22T00:00:00.000Z",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:00:01.000Z",
      updatedAt: "2026-06-22T00:00:01.000Z",
    });
    render(<SoftwarePolicyTable />, { wrapper: makeWrapper() });

    fireEvent.click(await screen.findByText("cp.software.agent.inspect"));
    fireEvent.change(screen.getByPlaceholderText("cp.software.operations.specPlaceholder"), {
      target: { value: "zlib" },
    });
    fireEvent.click(screen.getByText("cp.software.operations.submit"));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("cp.software.operations.failed");
      expect(toast.error).not.toHaveBeenCalledWith("spack install failed");
    });
    expect(
      (screen.getByPlaceholderText("cp.software.operations.specPlaceholder") as HTMLInputElement)
        .value,
    ).toBe("zlib");
  });
});
