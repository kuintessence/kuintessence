import { equals, fromBinary } from "@bufbuild/protobuf";
import { agents, jobDispatchOutbox, jobs, type PgDb } from "@kuintessence/db";
import {
  SandboxExecutionIdentitySchema,
  SandboxLanguage,
  SandboxRuntimeKind,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { type JobSubmission, workflowDsl } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { z } from "zod";
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
): Promise<void> {
  if (!("sandbox" in intent)) return;
  // Placement publishes the Job epoch and outbox together; read both in the same snapshot.
  const [saved] = await db
    .select({ job: jobs, outbox: jobDispatchOutbox })
    .from(jobs)
    .leftJoin(jobDispatchOutbox, eq(jobDispatchOutbox.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
  if (!saved || !["pending", "queued", "running"].includes(saved.job.status)) return;
  const { job, outbox } = saved;
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
  const resolver = new SandboxExecutionResolver(db);
  const source = await resolver.resolveSource(node, identity.userId, identity.orgId);
  if (!outbox) {
    if (job.status === "pending") return;
    throw new FederationError("OPERATION_CONFLICT");
  }
  const message = fromBinary(ServerMessageSchema, Buffer.from(outbox.payloadBase64, "base64"));
  if (
    message.payload.case !== "dispatchJob" ||
    !message.payload.value.federationExecution ||
    message.payload.value.jobId !== job.id ||
    message.payload.value.dispatchEpoch !== BigInt(job.dispatchEpoch) ||
    outbox.dispatchEpoch !== job.dispatchEpoch ||
    outbox.agentId !== job.agentId
  )
    throw new FederationError("OPERATION_CONFLICT");
  const manifest = message.payload.value.sandboxExecution;
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
  const [agent] = await db.select().from(agents).where(eq(agents.agentId, outbox.agentId));
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
    manifest.runtime.kind !==
      (selected.kind === "OCI" ? SandboxRuntimeKind.OCI : SandboxRuntimeKind.SIF)
  )
    throw new FederationError("POLICY_DENIED");
  if (contract) {
    const governance = new LicenseRuntimeGovernanceService(new PgGovernanceRepository(db));
    const blocks = await governance.evaluateRuntime({
      contractId: sandboxRuntimeContractKey(contract),
      providerOrgId: agent.providerOrgId,
      agentId: agent.agentId,
      clusterId: agent.clusterId,
      runtimeProfileId: runtime.id,
    });
    if (blocks.length) throw new FederationError("POLICY_DENIED");
  }
  const currentIdentity = await resolver.resolveIdentity({
    requested: executionIdentity,
    pinnedAccountId: manifest.executionIdentity.accountId,
    userId: identity.userId,
    agentId: agent.agentId,
    providerOrgId: agent.providerOrgId,
    source,
    runtimeProfileId: runtime.id,
    runtimeDigest: selected.digest,
  });
  if (
    !equals(
      SandboxExecutionIdentitySchema,
      sandboxIdentityToProto(currentIdentity),
      manifest.executionIdentity,
    )
  )
    throw new FederationError("POLICY_DENIED");
  if (!policies) throw new Error("Federation Sandbox policy observation is unavailable");
  const policy = await policies.effectiveFor(agent);
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
}
