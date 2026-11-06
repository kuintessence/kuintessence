import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  federationAgreements,
  federationReservations,
  federationWorkflowBindings,
  jobDispatchOutbox,
  jobs,
  type PgDb,
  type PgTransaction,
  workflowExecutionJobs,
  workflowRuns,
} from "@kuintessence/db";
import {
  FederationExecutionDecision,
  type FederationExecutionRequest,
  type FederationExecutionResponse,
  FederationExecutionResponseSchema,
  type ServerMessage,
  ServerMessageSchema,
  sameDispatchIntent,
} from "@kuintessence/proto";
import { createLogger, WorkflowExecutionInterrupted } from "@kuintessence/shared";
import { federationExecutionDeadline } from "@kuintessence/shared/federation";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  assertRunningDataBindings,
  type PreparedFederationDataDispatch,
} from "../federation/data-dispatch";
import type { FederationDeliveryTarget } from "../federation/dispatch-authorization";
import type { LeasedWorkflowJournal } from "../workflow/execution-journal";
import type { AgentDispatcher } from "./dispatcher";

const logger = createLogger("job-dispatch-outbox");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

interface ExecutionGrantDelivery {
  agentId: string;
  request: FederationExecutionRequest;
  send: (response: FederationExecutionResponse) => void;
}

/** Stores the original envelope. Renewed data credentials never change its execution intent. */
export class JobDispatchOutbox {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;

  constructor(
    private readonly db: PgDb,
    private readonly dispatcher: AgentDispatcher,
    private readonly prepareFederationDispatch?: (
      runId: string,
      target: FederationDeliveryTarget,
    ) => Promise<(tx: PgTransaction) => Promise<number>>,
    private readonly prepareFederationData?: (
      agentId: string,
      message: ServerMessage,
    ) => Promise<PreparedFederationDataDispatch>,
  ) {}

