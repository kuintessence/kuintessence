import { afterAll, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  agents,
  clusterExecutionAccounts,
  createPgDb,
  jobDispatchOutbox,
  jobs,
  netdriveFiles,
  orgs,
  type PgTransaction,
  sandboxPolicyOverlays,
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
import { eq, inArray, sql } from "drizzle-orm";
import { AgentDispatcher } from "../grpc/dispatcher";
import { SandboxExecutionResolver } from "../services/sandbox-execution-resolver";
import { SandboxPolicyService } from "../services/sandbox-policy";
import { hashSandboxScript } from "../services/sandbox-script";
import { federationExecutionDenial } from "./execution-policy";
import { checkFederationSandboxJob } from "./sandbox-authorization";

const url = process.env.DATABASE_URL;
if (!url || !/^\/kuintessence_unit_[a-z0-9_]+$/.test(new URL(url).pathname))
  throw new Error("Sandbox authorization requires an isolated unit database");
const db = createPgDb(url, { max: 8, idle_timeout: 1 });
const other = createPgDb(url, { max: 1, idle_timeout: 1 });
afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await other.$client.end({ timeout: 5 });
});

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
    rootMode: true,
    sandboxCapabilities: { executionMode: "RootImpersonation" },
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
    inputStaging: [] as Array<{ fileMetadataId: string; stagePath: string }>,
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
    resources: { cpus: 1, memoryMb: 128 },
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
    sandboxExecution: manifest,
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
  const policies = new SandboxPolicyService(db, policy);
  const check = (transaction?: PgTransaction) =>
    checkFederationSandboxJob(db, jobId, intent, { userId, orgId }, policies, transaction);
  const persist = async () => {
    await db
      .update(jobs)
      .set({
        sandboxExecution: manifest,
        ...(manifest.executionMode === "SelfAccount" ? { schedulerQueueName: "compute" } : {}),
      })
      .where(eq(jobs.id, jobId));
    const message = new AgentDispatcher().buildDispatchJob(jobId, {
      jobIdInternal: jobId,
      name: "Sandbox fixture",
      command: "true",
      resources: { cpus: 1, memoryMb: 128, wallTimeSec: 30 },
      dispatchEpoch: 1,
      sandboxExecution: manifest,
      federationExecution: true,
      inputStaging: intent.inputStaging,
      restrictedNoEgress: Boolean(manifest.executionProfile),
      ...(manifest.executionMode === "SelfAccount" ? { queueName: "compute" } : {}),
    });
    await db
      .update(jobDispatchOutbox)
      .set({
        payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
      })
      .where(eq(jobDispatchOutbox.jobId, jobId));
  };
  return {
    userId,
    jobId,
    manifest,
    persist,
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
      await db.delete(sandboxPolicyOverlays).where(eq(sandboxPolicyOverlays.updatedBy, userId));
      await db.delete(netdriveFiles).where(eq(netdriveFiles.ownerId, userId));
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
  false,
  true,
])("Sandbox permit uses the actual identity authorization deadline (shared=%s)", async (shared) => {
  const f = await fixture(shared);
  try {
    const expiry = new Date(Date.now() + 5_000);
    if (shared)
      await db
        .update(scriptAttestations)
        .set({ expiresAt: expiry })
        .where(eq(scriptAttestations.id, f.attestationId));
    else
      await db
        .update(userClusterAccountMappings)
        .set({ expiresAt: expiry })
        .where(eq(userClusterAccountMappings.id, f.mappingId));
    await db.transaction(async (tx) => {
      expect(await f.check(tx)).toBe(expiry.getTime());
      if (shared)
        await expect(
          Promise.resolve(
            other.execute(
              sql`select id from script_attestations where id=${f.attestationId} for update nowait`,
            ),
          ),
        ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });
  } finally {
    await f.cleanup();
  }
});

test("a more-specific runtime binding cannot appear inside the final Sandbox authorization fence", async () => {
  const f = await fixture();
  const replacement = randomUUID();
  try {
    f.intent.sandbox.node.runtimeContractRef = { name: "bash", version: "1" };
    delete f.intent.sandbox.node.runtimeProfileId;
    await db.insert(sandboxRuntimeContractBindings).values({
      providerOrgId: f.orgId,
      runtimeContractRef: "bash@1",
      runtimeProfileId: f.runtimeId,
      runtimeDigest: f.digest,
      boundBy: f.userId,
      attestationKeyId: "fixture",
      attestationSignature: "fixture",
      attestedAt: new Date(),
    });
    const replacementDigest = `sha256:${replacement.replaceAll("-", "").repeat(2)}`;
    await db.insert(sandboxRuntimeProfiles).values({
      id: replacement,
      name: "Replacement",
      language: "bash",
      languageVersion: "5",
      sifDigest: replacementDigest,
      signature: "fixture",
      securityRequirements: {},
      lifecycle: "active",
      adapters: ["slurm"],
    });
    const binding = {
      providerOrgId: f.orgId,
      agentId: f.agentId,
      agentScopeKey: f.agentId,
      runtimeContractRef: "bash@1",
      runtimeProfileId: replacement,
      runtimeDigest: replacementDigest,
      boundBy: f.userId,
      attestationKeyId: "fixture",
      attestationSignature: "fixture",
      attestedAt: new Date(),
    };
    await db.transaction(async (tx) => {
      await f.check(tx);
      await expect(
        other.transaction(async (writer) => {
          await writer.execute(sql`set local lock_timeout = '100ms'`);
          await writer.insert(sandboxRuntimeContractBindings).values(binding);
        }),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });
    await other.insert(sandboxRuntimeContractBindings).values(binding);
    await expect(db.transaction((tx) => f.check(tx))).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db
      .delete(sandboxRuntimeContractBindings)
      .where(eq(sandboxRuntimeContractBindings.providerOrgId, f.orgId));
    await db.delete(sandboxRuntimeProfiles).where(eq(sandboxRuntimeProfiles.id, replacement));
    await f.cleanup();
  }
});

test("the Sandbox fence holds every selected local authority until commit", async () => {
  const f = await fixture();
  try {
    await db
      .update(softwareAssets)
      .set({ visibility: "private" })
      .where(eq(softwareAssets.id, f.assetId));
    const [grant] = await db
      .insert(softwareAssetGrants)
      .values({ assetId: f.assetId, subjectKind: "org", subjectId: f.orgId, capabilities: ["use"] })
      .returning();
    if (!grant) throw new Error("Missing grant");
    await db.transaction(async (tx) => {
      await f.check(tx);
      for (const query of [
        sql`select id from software_assets where id=${f.assetId} for update nowait`,
        sql`select id from software_asset_revisions where id=${f.revisionId} for update nowait`,
        sql`select id from software_asset_grants where id=${grant.id} for update nowait`,
        sql`select id from user_org_memberships where user_id=${f.userId} and org_id=${f.orgId} for update nowait`,
        sql`select id from cluster_execution_accounts where id=${f.accountId} for update nowait`,
        sql`select id from user_cluster_account_mappings where id=${f.mappingId} for update nowait`,
        sql`select id from sandbox_runtime_profiles where id=${f.runtimeId} for update nowait`,
        sql`select agent_id from agents where agent_id=${f.agentId} for update nowait`,
      ])
        await expect(Promise.resolve(other.execute(query))).rejects.toMatchObject({
          cause: { code: "55P03" },
        });
      await expect(
        other.transaction(async (writer) => {
          await writer.execute(sql`set local lock_timeout = '100ms'`);
          await writer
            .insert(sandboxPolicyOverlays)
            .values({ scope: "platform", policy: { sandboxEnabled: false }, updatedBy: f.userId });
        }),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });
    await other
      .insert(sandboxPolicyOverlays)
      .values({ scope: "platform", policy: { sandboxEnabled: false }, updatedBy: f.userId });
    await expect(db.transaction((tx) => f.check(tx))).rejects.toThrow("POLICY_DENIED");
  } finally {
    await f.cleanup();
  }
});

test("an existing Sandbox policy writer causes a transient retry rather than a permit", async () => {
  const f = await fixture();
  try {
    await other.transaction(async (writer) => {
      await writer.insert(sandboxPolicyOverlays).values({
        scope: "agent",
        agentId: f.agentId,
        policy: { sandboxEnabled: false },
        updatedBy: f.userId,
      });
      const error = await db
        .transaction((tx) => f.check(tx))
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(error).toMatchObject({ cause: { code: "55P03" } });
      expect(federationExecutionDenial(error)).toBeUndefined();
    });
    await expect(db.transaction((tx) => f.check(tx))).rejects.toThrow("POLICY_DENIED");
  } finally {
    await f.cleanup();
  }
});

test.each([
  "expired",
  "replacement",
  "account",
  "mode",
  "queue",
  "missing-queue",
  "dispatch-queue",
  "job-queue",
] as const)("SelfAccount keeps its original runtime proof and rejects %s changes", async (change) => {
  const f = await fixture();
  try {
    const expiry = Date.now() + 5_000;
    const evidence = {
      kind: "SIF",
      digest: f.digest,
      signatureVerified: true,
      runtimeAttestationId: "a".repeat(64),
      attestedNodes: ["compute-1"],
      attestedQueue: "compute",
      expiresAtUnixMs: expiry,
    };
    const capabilities = {
      executionMode: "SelfAccount",
      selfAccount: { username: "scientist", uid: 1001, gid: 1001 },
    };
    await db
      .update(agents)
      .set({
        sandboxCapabilities: capabilities,
        sandboxRuntimeCache: [{ kind: "OCI", digest: "unrelated-runtime" }, evidence],
      })
      .where(eq(agents.agentId, f.agentId));
    f.manifest.executionMode = "SelfAccount";
    f.manifest.runtimeAttestationId = evidence.runtimeAttestationId;
    await f.persist();
    expect(await db.transaction((tx) => f.check(tx))).toBe(expiry);
    if (change === "expired") evidence.expiresAtUnixMs = 1;
    if (change === "replacement") evidence.runtimeAttestationId = "b".repeat(64);
    if (change === "account") capabilities.selfAccount.uid = 2001;
    if (change === "mode") capabilities.executionMode = "RootImpersonation";
    if (change === "queue") evidence.attestedQueue = "other";
    if (change === "missing-queue") evidence.attestedQueue = "";
    if (change === "job-queue") {
      await db.update(jobs).set({ schedulerQueueName: "other" }).where(eq(jobs.id, f.jobId));
    }
    if (change === "dispatch-queue") {
      const [saved] = await db
        .select()
        .from(jobDispatchOutbox)
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
      if (!saved) throw new Error("Missing original outbox");
      const message = fromBinary(ServerMessageSchema, Buffer.from(saved.payloadBase64, "base64"));
      if (message.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
      message.payload.value.queueName = "other";
      await db
        .update(jobDispatchOutbox)
        .set({
          payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
        })
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
    }
    await db
      .update(agents)
      .set({
        sandboxCapabilities: capabilities,
        sandboxRuntimeCache: [{ kind: "OCI", digest: "unrelated-runtime" }, evidence],
      })
      .where(eq(agents.agentId, f.agentId));
    await expect(db.transaction((tx) => f.check(tx))).rejects.toThrow("POLICY_DENIED");
  } finally {
    await f.cleanup();
  }
});

test("restricted Unix execution keeps its original trusted wrapper profile", async () => {
  const f = await fixture();
  try {
    const profile = {
      profileId: randomUUID(),
      apptainerCanonicalPath: "/opt/kq/apptainer",
      apptainerSha256: "a".repeat(64),
      sifCanonicalPath: "/opt/kq/runtime.sif",
      sifSha256: f.digest.slice(7),
      trustedWrapperCanonicalPath: "/opt/kq/wrapper",
      trustedWrapperSha256: "b".repeat(64),
    };
    f.manifest.executionProfile = profile;
    await f.persist();
    await db.update(jobs).set({ restrictedNoEgress: true }).where(eq(jobs.id, f.jobId));
    await db
      .update(agents)
      .set({
        sandboxCapabilities: {
          executionMode: "RootImpersonation",
          restrictedExecutionProfile: profile,
        },
      })
      .where(eq(agents.agentId, f.agentId));
    await db.transaction((tx) => f.check(tx));
    await db
      .update(agents)
      .set({
        sandboxCapabilities: {
          executionMode: "RootImpersonation",
          restrictedExecutionProfile: { ...profile, trustedWrapperSha256: "c".repeat(64) },
        },
      })
      .where(eq(agents.agentId, f.agentId));
    await expect(db.transaction((tx) => f.check(tx))).rejects.toThrow("POLICY_DENIED");
  } finally {
    await f.cleanup();
  }
});

test.each([
  "delete",
  "hash",
  "owner",
  "renewable",
] as const)("Sandbox file authorization is retained and rejects %s after dispatch", async (change) => {
  const f = await fixture();
  const otherUser = randomUUID();
  try {
    await db.insert(users).values({ id: otherUser, email: `${otherUser}@test.invalid` });
    const [file] = await db
      .insert(netdriveFiles)
      .values({
        ownerId: f.userId,
        path: "input.txt",
        size: 4,
        sha256: "a".repeat(64),
        storageKey: "fixture/input.txt",
      })
      .returning();
    if (!file) throw new Error("Missing file");
    f.intent.inputStaging.push({ fileMetadataId: file.id, stagePath: "inputs/data" });
    f.manifest.mounts.push({
      descriptor: "data",
      ioType: "File",
      mode: "ReadOnly",
      relativePath: "inputs/data",
      containerPath: "/kq/inputs/data",
      expectedSha256: file.sha256,
      batchEntries: [],
      sizeLimitBytes: 4,
      required: true,
    });
    await f.persist();
    if (change === "renewable") {
      const [saved] = await db
        .select()
        .from(jobDispatchOutbox)
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
      if (!saved) throw new Error("Missing outbox");
      const message = fromBinary(ServerMessageSchema, Buffer.from(saved.payloadBase64, "base64"));
      if (message.payload.case !== "dispatchJob" || !message.payload.value.inputStaging[0])
        throw new Error("Missing input");
      Object.assign(message.payload.value.inputStaging[0], {
        netdriveInput: true,
        expectedSha256: file.sha256,
        expectedSizeBytes: 4n,
        deliveryLeaseId: randomUUID(),
        deliveryLeaseExpiresAtUnixMs: 1n,
      });
      await db
        .update(jobDispatchOutbox)
        .set({
          payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
        })
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
    }
    await db.transaction(async (tx) => {
      await f.check(tx);
      await expect(
        Promise.resolve(
          other.execute(sql`select id from netdrive_files where id=${file.id} for update nowait`),
        ),
      ).rejects.toMatchObject({ cause: { code: "55P03" } });
    });
    await db
      .update(netdriveFiles)
      .set(
        change === "delete"
          ? { deletedAt: new Date() }
          : change === "hash"
            ? { sha256: "b".repeat(64) }
            : { ownerId: otherUser },
      )
      .where(eq(netdriveFiles.id, file.id));
    await expect(db.transaction((tx) => f.check(tx))).rejects.toThrow("POLICY_DENIED");
  } finally {
    await db.delete(users).where(eq(users.id, otherUser));
    await f.cleanup();
  }
});

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

test("incomplete placement is retried without masking a revoked Sandbox source", async () => {
  const f = await fixture();
  try {
    await db.delete(jobDispatchOutbox).where(eq(jobDispatchOutbox.jobId, f.jobId));
    await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, f.jobId));
    const error = await f.check().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(federationExecutionDenial(error)).toBeUndefined();
    await db.update(jobs).set({ status: "running" }).where(eq(jobs.id, f.jobId));
    await expect(f.check()).rejects.toThrow("OPERATION_CONFLICT");
    await db.update(jobs).set({ status: "queued" }).where(eq(jobs.id, f.jobId));
    await db
      .update(softwareAssets)
      .set({ lifecycle: "revoked" })
      .where(eq(softwareAssets.id, f.assetId));
    const revoked = await f.check().catch((error: unknown) => error);
    expect(federationExecutionDenial(revoked)).toBe("POLICY_DENIED");
  } finally {
    await f.cleanup();
  }
});

test.each([
  "job-cpu",
  "job-memory",
  "manifest-cpu",
  "manifest-memory",
  "dispatch-cpu",
  "dispatch-memory",
  "legacy",
] as const)("Sandbox renewal refuses resource drift even within policy limits: %s", async (change) => {
  const f = await fixture();
  try {
    if (change === "job-cpu" || change === "job-memory") {
      await db
        .update(jobs)
        .set(change === "job-cpu" ? { cpus: 2 } : { memoryMb: 256 })
        .where(eq(jobs.id, f.jobId));
    } else if (change === "manifest-cpu" || change === "manifest-memory") {
      if (change === "manifest-cpu") f.manifest.resources.cpus = 2;
      else f.manifest.resources.memoryMb = 256;
      await f.persist();
    } else if (change === "legacy") {
      const { resources: _resources, ...legacy } = f.manifest;
      await db.update(jobs).set({ sandboxExecution: legacy }).where(eq(jobs.id, f.jobId));
    } else {
      const [row] = await db
        .select()
        .from(jobDispatchOutbox)
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
      if (!row) throw new Error("Missing outbox");
      const message = fromBinary(ServerMessageSchema, Buffer.from(row.payloadBase64, "base64"));
      if (message.payload.case !== "dispatchJob") throw new Error("Missing dispatch");
      if (change === "dispatch-cpu") message.payload.value.cpus = 2;
      else message.payload.value.memoryMb = 256n;
      await db
        .update(jobDispatchOutbox)
        .set({
          payloadBase64: Buffer.from(toBinary(ServerMessageSchema, message)).toString("base64"),
        })
        .where(eq(jobDispatchOutbox.jobId, f.jobId));
    }
    await expect(db.transaction((tx) => f.check(tx))).rejects.toThrow("OPERATION_CONFLICT");
  } finally {
    await f.cleanup();
  }
});
