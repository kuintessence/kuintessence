import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  createPgDb,
  federationAgreementApprovals,
  federationMaterials,
  federationSites,
  orgs,
  userOrgMemberships,
  users,
  workflowRuns,
} from "@kuintessence/db";
import { type JobSubmit, workflowDsl } from "@kuintessence/shared";
import {
  assertDelegationTerms,
  type FederationClusterQueueConfig,
  FederationClusterQueueConfigSchema,
  type FederationDelegation,
} from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { JobService } from "../services/job-service";
import { WorkflowAsyncRunner } from "../workflow/async-runner";
import { WorkflowExecutionJournalStore } from "../workflow/execution-journal";
import { WorkflowRunRegistry } from "../workflow/run-registry";
import { FederationAssetService, federationMaterialDigest } from "./assets";
import { assertManagedClusterRequest, FederationClusterQueueService } from "./cluster-queues";
import { FederationJobService } from "./jobs";
import { configureFederationLabDefaults, FederationPermissionService } from "./permissions";
import { testAgreement, testDelegation, testNow } from "./test-fixtures";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 4, idle_timeout: 1 });
const orgId = crypto.randomUUID();
const admin = { orgId, userId: crypto.randomUUID() };
const user = { orgId, userId: crypto.randomUUID() };
const other = { orgId, userId: crypto.randomUUID() };
const guest = { orgId, userId: crypto.randomUUID() };
const siteId = crypto.randomUUID(),
  targetId = crypto.randomUUID();
const terms = testAgreement(siteId, targetId, "bilateral_attested");
const executionTarget = {
  providerOrgId: crypto.randomUUID(),
  clusterId: "remote-hpc",
  agentId: "remote-agent",
  queueId: "remote-queue",
};
terms.executionTargets = [executionTarget, { ...executionTarget, queueId: "other-queue" }];
const inputs = { protocolVersion: 1, kind: "inputs", parameters: {}, datasets: [], bindings: [] };
const environment = {
  protocolVersion: 1,
  kind: "environment-lock",
  target: { platform: "linux", architecture: "x86_64" },
  nativeLockDigest: `sha256:${"a".repeat(64)}`,
  software: [],
};
const template = terms.templates[0];
if (!template) throw new Error("Template is required");
const config: FederationClusterQueueConfig = FederationClusterQueueConfigSchema.parse({
  localOrgId: orgId,
  name: "Partner CPU",
  clusterName: "Partner CPU",
  schedulerType: "slurm",
  queueName: "batch",
  agreementRevisionId: terms.agreementRevisionId,
  executionTarget,
  allowAllMembers: false,
  allowedUserIds: [user.userId],
  profiles: [
    {
      id: crypto.randomUUID(),
      name: "Shell computation",
      source: { kind: "command", commandParameter: "command" },
      template,
      inputManifestDigest: federationMaterialDigest(inputs),
      environmentLockDigest: federationMaterialDigest(environment),
      maxAmount: "10",
      outputs: [],
    },
  ],
});
const assets = new FederationAssetService(db, { authorizeSoftware: async () => {} });
const service = new FederationClusterQueueService(db, siteId, assets, () => testNow);
const permissions = new FederationPermissionService(db);
const principal: BoundPrincipal & { role: "user" } = {
  ...user,
  orgIds: [orgId],
  memberships: [{ orgId, role: "member" }],
  role: "user",
  email: "member@example.test",
  sub: user.userId,
  capabilities: [],
};
const context = { ...principal, role: "user" as const };

