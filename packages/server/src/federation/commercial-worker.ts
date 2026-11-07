import { createLogger } from "@kuintessence/shared";
import type { FederationAccountingCollection } from "./accounting-collection";
import type { FederationCommercialSubmissionService } from "./commercial-submissions";
import type { FederationMarketService } from "./market";
import type { FederationUsageService } from "./usage";
import type { FederationUsageExchange } from "./usage-exchange";

const logger = createLogger("federation-commercial");
export class FederationCommercialWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(
    private readonly service: FederationCommercialSubmissionService,
    private readonly usage?: FederationUsageService,
    private readonly exchange?: FederationUsageExchange,
    private readonly accounting?: FederationAccountingCollection,
    private readonly market?: FederationMarketService,
  ) {}

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 10_000);
    this.timer.unref();
    void this.tick();
  }

  tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      if (this.usage) {
        try {
          await this.usage.discover();
          for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.usage.advanceNext())) break;
        } catch {
          logger.error("Usage scan failed; original evidence remains in PostgreSQL");
        }
      }
      if (this.accounting) {
        try {
          await this.accounting.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.accounting.advanceNext())) break;
        } catch {
          logger.error("Accounting collection failed; original evidence remains in PostgreSQL");
        }
      }
      if (this.exchange) {
        try {
          await this.exchange.discover();
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.exchange.advanceNext())) break;
        } catch {
          logger.error("Usage exchange scan failed; received evidence remains in PostgreSQL");
        }
      }
      if (this.market) {
        try {
          for (let i = 0; i < 8 && !this.stopped; i++)
            if (!(await this.market.advanceNext())) break;
        } catch {
          logger.error(
            "Market submission failed; original intent and checkpoints remain in PostgreSQL",
          );
        }
      }
      for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.service.advanceNext())) break;
    })()
      .catch(() => {
        logger.error(
          "Commercial scan failed; signed records and recovery checkpoints remain in PostgreSQL",
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
