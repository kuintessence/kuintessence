import { create } from "@bufbuild/protobuf";
import {
  type FederationResultCopy,
  type FederationResultCopyReport,
  FederationResultCopyReportSchema,
  type FederationResultGrantRequest,
  FederationResultGrantRequestSchema,
  type FederationResultGrantResponse,
} from "@kuintessence/proto";
import {
  FederationResultCopyGrantSchema,
  type FederationResultCopyTask,
  FederationResultCopyTaskSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { copyFederationResultFile, type FederationResultCopyOptions } from "./result-copy";

export type FederationResultClientConfig = Pick<
  FederationResultCopyOptions,
  "stagingRoot" | "maxStagingBytes" | "allowedSourceOrigins" | "allowedDestinationOrigins"
>;

/** One memory-only copy per Agent; lost reports are recovered through Server lease expiry. */
export class FederationResultClient {
  private active?: { generation: string; controller: AbortController; done: Promise<void> };
  private readonly pending = new Map<string, (response: FederationResultGrantResponse) => void>();
  constructor(
    private readonly config: FederationResultClientConfig,
    private readonly sendGrant: (request: FederationResultGrantRequest) => boolean,
    private readonly sendReport: (report: FederationResultCopyReport) => void,
    private readonly copy = copyFederationResultFile,
  ) {}

  hasPending(id: string) {
    return this.pending.has(id);
  }
  receive(response: FederationResultGrantResponse) {
    this.pending.get(response.requestId)?.(response);
  }
  disconnect() {
    this.active?.controller.abort();
    return this.active?.done;
  }

  start(command: FederationResultCopy): void {
    if (Buffer.byteLength(command.taskJson) > 256 * 1024) return;
    let task: FederationResultCopyTask;
    try {
      task = FederationResultCopyTaskSchema.parse(JSON.parse(command.taskJson));
    } catch {
      return;
    }
    if (this.active?.generation === task.generation) return;
    const failed = () =>
      this.sendReport(
        create(FederationResultCopyReportSchema, {
          generation: task.generation,
          failed: true,
        }),
      );
    if (this.active) {
      failed();
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lease = (until: bigint | number) => {
      const expires = Number(until);
      if (
        !Number.isSafeInteger(expires) ||
        expires <= Date.now() ||
        expires > Date.now() + 120_000 ||
        expires > Date.parse(task.report.manifest.availableUntil)
      )
        throw new Error("INVALID_LEASE");
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), expires - Date.now());
    };
    try {
      lease(command.leaseExpiresAtUnixMs);
    } catch {
      failed();
      return;
    }
    const done = Promise.resolve().then(async () => {
      try {
        const receipt = await this.copy({
          ...this.config,
          task,
          signal: controller.signal,
          authorize: async (binding, direction, partNumber, signal) => {
            const request = create(FederationResultGrantRequestSchema, {
              requestId: crypto.randomUUID(),
              bindingJson: JSON.stringify(binding),
              upload: direction === "upload",
              partNumber,
            });
            const response = await this.request(request, signal);
            if (Buffer.byteLength(response.grantJson) > 16 * 1024) throw new Error("INVALID_GRANT");
            const grant = FederationResultCopyGrantSchema.parse(JSON.parse(response.grantJson));
            if (
              federationCanonicalJson(grant.binding) !== federationCanonicalJson(binding) ||
              grant.direction !== direction ||
              grant.partNumber !== partNumber ||
              Date.parse(grant.expiresAt) > Number(response.leaseExpiresAtUnixMs)
            )
              throw new Error("INVALID_GRANT");
            lease(response.leaseExpiresAtUnixMs);
            return grant;
          },
        });
        controller.signal.throwIfAborted();
        this.sendReport(
          create(FederationResultCopyReportSchema, {
            generation: task.generation,
            copiedJson: JSON.stringify(receipt),
          }),
        );
      } catch {
        failed();
      } finally {
        clearTimeout(timer);
        if (this.active?.controller === controller) this.active = undefined;
      }
    });
    this.active = { generation: task.generation, controller, done };
  }

  private async request(request: FederationResultGrantRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort = () => {};
    try {
      return await new Promise<FederationResultGrantResponse>((resolve, reject) => {
        abort = () => reject(new Error("RESULT_GRANT_UNAVAILABLE"));
        this.pending.set(request.requestId, resolve);
        signal.addEventListener("abort", abort, { once: true });
        if (!this.sendGrant(request)) abort();
      });
    } finally {
      this.pending.delete(request.requestId);
      signal.removeEventListener("abort", abort);
    }
  }
}
