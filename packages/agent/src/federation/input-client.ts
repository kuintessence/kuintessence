import { create } from "@bufbuild/protobuf";
import {
  type FederationInputCopy,
  type FederationInputCopyReport,
  FederationInputCopyReportSchema,
  type FederationInputGrantRequest,
  FederationInputGrantRequestSchema,
  type FederationInputGrantResponse,
  type FederationInputVerify,
} from "@kuintessence/proto";
import {
  FederationInputCopyGrantSchema,
  type FederationInputCopyTask,
  FederationInputCopyTaskSchema,
  FederationInputVerificationGrantSchema,
  type FederationInputVerifyTask,
  FederationInputVerifyTaskSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { copyFederationInputFile, type FederationInputCopyOptions } from "./input-copy";
import { verifyFederationInputFile } from "./input-verify";
import { FederationTransferSession, FederationTransferSlot } from "./transfer-session";

export type FederationInputClientConfig = Pick<
  FederationInputCopyOptions,
  "stagingRoot" | "maxStagingBytes" | "allowedSourceOrigins" | "allowedDestinationOrigins"
>;

/** One memory-only copy/verification; shared slot bounds both directions on this Agent. */
export class FederationInputClient {
  private readonly session: FederationTransferSession;
  constructor(
    private readonly config: FederationInputClientConfig,
    sendGrant: (request: FederationInputGrantRequest) => boolean,
    sendReport: (report: FederationInputCopyReport) => void,
    private readonly copy = copyFederationInputFile,
    private readonly verify = verifyFederationInputFile,
    slot = new FederationTransferSlot(),
  ) {
    this.session = new FederationTransferSession(
      (request) => sendGrant(create(FederationInputGrantRequestSchema, request)),
      (report) => sendReport(create(FederationInputCopyReportSchema, report)),
      slot,
    );
  }
  get supportsCopy() {
    return this.config.allowedSourceOrigins.length > 0;
  }
  hasPending(id: string) {
    return this.session.hasPending(id);
  }
  receive(response: FederationInputGrantResponse) {
    this.session.receive(response);
  }
  disconnect() {
    return this.session.disconnect();
  }
  start(command: FederationInputCopy): void {
    if (!this.supportsCopy) return;
    if (Buffer.byteLength(command.taskJson) > 256 * 1024) return;
    let task: FederationInputCopyTask;
    try {
      task = FederationInputCopyTaskSchema.parse(JSON.parse(command.taskJson));
    } catch {
      return;
    }
    this.session.run(
      task.binding.generation,
      task.availableUntil,
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
            const grant = FederationInputCopyGrantSchema.parse(JSON.parse(response.grantJson));
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

  startVerification(command: FederationInputVerify): void {
    if (Buffer.byteLength(command.taskJson) > 16 * 1024) return;
    let task: FederationInputVerifyTask;
    try {
      task = FederationInputVerifyTaskSchema.parse(JSON.parse(command.taskJson));
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
            const grant = FederationInputVerificationGrantSchema.parse(
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
