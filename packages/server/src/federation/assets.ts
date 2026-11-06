import { createHash } from "node:crypto";
import {
  auditLog,
  dataAssets,
  dataAssetVersions,
  federationAssetMappings,
  federationMaterials,
  federationSites,
  type PgDb,
  type PgTransaction,
  softwareAssetRevisions,
  softwareAssets,
} from "@kuintessence/db";
import { SoftwareAssetPayloadSchema } from "@kuintessence/shared";
import {
  type FederationAssetRef,
  FederationAssetRefSchema,
  type FederationEnvironmentLock,
  FederationEnvironmentLockSchema,
  FederationError,
  type FederationInputManifest,
  FederationInputManifestSchema,
  federationCanonicalJson,
} from "@kuintessence/shared/federation";
import { and, desc, eq } from "drizzle-orm";
import type { BoundPrincipal } from "../middleware/principal-binder";
import { PgDataPrerequisiteRepository } from "../services/data-prerequisite-repository-drizzle";
import { type ExecutionIdentity, requireExecutionIdentity } from "./execution-identity";
import { type FederationActor, requireFederationCapability } from "./permissions";

type Mapping = typeof federationAssetMappings.$inferSelect;
const assetKinds = {
  workflow: "workflow-template",
  script: "sandbox-script",
  software: "spack-package",
  usecase: "usecase",
} as const;

