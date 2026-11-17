import type { CpSoftwareOverview } from "../../src/lib/cp-client";

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

export const overview: CpSoftwareOverview = {
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
