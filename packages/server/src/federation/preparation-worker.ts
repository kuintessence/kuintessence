import {
  federationAgreements,
  federationPreparations,
  federationReservations,
  federationWorkflowBindings,
  type PgDb,
} from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { FederationExecutionBindingService } from "./execution-binding";
import { FederationMaterializationError } from "./materialize";
import type { FederationPreparationService } from "./preparation";

const logger = createLogger("federation-preparation");

/** Resolve and bind held runs; this worker never queues compute jobs or calls a ledger. */
export class FederationPreparationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly db: PgDb,
    private readonly service: FederationPreparationService,
    private readonly bindings?: FederationExecutionBindingService,
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
      .where(
        and(
          eq(federationAgreements.targetSiteId, this.service.localSiteId),
          eq(federationReservations.state, "reserved"),
          or(
            isNull(federationPreparations.reservationId),
            and(
              or(
                ne(federationPreparations.state, "resolved"),
                this.bindings ? isNull(federationWorkflowBindings.reservationId) : sql`false`,
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
        if (prepared.state === "resolved") await this.bindings?.stage(row.id);
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
        logger.warn(
          { reservationId: row.id },
          "Federation reference resolution failed; will retry",
        );
      }
    }
  }
}
