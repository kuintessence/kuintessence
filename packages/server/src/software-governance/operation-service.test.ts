import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { agents, createPgDb, type PgDb, softwareOperations } from "@kuintessence/db";
import {
  SoftwareOperationAction as ProtoSoftwareOperationAction,
  SoftwareOperationStatus as ProtoSoftwareOperationStatus,
  type SoftwareOperationResult,
} from "@kuintessence/proto";
import { AppError } from "@kuintessence/shared";
import { count, eq } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import type { InstalledRegistry } from "./installed-registry";
import {
  allowedCurrentStatusesForIncomingResult,
  exitCodeFromResult,
  installedLedgerRefreshFailureMessage,
  mergeEffectiveSpackPolicyLayers,
  normalizeSoftwareOperationAction,
  normalizeSoftwareOperationSpec,
  policyRejectionForSoftwareOperation,
  pushSoftwareOperationSafely,
  SoftwareOperationService,
  shouldApplyOperationResult,
  shouldRefreshInstalledLedger,
  softwareOperationActionFromProto,
  softwareOperationFailureMessage,
} from "./operation-service";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const IDEMPOTENCY_AGENT_IDS = ["software-idempotency-agent-a", "software-idempotency-agent-b"];

async function resetIdempotencyFixtures(db: PgDb): Promise<void> {
  await db
    .delete(softwareOperations)
    .where(eq(softwareOperations.requestedBy, "software-idempotency-user"));
  for (const agentId of IDEMPOTENCY_AGENT_IDS) {
    await db.delete(agents).where(eq(agents.agentId, agentId));
  }
}

