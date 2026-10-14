import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { v1 } from "@authzed/authzed-node";
import {
  authzOutbox,
  createPgDb,
  ecosystemReleaseAssets,
  ecosystemReleases,
  jobs,
  softwareAssets,
  usecasePackages,
  users,
} from "@kuintessence/db";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { createUsecasePackageRoutes } from "../packages/registry/src/routes/usecase-packages";
import {
  canonicalJson,
  type EcosystemManifest,
  EcosystemReleaseService,
} from "../packages/registry/src/services/ecosystem-release-service";
import { SoftwareAssetService } from "../packages/registry/src/services/software-asset-service";
import { UsecasePackageService } from "../packages/registry/src/services/usecase-package-service";
import { AuthzService } from "../packages/server/src/authz/service";
import { JobService } from "../packages/server/src/services/job-service";
import { SoftwareAvailabilityService } from "../packages/server/src/services/software-availability";
import { createDbPackageStore } from "../packages/server/src/workflow/db-package-store";
import {
  PgWorkflowNamedReferenceRepository,
  WorkflowNamedReferenceResolver,
} from "../packages/server/src/workflow/named-reference-resolver";
import { createPackageResolver } from "../packages/server/src/workflow/package-resolver";

const jobIds: string[] = [];
const userIds: string[] = [];
const releaseIds: string[] = [];
const db = createPgDb(process.env.DATABASE_URL ?? "postgres://kq:kq@localhost:5432/kuintessence");
const assetIds: string[] = [];
const packageIds: string[] = [];
afterAll(async () => {
  if (jobIds.length) await db.delete(jobs).where(inArray(jobs.id, jobIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  if (releaseIds.length)
    await db.delete(ecosystemReleases).where(inArray(ecosystemReleases.id, releaseIds));
  if (assetIds.length) {
    await db.delete(authzOutbox).where(inArray(authzOutbox.resourceId, assetIds));
    await db.delete(softwareAssets).where(inArray(softwareAssets.id, assetIds));
  }
  if (packageIds.length)
    await db.delete(usecasePackages).where(inArray(usecasePackages.id, packageIds));
});

test("Registry API projects published usecase access; enforce accepts a member and rejects an outsider and archived usecase", async () => {
  const assets = new SoftwareAssetService(db);
  const softwareRef = {
    source: "platform-fork" as const,
    name: "authz-regression-software",
    version: "1",
  };
  const software = await assets.upsertAsset({
    ...softwareRef,
    kind: "spack-package",
    lifecycle: "published",
    visibility: "platform-public",
    payload: {
      kind: "spack-package",
      spack: {
        packageName: softwareRef.name,
        metadata: {},
        dependencies: [],
        providers: [],
        variants: [],
      },
    },
    provenance: {},
  });
  assetIds.push(software.id);
  const spec = {
    description: "Projection regression",
    domain: "test",
    tags: [],
    citations: [],
    softwareRef,
    inputs: [],
    outputs: [],
    resources: {},
    materialMappings: [],
    licenseRequirements: [],
    usecase: { commandFile: "echo", inputSlots: [] },
    software: { kind: "Spack", name: softwareRef.name, argumentList: [] },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  };
  const app = new Hono().route(
    "/api",
    createUsecasePackageRoutes(new UsecasePackageService(db, assets), { allowTestHeader: true }),
  );
  const response = await app.request("/api/usecase-packages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Test-Principal": JSON.stringify({
        sub: "publisher@example.test",
        role: "platform_admin",
        orgIds: [],
      }),
    },
    body: JSON.stringify({ name: "authz-regression-usecase", version: "1", spec }),
  });
  expect(response.status).toBe(201);
  const pkg = (await response.json()) as { id: string };
  packageIds.push(pkg.id);
  const [asset] = await db
    .select()
    .from(softwareAssets)
    .where(eq(softwareAssets.name, "authz-regression-usecase"));
  if (!asset) throw new Error("usecase asset missing");
  assetIds.push(asset.id);

  // The transport double consumes only relationships emitted by the real outbox processor.
  const relationships = new Map<string, v1.Relationship>();
  const member = "11111111-1111-4111-8111-111111111111";
  const client = {
    promises: {
      writeRelationships: async (request: v1.WriteRelationshipsRequest) => {
        for (const update of request.updates) {
          const relation = update.relationship;
          if (!relation) throw new Error("missing relationship");
          const key = JSON.stringify(relation);
          if (update.operation === v1.RelationshipUpdate_Operation.DELETE)
            relationships.delete(key);
          else relationships.set(key, relation);
        }
      },
      checkPermission: async (request: v1.CheckPermissionRequest) =>
        v1.CheckPermissionResponse.create({
          permissionship:
            request.subject?.object?.objectId === member &&
            [...relationships.values()].some(
              (relation) =>
                relation.resource?.objectId === request.resource?.objectId &&
                relation.relation === "user" &&
                relation.subject?.object?.objectType === "platform" &&
                relation.subject.optionalRelation === "software_use",
            )
              ? v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION
              : v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
        }),
    },
    close: () => undefined,
  };
  const authz = new AuthzService({
    mode: "enforce",
    endpoint: "localhost:50051",
    token: "test",
    schemaPath: "authz/schema.zed",
    db,
    platformAdminDegrade: false,
  });
  (authz as unknown as { client: typeof client }).client = client;
  const availability = new SoftwareAvailabilityService(db, {}, authz);
  const resolver = new WorkflowNamedReferenceResolver(new PgWorkflowNamedReferenceRepository(db), {
    assertUse: (id, principal) => availability.assertAssetCapability(id, principal, "use"),
  });
  const principal = {
    sub: member,
    userId: member,
    role: "user",
    email: "member@example.test",
    orgId: null,
    orgIds: [],
    memberships: [],
    capabilities: [],
  };
  const workflow = {
    name: "api-projection",
    parameters: [],
    spec: {
      nodeRelations: [],
      nodeDrafts: [
        {
          id: "compute",
          name: "compute",
          type: "SoftwareUsecaseComputing" as const,
          usecaseRef: { source: "platform-fork" as const, name: asset.name, version: "1" },
          softwareRef,
        },
      ],
    },
  };
  await expect(resolver.resolve(workflow, principal)).rejects.toThrow("Authorization denied");
  for (const id of assetIds)
    expect(
      (await authz.processOutbox(100, { resourceType: "software_asset", resourceId: id })).dead,
    ).toBe(0);
  expect((await resolver.resolve(workflow, principal)).spec.nodeDrafts[0]).toHaveProperty(
    "usecaseVersionId",
  );
  await expect(
    resolver.resolve(workflow, { ...principal, userId: "22222222-2222-4222-8222-222222222222" }),
  ).rejects.toThrow("Authorization denied");
  await assets.archiveLegacyAsset("usecase", "usecasePackageId", pkg.id);
  await authz.processOutbox(100, { resourceType: "software_asset", resourceId: asset.id });
  await expect(availability.assertAssetCapability(asset.id, principal, "use")).rejects.toThrow();
});

