import { create } from "@bufbuild/protobuf";
import {
  FederationMediaImportGrantResponseSchema,
  type FederationMediaImportKeyRequest,
  type FederationMediaImportReport,
  FederationMediaImportSchema,
  ServerMessageSchema,
} from "@kuintessence/proto";
import { createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import { z } from "zod";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { FederationMediaImportOperations } from "./media-import-operations";
import type { FederationMediaReceiptSender } from "./media-receipts";

const logger = createLogger("federation-media-import");
export class FederationMediaImportTransport {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private receiptRunning?: Promise<void>;
  private stopping = false;
  constructor(
    private readonly operations: FederationMediaImportOperations,
    private readonly dispatcher: AgentDispatcher,
    private readonly receipts?: Pick<FederationMediaReceiptSender, "deliverNext">,
  ) {}
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      void this.tick();
      void this.tickReceipts();
    }, 30_000);
    this.timer.unref();
    void this.tick();
    void this.tickReceipts();
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.scan()
      .catch(() => logger.warn("Media import scan deferred"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async scan() {
    const eligible = this.dispatcher.onlineAgentIds().filter((id) => {
      const channel = this.dispatcher.getChannel(id);
      return channel?.federationMediaImportV1 && channel.verifiedCertFingerprint;
    });
    const used = new Set<string>();
    for (const row of await this.operations.pending(eligible)) {
      if (this.stopping) return;
      const agentId = row.agentId;
      if (used.has(agentId)) continue;
      used.add(agentId);
      try {
        await this.dispatch(agentId, row.authorizationId);
      } catch {
        logger.warn(
          { authorizationId: row.authorizationId },
          "Media import awaiting current authorization",
        );
      }
      await this.operations.defer(row.authorizationId);
    }
  }
  // Receipt HTTP retries must not hold the Agent dispatch scan.
  tickReceipts() {
    if (this.receiptRunning) return this.receiptRunning;
    this.receiptRunning = (async () => {
      if (this.receipts)
        for (let i = 0; i < 8 && !this.stopping; i++)
          if (!(await this.receipts.deliverNext())) break;
    })()
      .catch(() => logger.warn("Media receipt scan deferred"))
      .finally(() => {
        this.receiptRunning = undefined;
      });
    return this.receiptRunning;
  }
  async dispatch(agentId: string, authorizationId: string) {
    const channel = this.dispatcher.getChannel(agentId);
    if (!channel?.federationMediaImportV1 || !channel.verifiedCertFingerprint) return false;
    const prepared = await this.operations.task(agentId, authorizationId);
    if (!this.dispatcher.isCurrentChannel(agentId, channel)) return false;
    const taskJson = JSON.stringify(prepared.task);
    if (Buffer.byteLength(taskJson) > 512 * 1024) throw new FederationError("INVALID_MESSAGE");
    channel.push(
      create(ServerMessageSchema, {
        payload: {
          case: "federationMediaImport",
          value: create(FederationMediaImportSchema, {
            taskJson,
            leaseExpiresAtUnixMs: BigInt(prepared.expiresAt.getTime()),
          }),
        },
      }),
    );
    return true;
  }
  async grant(agentId: string, request: FederationMediaImportKeyRequest) {
    z.uuid().parse(request.requestId);
    if (Buffer.byteLength(request.bindingJson) > 8192) throw new FederationError("INVALID_MESSAGE");
    const grant = await this.operations.grant(agentId, JSON.parse(request.bindingJson));
    return create(FederationMediaImportGrantResponseSchema, {
      requestId: request.requestId,
      grantJson: JSON.stringify(grant),
      leaseExpiresAtUnixMs: BigInt(Date.parse(grant.expiresAt)),
    });
  }
  async report(agentId: string, report: FederationMediaImportReport) {
    if (Buffer.byteLength(report.reportJson) > 8192) throw new FederationError("INVALID_MESSAGE");
    await this.operations.report(agentId, JSON.parse(report.reportJson));
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await Promise.all([this.running, this.receiptRunning]);
  }
}
