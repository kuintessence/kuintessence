import {
  AppError,
  type DataAccessMode,
  type DataAccessRequestStatus,
  DataAssetEntryPathSchema,
  type DataAssetKind,
  type DataAssetLifecycle,
  type DataAssetOwnerKind,
  type DataAssetVersionStatus,
  type DataLocationKind,
  type DataReplicaStatus,
  type DataSensitivity,
  type DataVisibility,
  ErrorCode,
  hasRole,
  type RoleName,
} from "@kuintessence/shared";
import {
  dataAssetGrantDeltaTuples,
  dataAssetPublicTuples,
  normalizeDataGrantCapabilities,
} from "../authz/projection";
import type { AuthzTuple } from "../authz/service";
import type { DataGrantRevocationCoordinator } from "./data-delivery-revocations";
import type { DataScanCoordinator } from "./data-scan-coordinator";

export type DataAssetVisibility = DataVisibility;
export type DataAssetStatus = DataAssetLifecycle;

export interface DataMarketActor {
  userId: string;
  role: RoleName;
  orgId: string | null;
  orgIds: string[];
  providerManagerOrgIds?: string[];
}

export interface DataAsset {
  id: string;
  providerOrgId: string | null;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  ownerKind: DataAssetOwnerKind;
  kind: DataAssetKind;
  name: string;
  description: string | null;
  visibility: DataAssetVisibility;
  lifecycle: DataAssetStatus;
  accessMode: DataAccessMode;
  sensitivity: DataSensitivity;
  tags: string[];
  elements?: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DataAssetVersion {
  id: string;
  assetId: string;
  version: string;
  status: DataAssetVersionStatus;
  manifestDigest: string | null;
  manifest: DataManifest | Record<string, unknown>;
  immutableAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface DataManifest {
  checksum: string;
  sizeBytes: number;
  mediaType: string;
  source: DataLocationKind;
}

export interface DataAssetFile {
  id: string;
  versionId: string;
  path: string;
  checksum: string;
  sizeBytes: number;
  mediaType: string | null;
  objectKey: string | null;
}

export interface DataAssetReplica {
  id: string;
  versionId: string;
  providerOrgId: string;
  agentId: string;
  siteId: string;
  clusterId: string;
  status: DataReplicaStatus;
  locationKind: DataLocationKind;
  verifiedAt: Date | null;
}

export interface DataAccessRequest {
  id: string;
  assetId: string;
  requesterUserId: string;
  requesterOrgId: string | null;
  status: DataAccessRequestStatus;
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  capability: "view" | "use" | "download" | "derive" | "manage";
  subjectKind: "user" | "org";
  subjectId: string;
  decisionReason: string | null;
  expiresAt: Date | null;
}

export interface DataAccessGrant {
  id: string;
  assetId: string;
  versionId: string | null;
  subjectKind: "user" | "org";
  subjectId: string;
  capabilities: string[];
  status: "active" | "revoked" | "expired";
  reason?: string | null;
  grantedBy?: string | null;
  expiresAt: Date | null;
  revokedAt?: Date | null;
}

export interface DataAccessReviewInput {
  decision: "approve" | "reject";
  reason?: string | null;
  expiresAt?: Date | null;
}

export interface DataGrantCapabilityChange {
  previousCapabilities: string[];
  nextCapabilities: string[];
  outboxEnqueued: boolean;
}

export interface PublicAssetReviewInput {
  decision: "approve" | "reject";
  reason: string;
}

export interface DataUploadSession {
  id: string;
  assetId: string;
  version: string;
  locationKind: "platform-object" | "user-private-object";
  objectKey: string;
  uploadUrl: string;
  expiresAt: Date;
}

export interface DataAssetInput {
  name: string;
  description?: string | null;
  visibility: DataAssetVisibility;
  kind: DataAssetKind;
  lifecycle?: DataAssetLifecycle;
  accessMode: DataAccessMode;
  sensitivity: DataSensitivity;
  tags: string[];
  elements?: string[];
  providerOrgId?: string | null;
}

export interface DataVersionInput {
  assetId: string;
  version: string;
  manifest: DataManifest;
  files: Array<Omit<DataAssetFile, "id" | "versionId">>;
}

export interface DataReplicaInput {
  versionId: string;
  agentId: string;
  siteId: string;
  clusterId: string;
  locationKind: DataLocationKind;
  managedRootId?: string;
  relativePath?: string;
}

export interface DataAssetListQuery {
  query?: string;
  tag?: string;
  limit: number;
  offset: number;
}

export interface DataAssetPageQuery {
  limit: number;
  offset: number;
}

export interface DataAssetImport {
  id: string;
  assetId: string;
  version: string;
  sourceKind: "platform-object" | "netdrive" | "cp-local";
  status: "pending" | "running" | "completed" | "failed" | "canceled";
  agentId: string | null;
  managedRootId: string | null;
  relativePath: string | null;
  errorMessage: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export type CpDataImportSource =
  | { kind: "platform-object"; uploadSessionId: string }
  | { kind: "netdrive"; netdriveFileId: string }
  | {
      kind: "cp-local";
      agentId: string;
      managedRootId: string;
      relativePath: string;
    };

export interface CpDataImportInput {
  assetId: string;
  version: string;
  source: CpDataImportSource;
}

export interface DataMarketRepository {
  listCatalogCandidates(query: Pick<DataAssetListQuery, "query" | "tag">): Promise<DataAsset[]>;
  listProviderAssets(
    providerOrgIds: string[],
    query: DataAssetListQuery,
  ): Promise<{ assets: DataAsset[]; total: number }>;
  listVersions(
    assetId: string,
    query: DataAssetPageQuery,
  ): Promise<{ versions: DataAssetVersion[]; total: number }>;
  listReplicas(
    versionId: string,
    query: DataAssetPageQuery,
  ): Promise<{ replicas: DataAssetReplica[]; total: number }>;
  listImports(
    providerOrgIds: string[],
    query: DataAssetPageQuery,
  ): Promise<{ imports: DataAssetImport[]; total: number }>;
  listAccessRequests(input: {
    providerOrgIds: string[];
    status?: DataAccessRequestStatus;
    limit: number;
    offset: number;
  }): Promise<{ requests: DataAccessRequest[]; total: number }>;
  getAccessState(input: {
    requesterUserId: string;
    orgIds: string[];
    assetIds: string[];
  }): Promise<{ requests: DataAccessRequest[]; activeUseAssetIds: string[] }>;
  getAccessRequest(requestId: string): Promise<DataAccessRequest | null>;
  getAccessGrant(grantId: string): Promise<DataAccessGrant | null>;
  reviewAccessRequest(input: {
    requestId: string;
    reviewedBy: string;
    review: DataAccessReviewInput;
  }): Promise<{
    request: DataAccessRequest;
    grant: DataAccessGrant | null;
    capabilityChange: DataGrantCapabilityChange | null;
    idempotent: boolean;
  }>;
  revokeAccessGrant(input: { grantId: string; revokedBy: string; reason: string }): Promise<{
    grant: DataAccessGrant;
    capabilityChange: DataGrantCapabilityChange;
    idempotent: boolean;
  }>;
  listReviewingPublicAssets(
    query: DataAssetPageQuery,
  ): Promise<{ assets: DataAsset[]; total: number }>;
  reviewPublicAsset(input: {
    assetId: string;
    reviewedBy: string;
    review: PublicAssetReviewInput;
  }): Promise<{ asset: DataAsset; idempotent: boolean }>;
  hasActiveAccess(input: {
    assetId: string;
    actorUserId: string;
    orgIds: string[];
    capability: "view" | "use";
  }): Promise<boolean>;
  getAsset(assetId: string): Promise<DataAsset | null>;
  getVersion(assetId: string, version: string): Promise<DataAssetVersion | null>;
  getVersionById(versionId: string): Promise<DataAssetVersion | null>;
  listFiles(versionId: string): Promise<DataAssetFile[]>;
  createAsset(input: DataAssetInput & { ownerUserId: string }): Promise<DataAsset>;
  createVersion(input: DataVersionInput & { createdBy: string }): Promise<DataAssetVersion>;
  createCpLocalImport(input: {
    assetId: string;
    version: string;
    createdBy: string;
    idempotencyKey: string;
    providerOrgId: string;
    agentId: string;
    managedRootId: string;
    relativePath: string;
  }): Promise<{ version: DataAssetVersion; dataImport: DataAssetImport; created: boolean }>;
  createReplica(
    input: DataReplicaInput & { providerOrgId: string; manifestDigest: string },
  ): Promise<DataAssetReplica>;
  createAccessRequest(input: {
    assetId: string;
    requesterUserId: string;
    requesterOrgId: string | null;
    reason: string | null;
  }): Promise<DataAccessRequest>;
  runIdempotent<T>(input: { scope: string; key: string; create: () => Promise<T> }): Promise<T>;
}

export interface DataUploadPort {
  createUploadSession(input: {
    assetId: string;
    version: string;
    ownerUserId: string;
    locationKind: "platform-object" | "user-private-object";
    objectPath: string;
    sizeBytes: number;
    mediaType: string;
  }): Promise<DataUploadSession>;
  getUploadSessionAsset(input: { sessionId: string; ownerUserId: string }): Promise<string>;
  commitUploadSession(input: {
    sessionId: string;
    ownerUserId: string;
    sha256?: string;
  }): Promise<DataAssetVersion>;
}

export interface DataMarketAuthzHook {
  check(input: {
    actor: DataMarketActor;
    asset: DataAsset;
    permission: "view" | "use" | "manage";
    localAllowed: boolean;
  }): Promise<boolean>;
}

export interface DataMarketServiceDeps {
  repository: DataMarketRepository;
  uploadPort: DataUploadPort;
  authz?: DataMarketAuthzHook;
  dataScanCoordinator?: Pick<DataScanCoordinator, "requestScan"> &
    Partial<Pick<DataScanCoordinator, "requestScanIfMissing">>;
  grantProjector?: {
    enqueueMany(tuples: AuthzTuple[]): Promise<void>;
    mode?: string;
    processOutbox?(
      limit?: number,
      options?: { forcePending?: boolean; resourceType?: string; resourceId?: string },
    ): Promise<unknown>;
  };
  audit?: Pick<
    {
      record(input: {
        actor: string;
        action: string;
        target: string;
        before: unknown;
        after: unknown;
      }): Promise<void>;
    },
    "record"
  >;
  deliveryRevoker?: {
    revoke(input: {
      assetId: string;
      versionId?: string | null;
      reasonCode: string;
    }): Promise<number>;
  };
  grantRevocationCoordinator?: Pick<DataGrantRevocationCoordinator, "revoke">;
}

export class DataMarketService {
  constructor(private readonly deps: DataMarketServiceDeps) {}

  async listCatalog(actor: DataMarketActor, query: DataAssetListQuery) {
    const candidates = await this.deps.repository.listCatalogCandidates(query);
    const visible = await filterAsync(candidates, async (asset) =>
      this.authorize(actor, asset, "view"),
    );
    return {
      assets: visible.slice(query.offset, query.offset + query.limit),
      total: visible.length,
      limit: query.limit,
      offset: query.offset,
    };
  }

  async getAsset(actor: DataMarketActor, assetId: string): Promise<DataAsset> {
    const asset = await this.requireAsset(assetId);
    await this.assertAuthorized(actor, asset, "view");
    return asset;
  }

  async getVersion(actor: DataMarketActor, assetId: string, version: string) {
    const asset = await this.getAsset(actor, assetId);
    const value = await this.deps.repository.getVersion(asset.id, version);
    if (!value) throw new AppError(ErrorCode.NOT_FOUND, "Data asset version not found", 404);
    return value;
  }

  async listProviderAssets(actor: DataMarketActor, query: DataAssetListQuery) {
    assertCpDataManager(actor);
    const result = await this.deps.repository.listProviderAssets(actor.orgIds, query);
    return { ...result, limit: query.limit, offset: query.offset };
  }

  async listProviderVersions(actor: DataMarketActor, assetId: string, query: DataAssetPageQuery) {
    const asset = await this.requireProviderManagedAsset(actor, assetId);
    const result = await this.deps.repository.listVersions(asset.id, query);
    return { ...result, limit: query.limit, offset: query.offset };
  }

  async listProviderReplicas(actor: DataMarketActor, versionId: string, query: DataAssetPageQuery) {
    const version = await this.findVersionById(versionId);
    await this.requireProviderManagedAsset(actor, version.assetId);
    const result = await this.deps.repository.listReplicas(version.id, query);
    return { ...result, limit: query.limit, offset: query.offset };
  }

  async listProviderImports(actor: DataMarketActor, query: DataAssetPageQuery) {
    assertCpDataManager(actor);
    const result = await this.deps.repository.listImports(actor.orgIds, query);
    return { ...result, limit: query.limit, offset: query.offset };
  }

  async startProviderImport(
    actor: DataMarketActor,
    input: CpDataImportInput,
    idempotencyKey: string,
  ) {
    const source = input.source;
    if (source.kind === "netdrive") {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "DATA_IMPORT_UNAVAILABLE: NetDrive copy backend is not configured",
        503,
      );
    }
    if (source.kind === "platform-object") {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "DATA_IMPORT_UNAVAILABLE: platform-object upload commit is not configured",
        503,
      );
    }
    const asset = await this.requireProviderManagedAsset(actor, input.assetId);
    const coordinator = this.deps.dataScanCoordinator;
    if (!coordinator) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "DATA_IMPORT_UNAVAILABLE: CP-local scan coordinator is not configured",
        503,
      );
    }
    const created = await this.deps.repository.createCpLocalImport({
      assetId: asset.id,
      version: input.version,
      createdBy: actor.userId,
      idempotencyKey,
      agentId: source.agentId,
      providerOrgId: asset.providerOrgId ?? "",
      managedRootId: source.managedRootId,
      relativePath: source.relativePath,
    });
    if (!created.created) {
      if (created.dataImport.status === "pending" && coordinator.requestScanIfMissing) {
        const recovered = await coordinator.requestScanIfMissing({
          requestId: created.dataImport.id,
          importId: created.dataImport.id,
          assetId: asset.id,
          versionId: created.version.id,
          agentId: source.agentId,
          providerOrgId: asset.providerOrgId ?? "",
          managedRootId: source.managedRootId,
          relativePath: source.relativePath,
        });
        if (recovered !== null) {
          return {
            dataImport: created.dataImport,
            dispatchState: recovered ? ("dispatched" as const) : ("queued" as const),
            replayed: true,
            version: created.version,
          };
        }
      }
      return {
        dataImport: created.dataImport,
        dispatchState:
          created.dataImport.status === "pending" ? ("queued" as const) : ("dispatched" as const),
        replayed: true,
        version: created.version,
      };
    }
    const dispatched = await coordinator.requestScan({
      requestId: created.dataImport.id,
      importId: created.dataImport.id,
      assetId: asset.id,
      versionId: created.version.id,
      agentId: source.agentId,
      providerOrgId: asset.providerOrgId ?? "",
      managedRootId: source.managedRootId,
      relativePath: source.relativePath,
    });
    return {
      dataImport: created.dataImport,
      dispatchState: dispatched ? ("dispatched" as const) : ("queued" as const),
      replayed: false,
      version: created.version,
    };
  }

  async listFiles(actor: DataMarketActor, assetId: string, version: string) {
    const value = await this.getVersion(actor, assetId, version);
    return this.deps.repository.listFiles(value.id);
  }

  async createPrivateAsset(actor: DataMarketActor, input: DataAssetInput, idempotencyKey: string) {
    const elements = normalizeChemicalElements(input.elements ?? []);
    const licensedMaterial = input.kind === "licensed-material";
    if (licensedMaterial && elements.length === 0) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Licensed material requires at least one chemical element",
        400,
      );
    }
    const value = {
      ...input,
      elements,
      visibility: "private" as const,
      providerOrgId: null,
      ...(licensedMaterial
        ? { accessMode: "entitlement" as const, sensitivity: "restricted" as const }
        : {}),
    };
    const asset = await this.idempotent(`data-asset:create:${actor.userId}`, idempotencyKey, () =>
      this.deps.repository.createAsset({ ...value, ownerUserId: actor.userId }),
    );
    await this.flushCreatedAssetProjection(actor, asset);
    return asset;
  }

  async createProviderAsset(actor: DataMarketActor, input: DataAssetInput, idempotencyKey: string) {
    if (input.visibility === "private") {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Provider assets cannot use private visibility",
        400,
      );
    }
    const providerOrgId = input.providerOrgId ?? actor.orgId;
    if (!providerOrgId) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "providerOrgId is required", 400);
    }
    assertProviderManager(actor, providerOrgId);
    const lifecycle =
      input.visibility === "public" && !hasRole(actor.role, "platform_admin")
        ? "reviewing"
        : (input.lifecycle ?? "published");
    const asset = await this.idempotent(`data-asset:create:${providerOrgId}`, idempotencyKey, () =>
      this.deps.repository.createAsset({
        ...input,
        elements: normalizeChemicalElements(input.elements ?? []),
        lifecycle,
        providerOrgId,
        ownerUserId: actor.userId,
      }),
    );
    await this.flushCreatedAssetProjection(actor, asset);
    return asset;
  }

  async listProviderAccessRequests(
    actor: DataMarketActor,
    input: { status?: DataAccessRequestStatus; limit: number; offset: number },
  ) {
    assertCpDataManager(actor);
    const result = await this.deps.repository.listAccessRequests({
      providerOrgIds: actor.orgIds,
      ...input,
    });
    return { ...result, limit: input.limit, offset: input.offset };
  }

  async getMyAccessState(actor: DataMarketActor, assetIds: string[]) {
    return this.deps.repository.getAccessState({
      requesterUserId: actor.userId,
      orgIds: actor.orgIds,
      assetIds: [...new Set(assetIds)],
    });
  }

  async getProviderAccessRequest(actor: DataMarketActor, requestId: string) {
    const request = await this.requireAccessRequest(requestId);
    await this.requireProviderManagedAsset(actor, request.assetId);
    return request;
  }

  async reviewProviderAccessRequest(
    actor: DataMarketActor,
    requestId: string,
    review: DataAccessReviewInput,
  ) {
    const existing = await this.requireAccessRequest(requestId);
    await this.requireProviderManagedAsset(actor, existing.assetId);
    const result = await this.deps.repository.reviewAccessRequest({
      requestId,
      reviewedBy: actor.userId,
      review,
    });
    await this.projectGrantChange(result.grant, result.capabilityChange, result.idempotent);
    return result;
  }

  async requestOwnerEntitlement(
    actor: DataMarketActor,
    assetId: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<DataAccessRequest> {
    const asset = await this.requirePrivateLicensedAsset(assetId);
    if (asset.ownerUserId !== actor.userId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Only the private asset owner may request entitlement",
        403,
      );
    }
    if (
      await this.deps.repository.hasActiveAccess({
        assetId: asset.id,
        actorUserId: actor.userId,
        orgIds: actor.orgIds,
        capability: "use",
      })
    ) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Owner entitlement is already active", 409);
    }
    return this.idempotent(
      `data-owner-entitlement:${asset.id}:${actor.userId}`,
      idempotencyKey,
      async () => {
        const request = await this.deps.repository.createAccessRequest({
          assetId: asset.id,
          requesterUserId: actor.userId,
          requesterOrgId: null,
          reason,
        });
        await this.deps.audit?.record({
          actor: actor.userId,
          action: "data_market.owner_entitlement_requested",
          target: asset.id,
          before: null,
          after: { requestId: request.id, reason },
        });
        return request;
      },
    );
  }

  async reviewOwnerEntitlement(
    actor: DataMarketActor,
    requestId: string,
    review: DataAccessReviewInput,
  ) {
    assertPlatformAdmin(actor);
    const request = await this.requireAccessRequest(requestId);
    const asset = await this.requirePrivateLicensedAsset(request.assetId);
    if (
      request.requesterUserId !== asset.ownerUserId ||
      request.subjectKind !== "user" ||
      request.subjectId !== asset.ownerUserId ||
      request.capability !== "use"
    ) {
      throw new AppError(ErrorCode.FORBIDDEN, "Request is not an owner entitlement request", 403);
    }
    const result = await this.deps.repository.reviewAccessRequest({
      requestId,
      reviewedBy: actor.userId,
      review,
    });
    await this.projectGrantChange(result.grant, result.capabilityChange, result.idempotent);
    if (!result.idempotent) {
      await this.deps.audit?.record({
        actor: actor.userId,
        action: "data_market.owner_entitlement_reviewed",
        target: asset.id,
        before: { requestId, status: "pending" },
        after: {
          decision: review.decision,
          reason: review.reason ?? null,
          grantId: result.grant?.id,
          capabilities: result.capabilityChange,
        },
      });
    }
    return result;
  }

  async revokeOwnerEntitlement(actor: DataMarketActor, grantId: string, reason: string) {
    assertPlatformAdmin(actor);
    const grant = await this.deps.repository.getAccessGrant(grantId);
    if (!grant) throw new AppError(ErrorCode.NOT_FOUND, "Data access grant not found", 404);
    const asset = await this.requirePrivateLicensedAsset(grant.assetId);
    if (grant.subjectKind !== "user" || grant.subjectId !== asset.ownerUserId) {
      throw new AppError(ErrorCode.FORBIDDEN, "Grant is not an owner entitlement", 403);
    }
    const result = this.deps.grantRevocationCoordinator
      ? await this.deps.grantRevocationCoordinator.revoke({ grantId, reason })
      : await this.deps.repository.revokeAccessGrant({
          grantId,
          revokedBy: actor.userId,
          reason,
        });
    if (!result.idempotent) {
      await this.projectGrantChange(result.grant, result.capabilityChange, false);
      await this.deps.audit?.record({
        actor: actor.userId,
        action: "data_market.owner_entitlement_revoked",
        target: asset.id,
        before: {
          grantId,
          status: "active",
          capabilities: result.capabilityChange.previousCapabilities,
        },
        after: {
          grantId,
          status: "revoked",
          capabilities: result.capabilityChange.nextCapabilities,
          reason,
        },
      });
      if (!this.deps.grantRevocationCoordinator) {
        await this.deps.deliveryRevoker?.revoke({
          assetId: result.grant.assetId,
          versionId: result.grant.versionId,
          reasonCode: "DATA_GRANT_REVOKED",
        });
      }
    }
    return result;
  }

  async listReviewingPublicAssets(actor: DataMarketActor, query: DataAssetPageQuery) {
    assertPlatformAdmin(actor);
    const result = await this.deps.repository.listReviewingPublicAssets(query);
    return { ...result, limit: query.limit, offset: query.offset };
  }

  async reviewPublicAsset(actor: DataMarketActor, assetId: string, review: PublicAssetReviewInput) {
    assertPlatformAdmin(actor);
    const result = await this.deps.repository.reviewPublicAsset({
      assetId,
      reviewedBy: actor.userId,
      review,
    });
    if (!result.idempotent && review.decision === "approve") {
      await this.deps.grantProjector?.enqueueMany(
        dataAssetPublicTuples({
          assetId: result.asset.id,
          accessMode: result.asset.accessMode,
        }),
      );
    }
    if (!result.idempotent) {
      await this.deps.audit?.record({
        actor: actor.userId,
        action: "data_market.publication_review",
        target: result.asset.id,
        before: { lifecycle: "reviewing" },
        after: {
          lifecycle: result.asset.lifecycle,
          decision: review.decision,
          reason: review.reason,
        },
      });
    }
    return result;
  }

  async createUploadSession(
    actor: DataMarketActor,
    input: {
      assetId: string;
      version: string;
      path: string;
      sizeBytes: number;
      mediaType: string;
    },
    idempotencyKey: string,
  ) {
    assertDataAssetEntryPath(input.path);
    const asset = await this.requireAsset(input.assetId);
    await this.assertAuthorized(actor, asset, "manage");
    return this.idempotent(`data-upload:${asset.id}:${input.version}`, idempotencyKey, () =>
      this.deps.uploadPort.createUploadSession({
        assetId: asset.id,
        version: input.version,
        ownerUserId: actor.userId,
        locationKind: asset.visibility === "private" ? "user-private-object" : "platform-object",
        objectPath: input.path,
        sizeBytes: input.sizeBytes,
        mediaType: input.mediaType,
      }),
    );
  }

  async commitUploadSession(actor: DataMarketActor, sessionId: string, sha256?: string) {
    const assetId = await this.deps.uploadPort.getUploadSessionAsset({
      sessionId,
      ownerUserId: actor.userId,
    });
    await this.assertAuthorized(actor, await this.requireAsset(assetId), "manage");
    return this.deps.uploadPort.commitUploadSession({
      sessionId,
      ownerUserId: actor.userId,
      sha256,
    });
  }

  async importVersion(actor: DataMarketActor, input: DataVersionInput, idempotencyKey: string) {
    for (const file of input.files) assertDataAssetEntryPath(file.path);
    const asset = await this.requireAsset(input.assetId);
    await this.assertAuthorized(actor, asset, "manage");
    return this.idempotent(`data-version:${asset.id}:${input.version}`, idempotencyKey, () =>
      this.deps.repository.createVersion({ ...input, createdBy: actor.userId }),
    );
  }

  async createReplica(actor: DataMarketActor, input: DataReplicaInput, _idempotencyKey: string) {
    const version = await this.findVersionById(input.versionId);
    if (version.status !== "ready" || !version.manifestDigest) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Data replica requires a ready version", 409);
    }
    const asset = await this.requireAsset(version.assetId);
    await this.assertAuthorized(actor, asset, "manage");
    const providerOrgId = asset.providerOrgId;
    if (!providerOrgId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Private assets cannot create CP replicas",
        400,
      );
    }
    assertProviderManager(actor, providerOrgId);
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      "DATA_REPLICA_UNAVAILABLE: replica coordinator is not configured",
      501,
    );
  }

  async requestAccess(
    actor: DataMarketActor,
    assetId: string,
    reason: string | null,
    idempotencyKey: string,
  ) {
    const asset = await this.requireAsset(assetId);
    if (asset.visibility === "private") {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Private data assets cannot be requested or shared",
        403,
      );
    }
    if (await this.authorize(actor, asset, "use")) {
      throw new AppError(ErrorCode.VALIDATION_ERROR, "Data access is already granted", 400);
    }
    return this.idempotent(`data-access:${asset.id}:${actor.userId}`, idempotencyKey, () =>
      this.deps.repository.createAccessRequest({
        assetId: asset.id,
        requesterUserId: actor.userId,
        requesterOrgId: actor.orgId,
        reason,
      }),
    );
  }

  private async requireAsset(assetId: string): Promise<DataAsset> {
    const asset = await this.deps.repository.getAsset(assetId);
    if (!asset) throw new AppError(ErrorCode.NOT_FOUND, "Data asset not found", 404);
    return asset;
  }

  private async projectGrantChange(
    grant: DataAccessGrant | null,
    change: DataGrantCapabilityChange | null,
    idempotent: boolean,
  ): Promise<void> {
    if (idempotent || !grant || !change) return;
    if (change.outboxEnqueued) return;
    const tuples = dataAssetGrantDeltaTuples({
      assetId: grant.assetId,
      subjectKind: grant.subjectKind,
      subjectId: grant.subjectId,
      previousCapabilities: normalizeDataGrantCapabilities(change.previousCapabilities),
      nextCapabilities: normalizeDataGrantCapabilities(change.nextCapabilities),
    });
    if (tuples.length === 0) return;
    if (!this.deps.grantProjector) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        "DATA_AUTHZ_PROJECTION_UNAVAILABLE: capability change was not durably enqueued",
        503,
      );
    }
    await this.deps.grantProjector.enqueueMany(tuples);
  }

  private async requireProviderManagedAsset(
    actor: DataMarketActor,
    assetId: string,
  ): Promise<DataAsset> {
    const asset = await this.requireAsset(assetId);
    if (!asset.providerOrgId) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "CP data operations require a provider asset",
        400,
      );
    }
    if (actor.orgId && asset.providerOrgId !== actor.orgId) {
      throw new AppError(
        ErrorCode.FORBIDDEN,
        "Provider data asset does not belong to the active organization",
        403,
      );
    }
    await this.assertAuthorized(actor, asset, "manage");
    assertProviderManager(actor, asset.providerOrgId);
    return asset;
  }

  private async findVersionById(versionId: string): Promise<DataAssetVersion> {
    const version = await this.deps.repository.getVersionById(versionId);
    if (version) return version;
    throw new AppError(ErrorCode.NOT_FOUND, "Data asset version not found", 404);
  }

  private async requireAccessRequest(requestId: string): Promise<DataAccessRequest> {
    const request = await this.deps.repository.getAccessRequest(requestId);
    if (request) return request;
    throw new AppError(ErrorCode.NOT_FOUND, "Data access request not found", 404);
  }

  private async requirePrivateLicensedAsset(assetId: string): Promise<DataAsset> {
    const asset = await this.requireAsset(assetId);
    if (!requiresActiveEntitlementUse(asset) || asset.visibility !== "private") {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        "Owner entitlement requires private licensed material",
        400,
      );
    }
    return asset;
  }

  private async authorize(
    actor: DataMarketActor,
    asset: DataAsset,
    permission: "view" | "use" | "manage",
  ): Promise<boolean> {
    if (
      asset.visibility === "private" &&
      asset.ownerUserId !== actor.userId &&
      (asset.ownerOrgId === null || !actor.orgIds.includes(asset.ownerOrgId)) &&
      (asset.providerOrgId === null || !actor.orgIds.includes(asset.providerOrgId))
    ) {
      return false;
    }
    const localAllowed = await localPermission(actor, asset, permission, this.deps.repository);
    if (!this.deps.authz) return localAllowed;
    return localAllowed && this.deps.authz.check({ actor, asset, permission, localAllowed });
  }

  private async assertAuthorized(
    actor: DataMarketActor,
    asset: DataAsset,
    permission: "view" | "use" | "manage",
  ): Promise<void> {
    if (!(await this.authorize(actor, asset, permission))) {
      throw new AppError(ErrorCode.FORBIDDEN, "Not authorized for this data asset", 403);
    }
  }

  private async idempotent<T>(scope: string, key: string, create: () => Promise<T>): Promise<T> {
    return this.deps.repository.runIdempotent({ scope, key, create });
  }

  private async flushCreatedAssetProjection(
    actor: DataMarketActor,
    asset: DataAsset,
  ): Promise<void> {
    const projector = this.deps.grantProjector;
    if (projector?.mode === "enforce" && projector.processOutbox) {
      await projector.processOutbox(16, {
        forcePending: true,
        resourceType: "data_asset",
        resourceId: asset.id,
      });
      if (
        this.deps.authz &&
        !(await this.deps.authz.check({ actor, asset, permission: "manage", localAllowed: true }))
      ) {
        throw new AppError(ErrorCode.FORBIDDEN, "Data asset authorization projection failed", 403);
      }
    }
  }
}