test("signed import and activation resolve named references to immutable executable usecase revisions", async () => {
  const softwareRef = {
    source: "platform-fork" as const,
    name: "signed-regression-software",
    version: "1.0",
  };
  const spec = {
    description: "Frozen usecase",
    domain: "test",
    tags: [],
    citations: [],
    softwareRef,
    inputs: [],
    outputs: [],
    resources: {},
    materialMappings: [],
    licenseRequirements: [],
    usecase: { commandFile: "echo", inputSlots: [] },
    software: { kind: "Spack", name: softwareRef.name, argumentList: [] },
    arguments: [],
    environments: [],
    filesomeInputs: [],
    filesomeOutputs: [],
    valueOutputs: [],
  };
  const policy = {
    classification: "open-source",
    identifiers: [{ kind: "spdx", value: "MIT" }],
    provenance: { source: "official-upstream", reference: "https://example.test/license" },
    autoInstall: "allowed",
  };
  const manifest: EcosystemManifest = {
    schemaVersion: 1,
    releaseKey: "workflow-software-regression",
    version: "1.0",
    provenance: { source: "test" },
    assets: [
      {
        ecosystemKey: "software/example",
        kind: "spack-package",
        name: softwareRef.name,
        version: softwareRef.version,
        payload: {
          kind: "spack-package",
          spack: { packageName: softwareRef.name, defaultSpec: `${softwareRef.name}@1.0` },
        },
        provenance: { source: "test" },
        licensePolicy: policy,
      },
      {
        ecosystemKey: "usecase/example",
        kind: "usecase",
        name: "signed-regression-usecase",
        version: "1.0",
        payload: { kind: "usecase", spec },
        provenance: { source: "test" },
        licensePolicy: policy,
      },
    ],
  };
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const signature = sign(null, Buffer.from(canonicalJson(manifest)), keys.privateKey).toString(
    "base64",
  );
  const releaseService = new EcosystemReleaseService(db, { regression: publicKey });
  const release = await releaseService.stage(
    { manifest, signature, signingKeyId: "regression" },
    "test",
  );
  releaseIds.push(release.id);
  await releaseService.activate(release.id, "test");
  const entries = await db
    .select()
    .from(ecosystemReleaseAssets)
    .where(eq(ecosystemReleaseAssets.releaseId, release.id));
  for (const entry of entries) {
    if (entry.assetId) assetIds.push(entry.assetId);
    if (entry.usecasePackageId) packageIds.push(entry.usecasePackageId);
  }
  const resolver = new WorkflowNamedReferenceResolver(new PgWorkflowNamedReferenceRepository(db), {
    assertUse: async () => undefined,
  });
  const resolved = await resolver.resolve(
    {
      name: "signed",
      parameters: [],
      spec: {
        nodeRelations: [],
        nodeDrafts: [
          {
            id: "compute",
            name: "compute",
            type: "SoftwareUsecaseComputing",
            usecaseRef: {
              source: "platform-fork",
              name: "signed-regression-usecase",
              version: "1.0",
            },
            softwareRef,
          },
        ],
      },
    },
    {
      sub: "test",
      userId: "11111111-1111-4111-8111-111111111111",
      email: "test@example.test",
      role: "user",
      orgId: null,
      orgIds: [],
      memberships: [],
      capabilities: [],
    },
  );
  const node = resolved.spec.nodeDrafts[0];
  if (
    node?.type !== "SoftwareUsecaseComputing" ||
    !node.usecaseVersionId ||
    !node.softwareVersionId
  )
    throw new Error("named references were not frozen");
  const packageId = entries.find((entry) => entry.kind === "usecase")?.usecasePackageId;
  if (!packageId) throw new Error("missing catalog package");
  await db
    .update(usecasePackages)
    .set({ spec: { changed: true } })
    .where(eq(usecasePackages.id, packageId));
  const frozen = await createPackageResolver(createDbPackageStore(db))(
    node.usecaseVersionId,
    node.softwareVersionId,
  );
  expect(frozen.usecase).toEqual(spec.usecase);
  expect(frozen.usecasePackageId).toBe(packageId);
  expect(frozen.usecaseVersionId).toBe(node.usecaseVersionId);
  const [user] = await db
    .insert(users)
    .values({ email: "frozen-usecase@example.test", role: "user" })
    .returning();
  if (!user) throw new Error("missing submitter");
  userIds.push(user.id);
  const jobService = new JobService(db, undefined, undefined, { regression: publicKey });
  const submission = {
    name: "frozen-sensitive-job",
    command: "exit 125",
    usecasePackageId: packageId,
    resources: { cpus: 1, memoryMb: 128 },
    licensedMaterials: [
      {
        selector: "fixture",
        licenseSubject: "MIT",
        targetPath: "inputs/license",
        requiredElements: [],
      },
    ],
  };
  const options = { trustedMaterialization: true, trustedUsecaseRevisionId: node.usecaseVersionId };
  const job = await jobService.submit(submission, user.id, options);
  jobIds.push(job.id);
  expect(job.restrictedNoEgress).toBe(true);
  await expect(
    jobService.submit(submission, user.id, { trustedMaterialization: true }),
  ).rejects.toThrow("trusted executable");
  await expect(
    jobService.submit(submission, user.id, {
      ...options,
      trustedUsecaseRevisionId: "99999999-9999-4999-8999-999999999999",
    }),
  ).rejects.toThrow("trusted executable");
  await db
    .update(ecosystemReleases)
    .set({ signature: "forged" })
    .where(eq(ecosystemReleases.id, release.id));
  await expect(jobService.submit(submission, user.id, options)).rejects.toThrow(
    "trusted executable",
  );
});
