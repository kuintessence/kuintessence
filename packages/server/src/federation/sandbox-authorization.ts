import { create, equals, fromBinary } from "@bufbuild/protobuf";
import {
  agents,
  jobDispatchOutbox,
  jobs,
  netdriveFiles,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  type DispatchJob,
  SandboxTrustedExecutionProfileSchema as ProtoExecutionProfileSchema,
  SandboxExecutionIdentitySchema,
  SandboxExecutionSchema,
  SandboxIoType,
  SandboxLanguage,
  SandboxMountMode,
  SandboxRuntimeKind,
  ServerMessageSchema,
} from "@kuintessence/proto";
import {
  type JobSubmission,
  SandboxSelfAccountSchema,
  SandboxSignedManifestSchema,
  SandboxTrustedExecutionProfileSchema,
  workflowDsl,
} from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { sandboxExecutionToProto } from "../grpc/dispatcher";
import { sandboxIdentityToProto } from "../grpc/sandbox-identity";
import {
  LicenseRuntimeGovernanceService,
  PgGovernanceRepository,
  sandboxRuntimeContractKey,
} from "../services/license-runtime-governance";
import { SandboxExecutionResolver } from "../services/sandbox-execution-resolver";
import type { SandboxPolicyService } from "../services/sandbox-policy";

const savedSandboxSchema = z.object({
  node: workflowDsl.WorkflowNodeSchema,
  executionIdentity: workflowDsl.ExecutionIdentitySchema,
  submittedBy: z.string(),
  orgId: z.string(),
});

