import {
  auditLog,
  federationMediaExports,
  federationMediaExportOperations as operations,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  FederationDataOriginSchema,
  FederationError,
  FederationMediaExportBindingSchema,
  FederationMediaExportLeaseSchema,
  FederationMediaExportReceiptSchema,
  FederationMediaExportTaskSchema,
  FederationMediaObjectBindingSchema,
  FederationMediaObjectGrantSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { exportSPKI } from "jose";
import { z } from "zod";
import { type FederationDownloadStorage, signedDownloadExpiry } from "./download-credential";
import type { FederationMediaExportService } from "./media-exports";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId } from "./signatures";
import type { TaskMediaReader } from "./task-media-source";
import { FederationTrustRegistry } from "./trust-registry";

export class FederationMediaExportOperations {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly exports: FederationMediaExportService,
    private readonly clock: () => Date = () => new Date(),
    private readonly objectStorage?: () => FederationDownloadStorage | undefined,
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  private condition(packageId: string) {
    return and(eq(operations.localSiteId, this.siteId), eq(operations.packageId, packageId));
  }
  async start(actor: FederationActor, packageId: string) {
    z.uuid().parse(packageId);
    const reader = await this.exports.reader(packageId, { actor });
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.export");
      const row = await this.exports.assertExportAuthorized(tx, actor.orgId, packageId, reader);
      if ("objects" in row.source && !this.objectStorage?.())
        throw new FederationError("POLICY_DENIED");
      const inserted = await tx
        .insert(operations)
        .values({
          localSiteId: this.siteId,
          packageId,
          generation: crypto.randomUUID(),
          requestedBy: actor.userId,
          state: "queued",
          updatedAt: this.clock(),
        })
        .onConflictDoNothing()
        .returning();
      const [existing] = await tx
        .select()
        .from(operations)
        .where(this.condition(packageId))
        .for("update");
      if (!existing) throw new FederationError("OPERATION_CONFLICT");
      if (inserted.length)
        await tx.insert(auditLog).values({
          actor: actor.userId,
          orgId: actor.orgId,
          action: "federation.media.export_start",
          target: packageId,
          diff: { after: { generation: existing.generation } },
        });
      if (existing.state !== "failed") return existing;
      const [retry] = await tx
        .update(operations)
        .set({
          generation: crypto.randomUUID(),
          requestedBy: actor.userId,
          state: "queued",
          updatedAt: this.clock(),
        })
        .where(this.condition(packageId))
        .returning();
      if (!retry) throw new FederationError("OPERATION_CONFLICT");
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.media.export_retry",
        target: packageId,
        diff: { after: { generation: retry.generation, previousGeneration: existing.generation } },
      });
      return retry;
    });
  }
  async status(actor: FederationActor, packageId: string) {
    await this.exports.details(actor, packageId);
    const [row] = await this.db.select().from(operations).where(this.condition(packageId));
    return row ?? null;
  }
  async pending(agentIds: string[]) {
    if (!agentIds.length) return [];
    return this.db
      .select({ packageId: operations.packageId, source: federationMediaExports.source })
      .from(operations)
      .innerJoin(
        federationMediaExports,
        and(
          eq(federationMediaExports.localSiteId, operations.localSiteId),
          eq(federationMediaExports.packageId, operations.packageId),
        ),
      )
      .where(
        and(
          eq(operations.localSiteId, this.siteId),
          eq(operations.state, "queued"),
          isNull(federationMediaExports.revokedAt),
          gt(federationMediaExports.expiresAt, this.clock()),
          inArray(sql<string>`${federationMediaExports.source}->>'agentId'`, agentIds),
        ),
      )
      .orderBy(asc(operations.updatedAt))
      .limit(20);
  }
  async defer(packageId: string) {
    await this.db
      .update(operations)
      .set({ updatedAt: this.clock() })
      .where(and(this.condition(packageId), eq(operations.state, "queued")));
  }
  private async scope(
    tx: PgTransaction,
    agentId: string,
    packageId: string,
    reader?: TaskMediaReader,
  ) {
    const [stored] = await tx
      .select()
      .from(federationMediaExports)
      .where(
        and(
          eq(federationMediaExports.localSiteId, this.siteId),
          eq(federationMediaExports.packageId, packageId),
        ),
      );
    if (!stored || stored.source.agentId !== agentId) throw new FederationError("POLICY_DENIED");
    const row = await this.exports.assertExportAuthorized(tx, stored.localOrgId, packageId, reader);
    const [operation] = await tx
      .select()
      .from(operations)
      .where(this.condition(packageId))
      .for("update");
    if (!operation) throw new FederationError("POLICY_DENIED");
    await requireFederationCapability(
      tx,
      { orgId: row.localOrgId, userId: operation.requestedBy },
      "media.export",
    );
    const key = await this.trust.resolveKey(
      this.siteId,
      federationMessageKeyId(row.manifestJws),
      this.clock(),
      tx,
    );
    const expiresAt = new Date(
      Math.min(
        this.clock().getTime() + 30_000,
        row.expiresAt.getTime(),
        key.validUntil.getTime(),
        row.authorizedUntil,
      ),
    );
    if (expiresAt <= this.clock()) throw new FederationError("AUTHORIZATION_EXPIRED");
    return { operation, row, key, expiresAt };
  }
  async task(agentId: string, packageId: string) {
    const reader = await this.exports.reader(packageId, { agentId });
    return this.db.transaction(async (tx) => {
      const s = await this.scope(tx, agentId, packageId, reader);
      if (s.operation.state !== "queued") throw new FederationError("OPERATION_CONFLICT");
      if ("objects" in s.row.source && !this.objectStorage?.())
        throw new FederationError("POLICY_DENIED");
      const task = FederationMediaExportTaskSchema.parse({
        generation: s.operation.generation,
        packageId,
        manifestDigest: s.row.manifestDigest,
        agentId,
        sourceSiteId: this.siteId,
        recipientSiteId: s.row.recipientSiteId,
        ...("objects" in s.row.source
          ? {
              objects: s.row.source.objects.map(({ path, sizeBytes, sha256, versionId }) => ({
                path,
                sizeBytes,
                sha256,
                versionId,
              })),
            }
          : { managedRootId: s.row.source.managedRootId, relativePath: s.row.source.relativePath }),
        recipient: s.row.recipient,
        signedManifest: s.row.manifestJws,
        signingKey: {
          keyId: s.key.keyId,
          publicKeyPem: await exportSPKI(s.key.publicKey),
          validFrom: s.key.validFrom.toISOString(),
          validUntil: s.key.validUntil.toISOString(),
        },
        expiresAt: s.row.expiresAt.toISOString(),
      });
      return { task, expiresAt: s.expiresAt };
    });
  }
  async lease(agentId: string, raw: unknown) {
    const binding = FederationMediaExportBindingSchema.parse(raw);
    const reader = await this.exports.reader(binding.packageId, { agentId });
    return this.db.transaction(async (tx) => {
      const s = await this.scope(tx, agentId, binding.packageId, reader);
      if (
        s.operation.generation !== binding.generation ||
        s.row.manifestDigest !== binding.manifestDigest ||
        s.operation.state !== "queued"
      )
        throw new FederationError("OPERATION_CONFLICT");
      return FederationMediaExportLeaseSchema.parse({
        ...binding,
        expiresAt: s.expiresAt.toISOString(),
      });
    });
  }
  async objectGrant(agentId: string, raw: unknown) {
    const binding = FederationMediaObjectBindingSchema.parse(raw);
    const backend = this.objectStorage?.();
    if (!backend) throw new FederationError("POLICY_DENIED");
    const origins = new Set(
      backend.allowedOrigins.map(
        (origin) => new URL(FederationDataOriginSchema.parse(origin)).origin,
      ),
    );
    if (!origins.size) throw new FederationError("POLICY_DENIED");
    const reader = await this.exports.reader(binding.packageId, { agentId });
    const read = async (tx: PgTransaction) => {
      const s = await this.scope(tx, agentId, binding.packageId, reader);
      if (
        s.operation.generation !== binding.generation ||
        s.operation.state !== "queued" ||
        s.row.manifestDigest !== binding.manifestDigest ||
        !("objects" in s.row.source)
      )
        throw new FederationError("OPERATION_CONFLICT");
      const object = s.row.source.objects[binding.fileIndex];
      if (
        !object ||
        object.path !== binding.path ||
        object.sizeBytes !== binding.sizeBytes ||
        object.sha256 !== binding.sha256 ||
        object.versionId !== binding.versionId
      )
        throw new FederationError("OPERATION_CONFLICT");
      return { object, expiresAt: s.expiresAt };
    };
    const first = await this.db.transaction(read);
    // Object I/O never holds task/approval locks, and cannot select a different key or version.
    const stat = await backend.storage.head(first.object.storageKey, first.object.versionId);
    if (!stat || stat.size !== binding.sizeBytes || stat.versionId !== binding.versionId)
      throw new FederationError("ASSET_UNAVAILABLE");
    const now = this.clock().getTime();
    const deadline = Math.min(first.expiresAt.getTime(), now + 30_000);
    const seconds = Math.floor((deadline - now) / 1000);
    if (seconds < 1) throw new FederationError("AUTHORIZATION_EXPIRED");
    const url = await backend.storage.presignDownload(
      first.object.storageKey,
      seconds,
      undefined,
      first.object.versionId,
    );
    const grant = FederationMediaObjectGrantSchema.parse({
      binding,
      url,
      expiresAt: signedDownloadExpiry(url, this.clock().getTime(), deadline),
    });
    const address = new URL(grant.url);
    if (
      !origins.has(address.origin) ||
      address.searchParams.getAll("versionId").length !== 1 ||
      address.searchParams.get("versionId") !== binding.versionId
    )
      throw new FederationError("POLICY_DENIED");
    await this.db.transaction(async (tx) => {
      const current = await read(tx);
      if (federationCanonicalJson(current.object) !== federationCanonicalJson(first.object))
        throw new FederationError("OPERATION_CONFLICT");
      if (
        Date.parse(grant.expiresAt) <= this.clock().getTime() ||
        Date.parse(grant.expiresAt) > current.expiresAt.getTime()
      )
        throw new FederationError("AUTHORIZATION_EXPIRED");
    });
    return grant;
  }
  async report(agentId: string, raw: unknown) {
    const report = z
      .discriminatedUnion("state", [
        FederationMediaExportReceiptSchema.extend({ state: z.literal("exported") }),
        FederationMediaExportBindingSchema.extend({ state: z.literal("failed") }),
      ])
      .parse(raw);
    const reader = await this.exports.reader(report.packageId, { agentId });
    return this.db.transaction(async (tx) => {
      const s = await this.scope(tx, agentId, report.packageId, reader);
      if (
        s.operation.generation !== report.generation ||
        s.row.manifestDigest !== report.manifestDigest
      )
        throw new FederationError("OPERATION_CONFLICT");
      if (s.operation.state === "exported") {
        if (
          report.state !== "exported" ||
          s.operation.sha256 !== report.sha256 ||
          s.operation.sizeBytes !== report.sizeBytes
        )
          throw new FederationError("OPERATION_CONFLICT");
        return;
      }
      if (s.operation.state !== "queued") return;
      await tx
        .update(operations)
        .set({
          state: report.state,
          sha256: report.state === "exported" ? report.sha256 : null,
          sizeBytes: report.state === "exported" ? report.sizeBytes : null,
          updatedAt: this.clock(),
        })
        .where(this.condition(report.packageId));
      await tx.insert(auditLog).values({
        actor: s.operation.requestedBy,
        orgId: s.row.localOrgId,
        action: "federation.media.export_result",
        target: report.packageId,
        diff: { after: report },
      });
    });
  }
}
