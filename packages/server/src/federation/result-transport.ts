import { create } from "@bufbuild/protobuf";
import {
  type FederationResultCopyReport,
  FederationResultCopySchema,
  type FederationResultGrantRequest,
  FederationResultGrantResponseSchema,
  FederationResultVerifySchema,
  ServerMessageSchema,
} from "@kuintessence/proto";
import {
  FederationError,
  FederationResultCopiedSchema,
  FederationResultCopyBindingSchema,
  FederationResultVerifiedSchema,
  FederationResultVerifyTaskSchema,
} from "@kuintessence/shared/federation";
import { z } from "zod";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { FederationResultImports } from "./result-imports";
import type { FederationResultStorage } from "./result-storage";

/** Authenticated Agent transport; publication is deliberately outside an upload report. */
export class FederationResultTransport {
  constructor(
    private readonly imports: FederationResultImports,
    private readonly storage: FederationResultStorage,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  async dispatch(transferId: string, agentId: string) {
    const channel = this.dispatcher.getChannel(agentId);
    if (
      !channel?.federationResultCopyV1 ||
      !channel.federationResultVerifyV1 ||
      !channel.verifiedCertFingerprint
    )
      return false;
    const allocated = await this.storage.allocate(transferId, agentId);
    try {
      if (!this.dispatcher.isCurrentChannel(agentId, channel))
        throw new FederationError("OPERATION_CONFLICT");
      const taskJson = JSON.stringify(allocated.task);
      if (Buffer.byteLength(taskJson) > 256 * 1024) throw new FederationError("INVALID_MESSAGE");
      channel.push(
        create(ServerMessageSchema, {
          payload: {
            case: "federationResultCopy",
            value: create(FederationResultCopySchema, {
              taskJson,
              leaseExpiresAtUnixMs: BigInt(Date.parse(allocated.leaseExpiresAt)),
            }),
          },
        }),
      );
      return true;
    } catch {
      await this.imports.failed(agentId, allocated.task.generation, "COPY_FAILED");
      return false;
    }
  }

  async grant(agentId: string, request: FederationResultGrantRequest) {
    z.uuid().parse(request.requestId);
    if (request.verificationJson) {
      if (
        request.bindingJson ||
        request.upload ||
        request.partNumber !== undefined ||
        Buffer.byteLength(request.verificationJson) > 16 * 1024
      )
        throw new FederationError("INVALID_MESSAGE");
      const result = await this.storage.verificationGrant(
        agentId,
        FederationResultVerifyTaskSchema.parse(JSON.parse(request.verificationJson)),
      );
      return create(FederationResultGrantResponseSchema, {
        requestId: request.requestId,
        grantJson: JSON.stringify(result.grant),
        leaseExpiresAtUnixMs: BigInt(Date.parse(result.leaseExpiresAt)),
      });
    }
    if (Buffer.byteLength(request.bindingJson) > 8192) throw new FederationError("INVALID_MESSAGE");
    const binding = FederationResultCopyBindingSchema.parse(JSON.parse(request.bindingJson));
    const result = await this.storage.grant(
      agentId,
      binding,
      request.upload ? "upload" : "download",
      request.partNumber,
    );
    return create(FederationResultGrantResponseSchema, {
      requestId: request.requestId,
      grantJson: JSON.stringify(result.grant),
      leaseExpiresAtUnixMs: BigInt(Date.parse(result.leaseExpiresAt)),
    });
  }

  async report(agentId: string, report: FederationResultCopyReport) {
    z.uuid().parse(report.generation);
    if (report.failed) {
      if (report.copiedJson || report.verifiedJson) throw new FederationError("INVALID_MESSAGE");
      await this.imports.failed(agentId, report.generation, "COPY_FAILED");
      return;
    }
    if (report.verifiedJson) {
      if (report.copiedJson || Buffer.byteLength(report.verifiedJson) > 16 * 1024)
        throw new FederationError("INVALID_MESSAGE");
      const verified = FederationResultVerifiedSchema.parse(JSON.parse(report.verifiedJson));
      if (verified.binding.generation !== report.generation)
        throw new FederationError("INVALID_MESSAGE");
      await this.storage.verified(agentId, verified);
      return;
    }
    if (Buffer.byteLength(report.copiedJson) > 4 * 1024 * 1024)
      throw new FederationError("INVALID_MESSAGE");
    const copied = FederationResultCopiedSchema.parse(JSON.parse(report.copiedJson));
    if (copied.binding.generation !== report.generation)
      throw new FederationError("INVALID_MESSAGE");
    const channel = this.dispatcher.getChannel(agentId);
    const state = await this.imports.copied(agentId, copied);
    if (state.state === "verified") return;
    const verification =
      state.state === "verifying"
        ? await this.imports.verificationTask(agentId, report.generation)
        : await this.storage.assemble(agentId, report.generation);
    if (
      !channel?.federationResultCopyV1 ||
      !channel.federationResultVerifyV1 ||
      !channel.verifiedCertFingerprint ||
      !this.dispatcher.isCurrentChannel(agentId, channel)
    )
      throw new FederationError("OPERATION_CONFLICT");
    channel.push(
      create(ServerMessageSchema, {
        payload: {
          case: "federationResultVerify",
          value: create(FederationResultVerifySchema, {
            taskJson: JSON.stringify(verification.task),
            leaseExpiresAtUnixMs: BigInt(Date.parse(verification.leaseExpiresAt)),
          }),
        },
      }),
    );
  }
}
