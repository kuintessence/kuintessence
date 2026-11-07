import { create } from "@bufbuild/protobuf";
import {
  type FederationResultCopy,
  type FederationResultCopyReport,
  FederationResultCopyReportSchema,
  type FederationResultGrantRequest,
  FederationResultGrantRequestSchema,
  type FederationResultGrantResponse,
  type FederationResultVerify,
} from "@kuintessence/proto";
import {
  FederationResultCopyGrantSchema,
  type FederationResultCopyTask,
  FederationResultCopyTaskSchema,
  FederationResultVerificationGrantSchema,
  type FederationResultVerifyTask,
  FederationResultVerifyTaskSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { copyFederationResultFile, type FederationResultCopyOptions } from "./result-copy";
import { verifyFederationResultFile } from "./result-verify";

export type FederationResultClientConfig = Pick<
  FederationResultCopyOptions,
  "stagingRoot" | "maxStagingBytes" | "allowedSourceOrigins" | "allowedDestinationOrigins"
>;

/** One memory-only copy/verification per Agent; lost reports recover through Server leases. */
export class FederationResultClient {
  private active?: { generation: string; controller: AbortController; done: Promise<void> };
  private readonly pending = new Map<string, (response: FederationResultGrantResponse) => void>();
  constructor(
    private readonly config: FederationResultClientConfig,
    private readonly sendGrant: (request: FederationResultGrantRequest) => boolean,
    private readonly sendReport: (report: FederationResultCopyReport) => void,
    private readonly copy = copyFederationResultFile,
    private readonly verify = verifyFederationResultFile,
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
    this.run(
      task.generation,
      task.report.manifest.availableUntil,
      command.leaseExpiresAtUnixMs,
      async (signal, lease) => {
        const receipt = await this.copy({
          ...this.config,
          task,
          signal,
          authorize: async (binding, direction, partNumber, requestSignal) => {
            const response = await this.request(
              create(FederationResultGrantRequestSchema, {
                requestId: crypto.randomUUID(),
                bindingJson: JSON.stringify(binding),
                upload: direction === "upload",
                partNumber,
              }),
              requestSignal,
            );
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
        return { copiedJson: JSON.stringify(receipt) };
      },
    );
  }

  startVerification(command: FederationResultVerify): void {
    if (Buffer.byteLength(command.taskJson) > 16 * 1024) return;
    let task: FederationResultVerifyTask;
    try {
      task = FederationResultVerifyTaskSchema.parse(JSON.parse(command.taskJson));
    } catch {
      return;
    }
    this.run(
      task.binding.generation,
      task.availableUntil,
      command.leaseExpiresAtUnixMs,
      async (signal, lease) => {
        const receipt = await this.verify({
          task,
          signal,
          allowedDestinationOrigins: this.config.allowedDestinationOrigins,
          authorize: async (verification, requestSignal) => {
            const response = await this.request(
              create(FederationResultGrantRequestSchema, {
                requestId: crypto.randomUUID(),
                verificationJson: JSON.stringify(verification),
              }),
              requestSignal,
            );
            const grant = FederationResultVerificationGrantSchema.parse(
              JSON.parse(response.grantJson),
            );
            if (
              federationCanonicalJson({
                binding: grant.binding,
                object: grant.object,
                availableUntil: grant.availableUntil,
              }) !== federationCanonicalJson(verification) ||
              Date.parse(grant.expiresAt) > Number(response.leaseExpiresAtUnixMs)
            )
              throw new Error("INVALID_GRANT");
            lease(response.leaseExpiresAtUnixMs);
            return grant;
          },
        });
        return { verifiedJson: JSON.stringify(receipt) };
      },
    );
  }

  private run(
    generation: string,
    availableUntil: string,
    deadline: bigint,
    work: (
      signal: AbortSignal,
      lease: (until: bigint) => void,
    ) => Promise<{ copiedJson?: string; verifiedJson?: string }>,
  ) {
    if (this.active?.generation === generation) return;
    const failed = () =>
      this.sendReport(create(FederationResultCopyReportSchema, { generation, failed: true }));
    if (this.active) {
      failed();
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const lease = (until: bigint) => {
      const expires = Number(until);
      if (
        !Number.isSafeInteger(expires) ||
        expires <= Date.now() ||
        expires > Date.now() + 120_000 ||
        expires > Date.parse(availableUntil)
      )
        throw new Error("INVALID_LEASE");
      controller.signal.throwIfAborted();
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), expires - Date.now());
    };
    try {
      lease(deadline);
    } catch {
      failed();
      return;
    }
    const done = Promise.resolve().then(async () => {
      try {
        const receipt = await work(controller.signal, lease);
        controller.signal.throwIfAborted();
        this.sendReport(create(FederationResultCopyReportSchema, { generation, ...receipt }));
      } catch {
        failed();
      } finally {
        clearTimeout(timer);
        if (this.active?.controller === controller) this.active = undefined;
      }
    });
    this.active = { generation, controller, done };
  }

  private async request(request: FederationResultGrantRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    let abort = () => {};
    try {
      const response = await new Promise<FederationResultGrantResponse>((resolve, reject) => {
        abort = () => reject(new Error("RESULT_GRANT_UNAVAILABLE"));
        this.pending.set(request.requestId, resolve);
        signal.addEventListener("abort", abort, { once: true });
        if (!this.sendGrant(request)) abort();
      });
      if (Buffer.byteLength(response.grantJson) > 16 * 1024) throw new Error("INVALID_GRANT");
      return response;
    } finally {
      this.pending.delete(request.requestId);
      signal.removeEventListener("abort", abort);
    }
  }
}
