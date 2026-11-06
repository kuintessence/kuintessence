import {
  createLogger,
  extractRunGraph,
  Role,
  type RoleName,
  type RunResult,
  type Workflow,
  WorkflowExecutionInterrupted,
  type WorkflowPlacementConfig,
  WorkflowPlacementConfigSchema,
} from "@kuintessence/shared";
import { stringify } from "yaml";
import type { BoundPrincipal } from "../middleware/principal-binder";
import type { LeasedWorkflowJournal, WorkflowExecutionJournalStore } from "./execution-journal";
import { parseWorkflowYaml } from "./parser";
import type { WorkflowRunRegistry, WorkflowRunStatus } from "./run-registry";

export interface WorkflowAsyncRunnerDeps {
  registry: WorkflowRunRegistry;
  journal?: WorkflowExecutionJournalStore;
  makeRunner: (
    submittedBy: string,
    role: RoleName,
    runId?: string,
    placementConfig?: WorkflowPlacementConfig,
    orgId?: string | null,
    executionLease?: LeasedWorkflowJournal,
  ) => (yaml: string) => Promise<RunResult>;
  authorizeFederationExecution?: (runId: string, lease: LeasedWorkflowJournal) => Promise<void>;
  cancelSubmittedJobs?: (runId: string) => Promise<void>;
  preparePlacement?: (
    runId: string,
    workflow: Workflow,
    config: WorkflowPlacementConfig,
  ) => Promise<"within-cap" | "awaiting-approval">;
  awaitCheckpointPersistence?: (runId: string) => Promise<void>;
  markArtifactsTerminal?: (runId: string) => Promise<void>;
  schedule?: (task: () => Promise<void>) => void;
  resolveNamedReferences?: (workflow: Workflow, principal?: BoundPrincipal) => Promise<Workflow>;
  validateWorkflow?: (
    workflow: Workflow,
    principal?: { userId: string | null; orgId: string | null; sub?: string },
    runId?: string,
  ) => Promise<void>;
  assertExecutionPrincipal?: (input: { userId: string; orgId: string | null }) => Promise<void>;
}

export interface WorkflowAsyncSubmit {
  executionModel?: "durable-v2";
  yaml: string;
  submittedBy: string;
  role: RoleName;
  principal?: BoundPrincipal;
  placementConfig?: WorkflowPlacementConfig;
  authorizeRun: (runId: string) => Promise<void>;
}

type WorkflowExecutionInput = Omit<WorkflowAsyncSubmit, "authorizeRun"> & {
  orgId?: string | null;
};

export interface WorkflowAsyncSubmitResult {
  runId: string;
  name: string;
  status: "submitted" | "awaiting_approval";
}

export interface WorkflowRecoveryReport {
  resumed: number;
  failedInterrupted: number;
}

export class WorkflowAsyncRunner {
  private readonly logger = createLogger("workflow-async-runner");
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private recovering?: Promise<WorkflowRecoveryReport>;
  private stopping = false;
  private readonly activeLeases = new Set<{
    lease: LeasedWorkflowJournal;
    stopHeartbeat: () => Promise<void>;
  }>();

  private readonly schedule: (task: () => Promise<void>) => void;

  constructor(private readonly deps: WorkflowAsyncRunnerDeps) {
    this.schedule =
      deps.schedule ??
      ((task) => {
        queueMicrotask(() => {
          task().catch((err) => this.logger.error({ err }, "workflow async task crashed"));
        });
      });
  }

