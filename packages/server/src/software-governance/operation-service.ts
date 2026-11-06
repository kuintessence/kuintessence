import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  agents,
  auditLog,
  federationAgreements,
  federationReservations,
  federationWorkflowBindings,
  jobs,
  type PgDb,
  type PgTransaction,
  softwareOperations,
  softwarePolicies,
  softwarePolicyOverlays,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationExecutionDecision,
  type FederationExecutionRequest,
  type FederationExecutionResponse,
  FederationExecutionResponseSchema,
  SoftwareOperationAction as ProtoSoftwareOperationAction,
  SoftwareOperationRequestSchema,
  type SoftwareOperationResult,
  SoftwareOperationStatus,
} from "@kuintessence/proto";
import {
  AppError,
  decideSpackPolicy,
  ErrorCode,
  type SpackExecutionPin,
  SpackExecutionPinSchema,
  type SpackPolicy,
  WorkflowExecutionInterrupted,
} from "@kuintessence/shared";
import {
  federationCanonicalJson,
  federationExecutionDeadline,
} from "@kuintessence/shared/federation";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { AuthorizationUnavailableError } from "../authz/service";
import type { FederationDeliveryTarget } from "../federation/dispatch-authorization";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { CpScope } from "../middleware/cp-rbac";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import type { InstalledRegistry } from "./installed-registry";
import type { SpackInstallPreparation, SpackInstallTicket } from "./spack-material-delivery";

export type SoftwareOperationAction = "install" | "uninstall" | "load" | "import_preinstalled";
export type SoftwareOperationStatusValue =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "rejected";

export interface SoftwareOperationView {
  id: string;
  agentId: string;
  requestedBy: string | null;
  action: SoftwareOperationAction;
  spec: string;
  status: SoftwareOperationStatusValue;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export class SoftwareOperationService {
  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: AgentDispatcher,
    private readonly installedRegistry: InstalledRegistry,
    private readonly prepareSpackInstall?: (
      input: SpackInstallPreparation,
    ) => Promise<SpackInstallTicket>,
    private readonly authorizeJobInstall?: (input: {
      agentId: string;
      requestedBy: string;
      providerOrgId: string | null;
    }) => Promise<void>,
    private readonly prepareFederationDispatch?: (
      runId: string,
      target: FederationDeliveryTarget,
    ) => Promise<(tx: PgTransaction) => Promise<void>>,
  ) {}

