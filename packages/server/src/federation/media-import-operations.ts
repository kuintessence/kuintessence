import {
  auditLog,
  federationMediaImportAuthorizations as authorizations,
  federationMediaImportOperations as operations,
  type PgDb,
  type PgTransaction,
  federationMediaPackages as packages,
} from "@kuintessence/db";
import {
  assertMediaKeyGrant,
  FederationError,
  type FederationMediaImportBinding,
  FederationMediaImportBindingSchema,
  FederationMediaImportGrantSchema,
  FederationMediaImportKeyRequestSchema,
  FederationMediaImportReportSchema,
  FederationMediaImportTaskSchema,
  FederationMediaKeyGrantSchema,
} from "@kuintessence/shared/federation";
import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import { exportSPKI } from "jose";
import { z } from "zod";
import type { FederationMediaKeyRequester } from "./media-key-exchange";
import type { FederationMediaPackageService } from "./media-packages";
import { type FederationActor, requireFederationCapability } from "./permissions";
import { federationMessageKeyId, verifyFederationMessage } from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

export class FederationMediaImportOperations {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly siteId: string,
    private readonly inventory: FederationMediaPackageService,
    private readonly requester: FederationMediaKeyRequester,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }
  async start(actor: FederationActor, packageId: string, authorizationId: string) {
    z.uuid().parse(packageId);
    z.uuid().parse(authorizationId);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "media.import");
      const scope = await this.inventory.assertImportAuthorized(
        tx,
        actor.orgId,
        packageId,
        authorizationId,
      );
      // Task input/result package publication has separate workflow ownership semantics.
      if (scope.package.manifest.subject.kind !== "dataset")
        throw new FederationError("POLICY_DENIED");
      const created = await tx
        .insert(operations)
        .values({
          authorizationId,
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
        .where(eq(operations.authorizationId, authorizationId))
        .for("update");
      if (!existing) throw new FederationError("OPERATION_CONFLICT");
      if (created.length)
        await this.audit(tx, actor, "start", packageId, {
          authorizationId,
          generation: existing.generation,
        });
      if (existing.state !== "failed") return summary(existing);
      const [retry] = await tx
        .update(operations)
        .set({
          generation: crypto.randomUUID(),
          requestedBy: actor.userId,
          state: "queued",
          latestGrant: null,
          updatedAt: this.clock(),
        })
        .where(eq(operations.authorizationId, authorizationId))
        .returning();
      if (!retry) throw new FederationError("OPERATION_CONFLICT");
      await this.audit(tx, actor, "retry", packageId, {
        authorizationId,
        generation: retry.generation,
        previousGeneration: existing.generation,
      });
      return summary(retry);
    });
  }
  async status(actor: FederationActor, packageId: string, authorizationId: string) {
    await this.inventory.details(actor, packageId);
    const [row] = await this.db
      .select({ operation: operations })
      .from(operations)
      .innerJoin(authorizations, eq(authorizations.authorizationId, operations.authorizationId))
      .where(
        and(
          eq(authorizations.localSiteId, this.siteId),
          eq(authorizations.packageId, packageId),
          eq(authorizations.authorizationId, authorizationId),
        ),
      );
    return row ? summary(row.operation) : null;
  }
  async pending(agentIds: string[]) {
    if (!agentIds.length) return [];
    return this.db
      .select({ authorizationId: operations.authorizationId, agentId: authorizations.agentId })
      .from(operations)
      .innerJoin(authorizations, eq(authorizations.authorizationId, operations.authorizationId))
      .innerJoin(
        packages,
        and(
          eq(packages.localSiteId, authorizations.localSiteId),
          eq(packages.packageId, authorizations.packageId),
        ),
      )
      .where(
        and(
          eq(authorizations.localSiteId, this.siteId),
          eq(operations.state, "queued"),
          inArray(authorizations.agentId, agentIds),
          isNull(authorizations.revokedAt),
          isNull(packages.revokedAt),
          gt(authorizations.expiresAt, this.clock()),
        ),
      )
      .orderBy(asc(operations.updatedAt))
      .limit(20);
  }
  async defer(authorizationId: string) {
    await this.db
      .update(operations)
      .set({ updatedAt: this.clock() })
      .where(and(eq(operations.authorizationId, authorizationId), eq(operations.state, "queued")));
  }
  private async scope(tx: PgTransaction, agentId: string, authorizationId: string) {
    const [selected] = await tx
      .select({
        orgId: packages.localOrgId,
        packageId: packages.packageId,
        agentId: authorizations.agentId,
      })
      .from(authorizations)
      .innerJoin(
        packages,
        and(
          eq(packages.localSiteId, authorizations.localSiteId),
          eq(packages.packageId, authorizations.packageId),
        ),
      )
      .where(
        and(
          eq(authorizations.localSiteId, this.siteId),
          eq(authorizations.authorizationId, authorizationId),
        ),
      );
    if (!selected || selected.agentId !== agentId) throw new FederationError("POLICY_DENIED");
    const scope = await this.inventory.assertImportAuthorized(
      tx,
      selected.orgId,
      selected.packageId,
      authorizationId,
    );
    const [operation] = await tx
      .select()
      .from(operations)
      .where(eq(operations.authorizationId, authorizationId))
      .for("update");
    if (!operation || scope.package.manifest.subject.kind !== "dataset")
      throw new FederationError("POLICY_DENIED");
    await requireFederationCapability(
      tx,
      { orgId: selected.orgId, userId: operation.requestedBy },
      "media.import",
    );
    const key = await this.trust.resolveKey(
      scope.package.senderSiteId,
      federationMessageKeyId(scope.package.manifestJws),
      this.clock(),
      tx,
    );
    return { ...scope, operation, key };
  }
  private match(
    scope: Awaited<ReturnType<FederationMediaImportOperations["scope"]>>,
    binding: FederationMediaImportBinding,
  ) {
    if (
      scope.operation.generation !== binding.generation ||
      scope.package.packageId !== binding.packageId ||
      scope.package.manifestDigest !== binding.manifestDigest ||
      scope.operation.authorizationId !== binding.authorizationId
    )
      throw new FederationError("OPERATION_CONFLICT");
  }
  async task(agentId: string, authorizationId: string) {
    return this.db.transaction(async (tx) => {
      const s = await this.scope(tx, agentId, authorizationId);
      if (s.operation.state !== "queued") throw new FederationError("OPERATION_CONFLICT");
      return {
        task: FederationMediaImportTaskSchema.parse({
          generation: s.operation.generation,
          authorizationId,
          packageId: s.package.packageId,
          manifestDigest: s.package.manifestDigest,
          agentId,
          sourceSiteId: s.package.senderSiteId,
          recipientSiteId: this.siteId,
          agreementRevisionId: s.package.agreementRevisionId,
          managedRootId: s.authorization.managedRootId,
          maxBytes: s.authorization.maxBytes,
          signedManifest: s.package.manifestJws,
          signingKey: {
            keyId: s.key.keyId,
            publicKeyPem: await exportSPKI(s.key.publicKey),
            validFrom: s.key.validFrom.toISOString(),
            validUntil: s.key.validUntil.toISOString(),
          },
          expiresAt: s.authorization.expiresAt.toISOString(),
        }),
        expiresAt: new Date(
          Math.min(
            this.clock().getTime() + 30_000,
            s.authorization.expiresAt.getTime(),
            s.key.validUntil.getTime(),
          ),
        ),
      };
    });
  }
  async grant(agentId: string, raw: unknown) {
    const input = FederationMediaImportKeyRequestSchema.parse(raw);
    const binding = FederationMediaImportBindingSchema.parse({
      generation: input.generation,
      packageId: input.packageId,
      authorizationId: input.authorizationId,
      manifestDigest: input.manifestDigest,
    });
    const orgId = await this.db.transaction(async (tx) => {
      const s = await this.scope(tx, agentId, input.authorizationId);
      this.match(s, binding);
      if (s.operation.state !== "queued") throw new FederationError("OPERATION_CONFLICT");
      return s.package.localOrgId;
    });
    const response = await this.requester.request({
      orgId,
      packageId: input.packageId,
      authorizationId: input.authorizationId,
      authenticatedAgentId: agentId,
      recipientKey: input.recipientKey,
    });
    return this.db.transaction(async (tx) => {
      const s = await this.scope(tx, agentId, input.authorizationId);
      this.match(s, binding);
      if (s.operation.state !== "queued") throw new FederationError("OPERATION_CONFLICT");
      assertMediaKeyGrant(response.query, response.queryDigest, response.grant, this.clock());
      const expiresAt = new Date(
        Math.min(
          this.clock().getTime() + 30_000,
          Date.parse(response.grant.expiresAt),
          s.authorization.expiresAt.getTime(),
          s.key.validUntil.getTime(),
          Date.parse(response.signingKey.validUntil),
        ),
      );
      if (expiresAt <= this.clock()) throw new FederationError("AUTHORIZATION_EXPIRED");
      const grant = FederationMediaImportGrantSchema.parse({
        binding,
        query: response.query,
        queryDigest: response.queryDigest,
        signedGrant: response.signedGrant,
        signingKey: response.signingKey,
        expiresAt: expiresAt.toISOString(),
      });
      await this.assertSourceGrant(tx, grant);
      await tx
        .update(operations)
        .set({ latestGrant: grant, updatedAt: this.clock() })
        .where(eq(operations.authorizationId, input.authorizationId));
      return grant;
    });
  }
  private async assertSourceGrant(
    tx: PgTransaction,
    grant: ReturnType<typeof FederationMediaImportGrantSchema.parse>,
  ) {
    if (Date.parse(grant.expiresAt) <= this.clock().getTime())
      throw new FederationError("AUTHORIZATION_EXPIRED");
    const keyId = federationMessageKeyId(grant.signedGrant);
    await this.trust.assertKey(tx, grant.query.recipientSiteId, keyId, this.clock());
    const key = await this.trust.resolveKey(grant.query.recipientSiteId, keyId, this.clock(), tx);
    const verified = await verifyFederationMessage(
      FederationMediaKeyGrantSchema,
      grant.signedGrant,
      key,
      this.clock(),
    );
    assertMediaKeyGrant(grant.query, grant.queryDigest, verified.payload, this.clock());
  }
  async report(agentId: string, raw: unknown) {
    const report = FederationMediaImportReportSchema.parse(raw);
    return this.db.transaction(async (tx) => {
      const s = await this.scope(tx, agentId, report.authorizationId);
      this.match(s, report);
      if (s.operation.state === "verified") {
        if (
          report.state !== "verified" ||
          report.sizeBytes !== s.operation.verifiedBytes ||
          report.queryDigest !== s.operation.latestGrant?.queryDigest
        )
          throw new FederationError("OPERATION_CONFLICT");
        return;
      }
      if (s.operation.state !== "queued") return;
      if (report.state === "verified") {
        if (
          !s.operation.latestGrant ||
          s.operation.latestGrant.queryDigest !== report.queryDigest ||
          report.sizeBytes !==
            s.package.manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0)
        )
          throw new FederationError("OPERATION_CONFLICT");
        await this.assertSourceGrant(tx, s.operation.latestGrant);
      }
      await tx
        .update(operations)
        .set({
          state: report.state,
          verifiedAt: report.state === "verified" ? this.clock() : null,
          verifiedBytes: report.state === "verified" ? report.sizeBytes : null,
          updatedAt: this.clock(),
        })
        .where(eq(operations.authorizationId, report.authorizationId));
      await this.audit(
        tx,
        { orgId: s.package.localOrgId, userId: s.operation.requestedBy },
        "result",
        report.packageId,
        report,
      );
    });
  }
  private async audit(
    tx: PgTransaction,
    actor: FederationActor,
    action: string,
    packageId: string,
    after: Record<string, unknown>,
  ) {
    await tx.insert(auditLog).values({
      actor: actor.userId,
      orgId: actor.orgId,
      action: `federation.media.import_${action}`,
      target: packageId,
      diff: { after },
    });
  }
}
function summary(row: typeof operations.$inferSelect) {
  return {
    authorizationId: row.authorizationId,
    generation: row.generation,
    requestedBy: row.requestedBy,
    state: row.state,
    verifiedBytes: row.verifiedBytes,
    verifiedAt: row.verifiedAt,
    updatedAt: row.updatedAt,
  };
}