export function federationMaterialDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(federationCanonicalJson(value)).digest("hex")}`;
}

export interface FederationAssetAuthorization {
  /** Uses the existing software policy/SpiceDB service, not a new federation-specific ACL. */
  authorizeSoftware(
    assetId: string,
    principal: BoundPrincipal,
    capability: "view" | "use",
  ): Promise<void>;
}

function executionPrincipal(identity: ExecutionIdentity): BoundPrincipal {
  return {
    userId: identity.userId,
    sub: identity.userId,
    orgId: identity.orgId,
    orgIds: [identity.orgId],
    role: "user",
    email: "",
    memberships: [{ orgId: identity.orgId, role: "member" }],
    capabilities: [],
  };
}

/** Mapping and material storage do not confer software licenses, data use grants or dispatch authority. */
export class FederationAssetService {
  constructor(
    private readonly db: PgDb,
    private readonly authorization: FederationAssetAuthorization,
  ) {}

  async list(actor: FederationActor, limit = 50, offset = 0) {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      return tx
        .select()
        .from(federationAssetMappings)
        .where(eq(federationAssetMappings.localOrgId, actor.orgId))
        .orderBy(desc(federationAssetMappings.createdAt), desc(federationAssetMappings.id))
        .limit(limit)
        .offset(offset);
    });
  }

  async register(
    actor: FederationActor,
    input: { reference: FederationAssetRef; localRevisionId: string },
  ) {
    const reference = FederationAssetRefSchema.parse(input.reference);
    const inspect = (tx: PgTransaction) => this.inspectLocal(tx, reference, input.localRevisionId);
    const local = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.map");
      await this.requireOrigin(tx, reference.originSiteId);
      return inspect(tx);
    });
    // External authorization calls never hold a database transaction/connection.
    if (local.kind === "software")
      await this.authorization.authorizeSoftware(local.asset.id, executionPrincipal(actor), "view");
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.map");
      await this.requireOrigin(tx, reference.originSiteId);
      const current = await inspect(tx);
      if (current.kind === "dataset") await this.requireDatasetAccess(tx, current, actor);
      const [created] = await tx
        .insert(federationAssetMappings)
        .values({
          localOrgId: actor.orgId,
          originSiteId: reference.originSiteId,
          kind: reference.kind,
          originId: reference.id,
          originRevision: reference.revision,
          digest: reference.digest,
          softwareRevisionId: reference.kind === "dataset" ? null : input.localRevisionId,
          dataVersionId: reference.kind === "dataset" ? input.localRevisionId : null,
          createdBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        const [existing] = await tx
          .select()
          .from(federationAssetMappings)
          .where(this.referenceCondition(actor.orgId, reference))
          .for("share");
        if (
          !existing ||
          existing.digest !== reference.digest ||
          (existing.softwareRevisionId ?? existing.dataVersionId) !== input.localRevisionId ||
          existing.revokedAt
        )
          throw new FederationError("OPERATION_CONFLICT");
        return existing;
      }
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.asset.map",
        target: created.id,
        diff: { after: { reference, localRevisionId: input.localRevisionId } },
      });
      return created;
    });
  }

  async revoke(actor: FederationActor, mappingId: string) {
    await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.map");
      const [row] = await tx
        .select()
        .from(federationAssetMappings)
        .where(
          and(
            eq(federationAssetMappings.id, mappingId),
            eq(federationAssetMappings.localOrgId, actor.orgId),
          ),
        )
        .for("update");
      if (!row) throw new FederationError("ASSET_UNAVAILABLE");
      if (row.revokedAt) return;
      await tx
        .update(federationAssetMappings)
        .set({ revokedAt: new Date() })
        .where(eq(federationAssetMappings.id, mappingId));
      await tx.insert(auditLog).values({
        actor: actor.userId,
        orgId: actor.orgId,
        action: "federation.asset.revoke",
        target: mappingId,
      });
    });
  }

  async putMaterial(actor: FederationActor, originSiteId: string, raw: unknown) {
    // Bound depth and byte length before recursive schema validation.
    let content: string;
    try {
      content = federationCanonicalJson(raw);
    } catch {
      throw new FederationError("INVALID_MESSAGE");
    }
    const parsed = FederationInputManifestSchema.or(FederationEnvironmentLockSchema).safeParse(raw);
    if (!parsed.success) throw new FederationError("INVALID_MESSAGE");
    const digest = federationMaterialDigest(raw);
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.map");
      await this.requireOrigin(tx, originSiteId);
      const [created] = await tx
        .insert(federationMaterials)
        .values({
          localOrgId: actor.orgId,
          originSiteId,
          digest,
          kind: parsed.data.kind,
          content,
          createdBy: actor.userId,
        })
        .onConflictDoNothing()
        .returning();
      if (created)
        await tx.insert(auditLog).values({
          actor: actor.userId,
          orgId: actor.orgId,
          action: "federation.material.store",
          target: digest,
          diff: { after: { originSiteId, kind: parsed.data.kind } },
        });
      return { digest, kind: parsed.data.kind };
    });
  }

  async getMaterial(
    actor: FederationActor,
    originSiteId: string,
    digest: string,
  ): Promise<FederationInputManifest | FederationEnvironmentLock> {
    return this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      return this.readMaterial(tx, actor.orgId, originSiteId, digest);
    });
  }

  async readMaterial(
    tx: PgTransaction,
    orgId: string,
    originSiteId: string,
    digest: string,
  ): Promise<FederationInputManifest | FederationEnvironmentLock> {
    const [row] = await tx
      .select()
      .from(federationMaterials)
      .where(
        and(
          eq(federationMaterials.localOrgId, orgId),
          eq(federationMaterials.originSiteId, originSiteId),
          eq(federationMaterials.digest, digest),
        ),
      )
      .for("share");
    if (!row) throw new FederationError("DATA_WAITING");
    const body: unknown = JSON.parse(row.content);
    if (federationMaterialDigest(body) !== digest) throw new FederationError("INVALID_MESSAGE");
    const result = FederationInputManifestSchema.or(FederationEnvironmentLockSchema).safeParse(
      body,
    );
    if (!result.success || result.data.kind !== row.kind)
      throw new FederationError("INVALID_MESSAGE");
    return result.data;
  }

  /** This resolves and authorizes a snapshot. Dispatch must recheck it using assertResolved. */
  async resolve(identity: ExecutionIdentity, reference: FederationAssetRef, running = false) {
    const snapshot = await this.db.transaction(async (tx) => {
      await requireExecutionIdentity(tx, identity);
      return this.assertResolved(tx, identity, reference, undefined, running);
    });
    if (snapshot.local.kind === "software")
      await this.authorization.authorizeSoftware(
        snapshot.local.asset.id,
        executionPrincipal(identity),
        "use",
      );
    return snapshot;
  }

  async assertView(actor: FederationActor, reference: FederationAssetRef) {
    const { local } = await this.db.transaction(async (tx) => {
      await requireFederationCapability(tx, actor, "asset.read");
      return this.assertResolved(tx, actor, reference);
    });
    if (local.kind === "software")
      await this.authorization.authorizeSoftware(local.asset.id, executionPrincipal(actor), "view");
  }

  async assertResolved(
    tx: PgTransaction,
    identity: ExecutionIdentity,
    reference: FederationAssetRef,
    expectedMappingId?: string,
    running = false,
  ) {
    await this.requireOrigin(tx, reference.originSiteId);
    const [mapping] = await tx
      .select()
      .from(federationAssetMappings)
      .where(this.referenceCondition(identity.orgId, reference))
      .for("share");
    if (!mapping)
      throw new FederationError(
        reference.kind === "dataset" ? "DATA_WAITING" : "ASSET_UNAVAILABLE",
      );
    if (mapping.revokedAt) throw new FederationError("POLICY_DENIED");
    if (
      mapping.digest !== reference.digest ||
      (expectedMappingId && mapping.id !== expectedMappingId)
    )
      throw new FederationError("OPERATION_CONFLICT");
    const local = await this.inspectLocal(tx, reference, this.localId(mapping));
    if (local.kind === "dataset") {
      await this.requireDatasetAccess(tx, local, identity);
      if (!running) {
        const locations = await new PgDataPrerequisiteRepository(tx).listLocations(
          local.version.id,
        );
        if (!locations.length) throw new FederationError("DATA_WAITING");
      }
    }
    return { mapping, local };
  }

  private localId(mapping: Mapping) {
    const id = mapping.softwareRevisionId ?? mapping.dataVersionId;
    if (!id) throw new FederationError("ASSET_UNAVAILABLE");
    return id;
  }

  private referenceCondition(orgId: string, ref: FederationAssetRef) {
    return and(
      eq(federationAssetMappings.localOrgId, orgId),
      eq(federationAssetMappings.originSiteId, ref.originSiteId),
      eq(federationAssetMappings.kind, ref.kind),
      eq(federationAssetMappings.originId, ref.id),
      eq(federationAssetMappings.originRevision, ref.revision),
    );
  }

  private async requireOrigin(tx: PgTransaction, siteId: string) {
    const [site] = await tx
      .select()
      .from(federationSites)
      .where(eq(federationSites.id, siteId))
      .for("share");
    if (!site || site.state !== "active") throw new FederationError("UNTRUSTED_IDENTITY");
  }

  private async inspectLocal(tx: PgTransaction, reference: FederationAssetRef, id: string) {
    if (reference.kind === "dataset") {
      const [row] = await tx
        .select({ asset: dataAssets, version: dataAssetVersions })
        .from(dataAssetVersions)
        .innerJoin(dataAssets, eq(dataAssets.id, dataAssetVersions.dataAssetId))
        .where(eq(dataAssetVersions.id, id))
        .for("share", { of: [dataAssetVersions, dataAssets] });
      if (row?.asset.lifecycle === "revoked") throw new FederationError("POLICY_DENIED");
      if (
        !row?.version.immutableAt ||
        row.asset.lifecycle !== "published" ||
        row.version.status !== "ready"
      )
        throw new FederationError("DATA_WAITING");
      if (row.version.manifestDigest !== reference.digest)
        throw new FederationError("OPERATION_CONFLICT");
      return { kind: "dataset" as const, ...row };
    }
    const [row] = await tx
      .select({ asset: softwareAssets, revision: softwareAssetRevisions })
      .from(softwareAssetRevisions)
      .innerJoin(softwareAssets, eq(softwareAssets.id, softwareAssetRevisions.assetId))
      .where(eq(softwareAssetRevisions.id, id))
      .for("share", { of: [softwareAssetRevisions, softwareAssets] });
    if (row?.asset.lifecycle === "revoked") throw new FederationError("POLICY_DENIED");
    if (
      !row ||
      row.asset.kind !== assetKinds[reference.kind] ||
      row.asset.lifecycle !== "published"
    )
      throw new FederationError("ASSET_UNAVAILABLE");
    if (federationMaterialDigest(row.revision.payload) !== reference.digest)
      throw new FederationError("OPERATION_CONFLICT");
    const payload = SoftwareAssetPayloadSchema.safeParse(row.revision.payload);
    if (!payload.success || payload.data.kind !== row.asset.kind)
      throw new FederationError("INVALID_MESSAGE");
    if (
      payload.data.kind === "sandbox-script" &&
      createHash("sha256").update(payload.data.content).digest("hex") !== payload.data.sha256
    )
      throw new FederationError("INVALID_MESSAGE");
    return { kind: "software" as const, ...row, payload: payload.data };
  }

  private async requireDatasetAccess(
    tx: PgTransaction,
    local: {
      asset: typeof dataAssets.$inferSelect;
      version: typeof dataAssetVersions.$inferSelect;
    },
    actor: FederationActor,
  ) {
    if (
      !(await new PgDataPrerequisiteRepository(tx).verifyAccess({
        actorUserId: actor.userId,
        orgId: actor.orgId,
        assetId: local.asset.id,
        versionId: local.version.id,
      }))
    )
      throw new FederationError("POLICY_DENIED");
  }
}
