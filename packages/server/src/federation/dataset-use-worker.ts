import { createLogger } from "@kuintessence/shared";
import type { FederationDatasetPublicationService } from "./dataset-publication";

const logger = createLogger("federation-dataset-use");
export class FederationDatasetUseWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopped = false;
  constructor(private readonly service: Pick<FederationDatasetPublicationService, "renewNext">) {}

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, 1_000);
    this.timer.unref();
    void this.tick();
  }

  tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      for (let i = 0; i < 8 && !this.stopped; i++) if (!(await this.service.renewNext())) break;
    })()
      .catch(() => {
        logger.error(
          "Dataset authorization renewal failed; existing signed leases retain their original expiry",
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