describe("software operation request idempotency", () => {
  let db: PgDb;
  let service: SoftwareOperationService;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new SoftwareOperationService(
      db,
      new AgentDispatcher(),
      {} as unknown as InstalledRegistry,
    );
  });

  beforeEach(async () => {
    await resetIdempotencyFixtures(db);
    await db.insert(agents).values(
      IDEMPOTENCY_AGENT_IDS.map((agentId) => ({
        agentId,
        siteName: agentId,
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
      })),
    );
  });

  afterAll(async () => {
    await resetIdempotencyFixtures(db);
  });

  test("returns the same operation for the same actor, key, and normalized payload", async () => {
    const input = {
      scope: {
        orgIds: [],
        isPlatformWide: true,
        principal: { sub: "software-idempotency-user", role: "platform_admin" },
      },
      agentId: IDEMPOTENCY_AGENT_IDS[0] ?? "",
      action: "install" as const,
      spec: " zlib@1.3 ",
      requestedBy: "software-idempotency-user",
      idempotencyKey: "same-request",
      agentScopeVerified: true,
    };

    const first = await service.requestOperation(input);
    const repeated = await service.requestOperation(input);
    const [rows] = await db
      .select({ value: count() })
      .from(softwareOperations)
      .where(eq(softwareOperations.requestedBy, input.requestedBy));

    expect(repeated.id).toBe(first.id);
    expect(rows?.value).toBe(1);
  });

  test("rejects a reused key when the target or payload changes", async () => {
    const base = {
      scope: {
        orgIds: [],
        isPlatformWide: true,
        principal: { sub: "software-idempotency-user", role: "platform_admin" },
      },
      agentId: IDEMPOTENCY_AGENT_IDS[0] ?? "",
      action: "install" as const,
      spec: "zlib@1.3",
      requestedBy: "software-idempotency-user",
      idempotencyKey: "conflicting-request",
      agentScopeVerified: true,
    };
    await service.requestOperation(base);

    try {
      await service.requestOperation({
        ...base,
        agentId: IDEMPOTENCY_AGENT_IDS[1] ?? "",
      });
      throw new Error("expected idempotency conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).statusCode).toBe(409);
    }
  });

  test("reuses stable batch item indexes and rejects a changed batch shape", async () => {
    const requestItem = (spec: string, index: number, itemCount = 2) =>
      service.requestOperation({
        scope: {
          orgIds: [],
          isPlatformWide: true,
          principal: { sub: "software-idempotency-user", role: "platform_admin" },
        },
        agentId: IDEMPOTENCY_AGENT_IDS[0] ?? "",
        action: "install",
        spec,
        requestedBy: "software-idempotency-user",
        idempotencyKey: "batch-request",
        idempotencyItemIndex: index,
        idempotencyItemCount: itemCount,
        agentScopeVerified: true,
      });
    const first = await Promise.all([requestItem("zlib@1.3", 0), requestItem("openmpi@4.1", 1)]);
    const repeated = await Promise.all([requestItem("zlib@1.3", 0), requestItem("openmpi@4.1", 1)]);

    expect(repeated.map((item) => item.id)).toEqual(first.map((item) => item.id));
    await expect(requestItem("zlib@1.3", 0, 3)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("software operation request normalization", () => {
  test("trims specs before they are persisted or dispatched", () => {
    expect(normalizeSoftwareOperationSpec(" zlib@1.3 ")).toBe("zlib@1.3");
  });

  test("rejects blank specs at the service boundary", () => {
    expect(() => normalizeSoftwareOperationSpec(" \n\t ")).toThrow(
      "Software operation spec is required",
    );
  });

  test("accepts supported operation actions at the service boundary", () => {
    expect(normalizeSoftwareOperationAction("install")).toBe("install");
    expect(normalizeSoftwareOperationAction("uninstall")).toBe("uninstall");
    expect(normalizeSoftwareOperationAction("load")).toBe("load");
    expect(normalizeSoftwareOperationAction("import_preinstalled")).toBe("import_preinstalled");
  });

  test("rejects unsupported operation actions at the service boundary", () => {
    expect(() => normalizeSoftwareOperationAction("remove")).toThrow(
      "Unsupported software operation action",
    );
  });
});

describe("software operation result mapping", () => {
  test("maps proto actions to persisted operation actions", () => {
    expect(softwareOperationActionFromProto(ProtoSoftwareOperationAction.INSTALL)).toBe("install");
    expect(softwareOperationActionFromProto(ProtoSoftwareOperationAction.UNINSTALL)).toBe(
      "uninstall",
    );
    expect(softwareOperationActionFromProto(ProtoSoftwareOperationAction.LOAD)).toBe("load");
    expect(softwareOperationActionFromProto(ProtoSoftwareOperationAction.IMPORT_PREINSTALLED)).toBe(
      "import_preinstalled",
    );
    expect(softwareOperationActionFromProto(ProtoSoftwareOperationAction.UNSPECIFIED)).toBeNull();
  });

  test("preserves successful exit code 0", () => {
    expect(exitCodeFromResult("succeeded", 0)).toBe(0);
  });

  test("keeps failed non-zero exit codes", () => {
    expect(exitCodeFromResult("failed", 127)).toBe(127);
  });

  test("does not invent exit codes for running, rejected, or failed-without-code results", () => {
    expect(exitCodeFromResult("running", 0)).toBeNull();
    expect(exitCodeFromResult("rejected", 0)).toBeNull();
    expect(exitCodeFromResult("failed", 0)).toBeNull();
  });
});

describe("software operation failure messages", () => {
  test("formats Error instances with the original message", () => {
    expect(
      softwareOperationFailureMessage("software policy precheck failed", new Error("db down")),
    ).toBe("software policy precheck failed: db down");
  });

  test("formats non-Error throws", () => {
    expect(softwareOperationFailureMessage("agent dispatch failed", "stream closed")).toBe(
      "agent dispatch failed: stream closed",
    );
  });

  test("formats Server installed-ledger refresh failures for operation history", () => {
    expect(installedLedgerRefreshFailureMessage(new Error("unique index violation"))).toBe(
      "server installed ledger refresh failed: unique index violation",
    );
  });
});

describe("software operation installed-ledger refresh guard", () => {
  test("refreshes installed software only after a matched successful mutating operation", () => {
    expect(shouldRefreshInstalledLedger("succeeded", "install", true)).toBe(true);
    expect(shouldRefreshInstalledLedger("succeeded", "uninstall", true)).toBe(true);
    expect(shouldRefreshInstalledLedger("succeeded", "import_preinstalled", true)).toBe(true);
  });

  test("does not refresh installed software for load, failed, or unmatched results", () => {
    expect(shouldRefreshInstalledLedger("succeeded", "load", true)).toBe(false);
    expect(shouldRefreshInstalledLedger("failed", "install", true)).toBe(false);
    expect(shouldRefreshInstalledLedger("succeeded", "install", false)).toBe(false);
  });
});

describe("software operation result application", () => {
  test("marks the operation failed when Server installed-ledger refresh fails", async () => {
    const operationId = "00000000-0000-0000-0000-000000000001";
    const updates: Array<Record<string, unknown>> = [];
    const returningRows: unknown[][] = [[{ id: operationId, action: "install" }]];
    const db = {
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return {
            where: () => ({
              returning: async () => returningRows.shift() ?? [],
            }),
          };
        },
      }),
    } as unknown as PgDb;
    const installedRegistry = {
      replaceForAgent: async () => {
        throw new Error("unique index violation");
      },
    } as unknown as InstalledRegistry;
    const service = new SoftwareOperationService(db, new AgentDispatcher(), installedRegistry);

    await service.applyAgentResult("agent-a", {
      operationId,
      action: ProtoSoftwareOperationAction.INSTALL,
      status: ProtoSoftwareOperationStatus.SUCCEEDED,
      spec: "zlib@1.3",
      stdout: "installed",
      stderr: "",
      exitCode: 0,
      error: "",
      installed: [
        {
          name: "zlib",
          version: "1.3",
          hash: "abc123",
          compiler: "gcc@12",
          arch: "linux-ubuntu22.04-x86_64",
          spec: "zlib@1.3%gcc@12",
        },
      ],
    } as unknown as SoftwareOperationResult);

    expect(updates[0]).toMatchObject({
      status: "succeeded",
      stdout: "installed",
      exitCode: 0,
    });
    expect(updates[1]).toMatchObject({
      status: "failed",
      error: "server installed ledger refresh failed: unique index violation",
    });
  });
});

describe("software operation history listing", () => {
  test("still validates agent existence when route authorization already passed", async () => {
    let operationHistoryQueried = false;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
            orderBy: () => {
              operationHistoryQueried = true;
              return {
                limit: async () => [],
              };
            },
          }),
        }),
      }),
    } as unknown as PgDb;
    const service = new SoftwareOperationService(
      db,
      new AgentDispatcher(),
      {} as unknown as InstalledRegistry,
    );

    await expect(
      service.listOperations({
        scope: {
          orgIds: [],
          isPlatformWide: false,
          principal: { sub: "admin@test", role: "org_admin", orgIds: [] },
        },
        agentId: "ghost-agent",
        agentScopeVerified: true,
      }),
    ).rejects.toThrow("Agent not found");
    expect(operationHistoryQueried).toBe(false);
  });

  test("uses stable recency ordering for operation history", async () => {
    const orderByArgs: unknown[] = [];
    let selectCount = 0;
    const db = {
      select: () => ({
        from: () => {
          selectCount += 1;
          if (selectCount === 1) {
            return {
              where: () => ({
                limit: async () => [
                  {
                    agentId: "agent-a",
                    providerOrgId: "org-a",
                  },
                ],
              }),
            };
          }
          return {
            where: () => ({
              orderBy: (...args: unknown[]) => {
                orderByArgs.push(...args);
                return {
                  limit: async () => [],
                };
              },
            }),
          };
        },
      }),
    } as unknown as PgDb;
    const service = new SoftwareOperationService(
      db,
      new AgentDispatcher(),
      {} as unknown as InstalledRegistry,
    );

    await service.listOperations({
      scope: {
        orgIds: ["org-a"],
        isPlatformWide: false,
        principal: { sub: "admin@test", role: "org_admin", orgIds: ["org-a"] },
      },
      agentId: "agent-a",
      limit: 200,
    });

    expect(orderByArgs).toHaveLength(3);
  });
});

