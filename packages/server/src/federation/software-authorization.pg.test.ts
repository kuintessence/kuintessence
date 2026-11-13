import { afterEach, beforeEach, expect, test } from "bun:test";
import { toBinary } from "@bufbuild/protobuf";
import {
  agentInstalledSoftware,
  agents,
  createPgDb,
  ecosystemReleaseAssets,
  ecosystemReleases,
  jobDispatchOutbox,
  jobs,
  licensedMaterialMappings,
  licenseEntitlementClaims,
  orgs,
  softwareAssetRevisions,
  softwareAssets,
  softwarePolicies,
  users,
} from "@kuintessence/db";
import { ServerMessageSchema } from "@kuintessence/proto";
import type { JobSubmission } from "@kuintessence/shared";
import { eq, sql } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import {
  LicenseRuntimeGovernanceService,
  PgGovernanceRepository,
} from "../services/license-runtime-governance";
import { SoftwareAvailabilityService } from "../services/software-availability";
import { federationExecutionDenial } from "./execution-policy";
import { checkFederationLicensedMaterials } from "./licensed-material-authorization";
import { prepareFederationSoftware } from "./software-authorization";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Federation PG tests require an isolated kuintessence_unit_* DATABASE_URL");
const db = createPgDb(url, { max: 4, idle_timeout: 1 });
const other = createPgDb(url, { max: 1, idle_timeout: 1 });
const identity = { userId: crypto.randomUUID(), orgId: crypto.randomUUID() };
const assetId = crypto.randomUUID();
const releaseId = crypto.randomUUID();
const claimId = crypto.randomUUID();
const agentId = `software-fence-${crypto.randomUUID()}`;
const name = `federation-test-${crypto.randomUUID()}`;
const spec = `${name}@1`;
const delivery = { kind: "compute" as const, jobId: crypto.randomUUID(), agentId };
const intent: JobSubmission = {
  nodeId: "software",
  name: "Governed software",
  command: "true",
  envVars: {},
  inputStaging: [],
  expectedOutputs: [],
  softwareRequirements: [{ assetId, name, version: "1", spec, installable: true }],
};
const policy = {
  classification: "proprietary",
  identifiers: [{ kind: "custom", value: "test-license" }],
  provenance: { source: "sp-published", reference: "Test license contract" },
  acceptanceRequired: false,
  providerEntitlements: [],
  consumerEntitlements: ["use"],
  redistribution: "prohibited",
  autoInstall: "allowed",
};
const software = new SoftwareAvailabilityService(db, {
  governance: new LicenseRuntimeGovernanceService(new PgGovernanceRepository(db)),
});

beforeEach(async () => {
  await db.insert(orgs).values({ id: identity.orgId, name: "Software authorization test" });
  await db.insert(users).values({
    id: identity.userId,
    orgId: identity.orgId,
    email: `${identity.userId}@test.invalid`,
    role: "user",
  });
  const payload = { kind: "spack-package", spack: { packageName: name, defaultSpec: spec } };
  await db.insert(softwareAssets).values({
    id: assetId,
    kind: "spack-package",
    name,
    version: "1",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    ownerUserId: identity.userId,
    payload,
  });
  await db.insert(ecosystemReleases).values({
    id: releaseId,
    releaseKey: name,
    version: "1",
    artifactDigest: `sha256:${"a".repeat(64)}`,
    manifest: {},
    provenance: {},
    signature: "test-signature",
    signingKeyId: "test-key",
    status: "active",
    importedBy: identity.userId,
  });
  const [revision] = await db
    .insert(softwareAssetRevisions)
    .values({ assetId, revision: 1, payload, provenance: {} })
    .returning();
  if (!revision) throw new Error("Missing fixture revision");
  await db.insert(ecosystemReleaseAssets).values({
    assetRevisionId: revision.id,
    materializedAt: new Date(),
    releaseId,
    assetId,
    ecosystemKey: `software/${name}`,
    kind: "spack-package",
    name,
    version: "1",
    payload,
    provenance: {},
    licensePolicy: policy,
    manifestEntryDigest: `sha256:${"b".repeat(64)}`,
  });
  await db.insert(licenseEntitlementClaims).values({
    id: claimId,
    assetId,
    licenseSubject: "test-license",
    entitlement: "consumer-use",
    claimantKind: "user",
    claimantId: identity.userId,
    evidenceReference: "test-contract",
    evidenceSummary: "Test authorization",
    status: "approved",
    submittedBy: identity.userId,
  });
  await db.insert(agents).values({
    agentId,
    siteName: "Test receiver",
    schedulerType: "slurm",
    schedulerVersion: "test",
    providerOrgId: identity.orgId,
    status: "online",
  });
  await db
    .insert(agentInstalledSoftware)
    .values({ agentId, name, version: "1", spec, hash: "a".repeat(32) });
});