  async enqueue(
    agentId: string,
    message: ServerMessage,
    workflowRunId?: string,
    executionLease?: LeasedWorkflowJournal,
  ): Promise<{ sent: boolean; pending: boolean }> {
    if (message.payload.case !== "dispatchJob") throw new Error("Expected a job dispatch message");
    const payload = message.payload.value;
    const epoch = Number(payload.dispatchEpoch);
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Invalid dispatch epoch");
    const bytes = toBinary(ServerMessageSchema, message);
    if (bytes.byteLength > 16 * 1024 * 1024) throw new Error("Dispatch envelope exceeds 16 MiB");
    const encoded = Buffer.from(bytes).toString("base64");
    const accepted = await (executionLease ?? this.db).transaction(async (tx) => {
      const [invocation] = await tx
        .select({ runId: workflowExecutionJobs.runId })
        .from(workflowExecutionJobs)
        .where(eq(workflowExecutionJobs.jobId, payload.jobId));
      if (workflowRunId && invocation && invocation.runId !== workflowRunId)
        throw new Error("Dispatch workflow does not match the persisted invocation");
      const runId = workflowRunId ?? invocation?.runId;
      if (invocation && !executionLease)
        throw new WorkflowExecutionInterrupted(
          "Durable dispatch requires the current execution lease",
          { retryable: false },
        );
      if (executionLease && (!invocation || runId !== executionLease.runId))
        throw new WorkflowExecutionInterrupted(
          "Dispatch lease does not match the bound invocation",
          { retryable: false },
        );
      // Match journal lock order: Workflow first, then Job and its outbox.
      const [run] = runId
        ? await tx
            .select({ status: workflowRuns.status, submittedBy: workflowRuns.submittedBy })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, runId))
            .for("update")
        : [];
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, payload.jobId)).for("update");
      if (
        !job ||
        job.status !== "queued" ||
        job.agentId !== agentId ||
        job.dispatchEpoch !== epoch ||
        job.revokedEpoch >= epoch
      )
        return false;
      if (runId && (!run || run.status !== "running" || run.submittedBy !== job.submittedBy))
        return false;
      await tx
        .insert(jobDispatchOutbox)
        .values({
          jobId: job.id,
          agentId,
          dispatchEpoch: epoch,
          payloadBase64: encoded,
          workflowRunId: runId ?? null,
        })
        .onConflictDoNothing();
      const [saved] = await tx
        .select()
        .from(jobDispatchOutbox)
        .where(eq(jobDispatchOutbox.jobId, job.id));
      if (
        !saved ||
        saved.agentId !== agentId ||
        saved.dispatchEpoch !== epoch ||
        saved.payloadBase64 !== encoded ||
        saved.workflowRunId !== (runId ?? null)
      )
        throw new Error("A committed dispatch envelope cannot be replaced");
      return true;
    });
    if (!accepted) return { sent: false, pending: false };
    // After commit, a delivery failure must not turn an accepted job into a failed job.
    try {
      const sent = await this.deliver(payload.jobId, true);
      return { sent, pending: !sent };
    } catch {
      await this.defer(payload.jobId);
      logger.warn({ jobId: payload.jobId }, "Dispatch retained for retry after delivery failure");
      return { sent: false, pending: true };
    }
  }

  async acknowledge(agentId: string, jobId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [received] = await tx
        .update(jobDispatchOutbox)
        .set({ acknowledgedAt: sql`clock_timestamp()` })
        .where(
          and(
            eq(jobDispatchOutbox.jobId, jobId),
            eq(jobDispatchOutbox.agentId, agentId),
            isNull(jobDispatchOutbox.acknowledgedAt),
          ),
        )
        .returning({ jobId: jobDispatchOutbox.jobId });
      if (received)
        await tx
          .update(workflowExecutionJobs)
          .set({ dispatchState: "acknowledged" })
          .where(eq(workflowExecutionJobs.jobId, jobId));
    });
  }

  async renewExecution(
    agentId: string,
    request: FederationExecutionRequest,
    send: ExecutionGrantDelivery["send"],
  ): Promise<boolean> {
    if (
      request.operationId ||
      !UUID.test(request.jobId) ||
      !UUID.test(request.requestId) ||
      request.dispatchEpoch < 1n ||
      request.dispatchEpoch > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return false;
    if (!this.dispatcher.supportsFederationExecution(agentId)) return false;
    return this.deliver(request.jobId, true, { agentId, request, send });
  }

  async redeliver(agentId?: string): Promise<void> {
    const rows = await this.db
      .select({ jobId: jobDispatchOutbox.jobId })
      .from(jobDispatchOutbox)
      .innerJoin(jobs, eq(jobs.id, jobDispatchOutbox.jobId))
      .leftJoin(workflowRuns, eq(workflowRuns.id, jobDispatchOutbox.workflowRunId))
      .where(
        and(
          isNull(jobDispatchOutbox.acknowledgedAt),
          eq(jobs.status, "queued"),
          lt(jobs.revokedEpoch, jobDispatchOutbox.dispatchEpoch),
          or(isNull(jobDispatchOutbox.workflowRunId), eq(workflowRuns.status, "running")),
          eq(jobs.agentId, jobDispatchOutbox.agentId),
          eq(jobs.dispatchEpoch, jobDispatchOutbox.dispatchEpoch),
          agentId
            ? eq(jobDispatchOutbox.agentId, agentId)
            : lte(jobDispatchOutbox.nextAttemptAt, sql`clock_timestamp()`),
        ),
      )
      .orderBy(asc(jobDispatchOutbox.nextAttemptAt))
      .limit(50);
    for (const row of rows) {
      try {
        await this.deliver(row.jobId, agentId !== undefined);
      } catch {
        await this.defer(row.jobId);
        logger.warn({ jobId: row.jobId }, "Dispatch retry deferred");
      }
    }
  }

  private async defer(jobId: string): Promise<void> {
    // Failed authorization rolls back deliver's backoff; keep blocked rows from starving later work.
    try {
      await this.db
        .update(jobDispatchOutbox)
        .set({ nextAttemptAt: sql`clock_timestamp() + interval '30 seconds'` })
        .where(and(eq(jobDispatchOutbox.jobId, jobId), isNull(jobDispatchOutbox.acknowledgedAt)));
    } catch {
      logger.warn({ jobId }, "Dispatch retained but retry backoff could not be saved");
    }
  }

  private async deliver(
    jobId: string,
    force: boolean,
    grant?: ExecutionGrantDelivery,
  ): Promise<boolean> {
    const [identity] = await this.db
      .select({
        runId: jobDispatchOutbox.workflowRunId,
        input: workflowRuns.input,
        boundReservationId: federationWorkflowBindings.reservationId,
        payloadBase64: jobDispatchOutbox.payloadBase64,
        agentId: jobDispatchOutbox.agentId,
      })
      .from(jobDispatchOutbox)
      .leftJoin(workflowRuns, eq(workflowRuns.id, jobDispatchOutbox.workflowRunId))
      .leftJoin(
        federationWorkflowBindings,
        eq(federationWorkflowBindings.workflowRunId, jobDispatchOutbox.workflowRunId),
      )
      .where(eq(jobDispatchOutbox.jobId, jobId));
    if (!identity) return false;
    const reservationId =
      identity.input?.federationReservationId ?? identity.boundReservationId ?? undefined;
    const preparedMessage = fromBinary(
      ServerMessageSchema,
      Buffer.from(identity.payloadBase64, "base64"),
    );
    if (preparedMessage.payload.case !== "dispatchJob") throw new Error("Invalid dispatch payload");
    const originalDispatch = preparedMessage.payload.value;
    const running = grant?.request.runtimeRenewal === true;
    if (Boolean(reservationId) !== preparedMessage.payload.value.federationExecution)
      throw new WorkflowExecutionInterrupted(
        "Dispatch federation capability does not match its binding",
        { retryable: false },
      );
    if (
      grant &&
      (!reservationId ||
        identity.agentId !== grant.agentId ||
        preparedMessage.payload.value.dispatchEpoch !== grant.request.dispatchEpoch)
    )
      return false;
    if (reservationId && (!identity.runId || !this.prepareFederationDispatch))
      throw new WorkflowExecutionInterrupted("Federation dispatch authorization is unavailable", {
        retryable: false,
      });
    const authorize =
      reservationId && identity.runId
        ? await this.prepareFederationDispatch?.(identity.runId, {
            kind: "compute",
            jobId,
            agentId: identity.agentId,
            qos: preparedMessage.payload.value.qos,
            running,
          })
        : undefined;
    const data =
      reservationId && !running
        ? await this.prepareFederationData?.(identity.agentId, preparedMessage)
        : undefined;
    if (
      reservationId &&
      !running &&
      !data &&
      (preparedMessage.payload.value.dataDeliveries.length > 0 ||
        preparedMessage.payload.value.inputStaging.some(
          (input) => input.deliveryLeaseId || input.deliveryLeaseExpiresAtUnixMs !== 0n,
        ))
    )
      throw new WorkflowExecutionInterrupted("Federation data authorization is unavailable", {
        retryable: false,
      });
    return this.db.transaction(async (tx) => {
      const [run] = identity.runId
        ? await tx
            .select({
              status: workflowRuns.status,
              submittedBy: workflowRuns.submittedBy,
              input: workflowRuns.input,
            })
            .from(workflowRuns)
            .where(eq(workflowRuns.id, identity.runId))
            .for("update")
        : [];
      const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
      const [saved] = await tx
        .select()
        .from(jobDispatchOutbox)
        .where(
          and(
            eq(jobDispatchOutbox.jobId, jobId),
            grant ? undefined : isNull(jobDispatchOutbox.acknowledgedAt),
            force ? undefined : lte(jobDispatchOutbox.nextAttemptAt, sql`clock_timestamp()`),
          ),
        )
        .for("update");
      if (
        !job ||
        !saved ||
        !(running ? ["queued", "running"].includes(job.status) : job.status === "queued") ||
        job.agentId !== saved.agentId ||
        job.dispatchEpoch !== saved.dispatchEpoch ||
        job.revokedEpoch >= saved.dispatchEpoch ||
        saved.workflowRunId !== identity.runId
      )
        return false;
      if (saved.payloadBase64 !== identity.payloadBase64 || saved.agentId !== identity.agentId)
        throw new WorkflowExecutionInterrupted("Prepared dispatch changed", { retryable: false });
      if (
        saved.workflowRunId &&
        (!run || run.status !== "running" || run.submittedBy !== job.submittedBy)
      )
        return false;
      if (run?.input?.federationReservationId !== reservationId)
        throw new WorkflowExecutionInterrupted("Federation dispatch binding changed", {
          retryable: false,
        });
      const message = data?.message ?? preparedMessage;
      if (
        message.payload.case !== "dispatchJob" ||
        message.payload.value.jobId !== jobId ||
        message.payload.value.dispatchEpoch !== BigInt(saved.dispatchEpoch)
      )
        throw new Error("Invalid persisted dispatch envelope");
      if (!sameDispatchIntent(originalDispatch, message.payload.value))
        throw new WorkflowExecutionInterrupted("Credential renewal changed dispatch intent", {
          retryable: false,
        });
      if (!running)
        await tx
          .update(jobDispatchOutbox)
          .set({ nextAttemptAt: sql`clock_timestamp() + interval '10 seconds'` })
          .where(eq(jobDispatchOutbox.jobId, jobId));
      const authorizationDeadline = await authorize?.(tx);
      await data?.authorize(tx);
      if (running) await assertRunningDataBindings(tx, originalDispatch);
      if (grant) {
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
          .where(eq(federationWorkflowBindings.workflowRunId, saved.workflowRunId ?? ""));
        if (!binding) return false;
        const dispatch = message.payload.value;
        const expiry = Math.min(
          Date.now() + 10_000,
          authorizationDeadline ?? Number.POSITIVE_INFINITY,
          federationExecutionDeadline(binding.snapshot.request),
          Date.parse(binding.terms.validUntil),
          ...(running
            ? []
            : dispatch.dataDeliveries.map((item) => Number(item.leaseExpiresAtUnixMs))),
          ...(running
            ? []
            : dispatch.inputStaging
                .filter((item) => item.deliveryLeaseId)
                .map((item) => Number(item.deliveryLeaseExpiresAtUnixMs))),
          ...(!running && dispatch.sandboxExecution?.envelope
            ? [Number(dispatch.sandboxExecution.envelope.expiresAtUnixMs)]
            : []),
        );
        if (!Number.isSafeInteger(expiry) || expiry <= Date.now()) return false;
        grant.send(
          create(FederationExecutionResponseSchema, {
            requestId: grant.request.requestId,
            jobId,
            dispatchEpoch: grant.request.dispatchEpoch,
            decision: FederationExecutionDecision.GRANTED,
            expiresAtUnixMs: BigInt(expiry),
            runtimeRenewal: running,
            ...(running ? {} : { dispatch }),
          }),
        );
        return true;
      }
      // Synchronous channel enqueue stays inside the cancellation fence; no network await here.
      // A failed commit may replay the same epoch, which the Agent's durable inbox deduplicates.
      return this.dispatcher.pushPreparedDispatch(saved.agentId, message);
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 5000);
    this.timer.unref();
    void this.tick();
  }

  private tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.redeliver()
      .catch(() => logger.error("Dispatch outbox scan failed; will retry"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
