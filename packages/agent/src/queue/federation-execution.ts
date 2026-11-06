import { setTimeout as delay } from "node:timers/promises";
import { create } from "@bufbuild/protobuf";
import {
  type DispatchJob,
  FederationExecutionDecision,
  type FederationExecutionRequest,
  FederationExecutionRequestSchema,
  type FederationExecutionResponse,
  SoftwareOperationAction,
  type SoftwareOperationRequest,
  sameDispatchIntent,
  sameInstallationIntent,
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
    const grant = await this.renewGrant(
      original.jobId,
      original.dispatchEpoch,
      "",
      signal,
      (response) =>
        !response.installation &&
        !!response.dispatch &&
        sameDispatchIntent(original, response.dispatch),
    );
    if (!grant.response.dispatch) throw new Error("Missing federation dispatch grant");
    return { dispatch: grant.response.dispatch, expiresAt: grant.expiresAt };
  }

  async renewInstallation(
    original: SoftwareOperationRequest,
    signal: AbortSignal,
  ): Promise<{ installation: SoftwareOperationRequest; expiresAt: number }> {
    if (
      !original.federationJobId ||
      !original.durableReplay ||
      original.action !== SoftwareOperationAction.INSTALL
    )
      throw new Error("Installation grant requires a durable federation install");
    const grant = await this.renewGrant(
      original.federationJobId,
      0n,
      original.operationId,
      signal,
      (response) =>
        !response.dispatch &&
        !!response.installation &&
        !!response.installation.spackMaterialTicket &&
        sameInstallationIntent(original, response.installation),
    );
    if (!grant.response.installation) throw new Error("Missing federation installation grant");
    return { installation: grant.response.installation, expiresAt: grant.expiresAt };
  }

  private async renewGrant(
    jobId: string,
    dispatchEpoch: bigint,
    operationId: string,
    signal: AbortSignal,
    validate: (response: FederationExecutionResponse) => boolean,
  ) {
    for (;;) {
      signal.throwIfAborted();
      const request = create(FederationExecutionRequestSchema, {
        requestId: crypto.randomUUID(),
        jobId,
        dispatchEpoch,
        operationId,
      });
      const response = await this.request(request, signal);
      if (response) {
        if (
          response.jobId !== jobId ||
          response.dispatchEpoch !== dispatchEpoch ||
          response.operationId !== operationId
        )
          throw new Error("Federation execution response does not match its request");
        if (response.decision === FederationExecutionDecision.DENIED)
          throw new Error("Federation execution authorization denied");
        if (response.decision === FederationExecutionDecision.GRANTED) {
          const now = (this.options.now ?? Date.now)();
          const expiresAt = Number(response.expiresAtUnixMs);
          if (!validate(response) || !Number.isSafeInteger(expiresAt) || expiresAt > now + 30_000)
            throw new Error("Federation execution grant is invalid");
          if (expiresAt > now) return { response, expiresAt };
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