describe("software operation agent business facts", () => {
  test("does not create an operation for a missing agent after enforce authorization", async () => {
    let insertCalled = false;
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [],
          }),
        }),
      }),
      insert: () => {
        insertCalled = true;
        throw new Error("insert should not run");
      },
    } as unknown as PgDb;
    const service = new SoftwareOperationService(
      db,
      new AgentDispatcher(),
      {} as unknown as InstalledRegistry,
    );

    await expect(
      service.requestOperation({
        scope: {
          orgIds: [],
          isPlatformWide: false,
          principal: { sub: "admin@test", role: "org_admin", orgIds: [] },
        },
        agentId: "ghost-agent",
        action: "install",
        spec: "zlib@1.3",
        requestedBy: "00000000-0000-0000-0000-000000000001",
        agentScopeVerified: true,
      }),
    ).rejects.toThrow("Agent not found");
    expect(insertCalled).toBe(false);
  });
});

describe("software operation result state machine", () => {
  test("accepts progress and terminal results before a terminal state", () => {
    expect(shouldApplyOperationResult("queued", "running")).toBe(true);
    expect(shouldApplyOperationResult("queued", "succeeded")).toBe(true);
    expect(shouldApplyOperationResult("running", "failed")).toBe(true);
    expect(shouldApplyOperationResult("running", "rejected")).toBe(true);
  });

  test("ignores stale or duplicate results after a terminal state", () => {
    expect(shouldApplyOperationResult("succeeded", "running")).toBe(false);
    expect(shouldApplyOperationResult("succeeded", "failed")).toBe(false);
    expect(shouldApplyOperationResult("failed", "running")).toBe(false);
    expect(shouldApplyOperationResult("failed", "succeeded")).toBe(false);
    expect(shouldApplyOperationResult("rejected", "running")).toBe(false);
    expect(shouldApplyOperationResult("rejected", "rejected")).toBe(false);
  });

  test("ignores duplicate running results after the start time is recorded", () => {
    expect(shouldApplyOperationResult("running", "running")).toBe(false);
  });

  test("limits database updates to non-terminal rows", () => {
    expect(allowedCurrentStatusesForIncomingResult("running")).toEqual(["queued"]);
    expect(allowedCurrentStatusesForIncomingResult("succeeded")).toEqual(["queued", "running"]);
    expect(allowedCurrentStatusesForIncomingResult("failed")).toEqual(["queued", "running"]);
    expect(allowedCurrentStatusesForIncomingResult("rejected")).toEqual(["queued", "running"]);
  });
});

