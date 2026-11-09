import { create } from "@bufbuild/protobuf";
import { FederationMediaUploadSchema, ServerMessageSchema } from "@kuintessence/proto";
import { createLogger } from "@kuintessence/shared";
import {
  FederationError,
  type FederationMediaUploadTask,
  FederationMediaUploadTaskSchema,
} from "@kuintessence/shared/federation";
import type { AgentDispatcher } from "../grpc/dispatcher";
import type { FederationInputStorage } from "./input-storage";
import type { FederationInputTransfers } from "./input-transfers";
import type { FederationMediaImportOperations } from "./media-import-operations";
import type { FederationResultImports } from "./result-imports";
import type { FederationResultStorage } from "./result-storage";

type Kind = "task-input" | "task-result";
type Candidate = Awaited<ReturnType<FederationMediaImportOperations["pendingUploads"]>>[number];
const logger = createLogger("federation-media-upload");

/** Private imports feed the original durable attempts, verification and publication workers. */
export class FederationMediaUploadTransport {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private stopping = false;
  private first: Kind = "task-input";
  constructor(
    private readonly operations: FederationMediaImportOperations,
    private readonly dispatcher: AgentDispatcher,
    private readonly input?: {
      storage: FederationInputStorage;
      transfers: FederationInputTransfers;
    },
    private readonly result?: {
      storage: FederationResultStorage;
      imports: FederationResultImports;
    },
  ) {}
  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref();
    void this.tick();
  }
  tick() {
    if (this.running) return this.running;
    this.running = this.scan()
      .catch(() => logger.warn("Task media upload scan deferred"))
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private eligible(kind: Kind, agentId: string) {
    const channel = this.dispatcher.getChannel(agentId);
    return channel?.federationMediaImportV1 &&
      channel.federationMediaUploadV1 &&
      channel.verifiedCertFingerprint &&
      (kind === "task-input"
        ? this.input && channel.federationInputCopyV1 && channel.federationInputVerifyV1
        : this.result && channel.federationResultCopyV1 && channel.federationResultVerifyV1)
      ? channel
      : undefined;
  }
  private async scan() {
    const kinds: Kind[] = [this.first, this.first === "task-input" ? "task-result" : "task-input"];
    this.first = this.first === "task-input" ? "task-result" : "task-input";
    const used = new Set<string>();
    for (const kind of kinds) {
      if (this.stopping) return;
      const agents = this.dispatcher
        .onlineAgentIds()
        .filter((id) => !used.has(id) && this.eligible(kind, id));
      for (const next of await this.operations.pendingUploads(kind, agents)) {
        if (this.stopping || used.size >= 4) return;
        if (used.has(next.agentId)) continue;
        used.add(next.agentId);
        try {
          await this.dispatch(kind, next);
        } catch (error) {
          const code = error instanceof FederationError ? error.code : "MEDIA_UPLOAD_FAILED";
          logger.warn({ transferId: next.transferId, code }, "Task media upload deferred");
        }
        await this.operations.deferUpload(next.authorizationId);
      }
    }
  }
  async dispatch(kind: Kind, next: Candidate) {
    const { agentId } = next;
    const channel = this.eligible(kind, agentId);
    if (!channel) return false;
    const prepared = await this.operations.uploadTask(agentId, next.authorizationId, {
      kind,
      transferId: next.transferId,
    });
    if (prepared.claimId !== next.claimId) throw new FederationError("OPERATION_CONFLICT");
    await this.operations.uploadForImport({
      kind,
      importId: next.importId,
      claimId: next.claimId,
      agentId,
      refresh: true,
    });
    if (!this.dispatcher.isCurrentChannel(agentId, channel)) return false;
    let generation: string | undefined;
    try {
      let target: FederationMediaUploadTask["target"];
      let leaseExpiresAt: string;
      if (kind === "task-input" && this.input) {
        const allocated = await this.input.storage.allocate(next.transferId, agentId, next.claimId);
        generation = allocated.task.binding.generation;
        target = { kind, ...allocated.task };
        leaseExpiresAt = allocated.leaseExpiresAt;
      } else if (kind === "task-result" && this.result) {
        const allocated = await this.result.storage.allocate(
          next.transferId,
          agentId,
          next.claimId,
        );
        generation = allocated.task.generation;
        target = {
          kind,
          binding: allocated.binding,
          availableUntil: allocated.task.report.manifest.availableUntil,
        };
        leaseExpiresAt = allocated.leaseExpiresAt;
      } else throw new FederationError("POLICY_DENIED");
      const task = FederationMediaUploadTaskSchema.parse({
        media: prepared.task,
        memberIndex: prepared.memberIndex,
        target,
      });
      const taskJson = JSON.stringify(task);
      if (Buffer.byteLength(taskJson) > 512 * 1024) throw new FederationError("INVALID_MESSAGE");
      if (!this.dispatcher.isCurrentChannel(agentId, channel))
        throw new FederationError("OPERATION_CONFLICT");
      channel.push(
        create(ServerMessageSchema, {
          payload: {
            case: "federationMediaUpload",
            value: create(FederationMediaUploadSchema, {
              taskJson,
              leaseExpiresAtUnixMs: BigInt(Date.parse(leaseExpiresAt)),
            }),
          },
        }),
      );
      return true;
    } catch (error) {
      if (generation) {
        if (kind === "task-input") await this.input?.transfers.failed(agentId, generation);
        else await this.result?.imports.failed(agentId, generation, "COPY_FAILED");
      }
      throw error;
    }
  }
  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