/** Observe the original execution, never select a replacement account or issue a new manifest. */
export async function checkFederationSandboxJob(
  db: PgDb,
  jobId: string,
  intent: JobSubmission,
  identity: { userId: string; orgId: string },
  policies?: Pick<SandboxPolicyService, "effectiveFor">,
  transaction?: PgTransaction,
  requiredRuntime?: { kind: "OCI" | "SIF"; digest: string },
): Promise<number> {
  const connection = transaction ?? db;
  // Read the Job epoch and outbox in one snapshot; placement may still be preparing the outbox.
  const savedQuery = connection
    .select({ job: jobs, outbox: jobDispatchOutbox })
    .from(jobs)
    .leftJoin(jobDispatchOutbox, eq(jobDispatchOutbox.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
  const [saved] = await (transaction
    ? savedQuery.for("share", { of: jobs, noWait: true })
    : savedQuery);
  if (!saved || !["pending", "queued", "running"].includes(saved.job.status))
    return Number.POSITIVE_INFINITY;
  const { job, outbox } = saved;
  const message = outbox
    ? fromBinary(ServerMessageSchema, Buffer.from(outbox.payloadBase64, "base64"))
    : undefined;
  if (!("sandbox" in intent)) {
    if (message?.payload.case === "dispatchJob" && message.payload.value.sandboxExecution)
      throw new FederationError("OPERATION_CONFLICT");
    return Number.POSITIVE_INFINITY;
  }
  if (job.submittedBy !== identity.userId || job.orgId !== identity.orgId)
    throw new FederationError("OPERATION_CONFLICT");
  const parsed = savedSandboxSchema.safeParse(intent.sandbox);
  if (
    !parsed.success ||
    parsed.data.node.type !== "Script" ||
    parsed.data.submittedBy !== identity.userId ||
    parsed.data.orgId !== identity.orgId
  )
    throw new FederationError("OPERATION_CONFLICT");
  const { node, executionIdentity } = parsed.data;
  const resolver = new SandboxExecutionResolver(connection, Boolean(transaction));
  const source = await resolver.resolveSource(node, identity.userId, identity.orgId);
  if (!outbox || !message) {
    if (job.status === "pending") return Number.POSITIVE_INFINITY;
    if (job.status === "queued") throw new Error("Sandbox dispatch is still being prepared");
    throw new FederationError("OPERATION_CONFLICT");
  }
  if (
    message.payload.case !== "dispatchJob" ||
    !message.payload.value.federationExecution ||
    message.payload.value.jobId !== job.id ||
    message.payload.value.dispatchEpoch !== BigInt(job.dispatchEpoch) ||
    message.payload.value.restrictedNoEgress !== job.restrictedNoEgress ||
    outbox.dispatchEpoch !== job.dispatchEpoch ||
    outbox.agentId !== job.agentId
  )
    throw new FederationError("OPERATION_CONFLICT");
  const manifest = message.payload.value.sandboxExecution;
  const dispatchedQueue = message.payload.value.queueName;
  const persisted = SandboxSignedManifestSchema.safeParse(job.sandboxExecution);
  if (
    !persisted.success ||
    persisted.data.jobId !== jobId ||
    persisted.data.resources.cpus !== job.cpus ||
    persisted.data.resources.memoryMb !== job.memoryMb ||
    message.payload.value.cpus !== job.cpus ||
    message.payload.value.memoryMb !== BigInt(job.memoryMb) ||
    !manifest ||
    !equals(SandboxExecutionSchema, sandboxExecutionToProto(persisted.data), manifest)
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (!manifest?.script || !manifest.runtime || !manifest.executionIdentity || !manifest.limits)
    throw new FederationError("OPERATION_CONFLICT");
  const language = {
    python: SandboxLanguage.PYTHON,
    bash: SandboxLanguage.BASH,
    nodejs: SandboxLanguage.NODEJS,
  }[source.language];
  if (
    manifest.script.sha256 !== source.sha256 ||
    manifest.script.entrypoint !== source.entrypoint ||
    manifest.script.language !== language
  )
    throw new FederationError("OPERATION_CONFLICT");
  const agentQuery = connection.select().from(agents).where(eq(agents.agentId, outbox.agentId));
  const [agent] = await (transaction ? agentQuery.for("share", { noWait: true }) : agentQuery);
  if (!agent?.providerOrgId) throw new FederationError("POLICY_DENIED");
  const contract = node.runtimeContractRef ?? source.runtimeContractRef;
  const runtime = contract
    ? await resolver.resolveRuntimeForTarget({ ...agent, runtimeContractRef: contract })
    : await resolver.resolveRuntime(node.runtimeProfileId ?? "");
  const selected = resolver.runtimeForScheduler(runtime, agent.schedulerType);
  if (
    runtime.id !== manifest.runtime.profileId ||
    runtime.language !== source.language ||
    selected.digest !== manifest.runtime.digest ||
    (requiredRuntime &&
      (selected.kind !== requiredRuntime.kind || selected.digest !== requiredRuntime.digest)) ||
    manifest.runtime.kind !==
      (selected.kind === "OCI" ? SandboxRuntimeKind.OCI : SandboxRuntimeKind.SIF)
  )
    throw new FederationError("POLICY_DENIED");
  if (contract) {
    const governance = new LicenseRuntimeGovernanceService(
      new PgGovernanceRepository(connection, Boolean(transaction)),
    );
    const blocks = await governance.evaluateRuntime({
      contractId: sandboxRuntimeContractKey(contract),
      providerOrgId: agent.providerOrgId,
      agentId: agent.agentId,
      clusterId: agent.clusterId,
      runtimeProfileId: runtime.id,
    });
    if (blocks.length) throw new FederationError("POLICY_DENIED");
  }
  const identityAuthorization = await resolver.resolveIdentityAuthorization({
    requested: executionIdentity,
    pinnedAccountId: manifest.executionIdentity.accountId,
    userId: identity.userId,
    agentId: agent.agentId,
    providerOrgId: agent.providerOrgId,
    source,
    runtimeProfileId: runtime.id,
    runtimeDigest: selected.digest,
  });
  const currentIdentity = identityAuthorization.identity;
  let expiresAtUnixMs = identityAuthorization.expiresAtUnixMs;
  if (
    !equals(
      SandboxExecutionIdentitySchema,
      sandboxIdentityToProto(currentIdentity),
      manifest.executionIdentity,
    )
  )
    throw new FederationError("POLICY_DENIED");
  if (!policies) throw new Error("Federation Sandbox policy observation is unavailable");
  const policy = await policies.effectiveFor(agent, transaction);
  if (
    !policy.sandboxEnabled ||
    policy.disabledRuntimeProfileIds.includes(runtime.id) ||
    (currentIdentity.mode === "SharedService" && !policy.sharedServiceAllowed) ||
    (manifest.executionMode === "SelfAccount" && !policy.selfAccountEnabled) ||
    (manifest.executionMode === "RootImpersonation" &&
      currentIdentity.backend === "Unix" &&
      !policy.impersonationEnabled) ||
    job.cpus > policy.limits.maxCpuCores ||
    job.memoryMb > policy.limits.maxMemoryMb ||
    (job.wallTimeSec ?? 0) > policy.limits.maxWallTimeSec ||
    manifest.limits.pids > policy.limits.maxPids ||
    manifest.limits.outputBytes > BigInt(policy.limits.maxOutputBytes) ||
    manifest.limits.logBytes > BigInt(policy.limits.maxLogBytes)
  )
    throw new FederationError("POLICY_DENIED");
  const capabilities = z
    .object({
      executionMode: z.enum(["RootImpersonation", "SelfAccount"]),
      selfAccount: z.unknown().optional(),
      restrictedExecutionProfile: z.unknown().optional(),
    })
    .safeParse(agent.sandboxCapabilities);
  if (
    !capabilities.success ||
    capabilities.data.executionMode !== manifest.executionMode ||
    !manifest.networkDisabled
  )
    throw new FederationError("POLICY_DENIED");
  if (manifest.executionMode === "RootImpersonation") {
    if (currentIdentity.backend === "Unix" && !agent.rootMode)
      throw new FederationError("POLICY_DENIED");
    if (
      manifest.executionProfile ||
      (job.restrictedNoEgress && currentIdentity.backend === "Unix")
    ) {
      const profile = SandboxTrustedExecutionProfileSchema.safeParse(
        capabilities.data.restrictedExecutionProfile,
      );
      if (
        !profile.success ||
        !manifest.executionProfile ||
        selected.digest !== `sha256:${profile.data.sifSha256}` ||
        !equals(
          ProtoExecutionProfileSchema,
          create(ProtoExecutionProfileSchema, profile.data),
          manifest.executionProfile,
        )
      )
        throw new FederationError("POLICY_DENIED");
    }
  } else {
    const self = SandboxSelfAccountSchema.safeParse(capabilities.data.selfAccount);
    if (
      job.restrictedNoEgress ||
      (agent.schedulerType !== "slurm" && agent.schedulerType !== "pbs-pro") ||
      !policy.selfAccountEnabled ||
      currentIdentity.backend !== "Unix" ||
      currentIdentity.mode !== "MappedAccount" ||
      !self.success ||
      self.data.username !== currentIdentity.username ||
      self.data.uid !== currentIdentity.uid ||
      self.data.gid !== currentIdentity.gid
    )
      throw new FederationError("POLICY_DENIED");
  }
  if (currentIdentity.backend === "Unix") {
    const cacheEntry = z.object({
      kind: z.enum(["OCI", "SIF"]),
      digest: z.string(),
      signatureVerified: z.boolean(),
      runtimeAttestationId: z.string().regex(/^[0-9a-f]{64}$/),
      attestedNodes: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,255}$/)).min(1),
      attestedQueue: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
      expiresAtUnixMs: z.number().int().safe(),
    });
    const cache = Array.isArray(agent.sandboxRuntimeCache) ? agent.sandboxRuntimeCache : [];
    const evidence = cache
      .flatMap((raw) => {
        const parsed = cacheEntry.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      })
      .filter(
        (item) =>
          item.kind === selected.kind &&
          item.digest === selected.digest &&
          item.signatureVerified &&
          item.runtimeAttestationId === manifest.runtimeAttestationId &&
          item.attestedQueue === dispatchedQueue &&
          item.attestedQueue === job.schedulerQueueName &&
          item.attestedNodes.some((node) => node.trim()) &&
          item.expiresAtUnixMs > Date.now(),
      );
    if (!evidence.length) throw new FederationError("POLICY_DENIED");
    expiresAtUnixMs = Math.min(
      expiresAtUnixMs,
      Math.max(...evidence.map((item) => item.expiresAtUnixMs)),
    );
  }
  await checkSandboxFiles(
    connection,
    message.payload.value,
    intent,
    identity.userId,
    Boolean(transaction),
  );
  return expiresAtUnixMs;
}

