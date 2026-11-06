import { federationWorkflowBindings, type PgDb, workflowRuns } from "@kuintessence/db";
import { AppError, createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, eq, gt, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { WorkflowAsyncRunner } from "../workflow/async-runner";
import type { FederationDispatchAuthorization } from "./dispatch-authorization";

const logger = createLogger("federation-execution-monitor");

/** Reuses dispatch authority and durable Workflow cancellation; never depends on a ledger. */
export class FederationExecutionMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private cursor?: string;

  constructor(
    private readonly db: PgDb,
    private readonly authorization: Pick<FederationDispatchAuthorization, "prepare"> | undefined,
    private readonly runner: Pick<WorkflowAsyncRunner, "cancel">,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 10000);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.scan()
      .catch(() => logger.error("Federation execution scan failed; will retry"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async scan() {
    const runs = await this.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .leftJoin(
        federationWorkflowBindings,
        eq(federationWorkflowBindings.workflowRunId, workflowRuns.id),
      )
      .where(
        and(
          inArray(workflowRuns.status, ["submitted", "queued", "awaiting_approval", "running"]),
          or(
            isNotNull(federationWorkflowBindings.reservationId),
            sql`${workflowRuns.input}->>'federationReservationId' is not null`,
          ),
          this.cursor ? gt(workflowRuns.id, this.cursor) : undefined,
        ),
      )
      .orderBy(asc(workflowRuns.id))
      .limit(25);
    for (const run of runs) {
      try {
        await this.inspect(run.id);
      } catch {
        logger.warn({ runId: run.id }, "Federation execution check failed; will retry");
      }
      // Failures must not starve later runs; restart scans from PostgreSQL after process loss.
      this.cursor = run.id;
    }
    if (runs.length < 25) this.cursor = undefined;
  }

  private async inspect(runId: string) {
    let reason: string;
    try {
      if (!this.authorization) throw new FederationError("POLICY_DENIED");
      const fence = await this.authorization.prepare(runId);
      await this.db.transaction(fence);
      return;
    } catch (error) {
      if (
        error instanceof FederationError &&
        error.code !== "ASSET_UNAVAILABLE" &&
        error.code !== "DATA_WAITING"
      ) {
        reason = error.code;
      } else if (error instanceof AppError && error.statusCode === 403) {
        reason = "POLICY_DENIED";
      } else {
        // Missing replicas and infrastructure failures are not proof of revoked authority.
        throw error;
      }
    }
    await this.runner.cancel(runId, {
      code: "FEDERATION_AUTHORIZATION_REVOKED",
      message: reason,
    });
  }
}
