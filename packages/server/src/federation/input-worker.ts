import { AppError, createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import type { FederationInputPublication } from "./input-publication";
import type { FederationInputTransfers } from "./input-transfers";
import type { FederationInputTransport } from "./input-transport";

const logger = createLogger("federation-inputs");

/** Cleanup runs with preparation even when dispatch is disabled; this worker only starts authorized copies. */
export class FederationInputWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly transfers: FederationInputTransfers,
    private readonly transport: FederationInputTransport,
    private readonly publication?: FederationInputPublication,
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
      .catch(() => logger.error("Input scan failed; persistent work remains pending"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async scan() {
    if (this.stopping) return;
    if (this.publication)
      for (let i = 0; i < 4 && !this.stopping; i++) {
        const reservationId = await this.publication.next();
        if (!reservationId) break;
        try {
          await this.publication.publish(reservationId);
        } catch (error) {
          const code =
            error instanceof FederationError || error instanceof AppError
              ? error.code
              : "INPUT_PUBLICATION_FAILED";
          await this.publication.failed(reservationId, code);
          logger.warn({ reservationId, code }, "Input publication deferred");
        }
      }
    const used = new Set<string>();
    for (const next of await this.transfers.pending(this.transport.eligibleAgentIds(), 20)) {
      if (this.stopping || used.size >= 4) return;
      if (used.has(next.agentId)) continue;
      used.add(next.agentId);
      try {
        await this.transport.dispatch(next.transferId, next.agentId);
      } catch (error) {
        if (error instanceof FederationError && error.code === "OPERATION_CONFLICT") continue;
        const code = error instanceof FederationError ? error.code : "INPUT_PROCESSING_FAILED";
        await this.transfers.processingFailed(next.transferId, code);
        logger.warn({ transferId: next.transferId, code }, "Input transfer deferred");
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