  async submit(input: WorkflowAsyncSubmit): Promise<WorkflowAsyncSubmitResult> {
    if (input.executionModel && (input.executionModel !== "durable-v2" || !this.deps.journal))
      throw new Error("Requested durable workflow execution is unavailable");
    const parsedWorkflow = parseWorkflowYaml(input.yaml);
    await this.deps.assertExecutionPrincipal?.({
      userId: input.submittedBy,
      orgId: input.principal?.orgId ?? null,
    });
    const wf = this.deps.resolveNamedReferences
      ? await this.deps.resolveNamedReferences(parsedWorkflow, input.principal)
      : parsedWorkflow;
    await this.deps.validateWorkflow?.(wf, input.principal);
    const resolvedYaml = this.deps.resolveNamedReferences ? stringify(wf) : input.yaml;
    const placementConfig = WorkflowPlacementConfigSchema.parse(input.placementConfig ?? {});
    const runId = await this.deps.registry.createRun(
      wf.name,
      input.submittedBy,
      extractRunGraph(wf),
      {
        ...(input.executionModel ? { executionModel: input.executionModel } : {}),
        yaml: resolvedYaml,
        role: input.role,
        placementConfig,
        ...(input.principal || input.executionModel
          ? { orgId: input.principal?.orgId ?? null }
          : {}),
      },
    );

    try {
      await input.authorizeRun(runId);
    } catch (error) {
      await this.deps.registry.failRun(runId, error, "WORKFLOW_AUTHORIZATION_FAILED");
      throw error;
    }

    let budgetStatus: "within-cap" | "awaiting-approval" | undefined;
    try {
      budgetStatus = await this.deps.preparePlacement?.(runId, wf, placementConfig);
    } catch (error) {
      await this.deps.registry.failRun(runId, error, "WORKFLOW_PLACEMENT_FAILED");
      throw error;
    }
    if (budgetStatus === "awaiting-approval") {
      return { runId, name: wf.name, status: "awaiting_approval" };
    }

    if (!(await this.deps.registry.queueAuthorizedRun(runId))) {
      throw new Error("Workflow run left submitted state before it could be queued");
    }
    const { authorizeRun: _authorizeRun, ...executionInput } = input;
    this.schedule(() =>
      this.execute(runId, {
        ...executionInput,
        yaml: resolvedYaml,
        placementConfig,
        ...(input.principal || input.executionModel
          ? { orgId: input.principal?.orgId ?? null }
          : {}),
      }),
    );
    return { runId, name: wf.name, status: "submitted" };
  }

  async resumeAfterApproval(runId: string): Promise<WorkflowRunStatus | null> {
    const run = await this.deps.registry.getById(runId);
    if (!run) return null;
    if (run.status !== "queued") {
      return run.status as WorkflowRunStatus;
    }
    const input = run.input;
    if (!run.submittedBy || !input?.yaml || !input.role) {
      await this.deps.registry.failRun(runId, new Error("workflow input cannot be recovered"));
      return "failed";
    }
    this.schedule(() =>
      this.execute(runId, {
        ...(input.executionModel ? { executionModel: input.executionModel } : {}),
        yaml: input.yaml,
        submittedBy: run.submittedBy ?? "",
        role: parseStoredRole(input.role),
        placementConfig: WorkflowPlacementConfigSchema.parse(input.placementConfig ?? {}),
        ...(Object.hasOwn(input, "orgId") ? { orgId: input.orgId } : {}),
      }),
    );
    return "queued";
  }

  async cancel(
    runId: string,
    reason?: { code: string; message: string },
  ): Promise<WorkflowRunStatus | null> {
    const status = await this.deps.registry.requestCancel(runId, reason);
    if (status !== "cancelling") return status;
    const run = await this.deps.registry.getById(runId);
    if (
      run?.status === "cancelling" &&
      run.startedAt == null &&
      Object.keys(run.stepJobs ?? {}).length === 0 &&
      (run.input?.executionModel !== "durable-v2" ||
        (await this.deps.registry.listJobIds(runId)).length === 0)
    ) {
      if (await this.deps.registry.cancelRun(runId)) {
        await this.markArtifactsTerminal(runId);
        return "cancelled";
      }
    }
    if (run?.status === "cancelling") {
      this.schedule(() => this.finishCancellation(runId));
    }
    return status;
  }