afterEach(async () => {
  await db.delete(jobs).where(eq(jobs.id, delivery.jobId));
  await db.delete(agents).where(eq(agents.agentId, agentId));
  await db.delete(licenseEntitlementClaims).where(eq(licenseEntitlementClaims.id, claimId));
  await db.delete(ecosystemReleases).where(eq(ecosystemReleases.id, releaseId));
  await db.delete(softwareAssets).where(eq(softwareAssets.id, assetId));
  await db.delete(users).where(eq(users.id, identity.userId));
  await db.delete(orgs).where(eq(orgs.id, identity.orgId));
});

async function materialJob() {
  const request = {
    selector: "local-potential",
    licenseSubject: "test-license",
    targetPath: "inputs/potential",
    requiredElements: ["Si"],
  };
  const declared: JobSubmission = { ...intent, licensedMaterials: [request] };
  await db.insert(jobs).values({
    id: delivery.jobId,
    name: "Licensed material",
    command: "true",
    cpus: 1,
    memoryMb: 128,
    submittedBy: identity.userId,
    orgId: identity.orgId,
    agentId,
    status: "running",
    dispatchEpoch: 1,
  });
  const [mapping] = await db
    .insert(licensedMaterialMappings)
    .values({
      providerOrgId: identity.orgId,
      agentId,
      assetId,
      selector: request.selector,
      licenseSubject: "test-license",
      materialName: "Local potential",
      materialVersion: "1",
      elementSet: ["Si"],
      fingerprint: `sha256:${"d".repeat(64)}`,
      createdBy: identity.userId,
    })
    .returning();
  if (!mapping) throw new Error("Missing mapping fixture");
  const message = new AgentDispatcher().buildDispatchJob(delivery.jobId, {
    jobIdInternal: delivery.jobId,
    name: "Material fixture",
    command: "true",
    resources: { cpus: 1, memoryMb: 128 },
    dispatchEpoch: 1,
    federationExecution: true,
    licensedMaterialMounts: [
      { ...request, mappingId: mapping.id, assetId, expectedFingerprint: mapping.fingerprint },
    ],
  });
  await db.insert(jobDispatchOutbox).values({
    jobId: delivery.jobId,
    agentId,
    dispatchEpoch: 1,
    payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
  });
  const check = () =>
    db.transaction((tx) =>
      checkFederationLicensedMaterials(
        tx,
        delivery.jobId,
        declared,
        identity,
        { agentId, providerOrgId: identity.orgId },
        true,
      ),
    );
  return { mapping, declared, check, message };
}

