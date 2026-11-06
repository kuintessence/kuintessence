import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { toBinary } from "@bufbuild/protobuf";
import {
  agents,
  clusterExecutionAccounts,
  createPgDb,
  jobDispatchOutbox,
  jobs,
  orgs,
  sandboxRuntimeContractBindings,
  sandboxRuntimeProfiles,
  scriptAttestations,
  softwareAssetGrants,
  softwareAssetRevisions,
  softwareAssets,
  userClusterAccountMappings,
  userOrgMemberships,
  users,
} from "@kuintessence/db";
import { ServerMessageSchema } from "@kuintessence/proto";
import {
  type EffectiveSandboxPolicy,
  type SandboxSignedManifest,
  workflowDsl,
} from "@kuintessence/shared";
import { eq, inArray } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { SandboxExecutionResolver } from "../services/sandbox-execution-resolver";
import { hashSandboxScript } from "../services/sandbox-script";
import { federationExecutionDenial } from "./execution-policy";
import { checkFederationSandboxJob } from "./sandbox-authorization";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Sandbox authorization requires an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
afterAll(() => db.$client.end({ timeout: 5 }));

async function fixture(shared = false, kubernetes = false) {
  const userId = randomUUID(),
    orgId = randomUUID(),
    otherOrgId = randomUUID();
  const agentId = randomUUID(),
    jobId = randomUUID(),
    accountId = randomUUID();
  const assetId = randomUUID(),
    revisionId = randomUUID(),
    runtimeId = randomUUID();
  const mappingId = randomUUID(),
    attestationId = randomUUID();
  const digest = `sha256:${runtimeId.replaceAll("-", "").repeat(2)}`;
  const content = "printf 'sandbox authorization fixture'";
  const sha256 = hashSandboxScript(content);
  await db.insert(orgs).values([
    { id: orgId, name: "Consumer" },
    { id: otherOrgId, name: "Other" },
  ]);
  await db.insert(users).values({ id: userId, email: `${userId}@test.invalid` });
  await db.insert(userOrgMemberships).values([
    { userId, orgId },
    { userId, orgId: otherOrgId },
  ]);
  await db.insert(agents).values({
    agentId,
    providerOrgId: orgId,
    siteName: "Sandbox fixture",
    clusterId: "sandbox-fixture",
    schedulerType: kubernetes ? "kubernetes" : "slurm",
    schedulerVersion: "test",
  });
  await db.insert(sandboxRuntimeProfiles).values({
    id: runtimeId,
    name: "Bash",
    language: "bash",
    languageVersion: "5",
    ...(kubernetes ? { ociDigest: digest } : { sifDigest: digest }),
    signature: "fixture",
    adapters: [kubernetes ? "kubernetes" : "slurm"],
    securityRequirements: {},
    lifecycle: "active",
  });
  await db.insert(clusterExecutionAccounts).values({
    id: accountId,
    agentId,
    providerOrgId: orgId,
    displayName: "Original execution account",
    backendType: kubernetes ? "kubernetes" : "unix",
    ...(kubernetes
      ? { namespace: "science", serviceAccount: "worker" }
      : { username: "scientist", uid: 1001, gid: 1001 }),
    sharedService: shared,
  });
  await db.insert(userClusterAccountMappings).values({
    id: mappingId,
    userId,
    accountId,
    status: "approved",
    isDefault: true,
  });
  const payload = {
    kind: "sandbox-script",
    language: "bash",
    entrypoint: "main.sh",
    content,
    sha256,
    inputs: {},
    outputs: {},
  };
  await db.insert(softwareAssets).values({
    id: assetId,
    name: "Pinned script",
    kind: "sandbox-script",
    version: "1",
    source: "sp-published",
    lifecycle: "published",
    visibility: "platform-public",
    payload,
  });
  await db.insert(softwareAssetRevisions).values({ id: revisionId, assetId, revision: 1, payload });
  await db.insert(scriptAttestations).values({
    id: attestationId,
    assetRevisionId: revisionId,
    scriptSha256: sha256,
    runtimeProfileId: runtimeId,
    runtimeDigest: digest,
    scope: "provider",
    providerOrgId: orgId,
    scanResultHash: sha256,
    allowedIdentities: [{ type: "SharedService" }],
    signedBy: userId,
  });
  const node = workflowDsl.WorkflowNodeSchema.parse({
    type: "Script",
    id: "script",
    name: "Script",
    source: { type: "AssetRevision", assetId, assetRevisionId: revisionId, revision: 1, sha256 },
    runtimeProfileId: runtimeId,
    executionIdentity: { type: shared ? "SharedService" : "MappedAuto" },
    outputs: {},
  });
  if (node.type !== "Script") throw new Error("Invalid fixture");
  const intent = {
    nodeId: node.id,
    name: "Script",
    command: "true",
    envVars: {},
    inputStaging: [],
    expectedOutputs: [],
    sandbox: {
      node,
      executionIdentity: node.executionIdentity ?? { type: "MappedAuto" as const },
      submittedBy: userId,
      orgId,
    },
  };
  const manifest: SandboxSignedManifest = {
    jobId,
    script: {
      language: "bash",
      entrypoint: "main.sh",
      contentBase64: Buffer.from(content).toString("base64"),
      sha256,
      bundleSha256: sha256,
    },
    runtime: { profileId: runtimeId, kind: kubernetes ? "OCI" : "SIF", digest },
    executionMode: "RootImpersonation",
    identity: {
      mode: shared ? "SharedService" : "MappedAccount",
      accountId,
      ...(kubernetes
        ? {
            backend: "Kubernetes",
            namespace: "science",
            serviceAccount: "worker",
            quotaPolicy: null,
          }
        : {
            backend: "Unix",
            username: "scientist",
            uid: 1001,
            gid: 1001,
            schedulerAccount: null,
            allowedQueues: [],
          }),
    },
    mounts: [],
    limits: { pids: 8, outputBytes: 128, logBytes: 128 },
    networkDisabled: true,
    envelope: {
      keyId: "fixture",
      nonce: "fixture-nonce-123456",
      issuedAtUnixMs: 1,
      expiresAtUnixMs: 2,
      manifestSha256: sha256,
      signatureBase64: "Zml4dHVyZQ==",
    },
  };
  await db.insert(jobs).values({
    id: jobId,
    name: "Sandbox fixture",
    command: "true",
    cpus: 1,
    memoryMb: 128,
    wallTimeSec: 30,
    status: "running",
    agentId,
    submittedBy: userId,
    orgId,
    dispatchEpoch: 1,
  });
  const message = new AgentDispatcher().buildDispatchJob(jobId, {
    jobIdInternal: jobId,
    name: "Sandbox fixture",
    command: "true",
    resources: { cpus: 1, memoryMb: 128, wallTimeSec: 30 },
    dispatchEpoch: 1,
    sandboxExecution: manifest,
    federationExecution: true,
  });
  await db.insert(jobDispatchOutbox).values({
    jobId,
    agentId,
    dispatchEpoch: 1,
    payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
  });
  const policy: EffectiveSandboxPolicy = {
    sandboxEnabled: true,
    impersonationEnabled: true,
    selfAccountEnabled: true,
    sharedServiceAllowed: true,
    degradedImpersonationAllowed: false,
    runtimePrecacheRequired: true,
    disabledRuntimeProfileIds: [],
    limits: {
      maxCpuCores: 2,
      maxMemoryMb: 256,
      maxWallTimeSec: 60,
      maxPids: 16,
      maxOutputBytes: 256,
      maxLogBytes: 256,
    },
  };
  const check = async () => {
    await checkFederationSandboxJob(
      db,
      jobId,
      intent,
      { userId, orgId },
      { effectiveFor: async () => policy },
    );
  };
  return {
    userId,
    orgId,
    otherOrgId,
    agentId,
    accountId,
    assetId,
    revisionId,
    runtimeId,
    mappingId,
    attestationId,
    digest,
    intent,
    policy,
    check,
    cleanup: async () => {
      await db.delete(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, jobId));
      await db.delete(jobs).where(eq(jobs.id, jobId));
      await db.delete(softwareAssets).where(eq(softwareAssets.id, assetId));
      await db.delete(agents).where(eq(agents.agentId, agentId));
      await db.delete(sandboxRuntimeProfiles).where(eq(sandboxRuntimeProfiles.id, runtimeId));
      await db.delete(users).where(eq(users.id, userId));
      await db.delete(orgs).where(inArray(orgs.id, [orgId, otherOrgId]));
    },
  };
}

