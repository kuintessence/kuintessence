import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import {
  type DispatchJob,
  FederationExecutionDecision,
  type FederationExecutionRequest,
  FederationExecutionRequestSchema,
  type FederationExecutionResponse,
  sameDispatchIntent,
} from "@kuintessence/proto";

/** Grants are memory-only. Every preparation/submission boundary asks the current Server again. */
export class FederationExecutionClient {
  private readonly pending = new Map<string, (response?: FederationExecutionResponse) => void>();

  constructor(
    private readonly send: (request: FederationExecutionRequest) => boolean,
    private readonly options: { timeoutMs?: number; retryMs?: number; now?: () => number } = {},
  ) {}

  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  receive(response: FederationExecutionResponse): void {
    this.pending.get(response.requestId)?.(response);
  }

  disconnect(): void {
    for (const complete of this.pending.values()) complete();
  }

  async renew(
    original: DispatchJob,
    signal: AbortSignal,
  ): Promise<{ dispatch: DispatchJob; expiresAt: number }> {
    if (!original.federationExecution)
      throw new Error("Execution grant requires a federation dispatch");
    for (;;) {
      signal.throwIfAborted();
      const request = create(FederationExecutionRequestSchema, {
        requestId: crypto.randomUUID(),
        jobId: original.jobId,
        dispatchEpoch: original.dispatchEpoch,
      });
      const response = await this.request(request, signal);
      if (response) {
        if (response.jobId !== original.jobId || response.dispatchEpoch !== original.dispatchEpoch)
          throw new Error("Federation execution response does not match its request");
        if (response.decision === FederationExecutionDecision.DENIED)
          throw new Error("Federation execution authorization denied");
        if (response.decision === FederationExecutionDecision.GRANTED) {
          const now = (this.options.now ?? Date.now)();
          const expiresAt = Number(response.expiresAtUnixMs);
          if (
            !response.dispatch ||
            !sameDispatchIntent(original, response.dispatch) ||
            !Number.isSafeInteger(expiresAt) ||
            expiresAt > now + 30_000
          )
            throw new Error("Federation execution grant is invalid");
          if (expiresAt > now) return { dispatch: response.dispatch, expiresAt };
        } else if (response.decision !== FederationExecutionDecision.RETRY) {
          throw new Error("Federation execution decision is unspecified");
        }
      }
      await delay(this.options.retryMs ?? 1000, undefined, { signal });
    }
  }

  private request(
    request: FederationExecutionRequest,
    signal: AbortSignal,
  ): Promise<FederationExecutionResponse | undefined> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      const cleanup = () => {
        clearTimeout(timer);
        this.pending.delete(request.requestId);
        signal.removeEventListener("abort", abort);
      };
      const complete = (response?: FederationExecutionResponse) => {
        cleanup();
        resolve(response);
      };
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const timer = setTimeout(() => complete(), this.options.timeoutMs ?? 15_000);
      this.pending.set(request.requestId, complete);
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (!this.send(request)) complete();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}
