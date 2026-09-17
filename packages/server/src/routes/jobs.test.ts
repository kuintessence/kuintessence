import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createPgDb,
  dataAccessPolicies,
  dataAssetFiles,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  jobs,
  orgs,
  type PgDb,
  softwareAssets,
  usecasePackages,
  users,
} from "@kuintessence/db";
import { JobStatus, type JobSubmit } from "@kuintessence/shared";
import { eq, like } from "drizzle-orm";
import { Hono } from "hono";
import pino from "pino";
import { createErrorHandler } from "../middleware/error-handler";
import { JobService } from "../services/job-service";
import type { LicenseRuntimeGovernanceService } from "../services/license-runtime-governance";
import type { PlacementOrchestrator } from "../services/placement-orchestrator";
import { createJobRoutes } from "./jobs";

const TEST_DB_URL = process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence";
const testLogger = pino({ level: "silent" });

// Test isolation: this suite uses prefix "test-job-route-" for job names and
// email "jobroute-test@kuintessence.test" for the mock user.

describe("Job routes", () => {
  let db: PgDb;
  let app: Hono;
  let testOrgId: string;
  let testUserId: string;
  let usecasePackageId: string;
  let datasetAssetId: string;
  let privateDatasetAssetId: string;
  let grantedDatasetAssetId: string;
  let datasetVersionId: string;
  let privateDatasetVersionId: string;
  let grantedDatasetVersionId: string;
  const softwareAssetId = "11111111-1111-4111-8111-111111111991";
  let lastPlacedJob: JobSubmit | null = null;

  beforeAll(async () => {
    db = createPgDb(TEST_DB_URL);

    const [org] = await db.insert(orgs).values({ name: "test-org-jobroutes" }).returning();
    if (!org) throw new Error("failed to create test org");
    testOrgId = org.id;

    await db
      .insert(users)
      .values({ email: "jobroute-test@kuintessence.test", role: "user", orgId: testOrgId })
      .onConflictDoNothing();
    const [testUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "jobroute-test@kuintessence.test"))
      .limit(1);
    if (!testUser) throw new Error("failed to fetch test user");
    testUserId = testUser.id;

    await db.delete(softwareAssets).where(eq(softwareAssets.id, softwareAssetId));
    await db.insert(softwareAssets).values({
      id: softwareAssetId,
      kind: "spack-package",
      source: "platform-fork",
      name: "gromacs",
      version: "2024.1",
      lifecycle: "published",
      createdBy: testUserId,
    });

    const [usecasePackage] = await db
      .insert(usecasePackages)
      .values({
        name: "test-job-route-gromacs",
        version: "2024.1",
        description: "route test usecase",
        spec: {
          description: "Governed GROMACS route fixture",
          domain: "molecular-dynamics",
          tags: ["GROMACS"],
          citations: [],
          softwareRef: {
            source: "platform-fork",
            name: "gromacs",
            version: "2024.1",
          },
          inputs: [
            {
              descriptor: "temperature",
              type: "Number",
              required: false,
            },
            {
              descriptor: "trajectoryDataset",
              type: "Dataset",
              required: false,
              dataRequirements: {
                acceptedFormats: ["csv"],
                dataAssets: [{ kind: "scientific-dataset", selector: "test-job-route-trajectory" }],
              },
            },
          ],
          outputs: [],
          resources: {},
          materialMappings: [],
          licenseRequirements: [],
          usecase: {
            commandFile: "gmx",
            inputSlots: [
              {
                kind: "Text",
                descriptor: "steps",
                refMaterials: [{ kind: "ArgRef", descriptor: "stepsArg", sort: 1 }],
              },
              {
                kind: "File",
                descriptor: "structure",
                refMaterials: [{ kind: "FileInputRef", descriptor: "structureFile" }],
              },
            ],
          },
          software: { kind: "Spack", name: "gromacs", version: "2024.1", argumentList: [] },
          arguments: [{ descriptor: "stepsArg", valueFormat: "--steps {}" }],
          environments: [],
          filesomeInputs: [
            { descriptor: "structureFile", fileKind: { kind: "Normal", name: "input.gro" } },
          ],
          filesomeOutputs: [{ descriptor: "log", fileKind: { kind: "Normal", name: "md.log" } }],
          valueOutputs: [],
        },
        createdBy: testUserId,
      })
      .returning();
    if (!usecasePackage) throw new Error("failed to create usecase package");
    usecasePackageId = usecasePackage.id;

    const [datasetAsset] = await db
      .insert(dataAssets)
      .values({
        ownerKind: "platform",
        name: "test-job-route-trajectory",
        lifecycle: "published",
        visibility: "public",
        accessMode: "open",
        sensitivity: "open",
        metadata: { tags: ["trajectory"] },
        createdBy: testUserId,
      })
      .returning();
    if (!datasetAsset) throw new Error("failed to create Dataset option asset");
    datasetAssetId = datasetAsset.id;
    const insertedDatasetVersions = await db
      .insert(dataAssetVersions)
      .values([
        {
          dataAssetId: datasetAssetId,
          version: "v0-no-location",
          status: "ready",
          manifestDigest: "sha256:dataset-no-location",
          format: "csv",
          sizeBytes: 64,
          immutableAt: new Date("2026-08-12T23:00:00.000Z"),
          createdBy: testUserId,
        },
        {
          dataAssetId: datasetAssetId,
          version: "v1-csv",
          status: "ready",
          manifestDigest: "sha256:dataset-csv",
          format: "csv",
          sizeBytes: 128,
          immutableAt: new Date("2026-08-13T00:00:00.000Z"),
          createdBy: testUserId,
        },
        {
          dataAssetId: datasetAssetId,
          version: "published-json",
          status: "ready",
          manifestDigest: "sha256:dataset-json",
          format: "json",
          sizeBytes: 256,
          immutableAt: new Date("2026-08-13T00:00:00.000Z"),
          createdBy: testUserId,
        },
        {
          dataAssetId: datasetAssetId,
          version: "v3-draft",
          status: "draft",
          format: "csv",
          createdBy: testUserId,
        },
      ])
      .returning({ id: dataAssetVersions.id, version: dataAssetVersions.version });
    const datasetVersion = insertedDatasetVersions.find((version) => version.version === "v1-csv");
    if (!datasetVersion) throw new Error("failed to create selectable Dataset version");
    datasetVersionId = datasetVersion.id;
    await db.insert(dataLocations).values({
      dataAssetVersionId: datasetVersionId,
      kind: "platform-object",
      uri: "s3://test-job-route/trajectory/v1-csv",
      status: "available",
    });
    await db.insert(dataAssetFiles).values({
      dataAssetVersionId: datasetVersionId,
      path: "trajectory/frame-001.xtc",
      digest: "sha256:dataset-frame-001",
      sizeBytes: 64,
    });

    const [privateDatasetAsset] = await db
      .insert(dataAssets)
      .values({
        ownerKind: "platform",
        name: "test-job-route-trajectory",
        lifecycle: "published",
        visibility: "private",
        accessMode: "open",
        sensitivity: "open",
        metadata: { tags: ["trajectory"] },
        createdBy: testUserId,
      })
      .returning();
    if (!privateDatasetAsset) throw new Error("failed to create private Dataset option asset");
    privateDatasetAssetId = privateDatasetAsset.id;
    const [privateDatasetVersion] = await db
      .insert(dataAssetVersions)
      .values({
        dataAssetId: privateDatasetAssetId,
        version: "v1-private-csv",
        status: "ready",
        manifestDigest: "sha256:dataset-private-csv",
        format: "csv",
        sizeBytes: 128,
        immutableAt: new Date("2026-08-13T01:00:00.000Z"),
        createdBy: testUserId,
      })
      .returning({ id: dataAssetVersions.id });
    if (!privateDatasetVersion) throw new Error("failed to create private Dataset version");
    privateDatasetVersionId = privateDatasetVersion.id;

    const [grantedDatasetAsset] = await db
      .insert(dataAssets)
      .values({
        ownerKind: "platform",
        name: "test-job-route-trajectory",
        lifecycle: "published",
        visibility: "organization",
        accessMode: "request",
        sensitivity: "open",
        metadata: { tags: ["trajectory"] },
        createdBy: testUserId,
      })
      .returning();
    if (!grantedDatasetAsset) throw new Error("failed to create granted Dataset option asset");
    grantedDatasetAssetId = grantedDatasetAsset.id;
    const [grantedDatasetVersion] = await db
      .insert(dataAssetVersions)
      .values({
        dataAssetId: grantedDatasetAssetId,
        version: "v1-granted-csv",
        status: "ready",
        manifestDigest: "sha256:dataset-granted-csv",
        format: "csv",
        sizeBytes: 128,
        immutableAt: new Date("2026-08-13T02:00:00.000Z"),
        createdBy: testUserId,
      })
      .returning({ id: dataAssetVersions.id });
    if (!grantedDatasetVersion) throw new Error("failed to create granted Dataset version");
    grantedDatasetVersionId = grantedDatasetVersion.id;
    await db.insert(dataLocations).values({
      dataAssetVersionId: grantedDatasetVersionId,
      kind: "platform-object",
      uri: "s3://test-job-route/trajectory/v1-granted-csv",
      status: "available",
    });
    const service = new JobService(db);

    // Stub orchestrator: no agents registered in test DB, returns no-op result.
    const stubOrchestrator: PlacementOrchestrator = {
      validateSchedulingIntent: async () => null,
      runWithTrace: async () => ({
        stages: [],
        finalDecision: null,
        preview: true,
        candidateCount: 0,
        generatedAt: new Date().toISOString(),
      }),
      placeAndDispatch: async (input: { job: JobSubmit }) => {
        lastPlacedJob = input.job;
        return { selectedAgentId: null, rejections: [], dispatched: false };
      },
    } as unknown as PlacementOrchestrator;

    app = new Hono();
    app.onError(createErrorHandler(testLogger));

    // Mock auth middleware — inject user into context as authMiddleware would
    app.use("*", async (c, next) => {
      c.set("user" as never, {
        sub: "jobroute-test@kuintessence.test",
        role: "user",
        email: "jobroute-test@kuintessence.test",
      });
      c.set("principal" as never, {
        sub: "jobroute-test@kuintessence.test",
        role: "user",
        email: "jobroute-test@kuintessence.test",
        userId: testUserId,
        orgId: testOrgId,
        orgIds: [testOrgId],
        memberships: [{ orgId: testOrgId, role: "member" }],
      });
      await next();
    });

    const governance = {
      getCanonicalLicensePolicy: async () => ({
        classification: "open-source" as const,
        identifiers: ["gromacs"],
        acceptanceRequired: false,
        providerSourceInstallEntitlementRequired: false,
        consumerUseEntitlementRequired: false,
        autoInstallAllowed: true,
      }),
      evaluateLicense: async () => [],
    } as unknown as LicenseRuntimeGovernanceService;
    app.route(
      "/api",
      createJobRoutes(service, db, stubOrchestrator, {
        defaultRunBase: "/tmp/kq-runs",
        governance,
      }),
    );
  });

  afterAll(async () => {
    await db.delete(jobs).where(like(jobs.name, "test-job-route-%"));
    await db.delete(dataAssets).where(eq(dataAssets.id, privateDatasetAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, grantedDatasetAssetId));
    await db.delete(dataAssets).where(eq(dataAssets.id, datasetAssetId));
    await db.delete(usecasePackages).where(eq(usecasePackages.id, usecasePackageId));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, softwareAssetId));
    await db.delete(users).where(eq(users.email, "jobroute-test@kuintessence.test"));
    await db.delete(orgs).where(eq(orgs.id, testOrgId));
  });

  test("POST /api/jobs creates a job", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-create",
        command: "echo hi",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      name: string;
      status: string;
      placement: { selectedAgentId: string | null; rejections: unknown[] };
    };
    expect(body.name).toBe("test-job-route-create");
    expect(body.status).toBe("pending");
    expect(body.placement).toBeDefined();
    expect(body.placement.selectedAgentId).toBeNull();
  });

  test("GET Dataset options returns only authorized immutable versions matching the descriptor", async () => {
    const res = await app.request(
      `/api/jobs/usecase/${usecasePackageId}/dataset-options?descriptor=trajectoryDataset`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      limit: 25,
      offset: 0,
      total: 1,
      options: [
        {
          assetId: datasetAssetId,
          assetName: "test-job-route-trajectory",
          format: "csv",
          version: "v1-csv",
          input: {
            source: "data-market",
            assetId: datasetAssetId,
            versionId: datasetVersionId,
            manifestDigest: "sha256:dataset-csv",
            selectedEntries: [],
          },
        },
      ],
    });
  });

  test("GET Dataset options searches and paginates after access filtering", async () => {
    const res = await app.request(
      `/api/jobs/usecase/${usecasePackageId}/dataset-options?descriptor=trajectoryDataset&q=trajectory&limit=1&offset=0`,
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      total: number;
      options: Array<{ assetId: string }>;
    };
    expect(body.total).toBe(1);
    expect(body.options).toHaveLength(1);
    expect(body.options[0]?.assetId).toBe(datasetAssetId);
  });

  test("GET Dataset options applies version grants and deny precedence in batch", async () => {
    const [grant] = await db
      .insert(dataGrants)
      .values({
        dataAssetId: grantedDatasetAssetId,
        dataAssetVersionId: grantedDatasetVersionId,
        subjectKind: "user",
        subjectId: testUserId,
        capabilities: ["use"],
        status: "active",
        grantedBy: testUserId,
        startsAt: new Date(Date.now() - 1_000),
      })
      .returning({ id: dataGrants.id });
    if (!grant) throw new Error("failed to create Dataset grant");
    try {
      const granted = await app.request(
        `/api/jobs/usecase/${usecasePackageId}/dataset-options?descriptor=trajectoryDataset&q=granted`,
      );
      expect(granted.status).toBe(200);
      expect(await granted.json()).toMatchObject({
        total: 1,
        options: [{ assetId: grantedDatasetAssetId, versionId: grantedDatasetVersionId }],
      });

      const [deny] = await db
        .insert(dataAccessPolicies)
        .values({
          dataAssetId: grantedDatasetAssetId,
          dataAssetVersionId: grantedDatasetVersionId,
          subjectKind: "user",
          subjectId: testUserId,
          effect: "deny",
          capabilities: ["use"],
          accessMode: "request",
          sensitivity: "open",
          createdBy: testUserId,
        })
        .returning({ id: dataAccessPolicies.id });
      if (!deny) throw new Error("failed to create Dataset deny policy");
      try {
        const denied = await app.request(
          `/api/jobs/usecase/${usecasePackageId}/dataset-options?descriptor=trajectoryDataset&q=granted`,
        );
        expect(denied.status).toBe(200);
        expect(await denied.json()).toMatchObject({ total: 0, options: [] });
      } finally {
        await db.delete(dataAccessPolicies).where(eq(dataAccessPolicies.id, deny.id));
      }
    } finally {
      await db.delete(dataGrants).where(eq(dataGrants.id, grant.id));
    }
  });

  test("GET Dataset options rejects missing and non-Dataset descriptors", async () => {
    const missing = await app.request(
      `/api/jobs/usecase/${usecasePackageId}/dataset-options?descriptor=missing`,
    );
    expect(missing.status).toBe(404);

    const nonDataset = await app.request(
      `/api/jobs/usecase/${usecasePackageId}/dataset-options?descriptor=temperature`,
    );
    expect(nonDataset.status).toBe(404);
  });

  test("POST Dataset validation verifies complete frozen bindings without replacing selected entries", async () => {
    const valid = await app.request(
      `/api/jobs/usecase/${usecasePackageId}/dataset-options/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descriptor: "trajectoryDataset",
          input: {
            source: "data-market",
            assetId: datasetAssetId,
            versionId: datasetVersionId,
            manifestDigest: "sha256:dataset-csv",
            selectedEntries: ["trajectory/frame-001.xtc"],
            targetPath: "inputs/trajectory",
          },
        }),
      },
    );
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ valid: true });

    const forgedEntry = await app.request(
      `/api/jobs/usecase/${usecasePackageId}/dataset-options/validate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descriptor: "trajectoryDataset",
          input: {
            source: "data-market",
            assetId: datasetAssetId,
            versionId: datasetVersionId,
            manifestDigest: "sha256:dataset-csv",
            selectedEntries: ["trajectory/missing.xtc"],
          },
        }),
      },
    );
    expect(forgedEntry.status).toBe(409);

    const malformedUsecaseId = await app.request(
      "/api/jobs/usecase/not-a-uuid/dataset-options/validate",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          descriptor: "trajectoryDataset",
          input: {
            source: "data-market",
            assetId: datasetAssetId,
            versionId: datasetVersionId,
            manifestDigest: "sha256:dataset-csv",
            selectedEntries: [],
          },
        }),
      },
    );
    expect(malformedUsecaseId.status).toBe(400);
    expect(await malformedUsecaseId.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR", message: "Invalid usecase package id: must be a UUID" },
    });
  });

  test("POST usecase materialize rejects a Dataset without current use permission", async () => {
    const jobName = "test-job-route-unauthorized-dataset";
    const res = await app.request("/api/jobs/usecase/materialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: jobName,
        usecasePackageId,
        inputs: {
          steps: "1000",
          structure: {
            fileMetadataId: "file-structure-unauthorized",
            fileMetadataName: "case.gro",
          },
        },
        dataInputs: {
          trajectoryDataset: {
            source: "data-market",
            assetId: privateDatasetAssetId,
            versionId: privateDatasetVersionId,
            manifestDigest: "sha256:dataset-private-csv",
            selectedEntries: [],
          },
        },
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });

    expect(res.status).toBe(403);
    const persisted = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.name, jobName));
    expect(persisted).toHaveLength(0);
  });

  test("POST /api/jobs preserves command input staging for dispatch and detail", async () => {
    const inputStaging = [
      { fileMetadataId: "file-command-a", stagePath: "inputs/a.txt" },
      { fileMetadataId: "file-command-b", stagePath: "config/b.txt" },
    ];

    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-command-inputs",
        command: "cat inputs/a.txt config/b.txt",
        resources: { cpus: 1, memoryMb: 1024 },
        inputStaging,
      }),
    });

    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      inputStaging: Array<{ fileMetadataId: string; stagePath: string }>;
      workingDir: string;
    };
    expect(created.inputStaging).toEqual(inputStaging);
    expect(created.workingDir).toBe(`/tmp/kq-runs/${created.id}`);
    expect(lastPlacedJob?.inputStaging).toEqual(inputStaging);
    expect(lastPlacedJob?.workingDir).toBe(`/tmp/kq-runs/${created.id}`);

    const detail = await app.request(`/api/jobs/${created.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      inputStaging: Array<{ fileMetadataId: string; stagePath: string }>;
      workingDir: string;
    };
    expect(detailBody.inputStaging).toEqual(inputStaging);
    expect(detailBody.workingDir).toBe(`/tmp/kq-runs/${created.id}`);
  });

  test("POST /api/jobs rejects invalid body", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "invalid",
        // missing command and resources
      }),
    });
    expect(res.status).toBe(400);
  });

  // Regression: ISSUE-004 — zValidator's default error envelope leaked
  // {success:false,error:{name:"ZodError",message:"…stringified JSON…"}} which
  // doesn't match the project's {error:{code,message,details}} envelope, so
  // the web client showed the JSON-as-string in toast instead of a sane
  // VALIDATION_ERROR. Found by /qa on 2026-04-29.
  test("POST /api/jobs returns AppError envelope (VALIDATION_ERROR + details) on invalid body", async () => {
    const res = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", command: "echo hi" }), // missing resources
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: unknown };
    };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Invalid job submission body");
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  test("GET /api/jobs returns list", async () => {
    const res = await app.request("/api/jobs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: Array<{ id: string }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.jobs).toBeInstanceOf(Array);
    expect(body.total).toBeGreaterThanOrEqual(body.jobs.length);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
  });

  test("GET /api/jobs supports pagination and filters", async () => {
    const createdIds: string[] = [];
    for (const name of [
      "test-job-route-page-alpha",
      "test-job-route-page-beta",
      "test-job-route-page-gamma",
    ]) {
      const res = await app.request("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          command: "true",
          resources: { cpus: 1, memoryMb: 1024 },
        }),
      });
      const created = (await res.json()) as { id: string };
      createdIds.push(created.id);
    }
    const [alphaId, betaId, gammaId] = createdIds;
    if (!alphaId || !betaId || !gammaId) {
      throw new Error("Expected three created jobs");
    }
    await db.update(jobs).set({ status: JobStatus.COMPLETED }).where(eq(jobs.id, alphaId));
    await db.update(jobs).set({ status: JobStatus.COMPLETED }).where(eq(jobs.id, betaId));
    await db.update(jobs).set({ status: JobStatus.FAILED }).where(eq(jobs.id, gammaId));

    const res = await app.request(
      "/api/jobs?limit=1&offset=1&q=test-job-route-page&status=completed",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: Array<{ id: string; status: string; name: string }>;
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]?.status).toBe(JobStatus.COMPLETED);
    expect(body.jobs[0]?.name).toContain("test-job-route-page");
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(1);
  });

  test("GET /api/jobs/:id returns job", async () => {
    const create = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-get",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/jobs/${created.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe(created.id);
  });

  test("POST /api/jobs/usecase materializes and persists usecase file semantics", async () => {
    const res = await app.request("/api/jobs/usecase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-usecase",
        usecasePackageId,
        inputs: {
          steps: "1000",
          structure: {
            fileMetadataId: "file-structure-1",
            fileMetadataName: "case.gro",
          },
        },
        resources: { cpus: 2, memoryMb: 2048 },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      id: string;
      usecasePackageId: string;
      usecasePackageName: string;
      inputStaging: Array<{ fileMetadataId: string; stagePath: string }>;
      expectedOutputs: Array<{ descriptor: string; path: string; isBatch: boolean }>;
      softwareRequirements: Array<{ name: string; version?: string; installable?: boolean }>;
      workingDir: string;
    };
    expect(created.usecasePackageId).toBe(usecasePackageId);
    expect(created.usecasePackageName).toBe("test-job-route-gromacs");
    expect(created.workingDir).toBe(`/tmp/kq-runs/${created.id}`);
    expect(created.inputStaging).toEqual([
      { fileMetadataId: "file-structure-1", stagePath: "input.gro" },
    ]);
    expect(created.expectedOutputs).toEqual([
      { descriptor: "log", path: "md.log", isBatch: false },
    ]);
    expect(created.softwareRequirements).toEqual([
      { name: "gromacs", version: "2024.1", installable: false },
    ]);
    expect(lastPlacedJob?.workingDir).toBe(`/tmp/kq-runs/${created.id}`);
    expect(lastPlacedJob?.command).toContain('eval "$(spack load --sh gromacs)"');
    expect(lastPlacedJob?.command).toContain("--steps 1000");

    const detail = await app.request(`/api/jobs/${created.id}`);
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as {
      usecaseInputs: Record<string, unknown>;
      fileOutputDescriptors: string[];
      workingDir: string;
    };
    expect(detailBody.workingDir).toBe(`/tmp/kq-runs/${created.id}`);
    expect(detailBody.usecaseInputs.structure).toEqual({
      fileMetadataId: "file-structure-1",
      fileMetadataName: "case.gro",
    });
    expect(detailBody.fileOutputDescriptors).toEqual(["log"]);
  });

  test("rejects an out-of-scope organization usecase across Dataset options and submission", async () => {
    const [otherOrg] = await db
      .insert(orgs)
      .values({ name: "test-job-route-other-org" })
      .returning();
    if (!otherOrg) throw new Error("failed to create other organization");
    await db
      .update(usecasePackages)
      .set({ namespace: "org", ownerOrgId: otherOrg.id })
      .where(eq(usecasePackages.id, usecasePackageId));
    const body = {
      name: "test-job-route-private-usecase",
      usecasePackageId,
      inputs: {
        steps: "1000",
        structure: { fileMetadataId: "file-structure-1", fileMetadataName: "case.gro" },
      },
      resources: { cpus: 1, memoryMb: 1024 },
    };

    try {
      const datasetOptions = await app.request(
        `/api/jobs/usecase/${usecasePackageId}/dataset-options?descriptor=trajectoryDataset`,
      );
      expect(datasetOptions.status).toBe(403);

      const datasetValidation = await app.request(
        `/api/jobs/usecase/${usecasePackageId}/dataset-options/validate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            descriptor: "trajectoryDataset",
            input: {
              source: "data-market",
              assetId: datasetAssetId,
              versionId: datasetVersionId,
              manifestDigest: "sha256:dataset-csv",
              selectedEntries: [],
            },
          }),
        },
      );
      expect(datasetValidation.status).toBe(403);

      for (const path of [
        "/api/jobs/usecase/materialize",
        "/api/jobs/usecase/preview-placement",
        "/api/jobs/usecase",
      ]) {
        const response = await app.request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(403);
      }
    } finally {
      await db
        .update(usecasePackages)
        .set({ namespace: "platform", ownerOrgId: null })
        .where(eq(usecasePackages.id, usecasePackageId));
      await db.delete(orgs).where(eq(orgs.id, otherOrg.id));
    }
  });

  test("POST /api/jobs/usecase/materialize validates required file inputs", async () => {
    const res = await app.request("/api/jobs/usecase/materialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-usecase-invalid",
        usecasePackageId,
        inputs: { steps: "1000" },
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("structure");
  });

  test("GET /api/jobs/:id returns 404 for unknown", async () => {
    const res = await app.request("/api/jobs/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // Regression: ISSUE-002 — non-UUID job id leaked Postgres "invalid input syntax for type uuid"
  // as a 500 instead of being rejected at the route boundary as 400.
  // Found by /qa on 2026-04-29.
  test("GET /api/jobs/:id returns 400 for non-UUID id", async () => {
    const res = await app.request("/api/jobs/not-a-uuid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  // placement trace endpoint.
  test("GET /api/jobs/:id/placement returns 404 when no trace persisted", async () => {
    const create = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-trace-empty",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/jobs/${created.id}/placement`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  test("GET /api/jobs/:id/placement returns 404 for unknown job id", async () => {
    const res = await app.request("/api/jobs/00000000-0000-0000-0000-000000000000/placement");
    expect(res.status).toBe(404);
  });

  test("GET /api/jobs/:id/placement returns 400 for non-UUID id", async () => {
    const res = await app.request("/api/jobs/not-a-uuid/placement");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  test("GET /api/jobs/:id/placement returns persisted trace after setPlacementTrace", async () => {
    // Re-use the route's JobService instance via the app — submit a job,
    // stamp a trace via the underlying service, and verify the route
    // returns it verbatim.
    const create = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-trace-set",
        command: "true",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    const created = (await create.json()) as { id: string };

    // Direct service call via a fresh JobService against the same db.
    const service = new JobService(db);
    await service.setPlacementTrace(created.id, {
      generatedAt: "2026-05-01T00:00:00.000Z",
      preview: false,
      candidateCount: 1,
      stages: [
        { name: "permission", inputCount: 1, passed: [{ agentId: "a" }], rejected: [] },
        { name: "software", inputCount: 1, passed: [{ agentId: "a" }], rejected: [] },
        { name: "billing", inputCount: 1, passed: [{ agentId: "a" }], rejected: [] },
        { name: "load", inputCount: 1, passed: [{ agentId: "a" }], rejected: [] },
        { name: "urgency", inputCount: 1, passed: [{ agentId: "a" }], rejected: [] },
        { name: "install-rights", inputCount: 1, passed: [{ agentId: "a" }], rejected: [] },
        { name: "manual", inputCount: 1, passed: [{ agentId: "a" }], rejected: [] },
        {
          name: "auto",
          inputCount: 1,
          passed: [{ agentId: "a", score: 80 }],
          rejected: [],
        },
      ],
      finalDecision: { agentId: "a", score: 80 },
    });

    const res = await app.request(`/api/jobs/${created.id}/placement`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stages: Array<{ name: string }>;
      finalDecision: { agentId: string };
    };
    expect(body.stages.map((s) => s.name)).toEqual([
      "permission",
      "software",
      "billing",
      "load",
      "urgency",
      "install-rights",
      "manual",
      "auto",
    ]);
    expect(body.finalDecision.agentId).toBe("a");
  });

  test("POST /api/jobs/:id/cancel transitions to cancelled", async () => {
    const create = await app.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "test-job-route-cancel",
        command: "sleep 100",
        resources: { cpus: 1, memoryMb: 1024 },
      }),
    });
    const created = (await create.json()) as { id: string };
    const res = await app.request(`/api/jobs/${created.id}/cancel`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("cancelled");
  });
});
