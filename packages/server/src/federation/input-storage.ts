import { createLogger } from "@kuintessence/shared";
import { FederationError } from "@kuintessence/shared/federation";
import type { MinioBackend } from "../storage/minio-client";
import type { FederationInputTransfers } from "./input-transfers";

const logger = createLogger("federation-input-storage");
export type FederationInputStorageBackend = Pick<
  MinioBackend,
  "createMultipartUpload" | "cleanupFederationInput"
>;

/** Storage creation and deletion are fenced by durable attempts, never performed under DB locks. */
export class FederationInputStorage {
  constructor(
    private readonly transfers: FederationInputTransfers,
    private readonly storage: FederationInputStorageBackend,
    private readonly timeoutMs = 10_000,
  ) {
    if (!storage.cleanupFederationInput) throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
  }

  async allocate(transferId: string, agentId: string) {
    const started = await this.transfers.begin(transferId, agentId);
    const generation = started.attempt.generation;
    try {
      const permit = await this.transfers.preparing(agentId, generation);
      const allocated = this.storage
        .createMultipartUpload(permit.storageKey, "application/octet-stream")
        .then(({ uploadId }) => this.transfers.allocated(generation, uploadId));
      if (!(await this.bounded(allocated))) throw new FederationError("OPERATION_CONFLICT");
      const current = await this.transfers.assertCopyLease(agentId, started.task.binding);
      return { task: started.task, leaseExpiresAt: current.leaseUntil.toISOString() };
    } catch (error) {
      await this.transfers.failed(agentId, generation);
      if (error instanceof FederationError) throw error;
      throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
    }
  }

  async cleanup(limit = 8) {
    await this.transfers.expire(limit);
    let cleaned = 0;
    for (const candidate of await this.transfers.cleanupCandidates(limit)) {
      try {
        const context = await this.transfers.beginCleanup(candidate.generation);
        if (context.allocationStarted) {
          const purge = this.storage.cleanupFederationInput;
          if (!purge) throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
          await this.bounded(purge.call(this.storage, context.storageKey));
        }
        await this.transfers.storageCleaned(candidate.generation, context.token);
        cleaned++;
      } catch {
        logger.warn({ generation: candidate.generation }, "Input storage cleanup remains pending");
      }
    }
    return cleaned;
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE")),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
