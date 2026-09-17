import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  agents,
  createPgDb,
  dataAssets,
  dataAssetVersions,
  dataLocations,
  ecosystemReleaseAssets,
  ecosystemReleases,
  jobCancellations,
  jobDataBindings,
  jobs,
  meteringUsageRaw,
  netdriveFiles,
  netdriveTransferLog,
  orgs,
  type PgDb,
  softwareAssetRevisions,
  softwareAssets,
  userOrgMemberships,
  users,
  workflowRuns,
} from "@kuintessence/db";
import { ErrorCode, JobStatus } from "@kuintessence/shared";
import { eq, like } from "drizzle-orm";
import { type JobMeteringRecorder, JobService } from "./job-service";
import type { JobUsageRecord } from "./metering";
import { createMeteringBundle } from "./metering-binding";

/** Recorder spy: captures every call so tests can assert the produced record. */
class FakeRecorder implements JobMeteringRecorder {
  readonly calls: JobUsageRecord[] = [];
  constructor(private readonly shouldThrow = false) {}
  async recordJobCompletion(record: JobUsageRecord): Promise<unknown> {
    this.calls.push(record);
    if (this.shouldThrow) {
      throw new Error("simulated metering failure");
    }
    return null;
  }
}

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";

// Test isolation: this suite uses prefix "test-job-svc-" for jobs and email "jobsvc-test@..."
// for users to allow parallel runs.

