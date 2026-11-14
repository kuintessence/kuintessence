import { auditLog, jobs, type PgDb, workflowRuns } from "@kuintessence/db";
import {
  AppError,
  createLogger,
  ErrorCode,
  JobStatus,
  type JobSubmit,
  JobUsecaseFileValueSchema,
  type RoleName,
  type workflowDsl,
} from "@kuintessence/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { stringify } from "yaml";
import type { AuthzService } from "../authz/service";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { JobService } from "../services/job-service";
import { registerWorkflowAuthorization } from "../services/workflow-authorization";
import type { WorkflowAsyncRunner } from "../workflow/async-runner";
import type { FederationClusterQueueService } from "./cluster-queues";

const logger = createLogger("federation-jobs");
type Job = typeof jobs.$inferSelect;
type RemoteNode = Extract<workflowDsl.WorkflowNode, { type: "Federation" }>;

/** Local jobs are durable handles for the existing remote workflow execution and cancellation. */
export class FederationJobService {
  private timer?: ReturnType<typeof setInterval>;
  private reconciling?: Promise<void>;
  constructor(
    private readonly db: PgDb,
    private readonly jobService: JobService,
    private readonly runner: WorkflowAsyncRunner,
    private readonly clusters: FederationClusterQueueService,
    private readonly authz?: AuthzService,
  ) {}

  async submit(
    data: JobSubmit,
    principal: BoundPrincipal & { role: RoleName },
    node: RemoteNode,
    authorize: (jobId: string) => Promise<void>,
  ): Promise<Job> {
    if (!principal.userId || !principal.orgId)
      throw new AppError(ErrorCode.FORBIDDEN, "An active organization is required", 403);
    const userId = principal.userId;
    const orgId = principal.orgId;
    const parameters: workflowDsl.Parameter[] =
      node.inputSlots
        ?.filter((slot) => slot.type === "Text")
        .map((slot) => ({
          name: slot.from && "param" in slot.from ? slot.from.param : slot.descriptor,
          type: "string",
          required: true,
          default: data.usecasePackageId ? data.usecaseInputs?.[slot.descriptor] : data.command,
        })) ?? [];
    let submitted: Job | undefined;
    await this.runner.submit({
      executionModel: "durable-v2",
      submittedBy: userId,
      role: principal.role,
      principal,
      yaml: stringify({
        name: data.name,
        parameters,
        spec: { nodeDrafts: [node], nodeRelations: [] },
      }),
      authorizeRun: async (runId) => {
        // Validate again after the run exists, before giving it authority to queue.
        await this.clusters.prepareJob({ userId, orgId }, data);
        const job = await this.db.transaction(async (tx) => {
          const created = await this.jobService.submitInTransaction(
            tx,
            { ...data, schedulingStrategy: undefined },
            userId,
            { orgId },
          );
          const [linked] = await tx
            .update(jobs)
            .set({ federationRunId: runId, federationQueueId: node.managedPlacement?.queueId })
            .where(eq(jobs.id, created.id))
            .returning();
          if (!linked) throw new Error("Remote job link was not saved");
          await tx.insert(auditLog).values({
            actor: userId,
            orgId,
            action: "federation.job.submit",
            target: created.id,
            diff: {
              after: {
                workflowRunId: runId,
                queueId: node.managedPlacement?.queueId,
                executionTarget: node.executionTarget,
              },
            },
          });
          return linked;
        });
        submitted = job;
        await authorize(job.id);
        await registerWorkflowAuthorization(this.authz, runId, userId, orgId);
      },
    });
    if (!submitted) throw new Error("Remote job was not saved");
    return submitted;
  }

  async cancel(job: Job): Promise<Job> {
    if (!job.federationRunId) throw new Error("Job is not a federation job");
    await this.runner.cancel(job.federationRunId);
    await this.reconcile(job.id);
    return (await this.jobService.getById(job.id)) ?? job;
  }

  async reconcile(jobId?: string): Promise<void> {
    const rows = await this.db
      .select({ job: jobs, run: workflowRuns })
      .from(jobs)
      .innerJoin(workflowRuns, eq(workflowRuns.id, jobs.federationRunId))
      .where(
        and(
          isNotNull(jobs.federationRunId),
          inArray(jobs.status, ["pending", "queued", "running"]),
          jobId ? eq(jobs.id, jobId) : undefined,
        ),
      );
    for (const { job, run } of rows) {
      const status =
        run.status === "completed"
          ? JobStatus.COMPLETED
          : run.status === "failed"
            ? JobStatus.FAILED
            : run.status === "cancelled"
              ? JobStatus.CANCELLED
              : run.status === "running" || run.status === "cancelling"
                ? JobStatus.RUNNING
                : JobStatus.QUEUED;
      if (job.status === status) continue;
      const outputs: Record<
        string,
        Array<{ fileMetadataId: string; fileMetadataName: string }>
      > = {};
      if (status === JobStatus.COMPLETED) {
        for (const [descriptor, value] of Object.entries(
          run.result?.values.compute?.values ?? {},
        )) {
          const files = Array.isArray(value) ? value : [value];
          outputs[descriptor] = files.map((file) => JobUsecaseFileValueSchema.parse(file));
        }
      }
      if (status === JobStatus.COMPLETED)
        await this.db
          .update(jobs)
          .set({ federationOutputs: outputs })
          .where(
            and(
              eq(jobs.id, job.id),
              eq(jobs.federationRunId, run.id),
              inArray(jobs.status, ["pending", "queued", "running"]),
            ),
          );
      await this.jobService.updateStatus(
        job.id,
        status,
        undefined,
        undefined,
        run.errorMessage ?? undefined,
        status === JobStatus.COMPLETED ? 0 : undefined,
        undefined,
      );
    }
  }

  start() {
    if (this.timer) return;
    const tick = () => {
      if (this.reconciling) return;
      this.reconciling = this.reconcile()
        .catch((error: unknown) => logger.error({ error }, "Remote job projection failed"))
        .finally(() => {
          this.reconciling = undefined;
        });
    };
    this.timer = setInterval(tick, 3000);
    this.timer.unref();
    tick();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.reconciling;
  }
}