export function normalizeChemicalElements(elements: readonly string[]): string[] {
  const normalized = elements.map((element) => {
    const value = element.trim();
    if (!/^[A-Za-z]{1,2}$/.test(value)) {
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        `Invalid chemical element symbol: ${element}`,
        400,
      );
    }
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1).toLowerCase()}`;
  });
  return [...new Set(normalized)];
}

function assertDataAssetEntryPath(path: string): void {
  const parsed = DataAssetEntryPathSchema.safeParse(path);
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.VALIDATION_ERROR,
      "Data Market manifest path must be a canonical relative path",
      400,
      { blocker: "DATA_MANIFEST_PATH_INVALID", path },
    );
  }
}

export function localPermission(
  actor: DataMarketActor,
  asset: DataAsset,
  permission: "view" | "use" | "manage",
  repository: DataMarketRepository,
): Promise<boolean> | boolean {
  if (permission === "use" && requiresActiveEntitlementUse(asset)) {
    return repository.hasActiveAccess({
      assetId: asset.id,
      actorUserId: actor.userId,
      orgIds: actor.orgIds,
      capability: "use",
    });
  }
  if (hasRole(actor.role, "platform_admin")) return true;
  if (permission === "manage") {
    return (
      asset.ownerUserId === actor.userId ||
      (asset.ownerOrgId !== null &&
        actor.orgIds.includes(asset.ownerOrgId) &&
        hasProviderManagement(actor, asset.ownerOrgId)) ||
      (asset.providerOrgId !== null && hasProviderManagement(actor, asset.providerOrgId))
    );
  }
  if (
    asset.visibility === "public" &&
    asset.lifecycle === "published" &&
    asset.accessMode === "open"
  ) {
    return true;
  }
  if (asset.ownerUserId === actor.userId) return true;
  if (asset.ownerOrgId !== null && actor.orgIds.includes(asset.ownerOrgId)) return true;
  if (asset.providerOrgId !== null && actor.orgIds.includes(asset.providerOrgId)) return true;
  return repository.hasActiveAccess({
    assetId: asset.id,
    actorUserId: actor.userId,
    orgIds: actor.orgIds,
    capability: permission,
  });
}

function requiresActiveEntitlementUse(asset: DataAsset): boolean {
  return asset.kind === "licensed-material" && asset.accessMode === "entitlement";
}

function assertProviderManager(actor: DataMarketActor, providerOrgId: string): void {
  if (hasRole(actor.role, "platform_admin")) return;
  if (!hasProviderManagement(actor, providerOrgId)) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Provider data asset management requires org_admin",
      403,
    );
  }
}

function assertCpDataManager(actor: DataMarketActor): void {
  if (hasRole(actor.role, "platform_admin")) return;
  if (
    !hasRole(actor.role, "org_admin") &&
    !(actor.providerManagerOrgIds ?? []).some((orgId) => actor.orgIds.includes(orgId))
  ) {
    throw new AppError(ErrorCode.FORBIDDEN, "CP data management requires org_admin", 403);
  }
}

function hasProviderManagement(actor: DataMarketActor, orgId: string): boolean {
  return (
    (hasRole(actor.role, "org_admin") && actor.orgIds.includes(orgId)) ||
    actor.providerManagerOrgIds?.includes(orgId) === true
  );
}

function assertPlatformAdmin(actor: DataMarketActor): void {
  if (!hasRole(actor.role, "platform_admin")) {
    throw new AppError(
      ErrorCode.FORBIDDEN,
      "Data Market publication review requires platform_admin",
      403,
    );
  }
}

async function filterAsync<T>(items: T[], predicate: (item: T) => Promise<boolean>): Promise<T[]> {
  const allowed = await Promise.all(items.map(predicate));
  return items.filter((_, index) => allowed[index]);
}