test("a replacement authorization identity cannot reuse the original material fingerprint", async () => {
  const f = await materialJob();
  const replacement = crypto.randomUUID();
  const replacementPayload = {
    kind: "spack-package",
    spack: { packageName: "replacement", defaultSpec: "replacement@1" },
  };
  await db.insert(softwareAssets).values({
    id: replacement,
    name: "Replacement material policy",
    version: "1",
    kind: "spack-package",
    source: "sp-published",
    lifecycle: "published",
    payload: replacementPayload,
  });
  const [revision] = await db
    .insert(softwareAssetRevisions)
    .values({ assetId: replacement, revision: 1, payload: replacementPayload })
    .returning();
  if (!revision) throw new Error("Missing replacement revision");
  await db.insert(ecosystemReleaseAssets).values({
    releaseId,
    assetId: replacement,
    assetRevisionId: revision.id,
    materializedAt: new Date(),
    ecosystemKey: "software/replacement",
    kind: "spack-package",
    name: "replacement",
    version: "1",
    payload: replacementPayload,
    provenance: {},
    manifestEntryDigest: `sha256:${"e".repeat(64)}`,
    licensePolicy: { ...policy, classification: "open-source", consumerEntitlements: [] },
  });
  try {
    await f.check();
    await db
      .update(licensedMaterialMappings)
      .set({ assetId: replacement })
      .where(eq(licensedMaterialMappings.id, f.mapping.id));
    const mounts = await new LicenseRuntimeGovernanceService(
      new PgGovernanceRepository(db),
    ).resolveLicensedMaterialMounts({
      requests: f.declared.licensedMaterials ?? [],
      providerOrgId: identity.orgId,
      agentId,
      consumerEntitlementSubjectIds: [identity.userId, identity.orgId],
    });
    expect(mounts[0]?.assetId).toBe(replacement);
    await expect(f.check()).rejects.toMatchObject({ code: "POLICY_DENIED" });
  } finally {
    await db
      .update(licensedMaterialMappings)
      .set({ assetId })
      .where(eq(licensedMaterialMappings.id, f.mapping.id));
    await db.delete(ecosystemReleaseAssets).where(eq(ecosystemReleaseAssets.assetId, replacement));
    await db.delete(softwareAssets).where(eq(softwareAssets.id, replacement));
  }
});

