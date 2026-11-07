import { createLogger } from "@kuintessence/shared";
import {
  FederationDataOriginSchema,
  FederationDownloadUrlSchema,
  FederationError,
  type FederationInputCopyBinding,
  FederationInputCopyBindingSchema,
  type FederationInputVerified,
  type FederationInputVerifyTask,
  FederationInputVerifyTaskSchema,
} from "@kuintessence/shared/federation";
import type { MinioBackend } from "../storage/minio-client";
import { signedDownloadExpiry } from "./download-credential";
import type { FederationInputReader } from "./input-reader";
import type { FederationInputTransfers } from "./input-transfers";

const logger = createLogger("federation-input-storage");
export type FederationInputStorageBackend = Pick<
  MinioBackend,
  | "createMultipartUpload"
  | "cleanupFederationInput"
  | "findFederationInputUpload"
  | "presignUploadPart"
  | "completeMultipartUpload"
  | "head"
  | "presignDownload"
>;

interface InputGrantOptions {
  reader: FederationInputReader;
  sourceOrigins: readonly string[];
  destinationOrigins: readonly string[];
}
export interface FederationInputStorageOptions {
  timeoutMs?: number;
  clock?: () => Date;
  grants?: InputGrantOptions;
}

/** Storage creation and deletion are fenced by durable attempts, never performed under DB locks. */
export class FederationInputStorage {
  private readonly clock: () => Date;
  private readonly sourceOrigins: string[];
  private readonly destinationOrigins: Set<string>;
  constructor(
    private readonly transfers: FederationInputTransfers,
    private readonly storage: FederationInputStorageBackend,
    private readonly options: FederationInputStorageOptions = {},
  ) {
    if (!storage.cleanupFederationInput) throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
    this.clock = options.clock ?? (() => new Date());
    this.sourceOrigins = (options.grants?.sourceOrigins ?? []).map(
      (v) => new URL(FederationDataOriginSchema.parse(v)).origin,
    );
    this.destinationOrigins = new Set(
      (options.grants?.destinationOrigins ?? []).map(
        (v) => new URL(FederationDataOriginSchema.parse(v)).origin,
      ),
    );
    if (options.grants && (!this.sourceOrigins.length || !this.destinationOrigins.size))
      throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
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

  async grant(
    agentId: string,
    input: FederationInputCopyBinding,
    direction: "download" | "upload",
    partNumber?: number,
  ) {
    if (!this.options.grants) throw new FederationError("POLICY_DENIED");
    const parsed = FederationInputCopyBindingSchema.safeParse(input);
    if (
      !parsed.success ||
      (direction !== "download" && direction !== "upload") ||
      (direction === "download" && partNumber !== undefined) ||
      (direction === "upload" &&
        (!Number.isSafeInteger(partNumber) || !partNumber || partNumber < 1 || partNumber > 10_000))
    )
      throw new FederationError("INVALID_MESSAGE");
    const binding = parsed.data;
    const before = await this.transfers.assertCopyLease(agentId, binding);
    if (
      direction === "upload" &&
      (partNumber as number) > Math.max(1, Math.ceil(binding.sizeBytes / before.partSize))
    )
      throw new FederationError("INVALID_MESSAGE");
    const renewed = await this.transfers.assertCopyLease(agentId, binding, true);
    try {
      if (direction === "download")
        return await this.bounded(
          this.options.grants.reader.downloadGrant(agentId, binding, this.sourceOrigins),
        );
      return await this.uploadGrant(agentId, binding, partNumber as number, renewed);
    } catch (error) {
      if (error instanceof FederationError) throw error;
      throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
    }
  }

  private async uploadGrant(
    agentId: string,
    binding: FederationInputCopyBinding,
    partNumber: number,
    before: Awaited<ReturnType<FederationInputTransfers["assertCopyLease"]>>,
  ) {
    if (!before.uploadId) throw new FederationError("OPERATION_CONFLICT");
    const deadline = Math.min(this.clock().getTime() + 30_000, before.leaseUntil.getTime());
    const seconds = Math.floor((deadline - this.clock().getTime()) / 1000);
    if (seconds < 1) throw new FederationError("AUTHORIZATION_EXPIRED");
    const url = await this.bounded(
      this.storage.presignUploadPart(before.storageKey, before.uploadId, partNumber, seconds),
    );
    if (!FederationDownloadUrlSchema.safeParse(url).success)
      throw new FederationError("INVALID_MESSAGE");
    const parsed = new URL(url);
    if (!this.destinationOrigins.has(parsed.origin)) throw new FederationError("POLICY_DENIED");
    if (
      parsed.searchParams.get("uploadId") !== before.uploadId ||
      parsed.searchParams.getAll("uploadId").length !== 1 ||
      parsed.searchParams.get("partNumber") !== String(partNumber) ||
      parsed.searchParams.getAll("partNumber").length !== 1
    )
      throw new FederationError("INVALID_MESSAGE");
    const expiresAt = signedDownloadExpiry(url, this.clock().getTime(), deadline);
    const after = await this.transfers.assertCopyLease(agentId, binding);
    if (
      after.storageKey !== before.storageKey ||
      after.uploadId !== before.uploadId ||
      Date.parse(expiresAt) <= this.clock().getTime() ||
      Date.parse(expiresAt) > after.leaseUntil.getTime()
    )
      throw new FederationError("OPERATION_CONFLICT");
    return {
      grant: { binding, direction: "upload" as const, partNumber, url, expiresAt },
      leaseExpiresAt: before.leaseUntil.toISOString(),
    };
  }

  async assemble(agentId: string, generation: string) {
    try {
      const before = await this.transfers.assembling(agentId, generation);
      if (before.attempt.state === "verifying")
        return this.transfers.assembled(agentId, generation);
      if (!before.attempt.uploadId || !before.attempt.parts)
        throw new FederationError("OPERATION_CONFLICT");
      if (await this.transfers.startCompletion(agentId, generation)) {
        const completing = this.storage
          .completeMultipartUpload(
            before.attempt.storageKey,
            before.attempt.uploadId,
            before.attempt.parts,
          )
          .then(async (object) => {
            // Keep a late successful completion even after timeout/cancellation; it still needs cleanup.
            await this.transfers.completed(generation, this.objectPin(object));
          });
        await this.bounded(completing);
      }
      const current = await this.transfers.assembling(agentId, generation);
      const stat = await this.bounded(
        this.storage.head(
          current.attempt.storageKey,
          current.attempt.destinationVersionId ?? undefined,
        ),
      );
      if (!stat) throw new FederationError("DATA_WAITING");
      await this.transfers.completed(generation, this.objectPin(stat));
      if (stat.size !== current.binding.sizeBytes || !stat.versionId || stat.versionId === "null") {
        await this.transfers.failed(agentId, generation);
        throw new FederationError("POLICY_DENIED");
      }
      return await this.transfers.assembled(agentId, generation);
    } catch (error) {
      if (error instanceof FederationError) throw error;
      throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
    }
  }

  async verificationGrant(agentId: string, input: FederationInputVerifyTask) {
    if (!this.options.grants) throw new FederationError("POLICY_DENIED");
    const task = FederationInputVerifyTaskSchema.parse(input);
    try {
      const before = await this.transfers.verification(agentId, task, true);
      await this.assertObject(before.storageKey, task);
      const deadline = Math.min(this.clock().getTime() + 30_000, before.leaseUntil.getTime());
      const seconds = Math.floor((deadline - this.clock().getTime()) / 1000);
      if (seconds < 1) throw new FederationError("AUTHORIZATION_EXPIRED");
      const url = await this.bounded(
        this.storage.presignDownload(before.storageKey, seconds, undefined, task.object.versionId),
      );
      if (!FederationDownloadUrlSchema.safeParse(url).success)
        throw new FederationError("INVALID_MESSAGE");
      const parsed = new URL(url);
      if (!this.destinationOrigins.has(parsed.origin)) throw new FederationError("POLICY_DENIED");
      if (
        parsed.searchParams.get("versionId") !== task.object.versionId ||
        parsed.searchParams.getAll("versionId").length !== 1
      )
        throw new FederationError("INVALID_MESSAGE");
      const expiresAt = signedDownloadExpiry(url, this.clock().getTime(), deadline);
      const after = await this.transfers.verification(agentId, task);
      if (
        after.state !== "verifying" ||
        after.storageKey !== before.storageKey ||
        Date.parse(expiresAt) <= this.clock().getTime() ||
        Date.parse(expiresAt) > after.leaseUntil.getTime()
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        grant: { ...task, direction: "verify" as const, url, expiresAt },
        leaseExpiresAt: after.leaseUntil.toISOString(),
      };
    } catch (error) {
      if (error instanceof FederationError) throw error;
      throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
    }
  }

  async verified(agentId: string, receipt: FederationInputVerified) {
    try {
      const task = FederationInputVerifyTaskSchema.parse({
        binding: receipt.binding,
        object: receipt.object,
        availableUntil: receipt.availableUntil,
      });
      const before = await this.transfers.verification(agentId, task);
      if (before.state !== "verified") await this.assertObject(before.storageKey, task);
      await this.transfers.verified(agentId, receipt);
    } catch (error) {
      if (error instanceof FederationError) throw error;
      throw new Error("FEDERATION_INPUT_STORAGE_UNAVAILABLE");
    }
  }

  private objectPin(object: { etag: string; versionId?: string }) {
    return {
      etag: object.etag,
      versionId: object.versionId && object.versionId !== "null" ? object.versionId : null,
    };
  }

  private async assertObject(key: string, task: FederationInputVerifyTask) {
    const stat = await this.bounded(this.storage.head(key, task.object.versionId));
    if (
      !stat ||
      stat.size !== task.binding.sizeBytes ||
      stat.versionId !== task.object.versionId ||
      stat.etag !== task.object.etag
    )
      throw new FederationError("OPERATION_CONFLICT");
  }

  async cleanup(limit = 8) {
    await this.transfers.expire(limit);
    const findUpload = this.storage.findFederationInputUpload;
    if (findUpload)
      for (const { generation } of await this.transfers.allocationCandidates(limit)) {
        try {
          const pending = await this.transfers.allocationPending(generation);
          if (!pending) continue;
          const uploadId = await this.bounded(findUpload.call(this.storage, pending.storageKey));
          if (uploadId) await this.transfers.allocated(generation, uploadId);
        } catch {
          logger.warn(
            { generation },
            "Input allocation remains unconfirmed; storage quota is retained",
          );
        }
      }
    for (const { generation } of await this.transfers.completionCandidates(limit)) {
      try {
        const pending = await this.transfers.completionPending(generation);
        if (!pending) continue;
        const object = await this.bounded(this.storage.head(pending.storageKey));
        if (object) await this.transfers.completed(generation, this.objectPin(object));
      } catch {
        logger.warn(
          { generation },
          "Input completion remains unconfirmed; storage quota is retained",
        );
      }
    }
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
            this.options.timeoutMs ?? 10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
