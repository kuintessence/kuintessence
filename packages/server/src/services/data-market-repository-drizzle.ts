import {
  agents,
  authzOutbox,
  clusterFileRoots,
  dataAccessPolicies,
  dataAccessRequests,
  dataAssetFiles,
  dataAssetImports,
  dataAssets,
  dataAssetVersions,
  dataGrants,
  dataLocations,
  dataReplicas,
  type PgDb,
} from "@kuintessence/db";
import { AppError, ErrorCode } from "@kuintessence/shared";
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import {
  dataAssetGrantDeltaTuples,
  dataAssetOwnerOrgTuple,
  dataAssetOwnerTuple,
  dataAssetPlatformTuple,
  dataAssetProviderTuple,
  dataAssetPublicTuples,
  normalizeDataGrantCapabilities,
} from "../authz/projection";
import type { AuthzTuple } from "../authz/service";
import { hasActiveDataAccess } from "./data-access-decision";
import type {
  DataAccessGrant,
  DataAccessRequest,
  DataAccessReviewInput,
  DataAsset,
  DataAssetFile,
  DataAssetImport,
  DataAssetInput,
  DataAssetListQuery,
  DataAssetReplica,
  DataAssetVersion,
  DataMarketRepository,
  DataReplicaInput,
  DataVersionInput,
  PublicAssetReviewInput,
} from "./data-market";

export class PgDataMarketRepository implements DataMarketRepository {
  private readonly idempotent = new Map<string, Promise<unknown>>();

  constructor(private readonly db: PgDb) {}

  async listCatalogCandidates(
    query: Pick<DataAssetListQuery, "query" | "tag">,
  ): Promise<DataAsset[]> {
    const searchFilter = query.query ? ilike(dataAssets.name, `%${query.query}%`) : undefined;
    const tagFilter = query.tag
      ? sql`${dataAssets.metadata} @> ${JSON.stringify({ tags: [query.tag] })}::jsonb`
      : undefined;
    const filter =
      searchFilter && tagFilter ? and(searchFilter, tagFilter) : (searchFilter ?? tagFilter);
    const rows = await this.db
      .select()
      .from(dataAssets)
      .where(filter)
      .orderBy(desc(dataAssets.updatedAt), desc(dataAssets.id));
    return rows.map(toAsset);
  }

