import { afterAll, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { v1 } from "@authzed/authzed-node";
import {
  agents,
  authzOutbox,
  createPgDb,
  ecosystemReleaseAssets,
  ecosystemReleases,
  jobs,
  softwareAssetRevisions,
  softwareAssets,
  usecasePackageRevisions,
  usecasePackages,
  users,
  workflowTemplates,
} from "@kuintessence/db";
import { createUsecaseExecutor, runWorkflow, workflowDsl } from "@kuintessence/shared";
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
import { createJobRoutes } from "../packages/server/src/routes/jobs";
import { JobService } from "../packages/server/src/services/job-service";
import {
  LicenseRuntimeGovernanceService,
  PgGovernanceRepository,
} from "../packages/server/src/services/license-runtime-governance";
import { availabilityRequestForRequirement } from "../packages/server/src/services/placement-orchestrator";
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
const templateIds: string[] = [];
afterAll(async () => {
  if (jobIds.length) await db.delete(jobs).where(inArray(jobs.id, jobIds));
  if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
  if (releaseIds.length)
    await db.delete(ecosystemReleases).where(inArray(ecosystemReleases.id, releaseIds));
  if (templateIds.length)
    await db.delete(workflowTemplates).where(inArray(workflowTemplates.id, templateIds));
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

test("an independently published platform script resolves without a release key", async () => {
  const content = "print('independent')";
  const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
  const asset = await new SoftwareAssetService(db).upsertAsset({
    name: "independent-script",
    version: "1",
    source: "platform-fork",
    kind: "sandbox-script",
    lifecycle: "published",
    visibility: "platform-public",
    provenance: {},
    payload: {
      kind: "sandbox-script",
      language: "python",
      entrypoint: "main.py",
      runtimeContractRef: { name: "python-3.12-stdlib-v1", version: "1" },
      content,
      sha256,
      inputs: {},
      outputs: {},
    },
  });
  assetIds.push(asset.id);
  const revision = await new PgWorkflowNamedReferenceRepository(db).findLatestRevision(
    asset,
    "sandbox-script",
  );
  expect(revision).toMatchObject({ assetId: asset.id, revision: 1, payload: { sha256 } });
});

test.each([
  "Spack",
  "Bare",
  "Singularity",
] as const)("signed %s release freezes and authorizes an executable usecase revision", async (kind) => {
  const softwareRef = {
    source: "platform-fork" as const,
    name: `signed-regression-software-${kind}`,
    version: "1.0",
  };
  const facility =
    kind === "Spack"
      ? { kind, name: softwareRef.name, argumentList: ["+mpi"] }
      : kind === "Bare"
        ? { kind }
        : { kind, image: "echo", tag: "1" };
  const path = kind === "Bare" ? "/usr/bin/echo" : "/opt/test/echo.sif";
  const sha256 =
    kind === "Bare"
      ? new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex")
      : "c".repeat(64);
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
    software: facility,
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
  const scriptRef = { ...softwareRef, name: `signed-hook-${kind}` };
  const runtimeContractRef = { name: "python-3.12-stdlib-v1", version: "1" };
  const hook = { scriptRef, runtimeContractRef, executionIdentity: { type: "MappedAuto" } };
  const scriptContent = "print('ok')";
  const scriptDigest = new Bun.CryptoHasher("sha256").update(scriptContent).digest("hex");
  const usecaseRef = { ...softwareRef, name: `signed-regression-usecase-${kind}` };
  const flow = {
    name: `signed-hooks-${kind}`,
    spec: {
      nodeDrafts: [
        {
          id: "compute",
          name: "compute",
          type: "SoftwareUsecaseComputing",
          softwareRef,
          usecaseRef,
          hooks: { pre: hook, post: hook },
        },
        {
          type: "Loop",
          id: "samples",
          name: "samples",
          mode: "ForEach",
          maxIterations: 1,
          over: { expr: "[1]" },
          body: {
            nodeDrafts: [
              {
                type: "Generate",
                id: "gen",
                name: "gen",
                rule: { kind: "Enumeration", values: [1] },
                output: { as: "List", descriptor: "value" },
              },
            ],
          },
          outputs: [
            { descriptor: "items", from: { node: "gen", output: "value" }, aggregate: "Collect" },
          ],
        },
        ...[
          { id: "byCase", binding: { usecaseRef, softwareRef } },
          { id: "byScript", binding: { script: hook } },
        ].map(({ id, binding }) => ({
          type: "Reduce",
          id,
          name: id,
          from: { loop: "samples", output: "items" },
          output: { kind: "Value", descriptor: "sum" },
          reducer: { kind: "Command", ...binding },
        })),
      ],
    },
  };
  const manifest: EcosystemManifest = {
    schemaVersion: 1,
    releaseKey: `workflow-software-regression-${kind}`,
    version: "1.0",
    provenance: { source: "test" },
    assets: [
      {
        ecosystemKey: "script/hook",
        kind: "sandbox-script",
        name: scriptRef.name,
        version: scriptRef.version,
        payload: {
          kind: "sandbox-script",
          language: "python",
          runtimeContractRef,
          executionIdentity: hook.executionIdentity,
          entrypoint: "main.py",
          content: scriptContent,
          sha256: scriptDigest,
        },
        provenance: {},
        licensePolicy: policy,
      },
      {
        ecosystemKey: "workflow/example",
        kind: "workflow-template",
        name: flow.name,
        version: "1.0",
        payload: { kind: "workflow-template", yamlContent: JSON.stringify(flow) },
        provenance: {},
        licensePolicy: policy,
      },
      {
        ecosystemKey: "software/example",
        kind: kind === "Spack" ? "spack-package" : "site-runtime",
        name: softwareRef.name,
        version: softwareRef.version,
        payload:
          kind !== "Spack"
            ? { kind: "site-runtime", runtime: { ...facility, path, sha256 }, siteIds: ["allowed"] }
            : {
                kind: "spack-package",
                spack: { packageName: "echo-tool", defaultSpec: "echo-tool@1.0" },
              },
        provenance: { source: "test" },
        licensePolicy: policy,
      },
      {
        ecosystemKey: "usecase/example",
        kind: "usecase",
        name: `signed-regression-usecase-${kind}`,
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
    if (entry.workflowTemplateId) templateIds.push(entry.workflowTemplateId);
    if (entry.usecasePackageId) packageIds.push(entry.usecasePackageId);
  }
  {
    const asset = entries.find(
      (entry) => entry.kind === (kind === "Spack" ? "spack-package" : "site-runtime"),
    );
    if (!asset?.assetId) throw new Error("missing released runtime");
    const [unbound] = await db
      .insert(softwareAssetRevisions)
      .values({
        assetId: asset.assetId,
        revision: 2,
        payload: asset.payload,
      })
      .returning({ id: softwareAssetRevisions.id });
    if (!unbound) throw new Error("missing unbound revision");
    expect(
      await createDbPackageStore(db, { regression: publicKey }).getSoftwareRevision?.(unbound.id),
    ).toBeNull();
  }
  const resolver = new WorkflowNamedReferenceResolver(
    new PgWorkflowNamedReferenceRepository(db, { regression: publicKey }),
    {
      assertUse: async () => undefined,
    },
  );
  const principal = {
    sub: "test",
    userId: "11111111-1111-4111-8111-111111111111",
    email: "test@example.test",
    role: "user",
    orgId: null,
    orgIds: [],
    memberships: [],
    capabilities: [],
  };
  const hookEntry = entries.find((entry) => entry.kind === "sandbox-script");
  const templateEntry = entries.find((entry) => entry.kind === "workflow-template");
  if (!hookEntry?.assetId || !templateEntry?.workflowTemplateId)
    throw new Error("missing released hook or template");
  const [template] = await db
    .select()
    .from(workflowTemplates)
    .where(eq(workflowTemplates.id, templateEntry.workflowTemplateId));
  if (!template) throw new Error("missing catalog template");
  const workflow = workflowDsl.WorkflowSchema.parse(JSON.parse(template.yamlContent));
  // An independently appended revision must never replace the signed script in this template.
  await db
    .insert(softwareAssetRevisions)
    .values({ assetId: hookEntry.assetId, revision: 2, payload: hookEntry.payload });
  const caseEntry = entries.find((e) => e.kind === "usecase");
  if (!caseEntry?.assetId) throw new Error("missing released usecase");
  await db
    .insert(softwareAssetRevisions)
    .values({ assetId: caseEntry.assetId, revision: 2, payload: caseEntry.payload });
  const resolved = await resolver.resolve(workflow, principal);
  const persisted = workflowDsl.WorkflowSchema.parse(JSON.parse(JSON.stringify(resolved)));
  const commands = persisted.spec.nodeDrafts
    .filter((n) => n.type === "Reduce")
    .map(workflowDsl.commandExecutionNode);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toMatchObject({
    type: "SoftwareUsecaseComputing",
    usecaseVersionId: caseEntry.assetRevisionId,
    softwareVersionId: entries.find(
      (e) => e.kind === (kind === "Spack" ? "spack-package" : "site-runtime"),
    )?.assetRevisionId,
    frozenAssetRevisions: { usecase: { revision: 1 }, software: { revision: 1 } },
  });
  expect(commands[1]).toMatchObject({
    type: "Script",
    source: { type: "AssetRevision", assetRevisionId: hookEntry.assetRevisionId },
    executionIdentity: { type: "MappedAuto" },
    runtimeContractRef,
    inputs: { items: { type: "JSON" } },
    outputs: { sum: { type: "JSON" } },
  });
  const result = await runWorkflow(persisted, async (leaf, ctx) => {
    if (leaf.id !== "byCase" && leaf.id !== "byScript") return { status: "Succeeded" };
    const expected = commands.find((command) => command?.id === leaf.id);
    if (!expected) throw new Error("Missing frozen Command executor");
    expect(leaf).toEqual(expected);
    expect(ctx.nodes).toMatchObject({ samples: { values: { items: [[1]] } } });
    return { status: "Succeeded", values: { sum: 1 } };
  });
  expect(result.values.byCase?.values).toEqual({ sum: 1 });
  expect(result.values.byScript?.values).toEqual({ sum: 1 });
  for (const id of ["compute__pre", "compute"]) {
    expect(resolved.spec.nodeDrafts.find((n) => n.id === id)).toMatchObject({
      type: "Script",
      runtimeContractRef,
      source: {
        type: "AssetRevision",
        revision: 1,
        assetRevisionId: hookEntry.assetRevisionId,
        sha256: scriptDigest,
      },
    });
  }
  const withoutTrust = new WorkflowNamedReferenceResolver(
    new PgWorkflowNamedReferenceRepository(db),
    { assertUse: async () => undefined },
  );
  const scriptsOnly = {
    ...workflow,
    spec: {
      ...workflow.spec,
      nodeDrafts: workflow.spec.nodeDrafts.filter((n) => n.type === "Script"),
    },
  };
  await expect(withoutTrust.resolve(scriptsOnly, principal)).rejects.toThrow(
    "no immutable revision",
  );
  const denied = new WorkflowNamedReferenceResolver(
    new PgWorkflowNamedReferenceRepository(db, { regression: publicKey }),
    {
      assertUse: async (id) => {
        if (id === hookEntry.assetId) throw new Error("script use denied");
      },
    },
  );
  const summaries = workflow.spec.nodeDrafts.filter((n) => n.type === "Reduce");
  for (const summary of summaries) {
    const only = { ...workflow, spec: { ...workflow.spec, nodeDrafts: [summary] } };
    await expect(withoutTrust.resolve(only, principal)).rejects.toThrow("no immutable revision");
    await expect(resolver.resolve(only)).rejects.toThrow("canonical principal");
    if (summary.id === "byScript")
      await expect(denied.resolve(only, principal)).rejects.toThrow("script use denied");
  }
  await expect(denied.resolve(workflow, principal)).rejects.toThrow("script use denied");
  const node = resolved.spec.nodeDrafts.find((n) => n.id === "compute__main");
  if (
    node?.type !== "SoftwareUsecaseComputing" ||
    !node.usecaseVersionId ||
    !node.softwareVersionId
  )
    throw new Error("named references were not frozen");
  const packageId = entries.find((entry) => entry.kind === "usecase")?.usecasePackageId;
  if (!packageId) throw new Error("missing catalog package");
  const page = await new UsecasePackageService(db).listPage({
    principal: null,
    q: `signed-regression-usecase-${kind}`,
  });
  expect(page.packages.find((p) => p.id === packageId)?.publishedSoftwareRevisionId).toBe(
    node.softwareVersionId,
  );
  const [user] = await db
    .insert(users)
    .values({ email: `frozen-${kind}@example.test`, role: "user" })
    .returning();
  if (!user) throw new Error("missing submitter");
  userIds.push(user.id);
  {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("principal" as never, {
        sub: user.id,
        userId: user.id,
        email: user.email,
        role: "user",
        orgId: null,
        orgIds: [],
        memberships: [],
        capabilities: [],
      });
      await next();
    });
    const unexpected = async (): Promise<never> => {
      throw new Error("unexpected scheduler operation");
    };
    app.route(
      "/api",
      createJobRoutes(
        new JobService(db),
        db,
        {
          validateSchedulingIntent: async () => ({
            queueSelection: null,
            preferredQueueSelections: [],
            preferredQueueRejections: [],
          }),
          placeAndDispatch: async () => ({
            selectedAgentId: null,
            dispatched: false,
            rejections: [],
          }),
          runWithTrace: unexpected,
          cancelJob: unexpected,
        },
        {
          trustedReleaseKeys: { regression: publicKey },
          governance: new LicenseRuntimeGovernanceService(new PgGovernanceRepository(db)),
        },
      ),
    );
    const response = await app.request("/api/jobs/usecase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "signed site usecase",
        usecasePackageId: packageId,
        resources: { cpus: 1, memoryMb: 64 },
      }),
    });
    expect(response.status).toBe(201);
    const job = (await response.json()) as typeof jobs.$inferSelect;
    jobIds.push(job.id);
    if (kind === "Spack") {
      expect(job.softwareRequirements?.[0]).toMatchObject({
        assetId: node.frozenAssetRevisions?.software.assetId,
        name: softwareRef.name,
        spec: "echo-tool@1.0 +mpi",
      });
      expect(job.command).toContain("spack load --sh echo-tool@1.0 +mpi");
    } else {
      expect(job.softwareRequirements?.[0]?.siteRuntimeRevisionId).toBe(node.softwareVersionId);
      expect(job.command).toContain(sha256);
    }
  }
  await db
    .update(usecasePackages)
    .set({ spec: { changed: true } })
    .where(eq(usecasePackages.id, packageId));
  const frozen = await createPackageResolver(createDbPackageStore(db, { regression: publicKey }))(
    node.usecaseVersionId,
    node.softwareVersionId,
  );
  expect(frozen.usecase).toEqual(spec.usecase);
  expect(frozen.usecasePackageId).toBe(packageId);
  expect(frozen.usecaseVersionId).toBe(node.usecaseVersionId);
  if (kind !== "Spack") {
    const site = frozen.siteRuntime;
    const req = frozen.softwareRequirements?.[0];
    if (!site || !req) throw new Error("missing pinned site runtime");
    expect(req.siteRuntimeRevisionId).toBe(node.softwareVersionId);
    const execute = createUsecaseExecutor({
      resolvePackage: createPackageResolver(createDbPackageStore(db, { regression: publicKey })),
      submitJob: async (job) => {
        expect(job.softwareRequirements).toEqual([req]);
        expect(job.spackExecution).toBeUndefined();
        if (kind === "Bare") {
          const output = Bun.spawnSync(["/bin/sh", "-c", job.command], { env: job.envVars });
          expect(output.exitCode).toBe(0);
          expect(output.stdout.toString()).toBe("\n");
        } else {
          expect(job.command).toContain(
            "/usr/bin/apptainer exec --cleanenv --no-eval /opt/test/echo.sif echo",
          );
        }
        return { jobId: crypto.randomUUID(), status: "completed", collected: {} };
      },
    });
    expect((await execute(node, {})).status).toBe("Succeeded");
    const ids: [string, string] = [crypto.randomUUID(), crypto.randomUUID()];
    try {
      await db.insert(agents).values(
        ids.map((agentId, i) => ({
          agentId,
          siteId: i === 0 ? "allowed" : "other",
          siteName: "Test",
          schedulerType: "slurm",
          schedulerVersion: "test",
          status: "online",
        })),
      );
      const availability = new SoftwareAvailabilityService(db, {
        trustedReleaseKeys: { regression: publicKey },
        governance: new LicenseRuntimeGovernanceService(new PgGovernanceRepository(db)),
      });
      const principal = {
        sub: user.id,
        userId: user.id,
        email: user.email,
        role: "user",
        orgId: null,
        orgIds: [],
        memberships: [],
        capabilities: [],
      };
      const request = availabilityRequestForRequirement(req, ids);
      const available = await availability.resolve(request, principal);
      expect(available.installedAvailable.map((a) => a.agentId)).toEqual([ids[0]]);
      expect(available.blocked.map((a) => a.agentId)).toEqual([ids[1]]);
      expect(
        (await availability.resolve({ ...request, installable: true }, principal))
          .installedAvailable,
      ).toHaveLength(0);
      await expect(
        availability.resolve({ ...request, siteRuntimeRevisionId: crypto.randomUUID() }, principal),
      ).rejects.toThrow("active signed release");
    } finally {
      await db.delete(agents).where(inArray(agents.agentId, ids));
    }
  }
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
  const packageRevisionId = caseEntry.usecasePackageRevisionId;
  if (!packageRevisionId) throw new Error("missing catalog package revision");
  const summaryCase = {
    ...workflow,
    spec: { ...workflow.spec, nodeDrafts: summaries.filter((n) => n.id === "byCase") },
  };
  await db
    .update(usecasePackageRevisions)
    .set({ spec: { changed: true } })
    .where(eq(usecasePackageRevisions.id, packageRevisionId));
  await expect(resolver.resolve(summaryCase, principal)).rejects.toThrow("no immutable revision");
  await db
    .update(usecasePackageRevisions)
    .set({ spec })
    .where(eq(usecasePackageRevisions.id, packageRevisionId));
  expect((await resolver.resolve(summaryCase, principal)).spec.nodeDrafts).toHaveLength(1);
  await db
    .update(ecosystemReleases)
    .set({ signature: "forged" })
    .where(eq(ecosystemReleases.id, release.id));
  expect(
    await createDbPackageStore(db, { regression: publicKey }).getSoftwareRevision?.(
      node.softwareVersionId,
    ),
  ).toBeNull();
  await expect(jobService.submit(submission, user.id, options)).rejects.toThrow(
    "trusted executable",
  );
});
