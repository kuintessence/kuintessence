import { create } from "@bufbuild/protobuf";
import {
  type FederationMediaExportLeaseRequest,
  FederationMediaExportLeaseResponseSchema,
  type FederationMediaExportReport,
  FederationMediaExportSchema,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { z } from "zod";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { FederationMediaExportOperations } from "./media-export-operations";

const logger = createLogger("federation-media-export");
export class FederationMediaExportTransport {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly operations: FederationMediaExportOperations,
    private readonly dispatcher: AgentDispatcher,
  ) {}
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), 30_000);
    this.timer.unref();
    void this.tick();
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.scan()
      .catch(() => logger.warn("Media export scan deferred"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async scan() {
    const eligible = this.dispatcher.onlineAgentIds().filter((id) => {
      const channel = this.dispatcher.getChannel(id);
      return channel?.federationMediaExportV1 && channel.verifiedCertFingerprint;
    });
    const used = new Set<string>();
    for (const row of await this.operations.pending(eligible)) {
      if (this.stopping) return;
      const agentId = row.source.agentId;
      if (used.has(agentId)) continue;
      used.add(agentId);
      try {
        await this.dispatch(agentId, row.packageId);
      } catch {
        logger.warn({ packageId: row.packageId }, "Media export awaiting current authorization");
      }
      await this.operations.defer(row.packageId);
    }
  }
  async dispatch(agentId: string, packageId: string) {
    const channel = this.dispatcher.getChannel(agentId);
    if (!channel?.federationMediaExportV1 || !channel.verifiedCertFingerprint) return false;
    const prepared = await this.operations.task(agentId, packageId);
    if (!this.dispatcher.isCurrentChannel(agentId, channel)) return false;
    const taskJson = JSON.stringify(prepared.task);
    if (Buffer.byteLength(taskJson) > 512 * 1024) throw new FederationError("INVALID_MESSAGE");
    channel.push(
      create(ServerMessageSchema, {
        payload: {
          case: "federationMediaExport",
          value: create(FederationMediaExportSchema, {
            taskJson,
            leaseExpiresAtUnixMs: BigInt(prepared.expiresAt.getTime()),
          }),
        },
      }),
    );
    return true;
  }
  async grant(agentId: string, request: FederationMediaExportLeaseRequest) {
    z.uuid().parse(request.requestId);
    if (Buffer.byteLength(request.bindingJson) > 8192) throw new FederationError("INVALID_MESSAGE");
    const grant = await this.operations.lease(agentId, JSON.parse(request.bindingJson));
    return create(FederationMediaExportLeaseResponseSchema, {
      requestId: request.requestId,
      grantJson: JSON.stringify(grant),
      leaseExpiresAtUnixMs: BigInt(Date.parse(grant.expiresAt)),
    });
  }
  async report(agentId: string, report: FederationMediaExportReport) {
    if (Buffer.byteLength(report.reportJson) > 8192) throw new FederationError("INVALID_MESSAGE");
    await this.operations.report(agentId, JSON.parse(report.reportJson));
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