  async listProviderAssets(
    providerOrgIds: string[],
    query: DataAssetListQuery,
  ): Promise<{ assets: DataAsset[]; total: number }> {
    if (providerOrgIds.length === 0) return { assets: [], total: 0 };
    const providerFilter = inArray(dataAssets.providerOrgId, providerOrgIds);
    const searchFilter = query.query ? ilike(dataAssets.name, `%${query.query}%`) : undefined;
    const tagFilter = query.tag
      ? sql`${dataAssets.metadata} @> ${JSON.stringify({ tags: [query.tag] })}::jsonb`
      : undefined;
    const filter = and(providerFilter, searchFilter, tagFilter);
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(dataAssets)
        .where(filter)
        .orderBy(desc(dataAssets.updatedAt), desc(dataAssets.id))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(dataAssets).where(filter),
    ]);
    return { assets: rows.map(toAsset), total: totalRows[0]?.total ?? 0 };
  }

  async listVersions(assetId: string, query: { limit: number; offset: number }) {
    const filter = eq(dataAssetVersions.dataAssetId, assetId);
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(dataAssetVersions)
        .where(filter)
        .orderBy(desc(dataAssetVersions.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(dataAssetVersions).where(filter),
    ]);
    return { versions: rows.map(toVersion), total: totalRows[0]?.total ?? 0 };
  }

  async listReplicas(versionId: string, query: { limit: number; offset: number }) {
    const filter = eq(dataReplicas.dataAssetVersionId, versionId);
    const [rows, totalRows] = await Promise.all([
      this.db
        .select({ replica: dataReplicas, location: dataLocations })
        .from(dataReplicas)
        .leftJoin(dataLocations, eq(dataReplicas.targetLocationId, dataLocations.id))
        .where(filter)
        .orderBy(desc(dataReplicas.requestedAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(dataReplicas).where(filter),
    ]);
    return {
      replicas: rows.map(({ replica, location }) => ({
        id: replica.id,
        versionId: replica.dataAssetVersionId,
        providerOrgId: location?.providerOrgId ?? "",
        agentId: location?.agentId ?? "",
        siteId: location?.siteId ?? replica.targetSiteId,
        clusterId: replica.targetSiteId,
        status: replica.status as DataAssetReplica["status"],
        locationKind: (location?.kind ?? "cp-local") as DataAssetReplica["locationKind"],
        verifiedAt: replica.verifiedAt,
      })),
      total: totalRows[0]?.total ?? 0,
    };
  }

  async listImports(providerOrgIds: string[], query: { limit: number; offset: number }) {
    if (providerOrgIds.length === 0) return { imports: [], total: 0 };
    const filter = inArray(dataAssets.providerOrgId, providerOrgIds);
    const [rows, totalRows] = await Promise.all([
      this.db
        .select({ row: dataAssetImports, root: clusterFileRoots })
        .from(dataAssetImports)
        .innerJoin(dataAssets, eq(dataAssetImports.targetAssetId, dataAssets.id))
        .leftJoin(clusterFileRoots, eq(dataAssetImports.sourceManagedRootId, clusterFileRoots.id))
        .where(filter)
        .orderBy(desc(dataAssetImports.createdAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db
        .select({ total: count() })
        .from(dataAssetImports)
        .innerJoin(dataAssets, eq(dataAssetImports.targetAssetId, dataAssets.id))
        .where(filter),
    ]);
    return {
      imports: rows.map(({ row, root }) => toImport(row, root?.agentId ?? null)),
      total: totalRows[0]?.total ?? 0,
    };
  }

  async listAccessRequests(input: {
    providerOrgIds: string[];
    status?: DataAccessRequest["status"];
    limit: number;
    offset: number;
  }) {
    if (input.providerOrgIds.length === 0) return { requests: [], total: 0 };
    const providerFilter = inArray(dataAssets.providerOrgId, input.providerOrgIds);
    const filter = input.status
      ? and(providerFilter, eq(dataAccessRequests.status, input.status))
      : providerFilter;
    const [rows, totalRows] = await Promise.all([
      this.db
        .select({ row: dataAccessRequests })
        .from(dataAccessRequests)
        .innerJoin(dataAssets, eq(dataAccessRequests.dataAssetId, dataAssets.id))
        .where(filter)
        .orderBy(desc(dataAccessRequests.createdAt))
        .limit(input.limit)
        .offset(input.offset),
      this.db
        .select({ total: count() })
        .from(dataAccessRequests)
        .innerJoin(dataAssets, eq(dataAccessRequests.dataAssetId, dataAssets.id))
        .where(filter),
    ]);
    return {
      requests: rows.map(({ row }) => toAccessRequest(row)),
      total: totalRows[0]?.total ?? 0,
    };
  }

  async getAccessState(input: { requesterUserId: string; orgIds: string[]; assetIds: string[] }) {
    if (input.assetIds.length === 0) return { requests: [], activeUseAssetIds: [] };
    const subject = or(
      and(eq(dataGrants.subjectKind, "user"), eq(dataGrants.subjectId, input.requesterUserId)),
      ...input.orgIds.map((orgId) =>
        and(eq(dataGrants.subjectKind, "org"), eq(dataGrants.subjectId, orgId)),
      ),
    );
    const policySubject = or(
      and(
        eq(dataAccessPolicies.subjectKind, "user"),
        eq(dataAccessPolicies.subjectId, input.requesterUserId),
      ),
      ...input.orgIds.map((orgId) =>
        and(eq(dataAccessPolicies.subjectKind, "org"), eq(dataAccessPolicies.subjectId, orgId)),
      ),
    );
    const [requestRows, grants, policies] = await Promise.all([
      this.db
        .selectDistinctOn([dataAccessRequests.dataAssetId])
        .from(dataAccessRequests)
        .where(
          and(
            eq(dataAccessRequests.requesterUserId, input.requesterUserId),
            inArray(dataAccessRequests.dataAssetId, input.assetIds),
          ),
        )
        .orderBy(dataAccessRequests.dataAssetId, desc(dataAccessRequests.createdAt)),
      this.db
        .select()
        .from(dataGrants)
        .where(
          and(
            inArray(dataGrants.dataAssetId, input.assetIds),
            isNull(dataGrants.dataAssetVersionId),
            eq(dataGrants.status, "active"),
            subject,
          ),
        ),
      this.db
        .select()
        .from(dataAccessPolicies)
        .where(
          and(
            inArray(dataAccessPolicies.dataAssetId, input.assetIds),
            isNull(dataAccessPolicies.dataAssetVersionId),
            eq(dataAccessPolicies.status, "active"),
            policySubject,
          ),
        ),
    ]);
    const now = new Date();
    const activeUseAssetIds = input.assetIds.filter((assetId) => {
      const currentPolicies = policies.filter(
        (policy) =>
          policy.dataAssetId === assetId &&
          (policy.expiresAt === null || policy.expiresAt > now) &&
          allowsUse(policy.capabilities),
      );
      if (currentPolicies.some((policy) => policy.effect === "deny")) return false;
      return (
        currentPolicies.some((policy) => policy.effect === "allow") ||
        grants.some(
          (grant) =>
            grant.dataAssetId === assetId &&
            grant.startsAt <= now &&
            (grant.expiresAt === null || grant.expiresAt > now) &&
            allowsUse(grant.capabilities),
        )
      );
    });
    return {
      requests: requestRows.map(toAccessRequest),
      activeUseAssetIds,
    };
  }

  async getAccessRequest(requestId: string): Promise<DataAccessRequest | null> {
    const [row] = await this.db
      .select()
      .from(dataAccessRequests)
      .where(eq(dataAccessRequests.id, requestId))
      .limit(1);
    return row ? toAccessRequest(row) : null;
  }

  async getAccessGrant(grantId: string): Promise<DataAccessGrant | null> {
    const [row] = await this.db
      .select()
      .from(dataGrants)
      .where(eq(dataGrants.id, grantId))
      .limit(1);
    return row ? toGrant(row) : null;
  }

  async reviewAccessRequest(input: {
    requestId: string;
    reviewedBy: string;
    review: DataAccessReviewInput;
  }): Promise<{
    request: DataAccessRequest;
    grant: DataAccessGrant | null;
    capabilityChange: {
      previousCapabilities: string[];
      nextCapabilities: string[];
      outboxEnqueued: boolean;
    } | null;
    idempotent: boolean;
  }> {
    return this.db.transaction(async (tx) => {
      const [request] = await tx
        .select()
        .from(dataAccessRequests)
        .where(eq(dataAccessRequests.id, input.requestId))
        .for("update")
        .limit(1);
      if (!request) throw new AppError(ErrorCode.NOT_FOUND, "Data access request not found", 404);
      const targetStatus = input.review.decision === "approve" ? "approved" : "rejected";
      if (request.status !== "pending") {
        if (request.status === targetStatus) {
          const grant =
            request.status === "approved"
              ? await findDataGrant(
                  tx,
                  request.dataAssetId,
                  request.dataAssetVersionId,
                  request.subjectKind,
                  request.subjectId,
                )
              : null;
          return {
            request: toAccessRequest(request),
            grant,
            capabilityChange: null,
            idempotent: true,
          };
        }
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Data access request was already reviewed",
          409,
        );
      }
      const decidedAt = new Date();
      if (input.review.decision === "reject") {
        const [updated] = await tx
          .update(dataAccessRequests)
          .set({
            status: "rejected",
            decisionReason: input.review.reason ?? null,
            decidedBy: input.reviewedBy,
            decidedAt,
            updatedAt: decidedAt,
          })
          .where(eq(dataAccessRequests.id, request.id))
          .returning();
        if (!updated)
          throw new AppError(ErrorCode.INTERNAL_ERROR, "Data access rejection failed", 500);
        return {
          request: toAccessRequest(updated),
          grant: null,
          capabilityChange: null,
          idempotent: false,
        };
      }
      await tx
        .select({ id: dataAssets.id })
        .from(dataAssets)
        .where(eq(dataAssets.id, request.dataAssetId))
        .for("update");
      const existingGrant = await findDataGrant(
        tx,
        request.dataAssetId,
        request.dataAssetVersionId,
        request.subjectKind,
        request.subjectId,
      );
      const previousCapabilities = existingGrant?.capabilities ?? [];
      const grant = existingGrant
        ? await updateDataGrant(
            tx,
            existingGrant.id,
            request.capability,
            input.review,
            input.reviewedBy,
          )
        : await createDataGrant(tx, request, input.review, input.reviewedBy, decidedAt);
      const capabilityChange = {
        previousCapabilities: normalizeDataGrantCapabilities(previousCapabilities),
        nextCapabilities: normalizeDataGrantCapabilities(grant.capabilities),
        outboxEnqueued: true,
      };
      if (grant.versionId === null) {
        await insertAuthzOutbox(
          tx,
          dataAssetGrantDeltaTuples({
            assetId: grant.assetId,
            subjectKind: grant.subjectKind,
            subjectId: grant.subjectId,
            ...capabilityChange,
          }),
        );
      }
      const [updated] = await tx
        .update(dataAccessRequests)
        .set({
          status: "approved",
          decisionReason: input.review.reason ?? null,
          decidedBy: input.reviewedBy,
          decidedAt,
          expiresAt: input.review.expiresAt ?? null,
          updatedAt: decidedAt,
        })
        .where(eq(dataAccessRequests.id, request.id))
        .returning();
      if (!updated)
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data access approval failed", 500);
      return { request: toAccessRequest(updated), grant, capabilityChange, idempotent: false };
    });
  }

  async revokeAccessGrant(input: { grantId: string; revokedBy: string; reason: string }): Promise<{
    grant: DataAccessGrant;
    capabilityChange: {
      previousCapabilities: string[];
      nextCapabilities: string[];
      outboxEnqueued: boolean;
    };
    idempotent: boolean;
  }> {
    return this.db.transaction(async (tx) => {
      const [grant] = await tx
        .select()
        .from(dataGrants)
        .where(eq(dataGrants.id, input.grantId))
        .for("update")
        .limit(1);
      if (!grant) throw new AppError(ErrorCode.NOT_FOUND, "Data access grant not found", 404);
      if (grant.status === "revoked") {
        return {
          grant: toGrant(grant),
          capabilityChange: {
            previousCapabilities: normalizeDataGrantCapabilities(grant.capabilities),
            nextCapabilities: [],
            outboxEnqueued: true,
          },
          idempotent: true,
        };
      }
      if (grant.status !== "active") {
        throw new AppError(ErrorCode.VALIDATION_ERROR, "Data access grant is not active", 409);
      }
      const revokedAt = new Date();
      const [updated] = await tx
        .update(dataGrants)
        .set({ status: "revoked", revokedAt, reason: input.reason })
        .where(eq(dataGrants.id, grant.id))
        .returning();
      if (!updated)
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data access grant revocation failed", 500);
      const capabilityChange = {
        previousCapabilities: normalizeDataGrantCapabilities(grant.capabilities),
        nextCapabilities: [],
        outboxEnqueued: true,
      };
      if (updated.dataAssetVersionId === null) {
        await insertAuthzOutbox(
          tx,
          dataAssetGrantDeltaTuples({
            assetId: updated.dataAssetId,
            subjectKind: updated.subjectKind,
            subjectId: updated.subjectId,
            ...capabilityChange,
          }),
        );
      }
      return { grant: toGrant(updated), capabilityChange, idempotent: false };
    });
  }

  async listReviewingPublicAssets(query: { limit: number; offset: number }) {
    const filter = and(eq(dataAssets.visibility, "public"), eq(dataAssets.lifecycle, "reviewing"));
    const [rows, totalRows] = await Promise.all([
      this.db
        .select()
        .from(dataAssets)
        .where(filter)
        .orderBy(desc(dataAssets.updatedAt))
        .limit(query.limit)
        .offset(query.offset),
      this.db.select({ total: count() }).from(dataAssets).where(filter),
    ]);
    return { assets: rows.map(toAsset), total: totalRows[0]?.total ?? 0 };
  }

  async reviewPublicAsset(input: {
    assetId: string;
    reviewedBy: string;
    review: PublicAssetReviewInput;
  }): Promise<{ asset: DataAsset; idempotent: boolean }> {
    return this.db.transaction(async (tx) => {
      const [asset] = await tx
        .select()
        .from(dataAssets)
        .where(eq(dataAssets.id, input.assetId))
        .for("update")
        .limit(1);
      if (!asset) throw new AppError(ErrorCode.NOT_FOUND, "Data asset not found", 404);
      const targetLifecycle = input.review.decision === "approve" ? "published" : "draft";
      const reviewed = asset.metadata.publicationReview;
      const priorDecision =
        typeof reviewed === "object" && reviewed !== null && "decision" in reviewed
          ? reviewed.decision
          : null;
      if (asset.visibility !== "public") {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Only public data assets can be reviewed",
          409,
        );
      }
      if (asset.lifecycle !== "reviewing") {
        if (asset.lifecycle === targetLifecycle && priorDecision === input.review.decision) {
          return { asset: toAsset(asset), idempotent: true };
        }
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Data asset review conflicts with current lifecycle",
          409,
        );
      }
      const reviewedAt = new Date();
      const [updated] = await tx
        .update(dataAssets)
        .set({
          lifecycle: targetLifecycle,
          metadata: {
            ...asset.metadata,
            publicationReview: {
              decision: input.review.decision,
              reason: input.review.reason,
              reviewedBy: input.reviewedBy,
              reviewedAt: reviewedAt.toISOString(),
            },
          },
          updatedAt: reviewedAt,
        })
        .where(eq(dataAssets.id, asset.id))
        .returning();
      if (!updated) throw new AppError(ErrorCode.INTERNAL_ERROR, "Data asset review failed", 500);
      return { asset: toAsset(updated), idempotent: false };
    });
  }

  async getAsset(assetId: string): Promise<DataAsset | null> {
    const [row] = await this.db
      .select()
      .from(dataAssets)
      .where(eq(dataAssets.id, assetId))
      .limit(1);
    return row ? toAsset(row) : null;
  }

  hasActiveAccess(input: {
    assetId: string;
    actorUserId: string;
    orgIds: string[];
    capability: "view" | "use";
  }): Promise<boolean> {
    return hasActiveDataAccess(this.db, input);
  }

  async getVersion(assetId: string, version: string): Promise<DataAssetVersion | null> {
    const [row] = await this.db
      .select()
      .from(dataAssetVersions)
      .where(
        and(eq(dataAssetVersions.dataAssetId, assetId), eq(dataAssetVersions.version, version)),
      )
      .limit(1);
    return row ? toVersion(row) : null;
  }

  async getVersionById(versionId: string): Promise<DataAssetVersion | null> {
    const [row] = await this.db
      .select()
      .from(dataAssetVersions)
      .where(eq(dataAssetVersions.id, versionId))
      .limit(1);
    return row ? toVersion(row) : null;
  }

  async listFiles(versionId: string): Promise<DataAssetFile[]> {
    const rows = await this.db
      .select()
      .from(dataAssetFiles)
      .where(eq(dataAssetFiles.dataAssetVersionId, versionId))
      .orderBy(dataAssetFiles.path);
    return rows.map((row) => ({
      id: row.id,
      versionId: row.dataAssetVersionId,
      path: row.path,
      checksum: row.digest,
      sizeBytes: row.sizeBytes,
      mediaType: row.mediaType,
      objectKey: typeof row.metadata.objectKey === "string" ? row.metadata.objectKey : null,
    }));
  }

  async createAsset(input: DataAssetInput & { ownerUserId: string }): Promise<DataAsset> {
    const providerOwned = input.providerOrgId !== null && input.providerOrgId !== undefined;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(dataAssets)
        .values({
          ownerKind: providerOwned ? "provider" : "user",
          ownerUserId: providerOwned ? null : input.ownerUserId,
          ownerOrgId: null,
          providerOrgId: providerOwned ? input.providerOrgId : null,
          kind: input.kind,
          name: input.name,
          description: input.description ?? null,
          lifecycle: input.lifecycle ?? "draft",
          visibility: input.visibility,
          accessMode: input.accessMode,
          sensitivity: input.sensitivity,
          metadata: {
            tags: input.tags,
            ...(input.elements && input.elements.length > 0 ? { elements: input.elements } : {}),
          },
          createdBy: input.ownerUserId,
        })
        .returning();
      if (!row) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data asset insert returned no row", 500);
      }
      await insertAuthzOutbox(tx, dataAssetCreationTuples(row));
      return toAsset(row);
    });
  }

  async createVersion(input: DataVersionInput & { createdBy: string }): Promise<DataAssetVersion> {
    const [row] = await this.db
      .insert(dataAssetVersions)
      .values({
        dataAssetId: input.assetId,
        version: input.version,
        status: "draft",
        manifest: {},
        immutableAt: null,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Data version insert returned no row", 500);
    return toVersion(row);
  }

  async createCpLocalImport(input: {
    assetId: string;
    version: string;
    createdBy: string;
    idempotencyKey: string;
    providerOrgId: string;
    agentId: string;
    managedRootId: string;
    relativePath: string;
  }): Promise<{ version: DataAssetVersion; dataImport: DataAssetImport; created: boolean }> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.createdBy}:${input.idempotencyKey}`}, 0))`,
      );
      const [existing] = await tx
        .select({ dataImport: dataAssetImports, root: clusterFileRoots })
        .from(dataAssetImports)
        .leftJoin(clusterFileRoots, eq(dataAssetImports.sourceManagedRootId, clusterFileRoots.id))
        .where(
          and(
            eq(dataAssetImports.requesterUserId, input.createdBy),
            eq(dataAssetImports.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing) {
        if (
          existing.dataImport.targetAssetId !== input.assetId ||
          existing.dataImport.targetVersion !== input.version ||
          existing.dataImport.sourceKind !== "cp-local" ||
          existing.dataImport.sourceManagedRootId !== input.managedRootId ||
          existing.dataImport.sourceRelativePath !== input.relativePath ||
          existing.root?.agentId !== input.agentId ||
          existing.root.providerOrgId !== input.providerOrgId
        ) {
          throw new AppError(
            ErrorCode.VALIDATION_ERROR,
            "Idempotency-Key was already used for a different data import",
            409,
          );
        }
        const [version] = await tx
          .select()
          .from(dataAssetVersions)
          .where(
            and(
              eq(dataAssetVersions.dataAssetId, existing.dataImport.targetAssetId),
              eq(dataAssetVersions.version, existing.dataImport.targetVersion),
            ),
          )
          .limit(1);
        if (!version) {
          throw new AppError(ErrorCode.INTERNAL_ERROR, "Idempotent data version is missing", 500);
        }
        return {
          created: false,
          version: toVersion(version),
          dataImport: toImport(existing.dataImport, existing.root.agentId),
        };
      }
      const [root] = await tx
        .select({ id: clusterFileRoots.id })
        .from(clusterFileRoots)
        .where(
          and(
            eq(clusterFileRoots.id, input.managedRootId),
            eq(clusterFileRoots.agentId, input.agentId),
            eq(clusterFileRoots.providerOrgId, input.providerOrgId),
            eq(clusterFileRoots.enabled, true),
          ),
        )
        .limit(1);
      if (!root) {
        throw new AppError(
          ErrorCode.VALIDATION_ERROR,
          "Managed root is not available for Agent",
          400,
        );
      }
      const [agent] = await tx
        .select({ agentId: agents.agentId })
        .from(agents)
        .where(eq(agents.agentId, input.agentId))
        .limit(1);
      if (!agent) throw new AppError(ErrorCode.VALIDATION_ERROR, "Agent is not registered", 400);
      const [version] = await tx
        .insert(dataAssetVersions)
        .values({
          dataAssetId: input.assetId,
          version: input.version,
          status: "draft",
          manifest: {},
          immutableAt: null,
          createdBy: input.createdBy,
        })
        .returning();
      if (!version) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data version insert returned no row", 500);
      }
      const [dataImport] = await tx
        .insert(dataAssetImports)
        .values({
          targetAssetId: input.assetId,
          targetVersion: input.version,
          sourceKind: "cp-local",
          sourceManagedRootId: input.managedRootId,
          sourceRelativePath: input.relativePath,
          requesterUserId: input.createdBy,
          idempotencyKey: input.idempotencyKey,
          status: "pending",
        })
        .returning();
      if (!dataImport) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, "Data import insert returned no row", 500);
      }
      return {
        created: true,
        version: toVersion(version),
        dataImport: toImport(dataImport, input.agentId),
      };
    });
  }

  async createReplica(
    input: DataReplicaInput & { providerOrgId: string; manifestDigest: string },
  ): Promise<DataAssetReplica> {
    if (input.locationKind === "cp-local" && (!input.managedRootId || !input.relativePath)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "CP-local data replicas require managedRootId and relativePath",
        400,
      );
    }
    const [location] = await this.db
      .insert(dataLocations)
      .values({
        dataAssetVersionId: input.versionId,
        providerOrgId: input.providerOrgId,
        siteId: input.siteId,
        agentId: input.agentId,
        managedRootId: input.locationKind === "cp-local" ? (input.managedRootId ?? null) : null,
        relativePath: input.locationKind === "cp-local" ? (input.relativePath ?? null) : null,
        kind: input.locationKind,
        uri:
          input.locationKind === "cp-local"
            ? null
            : `data-market://${input.versionId}/${input.siteId}`,
        status: "available",
      })
      .returning();
    if (!location)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Data location insert returned no row", 500);
    const [replica] = await this.db
      .insert(dataReplicas)
      .values({
        dataAssetVersionId: input.versionId,
        targetLocationId: location.id,
        targetSiteId: input.siteId,
        manifestDigest: input.manifestDigest,
        status: "pending",
      })
      .returning();
    if (!replica)
      throw new AppError(ErrorCode.INTERNAL_ERROR, "Data replica insert returned no row", 500);
    return {
      id: replica.id,
      versionId: input.versionId,
      providerOrgId: input.providerOrgId,
      agentId: input.agentId,
      siteId: input.siteId,
      clusterId: input.clusterId,
      status: replica.status as DataAssetReplica["status"],
      locationKind: input.locationKind,
      verifiedAt: replica.verifiedAt,
    };
  }

  async createAccessRequest(input: {
    assetId: string;
    requesterUserId: string;
    requesterOrgId: string | null;
    reason: string | null;
  }): Promise<DataAccessRequest> {
    const [row] = await this.db
      .insert(dataAccessRequests)
      .values({
        dataAssetId: input.assetId,
        dataAssetVersionId: null,
        capability: "use",
        requesterUserId: input.requesterUserId,
        requesterOrgId: input.requesterOrgId,
        subjectKind: "user",
        subjectId: input.requesterUserId,
        reason: input.reason,
      })
      .returning();
    if (!row)
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "Data access request insert returned no row",
        500,
      );
    return toAccessRequest(row);
  }

  runIdempotent<T>(input: { scope: string; key: string; create: () => Promise<T> }): Promise<T> {
    const id = `${input.scope}:${input.key}`;
    const existing = this.idempotent.get(id) as Promise<T> | undefined;
    if (existing) return existing;
    const created = input.create();
    this.idempotent.set(id, created);
    return created.catch((error) => {
      this.idempotent.delete(id);
      throw error;
    });
  }
}

