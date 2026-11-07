import {
  federationAgreements,
  federationCancellations,
  federationPreparations,
  federationReservations,
  federationWorkflowBindings,
  type PgDb,
  workflowRuns,
} from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, eq, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import type { FederationExecutionBindingService } from "./execution-binding";
import { FederationMaterializationError } from "./materialize";
import type { FederationPreparationService } from "./preparation";

const logger = createLogger("federation-preparation");

/** Resolve, bind and authorize workflows; compute dispatch retains its own authorization. */
export class FederationPreparationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly db: PgDb,
    private readonly service: FederationPreparationService,
    private readonly bindings?: FederationExecutionBindingService,
    private readonly queueRun?: (runId: string) => Promise<boolean>,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, 10000);
    this.timer.unref();
    void this.tick();
  }

  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.run()
      .catch(() => {
        logger.error("Federation reference scan failed; pending reservations remain in PostgreSQL");
      })
      .finally(() => {
        this.running = undefined;
      });
    this.running = run;
    return run;
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async run() {
    const cutoff = new Date(Date.now() - 30000);
    const rows = await this.db
      .select({ id: federationReservations.id })
      .from(federationReservations)
      .innerJoin(
        federationAgreements,
        eq(federationAgreements.revisionId, federationReservations.agreementRevisionId),
      )
      .leftJoin(
        federationPreparations,
        eq(federationPreparations.reservationId, federationReservations.id),
      )
      .leftJoin(
        federationWorkflowBindings,
        eq(federationWorkflowBindings.reservationId, federationReservations.id),
      )
      .leftJoin(workflowRuns, eq(workflowRuns.id, federationWorkflowBindings.workflowRunId))
      .where(
        and(
          eq(federationAgreements.targetSiteId, this.service.localSiteId),
          eq(federationReservations.state, "reserved"),
          notExists(
            this.db
              .select({ id: federationCancellations.operationId })
              .from(federationCancellations)
              .where(
                and(
                  eq(federationCancellations.localSiteId, this.service.localSiteId),
                  eq(federationCancellations.senderSiteId, federationReservations.senderSiteId),
                  eq(federationCancellations.operationId, federationReservations.operationId),
                ),
              ),
          ),
          or(
            isNull(federationPreparations.reservationId),
            and(
              or(
                ne(federationPreparations.state, "resolved"),
                this.bindings ? isNull(federationWorkflowBindings.reservationId) : sql`false`,
                this.queueRun ? eq(workflowRuns.status, "submitted") : sql`false`,
              ),
              lt(federationPreparations.updatedAt, cutoff),
            ),
          ),
        ),
      )
      .orderBy(
        asc(
          sql`coalesce(${federationPreparations.updatedAt}, ${federationReservations.createdAt})`,
        ),
        asc(federationReservations.id),
      )
      .limit(8);
    for (const row of rows) {
      try {
        const prepared = await this.service.prepare(row.id);
        if (prepared.state === "resolved") {
          const binding = await this.bindings?.stage(row.id);
          if (binding) await this.queueRun?.(binding.workflowRunId);
        }
      } catch (error) {
        if (error instanceof FederationError || error instanceof FederationMaterializationError) {
          await this.db
            .update(federationPreparations)
            .set({
              state:
                error instanceof FederationError &&
                ["DATA_WAITING", "ASSET_UNAVAILABLE"].includes(error.code)
                  ? "waiting"
                  : "blocked",
              blocker: error instanceof FederationError ? error.code : "WORKFLOW_INCOMPATIBLE",
              updatedAt: new Date(),
            })
            .where(eq(federationPreparations.reservationId, row.id));
          continue;
        }
        await this.db
          .update(federationPreparations)
          .set({ updatedAt: new Date() })
          .where(eq(federationPreparations.reservationId, row.id));
        logger.warn(
          { reservationId: row.id },
          "Federation reference resolution failed; will retry",
        );
      }
    }
  }
}