  async closeInterruptedOperation(input: {
    scope: CpScope;
    operationId: string;
    expectedUpdatedAt: string;
    workersStopped: true;
    reason: string;
    actor: string;
  }): Promise<SoftwareOperationView> {
    if (!input.scope.isPlatformWide) {
      throw new AppError(ErrorCode.FORBIDDEN, "Platform administrator required", 403);
    }
    if (input.workersStopped !== true || !input.reason.trim() || input.reason.length > 500) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Worker shutdown confirmation and reason required",
        400,
      );
    }
    return this.db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(softwareOperations)
        .where(eq(softwareOperations.id, input.operationId))
        .for("update")
        .limit(1);
      if (!operation) throw new AppError(ErrorCode.NOT_FOUND, "Software operation not found", 404);
      if (
        !["queued", "running"].includes(operation.status) ||
        operation.updatedAt.getTime() !== Date.parse(input.expectedUpdatedAt)
      ) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Operation changed or already finished",
          409,
        );
      }
      const [agent] = await tx
        .select()
        .from(agents)
        .where(eq(agents.agentId, operation.agentId))
        .limit(1);
      if (!agent || agent.status !== "offline" || this.dispatcher.isOnline(operation.agentId)) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Stop the Agent and all workers before maintenance",
          409,
        );
      }
      const now = new Date();
      const error =
        "SPACK_MANUALLY_INTERRUPTED: closed after operator-confirmed worker shutdown; installation outcome unknown";
      const [updated] = await tx
        .update(softwareOperations)
        .set({
          status: "failed",
          error,
          exitCode: null,
          finishedAt: now,
          updatedAt: now,
        })
        .where(eq(softwareOperations.id, operation.id))
        .returning();
      if (!updated) throw new Error("Software operation disappeared during maintenance");
      await tx.insert(auditLog).values({
        actor: input.actor,
        action: "software.operation.close-interrupted",
        target: operation.id,
        diff: {
          before: { status: operation.status, updatedAt: operation.updatedAt.toISOString() },
          after: {
            status: "failed",
            error,
            agentId: operation.agentId,
            reason: input.reason.trim(),
            workersStopped: true,
          },
        },
      });
      return rowToView(updated);
    });
  }

  async requestOperation(input: {
    scope: CpScope;
    agentId: string;
    action: SoftwareOperationAction;
    spec: string;
    requestedBy: string;
    idempotencyKey?: string;
    idempotencyItemIndex?: number;
    idempotencyItemCount?: number;
    agentScopeVerified?: boolean;
  }): Promise<SoftwareOperationView> {
    const spec = normalizeSoftwareOperationSpec(input.spec);
    const action = normalizeSoftwareOperationAction(input.action);
    const idempotency = normalizeSoftwareOperationIdempotency(input);
    if (input.agentScopeVerified) {
      await this.assertAgentExists(input.agentId);
    } else {
      await this.assertAgentInScope(input.scope, input.agentId);
    }
    const [created] = await this.db
      .insert(softwareOperations)
      .values({
        agentId: input.agentId,
        requestedBy: input.requestedBy,
        ...idempotency,
        action,
        spec,
      })
      .onConflictDoNothing({
        target: [
          softwareOperations.requestedBy,
          softwareOperations.idempotencyKey,
          softwareOperations.idempotencyItemIndex,
        ],
      })
      .returning();
    if (!created && idempotency.idempotencyKey) {
      const [existing] = await this.db
        .select()
        .from(softwareOperations)
        .where(
          and(
            eq(softwareOperations.requestedBy, input.requestedBy),
            eq(softwareOperations.idempotencyKey, idempotency.idempotencyKey),
            eq(softwareOperations.idempotencyItemIndex, idempotency.idempotencyItemIndex ?? 0),
          ),
        )
        .limit(1);
      if (!existing) {
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          "Software operation idempotency lookup failed",
          500,
        );
      }
      assertIdempotentOperationMatches(existing, {
        agentId: input.agentId,
        action,
        spec,
        itemCount: idempotency.idempotencyItemCount ?? 1,
      });
      return rowToView(existing);
    }
    if (!created) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Software operation insert failed", 500);
    }
    return this.dispatchOperation(created);
  }

  private async dispatchOperation(
    created: typeof softwareOperations.$inferSelect,
    expectedPin?: SpackExecutionPin,
  ): Promise<SoftwareOperationView> {
    if (created.federationJobId)
      throw new WorkflowExecutionInterrupted(
        "Federation installation requires its workflow authority",
        { retryable: false },
      );
    const input = created;
    const spec = created.spec;
    const action = normalizeSoftwareOperationAction(created.action);
    if (!input.requestedBy) throw new Error("Software operation has no requester");
    const requestedBy = input.requestedBy;
    let policyRejection: string | null;
    try {
      policyRejection = await this.policyRejection(input.agentId, action, spec);
    } catch (err) {
      const [updated] = await this.db
        .update(softwareOperations)
        .set({
          status: "failed",
          error: softwareOperationFailureMessage("software policy precheck failed", err),
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(softwareOperations.id, created.id))
        .returning();
      if (updated) {
        return rowToView(updated);
      }
      throw err;
    }
    if (policyRejection) {
      const [updated] = await this.db
        .update(softwareOperations)
        .set({
          status: "rejected",
          error: policyRejection,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(softwareOperations.id, created.id))
        .returning();
      return rowToView(updated ?? created);
    }
    let materialTicket: SpackInstallTicket | undefined;
    if (action === "install" && this.prepareSpackInstall) {
      try {
        materialTicket = await this.prepareSpackInstall({
          operationId: created.id,
          agentId: input.agentId,
          requestedBy,
          spec,
          ...(expectedPin ? { expectedPin } : {}),
        });
        if (
          expectedPin &&
          (!materialTicket.spackMaterialTicket ||
            materialTicket.spackManifestDigest !== expectedPin.manifestDigest)
        )
          throw new Error("Prepared installation differs from the required material release");
      } catch (error) {
        const [updated] = await this.db
          .update(softwareOperations)
          .set({
            status: "rejected",
            error:
              error instanceof AppError
                ? error.message
                : "Spack material preparation failed; no install was dispatched",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(softwareOperations.id, created.id))
          .returning();
        return rowToView(updated ?? created);
      }
    }
    const dispatch = pushSoftwareOperationSafely(this.dispatcher, input.agentId, {
      operationId: created.id,
      action: actionToProto(action),
      spec,
      requestedBy,
      ...materialTicket,
    });
    if (dispatch.pushed) {
      return rowToView(created);
    }
    const [updated] = await this.db
      .update(softwareOperations)
      .set({
        status: "failed",
        error: dispatch.error ?? "agent is offline",
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(softwareOperations.id, created.id))
      .returning();
    return rowToView(updated ?? created);
  }

  /** Caller must pass the governed availability check for this exact agent/spec first. */
  async requestInstallForJob(input: {
    jobId: string;
    agentId: string;
    spec: string;
    requestedBy: string;
    executionLease?: LeasedWorkflowJournal;
    expectedPin?: SpackExecutionPin;
  }): Promise<SoftwareOperationView> {
    if (input.expectedPin)
      input = { ...input, expectedPin: SpackExecutionPinSchema.parse(input.expectedPin) };
    if (input.expectedPin && !this.prepareSpackInstall)
      throw new WorkflowExecutionInterrupted("Pinned installation requires managed materials", {
        retryable: false,
      });
    const workflow = await installationWorkflowScope(this.db, input.jobId);
    const reservationId = workflow?.reservationId ?? workflow?.boundReservationId;
    const federationJobId = reservationId ? input.jobId : null;
    if (
      reservationId &&
      (!this.prepareFederationDispatch ||
        !input.executionLease ||
        input.executionLease.runId !== workflow?.runId)
    )
      throw new WorkflowExecutionInterrupted(
        "Federation installation authorization is unavailable",
        {
          retryable: false,
        },
      );
    const federationFence =
      reservationId && workflow
        ? await this.prepareFederationDispatch?.(workflow.runId, {
            kind: "install",
            spec: input.spec,
            jobId: input.jobId,
            agentId: input.agentId,
          })
        : undefined;
    const authorizeWorkflow = async (tx: PgTransaction) => {
      const current = await installationWorkflowScope(tx, input.jobId);
      if (
        current?.runId !== workflow?.runId ||
        current?.reservationId !== workflow?.reservationId ||
        current?.boundReservationId !== workflow?.boundReservationId
      )
        throw new WorkflowExecutionInterrupted("Installation workflow binding changed", {
          retryable: false,
        });
      if (reservationId) {
        if (
          !input.expectedPin ||
          !current?.intent.spackExecution?.pin ||
          normalizeSoftwareOperationSpec(current.intent.spackExecution.spec) !== input.spec ||
          federationCanonicalJson(current.intent.spackExecution.pin) !==
            federationCanonicalJson(input.expectedPin)
        )
          throw new WorkflowExecutionInterrupted(
            "Federation installation requires its saved software pin",
            {
              retryable: false,
            },
          );
        await federationFence?.(tx);
      }
    };
    if (input.executionLease) {
      if (!this.dispatcher.isOnline(input.agentId))
        throw new WorkflowExecutionInterrupted("Original installation Agent is offline");
      if (!this.dispatcher.supportsSoftwareOperationReplay(input.agentId))
        throw new WorkflowExecutionInterrupted(
          "Durable installation requires software_operation_replay_v1",
          { retryable: false },
        );
    }
    if (!this.authorizeJobInstall) throw new Error("Workflow install authorization is unavailable");
    const agent = await this.assertAgentExists(input.agentId);
    await this.authorizeJobInstall({
      agentId: input.agentId,
      requestedBy: input.requestedBy,
      providerOrgId: agent.providerOrgId,
    });
    input = { ...input, spec: normalizeSoftwareOperationSpec(input.spec) };
    const idempotencyKey = `workflow:${input.jobId}:${createHash("sha256").update(input.spec).digest("hex")}`;
    const write = async (tx: PgTransaction) => {
      if (input.executionLease) {
        const [binding] = await tx
          .select()
          .from(workflowExecutionJobs)
          .where(
            and(
              eq(workflowExecutionJobs.jobId, input.jobId),
              eq(workflowExecutionJobs.runId, input.executionLease.runId),
            ),
          );
        if (!binding)
          throw new WorkflowExecutionInterrupted(
            "Software installation lacks its workflow binding",
            { retryable: false },
          );
      }
      await authorizeWorkflow(tx);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`software-install:${input.agentId}:${input.spec}`}, 0))`,
      );
      const [job] = await tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.id, input.jobId), eq(jobs.submittedBy, input.requestedBy)))
        .for("update")
        .limit(1);
      if (!job || job.status !== "pending")
        throw new Error("Job is no longer waiting for software installation");
      const requirements = job.softwareRequirements ?? [];
      const matches = requirements.filter(
        (req) =>
          normalizeSoftwareOperationSpec(
            req.spec ?? (req.version ? `${req.name}@${req.version}` : req.name),
          ) === input.spec,
      );
      if (matches.length === 0)
        throw new Error("Software installation does not match a Job requirement");
      const linkedIds = [
        ...new Set(matches.flatMap((req) => (req.operationId ? [req.operationId] : []))),
      ];
      if (linkedIds.length > 1)
        throw new WorkflowExecutionInterrupted("Job has conflicting software operation bindings", {
          retryable: false,
        });
      const linkedId = linkedIds[0];
      if (linkedId) {
        const [linked] = await tx
          .select()
          .from(softwareOperations)
          .where(eq(softwareOperations.id, linkedId));
        if (
          !linked ||
          linked.agentId !== input.agentId ||
          linked.spec !== input.spec ||
          linked.action !== "install" ||
          linked.federationJobId !== federationJobId ||
          (federationJobId !== null && linked.requestedBy !== input.requestedBy) ||
          (input.expectedPin && linked.manifestDigest !== input.expectedPin.manifestDigest)
        )
          throw new WorkflowExecutionInterrupted("Job software operation binding changed", {
            retryable: false,
          });
        return { operation: linked, created: false };
      }
      const [existing] = await tx
        .select()
        .from(softwareOperations)
        .where(
          and(
            eq(softwareOperations.agentId, input.agentId),
            eq(softwareOperations.spec, input.spec),
            eq(softwareOperations.action, "install"),
            federationJobId
              ? and(
                  eq(softwareOperations.federationJobId, federationJobId),
                  eq(softwareOperations.requestedBy, input.requestedBy),
                )
              : isNull(softwareOperations.federationJobId),
            or(
              inArray(softwareOperations.status, ["queued", "running"]),
              and(
                eq(softwareOperations.requestedBy, input.requestedBy),
                eq(softwareOperations.idempotencyKey, idempotencyKey),
              ),
            ),
          ),
        )
        .orderBy(desc(softwareOperations.requestedAt))
        .limit(1);
      const operation =
        existing ??
        (
          await tx
            .insert(softwareOperations)
            .values({
              replayEnabled: !!input.executionLease,
              federationJobId,
              manifestDigest: input.expectedPin?.manifestDigest,
              agentId: input.agentId,
              requestedBy: input.requestedBy,
              action: "install",
              spec: input.spec,
              idempotencyKey,
              idempotencyItemIndex: 0,
              idempotencyItemCount: 1,
            })
            .returning()
        )[0];
      if (!operation) throw new Error("Software operation insert failed");
      if (input.expectedPin && operation.manifestDigest !== input.expectedPin.manifestDigest)
        throw new WorkflowExecutionInterrupted(
          "Existing installation uses a different material release",
          { retryable: false },
        );
      if (input.executionLease && !operation.replayEnabled)
        throw new WorkflowExecutionInterrupted(
          "Waiting for an existing installation without durable delivery",
        );
      await tx
        .update(jobs)
        .set({
          softwareRequirements: (job.softwareRequirements ?? []).map((req) =>
            normalizeSoftwareOperationSpec(
              req.spec ?? (req.version ? `${req.name}@${req.version}` : req.name),
            ) === input.spec
              ? { ...req, operationId: operation.id }
              : req,
          ),
        })
        .where(and(eq(jobs.id, input.jobId), eq(jobs.status, "pending")));
      return { operation, created: !existing };
    };
    const result = input.executionLease
      ? await input.executionLease.transaction(write)
      : await this.db.transaction(write);
    // The persistent operation and Job association are the delivery intent.
    if (input.executionLease) {
      if (!result.operation.replayEnabled)
        throw new WorkflowExecutionInterrupted("Legacy installation delivery cannot be replayed", {
          retryable: false,
        });
      return this.deliverWorkflowInstallation(
        result.operation,
        input.executionLease,
        input.jobId,
        input.expectedPin,
        authorizeWorkflow,
      );
    }
    return result.created
      ? this.dispatchOperation(result.operation, input.expectedPin)
      : rowToView(result.operation);
  }

  private async deliverWorkflowInstallation(
    operation: typeof softwareOperations.$inferSelect,
    lease: LeasedWorkflowJournal,
    jobId: string,
    expectedPin?: SpackExecutionPin,
    authorizeWorkflow?: (tx: PgTransaction) => Promise<void>,
  ): Promise<SoftwareOperationView> {
    const active = ["queued", "running"];
    if (!active.includes(operation.status)) return rowToView(operation);
    const due = await lease.transaction(async (tx) => {
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      if (
        !job ||
        job.status !== "pending" ||
        !job.softwareRequirements?.some((req) => req.operationId === operation.id)
      )
        throw new WorkflowExecutionInterrupted("Job stopped before installation delivery");
      const [claimed] = await tx
        .update(softwareOperations)
        .set({ nextDispatchAt: sql`clock_timestamp() + interval '5 seconds'` })
        .where(
          and(
            eq(softwareOperations.id, operation.id),
            eq(softwareOperations.replayEnabled, true),
            inArray(softwareOperations.status, active),
            or(
              isNull(softwareOperations.nextDispatchAt),
              sql`${softwareOperations.nextDispatchAt} <= clock_timestamp()`,
            ),
          ),
        )
        .returning();
      return claimed;
    });
    if (!due) return (await this.getOperation(operation.id)) ?? rowToView(operation);
    if (
      due.federationJobId !== operation.federationJobId ||
      (due.federationJobId !== null && due.federationJobId !== jobId)
    )
      throw new WorkflowExecutionInterrupted("Installation authority changed", {
        retryable: false,
      });
    if (!due.requestedBy || !this.prepareSpackInstall)
      throw new WorkflowExecutionInterrupted(
        "Durable installation material authorization is unavailable",
        { retryable: false },
      );
    try {
      const rejection = await this.policyRejection(due.agentId, "install", due.spec);
      if (rejection) throw new WorkflowExecutionInterrupted(rejection, { retryable: false });
      const ticket = await this.prepareSpackInstall({
        operationId: due.id,
        agentId: due.agentId,
        requestedBy: due.requestedBy,
        spec: due.spec,
        ...(expectedPin ? { expectedPin } : {}),
      });
      if (!/^sha256:[0-9a-f]{64}$/.test(ticket.spackManifestDigest) || !ticket.spackMaterialTicket)
        throw new WorkflowExecutionInterrupted(
          "Durable installation lacks a verified material manifest",
          { retryable: false },
        );
      await lease.transaction(async (tx) => {
        const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
        if (
          !job ||
          job.status !== "pending" ||
          !job.softwareRequirements?.some((req) => req.operationId === due.id)
        )
          throw new WorkflowExecutionInterrupted("Job stopped before installation delivery");
        const [current] = await tx
          .select()
          .from(softwareOperations)
          .where(eq(softwareOperations.id, due.id))
          .for("update");
        if (!current)
          throw new WorkflowExecutionInterrupted("Installation operation disappeared", {
            retryable: false,
          });
        if (!active.includes(current.status)) return;
        if (
          !current.replayEnabled ||
          current.agentId !== due.agentId ||
          current.spec !== due.spec ||
          current.requestedBy !== due.requestedBy ||
          current.action !== "install" ||
          current.federationJobId !== due.federationJobId ||
          (current.federationJobId !== null && current.federationJobId !== jobId) ||
          (current.manifestDigest && current.manifestDigest !== ticket.spackManifestDigest)
        )
          throw new WorkflowExecutionInterrupted(
            "Installation replay changed its immutable intent",
            { retryable: false },
          );
        await tx
          .update(softwareOperations)
          .set({ manifestDigest: ticket.spackManifestDigest })
          .where(eq(softwareOperations.id, current.id));
        await authorizeWorkflow?.(tx);
        // The verified Agent records this identity before executing; a lost commit may resend it.
        pushSoftwareOperationSafely(this.dispatcher, due.agentId, {
          operationId: due.id,
          action: actionToProto("install"),
          spec: due.spec,
          requestedBy: due.requestedBy ?? "",
          ...ticket,
          durableReplay: true,
          federationJobId: due.federationJobId ?? undefined,
        });
      });
    } catch (cause) {
      // Completion may revoke the material ticket while a replay is being prepared.
      const current = await this.getOperation(operation.id);
      if (current && !active.includes(current.status)) return current;
      if (cause instanceof WorkflowExecutionInterrupted) throw cause;
      throw new WorkflowExecutionInterrupted("Software installation delivery is pending", {
        cause,
        retryable: !(
          cause instanceof AppError &&
          !(cause instanceof AuthorizationUnavailableError) &&
          cause.statusCode >= 400 &&
          cause.statusCode < 500
        ),
      });
    }
    return (await this.getOperation(operation.id)) ?? rowToView(operation);
  }

  async renewFederationInstallation(
    agentId: string,
    request: FederationExecutionRequest,
    send: (response: FederationExecutionResponse) => void,
  ): Promise<boolean> {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (
      ![request.requestId, request.operationId, request.jobId].every((value) => uuid.test(value)) ||
      request.dispatchEpoch !== 0n ||
      !this.dispatcher.supportsFederationInstallation(agentId)
    )
      return false;
    const [original] = await this.db
      .select()
      .from(softwareOperations)
      .where(eq(softwareOperations.id, request.operationId));
    if (
      !original ||
      original.agentId !== agentId ||
      original.federationJobId !== request.jobId ||
      original.action !== "install" ||
      !original.replayEnabled ||
      !original.requestedBy ||
      !["queued", "running"].includes(original.status)
    )
      return false;
    const requestedBy = original.requestedBy;
    const scope = await installationWorkflowScope(this.db, request.jobId);
    const pin = scope?.intent.spackExecution?.pin;
    if (
      !scope?.reservationId ||
      scope.reservationId !== scope.boundReservationId ||
      !pin ||
      pin.manifestDigest !== original.manifestDigest ||
      scope.intent.spackExecution?.spec !== original.spec ||
      !this.prepareFederationDispatch ||
      !this.authorizeJobInstall ||
      !this.prepareSpackInstall
    )
      return false;
    const fence = await this.prepareFederationDispatch(scope.runId, {
      kind: "install",
      spec: original.spec,
      jobId: request.jobId,
      agentId,
    });
    const agent = await this.assertAgentExists(agentId);
    await this.authorizeJobInstall({
      agentId,
      requestedBy,
      providerOrgId: agent.providerOrgId,
    });
    if (await this.policyRejection(agentId, "install", original.spec)) return false;
    const ticket = await this.prepareSpackInstall({
      operationId: original.id,
      agentId,
      requestedBy,
      spec: original.spec,
      expectedPin: pin,
    });
    if (!ticket.spackMaterialTicket || ticket.spackManifestDigest !== original.manifestDigest)
      return false;
    return this.db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, scope.runId))
        .for("update");
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, request.jobId)).for("update");
      const [current] = await tx
        .select()
        .from(softwareOperations)
        .where(eq(softwareOperations.id, original.id))
        .for("update");
      if (
        !run ||
        run.status !== "running" ||
        run.input?.federationReservationId !== scope.reservationId ||
        !job ||
        job.status !== "pending" ||
        job.submittedBy !== original.requestedBy ||
        run.submittedBy !== job.submittedBy ||
        !job.softwareRequirements?.some(
          (requirement) =>
            requirement.operationId === original.id &&
            requirement.installable === true &&
            normalizeSoftwareOperationSpec(
              requirement.spec ??
                (requirement.version
                  ? `${requirement.name}@${requirement.version}`
                  : requirement.name),
            ) === original.spec,
        ) ||
        !current ||
        !["queued", "running"].includes(current.status)
      )
        return false;
      if (
        current.agentId !== original.agentId ||
        current.federationJobId !== request.jobId ||
        current.requestedBy !== original.requestedBy ||
        current.spec !== original.spec ||
        current.manifestDigest !== original.manifestDigest ||
        current.action !== "install" ||
        !current.replayEnabled ||
        current.idempotencyKey !== original.idempotencyKey
      )
        return false;
      await fence(tx);
      const [binding] = await tx
        .select({
          snapshot: federationWorkflowBindings.snapshot,
          terms: federationAgreements.terms,
        })
        .from(federationWorkflowBindings)
        .innerJoin(
          federationReservations,
          eq(federationReservations.id, federationWorkflowBindings.reservationId),
        )
        .innerJoin(
          federationAgreements,
          eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
        )
        .where(eq(federationWorkflowBindings.workflowRunId, scope.runId));
      if (!binding) return false;
      const expiresAt = Math.min(
        Date.now() + 10_000,
        federationExecutionDeadline(binding.snapshot.request),
        Date.parse(binding.terms.validUntil),
      );
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
      send(
        create(FederationExecutionResponseSchema, {
          requestId: request.requestId,
          jobId: request.jobId,
          operationId: original.id,
          decision: FederationExecutionDecision.GRANTED,
          expiresAtUnixMs: BigInt(expiresAt),
          installation: create(SoftwareOperationRequestSchema, {
            operationId: original.id,
            federationJobId: request.jobId,
            action: ProtoSoftwareOperationAction.INSTALL,
            spec: original.spec,
            requestedBy,
            durableReplay: true,
            ...ticket,
          }),
        }),
      );
      return true;
    });
  }

  async getOperation(id: string): Promise<SoftwareOperationView | null> {
    const [row] = await this.db
      .select()
      .from(softwareOperations)
      .where(eq(softwareOperations.id, id))
      .limit(1);
    return row ? rowToView(row) : null;
  }

  async listOperations(input: {
    scope: CpScope;
    agentId?: string;
    action?: SoftwareOperationAction;
    status?: SoftwareOperationStatusValue;
    limit?: number;
    agentScopeVerified?: boolean;
  }): Promise<SoftwareOperationView[]> {
    const agentIds = input.agentId ? [input.agentId] : await this.accessibleAgentIds(input.scope);
    if (agentIds.length === 0) return [];
    if (input.agentId) {
      if (input.agentScopeVerified) {
        await this.assertAgentExists(input.agentId);
      } else {
        await this.assertAgentInScope(input.scope, input.agentId);
      }
    }
    let where = inArray(softwareOperations.agentId, agentIds);
    if (input.action) {
      where = and(where, eq(softwareOperations.action, input.action)) ?? where;
    }
    if (input.status) {
      where = and(where, eq(softwareOperations.status, input.status)) ?? where;
    }
    const rows = await this.db
      .select()
      .from(softwareOperations)
      .where(where)
      .orderBy(
        desc(softwareOperations.requestedAt),
        desc(softwareOperations.updatedAt),
        desc(softwareOperations.id),
      )
      .limit(input.limit ?? 100);
    return rows.map(rowToView);
  }

  async applyAgentResult(agentId: string, result: SoftwareOperationResult): Promise<void> {
    const status = statusFromProto(result.status);
    const action = softwareOperationActionFromProto(result.action);
    if (!action) return;
    const now = new Date();
    const values = {
      status,
      stdout: result.stdout || null,
      stderr: result.stderr || null,
      exitCode: exitCodeFromResult(status, result.exitCode),
      error: result.error || null,
      ...(status === "running" ? { startedAt: now } : {}),
      ...(status === "succeeded" || status === "failed" || status === "rejected"
        ? { finishedAt: now }
        : {}),
      updatedAt: now,
    };
    const updated = await this.db
      .update(softwareOperations)
      .set(values)
      .where(
        and(
          eq(softwareOperations.id, result.operationId),
          eq(softwareOperations.agentId, agentId),
          eq(softwareOperations.action, action),
          eq(softwareOperations.spec, result.spec),
          inArray(softwareOperations.status, allowedCurrentStatusesForIncomingResult(status)),
        ),
      )
      .returning({ id: softwareOperations.id, action: softwareOperations.action });
    if (shouldRefreshInstalledLedger(status, action, updated.length > 0, result.replayed)) {
      try {
        await this.installedRegistry.replaceForAgent(
          agentId,
          result.installed.map((s) => ({
            name: s.name,
            version: s.version,
            hash: s.hash,
            compiler: s.compiler || undefined,
            arch: s.arch || undefined,
            spec: s.spec,
          })),
        );
      } catch (err) {
        await this.db
          .update(softwareOperations)
          .set({
            status: "failed",
            error: installedLedgerRefreshFailureMessage(err),
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(softwareOperations.id, result.operationId));
      }
    }
  }

  async assertAgentInScope(scope: CpScope, agentId: string): Promise<void> {
    const agent = await this.assertAgentExists(agentId);
    if (
      !scope.isPlatformWide &&
      (agent.providerOrgId === null || !scope.orgIds.includes(agent.providerOrgId))
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Agent is outside CP scope", 403);
    }
  }

  async assertAgentExists(agentId: string): Promise<typeof agents.$inferSelect> {
    const [agent] = await this.db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
    if (!agent) {
      throw new AppError(ErrorCode.NOT_FOUND, "Agent not found", 404);
    }
    return agent;
  }

  private async accessibleAgentIds(scope: CpScope): Promise<string[]> {
    if (scope.isPlatformWide) {
      const rows = await this.db.select({ agentId: agents.agentId }).from(agents);
      return rows.map((row) => row.agentId);
    }
    if (scope.orgIds.length === 0) return [];
    const rows = await this.db
      .select({ agentId: agents.agentId })
      .from(agents)
      .where(inArray(agents.providerOrgId, scope.orgIds));
    return rows.map((row) => row.agentId);
  }

  private async policyRejection(
    agentId: string,
    action: SoftwareOperationAction,
    spec: string,
  ): Promise<string | null> {
    const policy = await resolveEffectiveSpackPolicy(this.db, agentId);
    return policyRejectionForSoftwareOperation(action, spec, policy);
  }
}

export function softwareOperationActionFromProto(
  action: ProtoSoftwareOperationAction,
): SoftwareOperationAction | null {
  switch (action) {
    case ProtoSoftwareOperationAction.INSTALL:
      return "install";
    case ProtoSoftwareOperationAction.UNINSTALL:
      return "uninstall";
    case ProtoSoftwareOperationAction.LOAD:
      return "load";
    case ProtoSoftwareOperationAction.IMPORT_PREINSTALLED:
      return "import_preinstalled";
    default:
      return null;
  }
}

export function normalizeSoftwareOperationSpec(spec: string): string {
  const normalized = spec.trim();
  if (normalized.length === 0) {
    throw new AppError(ErrorCode.VALIDATION_ERROR, "Software operation spec is required", 400);
  }
  return normalized;
}

export function normalizeSoftwareOperationAction(action: string): SoftwareOperationAction {
  if (
    action === "install" ||
    action === "uninstall" ||
    action === "load" ||
    action === "import_preinstalled"
  ) {
    return action;
  }
  throw new AppError(ErrorCode.VALIDATION_ERROR, "Unsupported software operation action", 400);
}

export function softwareOperationFailureMessage(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${message}`;
}

export function installedLedgerRefreshFailureMessage(err: unknown): string {
  return softwareOperationFailureMessage("server installed ledger refresh failed", err);
}

function actionToProto(action: SoftwareOperationAction): ProtoSoftwareOperationAction {
  switch (action) {
    case "install":
      return ProtoSoftwareOperationAction.INSTALL;
    case "uninstall":
      return ProtoSoftwareOperationAction.UNINSTALL;
    case "load":
      return ProtoSoftwareOperationAction.LOAD;
    case "import_preinstalled":
      return ProtoSoftwareOperationAction.IMPORT_PREINSTALLED;
  }
}

function statusFromProto(status: SoftwareOperationStatus): SoftwareOperationStatusValue {
  switch (status) {
    case SoftwareOperationStatus.RUNNING:
      return "running";
    case SoftwareOperationStatus.SUCCEEDED:
      return "succeeded";
    case SoftwareOperationStatus.FAILED:
      return "failed";
    case SoftwareOperationStatus.REJECTED:
      return "rejected";
    default:
      return "failed";
  }
}

export function exitCodeFromResult(
  status: SoftwareOperationStatusValue,
  exitCode: number,
): number | null {
  if (status === "succeeded") return 0;
  if (status === "failed") return exitCode === 0 ? null : exitCode;
  return null;
}

export function shouldRefreshInstalledLedger(
  status: SoftwareOperationStatusValue,
  action: SoftwareOperationAction,
  operationMatched: boolean,
  replayed = false,
): boolean {
  return !replayed && operationMatched && status === "succeeded" && action !== "load";
}

export function shouldApplyOperationResult(
  current: SoftwareOperationStatusValue,
  incoming: SoftwareOperationStatusValue,
): boolean {
  return allowedCurrentStatusesForIncomingResult(incoming).includes(current);
}

export function allowedCurrentStatusesForIncomingResult(
  incoming: SoftwareOperationStatusValue,
): SoftwareOperationStatusValue[] {
  if (incoming === "running") return ["queued"];
  return ["queued", "running"];
}

export function pushSoftwareOperationSafely(
  dispatcher: Pick<AgentDispatcher, "pushSoftwareOperation">,
  agentId: string,
  payload: {
    operationId: string;
    action: ProtoSoftwareOperationAction;
    spec: string;
    requestedBy: string;
    spackMaterialTicket?: string;
    spackManifestDigest?: string;
    durableReplay?: boolean;
    federationJobId?: string;
  },
): { pushed: boolean; error?: string } {
  try {
    return dispatcher.pushSoftwareOperation(agentId, payload)
      ? { pushed: true }
      : { pushed: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { pushed: false, error: `agent dispatch failed: ${message}` };
  }
}

export function policyRejectionForSoftwareOperation(
  action: SoftwareOperationAction,
  spec: string,
  policy: SpackPolicy,
): string | null {
  if (action === "import_preinstalled") return null;
  const decision = decideSpackPolicy(spec, policy);
  return decision === "allow" ? null : decision.reject;
}

interface SpackPolicyLayer {
  lockEnabled?: boolean;
  allowList?: string[] | null;
  denyList?: string[] | null;
}

export function mergeEffectiveSpackPolicyLayers(input: {
  provider?: SpackPolicyLayer | null;
  cluster?: SpackPolicyLayer | null;
  legacy?: SpackPolicyLayer | null;
  agentOverlay?: SpackPolicyLayer | null;
}): SpackPolicy {
  return {
    lockEnabled:
      (input.provider?.lockEnabled ?? false) ||
      (input.cluster?.lockEnabled ?? false) ||
      (input.legacy?.lockEnabled ?? false) ||
      (input.agentOverlay?.lockEnabled ?? false),
    allowList: uniqueSorted([
      ...(input.provider?.allowList ?? []),
      ...(input.cluster?.allowList ?? []),
      ...(input.legacy?.allowList ?? []),
      ...(input.agentOverlay?.allowList ?? []),
    ]),
    denyList: uniqueSorted([
      ...(input.provider?.denyList ?? []),
      ...(input.cluster?.denyList ?? []),
      ...(input.legacy?.denyList ?? []),
      ...(input.agentOverlay?.denyList ?? []),
    ]),
  };
}

export async function resolveEffectiveSpackPolicy(db: PgDb, agentId: string): Promise<SpackPolicy> {
  const [agent] = await db.select().from(agents).where(eq(agents.agentId, agentId)).limit(1);
  if (!agent) return { lockEnabled: false };
  const clusterId = agent.clusterId ?? agent.siteName;
  const providerCondition = agent.providerOrgId
    ? eq(softwarePolicyOverlays.providerOrgId, agent.providerOrgId)
    : isNull(softwarePolicyOverlays.providerOrgId);
  const [overlays, legacyPolicies] = await Promise.all([
    db
      .select()
      .from(softwarePolicyOverlays)
      .where(or(providerCondition, eq(softwarePolicyOverlays.agentId, agentId))),
    db.select().from(softwarePolicies).where(eq(softwarePolicies.agentId, agentId)),
  ]);
  const provider = overlays.find(
    (overlay) => overlay.scope === "provider" && overlay.providerOrgId === agent.providerOrgId,
  );
  const cluster = overlays.find(
    (overlay) =>
      overlay.scope === "cluster" &&
      overlay.providerOrgId === agent.providerOrgId &&
      overlay.clusterId === clusterId,
  );
  const agentOverlay = overlays.find(
    (overlay) => overlay.scope === "agent" && overlay.agentId === agentId,
  );
  const legacy = legacyPolicies.find((policy) => policy.scope === "agent");
  return mergeEffectiveSpackPolicyLayers({ provider, cluster, legacy, agentOverlay });
}

function uniqueSorted(values: string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].sort();
}

function normalizeSoftwareOperationIdempotency(input: {
  idempotencyKey?: string;
  idempotencyItemIndex?: number;
  idempotencyItemCount?: number;
}): {
  idempotencyKey?: string;
  idempotencyItemIndex?: number;
  idempotencyItemCount?: number;
} {
  if (!input.idempotencyKey) return {};
  const itemIndex = input.idempotencyItemIndex ?? 0;
  const itemCount = input.idempotencyItemCount ?? 1;
  if (!Number.isInteger(itemIndex) || itemIndex < 0) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid software operation idempotency item",
      400,
    );
  }
  if (!Number.isInteger(itemCount) || itemCount < 1 || itemIndex >= itemCount) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Invalid software operation idempotency batch",
      400,
    );
  }
  return {
    idempotencyKey: input.idempotencyKey,
    idempotencyItemIndex: itemIndex,
    idempotencyItemCount: itemCount,
  };
}

