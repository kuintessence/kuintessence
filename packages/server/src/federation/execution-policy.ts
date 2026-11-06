import {
  agents,
  dataAccessPolicies,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  jobDataBindings,
  jobs,
  type PgDb,
  type PgTransaction,
  schedulerQueues,
  softwareOperations,
  workflowExecutionJobs,
} from "@kuintessence/db";
import { AppError, DataDeliveryPolicySchema, type JobSubmission } from "@kuintessence/shared";
import { FederationError, type FederationExecutionTarget } from "@kuintessence/shared/federation";
import { and, eq, inArray } from "drizzle-orm";
import { AuthorizationUnavailableError } from "../authz/service";
import { PgDataPrerequisiteRepository } from "../services/data-prerequisite-repository-drizzle";
import type { QueueRegistryService } from "../services/queue-registry";
import { SandboxAuthorizationError } from "../services/sandbox-execution-resolver";
import type { SandboxPolicyService } from "../services/sandbox-policy";
import type { SoftwareAvailabilityService } from "../services/software-availability";
import type { FederationDeliveryTarget } from "./dispatch-authorization";
import { loadFederationWorkflowBinding } from "./execution-binding";
import { matchesFederationTarget } from "./execution-targets";
import { checkFederationLicensedMaterials } from "./licensed-material-authorization";
import { checkFederationSandboxJob } from "./sandbox-authorization";
import { prepareFederationSoftware } from "./software-authorization";

/** Observe active authorization without requiring a live transport or reissuing download credentials. */
export async function checkFederationExecutionPolicy(
  db: PgDb,
  runId: string,
  queues: Pick<QueueRegistryService, "assertExecutionAccess"> | undefined,
  software: Pick<SoftwareAvailabilityService, "resolve" | "assertExecutionAccess"> | undefined,
  sandboxPolicies?: Pick<SandboxPolicyService, "effectiveFor">,
): Promise<void> {
  const binding = await loadFederationWorkflowBinding(db, runId);
  if (!binding) throw new FederationError("OPERATION_CONFLICT");
  const { identity } = binding.snapshot;
  const targets = binding.snapshot.executionTargets ?? [];
  const active = await db
    .select({ job: jobs, intent: workflowExecutionJobs.intent })
    .from(workflowExecutionJobs)
    .innerJoin(jobs, eq(jobs.id, workflowExecutionJobs.jobId))
    .where(
      and(
        eq(workflowExecutionJobs.runId, runId),
        inArray(jobs.status, ["pending", "queued", "running"]),
      ),
    );
  const installations = await db
    .select({ operation: softwareOperations, job: jobs, intent: workflowExecutionJobs.intent })
    .from(softwareOperations)
    .innerJoin(jobs, eq(jobs.id, softwareOperations.federationJobId))
    .innerJoin(workflowExecutionJobs, eq(workflowExecutionJobs.jobId, jobs.id))
    .where(
      and(
        eq(workflowExecutionJobs.runId, runId),
        inArray(softwareOperations.status, ["queued", "running"]),
      ),
    );
  let transient: unknown;
  const defer = (error: unknown) => {
    transient ??= error;
  };
  const inspect = async (check: () => Promise<unknown>) => {
    try {
      await check();
    } catch (error) {
      if (federationExecutionDenial(error)) throw error;
      defer(error);
    }
  };
  const checkOwner = (job: typeof jobs.$inferSelect) => {
    if (job.submittedBy !== identity.userId || job.orgId !== identity.orgId)
      throw new FederationError("OPERATION_CONFLICT");
  };
  const checkSoftware = async (
    intent: JobSubmission,
    delivery: FederationDeliveryTarget,
    providerOrgId: string,
  ) => {
    const fence = await prepareFederationSoftware(intent, identity, delivery, software, true);
    await db.transaction((tx) => fence(tx, providerOrgId));
  };
  for (const { job, intent } of active) {
    checkOwner(job);
    await inspect(async () => {
      if (job.agentId) {
        const target = await checkTarget(db, queues, targets, identity, job.agentId, defer, job);
        await checkSoftware(
          intent,
          { kind: "compute", jobId: job.id, agentId: job.agentId },
          target.providerOrgId,
        );
      } else if (job.status !== "pending") throw new FederationError("OPERATION_CONFLICT");
    });
    await inspect(async () => {
      if (!job.agentId) return;
      const target = targets.find(
        (target) => target.agentId === job.agentId && target.queueId === job.queueId,
      );
      if (!target) throw new FederationError("POLICY_DENIED");
      await checkFederationLicensedMaterials(db, job.id, intent, identity, target);
    });
    await inspect(() => checkFederationJobData(db, job.id, identity));
    await inspect(() =>
      checkFederationSandboxJob(
        db,
        job.id,
        intent,
        identity,
        sandboxPolicies,
        undefined,
        binding.snapshot.environment.sandboxRuntime,
      ),
    );
  }
  for (const { operation, job, intent } of installations) {
    checkOwner(job);
    if (
      job.status !== "pending" ||
      operation.requestedBy !== identity.userId ||
      !job.softwareRequirements?.some((requirement) => requirement.operationId === operation.id)
    )
      throw new FederationError("OPERATION_CONFLICT");
    await inspect(async () => {
      const target = await checkTarget(db, queues, targets, identity, operation.agentId, defer);
      await checkSoftware(
        intent,
        { kind: "install", jobId: job.id, agentId: operation.agentId, spec: operation.spec },
        target.providerOrgId,
      );
    });
  }
  if (transient !== undefined) throw transient;
}