describe("JobService", () => {
  let db: PgDb;
  let service: JobService;
  let testUserId: string;
  let testOrgId: string;
  let otherProviderOrgId: string;
  const testJobIds: string[] = [];
  const workflowRunIds: string[] = [];
  const meteringAgentId = "test-job-svc-metering-agent";
  const agentFilterOtherId = "test-job-svc-agent-filter-other";
  const dataAssetId = "00000000-0000-4000-8000-000000000301";
  const dataVersionId = "00000000-0000-4000-8000-000000000302";
  const dataLocationId = "00000000-0000-4000-8000-000000000303";
  const inaccessibleDataAssetId = "00000000-0000-4000-8000-000000000311";
  const inaccessibleDataVersionId = "00000000-0000-4000-8000-000000000312";
  const restrictedDataAssetId = "00000000-0000-4000-8000-000000000401";
  const restrictedDataVersionId = "00000000-0000-4000-8000-000000000402";
  const restrictedDataLocationId = "00000000-0000-4000-8000-000000000403";
  const sandboxAssetId = "00000000-0000-4000-8000-000000000411";
  const sandboxRevisionId = "00000000-0000-4000-8000-000000000412";
  const ecosystemReleaseId = "00000000-0000-4000-8000-000000000413";

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);
    service = new JobService(db);

    const [org] = await db.insert(orgs).values({ name: "test-org-jobsvc" }).returning();
    if (!org) throw new Error("failed to create test org");
    testOrgId = org.id;
    const [otherProviderOrg] = await db
      .insert(orgs)
      .values({ name: "test-org-jobsvc-other-provider" })
      .returning();
    if (!otherProviderOrg) throw new Error("failed to create other provider org");
    otherProviderOrgId = otherProviderOrg.id;

    const [user] = await db
      .insert(users)
      .values({
        email: "jobsvc-test@kuintessence.test",
        role: "user",
        orgId: testOrgId,
      })
      .returning();
    if (!user) throw new Error("failed to create test user");
    testUserId = user.id;
    await db
      .insert(userOrgMemberships)
      .values({ userId: testUserId, orgId: testOrgId, role: "member" })
      .onConflictDoNothing();

    await db
      .insert(agents)
      .values({
        agentId: meteringAgentId,
        siteName: "test-site-metering",
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
        status: "online",
        lastHeartbeat: new Date(),
      })
      .onConflictDoNothing();
    await db.delete(dataAssets).where(eq(dataAssets.id, dataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, inaccessibleDataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, restrictedDataAssetId));
    await db.delete(ecosystemReleases).where(eq(ecosystemReleases.id, ecosystemReleaseId));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, sandboxAssetId));
    await db.insert(dataAssets).values({
      id: dataAssetId,
      ownerKind: "platform",
      kind: "reference-data",
      name: "test-job-svc-reference",
      lifecycle: "published",
      visibility: "public",
      accessMode: "open",
      sensitivity: "internal",
      createdBy: testUserId,
    });
    await db.insert(dataAssetVersions).values({
      id: dataVersionId,
      dataAssetId,
      version: "1.0.0",
      status: "ready",
      manifestDigest: "sha256:binding-immutable",
      manifest: {
        deliveryPolicy: { download: "deny", redistribution: "deny" },
      },
      immutableAt: new Date(),
      createdBy: testUserId,
    });
    await db.insert(dataLocations).values({
      id: dataLocationId,
      dataAssetVersionId: dataVersionId,
      kind: "platform-object",
      uri: "s3://test-job-svc/reference.fa",
      status: "available",
    });
    await db.insert(dataAssets).values({
      id: inaccessibleDataAssetId,
      ownerKind: "platform",
      kind: "reference-data",
      name: "test-job-svc-private-reference",
      lifecycle: "published",
      visibility: "private",
      accessMode: "open",
      sensitivity: "internal",
      createdBy: testUserId,
    });
    await db.insert(dataAssetVersions).values({
      id: inaccessibleDataVersionId,
      dataAssetId: inaccessibleDataAssetId,
      version: "1.0.0",
      status: "ready",
      manifestDigest: "sha256:private-binding",
      immutableAt: new Date(),
      createdBy: testUserId,
    });
  });

  afterAll(async () => {
    if (testJobIds.length > 0) {
      for (const id of testJobIds) {
        await db.delete(meteringUsageRaw).where(eq(meteringUsageRaw.jobId, id));
        await db.delete(jobs).where(eq(jobs.id, id));
      }
    }
    await db.delete(netdriveTransferLog).where(eq(netdriveTransferLog.actorId, testUserId));
    await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, testUserId));
    await db.delete(jobs).where(like(jobs.name, "test-job-svc-%"));
    for (const id of workflowRunIds) {
      await db.delete(workflowRuns).where(eq(workflowRuns.id, id));
    }
    await db.delete(dataAssets).where(eq(dataAssets.id, dataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, inaccessibleDataAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, restrictedDataAssetId));
    await db.delete(ecosystemReleases).where(eq(ecosystemReleases.id, ecosystemReleaseId));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, sandboxAssetId));
    await db.delete(agents).where(eq(agents.agentId, meteringAgentId));
    await db.delete(agents).where(eq(agents.agentId, agentFilterOtherId));
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.userId, testUserId));
    await db.delete(users).where(eq(users.email, "jobsvc-test@kuintessence.test"));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
    await db.delete(orgs).where(eq(orgs.id, otherProviderOrgId));
  });

  test("setWorkingDir persists the run directory on the job", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-workingdir",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    expect(job.workingDir).toBeNull();
    await service.setWorkingDir(job.id, `/tmp/kq-runs/${job.id}`);
    const reloaded = await service.getById(job.id);
    expect(reloaded?.workingDir).toBe(`/tmp/kq-runs/${job.id}`);
  });

  test("submit creates a pending job", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-submit",
        command: "echo hello",
        resources: { cpus: 2, memoryMb: 4096 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    expect(job.name).toBe("test-job-svc-submit");
    expect(job.status).toBe("pending");
    expect(job.cpus).toBe(2);
    expect(job.memoryMb).toBe(4096);
    expect(job.submittedBy).toBe(testUserId);
    expect(job.id).toBeDefined();
  });

  test("prefers an explicit workflow organization over the submitter membership fallback", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-explicit-org",
        command: "echo explicit-org",
        resources: { cpus: 1, memoryMb: 512 },
      },
      testUserId,
      { orgId: otherProviderOrgId },
    );
    testJobIds.push(job.id);

    expect(job.orgId).toBe(otherProviderOrgId);
  });

  test("atomically links workflow jobs only while the run is running", async () => {
    const [run] = await db
      .insert(workflowRuns)
      .values({
        name: "test-job-svc-workflow-fence",
        submittedBy: testUserId,
        status: "running",
        stepJobs: {},
      })
      .returning();
    if (!run) throw new Error("failed to create workflow run");
    workflowRunIds.push(run.id);

    const job = await service.submit(
      {
        name: "test-job-svc-workflow-linked",
        command: "echo linked",
        resources: { cpus: 1, memoryMb: 512 },
      },
      testUserId,
      { workflow: { runId: run.id, nodeId: "solve" } },
    );
    testJobIds.push(job.id);
    let [persistedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(persistedRun?.stepJobs).toEqual({ solve: job.id });

    await db.update(workflowRuns).set({ status: "cancelling" }).where(eq(workflowRuns.id, run.id));
    await expect(
      service.submit(
        {
          name: "test-job-svc-workflow-blocked",
          command: "echo blocked",
          resources: { cpus: 1, memoryMb: 512 },
        },
        testUserId,
        { workflow: { runId: run.id, nodeId: "post" } },
      ),
    ).rejects.toThrow("is not accepting new jobs");
    [persistedRun] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(persistedRun?.stepJobs).toEqual({ solve: job.id });
  });

  test("persists immutable Data Market bindings for placement retries", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-data-binding",
        command: "echo data",
        resources: { cpus: 1, memoryMb: 512 },
        dataInputs: {
          reference: {
            source: "data-market",
            assetId: "00000000-0000-4000-8000-000000000301",
            versionId: "00000000-0000-4000-8000-000000000302",
            manifestDigest: "sha256:binding-immutable",
            selectedEntries: ["inputs/reference.fa"],
          },
        },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    const persisted = await service.listDataPrerequisites(job.id);
    expect(persisted).toEqual([
      {
        assetId: "00000000-0000-4000-8000-000000000301",
        versionId: "00000000-0000-4000-8000-000000000302",
        manifestDigest: "sha256:binding-immutable",
        requiredPaths: ["inputs/reference.fa"],
      },
    ]);
    const retried = await new JobService(db).listDataPrerequisites(job.id);
    expect(retried).toEqual(persisted);
    const [binding] = await db
      .select()
      .from(jobDataBindings)
      .where(eq(jobDataBindings.jobId, job.id));
    expect(binding?.deliveryPolicy.download).toBe("deny");
    expect(binding?.allowedLocationIds).toEqual([dataLocationId]);
  });

  test("rejects an unauthorized Data Market binding before creating a job", async () => {
    const jobName = "test-job-svc-unauthorized-data-binding";
    await expect(
      service.submit(
        {
          name: jobName,
          command: "echo data",
          resources: { cpus: 1, memoryMb: 512 },
          dataInputs: {
            reference: {
              source: "data-market",
              assetId: inaccessibleDataAssetId,
              versionId: inaccessibleDataVersionId,
              manifestDigest: "sha256:private-binding",
              selectedEntries: [],
            },
          },
        },
        testUserId,
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    const persisted = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.name, jobName));
    expect(persisted).toHaveLength(0);
  });

  test("requires an active signed release binding for restricted Sandbox scripts", async () => {
    const content = "print('restricted')";
    const scriptSha256 = createHash("sha256").update(content).digest("hex");
    const payload = {
      kind: "sandbox-script",
      language: "python",
      entrypoint: "main.py",
      content,
      sha256: scriptSha256,
      inputs: {},
      outputs: {},
    };
    const entry = {
      ecosystemKey: "sandbox/job-service-restricted",
      kind: "sandbox-script",
      name: "Job Service Restricted Sandbox",
      version: "1.0.0",
      payload,
      provenance: { source: "job-service-test" },
      licensePolicy: {},
    };
    const manifest = {
      schemaVersion: 1,
      releaseKey: "job-service-restricted",
      version: "1.0.0",
      provenance: { source: "job-service-test" },
      assets: [entry],
    };
    const keys = generateKeyPairSync("ed25519");
    const signature = sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
      "base64",
    );
    const trustedKeys = {
      "job-service-release-key": keys.publicKey
        .export({ format: "der", type: "spki" })
        .toString("base64"),
    };
    await db.insert(dataAssets).values({
      id: restrictedDataAssetId,
      ownerKind: "platform",
      kind: "reference-data",
      name: "test-job-svc-restricted-reference",
      lifecycle: "published",
      visibility: "public",
      accessMode: "open",
      sensitivity: "restricted",
      createdBy: testUserId,
    });
    await db.insert(dataAssetVersions).values({
      id: restrictedDataVersionId,
      dataAssetId: restrictedDataAssetId,
      version: "1.0.0",
      status: "ready",
      manifestDigest: `sha256:${"c".repeat(64)}`,
      manifest: { deliveryPolicy: { download: "deny", redistribution: "deny" } },
      immutableAt: new Date(),
      createdBy: testUserId,
    });
    await db.insert(dataLocations).values({
      id: restrictedDataLocationId,
      dataAssetVersionId: restrictedDataVersionId,
      kind: "platform-object",
      uri: "s3://test-job-svc/restricted.dat",
      status: "available",
    });
    await db.insert(softwareAssets).values({
      id: sandboxAssetId,
      kind: "sandbox-script",
      name: entry.name,
      version: entry.version,
      source: "platform-fork",
      lifecycle: "published",
      visibility: "platform-public",
      payload,
      provenance: { ecosystemKey: entry.ecosystemKey },
      trustedForGlobalUse: true,
    });
    await db.insert(softwareAssetRevisions).values({
      id: sandboxRevisionId,
      assetId: sandboxAssetId,
      revision: 1,
      payload,
      provenance: { ecosystemKey: entry.ecosystemKey },
      recipeSha256: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
      contentSha256: scriptSha256,
    });
    await db.insert(ecosystemReleases).values({
      id: ecosystemReleaseId,
      releaseKey: manifest.releaseKey,
      version: manifest.version,
      artifactDigest: digestJson(manifest),
      manifest,
      provenance: manifest.provenance,
      signature,
      signingKeyId: "job-service-release-key",
      status: "active",
      importedBy: "job-service-test",
      activatedBy: "job-service-test",
      activatedAt: new Date(),
    });
    await db.insert(ecosystemReleaseAssets).values({
      releaseId: ecosystemReleaseId,
      ecosystemKey: entry.ecosystemKey,
      kind: entry.kind,
      name: entry.name,
      version: entry.version,
      payload,
      provenance: entry.provenance,
      licensePolicy: entry.licensePolicy,
      manifestEntryDigest: digestJson(entry),
      assetId: sandboxAssetId,
      assetRevisionId: sandboxRevisionId,
      materializedAt: new Date(),
    });
    const restrictedJob = {
      name: "test-job-svc-restricted-sandbox",
      command: "sandbox-manifest",
      resources: { cpus: 1, memoryMb: 512 },
      dataInputs: {
        dataset: {
          source: "data-market" as const,
          assetId: restrictedDataAssetId,
          versionId: restrictedDataVersionId,
          manifestDigest: `sha256:${"c".repeat(64)}`,
          selectedEntries: ["restricted.dat"],
        },
      },
    };
    const trustedScript = {
      revisionId: sandboxRevisionId,
      sha256: scriptSha256,
    };
    const restrictedService = new JobService(db, undefined, undefined, trustedKeys);

    const accepted = await restrictedService.submit(restrictedJob, testUserId, {
      trustedMaterialization: true,
      trustedSandboxScript: trustedScript,
    });
    testJobIds.push(accepted.id);
    expect(accepted.restrictedNoEgress).toBe(true);

    await db
      .update(ecosystemReleases)
      .set({ status: "inactive" })
      .where(eq(ecosystemReleases.id, ecosystemReleaseId));
    await expect(
      restrictedService.submit(restrictedJob, testUserId, {
        trustedMaterialization: true,
        trustedSandboxScript: trustedScript,
      }),
    ).rejects.toThrow("trusted executable");
    await db
      .update(ecosystemReleases)
      .set({ status: "active" })
      .where(eq(ecosystemReleases.id, ecosystemReleaseId));

    await expect(
      restrictedService.submit(restrictedJob, testUserId, {
        trustedMaterialization: true,
        trustedSandboxScript: {
          revisionId: "00000000-0000-4000-8000-000000000499",
          sha256: scriptSha256,
        },
      }),
    ).rejects.toThrow("trusted executable");
    await expect(
      restrictedService.submit(restrictedJob, testUserId, {
        trustedMaterialization: true,
        trustedSandboxScript: { ...trustedScript, sha256: "0".repeat(64) },
      }),
    ).rejects.toThrow("trusted executable");
    await expect(
      restrictedService.submit(restrictedJob, testUserId, { trustedMaterialization: true }),
    ).rejects.toThrow("trusted executable");

    await db
      .update(ecosystemReleaseAssets)
      .set({ payload: { ...payload, content: "print('staged-tamper')" } })
      .where(eq(ecosystemReleaseAssets.releaseId, ecosystemReleaseId));
    await expect(
      restrictedService.submit(restrictedJob, testUserId, {
        trustedMaterialization: true,
        trustedSandboxScript: trustedScript,
      }),
    ).rejects.toThrow("trusted executable");
    await db
      .update(ecosystemReleaseAssets)
      .set({ payload })
      .where(eq(ecosystemReleaseAssets.releaseId, ecosystemReleaseId));

    await db
      .update(softwareAssetRevisions)
      .set({ payload: { ...payload, content: "print('revision-tamper')" } })
      .where(eq(softwareAssetRevisions.id, sandboxRevisionId));
    await expect(
      restrictedService.submit(restrictedJob, testUserId, {
        trustedMaterialization: true,
        trustedSandboxScript: trustedScript,
      }),
    ).rejects.toThrow("trusted executable");
    await db
      .update(softwareAssetRevisions)
      .set({ payload })
      .where(eq(softwareAssetRevisions.id, sandboxRevisionId));

    await db
      .update(ecosystemReleases)
      .set({ manifest: { ...manifest, assets: [{ ...entry, name: "Manifest Tamper" }] } })
      .where(eq(ecosystemReleases.id, ecosystemReleaseId));
    await expect(
      restrictedService.submit(restrictedJob, testUserId, {
        trustedMaterialization: true,
        trustedSandboxScript: trustedScript,
      }),
    ).rejects.toThrow("trusted executable");
    await db
      .update(ecosystemReleases)
      .set({ manifest })
      .where(eq(ecosystemReleases.id, ecosystemReleaseId));
  });

  test("submit accepts optional fields", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-optional",
        command: "echo full",
        resources: { cpus: 4, memoryMb: 8192, gpus: 1, wallTimeSec: 7200 },
        workingDir: "/tmp/work",
        envVars: { FOO: "bar", BAZ: "qux" },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    expect(job.gpus).toBe(1);
    expect(job.wallTimeSec).toBe(7200);
    expect(job.workingDir).toBe("/tmp/work");
    expect(job.envVars).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("getById returns job", async () => {
    const submitted = await service.submit(
      { name: "test-job-svc-get", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
      testUserId,
    );
    testJobIds.push(submitted.id);
    const found = await service.getById(submitted.id);
    expect(found?.id).toBe(submitted.id);
    expect(found?.name).toBe("test-job-svc-get");
  });

  test("getById returns null for unknown", async () => {
    const result = await service.getById("00000000-0000-0000-0000-000000000000");
    expect(result).toBeNull();
  });

  test("list returns jobs ordered by submittedAt desc", async () => {
    const a = await service.submit(
      { name: "test-job-svc-list-a", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
      testUserId,
    );
    testJobIds.push(a.id);
    await Bun.sleep(10);
    const b = await service.submit(
      { name: "test-job-svc-list-b", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
      testUserId,
    );
    testJobIds.push(b.id);
    const list = await service.list();
    const aIdx = list.findIndex((j) => j.id === a.id);
    const bIdx = list.findIndex((j) => j.id === b.id);
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeGreaterThanOrEqual(0);
    expect(bIdx).toBeLessThan(aIdx); // b is newer, comes first
  });

  test("listPage applies provider snapshot visibility before pagination", async () => {
    const first = await service.submit(
      { name: "test-job-svc-provider-a", command: "true", resources: { cpus: 1, memoryMb: 512 } },
      testUserId,
    );
    const second = await service.submit(
      { name: "test-job-svc-provider-b", command: "true", resources: { cpus: 1, memoryMb: 512 } },
      testUserId,
    );
    testJobIds.push(first.id, second.id);
    await db.update(jobs).set({ providerOrgId: testOrgId }).where(eq(jobs.id, first.id));
    await db.update(jobs).set({ providerOrgId: otherProviderOrgId }).where(eq(jobs.id, second.id));

    const page = await service.listPage({
      visibility: {
        userId: "00000000-0000-4000-8000-000000000099",
        includeOwner: false,
        consumerAdminOrgIds: [],
        providerOrgIds: [testOrgId],
      },
    });

    expect(page.total).toBe(1);
    expect(page.jobs.map((job) => job.id)).toEqual([first.id]);
  });

  test("listPage intersects an agent filter with visibility before pagination and count", async () => {
    await db
      .insert(agents)
      .values({
        agentId: agentFilterOtherId,
        siteName: "test-site-agent-filter-other",
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
        status: "online",
        lastHeartbeat: new Date(),
      })
      .onConflictDoNothing();
    const matching = await service.submit(
      {
        name: "test-job-svc-agent-filter-match",
        command: "true",
        resources: { cpus: 1, memoryMb: 512 },
      },
      testUserId,
    );
    const other = await service.submit(
      {
        name: "test-job-svc-agent-filter-other",
        command: "true",
        resources: { cpus: 1, memoryMb: 512 },
      },
      testUserId,
    );
    testJobIds.push(matching.id, other.id);
    await service.assignToAgent(matching.id, meteringAgentId, testOrgId);
    await service.assignToAgent(other.id, agentFilterOtherId, testOrgId);

    const page = await service.listPage({
      agentId: meteringAgentId,
      query: "test-job-svc-agent-filter",
      visibility: {
        userId: "00000000-0000-4000-8000-000000000099",
        includeOwner: false,
        consumerAdminOrgIds: [],
        providerOrgIds: [testOrgId],
      },
    });

    expect(page.total).toBe(1);
    expect(page.jobs.map((job) => job.id)).toEqual([matching.id]);
  });

  test("updateStatus transitions to running and sets startedAt", async () => {
    const job = await service.submit(
      { name: "test-job-svc-running", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
      testUserId,
    );
    testJobIds.push(job.id);
    const updated = await service.updateStatus(
      job.id,
      "running",
      "slurm-12345",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { node: "compute-01", reason: "Resources" },
    );
    expect(updated.status).toBe("running");
    expect(updated.schedulerJobId).toBe("slurm-12345");
    expect(updated.node).toBe("compute-01");
    expect(updated.reason).toBe("Resources");
    expect(updated.startedAt).toBeInstanceOf(Date);
    expect(updated.completedAt).toBeNull();

    const reasonCleared = await service.updateStatus(
      job.id,
      "running",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { reason: null },
    );
    expect(reasonCleared.node).toBe("compute-01");
    expect(reasonCleared.reason).toBeNull();
  });

  test("updateStatus transitions to completed and sets completedAt", async () => {
    const job = await service.submit(
      { name: "test-job-svc-completed", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
      testUserId,
    );
    testJobIds.push(job.id);
    await service.updateStatus(job.id, "running", "slurm-12346");
    const updated = await service.updateStatus(
      job.id,
      "completed",
      undefined,
      undefined,
      "finished",
      0,
      { result: "ok" },
    );
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.exitCode).toBe(0);
    expect(updated.errorMessage).toBe("finished");
    expect(updated.collectedOutputs).toEqual({ result: "ok" });
  });

  test("updateStatus throws AppError NOT_FOUND for unknown job", async () => {
    await expect(
      service.updateStatus("00000000-0000-0000-0000-000000000000", "running"),
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
  });

  test("cancel rejects a terminal job without changing its cancellation epoch", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-cancel-once",
        command: "sleep 100",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);

    const cancelled = await service.cancel(job.id);
    await expect(service.cancel(job.id)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
      statusCode: 409,
    });

    const persisted = await service.getById(job.id);
    expect(persisted?.status).toBe(JobStatus.CANCELLED);
    expect(persisted?.revokedEpoch).toBe(cancelled.revokedEpoch);
    expect(persisted?.completedAt?.getTime()).toBe(cancelled.completedAt?.getTime());
  });

  test("cancel persists the Agent cancellation intent with the terminal transition", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-cancel-outbox",
        command: "sleep 100",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    const assigned = await service.assignToAgent(job.id, meteringAgentId, testOrgId);

    const cancelled = await service.cancel(job.id);
    const [intent] = await db
      .select()
      .from(jobCancellations)
      .where(eq(jobCancellations.jobId, job.id));

    expect(cancelled.status).toBe(JobStatus.CANCELLED);
    expect(intent).toMatchObject({
      agentId: meteringAgentId,
      jobId: job.id,
      revokedEpoch: Math.max(assigned.revokedEpoch, assigned.dispatchEpoch + 1),
    });
  });

  test("assignToAgent persists the immutable queue audit snapshot", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-queue-snapshot",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    const observedAt = new Date("2026-08-19T04:30:00.000Z");
    const assigned = await service.assignToAgent(job.id, meteringAgentId, testOrgId, {
      targetMode: "default",
      schedulerQueueName: "batch",
      observedAt,
    });

    expect(assigned.queueTargetMode).toBe("default");
    expect(assigned.schedulerQueueName).toBe("batch");
    expect(assigned.queueObservedAt?.toISOString()).toBe(observedAt.toISOString());
  });

  test("first terminal status is sticky and replayed or late reports are no-ops", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-terminal",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);

    const observed: string[] = [];
    const unsubscribe = service.subscribe((updatedJobId, status) => {
      if (updatedJobId === job.id) observed.push(status);
    });

    const completed = await service.updateStatus(job.id, "completed");
    const firstCompletedAt = completed.completedAt;
    expect(firstCompletedAt).toBeInstanceOf(Date);

    await Bun.sleep(20);
    const recancelled = await service.updateStatus(job.id, "cancelled");
    const replayed = await service.updateStatus(job.id, "completed");
    const lateRunning = await service.updateStatus(job.id, "running", "late-scheduler-id");
    const lateQueued = await service.updateStatus(job.id, "queued");
    const lateFailed = await service.updateStatus(job.id, "failed");
    unsubscribe();

    for (const preserved of [recancelled, replayed, lateRunning, lateQueued, lateFailed]) {
      expect(preserved.status).toBe("completed");
      expect(preserved.completedAt?.getTime()).toBe(firstCompletedAt?.getTime());
      expect(preserved.schedulerJobId).toBeNull();
    }
    expect(observed).toEqual(["completed"]);
  });

  test("duplicate event cannot regress running while a new event can requeue it", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-monotonic-nonterminal",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    await service.assignToAgent(job.id, meteringAgentId);

    const observed: string[] = [];
    const unsubscribe = service.subscribe((updatedJobId, status) => {
      if (updatedJobId === job.id) observed.push(status);
    });
    await service.updateStatus(
      job.id,
      "queued",
      "slurm-monotonic-1",
      meteringAgentId,
      undefined,
      undefined,
      undefined,
      "queued-event",
    );
    const running = await service.updateStatus(
      job.id,
      "running",
      "slurm-monotonic-1",
      meteringAgentId,
      undefined,
      undefined,
      undefined,
      "running-event",
    );
    const replayedQueued = await service.updateStatus(
      job.id,
      "queued",
      "slurm-monotonic-1",
      meteringAgentId,
      undefined,
      undefined,
      undefined,
      "queued-event",
    );
    const requeued = await service.updateStatus(
      job.id,
      "queued",
      "slurm-monotonic-1",
      meteringAgentId,
      undefined,
      undefined,
      undefined,
      "requeue-event",
    );
    unsubscribe();

    expect(running.status).toBe("running");
    expect(replayedQueued.status).toBe("running");
    expect(replayedQueued.schedulerJobId).toBe("slurm-monotonic-1");
    expect(requeued.status).toBe("queued");
    expect(requeued.startedAt?.getTime()).toBe(running.startedAt?.getTime());
    expect(observed).toEqual(["queued", "running", "queued"]);
  });

  test("concurrent terminal reports commit one state and one timestamp atomically", async () => {
    const job = await service.submit(
      {
        name: "test-job-svc-concurrent-terminal",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    await service.assignToAgent(job.id, meteringAgentId);

    const observed: string[] = [];
    const unsubscribe = service.subscribe((updatedJobId, status) => {
      if (updatedJobId === job.id) observed.push(status);
    });
    const results = await Promise.all([
      service.updateStatus(
        job.id,
        "completed",
        undefined,
        meteringAgentId,
        "completed-message",
        0,
        { winner: "completed" },
        "terminal-completed-event",
      ),
      service.updateStatus(
        job.id,
        "failed",
        undefined,
        meteringAgentId,
        "failed-message",
        17,
        { winner: "failed" },
        "terminal-failed-event",
      ),
    ]);
    unsubscribe();

    const persisted = await service.getById(job.id);
    if (!persisted) throw new Error("concurrent terminal job was not persisted");
    expect(persisted.status === "completed" || persisted.status === "failed").toBe(true);
    expect(persisted.startedAt).toBeInstanceOf(Date);
    expect(persisted.completedAt).toBeInstanceOf(Date);
    expect(persisted.startedAt?.getTime()).toBe(persisted.completedAt?.getTime());
    const winner = persisted.status;
    expect(persisted.exitCode).toBe(winner === "completed" ? 0 : 17);
    expect(persisted.errorMessage).toBe(`${winner}-message`);
    expect(persisted.collectedOutputs).toEqual({ winner });
    expect(results.every((result) => result.status === persisted.status)).toBe(true);
    expect(observed).toEqual([persisted.status]);
  });

  test("cancelled is sticky: a later completed report does not revert a cancelled job", async () => {
    // Live integrity gap (tbd #11): cancelling a running job sets DB=cancelled
    // but does not kill the cluster job, so when it finishes the agent reports
    // `completed`. Without stickiness that completed overwrites the user's cancel
    // and the job misleadingly shows "completed".
    const job = await service.submit(
      {
        name: "test-job-svc-sticky-cancel",
        command: "sleep 100",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);

    await service.updateStatus(job.id, "running", "slurm-sticky-1");
    const cancelled = await service.updateStatus(job.id, "cancelled");
    expect(cancelled.status).toBe("cancelled");
    const cancelledAt = cancelled.completedAt;

    // Agent's job finishes AFTER the cancel and reports completed.
    const afterReport = await service.updateStatus(job.id, "completed");
    expect(afterReport.status).toBe("cancelled");
    // completedAt stamped at cancel time is preserved (no overwrite).
    expect(afterReport.completedAt?.getTime()).toBe(cancelledAt?.getTime());

    const reloaded = await service.getById(job.id);
    expect(reloaded?.status).toBe("cancelled");
  });

  test("updateStatus to completed without running stamps startedAt = completedAt", async () => {
    // Regression test for the startedAt-fallback branch:
    // fast-completing jobs may never receive a "running" transition (e.g. they
    // finish before the first poll interval). updateStatus("completed") must still
    // stamp both timestamps and satisfy startedAt <= completedAt.
    //
    // Requires a running Postgres (DATABASE_URL or default localhost:5432).
    // Run `bun infra:up` (see deploy/compose/docker-compose.dev.yml) before executing this suite.
    const job = await service.submit(
      {
        name: "test-job-svc-startedat-fallback",
        command: "echo fast",
        resources: { cpus: 1, memoryMb: 512 },
      },
      testUserId,
    );
    testJobIds.push(job.id);

    // Sanity: freshly submitted job has no timestamps
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();

    // Transition directly to "completed" without going through "running"
    const updated = await service.updateStatus(job.id, "completed");

    expect(updated.status).toBe("completed");
    expect(updated.completedAt).toBeInstanceOf(Date);
    expect(updated.startedAt).toBeInstanceOf(Date);
    // startedAt must be <= completedAt (they are the same `now` in the fast path)
    expect((updated.startedAt as Date).getTime()).toBeLessThanOrEqual(
      (updated.completedAt as Date).getTime(),
    );
  });

  test("assignToAgent updates agent and sets status to queued", async () => {
    // First, register an agent so the FK constraint passes
    await db
      .insert(agents)
      .values({
        agentId: "test-job-svc-agent",
        siteName: "test-site",
        schedulerType: "slurm",
        schedulerVersion: "23.02.7",
        providerOrgId: testOrgId,
        status: "online",
        lastHeartbeat: new Date(),
      })
      .onConflictDoNothing();

    const job = await service.submit(
      { name: "test-job-svc-assign", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
      testUserId,
    );
    testJobIds.push(job.id);
    const assigned = await service.assignToAgent(job.id, "test-job-svc-agent", testOrgId);
    expect(assigned.agentId).toBe("test-job-svc-agent");
    expect(assigned.providerOrgId).toBe(testOrgId);
    expect(assigned.status).toBe("queued");
    expect(assigned.dispatchEpoch).toBe(1);

    await db
      .update(agents)
      .set({ providerOrgId: otherProviderOrgId })
      .where(eq(agents.agentId, "test-job-svc-agent"));
    expect((await service.getById(job.id))?.providerOrgId).toBe(testOrgId);
    await expect(
      service.assignToAgent(job.id, "test-job-svc-agent", otherProviderOrgId),
    ).rejects.toMatchObject({ statusCode: 409 });
    await expect(
      service.assignToAgent(job.id, "test-job-svc-agent", testOrgId),
    ).rejects.toMatchObject({ statusCode: 409 });

    // cleanup: must delete the job first (FK → agents), then the agent
    await db.delete(jobs).where(eq(jobs.id, job.id));
    await db.delete(agents).where(eq(agents.agentId, "test-job-svc-agent"));
  });

  test("backfills a missing provider snapshot without overwriting existing snapshots", async () => {
    const agentId = "test-job-svc-backfill-agent";
    await db.insert(agents).values({
      agentId,
      siteName: "test-backfill-site",
      providerOrgId: testOrgId,
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const job = await service.submit(
      { name: "test-job-svc-backfill", command: "true", resources: { cpus: 1, memoryMb: 1024 } },
      testUserId,
    );
    testJobIds.push(job.id);
    await service.assignToAgent(job.id, agentId);
    expect((await service.getById(job.id))?.providerOrgId).toBeNull();

    expect(await service.backfillProviderSnapshots()).toBeGreaterThanOrEqual(1);
    expect((await service.getById(job.id))?.providerOrgId).toBe(testOrgId);

    await db
      .update(agents)
      .set({ providerOrgId: otherProviderOrgId })
      .where(eq(agents.agentId, agentId));
    await service.backfillProviderSnapshots();
    expect((await service.getById(job.id))?.providerOrgId).toBe(testOrgId);

    await db.delete(jobs).where(eq(jobs.id, job.id));
    await db.delete(agents).where(eq(agents.agentId, agentId));
  });

  test("updateStatus refuses to mutate a job owned by a different agent", async () => {
    await db.insert(agents).values({
      agentId: "agent-A",
      siteName: "site-A",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    await db.insert(agents).values({
      agentId: "agent-B",
      siteName: "site-B",
      schedulerType: "slurm",
      schedulerVersion: "23.02.7",
    });
    const submitted = await service.submit(
      {
        name: "test-job-svc-ownership",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(submitted.id);
    await service.assignToAgent(submitted.id, "agent-A");
    const job = await service.updateStatus(submitted.id, "running", undefined, "agent-A");

    // agent-B must NOT be able to drive agent-A's job to completed.
    await expect(service.updateStatus(job.id, "completed", undefined, "agent-B")).rejects.toThrow(
      /not found/i,
    );

    const [afterEvil] = await db.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
    expect(afterEvil?.status).toBe("running");

    // The owning agent still succeeds.
    await service.updateStatus(job.id, "completed", undefined, "agent-A");
    const [afterOwner] = await db.select().from(jobs).where(eq(jobs.id, job.id)).limit(1);
    expect(afterOwner?.status).toBe("completed");

    // Delete the job first (FK jobs.agent_id → agents.agent_id), then the agents.
    await db.delete(jobs).where(eq(jobs.id, job.id));
    await db.delete(agents).where(eq(agents.agentId, "agent-A"));
    await db.delete(agents).where(eq(agents.agentId, "agent-B"));
  });

  test("records compute usage to the recorder on terminal transition", async () => {
    const recorder = new FakeRecorder();
    const metered = new JobService(db, undefined, recorder);

    const cpus = 4;
    const memoryMb = 8192;
    const gpus = 2;
    const job = await metered.submit(
      {
        name: "test-job-svc-metering-record",
        command: "true",
        resources: { cpus, memoryMb, gpus },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    await metered.assignToAgent(job.id, meteringAgentId);
    const running = await metered.updateStatus(
      job.id,
      "running",
      "slurm-metering-1",
      meteringAgentId,
    );
    if (!running.startedAt) throw new Error("expected running timestamp");
    const [file] = await db
      .insert(netdriveFiles)
      .values({
        ownerId: testUserId,
        path: `metering/${job.id}/input.bin`,
        size: 2 * 1024 * 1024,
        sha256: "a".repeat(64),
        contentType: "application/octet-stream",
        storageKey: `netdrive/metering/${job.id}/input.bin`,
      })
      .returning();
    if (!file) throw new Error("expected netdrive fixture file");
    await db.insert(netdriveTransferLog).values({
      fileId: file.id,
      actorId: testUserId,
      orgId: testOrgId,
      direction: "download",
      bytes: 3 * 1024 * 1024,
      occurredAt: new Date(),
    });
    const completed = await metered.updateStatus(job.id, "completed", undefined, meteringAgentId);

    expect(recorder.calls.length).toBe(1);
    const rec = recorder.calls[0];
    if (!rec) throw new Error("expected one usage record");

    const startedAt = completed.startedAt;
    const finishedAt = completed.completedAt;
    if (!startedAt || !finishedAt) throw new Error("expected terminal timestamps");
    const durationSec = Math.max(0, (finishedAt.getTime() - startedAt.getTime()) / 1000);

    expect(rec.jobId).toBe(job.id);
    expect(rec.userId).toBe(testUserId);
    expect(rec.orgId).toBe(testOrgId);
    expect(rec.agentId).toBe(meteringAgentId);
    expect(rec.clusterName).toBe(meteringAgentId);
    expect(rec.appTemplateKey).toBeNull();
    expect(rec.cpuCoreSeconds).toBe(Math.round(cpus * durationSec));
    expect(rec.gpuSeconds).toBe(Math.round(gpus * durationSec));
    expect(rec.memoryMbSeconds).toBe(Math.round(memoryMb * durationSec));
    expect(rec.storageMbSeconds).toBe(Math.round(2 * durationSec));
    expect(rec.networkEgressMb).toBe(3);
    expect(rec.metadata?.dataAttribution).toEqual({
      version: "netdrive-v1",
      networkSource: "netdrive_transfer_log:download+mirror actor/org/job-window",
      storageSource: "netdrive_files:live-owner-bytes * job-duration",
      storageBytes: 2 * 1024 * 1024,
      networkEgressBytes: 3 * 1024 * 1024,
    });
    expect(rec.startedAt.getTime()).toBe(startedAt.getTime());
    expect(rec.finishedAt.getTime()).toBe(finishedAt.getTime());
  });

  test("prefers job-linked NetDrive transfers for metering attribution", async () => {
    const recorder = new FakeRecorder();
    const metered = new JobService(db, undefined, recorder);

    const job = await metered.submit(
      {
        name: "test-job-svc-metering-exact-netdrive",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    await metered.assignToAgent(job.id, meteringAgentId);
    await metered.updateStatus(job.id, "running", "slurm-metering-exact", meteringAgentId);

    const [exactFile] = await db
      .insert(netdriveFiles)
      .values({
        ownerId: testUserId,
        path: `metering/${job.id}/exact.bin`,
        size: 4 * 1024 * 1024,
        sha256: "b".repeat(64),
        contentType: "application/octet-stream",
        storageKey: `netdrive/metering/${job.id}/exact.bin`,
      })
      .returning();
    const [distractorFile] = await db
      .insert(netdriveFiles)
      .values({
        ownerId: testUserId,
        path: `metering/${job.id}/distractor.bin`,
        size: 8 * 1024 * 1024,
        sha256: "c".repeat(64),
        contentType: "application/octet-stream",
        storageKey: `netdrive/metering/${job.id}/distractor.bin`,
      })
      .returning();
    if (!exactFile || !distractorFile) throw new Error("expected netdrive fixture files");

    await db.insert(netdriveTransferLog).values([
      {
        fileId: exactFile.id,
        actorId: testUserId,
        orgId: testOrgId,
        direction: "download",
        bytes: 5 * 1024 * 1024,
        occurredAt: new Date(),
        jobId: job.id,
        netdriveFileIds: [exactFile.id],
      },
      {
        fileId: distractorFile.id,
        actorId: testUserId,
        orgId: testOrgId,
        direction: "download",
        bytes: 99 * 1024 * 1024,
        occurredAt: new Date(),
      },
    ]);

    const completed = await metered.updateStatus(job.id, "completed", undefined, meteringAgentId);

    const rec = recorder.calls[0];
    if (!rec) throw new Error("expected one usage record");
    const startedAt = completed.startedAt;
    const finishedAt = completed.completedAt;
    if (!startedAt || !finishedAt) throw new Error("expected terminal timestamps");
    const durationSec = Math.max(0, (finishedAt.getTime() - startedAt.getTime()) / 1000);

    expect(rec.storageMbSeconds).toBe(Math.round(4 * durationSec));
    expect(rec.networkEgressMb).toBe(5);
    expect(rec.metadata?.dataAttribution).toEqual({
      version: "netdrive",
      networkSource: "netdrive_transfer_log:download+mirror jobId",
      storageSource: "netdrive_files:job-linked-file-ids * job-duration",
      storageBytes: 4 * 1024 * 1024,
      networkEgressBytes: 5 * 1024 * 1024,
      netdriveFileIds: [exactFile.id],
    });
  });

  test("a metering failure does not break updateStatus", async () => {
    const recorder = new FakeRecorder(true);
    const metered = new JobService(db, undefined, recorder);

    const job = await metered.submit(
      {
        name: "test-job-svc-metering-failure",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    await metered.assignToAgent(job.id, meteringAgentId);
    await metered.updateStatus(job.id, "running", "slurm-metering-2", meteringAgentId);

    // The throwing recorder must not propagate out of updateStatus.
    const completed = await metered.updateStatus(job.id, "completed", undefined, meteringAgentId);
    expect(completed.status).toBe("completed");
    expect(recorder.calls.length).toBe(1);

    const reloaded = await metered.getById(job.id);
    expect(reloaded?.status).toBe("completed");
  });

  test("e2e: real MeteringService persists the usage row in metering_usage_raw", async () => {
    const bundle = createMeteringBundle({ db });
    const metered = new JobService(db, undefined, bundle.service);

    const cpus = 3;
    const memoryMb = 2048;
    const job = await metered.submit(
      {
        name: "test-job-svc-metering-e2e",
        command: "true",
        resources: { cpus, memoryMb },
      },
      testUserId,
    );
    testJobIds.push(job.id);
    await metered.assignToAgent(job.id, meteringAgentId);
    await metered.updateStatus(job.id, "running", "slurm-metering-e2e", meteringAgentId);
    const completed = await metered.updateStatus(job.id, "completed", undefined, meteringAgentId);

    const [row] = await db
      .select()
      .from(meteringUsageRaw)
      .where(eq(meteringUsageRaw.jobId, job.id))
      .limit(1);
    expect(row).toBeDefined();
    if (!row) throw new Error("expected a metering_usage_raw row");

    const startedAt = completed.startedAt;
    const finishedAt = completed.completedAt;
    if (!startedAt || !finishedAt) throw new Error("expected terminal timestamps");
    const durationSec = Math.max(0, (finishedAt.getTime() - startedAt.getTime()) / 1000);

    expect(row.userId).toBe(testUserId);
    expect(row.orgId).toBe(testOrgId);
    expect(row.clusterName).toBe(meteringAgentId);
    expect(row.cpuCoreSeconds).toBe(Math.round(cpus * durationSec));
    expect(row.memoryMbSeconds).toBe(Math.round(memoryMb * durationSec));
    expect(row.gpuSeconds).toBe(0);
  });
});

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digestJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}