beforeAll(async () => {
  await db.insert(orgs).values({ id: orgId, name: "Research institute" });
  for (const [actor, role] of [
    [admin, "platform_admin"],
    [user, "user"],
    [other, "user"],
    [guest, "guest"],
  ] as const) {
    await db
      .insert(users)
      .values({ id: actor.userId, orgId, role, email: `${actor.userId}@example.test` });
    await db.insert(userOrgMemberships).values({ ...actor, role: "member" });
  }
  await db.insert(federationSites).values([
    { id: siteId, name: "Home institute", endpoint: "https://home.example.test" },
    { id: targetId, name: "Partner institute", endpoint: "https://partner.example.test" },
  ]);
  await db.insert(federationAgreementApprovals).values({
    localSiteId: siteId,
    localOrgId: orgId,
    revisionId: terms.agreementRevisionId,
    terms,
    termsDigest: terms.termsDigest,
    approvalJws: "approval",
    counterpartyApprovalJws: "counterparty",
    approvedBy: admin.userId,
  });
  for (const material of [inputs, environment])
    await db.insert(federationMaterials).values({
      localOrgId: orgId,
      originSiteId: siteId,
      digest: federationMaterialDigest(material),
      kind: material.kind,
      content: JSON.stringify(material),
      createdBy: admin.userId,
    });
  configureFederationLabDefaults(true);
});
afterAll(async () => {
  configureFederationLabDefaults(false);
  await db.$client.end();
});

test("lab defaults grant administration to platform admins and scoped use to ordinary users", async () => {
  const a = await permissions.current(admin);
  const u = await permissions.current(user);
  expect(a.effectiveCapabilities).toContain("cluster.manage");
  expect(a.effectiveCapabilities).toContain("agreement.approve");
  expect(u.grants).toEqual(["cluster.use"]);
  expect((await permissions.current(guest)).grants).toEqual([]);
  expect(u.effectiveCapabilities).not.toContain("agreement.read");
  expect(u.effectiveCapabilities).not.toContain("delegation.submit");
  expect(u.effectiveCapabilities).not.toContain("asset.map");
});

test("authorized queues join local selection; label hiding leaves the target unchanged", async () => {
  const created = await service.save(admin, config);
  expect(
    (await service.listVisible(context)).find((queue) => queue.queueId === created.id)?.federation
      ?.partnerName,
  ).toBe("Partner institute");
  expect(await service.listVisible({ ...context, userId: other.userId })).toEqual([]);
  await service.save(admin, { ...config, showPartnerLabel: false }, created.id);
  const visible = (await service.listVisible(context)).find(
    (queue) => queue.queueId === created.id,
  );
  expect(visible?.federation?.partnerName).toBeNull();
  const preview = await service.previewJob(user, {
    name: "Count reads",
    command: "true",
    resources: { cpus: 1, memoryMb: 64 },
    schedulingStrategy: { queueId: created.id },
  });
  expect(preview?.federation?.clusterName).toBe(config.clusterName);
  expect(preview?.finalDecision).toBeNull();
  expect(JSON.stringify(preview)).not.toContain(targetId);
  expect((await service.selected(user, created.id))?.row.config.executionTarget).toEqual(
    executionTarget,
  );
  await expect(service.selected(other, created.id)).rejects.toThrow("POLICY_DENIED");
});

test("an empty selected member list does not accidentally authorize the whole organization", async () => {
  const saved = await service.save(admin, { ...config, allowedUserIds: [] });
  await expect(service.selected(user, saved.id)).rejects.toThrow("POLICY_DENIED");
  await service.save(admin, { ...config, allowAllMembers: true, allowedUserIds: [] }, saved.id);
  expect(await service.selected(other, saved.id)).not.toBeNull();
});

test("configuration cannot choose an unsigned queue or exceed its allowance", async () => {
  await expect(
    service.save(admin, {
      ...config,
      executionTarget: { ...executionTarget, queueId: "not-approved" },
    }),
  ).rejects.toThrow("not authorized");
  await expect(
    service.save(admin, {
      ...config,
      profiles: config.profiles.map((p) => ({ ...p, maxAmount: "61" })),
    }),
  ).rejects.toThrow("allowance");
  await expect(service.save(user, config)).rejects.toThrow("POLICY_DENIED");
});