async function checkTarget(
  db: PgDb,
  queues: Pick<QueueRegistryService, "assertExecutionAccess"> | undefined,
  targets: readonly FederationExecutionTarget[],
  identity: { userId: string; orgId: string },
  agentId: string,
  defer: (error: unknown) => void,
  job?: typeof jobs.$inferSelect,
): Promise<FederationExecutionTarget> {
  if (!queues) throw new Error("Federation execution queue authorization unavailable");
  if (job && !job.queueId) throw new FederationError("OPERATION_CONFLICT");
  for (const target of targets.filter(
    (target) => target.agentId === agentId && (!job || target.queueId === job.queueId),
  )) {
    const [row] = await db
      .select({ agent: agents, queue: schedulerQueues })
      .from(schedulerQueues)
      .innerJoin(agents, eq(agents.agentId, schedulerQueues.agentId))
      .where(eq(schedulerQueues.queueId, target.queueId));
    if (!row || !matchesFederationTarget(target, row.agent, row.queue)) continue;
    if (
      job &&
      (job.queueTargetMode !== row.queue.targetMode ||
        (row.queue.targetMode === "named" && job.schedulerQueueName !== row.queue.queueName))
    )
      continue;
    try {
      await queues.assertExecutionAccess(target.queueId, { ...identity, role: "user" });
      return target;
    } catch (error) {
      if (
        error instanceof AuthorizationUnavailableError ||
        !(error instanceof AppError && (error.statusCode === 403 || error.statusCode === 404))
      ) {
        // No permit is issued here; keep checking independent software/data policy during an outage.
        defer(error);
        return target;
      }
    }
  }
  throw new FederationError("POLICY_DENIED");
}

export async function checkFederationJobData(
  db: PgDb | PgTransaction,
  jobId: string,
  identity: { userId: string; orgId: string },
  lock = false,
) {
  if (lock) {
    // The caller holds the Job UPDATE lock, fencing new bindings. NOWAIT avoids revoke lock inversion.
    const bound = await db
      .select()
      .from(jobDataBindings)
      .where(and(eq(jobDataBindings.jobId, jobId), eq(jobDataBindings.source, "data-market")))
      .orderBy(jobDataBindings.id)
      .for("update", { noWait: true });
    const assetIds = [
      ...new Set(bound.flatMap((row) => (row.assetId ? [row.assetId] : []))),
    ].sort();
    const versionIds = [
      ...new Set(bound.flatMap((row) => (row.versionId ? [row.versionId] : []))),
    ].sort();
    if (assetIds.length) {
      await db
        .select()
        .from(dataAssets)
        .where(inArray(dataAssets.id, assetIds))
        .orderBy(dataAssets.id)
        .for("update", { noWait: true });
      await db
        .select()
        .from(dataAssetVersions)
        .where(inArray(dataAssetVersions.id, versionIds))
        .orderBy(dataAssetVersions.id)
        .for("update", { noWait: true });
      await db
        .select()
        .from(dataGrants)
        .where(inArray(dataGrants.dataAssetId, assetIds))
        .orderBy(dataGrants.id)
        .for("update", { noWait: true });
      await db
        .select()
        .from(dataAccessPolicies)
        .where(inArray(dataAccessPolicies.dataAssetId, assetIds))
        .orderBy(dataAccessPolicies.id)
        .for("update", { noWait: true });
    }
  }
  const bindings = await db
    .select({ binding: jobDataBindings, asset: dataAssets, version: dataAssetVersions })
    .from(jobDataBindings)
    .leftJoin(dataAssets, eq(dataAssets.id, jobDataBindings.assetId))
    .leftJoin(dataAssetVersions, eq(dataAssetVersions.id, jobDataBindings.versionId))
    .where(and(eq(jobDataBindings.jobId, jobId), eq(jobDataBindings.source, "data-market")));
  const access = new PgDataPrerequisiteRepository(db);
  let expiresAtUnixMs = Number.POSITIVE_INFINITY;
  for (const { binding, asset, version } of bindings) {
    if (
      !asset ||
      !version ||
      version.dataAssetId !== asset.id ||
      version.manifestDigest !== binding.manifestDigest ||
      asset.kind !== binding.assetKind ||
      asset.sensitivity !== binding.sensitivity
    )
      throw new FederationError("OPERATION_CONFLICT");
    if (
      asset.lifecycle === "revoked" ||
      asset.lifecycle === "archived" ||
      version.status === "revoked"
    )
      throw new FederationError("POLICY_DENIED");
    const currentPolicy = DataDeliveryPolicySchema.safeParse(version.manifest.deliveryPolicy ?? {});
    const boundPolicy = DataDeliveryPolicySchema.safeParse(binding.deliveryPolicy);
    if (!currentPolicy.success || !boundPolicy.success)
      throw new FederationError("OPERATION_CONFLICT");
    if (JSON.stringify(currentPolicy.data) !== JSON.stringify(boundPolicy.data))
      throw new FederationError("POLICY_DENIED");
    const authorization = await access.authorizeAccess({
      actorUserId: identity.userId,
      orgId: identity.orgId,
      assetId: asset.id,
      versionId: version.id,
    });
    if (!authorization.allowed) throw new FederationError("POLICY_DENIED");
    expiresAtUnixMs = Math.min(expiresAtUnixMs, authorization.expiresAtUnixMs);
  }
  return expiresAtUnixMs;
}

export function federationExecutionDenial(error: unknown): string | undefined {
  if (error instanceof SandboxAuthorizationError) return "POLICY_DENIED";
  if (error instanceof AuthorizationUnavailableError) return undefined;
  if (
    error instanceof FederationError &&
    error.code !== "ASSET_UNAVAILABLE" &&
    error.code !== "DATA_WAITING"
  )
    return error.code;
  if (error instanceof AppError && error.statusCode === 403) return "POLICY_DENIED";
  return undefined;
}
