import { AppError, createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { FederationDeliveryError } from "./outbound-client";
import type { FederationResultImports } from "./result-imports";
import type { FederationResultStorage } from "./result-storage";
import type { FederationResultTransport } from "./result-transport";

const logger = createLogger("federation-results");

/** Persistent attempts fence dispatch; completed members survive process restarts. */
export class FederationResultWorker {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly imports: FederationResultImports,
    private readonly storage: FederationResultStorage,
    private readonly transport: FederationResultTransport,
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
      .catch(() => logger.error("Result scan failed; persistent work remains pending"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async scan() {
    if (this.stopping) return;
    await this.storage.cleanup(4);
    for (let i = 0; i < 4 && !this.stopping; i++) {
      const next = await this.imports.nextPublication();
      if (!next) break;
      try {
        await this.storage.publish(next.actor, next.id);
      } catch (error) {
        await this.failed(next.id, error);
      }
    }
    if (this.stopping) return;
    const usedAgents = new Set<string>();
    for (const next of await this.imports.pending(this.transport.eligibleAgentIds(), 20)) {
      if (this.stopping) return;
      if (usedAgents.has(next.agentId)) continue;
      try {
        if (await this.transport.dispatch(next.transferId, next.agentId))
          usedAgents.add(next.agentId);
      } catch (error) {
        // Concurrent workers can claim a candidate after this scan. That is not an import failure.
        if (error instanceof FederationError && error.code === "OPERATION_CONFLICT") continue;
        await this.failed(next.importId, error);
      }
    }
  }
  private async failed(importId: string, error: unknown) {
    const code =
      error instanceof FederationError ||
      error instanceof FederationDeliveryError ||
      error instanceof AppError
        ? error.code
        : "RESULT_PROCESSING_FAILED";
    await this.imports.processingFailed(importId, code);
    logger.warn({ importId, code }, "Result processing deferred; no partial publication");
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
