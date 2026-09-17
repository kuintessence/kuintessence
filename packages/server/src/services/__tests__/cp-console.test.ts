// CP Console service unit tests with in-memory port fakes.
import { describe, expect, it } from "bun:test";
import { ErrorCode } from "@kuintessence/shared";
import type { CpScope } from "../../middleware/cp-rbac";
import {
  type AgentsServicePort,
  type AuditServicePort,
  type CpConsoleDeps,
  CpConsoleService,
  type JobsServicePort,
  type NetdriveServicePort,
  type OrganizationDirectoryPort,
  type QueueDepthSamplerPort,
  type SoftwareGovernancePort,
  type UsersServicePort,
} from "../cp-console";

function emptySoftwareOverview() {
  return {
    providerOrgIds: ["org-A"],
    providerPolicy: null,
    clusters: [],
    agents: [],
    summary: {
      clusters: 0,
      agents: 0,
      lockedAgents: 0,
      overrides: 0,
      mirrors: 0,
      preinstalledSpecs: 0,
      installedSpecs: 0,
    },
  };
}

function fakes(): CpConsoleDeps {
  const jobs: JobsServicePort = {
    countCompletedSince: async () => 42,
    countFailedSince: async () => 3,
    topUsersByJobs: async () => [
      { userId: "u-1", jobs: 20 },
      { userId: "u-2", jobs: 15 },
    ],
    topAppsByJobs: async () => [{ appKey: "gromacs", jobs: 30 }],
  };
  const agents: AgentsServicePort = {
    countByHealth: async () => ({ healthy: 4, sick: 1, offline: 0 }),
    listForOrgs: async () => [
      { id: "a-1", hostname: "h1", siteId: "groupa-site-1", status: "healthy" },
    ],
    listByIds: async () => [
      { id: "a-1", hostname: "h1", siteId: "groupa-site-1", status: "healthy" },
    ],
  };
  const audit: AuditServicePort = {
    search: async () => ({ total: 0, items: [] }),
  };
  const software: SoftwareGovernancePort = {
    listPolicies: async () => [
      { cluster: "cluster-A", whitelist: ["gromacs@*"], blacklist: [], locked: false },
    ],
    getOverview: async () => emptySoftwareOverview(),
    saveProviderPolicy: async () => emptySoftwareOverview(),
    saveClusterPolicy: async () => emptySoftwareOverview(),
    saveAgentPolicy: async () => emptySoftwareOverview(),
    reviewPreinstalledMapping: async () => emptySoftwareOverview(),
    setPolicy: async () => {},
  };
  const users: UsersServicePort = {
    listInOrgs: async () => ({
      total: 2,
      items: [
        { id: "u-1", email: "a@x.test", role: "user", suspended: false, quota: 100 },
        { id: "u-2", email: "b@x.test", role: "user", suspended: false, quota: 100 },
      ],
    }),
    setSuspended: async () => {},
    setQuota: async () => {},
  };
  const netdrive: NetdriveServicePort = {
    bytesTransferredSince: async () => 1_234_567,
  };
  const queueSampler: QueueDepthSamplerPort = {
    peakSince: async () => 87,
  };
  const organizations: OrganizationDirectoryPort = {
    listVisible: async () => [{ id: "org-A", name: "Org A" }],
  };
  return { jobs, agents, audit, software, users, netdrive, queueSampler, organizations };
}

const scope: CpScope = {
  orgIds: ["org-A"],
  isPlatformWide: false,
  principal: { sub: "u-admin", role: "org_admin", orgIds: ["org-A"] },
};

