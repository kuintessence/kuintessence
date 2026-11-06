import {
  federationAgreements,
  federationPreparations,
  federationReservations,
  type PgDb,
} from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { and, asc, eq, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { FederationPreparationService } from "./preparation";

const logger = createLogger("federation-preparation");

/** Reference resolution is repeatable; this worker never submits jobs or calls a ledger. */
export class FederationPreparationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  constructor(
    private readonly db: PgDb,
    private readonly service: FederationPreparationService,
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
      .where(
        and(
          eq(federationAgreements.targetSiteId, this.service.localSiteId),
          eq(federationReservations.state, "reserved"),
          or(
            isNull(federationPreparations.reservationId),
            and(
              ne(federationPreparations.state, "resolved"),
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
        await this.service.prepare(row.id);
      } catch {
        logger.warn(
          { reservationId: row.id },
          "Federation reference resolution failed; will retry",
        );
      }
    }
  }
}