test("the exact target is part of delegation policy and cannot expand the signed agreement", () => {
  const request = { ...testDelegation(terms), executionTarget };
  expect(() => assertDelegationTerms(terms, request, testNow)).not.toThrow();
  expect(() =>
    assertDelegationTerms(
      terms,
      { ...request, executionTarget: { ...executionTarget, queueId: "not-approved" } },
      testNow,
    ),
  ).toThrow("POLICY_DENIED");
});

test("managed send rechecks member authorization and refuses unmanaged use", async () => {
  const saved = await service.save(admin, config);
  const profile = config.profiles[0];
  if (!profile) throw new Error("Missing profile");
  const request: FederationDelegation = {
    ...testDelegation(terms),
    executionTarget,
    managedPlacement: { queueId: saved.id, profileId: profile.id },
    inputManifestDigest: profile.inputManifestDigest,
    environmentLockDigest: profile.environmentLockDigest,
    maxAmount: profile.maxAmount,
  };
  await db.transaction((tx) => assertManagedClusterRequest(tx, user, request, assets));
  await expect(
    db.transaction((tx) => assertManagedClusterRequest(tx, other, request, assets)),
  ).rejects.toThrow("POLICY_DENIED");
  await expect(
    db.transaction((tx) =>
      assertManagedClusterRequest(tx, user, { ...request, managedPlacement: undefined }, assets),
    ),
  ).rejects.toThrow("POLICY_DENIED");
  await service.remove(admin, saved.id);
  await expect(
    db.transaction((tx) => assertManagedClusterRequest(tx, user, request, assets)),
  ).rejects.toThrow("POLICY_DENIED");
});

test("job selection produces a durable delegation and never inserts a remote ID into a local queue foreign key", async () => {
  const saved = await service.save(admin, config);
  const data: JobSubmit = {
    name: "Sequence summary",
    command: "printf ready",
    resources: { cpus: 1, memoryMb: 64, wallTimeSec: 10 },
    schedulingStrategy: { queueId: saved.id },
  };
  const node = await service.prepareJob(user, data);
  if (!node) throw new Error("Remote queue was not selected");
  const registry = new WorkflowRunRegistry(db);
  const runner = new WorkflowAsyncRunner({
    registry,
    journal: new WorkflowExecutionJournalStore(db),
    makeRunner: () => async () => ({ status: {}, values: {} }),
    schedule: () => {},
  });
  const jobService = new JobService(db);
  const remoteJobs = new FederationJobService(db, jobService, runner, service);
  const submitted = await remoteJobs.submit(data, principal, node, async () => {});
  expect(submitted.federationRunId).toBeString();
  expect(submitted.queueId).toBeNull();
  expect(submitted.federationQueueId).toBe(saved.id);
  const run = await registry.getById(submitted.federationRunId ?? "");
  expect(run?.input?.executionModel).toBe("durable-v2");
  expect(run?.input?.yaml).toContain("managedPlacement");
  await remoteJobs.reconcile(submitted.id);
  expect((await jobService.getById(submitted.id))?.status).toBe("queued");
  await remoteJobs.cancel(submitted);
  expect((await jobService.getById(submitted.id))?.status).toBe("cancelled");
  const running = await remoteJobs.submit(data, principal, node, async () => {});
  await db
    .update(workflowRuns)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(workflowRuns.id, running.federationRunId ?? ""));
  await remoteJobs.cancel(running);
  expect((await jobService.getById(running.id))?.status).toBe("running");
  expect((await registry.getById(running.federationRunId ?? ""))?.status).toBe("cancelling");
  await db
    .update(workflowRuns)
    .set({ status: "cancelled" })
    .where(eq(workflowRuns.id, running.federationRunId ?? ""));
  await remoteJobs.reconcile(running.id);
  expect((await jobService.getById(running.id))?.status).toBe("cancelled");
  const completed = await remoteJobs.submit(data, principal, node, async () => {});
  const output = { fileMetadataId: crypto.randomUUID(), fileMetadataName: "alignment.sam" };
  await db
    .update(workflowRuns)
    .set({
      status: "completed",
      result: {
        status: { compute: "Succeeded" },
        values: { compute: { status: "Succeeded", values: { alignment: output } } },
      },
    })
    .where(eq(workflowRuns.id, completed.federationRunId ?? ""));
  await remoteJobs.reconcile(completed.id);
  expect((await jobService.getById(completed.id))?.federationOutputs).toEqual({
    alignment: [output],
  });
  expect((await jobService.getById(completed.id))?.status).toBe("completed");
});

