import { expect, test } from "bun:test";
import {
  agentInstalledSoftware,
  agentSoftware,
  agents,
  auditLog,
  type PgDb,
  softwareAssets,
  softwareConcretizeCache,
  softwareOperations,
  softwarePolicies,
  softwarePolicyOverlays,
  spackInstallBindingEvents,
  spackMaterialLifecycleEvents,
} from "@kuintessence/db";
import { SPACK_SOURCE_PROOF_PREFIX, type SpackSourceAuditEnvelope } from "@kuintessence/shared";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { AgentDispatcher } from "../grpc/dispatcher";
import { SoftwareAvailabilityService } from "../services/software-availability";
import type { InstalledRegistry } from "./installed-registry";
import { SoftwareOperationService } from "./operation-service";
import { SourceAuditProofs } from "./source-audit-proofs";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const operationId = "00000000-0000-4000-8000-000000000001";
const requester = "00000000-0000-4000-8000-000000000002";
const fingerprint = "f".repeat(64);
const context = { siteProfileDigest: digest("c"), runtimeDigest: digest("d") };

function fixture() {
  const events: Array<{
    actor: string;
    action: string;
    target: string;
    diff: { after?: unknown };
    createdAt: Date;
    id: string;
  }> = [];
  const agent = {
    agentId: "agent",
    providerOrgId: null,
    siteName: "test",
    status: "online",
    siteOperations: {
      version: 1,
      observedAt: Date.now(),
      transport: "ssh-forward",
      trust: "single-user",
      executor: "slurm",
      materials: { state: "ready" },
      installation: { state: "disabled" },
      jobs: { state: "idle" },
      transfers: { state: "idle" },
      update: { phase: "unknown" },
      auditContext: { ...context },
    },
  };
  const operation = {
    id: operationId,
    agentId: "agent",
    requestedBy: requester,
    action: "install",
    spec: "review@1",
    status: "rejected",
  };
  const binding = {
    scope: "platform",
    state: "enabled",
    revision: 1,
    repositoryId: "a".repeat(64),
    manifestDigest: digest("b"),
  };
  let certificate = true;
  let authorized = true;
  let channelFingerprint = fingerprint;
  let withdrawn = false;
  let currentSessionObserved = true;
  let newerInstallFailed = false;
  const dialect = new PgDialect();
  const db = {
    select: () => ({
      from: (table: unknown) => {
        let condition: SQL | undefined;
        const rows = () => {
          if (table === auditLog) {
            const params = condition ? dialect.sqlToQuery(condition).params : [];
            return events
              .filter((row) => params.includes(row.action) && params.includes(row.target))
              .toReversed();
          }
          if (table === agents) return [agent];
          if (table === softwareOperations) {
            const params = condition ? dialect.sqlToQuery(condition).params : [];
            return newerInstallFailed && !params.includes(operationId)
              ? [{ ...operation, id: requester, status: "failed" }]
              : [operation];
          }
          if (table === spackInstallBindingEvents) return [binding];
          if (table === spackMaterialLifecycleEvents) return withdrawn ? [{ id: "withdrawn" }] : [];
          if (
            table === agentInstalledSoftware ||
            table === agentSoftware ||
            table === softwareAssets ||
            table === softwarePolicies ||
            table === softwarePolicyOverlays
          )
            return [];
          if (table === softwareConcretizeCache)
            return [{ dag: { dependencies: [] }, generatedAt: new Date() }];
          throw new Error("Unexpected table");
        };
        const query = Object.assign(Promise.resolve().then(rows), {
          where: (value: SQL) => {
            condition = value;
            return query;
          },
          orderBy: () => query,
          limit: async (count: number) => rows().slice(0, count),
        });
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: async (value: Omit<(typeof events)[number], "createdAt" | "id">) => {
        expect(table).toBe(auditLog);
        events.push({ ...value, createdAt: new Date(), id: String(events.length) });
      },
    }),
  } as unknown as PgDb;
  const service = new SourceAuditProofs(
    db,
    {
      getChannel: () => ({
        push: () => {},
        close: () => {},
        verifiedCertFingerprint: channelFingerprint,
        ...(currentSessionObserved
          ? {
              siteAuditContext: agent.siteOperations.auditContext,
              siteAuditObservedAt: agent.siteOperations.observedAt,
            }
          : {}),
      }),
    },
    {
      operation: async () => null,
      certificate: async () => certificate,
    },
    async () => authorized,
  );
  const envelope: SpackSourceAuditEnvelope = {
    version: 1,
    operationId,
    spec: operation.spec,
    nativeLockDigest: digest("e"),
    context: { ...context },
    report: {
      version: 1,
      validation: "isolated-source-audit",
      manifestDigest: binding.manifestDigest,
      spackVersion: "1.0.0",
      rootHash: "a".repeat(32),
      nodeCount: 1,
      externalCount: 0,
      verifiedNodeCount: 1,
      passed: true,
      issues: [],
    },
  };
  const dispatch = () =>
    service.dispatched({
      operationId,
      agentId: agent.agentId,
      requestedBy: requester,
      spec: operation.spec,
      repositoryId: binding.repositoryId,
      manifestDigest: binding.manifestDigest,
      nativeLockDigest: envelope.nativeLockDigest,
      certificateFingerprint: fingerprint,
    });
  const accept = (report = envelope, incomingFingerprint: string | undefined = fingerprint) =>
    service.accept(
      "agent",
      operationId,
      SPACK_SOURCE_PROOF_PREFIX + JSON.stringify(report),
      incomingFingerprint,
    );
  return {
    db,
    service,
    dispatch,
    accept,
    envelope,
    agent,
    binding,
    operation,
    events,
    revokeCertificate: () => {
      certificate = false;
    },
    deny: () => {
      authorized = false;
    },
    laterBuildFailure: () => {
      newerInstallFailed = true;
    },
    reconnectWithoutHeartbeat: () => {
      currentSessionObserved = false;
    },
    rotate: () => {
      channelFingerprint = "0".repeat(64);
    },
    withdraw: () => {
      withdrawn = true;
    },
  };
}

test("authorized actual audit survives service reads and revocation cannot be undone by replay", async () => {
  const f = fixture();
  await f.dispatch();
  await f.accept();
  expect((await f.service.get(operationId))?.valid).toBe(true);
  expect(await f.service.available("agent", "review@1")).toBe(true);
  await f.service.revoke(operationId, requester, "materials quarantined");
  await f.accept();
  expect((await f.service.get(operationId))?.revoked).toBe(true);
  expect(await f.service.available("agent", "review@1")).toBe(false);
  expect(f.events.filter((row) => row.action === "software.source-audit.proof")).toHaveLength(1);
});

test("ready telemetry or an audit without an authorized dispatch cannot mint a proof", async () => {
  const f = fixture();
  await f.accept();
  expect(await f.service.get(operationId)).toBeNull();
  await f.dispatch();
  await f.accept(f.envelope, "0".repeat(64));
  expect(await f.service.get(operationId)).toBeNull();
});

test("spec, native lock, manifest, site and runtime substitutions and failed audits are rejected", async () => {
  const mutations: Array<(value: SpackSourceAuditEnvelope) => void> = [
    (p) => {
      p.spec = "review@2";
    },
    (p) => {
      p.operationId = requester;
    },
    (p) => {
      p.nativeLockDigest = digest("f");
    },
    (p) => {
      p.report.manifestDigest = digest("f");
    },
    (p) => {
      p.context.siteProfileDigest = digest("f");
    },
    (p) => {
      p.context.runtimeDigest = digest("f");
    },
    (p) => {
      p.report.passed = false;
      p.report.issues = [{ severity: "error", code: "source-missing" }];
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    await f.dispatch();
    const changed = structuredClone(f.envelope);
    mutate(changed);
    await f.accept(changed);
    expect(await f.service.get(operationId)).toBeNull();
  }
});

test("proofs stop admitting installs after binding, execution, context or identity changes", async () => {
  const mutations: Array<(f: ReturnType<typeof fixture>) => void> = [
    (f) => {
      f.binding.revision++;
    },
    (f) => {
      f.binding.state = "disabled";
    },
    (f) => {
      f.operation.status = "failed";
    },
    (f) => {
      f.agent.siteOperations.auditContext.siteProfileDigest = digest("f");
    },
    (f) => {
      f.agent.siteOperations.auditContext.runtimeDigest = digest("f");
    },
    (f) => {
      f.agent.siteOperations.observedAt -= 600_000;
    },
    (f) => f.revokeCertificate(),
    (f) => f.rotate(),
    (f) => f.deny(),
    (f) => f.withdraw(),
    (f) => f.reconnectWithoutHeartbeat(),
    (f) => f.laterBuildFailure(),
    (f) => {
      const event = f.events.find((row) => row.action === "software.source-audit.proof");
      const proof = event?.diff.after as {
        issuedAt: number;
        expiresAt: number;
        dispatch: { preparedAt: number };
      };
      proof.issuedAt -= 2 * 24 * 60 * 60_000;
      proof.expiresAt -= 2 * 24 * 60 * 60_000;
      proof.dispatch.preparedAt -= 2 * 24 * 60 * 60_000;
    },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    await f.dispatch();
    await f.accept();
    expect((await f.service.get(operationId))?.valid).toBe(true);
    mutate(f);
    expect((await f.service.get(operationId))?.valid).toBe(false);
  }
});

test("a real preinstall audit receipt admits an uninstalled spec, and a subsequent build failure removes admission", async () => {
  const f = fixture();
  await f.dispatch();
  await f.accept();
  const availability = new SoftwareAvailabilityService(f.db, {
    onlineAgentIds: () => ["agent"],
    sourceAuditAvailable: (agentId, spec) => f.service.available(agentId, spec),
  });
  const principal = {
    sub: requester,
    userId: requester,
    email: "admin@example.invalid",
    role: "platform_admin",
    orgId: null,
    orgIds: [],
    memberships: [],
    capabilities: [],
  };
  const admitted = await availability.resolve(
    { rawSpec: "review@1", installable: true },
    principal,
  );
  expect(admitted.installedAvailable).toHaveLength(0);
  expect(admitted.installableAvailable[0]?.agentId).toBe("agent");
  f.operation.status = "failed";
  const blocked = await availability.resolve({ rawSpec: "review@1", installable: true }, principal);
  expect(blocked.installableAvailable).toHaveLength(0);
  expect(blocked.blocked[0]?.reasons).toContain(
    "offline site material closure has not been verified",
  );
});

test("audit-only operation views report audit success without declaring an installed build", async () => {
  const f = fixture();
  Object.assign(f.operation, {
    idempotencyKey: "source-audit:fixture",
    stdout: SPACK_SOURCE_PROOF_PREFIX + JSON.stringify(f.envelope),
    stderr: null,
    exitCode: null,
    error: "Spack source audit completed; installation was not requested",
    requestedAt: new Date(),
    startedAt: new Date(),
    finishedAt: new Date(),
    updatedAt: new Date(),
  });
  const service = new SoftwareOperationService(
    f.db,
    new AgentDispatcher(),
    {} as InstalledRegistry,
  );
  const view = await service.getOperation(operationId);
  expect(view).toMatchObject({
    auditOnly: true,
    auditStatus: "passed",
    status: "succeeded",
    error: null,
  });
  expect(f.operation.status).toBe("rejected");
});