describe("software operation dispatch guard", () => {
  const payload = {
    operationId: "00000000-0000-0000-0000-000000000001",
    action: ProtoSoftwareOperationAction.INSTALL,
    spec: "zlib@1.3",
    requestedBy: "admin@test",
  };

  test("reports successful dispatch", () => {
    const result = pushSoftwareOperationSafely(
      {
        pushSoftwareOperation: () => true,
      },
      "agent-a",
      payload,
    );

    expect(result).toEqual({ pushed: true });
  });

  test("reports offline dispatch without an error message", () => {
    const result = pushSoftwareOperationSafely(
      {
        pushSoftwareOperation: () => false,
      },
      "agent-a",
      payload,
    );

    expect(result).toEqual({ pushed: false });
  });

  test("converts channel push exceptions into a failed dispatch result", () => {
    const result = pushSoftwareOperationSafely(
      {
        pushSoftwareOperation: () => {
          throw new Error("stream closed");
        },
      },
      "agent-a",
      payload,
    );

    expect(result.pushed).toBe(false);
    expect(result.error).toBe("agent dispatch failed: stream closed");
  });
});

describe("software operation policy precheck", () => {
  test("merges provider, cluster, legacy, and agent policy layers deterministically", () => {
    expect(
      mergeEffectiveSpackPolicyLayers({
        provider: {
          lockEnabled: false,
          allowList: [" zlib@* ", "hdf5@*"],
          denyList: ["bad@*"],
        },
        cluster: {
          lockEnabled: true,
          allowList: ["gromacs@*", "zlib@*"],
          denyList: ["cluster-bad@*"],
        },
        legacy: {
          allowList: ["legacy@*"],
          denyList: ["bad@*", "legacy-bad@*"],
        },
        agentOverlay: {
          allowList: ["agent@*"],
          denyList: ["agent-bad@*"],
        },
      }),
    ).toEqual({
      lockEnabled: true,
      allowList: ["agent@*", "gromacs@*", "hdf5@*", "legacy@*", "zlib@*"],
      denyList: ["agent-bad@*", "bad@*", "cluster-bad@*", "legacy-bad@*"],
    });
  });

  test("returns unlocked empty defaults when no policy layer is present", () => {
    expect(mergeEffectiveSpackPolicyLayers({})).toEqual({
      lockEnabled: false,
      allowList: [],
      denyList: [],
    });
  });

  test("pre-rejects mutating/load operations denied by policy", () => {
    const policy = { lockEnabled: true, allowList: ["gromacs@*"] };

    expect(policyRejectionForSoftwareOperation("install", "lammps@2024.1", policy)).toMatch(
      /allowList/,
    );
    expect(policyRejectionForSoftwareOperation("uninstall", "lammps@2024.1", policy)).toMatch(
      /allowList/,
    );
    expect(policyRejectionForSoftwareOperation("load", "lammps@2024.1", policy)).toMatch(
      /allowList/,
    );
  });

  test("does not pre-reject import_preinstalled", () => {
    expect(
      policyRejectionForSoftwareOperation("import_preinstalled", "lammps@2024.1", {
        lockEnabled: true,
        allowList: ["gromacs@*"],
      }),
    ).toBeNull();
  });
});