function allowsUse(capabilities: string[]): boolean {
  return capabilities.some((capability) =>
    ["use", "download", "derive", "manage"].includes(capability),
  );
}

function toAsset(row: typeof dataAssets.$inferSelect): DataAsset {
  const tags = Array.isArray(row.metadata.tags)
    ? row.metadata.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  const elements = Array.isArray(row.metadata.elements)
    ? row.metadata.elements.filter((element): element is string => typeof element === "string")
    : [];
  return {
    id: row.id,
    providerOrgId: row.providerOrgId,
    ownerUserId: row.ownerUserId,
    ownerOrgId: row.ownerOrgId,
    ownerKind: row.ownerKind as DataAsset["ownerKind"],
    kind: row.kind as DataAsset["kind"],
    name: row.name,
    description: row.description,
    visibility: row.visibility as DataAsset["visibility"],
    lifecycle: row.lifecycle as DataAsset["lifecycle"],
    accessMode: row.accessMode as DataAsset["accessMode"],
    sensitivity: row.sensitivity as DataAsset["sensitivity"],
    tags,
    elements,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toVersion(row: typeof dataAssetVersions.$inferSelect): DataAssetVersion {
  return {
    id: row.id,
    assetId: row.dataAssetId,
    version: row.version,
    status: row.status as DataAssetVersion["status"],
    manifestDigest: row.manifestDigest,
    manifest: row.manifest,
    immutableAt: row.immutableAt,
    createdBy: row.createdBy ?? "",
    createdAt: row.createdAt,
  };
}

function toImport(
  row: typeof dataAssetImports.$inferSelect,
  agentId: string | null = null,
): DataAssetImport {
  return {
    id: row.id,
    assetId: row.targetAssetId,
    version: row.targetVersion,
    sourceKind: row.sourceKind as DataAssetImport["sourceKind"],
    status: row.status as DataAssetImport["status"],
    agentId,
    managedRootId: row.sourceManagedRootId,
    relativePath: row.sourceRelativePath,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
  };
}

type DbTransaction = Parameters<Parameters<PgDb["transaction"]>[0]>[0];

function toAccessRequest(row: typeof dataAccessRequests.$inferSelect): DataAccessRequest {
  return {
    id: row.id,
    assetId: row.dataAssetId,
    requesterUserId: row.requesterUserId,
    requesterOrgId: row.requesterOrgId,
    status: row.status as DataAccessRequest["status"],
    reason: row.reason,
    reviewedBy: row.decidedBy,
    reviewedAt: row.decidedAt,
    createdAt: row.createdAt,
    capability: row.capability as DataAccessRequest["capability"],
    subjectKind: row.subjectKind as DataAccessRequest["subjectKind"],
    subjectId: row.subjectId,
    decisionReason: row.decisionReason,
    expiresAt: row.expiresAt,
  };
}

async function findDataGrant(
  tx: DbTransaction,
  assetId: string,
  versionId: string | null,
  subjectKind: string,
  subjectId: string,
): Promise<DataAccessGrant | null> {
  const [row] = await tx
    .select()
    .from(dataGrants)
    .where(
      and(
        eq(dataGrants.dataAssetId, assetId),
        versionId === null
          ? isNull(dataGrants.dataAssetVersionId)
          : eq(dataGrants.dataAssetVersionId, versionId),
        eq(dataGrants.subjectKind, subjectKind),
        eq(dataGrants.subjectId, subjectId),
      ),
    )
    .limit(1);
  return row ? toGrant(row) : null;
}

async function createDataGrant(
  tx: DbTransaction,
  request: typeof dataAccessRequests.$inferSelect,
  review: DataAccessReviewInput,
  reviewedBy: string,
  startsAt: Date,
): Promise<DataAccessGrant> {
  const [row] = await tx
    .insert(dataGrants)
    .values({
      dataAssetId: request.dataAssetId,
      dataAssetVersionId: request.dataAssetVersionId,
      subjectKind: request.subjectKind,
      subjectId: request.subjectId,
      capabilities: [request.capability],
      status: "active",
      reason: review.reason ?? null,
      grantedBy: reviewedBy,
      startsAt,
      expiresAt: review.expiresAt ?? null,
    })
    .returning();
  if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR, "Data grant insert failed", 500);
  return toGrant(row);
}

async function updateDataGrant(
  tx: DbTransaction,
  grantId: string,
  capability: string,
  review: DataAccessReviewInput,
  reviewedBy: string,
): Promise<DataAccessGrant> {
  const [row] = await tx
    .update(dataGrants)
    .set({
      capabilities: [capability],
      status: "active",
      reason: review.reason ?? null,
      grantedBy: reviewedBy,
      expiresAt: review.expiresAt ?? null,
      revokedAt: null,
    })
    .where(eq(dataGrants.id, grantId))
    .returning();
  if (!row) throw new AppError(ErrorCode.INTERNAL_ERROR, "Data grant update failed", 500);
  return toGrant(row);
}

function toGrant(row: typeof dataGrants.$inferSelect): DataAccessGrant {
  return {
    id: row.id,
    assetId: row.dataAssetId,
    versionId: row.dataAssetVersionId,
    subjectKind: row.subjectKind as DataAccessGrant["subjectKind"],
    subjectId: row.subjectId,
    capabilities: row.capabilities,
    status: row.status as DataAccessGrant["status"],
    reason: row.reason,
    grantedBy: row.grantedBy,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

function dataAssetCreationTuples(row: typeof dataAssets.$inferSelect): AuthzTuple[] {
  const tuples: AuthzTuple[] = [dataAssetPlatformTuple(row.id)];
  if (row.ownerKind === "user" && row.ownerUserId) {
    tuples.push(dataAssetOwnerTuple({ assetId: row.id, userId: row.ownerUserId }));
  }
  if (row.ownerKind === "org" && row.ownerOrgId) {
    tuples.push(dataAssetOwnerOrgTuple({ assetId: row.id, orgId: row.ownerOrgId }));
  }
  if (row.ownerKind === "provider" && row.providerOrgId) {
    tuples.push(dataAssetProviderTuple({ assetId: row.id, providerOrgId: row.providerOrgId }));
  }
  if (row.visibility === "public" && row.lifecycle === "published") {
    tuples.push(...dataAssetPublicTuples({ assetId: row.id, accessMode: row.accessMode }));
  }
  return tuples;
}

async function insertAuthzOutbox(tx: DbTransaction, tuples: AuthzTuple[]): Promise<void> {
  if (tuples.length === 0) return;
  await tx.insert(authzOutbox).values(
    tuples.map((tuple) => ({
      operation: tuple.operation,
      resourceType: tuple.resource.type,
      resourceId: tuple.resource.id,
      relation: tuple.relation,
      subjectType: tuple.subject.type,
      subjectId: tuple.subject.id,
      subjectRelation: tuple.subject.relation ?? null,
      payload: tuple.payload ?? {},
    })),
  );
}
