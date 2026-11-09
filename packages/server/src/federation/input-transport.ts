import { create } from "@bufbuild/protobuf";
import {
  type FederationInputCopyReport,
  FederationInputCopySchema,
  type FederationInputGrantRequest,
  FederationInputGrantResponseSchema,
  FederationInputVerifySchema,
  ServerMessageSchema,
} from "@kuintessence/proto";
import {
  FederationError,
  FederationInputCopiedSchema,
  FederationInputCopyBindingSchema,
  FederationInputVerifiedSchema,
  FederationInputVerifyTaskSchema,
} from "@kuintessence/shared/federation";
import { z } from "zod";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { FederationInputStorage } from "./input-storage";
import type { FederationInputTransfers } from "./input-transfers";

/** Authenticated Agent transport; publication is deliberately outside an upload report. */
export class FederationInputTransport {
  constructor(
    private readonly transfers: FederationInputTransfers,
    private readonly storage: FederationInputStorage,
    private readonly dispatcher: AgentDispatcher,
  ) {}

  get canCopy() {
    return this.storage.canCopy;
  }

  eligibleAgentIds() {
    if (!this.canCopy) return [];
    return this.dispatcher.onlineAgentIds().filter((agentId) => {
      const channel = this.dispatcher.getChannel(agentId);
      return (
        channel?.federationInputCopyV1 &&
        channel.federationInputVerifyV1 &&
        channel.verifiedCertFingerprint
      );
    });
  }

  async dispatch(transferId: string, agentId: string) {
    if (!this.canCopy) return false;
    const channel = this.dispatcher.getChannel(agentId);
    if (
      !channel?.federationInputCopyV1 ||
      !channel.federationInputVerifyV1 ||
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
            case: "federationInputCopy",
            value: create(FederationInputCopySchema, {
              taskJson,
              leaseExpiresAtUnixMs: BigInt(Date.parse(allocated.leaseExpiresAt)),
            }),
          },
        }),
      );
      return true;
    } catch {
      await this.transfers.failed(agentId, allocated.task.binding.generation);
      return false;
    }
  }

  async grant(agentId: string, request: FederationInputGrantRequest) {
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
        FederationInputVerifyTaskSchema.parse(JSON.parse(request.verificationJson)),
      );
      return create(FederationInputGrantResponseSchema, {
        requestId: request.requestId,
        grantJson: JSON.stringify(result.grant),
        leaseExpiresAtUnixMs: BigInt(Date.parse(result.leaseExpiresAt)),
      });
    }
    if (Buffer.byteLength(request.bindingJson) > 8192) throw new FederationError("INVALID_MESSAGE");
    const binding = FederationInputCopyBindingSchema.parse(JSON.parse(request.bindingJson));
    const result = await this.storage.grant(
      agentId,
      binding,
      request.upload ? "upload" : "download",
      request.partNumber,
    );
    return create(FederationInputGrantResponseSchema, {
      requestId: request.requestId,
      grantJson: JSON.stringify(result.grant),
      leaseExpiresAtUnixMs: BigInt(Date.parse(result.leaseExpiresAt)),
    });
  }

  async report(agentId: string, report: FederationInputCopyReport) {
    z.uuid().parse(report.generation);
    if (report.failed) {
      if (report.copiedJson || report.verifiedJson) throw new FederationError("INVALID_MESSAGE");
      await this.transfers.failed(agentId, report.generation);
      return;
    }
    if (report.verifiedJson) {
      if (report.copiedJson || Buffer.byteLength(report.verifiedJson) > 16 * 1024)
        throw new FederationError("INVALID_MESSAGE");
      const verified = FederationInputVerifiedSchema.parse(JSON.parse(report.verifiedJson));
      if (verified.binding.generation !== report.generation)
        throw new FederationError("INVALID_MESSAGE");
      await this.storage.verified(agentId, verified);
      return;
    }
    if (Buffer.byteLength(report.copiedJson) > 4 * 1024 * 1024)
      throw new FederationError("INVALID_MESSAGE");
    const copied = FederationInputCopiedSchema.parse(JSON.parse(report.copiedJson));
    if (copied.binding.generation !== report.generation)
      throw new FederationError("INVALID_MESSAGE");
    const channel = this.dispatcher.getChannel(agentId);
    const state = await this.transfers.copied(agentId, copied);
    if (["verified", "available"].includes(state.state)) return;
    const verification = await this.storage.assemble(agentId, report.generation);
    if (
      !channel?.federationInputVerifyV1 ||
      !channel.verifiedCertFingerprint ||
      !this.dispatcher.isCurrentChannel(agentId, channel)
    )
      throw new FederationError("OPERATION_CONFLICT");
    channel.push(
      create(ServerMessageSchema, {
        payload: {
          case: "federationInputVerify",
          value: create(FederationInputVerifySchema, {
            taskJson: JSON.stringify(verification.task),
            leaseExpiresAtUnixMs: BigInt(Date.parse(verification.leaseExpiresAt)),
          }),
        },
      }),
    );
  }
}