function assertIdempotentOperationMatches(
  existing: typeof softwareOperations.$inferSelect,
  input: {
    agentId: string;
    action: SoftwareOperationAction;
    spec: string;
    itemCount: number;
  },
): void {
  if (
    existing.agentId !== input.agentId ||
    existing.action !== input.action ||
    existing.spec !== input.spec ||
    existing.idempotencyItemCount !== input.itemCount
  ) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Idempotency-Key was already used for a different software operation",
      409,
    );
  }
}

function rowToView(row: typeof softwareOperations.$inferSelect): SoftwareOperationView {
  return {
    id: row.id,
    agentId: row.agentId,
    requestedBy: row.requestedBy,
    action: row.action as SoftwareOperationAction,
    spec: row.spec,
    status: row.status as SoftwareOperationStatusValue,
    stdout: row.stdout,
    stderr: row.stderr,
    exitCode: row.exitCode,
    error: row.error,
    requestedAt: row.requestedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function installationWorkflowScope(db: PgDb | PgTransaction, jobId: string) {
  const [row] = await db
    .select({
      runId: workflowExecutionJobs.runId,
      intent: workflowExecutionJobs.intent,
      input: workflowRuns.input,
      boundReservationId: federationWorkflowBindings.reservationId,
    })
    .from(workflowExecutionJobs)
    .innerJoin(workflowRuns, eq(workflowRuns.id, workflowExecutionJobs.runId))
    .leftJoin(
      federationWorkflowBindings,
      eq(federationWorkflowBindings.workflowRunId, workflowRuns.id),
    )
    .where(eq(workflowExecutionJobs.jobId, jobId));
  return row ? { ...row, reservationId: row.input?.federationReservationId } : undefined;
}
