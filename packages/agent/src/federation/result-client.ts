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
import { FederationTransferSession, FederationTransferSlot } from "./transfer-session";

export type FederationResultClientConfig = Pick<
  FederationResultCopyOptions,
  "stagingRoot" | "maxStagingBytes" | "allowedSourceOrigins" | "allowedDestinationOrigins"
>;

/** One memory-only copy/verification; shared slot bounds both directions on this Agent. */
export class FederationResultClient {
  private readonly session: FederationTransferSession;
  constructor(
    private readonly config: FederationResultClientConfig,
    sendGrant: (request: FederationResultGrantRequest) => boolean,
    sendReport: (report: FederationResultCopyReport) => void,
    private readonly copy = copyFederationResultFile,
    private readonly verify = verifyFederationResultFile,
    slot = new FederationTransferSlot(),
  ) {
    this.session = new FederationTransferSession(
      (request) => sendGrant(create(FederationResultGrantRequestSchema, request)),
      (report) => sendReport(create(FederationResultCopyReportSchema, report)),
      slot,
    );
  }
  hasPending(id: string) {
    return this.session.hasPending(id);
  }
  receive(response: FederationResultGrantResponse) {
    this.session.receive(response);
  }
  disconnect() {
    return this.session.disconnect();
  }
  start(command: FederationResultCopy): void {
    if (Buffer.byteLength(command.taskJson) > 256 * 1024) return;
    let task: FederationResultCopyTask;
    try {
      task = FederationResultCopyTaskSchema.parse(JSON.parse(command.taskJson));
    } catch {
      return;
    }
    this.session.run(
      task.generation,
      task.report.manifest.availableUntil,
      command.leaseExpiresAtUnixMs,
      async (signal, lease) => {
        const receipt = await this.copy({
          ...this.config,
          task,
          signal,
          authorize: async (binding, direction, partNumber, requestSignal) => {
            const response = await this.session.request(
              {
                requestId: crypto.randomUUID(),
                bindingJson: JSON.stringify(binding),
                upload: direction === "upload",
                partNumber,
              },
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
    this.session.run(
      task.binding.generation,
      task.availableUntil,
      command.leaseExpiresAtUnixMs,
      async (signal, lease) => {
        const receipt = await this.verify({
          task,
          signal,
          allowedDestinationOrigins: this.config.allowedDestinationOrigins,
          authorize: async (verification, requestSignal) => {
            const response = await this.session.request(
              {
                requestId: crypto.randomUUID(),
                verificationJson: JSON.stringify(verification),
              },
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
}
