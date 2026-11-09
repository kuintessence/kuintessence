import {
  auditLog,
  federationInputAttempts,
  federationInputImports,
  federationInputTransfers,
  netdriveFiles,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import { FederationError } from "@kuintessence/shared/federation";
import { and, asc, eq, gt, inArray, isNull, lte, ne, notExists } from "drizzle-orm";
import { lockCloudWrites, StorageQuotaService } from "../services/storage-quota";
import type { MinioBackend } from "../storage/minio-client";
import { federationMaterialDigest } from "./assets";
import type { FederationInputImports } from "./input-imports";
import type { FederationMaterialExchange } from "./material-exchange";
import type { FederationMediaImportOperations } from "./media-import-operations";
import type { FederationPreparationService } from "./preparation";

type Inventory = typeof federationInputImports.$inferSelect;

/** Storage checks and fresh source authorization precede one atomic receiver-local publication. */
export class FederationInputPublication {
  constructor(
    private readonly db: PgDb,
    private readonly preparation: FederationPreparationService,
    private readonly imports: FederationInputImports,
    private readonly exchange: FederationMaterialExchange,
    private readonly storage: Pick<MinioBackend, "head">,
    private readonly clock: () => Date = () => new Date(),
    private readonly media?: FederationMediaImportOperations,
  ) {}

  async publish(reservationId: string) {
    const scope = await this.preparation.materialScope(reservationId);
    const [selected] = await this.db
      .select()
      .from(federationInputImports)
      .where(
        and(
          eq(federationInputImports.reservationId, reservationId),
          eq(federationInputImports.localSiteId, this.preparation.localSiteId),
        ),
      );
    if (!selected) throw new FederationError("DATA_WAITING");
    const media =
      selected.delivery === "media" && selected.state !== "available"
        ? await this.mediaAuthorization(selected.id)
        : undefined;
    const snapshot = await this.db.transaction(async (tx) => {
      const permit = await media?.(tx);
      const inventory = await this.imports.lock(tx, scope);
      if (inventory.state === "available") return { inventory, files: null };
      return {
        inventory,
        files: await this.files(tx, inventory, permit?.claimId),
        claimId: permit?.claimId,
      };
    });
    if (snapshot.files === null) return this.summary(snapshot.inventory);
    for (const file of snapshot.files) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const stat = await Promise.race([
          this.storage.head(file.storageKey, file.versionId),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("INPUT_STORAGE_UNAVAILABLE")), 10_000);
          }),
        ]);
        if (
          !stat ||
          stat.size !== file.size ||
          stat.versionId !== file.versionId ||
          stat.etag !== file.etag
        )
          throw new FederationError("OPERATION_CONFLICT");
      } catch (error) {
        if (error instanceof FederationError) throw error;
        throw new Error("INPUT_STORAGE_UNAVAILABLE");
      } finally {
        clearTimeout(timer);
      }
    }
    const received = await this.exchange.inputFiles(reservationId);
    const finalMedia = media
      ? await this.mediaAuthorization(snapshot.inventory.id, snapshot.claimId)
      : undefined;
    return this.db.transaction(async (tx) => {
      const permit = await finalMedia?.(tx);
      await received.authorize(tx);
      const inventory = await this.imports.lock(tx, received.scope);
      if (inventory.state === "available") return this.summary(inventory);
      if (
        inventory.id !== snapshot.inventory.id ||
        inventory.manifestDigest !== snapshot.inventory.manifestDigest ||
        federationMaterialDigest(received.manifest) !== inventory.manifestDigest
      )
        throw new FederationError("OPERATION_CONFLICT");
      const files = await this.files(tx, inventory, permit?.claimId);
      if (federationMaterialDigest(files) !== federationMaterialDigest(snapshot.files))
        throw new FederationError("OPERATION_CONFLICT");
      await lockCloudWrites(tx, inventory.ownerId);
      if (files.length) {
        const [collision] = await tx
          .select({ id: netdriveFiles.id })
          .from(netdriveFiles)
          .where(
            and(
              eq(netdriveFiles.ownerId, inventory.ownerId),
              isNull(netdriveFiles.deletedAt),
              inArray(
                netdriveFiles.path,
                files.map((file) => file.path),
              ),
            ),
          )
          .limit(1);
        if (collision) throw new FederationError("OPERATION_CONFLICT");
      }
      await tx
        .update(federationInputImports)
        .set({ reservedBytes: 0 })
        .where(eq(federationInputImports.id, inventory.id));
      await new StorageQuotaService(tx, this.clock).assertCloudWritesAllowed(
        inventory.ownerId,
        files,
      );
      if (files.length) {
        await tx.insert(netdriveFiles).values(
          files.map((file) => ({
            id: file.id,
            ownerId: inventory.ownerId,
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            storageKey: file.storageKey,
            storageVersionId: file.versionId,
            etag: file.etag,
            mtime: this.clock(),
            createdAt: this.clock(),
          })),
        );
        await tx
          .update(federationInputAttempts)
          .set({ state: "available", updatedAt: this.clock() })
          .where(
            inArray(
              federationInputAttempts.generation,
              files.map((file) => file.generation),
            ),
          );
        await tx
          .update(federationInputTransfers)
          .set({ state: "available", updatedAt: this.clock() })
          .where(eq(federationInputTransfers.importId, inventory.id));
      }
      // Policy rows remain locked; do not let storage/quota work outlive either signed window.
      await received.authorize(tx);
      if (permit && this.clock().getTime() >= permit.authorizedUntil)
        throw new FederationError("AUTHORIZATION_EXPIRED");
      const [published] = await tx
        .update(federationInputImports)
        .set({
          state: "available",
          publishedAt: this.clock(),
          lastError: null,
          updatedAt: this.clock(),
        })
        .where(eq(federationInputImports.id, inventory.id))
        .returning();
      if (!published) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: inventory.ownerId,
        orgId: inventory.localOrgId,
        action: "federation.input.published",
        target: inventory.id,
        diff: {
          after: {
            manifestDigest: inventory.manifestDigest,
            files: files.length,
            bytes: files.reduce((sum, file) => sum + file.size, 0),
          },
        },
      });
      return this.summary(published);
    });
  }

  private summary(inventory: Inventory) {
    return {
      importId: inventory.id,
      reservationId: inventory.reservationId,
      state: inventory.state,
      manifestDigest: inventory.manifestDigest,
    };
  }

  private async mediaAuthorization(importId: string, claimId?: string) {
    if (!this.media) throw new FederationError("POLICY_DENIED");
    return this.media.uploadForImport({ kind: "task-input", importId, claimId, refresh: true });
  }

  private async files(tx: PgTransaction, inventory: Inventory, claimId?: string) {
    if ((inventory.delivery === "media") !== !!claimId)
      throw new FederationError("OPERATION_CONFLICT");
    const members = await tx
      .select()
      .from(federationInputTransfers)
      .where(eq(federationInputTransfers.importId, inventory.id))
      .orderBy(asc(federationInputTransfers.descriptor), asc(federationInputTransfers.path));
    const attempts = members.length
      ? await tx
          .select()
          .from(federationInputAttempts)
          .where(
            and(
              inArray(
                federationInputAttempts.transferId,
                members.map((member) => member.id),
              ),
              eq(federationInputAttempts.state, "verified"),
            ),
          )
      : [];
    return members.map((member) => {
      const attempt = attempts.find((attempt) => attempt.transferId === member.id);
      if (member.state !== "verified" || !attempt?.verifiedAt)
        throw new FederationError("DATA_WAITING");
      if (
        attempt.mediaClaimId !== (claimId ?? null) ||
        !attempt.destinationVersionId ||
        attempt.destinationVersionId === "null" ||
        !attempt.destinationEtag ||
        attempt.storageKey !== `federation-inputs/${inventory.id}/${attempt.generation}`
      )
        throw new FederationError("OPERATION_CONFLICT");
      return {
        id: member.id,
        descriptor: member.descriptor,
        generation: attempt.generation,
        path: `federation-inputs/${inventory.id}/${member.descriptor}/${member.path}`,
        size: member.sizeBytes,
        sha256: member.sha256,
        storageKey: attempt.storageKey,
        versionId: attempt.destinationVersionId,
        etag: attempt.destinationEtag,
      };
    });
  }

  async next() {
    return this.db.transaction(async (tx) => {
      const [inventory] = await tx
        .select()
        .from(federationInputImports)
        .where(
          and(
            eq(federationInputImports.localSiteId, this.preparation.localSiteId),
            inArray(federationInputImports.state, ["pending", "transferring"]),
            lte(federationInputImports.nextPublishAt, this.clock()),
            gt(federationInputImports.expiresAt, this.clock()),
            notExists(
              tx
                .select({ id: federationInputTransfers.id })
                .from(federationInputTransfers)
                .where(
                  and(
                    eq(federationInputTransfers.importId, federationInputImports.id),
                    ne(federationInputTransfers.state, "verified"),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(federationInputImports.nextPublishAt), asc(federationInputImports.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!inventory) return;
      await tx
        .update(federationInputImports)
        .set({ nextPublishAt: new Date(this.clock().getTime() + 30_000) })
        .where(eq(federationInputImports.id, inventory.id));
      return inventory.reservationId;
    });
  }

  async failed(reservationId: string, code: string) {
    await this.db
      .update(federationInputImports)
      .set({ lastError: code, nextPublishAt: new Date(this.clock().getTime() + 30_000) })
      .where(
        and(
          eq(federationInputImports.reservationId, reservationId),
          eq(federationInputImports.localSiteId, this.preparation.localSiteId),
          inArray(federationInputImports.state, ["pending", "transferring"]),
        ),
      );
  }
}