test.each([
  "account-disabled",
  "account-provider",
  "unix-identity",
  "mapping-expiry",
  "mapping-revoked",
  "runtime-revoked",
  "runtime-digest",
  "asset-revoked",
  "asset-private",
  "asset-malformed",
  "policy-disabled",
  "policy-limits",
] as const)("Sandbox execution observes %s against its original dispatch", async (change) => {
  const f = await fixture();
  try {
    await f.check();
    if (change === "account-disabled")
      await db
        .update(clusterExecutionAccounts)
        .set({ enabled: false })
        .where(eq(clusterExecutionAccounts.id, f.accountId));
    if (change === "account-provider")
      await db
        .update(clusterExecutionAccounts)
        .set({ providerOrgId: f.otherOrgId })
        .where(eq(clusterExecutionAccounts.id, f.accountId));
    if (change === "unix-identity")
      await db
        .update(clusterExecutionAccounts)
        .set({ uid: 2001 })
        .where(eq(clusterExecutionAccounts.id, f.accountId));
    if (change === "mapping-expiry")
      await db
        .update(userClusterAccountMappings)
        .set({ expiresAt: new Date(1) })
        .where(eq(userClusterAccountMappings.id, f.mappingId));
    if (change === "mapping-revoked")
      await db
        .update(userClusterAccountMappings)
        .set({ revokedAt: new Date() })
        .where(eq(userClusterAccountMappings.id, f.mappingId));
    if (change === "runtime-revoked")
      await db
        .update(sandboxRuntimeProfiles)
        .set({ lifecycle: "revoked" })
        .where(eq(sandboxRuntimeProfiles.id, f.runtimeId));
    if (change === "runtime-digest")
      await db
        .update(sandboxRuntimeProfiles)
        .set({ sifDigest: `sha256:${"f".repeat(64)}` })
        .where(eq(sandboxRuntimeProfiles.id, f.runtimeId));
    if (change === "asset-revoked")
      await db
        .update(softwareAssets)
        .set({ lifecycle: "revoked", ownerUserId: f.userId })
        .where(eq(softwareAssets.id, f.assetId));
    if (change === "asset-private")
      await db
        .update(softwareAssets)
        .set({ visibility: "private" })
        .where(eq(softwareAssets.id, f.assetId));
    if (change === "asset-malformed")
      await db
        .update(softwareAssetRevisions)
        .set({ payload: {} })
        .where(eq(softwareAssetRevisions.id, f.revisionId));
    if (change === "policy-disabled") f.policy.sandboxEnabled = false;
    if (change === "policy-limits") f.policy.limits.maxOutputBytes = 64;
    const error = await f.check().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(federationExecutionDenial(error)).toBe("POLICY_DENIED");
  } finally {
    await f.cleanup();
  }
});