  async recoverInterruptedRuns(durableOnly = false): Promise<WorkflowRecoveryReport> {
    const runs = durableOnly
      ? await this.deps.registry.listRunnableDurableRuns()
      : await this.deps.registry.listRecoverableRuns();
    let resumed = 0;
    let failedInterrupted = 0;
    for (const run of runs) {
      if (this.stopping) break;
      const durable = run.input?.executionModel === "durable-v2";
      if (
        durable &&
        run.status !== "cancelling" &&
        (run.errorCode === "WORKFLOW_RECONCILING" ||
          run.status === "submitted" ||
          run.status === "awaiting_approval")
      )
        continue;
      if (run.status === "queued" || (durable && run.status === "running")) {
        const input = run.input;
        if (run.submittedBy && input?.yaml && input.role) {
          resumed += 1;
          this.schedule(() =>
            this.execute(run.id, {
              ...(input.executionModel ? { executionModel: input.executionModel } : {}),
              yaml: input.yaml,
              submittedBy: run.submittedBy ?? "",
              role: parseStoredRole(input.role),
              placementConfig: WorkflowPlacementConfigSchema.parse(input.placementConfig ?? {}),
              ...(Object.hasOwn(input, "orgId") ? { orgId: input.orgId } : {}),
            }),
          );
          continue;
        }
      }
      if (run.status === "cancelling") {
        resumed += 1;
        this.schedule(() => this.finishCancellation(run.id));
        continue;
      }
      if (run.status === "running") {
        const message =
          "workflow was running when Server recovered; remote jobs are being cancelled";
        if (await this.deps.registry.requestInterrupt(run.id, message)) {
          resumed += 1;
          failedInterrupted += 1;
          this.schedule(() => this.finishCancellation(run.id));
        }
        continue;
      }
      if (
        await this.deps.registry.failRun(
          run.id,
          new Error(`workflow ${run.status} when Server recovered; manual review required`),
          "WORKFLOW_INTERRUPTED",
        )
      ) {
        failedInterrupted += 1;
        await this.markArtifactsTerminal(run.id);
      }
    }
    return { resumed, failedInterrupted };
  }

  startRecovery(): void {
    if (this.recoveryTimer || this.stopping) return;
    this.recoveryTimer = setInterval(() => {
      if (this.recovering) return;
      this.recovering = this.recoverInterruptedRuns(true)
        .catch((err) => {
          this.logger.error({ err }, "Durable workflow recovery will retry");
          return { resumed: 0, failedInterrupted: 0 };
        })
        .finally(() => {
          this.recovering = undefined;
        });
    }, 5000);
    this.recoveryTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    await this.recovering;
    await Promise.all(
      [...this.activeLeases].map(async ({ lease, stopHeartbeat }) => {
        await stopHeartbeat();
        await lease.release();
      }),
    );
  }

