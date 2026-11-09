import { createLogger } from "@kuintessence/shared";
import {
  FederationDataOriginSchema,
  FederationError,
  type FederationResultCopyBinding,
  FederationResultCopyBindingSchema,
  type FederationResultVerified,
  type FederationResultVerifyTask,
  FederationResultVerifyTaskSchema,
} from "@kuintessence/shared/federation";
import type { MinioBackend } from "../storage/minio-client";
import { signedDownloadExpiry } from "./download-credential";
import type { FederationActor } from "./permissions";
import type { FederationResultImports } from "./result-imports";
import type { FederationResultReader } from "./result-reader";

type Storage = Pick<
  MinioBackend,
  | "createMultipartUpload"
  | "presignUploadPart"
  | "cleanupFederationResult"
  | "completeMultipartUpload"
  | "head"
  | "presignDownload"
>;
const logger = createLogger("federation-result-storage");
export interface FederationResultStorageOptions {
  sourceOrigins: readonly string[];
  destinationOrigins: readonly string[];
  clock?: () => Date;
  timeoutMs?: number;
}

/** Storage effects are isolated from DB locks and fenced again before releasing credentials. */
export class FederationResultStorage {
  private readonly sourceOrigins: string[];
  private readonly destinationOrigins: Set<string>;
  private readonly clock: () => Date;
  constructor(
    private readonly imports: FederationResultImports,
    private readonly reader: FederationResultReader,
    private readonly storage: Storage,
    private readonly options: FederationResultStorageOptions,
  ) {
    this.sourceOrigins = options.sourceOrigins.map(
      (value) => new URL(FederationDataOriginSchema.parse(value)).origin,
    );
    this.destinationOrigins = new Set(
      options.destinationOrigins.map(
        (value) => new URL(FederationDataOriginSchema.parse(value)).origin,
      ),
    );
    if (
      !this.sourceOrigins.length ||
      !this.destinationOrigins.size ||
      !storage.cleanupFederationResult
    )
      throw new Error("FEDERATION_RESULT_STORAGE_UNAVAILABLE");
    this.clock = options.clock ?? (() => new Date());
  }

  async allocate(transferId: string, agentId: string, mediaClaimId?: string) {
    const started = await this.imports.begin(transferId, agentId, mediaClaimId);
    const generation = started.attempt.generation;
    try {
      const ready = await this.imports.preparing(agentId, generation);
      const allocated = this.storage
        .createMultipartUpload(ready.attempt.storageKey, "application/octet-stream")
        .then(async ({ uploadId }) => {
          // This continuation still records a late ID after a caller timeout; crash recovery scans the key.
          return this.imports.allocated(generation, uploadId);
        });
      if (!(await this.bounded(allocated))) throw new FederationError("POLICY_DENIED");
      const current = await this.imports.assertCopyLease(agentId, ready.binding);
      return { task: started.task, leaseExpiresAt: current.leaseUntil.toISOString() };
    } catch (error) {
      await this.imports.failed(agentId, generation, "STORAGE_FAILED");
      if (error instanceof FederationError) throw error;
      throw new Error("FEDERATION_RESULT_STORAGE_UNAVAILABLE");
    }
  }

  async grant(
    agentId: string,
    input: FederationResultCopyBinding,
    direction: "download" | "upload",
    partNumber?: number,
  ) {
    const binding = FederationResultCopyBindingSchema.parse(input);
    if (direction !== "download" && direction !== "upload")
      throw new FederationError("INVALID_MESSAGE");
    if (
      (direction === "download" && partNumber !== undefined) ||
      (direction === "upload" &&
        (!Number.isSafeInteger(partNumber) ||
          !partNumber ||
          partNumber < 1 ||
          partNumber > Math.max(1, Math.ceil(binding.sizeBytes / binding.partSize))))
    )
      throw new FederationError("INVALID_MESSAGE");
    await this.imports.assertCopyLease(agentId, binding);
    await this.imports.renew(agentId, binding.generation);
    const before = await this.imports.assertCopyLease(agentId, binding);
    const grant =
      direction === "download"
        ? await this.bounded(this.reader.downloadGrant(before.actor, binding, this.sourceOrigins))
        : await this.uploadGrant(binding, before, partNumber as number);
    const after = await this.imports.assertCopyLease(agentId, binding);
    if (
      after.storageKey !== before.storageKey ||
      after.uploadId !== before.uploadId ||
      Date.parse(grant.expiresAt) <= this.clock().getTime() ||
      Date.parse(grant.expiresAt) > after.leaseUntil.getTime()
    )
      throw new FederationError("OPERATION_CONFLICT");
    return { grant, leaseExpiresAt: after.leaseUntil.toISOString() };
  }

  async assemble(agentId: string, generation: string) {
    try {
      const before = await this.imports.assembling(agentId, generation);
      if (!before.attempt.uploadId || !before.attempt.parts)
        throw new FederationError("OPERATION_CONFLICT");
      // A prior CompleteMultipart response may have been lost. HEAD only selects a verification target.
      let stat = await this.bounded(this.storage.head(before.attempt.storageKey));
      if (!stat) {
        const completed = await this.bounded(
          this.storage.completeMultipartUpload(
            before.attempt.storageKey,
            before.attempt.uploadId,
            before.attempt.parts,
          ),
        );
        stat = await this.bounded(
          this.storage.head(before.attempt.storageKey, completed.versionId),
        );
        if (stat && completed.etag !== stat.etag) throw new FederationError("OPERATION_CONFLICT");
      }
      if (!stat || stat.size !== before.binding.sizeBytes)
        throw new FederationError("INVALID_MESSAGE");
      return await this.imports.assembled(agentId, generation, {
        etag: stat.etag,
        versionId: stat.versionId && stat.versionId !== "null" ? stat.versionId : null,
      });
    } catch (error) {
      // Concurrent completion may already have advanced this attempt. Expiry retains cleanup responsibility.
      if (error instanceof FederationError) throw error;
      throw new Error("FEDERATION_RESULT_STORAGE_UNAVAILABLE");
    }
  }