describe("CpConsoleService.getDashboardKpis", () => {
  it("aggregates last-24h KPIs from all collaborators", async () => {
    const svc = new CpConsoleService({ ...fakes(), now: () => new Date("2026-04-30T12:00:00Z") });
    const r = await svc.getDashboardKpis(scope);
    expect(r.jobsCompleted).toBe(42);
    expect(r.jobsFailed).toBe(3);
    expect(r.bytesTransferred).toBe(1_234_567);
    expect(r.queueDepthPeak).toBe(87);
    expect(r.agentsHealthy).toBe(4);
    expect(r.topUsers.length).toBe(2);
    expect(r.topUsers[0]).toEqual({
      userId: "u-1",
      jobs: 20,
      displayName: "a",
      email: "a@x.test",
      organizationName: "Org A",
    });
    expect(r.topApps[0]?.appKey).toBe("gromacs");
    // 24h window.
    const from = new Date(r.windowFrom);
    const to = new Date(r.windowTo);
    expect(to.getTime() - from.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("CpConsoleService.listSoftwarePolicies", () => {
  it("returns policies for the CP's orgs", async () => {
    const svc = new CpConsoleService(fakes());
    const r = await svc.listSoftwarePolicies(scope);
    expect(r.length).toBe(1);
    expect(r[0]?.cluster).toBe("cluster-A");
  });
});

describe("CpConsoleService.listAgentsByIds", () => {
  it("delegates a SpiceDB-authorized agent id set without widening CP scope", async () => {
    const captured: string[][] = [];
    const f = fakes();
    f.agents.listByIds = async (agentIds) => {
      captured.push(agentIds);
      return [{ id: "a-2", hostname: "h2", siteId: "groupa-site-2", status: "offline" }];
    };
    const svc = new CpConsoleService(f);

    const result = await svc.listAgentsByIds(["a-2"]);

    expect(captured).toEqual([["a-2"]]);
    expect(result.map((agent) => agent.id)).toEqual(["a-2"]);
  });
});

describe("CpConsoleService.listRegistrationProviderOrgs", () => {
  it("delegates to the visible organization directory", async () => {
    const captured: CpScope[] = [];
    const f = fakes();
    f.organizations.listVisible = async (input) => {
      captured.push(input);
      return [{ id: "org-A", name: "Org A" }];
    };
    const svc = new CpConsoleService(f);
    const r = await svc.listRegistrationProviderOrgs(scope);
    expect(r).toEqual([{ id: "org-A", name: "Org A" }]);
    expect(captured[0]).toEqual(scope);
  });
});

describe("CpConsoleService.editSoftwarePolicy", () => {
  it("forwards to software-governance.setPolicy", async () => {
    let called = false;
    const f = fakes();
    f.software.setPolicy = async () => {
      called = true;
    };
    const svc = new CpConsoleService(f);
    await svc.editSoftwarePolicy(scope, {
      cluster: "cluster-A",
      list: "whitelist",
      specs: ["gromacs@2024.1"],
    });
    expect(called).toBe(true);
  });
});

describe("CpConsoleService.listUsers", () => {
  it("delegates to users.listInOrgs with scope orgs", async () => {
    const captured: { orgIds: string[]; limit: number; offset: number }[] = [];
    const f = fakes();
    f.users.listInOrgs = async (q) => {
      captured.push({ orgIds: q.orgIds, limit: q.limit, offset: q.offset });
      return { total: 0, items: [] };
    };
    const svc = new CpConsoleService(f);
    await svc.listUsers(scope, { search: "abc", limit: 10, offset: 5 });
    expect(captured[0]).toEqual({ orgIds: ["org-A"], limit: 10, offset: 5 });
  });
});

describe("CpConsoleService.setUserSuspended", () => {
  it("rejects users outside scope", async () => {
    const f = fakes();
    f.users.listInOrgs = async () => ({ total: 0, items: [] });
    const svc = new CpConsoleService(f);
    await expect(
      svc.setUserSuspended(scope, "u-NOT-IN-SCOPE", true, { actor: "admin", orgId: "org-A" }),
    ).rejects.toThrow("not in CP scope");
  });
  it("rejects in-scope users without invoking the mutating port", async () => {
    const f = fakes();
    let setCalled = false;
    f.users.setSuspended = async () => {
      setCalled = true;
    };
    const svc = new CpConsoleService(f);

    await expect(
      svc.setUserSuspended(scope, "u-1", true, { actor: "admin", orgId: "org-A" }),
    ).rejects.toMatchObject({
      code: ErrorCode.CP_GOVERNANCE_WRITE_DISABLED,
      statusCode: 503,
    });
    expect(setCalled).toBe(false);
  });
  it("rejects platform-wide writes without invoking the mutating port", async () => {
    const f = fakes();
    let setCalled = false;
    f.users.setSuspended = async () => {
      setCalled = true;
    };
    f.users.listInOrgs = async () => ({ total: 0, items: [] });
    const svc = new CpConsoleService(f);
    const wide: CpScope = { ...scope, isPlatformWide: true };
    await expect(
      svc.setUserSuspended(wide, "u-elsewhere", true, { actor: "admin", orgId: "org-A" }),
    ).rejects.toMatchObject({
      code: ErrorCode.CP_GOVERNANCE_WRITE_DISABLED,
      statusCode: 503,
    });
    expect(setCalled).toBe(false);
  });
});

describe("CpConsoleService.setUserQuota", () => {
  it("rejects negative quota", async () => {
    const svc = new CpConsoleService(fakes());
    await expect(
      svc.setUserQuota(scope, "u-1", -1, { actor: "admin", orgId: "org-A" }),
    ).rejects.toThrow("non-negative");
  });
  it("rejects non-integer quota", async () => {
    const svc = new CpConsoleService(fakes());
    await expect(
      svc.setUserQuota(scope, "u-1", 1.5, { actor: "admin", orgId: "org-A" }),
    ).rejects.toThrow("non-negative");
  });
  it("rejects an in-scope quota write without invoking the mutating port", async () => {
    const f = fakes();
    let setCalled = false;
    f.users.setQuota = async () => {
      setCalled = true;
    };
    const svc = new CpConsoleService(f);

    await expect(
      svc.setUserQuota(scope, "u-1", 42, { actor: "admin", orgId: "org-A" }),
    ).rejects.toMatchObject({
      code: ErrorCode.CP_GOVERNANCE_WRITE_DISABLED,
      statusCode: 503,
    });
    expect(setCalled).toBe(false);
  });
});

describe("CpConsoleService.searchAudit", () => {
  it("rejects from > to", async () => {
    const svc = new CpConsoleService(fakes());
    await expect(
      svc.searchAudit(scope, {
        from: "2026-04-30T01:00:00Z",
        to: "2026-04-29T23:00:00Z",
      }),
    ).rejects.toThrow("'from' must be <= 'to'");
  });
  it("rejects invalid timestamps", async () => {
    const svc = new CpConsoleService(fakes());
    await expect(
      svc.searchAudit(scope, { from: "not-a-date", to: "2026-04-30Z" }),
    ).rejects.toThrow();
  });
});