  private async execute(runId: string, input: WorkflowExecutionInput): Promise<void> {
    if (this.stopping) return;
    let active: { lease: LeasedWorkflowJournal; stopHeartbeat: () => Promise<void> } | undefined;
    const durable = input.executionModel === "durable-v2";
    try {
      if (input.executionModel !== undefined && !durable)
        throw new Error("Unsupported workflow execution model");
      if (!(await this.deps.registry.claimForExecution(runId)) && !durable) return;
      if (durable) {
        if (!this.deps.journal)
          throw new WorkflowExecutionInterrupted("Durable workflow journal is unavailable");
        const lease = await this.deps.journal.acquire(runId);
        if (!lease) return;
        active = { lease, stopHeartbeat: lease.startHeartbeat() };
        this.activeLeases.add(active);
        if (input.orgId === undefined)
          throw new WorkflowExecutionInterrupted("Durable workflow lacks its organization scope", {
            retryable: false,
          });
      }
      const savedRun = await this.deps.registry.getById(runId);
      if (savedRun?.input?.federationReservationId) {
        if (!active || !this.deps.authorizeFederationExecution)
          throw new WorkflowExecutionInterrupted(
            "Federation execution requires its local dispatch authorization",
            { retryable: false },
          );
        await this.deps.authorizeFederationExecution(runId, active.lease);
      }
      await this.deps.assertExecutionPrincipal?.({
        userId: input.submittedBy,
        orgId: input.orgId ?? null,
      });
      const workflow = parseWorkflowYaml(input.yaml);
      await this.deps.validateWorkflow?.(
        workflow,
        {
          userId: input.submittedBy,
          orgId: input.orgId ?? null,
          ...(input.principal?.sub ? { sub: input.principal.sub } : {}),
        },
        runId,
      );
      await this.deps.assertExecutionPrincipal?.({
        userId: input.submittedBy,
        orgId: input.orgId ?? null,
      });
      const result = await this.deps.makeRunner(
        input.submittedBy,
        input.role,
        runId,
        input.placementConfig,
        input.orgId,
        active?.lease,
      )(input.yaml);
      try {
        await this.deps.awaitCheckpointPersistence?.(runId);
      } catch (cause) {
        if (durable && !(cause instanceof WorkflowExecutionInterrupted))
          throw new WorkflowExecutionInterrupted("Workflow checkpoint publication is pending", {
            cause,
          });
        throw cause;
      }
      const afterRun = await this.deps.registry.getById(runId);
      if (afterRun?.status === "cancelling" || afterRun?.status === "cancelled") {
        await this.finishCancellation(runId);
        return;
      }
      if (await this.deps.registry.completeRun(runId, result, active?.lease)) {
        await this.markArtifactsTerminal(runId);
      } else {
        await this.finishCancellation(runId);
      }
    } catch (err) {
      if (durable) {
        if (active) {
          try {
            if (err instanceof WorkflowExecutionInterrupted)
              await this.deps.registry.recordInterruption(runId, err, active.lease);
            else
              await this.deps.registry.requestInterrupt(
                runId,
                err instanceof Error ? err.message : String(err),
                active.lease,
              );
          } catch (fenceError) {
            this.logger.warn(
              { runId, err: fenceError },
              "Durable run left for its current or next lease owner",
            );
          }
        } else {
          this.logger.error(
            { runId, err },
            "Durable workflow could not acquire an execution lease",
          );
        }
      } else if (await this.deps.registry.failRun(runId, err)) {
        await this.markArtifactsTerminal(runId);
        return;
      }
      const run = await this.deps.registry.getById(runId);
      if (run?.status === "cancelling") await this.finishCancellation(runId);
    } finally {
      if (active) {
        await active.stopHeartbeat();
        this.activeLeases.delete(active);
        await active.lease.release();
      }
    }
  }

  private async finishCancellation(runId: string): Promise<void> {
    try {
      const run = await this.deps.registry.getById(runId);
      if (run?.status !== "cancelling") return;
      const stepJobCount =
        run.input?.executionModel === "durable-v2"
          ? (await this.deps.registry.listJobIds(runId)).length
          : Object.keys(run.stepJobs ?? {}).length;
      if (stepJobCount > 0 && !this.deps.cancelSubmittedJobs) {
        throw new Error("workflow job cancellation is not configured");
      }
      await this.deps.cancelSubmittedJobs?.(runId);
      const latest = await this.deps.registry.getById(runId);
      const finalized =
        latest?.errorCode === "WORKFLOW_INTERRUPTED"
          ? await this.deps.registry.failInterruptedRun(runId)
          : await this.deps.registry.cancelRun(runId);
      if (finalized) await this.markArtifactsTerminal(runId);
    } catch (err) {
      this.logger.error({ err, runId }, "Workflow cancellation remains pending for recovery");
    }
  }

  private async markArtifactsTerminal(runId: string): Promise<void> {
    try {
      await this.deps.markArtifactsTerminal?.(runId);
    } catch (err) {
      this.logger.warn({ err, runId }, "Failed to schedule ephemeral artifact expiry");
    }
  }
}

function parseStoredRole(role: string): RoleName {
  const roles = Object.values(Role) as RoleName[];
  return roles.includes(role as RoleName) ? (role as RoleName) : Role.GUEST;
}