test("changing default mappings does not change an already running account", async () => {
  const f = await fixture();
  try {
    await db
      .update(userClusterAccountMappings)
      .set({ isDefault: false })
      .where(eq(userClusterAccountMappings.id, f.mappingId));
    const replacement = randomUUID();
    await db.insert(clusterExecutionAccounts).values({
      id: replacement,
      providerOrgId: f.orgId,
      agentId: f.agentId,
      displayName: "New default",
      backendType: "unix",
      username: "replacement",
      uid: 2001,
      gid: 2001,
    });
    await db
      .insert(userClusterAccountMappings)
      .values({ userId: f.userId, accountId: replacement, status: "approved", isDefault: true });
    await f.check();
    await db
      .update(userClusterAccountMappings)
      .set({ status: "revoked" })
      .where(eq(userClusterAccountMappings.id, f.mappingId));
    await expect(f.check()).rejects.toThrow("No approved mapped account");
  } finally {
    await f.cleanup();
  }
});

test("federated script grants are limited to the bound consumer organization", async () => {
  const f = await fixture();
  try {
    await db
      .update(softwareAssets)
      .set({ visibility: "private" })
      .where(eq(softwareAssets.id, f.assetId));
    const [grant] = await db
      .insert(softwareAssetGrants)
      .values({
        assetId: f.assetId,
        subjectKind: "org",
        subjectId: f.otherOrgId,
        capabilities: ["use"],
      })
      .returning();
    if (!grant) throw new Error("Missing grant");
    await expect(f.check()).rejects.toThrow("not authorized");
    await db
      .update(softwareAssetGrants)
      .set({ subjectId: f.orgId })
      .where(eq(softwareAssetGrants.id, grant.id));
    await f.check();
    await db.delete(userOrgMemberships).where(eq(userOrgMemberships.orgId, f.orgId));
    await expect(f.check()).rejects.toThrow("not authorized");
  } finally {
    await f.cleanup();
  }
});