async function checkSandboxFiles(
  db: PgDb | PgTransaction,
  dispatch: DispatchJob,
  intent: JobSubmission,
  userId: string,
  lock: boolean,
) {
  const expectedPaths =
    dispatch.sandboxExecution?.artifactMounts.flatMap((mount) =>
      mount.mode !== SandboxMountMode.READ_ONLY
        ? []
        : mount.ioType === SandboxIoType.FILE
          ? [mount.relativePath]
          : mount.ioType === SandboxIoType.FILE_BATCH
            ? mount.batchEntries.map((entry) => `${mount.relativePath}/${entry.relativePath}`)
            : [],
    ) ?? [];
  if (
    new Set(expectedPaths).size !== expectedPaths.length ||
    expectedPaths.length !== dispatch.inputStaging.length ||
    dispatch.inputStaging.some((input) => !expectedPaths.includes(input.stagePath))
  )
    throw new FederationError("OPERATION_CONFLICT");
  const staged = dispatch.inputStaging.filter(
    (input) =>
      input.netdriveInput || (!input.deliveryLeaseId && input.deliveryLeaseExpiresAtUnixMs === 0n),
  );
  if (
    staged.length !== intent.inputStaging.length ||
    new Set(staged.map((input) => input.stagePath)).size !== staged.length ||
    staged.some(
      (input) =>
        !z.uuid().safeParse(input.fileMetadataId).success ||
        !intent.inputStaging.some(
          (saved) =>
            saved.fileMetadataId === input.fileMetadataId && saved.stagePath === input.stagePath,
        ),
    )
  )
    throw new FederationError("OPERATION_CONFLICT");
  if (!staged.length) return;
  const query = db
    .select()
    .from(netdriveFiles)
    .where(inArray(netdriveFiles.id, [...new Set(staged.map((input) => input.fileMetadataId))]))
    .orderBy(netdriveFiles.id);
  const files = await (lock ? query.for("share", { noWait: true }) : query);
  for (const input of staged) {
    const file = files.find((file) => file.id === input.fileMetadataId);
    if (!file || file.ownerId !== userId || file.deletedAt)
      throw new FederationError("POLICY_DENIED");
    const mount = dispatch.sandboxExecution?.artifactMounts.find(
      (mount) =>
        mount.mode === SandboxMountMode.READ_ONLY &&
        (mount.ioType === SandboxIoType.FILE
          ? mount.relativePath === input.stagePath
          : mount.ioType === SandboxIoType.FILE_BATCH &&
            mount.batchEntries.some(
              (entry) => `${mount.relativePath}/${entry.relativePath}` === input.stagePath,
            )),
    );
    if (!mount || mount.sizeLimitBytes < BigInt(file.size))
      throw new FederationError("OPERATION_CONFLICT");
    const expected =
      mount.ioType === SandboxIoType.FILE
        ? { sha256: mount.expectedSha256, sizeBytes: BigInt(file.size) }
        : mount.batchEntries.find(
            (entry) => `${mount.relativePath}/${entry.relativePath}` === input.stagePath,
          );
    if (!expected || file.sha256 !== expected.sha256 || BigInt(file.size) !== expected.sizeBytes)
      throw new FederationError("POLICY_DENIED");
  }
}