  async verificationGrant(agentId: string, input: FederationResultVerifyTask) {
    const task = FederationResultVerifyTaskSchema.parse(input);
    const before = await this.imports.verification(agentId, task, true);
    await this.assertObject(before.storageKey, task);
    const deadline = Math.min(this.clock().getTime() + 30_000, before.leaseUntil.getTime());
    const seconds = Math.floor((deadline - this.clock().getTime()) / 1000);
    if (seconds < 1) throw new FederationError("AUTHORIZATION_EXPIRED");
    const url = await this.bounded(
      this.storage.presignDownload(
        before.storageKey,
        seconds,
        undefined,
        task.object.versionId ?? undefined,
      ),
    );
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      !this.destinationOrigins.has(parsed.origin)
    )
      throw new FederationError("POLICY_DENIED");
    if (
      (task.object.versionId !== null &&
        (parsed.searchParams.get("versionId") !== task.object.versionId ||
          parsed.searchParams.getAll("versionId").length !== 1)) ||
      (task.object.versionId === null && parsed.searchParams.has("versionId"))
    )
      throw new FederationError("INVALID_MESSAGE");
    const expiresAt = signedDownloadExpiry(url, this.clock().getTime(), deadline);
    const after = await this.imports.verification(agentId, task);
    if (
      after.state !== "verifying" ||
      before.storageKey !== after.storageKey ||
      Date.parse(expiresAt) <= this.clock().getTime() ||
      Date.parse(expiresAt) > after.leaseUntil.getTime()
    )
      throw new FederationError("OPERATION_CONFLICT");
    return {
      grant: { ...task, direction: "verify" as const, url, expiresAt },
      leaseExpiresAt: after.leaseUntil.toISOString(),
    };
  }

  async verified(agentId: string, receipt: FederationResultVerified) {
    const before = await this.imports.verification(agentId, {
      binding: receipt.binding,
      object: receipt.object,
      availableUntil: receipt.availableUntil,
    });
    if (before.state !== "verified") await this.assertObject(before.storageKey, receipt);
    await this.imports.verified(agentId, receipt);
  }

  private async assertObject(key: string, task: FederationResultVerifyTask) {
    const stat = await this.bounded(this.storage.head(key, task.object.versionId ?? undefined));
    if (
      !stat ||
      stat.size !== task.binding.sizeBytes ||
      stat.etag !== task.object.etag ||
      (stat.versionId && stat.versionId !== "null" ? stat.versionId : null) !==
        task.object.versionId
    )
      throw new FederationError("OPERATION_CONFLICT");
  }

  async publish(actor: FederationActor, importId: string) {
    const snapshot = await this.imports.publication(actor, importId);
    if (snapshot.state === "available") return snapshot.summary;
    for (const file of snapshot.files) {
      const stat = await this.bounded(this.storage.head(file.storageKey, file.versionId));
      if (
        !stat ||
        stat.size !== file.size ||
        stat.etag !== file.etag ||
        stat.versionId !== file.versionId
      )
        throw new FederationError("OPERATION_CONFLICT");
    }
    const verified = await this.reader.read(actor, snapshot.operationId);
    return this.imports.publish(actor, importId, snapshot, verified);
  }

  async cleanup(limit = 20) {
    await this.imports.expire(limit);
    let cleaned = 0;
    for (const { generation } of await this.imports.cleanupCandidates(limit)) {
      try {
        const context = await this.imports.beginCleanup(generation);
        const purge = this.storage.cleanupFederationResult;
        if (!purge) throw new Error("FEDERATION_RESULT_STORAGE_UNAVAILABLE");
        await this.bounded(purge.call(this.storage, context.storageKey));
        await this.imports.storageCleaned(generation);
        cleaned++;
      } catch {
        // A failed/unknown delete never becomes a cleaned receipt; retry the retained attempt later.
        logger.warn({ generation }, "Federation result storage cleanup remains pending");
      }
    }
    return cleaned;
  }

  private async uploadGrant(
    binding: FederationResultCopyBinding,
    context: Awaited<ReturnType<FederationResultImports["assertCopyLease"]>>,
    partNumber: number,
  ) {
    if (!context.uploadId) throw new FederationError("OPERATION_CONFLICT");
    const deadline = Math.min(this.clock().getTime() + 30_000, context.leaseUntil.getTime());
    const seconds = Math.floor((deadline - this.clock().getTime()) / 1000);
    if (seconds < 1) throw new FederationError("AUTHORIZATION_EXPIRED");
    const url = await this.bounded(
      this.storage.presignUploadPart(context.storageKey, context.uploadId, partNumber, seconds),
    );
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      !this.destinationOrigins.has(parsed.origin)
    )
      throw new FederationError("POLICY_DENIED");
    if (
      parsed.searchParams.get("uploadId") !== context.uploadId ||
      parsed.searchParams.get("partNumber") !== String(partNumber) ||
      parsed.searchParams.getAll("uploadId").length !== 1 ||
      parsed.searchParams.getAll("partNumber").length !== 1
    )
      throw new FederationError("INVALID_MESSAGE");
    const expiresAt = signedDownloadExpiry(url, this.clock().getTime(), deadline);
    return { binding, direction: "upload" as const, partNumber, url, expiresAt };
  }

  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("FEDERATION_RESULT_STORAGE_UNAVAILABLE")),
            this.options.timeoutMs ?? 10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}
