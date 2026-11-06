import {
  federationWorkflowBindings,
  jobs,
  type PgDb,
  type PgTransaction,
  schedulerQueues,
  workflowExecutionJobs,
} from "@kuintessence/db";
import { WorkflowExecutionInterrupted } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { and, eq } from "drizzle-orm";
import type { QueueRegistryService } from "../services/queue-registry";
import type { SandboxPolicyService } from "../services/sandbox-policy";
import type { SoftwareAvailabilityService } from "../services/software-availability";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import { constrainWorkflowResources } from "../workflow/resource-limits";
import { federationMaterialDigest } from "./assets";
import { federationExecutionSnapshot, loadFederationWorkflowBinding } from "./execution-binding";
import {
  checkFederationExecutionPolicy,
  checkFederationJobData,
  federationExecutionDenial,
} from "./execution-policy";
import { lockFederationTarget, resolveFederationTargets } from "./execution-targets";
import { checkFederationLicensedMaterials } from "./licensed-material-authorization";
import { checkFederationNetdriveJob } from "./netdrive-inputs";
import type { FederationPreparationService } from "./preparation";
import { checkFederationSandboxJob } from "./sandbox-authorization";
import { prepareFederationSoftware } from "./software-authorization";

export type FederationDeliveryTarget = {
  jobId: string;
  agentId: string;
} & ({ kind: "install"; spec: string } | { kind: "compute"; qos?: string; running?: boolean });