test("remote selection refuses local paths, excess resources and fallback preferences", async () => {
  const saved = await service.save(admin, config);
  const data: JobSubmit = {
    name: "Computation",
    command: "true",
    resources: { cpus: 1, memoryMb: 64 },
    schedulingStrategy: { queueId: saved.id },
  };
  await expect(service.prepareJob(user, { ...data, workingDir: "/shared/home" })).rejects.toThrow(
    "portable",
  );
  await expect(
    service.prepareJob(user, { ...data, resources: { cpus: 2, memoryMb: 64 } }),
  ).rejects.toThrow("resources exceed");
  await expect(
    service.prepareJob(user, { ...data, schedulingStrategy: { preferredQueueIds: [saved.id] } }),
  ).rejects.toThrow("explicitly");
});

test("workflow cluster choice preserves node identity and file mappings", async () => {
  const revisionId = crypto.randomUUID();
  const saved = await service.save(admin, {
    ...config,
    profiles: config.profiles.map((p) => ({ ...p, source: { kind: "usecase", revisionId } })),
  });
  const workflow = workflowDsl.WorkflowSchema.parse({
    name: "Genome processing",
    spec: {
      nodeDrafts: [
        {
          id: "compute",
          name: "Alignment",
          type: "SoftwareUsecaseComputing",
          usecaseVersionId: revisionId,
          softwareVersionId: crypto.randomUUID(),
          schedulingStrategy: { type: "Manual", queues: [saved.id] },
          requirements: { cpuCores: 1, maxWallTime: 10 },
        },
      ],
    },
  });
  const transformed = await service.prepareWorkflow(workflow, principal);
  const node = transformed.spec.nodeDrafts[0];
  expect(node?.type).toBe("Federation");
  expect(node?.id).toBe("compute");
  if (node?.type !== "Federation") throw new Error("Node was not delegated");
  expect(node.executionTarget).toEqual(executionTarget);
  expect(node.resources.wallTimeSec).toBe(10);
});

test("remote script output policies are never silently discarded", async () => {
  const revisionId = crypto.randomUUID();
  const saved = await service.save(admin, {
    ...config,
    profiles: config.profiles.map((p) => ({ ...p, source: { kind: "script", revisionId } })),
  });
  const workflow = workflowDsl.WorkflowSchema.parse({
    name: "Read statistics",
    spec: {
      nodeDrafts: [
        {
          id: "stats",
          name: "Read statistics",
          type: "Script",
          source: {
            type: "AssetRevision",
            assetId: crypto.randomUUID(),
            assetRevisionId: revisionId,
            revision: 1,
            sha256: "a".repeat(64),
          },
          runtimeProfileId: crypto.randomUUID(),
          schedulingStrategy: { type: "Manual", queues: [saved.id] },
          outputs: { summary: { type: "Text" } },
        },
      ],
    },
  });
  await expect(service.prepareWorkflow(workflow, principal)).rejects.toThrow(
    "portable file mappings",
  );
});

test("revoking lab grants persists across requests; suspended users receive no queues", async () => {
  await permissions.current(other);
  await permissions.set({ ...other, capability: "cluster.use", enabled: false }, admin.userId);
  expect((await permissions.current(other)).grants).toEqual([]);
  expect(await service.listVisible({ ...context, userId: other.userId })).toEqual([]);
  await db.update(users).set({ suspended: true }).where(eq(users.id, user.userId));
  expect(await service.listVisible(context)).toEqual([]);
  await db.update(users).set({ suspended: false }).where(eq(users.id, user.userId));
});
