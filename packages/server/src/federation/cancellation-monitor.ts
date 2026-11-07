import { federationCancellations, type PgDb } from "@kuintessence/db";
import { createLogger } from "@kuintessence/shared";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { WorkflowAsyncRunner } from "../workflow/async-runner";
import { readFederationCancellationState } from "./cancellation-state";
import { retirePendingInputImport } from "./input-imports";

const logger = createLogger("federation-cancellation");

/** Idempotent stop/cleanup calls can be repeated after a crash; no execution lease is created. */
export class FederationCancellationMonitor {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly db: PgDb,
    private readonly runner: Pick<WorkflowAsyncRunner, "cancel">,
    private readonly stopJobs: (runId: string) => Promise<void>,
    private readonly clock: () => Date = () => new Date(),
  ) {}
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref();
    void this.tick();
  }
  tick(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.scan()
      .catch(() => logger.error("Cancellation scan failed; durable fences remain active"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async scan() {
    const rows = await this.db
      .select()
      .from(federationCancellations)
      .where(
        and(
          isNull(federationCancellations.confirmedAt),
          lte(federationCancellations.nextCheckAt, this.clock()),
        ),
      )
      .orderBy(asc(federationCancellations.nextCheckAt), asc(federationCancellations.operationId))
      .limit(8);
    for (const row of rows) {
      if (this.stopping) return;
      const key = and(
        eq(federationCancellations.localSiteId, row.localSiteId),
        eq(federationCancellations.senderSiteId, row.senderSiteId),
        eq(federationCancellations.operationId, row.operationId),
      );
      await this.db
        .update(federationCancellations)
        .set({ nextCheckAt: new Date(this.clock().getTime() + 30_000) })
        .where(key);
      try {
        const before = await readFederationCancellationState(this.db, row.request);
        const reservationId = before.reservationId;
        if (reservationId)
          await this.db.transaction((tx) =>
            retirePendingInputImport(tx, reservationId, "CANCELLATION_REQUESTED", this.clock()),
          );
        for (const runId of before.runs) {
          await this.runner.cancel(runId, {
            code: "FEDERATION_CANCELLATION_REQUESTED",
            message: "Origin institution requested cancellation",
          });
          // Terminal workflow/job states alone do not prove a lingering installer has stopped.
          await this.stopJobs(runId);
        }
        const after = await readFederationCancellationState(this.db, row.request);
        if (after.stopped)
          await this.db
            .update(federationCancellations)
            .set({ confirmedAt: this.clock() })
            .where(and(key, isNull(federationCancellations.confirmedAt)));
      } catch {
        logger.warn(
          { operationId: row.operationId },
          "Remote cancellation awaits stop and cleanup confirmation",
        );
      }
    }
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
