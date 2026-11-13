import {
  auditLog,
  federationMaterials,
  federationSites,
  type PgDb,
  type PgTransaction,
} from "@kuintessence/db";
import {
  assertFederationReportIdentity,
  FEDERATION_MATERIAL_CHUNK_BYTES,
  FederationEnvironmentLockSchema,
  FederationError,
  FederationInputFilesSchema,
  FederationInputManifestSchema,
  FederationMaterialChunkSchema,
  FederationMaterialQuerySchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { eq } from "drizzle-orm";
import { type FederationAssetService, federationMaterialDigest } from "./assets";
import { FederationDeliveryError, type FederationSend } from "./outbound-client";
import type { FederationPreparationService } from "./preparation";
import {
  type FederationSigningKey,
  federationMessageKeyId,
  signFederationMessage,
  verifyFederationMessage,
} from "./signatures";
import { FederationTrustRegistry } from "./trust-registry";

/** Small manifests only. No executable assets, dataset bytes or implicit local permission grants. */
export class FederationMaterialExchange {
  private readonly trust: FederationTrustRegistry;
  constructor(
    private readonly db: PgDb,
    private readonly signing: FederationSigningKey,
    private readonly send: FederationSend,
    private readonly preparation: FederationPreparationService,
    private readonly assets: FederationAssetService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.trust = new FederationTrustRegistry(db);
  }

  async ensure(reservationId: string) {
    const scope = await this.preparation.materialScope(reservationId);
    const { request, identity } = scope;
    if (request.recipientSiteId !== this.signing.siteId) throw new FederationError("POLICY_DENIED");
    const references = [
      { digest: request.inputManifestDigest, kind: "inputs" as const },
      { digest: request.environmentLockDigest, kind: "environment-lock" as const },
    ];
    const missing = await this.db.transaction(async (tx) => {
      await this.preparation.lockMaterialScope(tx, scope);
      const result = [];
      for (const ref of references) {
        try {
          const body = await this.assets.readMaterial(
            tx,
            identity.orgId,
            request.senderSiteId,
            ref.digest,
          );
          if (body.kind !== ref.kind) throw new FederationError("INVALID_MESSAGE");
        } catch (error) {
          if (!(error instanceof FederationError) || error.code !== "DATA_WAITING") throw error;
          result.push(ref);
        }
      }
      return result;
    });
    if (!missing.length) return;
    const { complete, authorize, disclosureExpiresAt } = await this.receive(scope, missing);
    const source = { id: request.senderSiteId };
    await this.db.transaction(async (tx) => {
      await authorize(tx);
      if (this.clock().getTime() >= disclosureExpiresAt)
        throw new FederationError("AUTHORIZATION_EXPIRED");
      for (const material of complete) {
        if (material.kind === "workflow-input-files") throw new FederationError("INVALID_MESSAGE");
        const [created] = await tx
          .insert(federationMaterials)
          .values({
            ...material,
            localOrgId: identity.orgId,
            originSiteId: source.id,
            createdBy: identity.userId,
          })
          .onConflictDoNothing()
          .returning({ digest: federationMaterials.digest });
        // A concurrent importer must have stored the same valid material, never silently replace it.
        const stored = await this.assets.readMaterial(
          tx,
          identity.orgId,
          source.id,
          material.digest,
        );
        if (stored.kind !== material.kind) throw new FederationError("INVALID_MESSAGE");
        if (created)
          await tx.insert(auditLog).values({
            actor: identity.userId,
            orgId: identity.orgId,
            action: "federation.material.receive",
            target: material.digest,
            diff: {
              after: {
                originSiteId: source.id,
                operationId: request.operationId,
                kind: material.kind,
              },
            },
          });
      }
      await authorize(tx);
      if (this.clock().getTime() >= disclosureExpiresAt)
        throw new FederationError("AUTHORIZATION_EXPIRED");
    });
  }

  async inputFiles(reservationId: string) {
    const scope = await this.preparation.materialScope(reservationId);
    const digest = scope.request.inputFilesDigest;
    if (!digest || scope.request.recipientSiteId !== this.signing.siteId)
      throw new FederationError("POLICY_DENIED");
    const received = await this.receive(scope, [{ digest, kind: "workflow-input-files" }]);
    const material = received.complete[0];
    if (!material) throw new FederationError("DATA_WAITING");
    const manifest = FederationInputFilesSchema.parse(JSON.parse(material.content));
    return {
      scope,
      manifest,
      authorize: async (tx: PgTransaction) => {
        await received.authorize(tx);
        if (this.clock().getTime() >= received.disclosureExpiresAt)
          throw new FederationError("AUTHORIZATION_EXPIRED");
      },
    };
  }

  private async receive(
    scope: Awaited<ReturnType<FederationPreparationService["materialScope"]>>,
    references: Array<{
      digest: string;
      kind: "inputs" | "environment-lock" | "workflow-input-files";
    }>,
  ) {
    const { request, saved } = scope;
    const reservationId = saved.reservation.id;
    const [source] = await this.db
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, request.senderSiteId));
    if (!source || source.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
    const ownKey = await this.trust.resolveKey(
      this.signing.siteId,
      this.signing.keyId,
      this.clock(),
    );
    if (!ownKey.allowedKinds.includes("material-query"))
      throw new FederationError("UNTRUSTED_IDENTITY");
    const peerKeys = new Set<string>();
    const authorize = async (tx: PgTransaction) => {
      await this.preparation.lockMaterialScope(tx, scope);
      await this.trust.assertKey(tx, this.signing.siteId, this.signing.keyId, this.clock());
      const local = await this.trust.resolveKey(
        this.signing.siteId,
        this.signing.keyId,
        this.clock(),
        tx,
      );
      if (!local.allowedKinds.includes("material-query"))
        throw new FederationError("UNTRUSTED_IDENTITY");
      for (const keyId of [...peerKeys].sort()) {
        await this.trust.assertKey(tx, source.id, keyId, this.clock());
        const key = await this.trust.resolveKey(source.id, keyId, this.clock(), tx);
        if (!key.allowedKinds.includes("material-chunk"))
          throw new FederationError("UNTRUSTED_IDENTITY");
      }
      const [current] = await tx
        .select()
        .from(federationSites)
        .where(eq(federationSites.id, source.id))
        .for("share");
      if (!current || current.state !== "active" || current.endpoint !== source.endpoint)
        throw new FederationError("UNTRUSTED_IDENTITY");
    };
    const complete: Array<{
      digest: string;
      kind: "inputs" | "environment-lock" | "workflow-input-files";
      content: string;
    }> = [];
    let disclosureExpiresAt = 0;
    for (const ref of references) {
      const chunks: Buffer[] = [];
      let total: number | undefined;
      let offset = 0;
      do {
        const query = FederationMaterialQuerySchema.parse({
          protocolVersion: 1,
          kind: "material-query",
          queryId: crypto.randomUUID(),
          senderSiteId: this.signing.siteId,
          recipientSiteId: source.id,
          operationId: request.operationId,
          agreementRevisionId: request.agreementRevisionId,
          taskId: request.taskId,
          attempt: request.attempt,
          reservationId,
          requestDigest: saved.reservation.requestDigest,
          materialDigest: ref.digest,
          offset,
          issuedAt: this.clock().toISOString(),
          expiresAt: new Date(this.clock().getTime() + 60_000).toISOString(),
        });
        const jws = await signFederationMessage(FederationMaterialQuerySchema, query, this.signing);
        const { digest } = await verifyFederationMessage(
          FederationMaterialQuerySchema,
          jws,
          ownKey,
          this.clock(),
        );
        await this.db.transaction(authorize);
        let response: string;
        try {
          response = await this.send(source.endpoint, jws, "/federation/v1/materials");
        } catch (error) {
          if (error instanceof FederationDeliveryError) throw new FederationError("DATA_WAITING");
          throw error;
        }
        const keyId = federationMessageKeyId(response);
        const peer = await this.trust.resolveKey(source.id, keyId, this.clock());
        const { payload: chunk } = await verifyFederationMessage(
          FederationMaterialChunkSchema,
          response,
          peer,
          this.clock(),
        );
        assertFederationReportIdentity(query, digest, chunk, this.clock());
        const bytes = Buffer.from(chunk.bytes, "base64");
        if (
          chunk.materialDigest !== ref.digest ||
          chunk.offset !== offset ||
          (total !== undefined && chunk.totalBytes !== total) ||
          chunk.totalBytes <= offset ||
          bytes.length !== Math.min(FEDERATION_MATERIAL_CHUNK_BYTES, chunk.totalBytes - offset) ||
          bytes.toString("base64") !== chunk.bytes
        )
          throw new FederationError("INVALID_MESSAGE");
        peerKeys.add(keyId);
        await this.db.transaction(async (tx) => {
          await authorize(tx);
          assertFederationReportIdentity(query, digest, chunk, this.clock());
        });
        disclosureExpiresAt = Date.parse(query.expiresAt);
        chunks.push(bytes);
        offset += bytes.length;
        total = chunk.totalBytes;
      } while (offset < total);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        const raw: unknown = JSON.parse(content);
        // Depth/size limits precede recursive schema parsing; exact digest covers all bytes.
        if (
          federationCanonicalJson(raw) !== content ||
          federationMaterialDigest(raw) !== ref.digest
        )
          throw new Error("Material digest mismatch");
        const parsed = FederationInputManifestSchema.or(FederationEnvironmentLockSchema)
          .or(FederationInputFilesSchema)
          .parse(raw);
        if (parsed.kind !== ref.kind) throw new Error("Material kind mismatch");
      } catch {
        throw new FederationError("INVALID_MESSAGE");
      }
      complete.push({ ...ref, content });
    }
    return { complete, authorize, disclosureExpiresAt };
  }
}