test("legacy material dispatches without an authorization identity cannot be upgraded by renewal", async () => {
  const f = await materialJob();
  if (
    f.message.payload.case !== "dispatchJob" ||
    !f.message.payload.value.licensedMaterialMounts[0]
  )
    throw new Error("Missing mount");
  f.message.payload.value.licensedMaterialMounts[0].mappingId = "";
  await db
    .update(jobDispatchOutbox)
    .set({
      payloadBase64: Buffer.from(toBinary(ServerMessageSchema, f.message)).toString("base64"),
    })
    .where(eq(jobDispatchOutbox.jobId, delivery.jobId));
  await expect(f.check()).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test.each([
  "revoked",
  "asset-revoked",
  "fingerprint",
  "elements",
  "claim",
  "expired",
  "undeclared",
  "path",
] as const)("original material mount rejects %s changes at the permit fence", async (change) => {
  const f = await materialJob();
  await f.check();
  if (change === "revoked")
    await db
      .update(licensedMaterialMappings)
      .set({ revokedAt: new Date() })
      .where(eq(licensedMaterialMappings.id, f.mapping.id));
  if (change === "asset-revoked")
    await db
      .update(softwareAssets)
      .set({ lifecycle: "revoked" })
      .where(eq(softwareAssets.id, assetId));
  if (change === "fingerprint")
    await db
      .update(licensedMaterialMappings)
      .set({ fingerprint: `sha256:${"e".repeat(64)}` })
      .where(eq(licensedMaterialMappings.id, f.mapping.id));
  if (change === "elements")
    await db
      .update(licensedMaterialMappings)
      .set({ elementSet: ["O"] })
      .where(eq(licensedMaterialMappings.id, f.mapping.id));
  if (change === "claim")
    await db
      .update(licenseEntitlementClaims)
      .set({ status: "revoked" })
      .where(eq(licenseEntitlementClaims.id, claimId));
  if (change === "expired")
    await db
      .update(licenseEntitlementClaims)
      .set({ expiresAt: new Date(1) })
      .where(eq(licenseEntitlementClaims.id, claimId));
  if (change === "undeclared") f.declared.licensedMaterials = [];
  if (change === "path" && f.declared.licensedMaterials?.[0])
    f.declared.licensedMaterials[0].targetPath = "other/path";
  await expect(f.check()).rejects.toMatchObject({
    code: change === "undeclared" ? "OPERATION_CONFLICT" : "POLICY_DENIED",
  });
});

test("material permit retains mapping and entitlement locks and returns the license deadline", async () => {
  const f = await materialJob();
  const deadline = new Date(Date.now() + 5_000);
  await db
    .update(licenseEntitlementClaims)
    .set({ expiresAt: deadline })
    .where(eq(licenseEntitlementClaims.id, claimId));
  await db.transaction(async (tx) => {
    expect(
      await checkFederationLicensedMaterials(
        tx,
        delivery.jobId,
        f.declared,
        identity,
        { agentId, providerOrgId: identity.orgId },
        true,
      ),
    ).toBe(deadline.getTime());
    for (const query of [
      sql`select id from licensed_material_mappings where id=${f.mapping.id} for update nowait`,
      sql`select id from license_entitlement_claims where id=${claimId} for update nowait`,
    ]) {
      await expect(Promise.resolve(other.execute(query))).rejects.toMatchObject({
        cause: { code: "55P03" },
      });
    }
  });
  await other.execute(
    sql`select id from licensed_material_mappings where id=${f.mapping.id} for update nowait`,
  );
});

test("an in-progress material revocation refuses a permit without waiting on the writer", async () => {
  const f = await materialJob();
  await other.transaction(async (tx) => {
    await tx.execute(
      sql`select id from licensed_material_mappings where id=${f.mapping.id} for update`,
    );
    await expect(f.check()).rejects.toMatchObject({ cause: { code: "55P03" } });
  });
  await f.check();
});

test.each([
  false,
  true,
])("software authorization returns the entitlement deadline (install=%s)", async (install) => {
  const deadline = new Date(Date.now() + 5_000);
  await db
    .update(licenseEntitlementClaims)
    .set({ expiresAt: deadline })
    .where(eq(licenseEntitlementClaims.id, claimId));
  const fence = await prepareFederationSoftware(
    intent,
    identity,
    install ? { ...delivery, kind: "install", spec } : delivery,
    software,
  );
  expect(await db.transaction((tx) => fence(tx, identity.orgId))).toBe(deadline.getTime());
});

test("compute authorization holds license and release evidence until delivery commits", async () => {
  const fence = await prepareFederationSoftware(intent, identity, delivery, software);
  await db.transaction(async (tx) => {
    await fence(tx, identity.orgId);
    for (const query of [
      sql`select id from license_entitlement_claims where id=${claimId} for update nowait`,
      sql`select id from ecosystem_releases where id=${releaseId} for update nowait`,
    ]) {
      let code: string | undefined;
      try {
        await other.execute(query);
      } catch (error) {
        const cause = error instanceof Error ? error.cause : undefined;
        if (cause && typeof cause === "object" && "code" in cause) code = String(cause.code);
      }
      expect(code).toBe("55P03");
    }
  });
});

test.each([
  "revoked",
  "expired",
] as const)("license %s after preparation blocks final delivery", async (change) => {
  const fence = await prepareFederationSoftware(intent, identity, delivery, software);
  await db
    .update(licenseEntitlementClaims)
    .set(change === "revoked" ? { status: "revoked" } : { expiresAt: new Date(Date.now() - 1000) })
    .where(eq(licenseEntitlementClaims.id, claimId));
  await expect(db.transaction((tx) => fence(tx, identity.orgId))).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await expect(
    prepareFederationSoftware(intent, identity, delivery, software),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("withdrawn license policy blocks the final fence", async () => {
  const fence = await prepareFederationSoftware(intent, identity, delivery, software);
  await db
    .update(ecosystemReleases)
    .set({ status: "inactive" })
    .where(eq(ecosystemReleases.id, releaseId));
  await expect(db.transaction((tx) => fence(tx, identity.orgId))).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});

test("installable software permits installation but never a compute dispatch", async () => {
  await db.delete(agentInstalledSoftware).where(eq(agentInstalledSoftware.agentId, agentId));
  await expect(
    prepareFederationSoftware(intent, identity, delivery, software),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  const fence = await prepareFederationSoftware(
    intent,
    identity,
    { ...delivery, kind: "install", spec },
    software,
  );
  await db.transaction((tx) => fence(tx, identity.orgId));
});

test("an installed copy does not bypass revoked installation permission", async () => {
  await db.update(softwareAssets).set({ ownerUserId: null }).where(eq(softwareAssets.id, assetId));
  await prepareFederationSoftware(intent, identity, delivery, software);
  await expect(
    prepareFederationSoftware(intent, identity, { ...delivery, kind: "install", spec }, software),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("an installed copy does not bypass installation license restrictions", async () => {
  const fence = await prepareFederationSoftware(
    intent,
    identity,
    { ...delivery, kind: "install", spec },
    software,
  );
  await db
    .update(ecosystemReleaseAssets)
    .set({ licensePolicy: { ...policy, autoInstall: "denied" } })
    .where(eq(ecosystemReleaseAssets.assetId, assetId));
  await expect(db.transaction((tx) => fence(tx, identity.orgId))).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});

test("target policy is freshly checked on retry", async () => {
  await prepareFederationSoftware(intent, identity, delivery, software);
  await db.insert(softwarePolicies).values({ agentId, denyList: [name] });
  await expect(
    prepareFederationSoftware(intent, identity, delivery, software),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
});

test("missing asset, missing service, wrong target and undeclared installation fail closed", async () => {
  await expect(prepareFederationSoftware(intent, identity, delivery)).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
  await expect(
    prepareFederationSoftware(
      { ...intent, softwareRequirements: [{ name, spec, installable: true }] },
      identity,
      delivery,
      software,
    ),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(
    prepareFederationSoftware(intent, identity, { ...delivery, agentId: "other-agent" }, software),
  ).rejects.toMatchObject({ code: "POLICY_DENIED" });
  await expect(
    prepareFederationSoftware(
      intent,
      identity,
      { ...delivery, kind: "install", spec: "other@1" },
      software,
    ),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
  await expect(
    prepareFederationSoftware(
      {
        ...intent,
        softwareRequirements: [{ assetId: crypto.randomUUID(), name, spec, installable: true }],
      },
      identity,
      delivery,
      software,
    ),
  ).rejects.toMatchObject({ code: "OPERATION_CONFLICT" });
});

test.each([
  false,
  true,
])("running software preserves authority while Agent/inventory is unavailable (installing=%s)", async (installing) => {
  await db.update(agents).set({ status: "offline" }).where(eq(agents.agentId, agentId));
  await db.delete(agentInstalledSoftware).where(eq(agentInstalledSoftware.agentId, agentId));
  const target = installing ? { ...delivery, kind: "install" as const, spec } : delivery;
  const fence = await prepareFederationSoftware(intent, identity, target, software, true);
  await db.transaction((tx) => fence(tx, identity.orgId));
  await db
    .update(licenseEntitlementClaims)
    .set({ expiresAt: new Date(Date.now() - 1000) })
    .where(eq(licenseEntitlementClaims.id, claimId));
  await expect(db.transaction((tx) => fence(tx, identity.orgId))).rejects.toMatchObject({
    code: "POLICY_DENIED",
  });
});

test.each([
  "permission",
  "lifecycle",
  "policy",
  "install-permission",
] as const)("running software checks current %s without placement discovery", async (change) => {
  const target =
    change === "install-permission" ? { ...delivery, kind: "install" as const, spec } : delivery;
  await prepareFederationSoftware(intent, identity, target, software, true);
  if (change === "permission")
    await db
      .update(softwareAssets)
      .set({ ownerUserId: null, visibility: "private" })
      .where(eq(softwareAssets.id, assetId));
  if (change === "lifecycle")
    await db
      .update(softwareAssets)
      .set({ lifecycle: "revoked" })
      .where(eq(softwareAssets.id, assetId));
  if (change === "install-permission")
    await db
      .update(softwareAssets)
      .set({ ownerUserId: null })
      .where(eq(softwareAssets.id, assetId));
  if (change === "policy")
    await db
      .insert(softwarePolicies)
      .values({ agentId, denyList: [spec], version: "runtime-revoked" });
  await expect(
    prepareFederationSoftware(intent, identity, target, software, true),
  ).rejects.toMatchObject({ statusCode: 403 });
});

test("incomplete placement retries without masking withdrawn material authorization", async () => {
  const f = await materialJob();
  await db.delete(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, delivery.jobId));
  await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, delivery.jobId));
  const error = await f.check().catch((error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(federationExecutionDenial(error)).toBeUndefined();
  await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, delivery.jobId));
  await expect(f.check()).rejects.toThrow("OPERATION_CONFLICT");
  await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, delivery.jobId));
  await db
    .update(licenseEntitlementClaims)
    .set({ status: "revoked" })
    .where(eq(licenseEntitlementClaims.id, claimId));
  await expect(f.check()).rejects.toMatchObject({ code: "POLICY_DENIED" });
});