/** Reauthorize every delivery; the returned check holds local revocations through channel enqueue. */
export class FederationDispatchAuthorization {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
    private readonly queues?: Pick<
      QueueRegistryService,
      "inspectPreferredForSubmit" | "assertExecutionAccess"
    >,
    private readonly software?: Pick<
      SoftwareAvailabilityService,
      "resolve" | "assertExecutionAccess"
    >,
    private readonly sandboxPolicies?: Pick<SandboxPolicyService, "effectiveFor">,
  ) {}

  async authorizeWorkflow(runId: string, lease: LeasedWorkflowJournal): Promise<void> {
    if (lease.runId !== runId) throw new FederationError("OPERATION_CONFLICT");
    try {
      const authorize = await this.prepare(runId);
      await lease.transaction(authorize);
    } catch (cause) {
      if (cause instanceof WorkflowExecutionInterrupted || federationExecutionDenial(cause))
        throw cause;
      throw new WorkflowExecutionInterrupted("Federation workflow authorization is pending", {
        cause,
      });
    }
  }

  async checkActiveJobs(runId: string): Promise<void> {
    await checkFederationExecutionPolicy(
      this.db,
      runId,
      this.queues,
      this.software,
      this.sandboxPolicies,
    );
  }

  async prepare(
    runId: string,
    delivery?: FederationDeliveryTarget,
  ): Promise<(tx: PgTransaction) => Promise<number>> {
    const binding = await loadFederationWorkflowBinding(this.db, runId);
    if (!binding)
      throw new WorkflowExecutionInterrupted("Federation dispatch lacks its saved binding", {
        retryable: false,
      });
    const running = delivery?.kind === "compute" && delivery.running === true;
    // External software authorization happens outside the final delivery transaction.
    const current = await this.preparation.executionSnapshot(
      binding.reservationId,
      undefined,
      running,
    );
    if (federationMaterialDigest(federationExecutionSnapshot(current)) !== binding.snapshotDigest)
      throw new FederationError("OPERATION_CONFLICT");
    const targets = binding.snapshot.executionTargets ?? [];
    if (delivery && !this.queues)
      throw new WorkflowExecutionInterrupted("Federation queue authorization is unavailable", {
        retryable: false,
      });
    const eligible =
      delivery && this.queues && !running
        ? await resolveFederationTargets(this.db, this.queues, targets, {
            ...binding.snapshot.identity,
            role: "user",
          })
        : undefined;
    const [invocation] = delivery
      ? await this.db
          .select({ intent: workflowExecutionJobs.intent })
          .from(workflowExecutionJobs)
          .where(
            and(
              eq(workflowExecutionJobs.jobId, delivery.jobId),
              eq(workflowExecutionJobs.runId, runId),
            ),
          )
      : [];
    if (delivery && !invocation) throw new FederationError("OPERATION_CONFLICT");
    const [runtimeQueue] =
      running && delivery
        ? await this.db
            .select({ queue: schedulerQueues })
            .from(jobs)
            .innerJoin(schedulerQueues, eq(schedulerQueues.queueId, jobs.queueId))
            .where(eq(jobs.id, delivery.jobId))
        : [];
    if (running) {
      if (!runtimeQueue || !this.queues) throw new FederationError("OPERATION_CONFLICT");
      await this.queues.assertExecutionAccess(runtimeQueue.queue.queueId, {
        ...binding.snapshot.identity,
        role: "user",
      });
    }
    const softwareFence =
      delivery && invocation
        ? await prepareFederationSoftware(
            invocation.intent,
            binding.snapshot.identity,
            delivery,
            this.software,
            running,
          )
        : undefined;
    return async (tx) => {
      let expiresAtUnixMs = Number.POSITIVE_INFINITY;
      await tx
        .select({ id: federationWorkflowBindings.reservationId })
        .from(federationWorkflowBindings)
        .where(eq(federationWorkflowBindings.workflowRunId, runId))
        .for("share");
      const saved = await loadFederationWorkflowBinding(tx, runId);
      if (
        !saved ||
        saved.reservationId !== binding.reservationId ||
        saved.snapshotDigest !== binding.snapshotDigest
      )
        throw new FederationError("OPERATION_CONFLICT");
      await this.preparation.lockExecutionSnapshot(tx, current, running);
      if (delivery) {
        const [job] = await tx
          .select({ job: jobs, intent: workflowExecutionJobs.intent })
          .from(jobs)
          .innerJoin(workflowExecutionJobs, eq(workflowExecutionJobs.jobId, jobs.id))
          .where(and(eq(jobs.id, delivery.jobId), eq(workflowExecutionJobs.runId, runId)))
          .for(running ? "update" : "share", { of: [jobs, workflowExecutionJobs] });
        if (
          !job ||
          !invocation ||
          federationMaterialDigest(job.intent) !== federationMaterialDigest(invocation.intent) ||
          job.job.submittedBy !== binding.snapshot.identity.userId ||
          job.job.orgId !== binding.snapshot.identity.orgId ||
          (delivery.kind === "compute" &&
            (job.job.agentId !== delivery.agentId || !job.job.queueId))
        )
          throw new FederationError("OPERATION_CONFLICT");
        if (running && !["queued", "running"].includes(job.job.status))
          throw new FederationError("POLICY_DENIED");
        constrainWorkflowResources(
          {
            cpus: job.job.cpus,
            memoryMb: job.job.memoryMb,
            gpus: job.job.gpus ?? 0,
            wallTimeSec: job.job.wallTimeSec ?? 0,
          },
          binding.snapshot.request.resources,
        );
        const queue = runtimeQueue
          ? {
              queueId: runtimeQueue.queue.queueId,
              targetUpdatedAt: runtimeQueue.queue.updatedAt,
              targetMode: runtimeQueue.queue.targetMode,
              resolvedQueueName:
                runtimeQueue.queue.targetMode === "named"
                  ? runtimeQueue.queue.queueName
                  : undefined,
              queueName: runtimeQueue.queue.queueName,
            }
          : eligible?.selections.find(
              (selection) =>
                selection.agentId === delivery.agentId &&
                (delivery.kind === "install" || selection.queueId === job.job.queueId),
            );
        if (!queue) throw new FederationError("POLICY_DENIED");
        if (
          delivery.kind === "compute" &&
          ((queue.targetMode ?? "default") !== job.job.queueTargetMode ||
            ((!running || queue.targetMode === "named") &&
              (queue.resolvedQueueName ?? queue.queueName ?? null) !== job.job.schedulerQueueName))
        )
          throw new FederationError("OPERATION_CONFLICT");
        const target = await lockFederationTarget(tx, targets, {
          agentId: delivery.agentId,
          queueId: queue.queueId,
          updatedAt: queue.targetUpdatedAt,
          running,
          ...(delivery.kind === "compute"
            ? {
                targetMode: job.job.queueTargetMode,
                queueName: job.job.schedulerQueueName,
                qos: delivery.qos ?? "",
              }
            : {}),
        });
        expiresAtUnixMs = Math.min(
          expiresAtUnixMs,
          (await softwareFence?.(tx, target.providerOrgId)) ?? Number.POSITIVE_INFINITY,
        );
        if (delivery.kind === "compute")
          expiresAtUnixMs = Math.min(
            expiresAtUnixMs,
            await checkFederationLicensedMaterials(
              tx,
              delivery.jobId,
              job.intent,
              binding.snapshot.identity,
              target,
              true,
            ),
          );
        if (delivery.kind === "compute")
          expiresAtUnixMs = Math.min(
            expiresAtUnixMs,
            await checkFederationSandboxJob(
              this.db,
              delivery.jobId,
              job.intent,
              binding.snapshot.identity,
              this.sandboxPolicies,
              tx,
              binding.snapshot.environment.sandboxRuntime,
            ),
          );
        if (delivery.kind === "compute")
          await checkFederationNetdriveJob(
            tx,
            delivery.jobId,
            job.intent,
            binding.snapshot.identity,
            true,
          );
        if (delivery.kind === "compute")
          expiresAtUnixMs = Math.min(
            expiresAtUnixMs,
            await checkFederationJobData(tx, delivery.jobId, binding.snapshot.identity, true),
          );
      }
      return expiresAtUnixMs;
    };
  }
}
