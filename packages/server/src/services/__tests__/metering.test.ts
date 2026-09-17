// Metering service unit tests.

import { beforeEach, describe, expect, it } from "bun:test";
import {
  InMemoryMeteringRepository,
  type JobUsageRecord,
  MeteringService,
  narrowScope,
  tenantScopeFromPrincipal,
} from "../metering";

function record(overrides: Partial<JobUsageRecord> = {}): JobUsageRecord {
  const finishedAt = overrides.finishedAt ?? new Date("2026-04-15T10:30:00Z");
  return {
    jobId: overrides.jobId ?? crypto.randomUUID(),
    userId: overrides.userId ?? "00000000-0000-0000-0000-000000000001",
    orgId: overrides.orgId ?? "00000000-0000-0000-0000-0000000000a1",
    agentId: "agent-1",
    clusterName: "cluster-A",
    appTemplateKey: "gromacs",
    cpuCoreSeconds: 32 * 60,
    gpuSeconds: 0,
    memoryMbSeconds: 1024 * 60,
    storageMbSeconds: 0,
    networkEgressMb: 0,
    startedAt: new Date(finishedAt.getTime() - 60_000),
    finishedAt,
    ...overrides,
  };
}

describe("MeteringService.recordJobCompletion", () => {
  let repo: InMemoryMeteringRepository;
  let svc: MeteringService;
  beforeEach(() => {
    repo = new InMemoryMeteringRepository();
    svc = new MeteringService({ repo });
  });

  it("inserts a raw row and assigns an id", async () => {
    const r = await svc.recordJobCompletion(record({ jobId: "job-1" }));
    expect(r).not.toBeNull();
    expect(r?.id).toBeTruthy();
    expect(repo.snapshot().raw.length).toBe(1);
  });

  it("is idempotent on jobId", async () => {
    await svc.recordJobCompletion(record({ jobId: "job-1" }));
    const second = await svc.recordJobCompletion(record({ jobId: "job-1" }));
    expect(second).toBeNull();
    expect(repo.snapshot().raw.length).toBe(1);
  });

  it.each([
    [{ jobId: "" } as Partial<JobUsageRecord>, "jobId required"],
    [{ orgId: "" } as Partial<JobUsageRecord>, "orgId required"],
    [{ agentId: "" } as Partial<JobUsageRecord>, "agentId required"],
    [{ clusterName: "" } as Partial<JobUsageRecord>, "clusterName required"],
  ])("rejects invalid records (%s)", async (override, expectedSubstring) => {
    expect(svc.recordJobCompletion(record(override))).rejects.toThrow(expectedSubstring);
  });

  it("rejects finishedAt < startedAt", async () => {
    expect(
      svc.recordJobCompletion(
        record({
          startedAt: new Date("2026-04-15T11:00:00Z"),
          finishedAt: new Date("2026-04-15T10:00:00Z"),
        }),
      ),
    ).rejects.toThrow();
  });
});

describe("MeteringService.query", () => {
  let svc: MeteringService;
  let repo: InMemoryMeteringRepository;
  beforeEach(async () => {
    repo = new InMemoryMeteringRepository();
    svc = new MeteringService({ repo });
    await svc.recordJobCompletion(
      record({
        orgId: "org-A",
        userId: "user-1",
        clusterName: "cluster-A",
        cpuCoreSeconds: 100,
        finishedAt: new Date("2026-04-15T10:00:00Z"),
      }),
    );
    await svc.recordJobCompletion(
      record({
        orgId: "org-A",
        userId: "user-2",
        clusterName: "cluster-A",
        cpuCoreSeconds: 200,
        finishedAt: new Date("2026-04-15T10:30:00Z"),
      }),
    );
    await svc.recordJobCompletion(
      record({
        orgId: "org-B",
        userId: "user-3",
        clusterName: "cluster-B",
        cpuCoreSeconds: 999,
        finishedAt: new Date("2026-04-15T10:45:00Z"),
      }),
    );
  });

  it("scope=orgs[A] hides org-B rows", async () => {
    const result = await svc.query(
      { kind: "orgs", orgIds: ["org-A"] },
      {
        from: "2026-04-15T00:00:00.000Z",
        to: "2026-04-15T23:59:59.000Z",
        period: "raw",
        grouping: "user",
        limit: 100,
        offset: 0,
      },
    );
    const seenUsers = result.rows.map((r) => r.groupKey).sort();
    expect(seenUsers).toEqual(["user-1", "user-2"]);
  });

  it("scope=all returns all 3 users", async () => {
    const result = await svc.query(
      { kind: "all" },
      {
        from: "2026-04-15T00:00:00.000Z",
        to: "2026-04-15T23:59:59.000Z",
        period: "raw",
        grouping: "user",
        limit: 100,
        offset: 0,
      },
    );
    expect(result.rows.length).toBe(3);
  });

  it("grouping=cluster collapses to per-cluster rows", async () => {
    const result = await svc.query(
      { kind: "all" },
      {
        from: "2026-04-15T00:00:00.000Z",
        to: "2026-04-15T23:59:59.000Z",
        period: "raw",
        grouping: "cluster",
        limit: 100,
        offset: 0,
      },
    );
    const groups = result.rows.map((r) => r.groupKey).sort();
    expect(groups).toEqual(["cluster-A", "cluster-B"]);
  });

  it("rejects from > to", async () => {
    expect(
      svc.query(
        { kind: "all" },
        {
          from: "2026-04-15T11:00:00.000Z",
          to: "2026-04-15T10:00:00.000Z",
          period: "raw",
          grouping: "user",
          limit: 100,
          offset: 0,
        },
      ),
    ).rejects.toThrow("'from' must be <= 'to'");
  });
});

describe("tenantScopeFromPrincipal", () => {
  it("super_admin defaults to all", () => {
    const s = tenantScopeFromPrincipal({ role: "super_admin", sub: "u1" });
    expect(s.kind).toBe("all");
  });

  it("super_admin can request specific orgs", () => {
    const s = tenantScopeFromPrincipal({ role: "super_admin", sub: "u1" }, ["org-A", "org-B"]);
    expect(s).toEqual({ kind: "orgs", orgIds: ["org-A", "org-B"] });
  });

  it("operator has platform view scope", () => {
    const s = tenantScopeFromPrincipal({ role: "operator", sub: "u1" });
    expect(s.kind).toBe("all");
  });

  it("regular user is locked to own org", () => {
    const s = tenantScopeFromPrincipal({ role: "user", orgId: "org-A", sub: "u1" });
    expect(s).toEqual({ kind: "orgs", orgIds: ["org-A"] });
  });

  it("user without orgId sees nothing", () => {
    const s = tenantScopeFromPrincipal({ role: "user", sub: "u1" });
    expect(s).toEqual({ kind: "orgs", orgIds: [] });
  });
});

describe("narrowScope", () => {
  it("intersects requested orgs with granted scope", () => {
    const s = narrowScope({ kind: "orgs", orgIds: ["org-A", "org-B"] }, ["org-B", "org-C"]);
    expect(s).toEqual({ kind: "orgs", orgIds: ["org-B"] });
  });

  it("expands all-scope to requested orgs", () => {
    const s = narrowScope({ kind: "all" }, ["org-X"]);
    expect(s).toEqual({ kind: "orgs", orgIds: ["org-X"] });
  });

  it("ignores empty/undefined requested orgs", () => {
    expect(narrowScope({ kind: "all" }, undefined)).toEqual({ kind: "all" });
    expect(narrowScope({ kind: "all" }, [])).toEqual({ kind: "all" });
  });
});
