import {
  createLogger,
  extractRunGraph,
  Role,
  type RoleName,
  type RunResult,
  type Workflow,
  type WorkflowPlacementConfig,
  WorkflowPlacementConfigSchema,
} from "@kuintessence/shared";
import { stringify } from "yaml";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { parseWorkflowYaml } from "./parser";
import type { WorkflowRunRegistry, WorkflowRunStatus } from "./run-registry";

export interface WorkflowAsyncRunnerDeps {
  registry: WorkflowRunRegistry;
  makeRunner: (
    submittedBy: string,
    role: RoleName,
    runId?: string,
    placementConfig?: WorkflowPlacementConfig,
    orgId?: string | null,
  ) => (yaml: string) => Promise<RunResult>;
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
  ) => Promise<void>;
  assertExecutionPrincipal?: (input: { userId: string; orgId: string | null }) => Promise<void>;
}

export interface WorkflowAsyncSubmit {
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
        yaml: resolvedYaml,
        role: input.role,
        placementConfig,
        ...(input.principal ? { orgId: input.principal.orgId } : {}),
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
        ...(input.principal ? { orgId: input.principal.orgId } : {}),
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
        yaml: input.yaml,
        submittedBy: run.submittedBy ?? "",
        role: parseStoredRole(input.role),
        placementConfig: WorkflowPlacementConfigSchema.parse(input.placementConfig ?? {}),
        ...(Object.hasOwn(input, "orgId") ? { orgId: input.orgId } : {}),
      }),
    );
    return "queued";
  }

  async cancel(runId: string): Promise<WorkflowRunStatus | null> {
    const status = await this.deps.registry.requestCancel(runId);
    if (status !== "cancelling") return status;
    const run = await this.deps.registry.getById(runId);
    if (
      run?.status === "cancelling" &&
      run.startedAt == null &&
      Object.keys(run.stepJobs ?? {}).length === 0
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

  async recoverInterruptedRuns(): Promise<WorkflowRecoveryReport> {
    const runs = await this.deps.registry.listRecoverableRuns();
    let resumed = 0;
    let failedInterrupted = 0;
    for (const run of runs) {
      if (run.status === "queued") {
        const input = run.input;
        if (run.submittedBy && input?.yaml && input.role) {
          resumed += 1;
          this.schedule(() =>
            this.execute(run.id, {
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

  private async execute(runId: string, input: WorkflowExecutionInput): Promise<void> {
    try {
      if (!(await this.deps.registry.claimForExecution(runId))) return;
      await this.deps.assertExecutionPrincipal?.({
        userId: input.submittedBy,
        orgId: input.orgId ?? null,
      });
      const workflow = parseWorkflowYaml(input.yaml);
      await this.deps.validateWorkflow?.(workflow, {
        userId: input.submittedBy,
        orgId: input.orgId ?? null,
        ...(input.principal?.sub ? { sub: input.principal.sub } : {}),
      });
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
      )(input.yaml);
      await this.deps.awaitCheckpointPersistence?.(runId);
      const afterRun = await this.deps.registry.getById(runId);
      if (afterRun?.status === "cancelling" || afterRun?.status === "cancelled") {
        await this.finishCancellation(runId);
        return;
      }
      if (await this.deps.registry.completeRun(runId, result)) {
        await this.markArtifactsTerminal(runId);
      }
    } catch (err) {
      if (await this.deps.registry.failRun(runId, err)) {
        await this.markArtifactsTerminal(runId);
        return;
      }
      const run = await this.deps.registry.getById(runId);
      if (run?.status === "cancelling") await this.finishCancellation(runId);
    }
  }

  private async finishCancellation(runId: string): Promise<void> {
    try {
      const run = await this.deps.registry.getById(runId);
      if (run?.status !== "cancelling") return;
      const stepJobCount = Object.keys(run.stepJobs ?? {}).length;
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