test.each([
  "revoke",
  "expiry",
  "scope",
] as const)("SharedService attestation %s is observed", async (change) => {
  const f = await fixture(true);
  try {
    await f.check();
    await db
      .update(scriptAttestations)
      .set(
        change === "revoke"
          ? { revokedAt: new Date() }
          : change === "expiry"
            ? { expiresAt: new Date(1) }
            : { providerOrgId: f.otherOrgId },
      )
      .where(eq(scriptAttestations.id, f.attestationId));
    await expect(f.check()).rejects.toThrow("No valid attestation");
  } finally {
    await f.cleanup();
  }
});

test("Kubernetes namespace and service account remain bound to the original execution", async () => {
  const f = await fixture(false, true);
  try {
    await f.check();
    await db
      .update(clusterExecutionAccounts)
      .set({ serviceAccount: "replacement" })
      .where(eq(clusterExecutionAccounts.id, f.accountId));
    await expect(f.check()).rejects.toThrow("POLICY_DENIED");
  } finally {
    await f.cleanup();
  }
});

test("runtime contract binding revocation is checked even while its profile remains active", async () => {
  const f = await fixture();
  try {
    f.intent.sandbox.node.runtimeContractRef = { name: "bash", version: "1" };
    delete f.intent.sandbox.node.runtimeProfileId;
    const [binding] = await db
      .insert(sandboxRuntimeContractBindings)
      .values({
        providerOrgId: f.orgId,
        agentId: f.agentId,
        runtimeContractRef: "bash@1",
        runtimeProfileId: f.runtimeId,
        runtimeDigest: f.digest,
        boundBy: f.userId,
        attestationKeyId: "fixture",
        attestationSignature: "fixture",
        attestedAt: new Date(),
      })
      .returning();
    if (!binding) throw new Error("Missing binding");
    await f.check();
    await db
      .update(sandboxRuntimeContractBindings)
      .set({ revokedAt: new Date() })
      .where(eq(sandboxRuntimeContractBindings.id, binding.id));
    await expect(f.check()).rejects.toThrow("unambiguous active binding");
  } finally {
    await f.cleanup();
  }
});

test("an unavailable resolver is transient rather than a permanent policy denial", async () => {
  const f = await fixture();
  const unavailable = spyOn(SandboxExecutionResolver.prototype, "resolveRuntime").mockRejectedValue(
    new Error("Database unavailable"),
  );
  try {
    const error = await f.check().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(federationExecutionDenial(error)).toBeUndefined();
  } finally {
    unavailable.mockRestore();
    await f.cleanup();
  }
});
