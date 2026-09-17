import { ApiError } from "@kuintessence/shared/browser";
import { getStoredActiveOrganizationId } from "./active-organization";
import { authenticatedHeaders, fetchAuthed } from "./authenticated-fetch";
import { assertMobileMutationAllowed } from "./mobile-management-policy";

export type DataAssetVisibility = "public" | "organization" | "private";
export type DataAssetLifecycle = "draft" | "reviewing" | "published" | "revoked";
export type DataAssetKind =
  | "training-dataset"
  | "scientific-dataset"
  | "reference-data"
  | "model-artifact"
  | "licensed-material";
export type DataAccessMode = "open" | "request" | "entitlement";
export type DataSensitivity = "open" | "internal" | "restricted" | "regulated";
export type DataLocationKind = "platform-object" | "user-private-object" | "cp-local";
export type DataReplicaStatus =
  | "pending"
  | "syncing"
  | "available"
  | "failed"
  | "revoked"
  | "deleted";
export type DataImportStatus = "pending" | "running" | "completed" | "failed" | "canceled";
export type DataAccessRequestStatus = "pending" | "approved" | "rejected" | "canceled" | "expired";

export interface DataAssetSummary {
  id: string;
  providerOrgId: string | null;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  ownerKind: "user" | "org" | "provider" | "platform";
  kind: DataAssetKind;
  name: string;
  description: string | null;
  visibility: DataAssetVisibility;
  lifecycle: DataAssetLifecycle;
  accessMode: DataAccessMode;
  sensitivity: DataSensitivity;
  tags: string[];
  elements?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface DataManifest {
  checksum: string;
  sizeBytes: number;
  mediaType: string;
  source: DataLocationKind;
}

export interface DataAssetVersion {
  id: string;
  assetId: string;
  version: string;
  status: "draft" | "validating" | "ready" | "failed" | "revoked";
  manifestDigest: string | null;
  manifest: DataManifest | Record<string, unknown>;
  immutableAt: string | null;
  createdBy: string;
  createdAt: string;
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
  verifiedAt: string | null;
}

export interface DataAssetImport {
  id: string;
  assetId: string;
  version: string;
  sourceKind: "platform-object" | "netdrive" | "cp-local";
  status: DataImportStatus;
  agentId: string | null;
  managedRootId: string | null;
  relativePath: string | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DataAccessRequest {
  id: string;
  assetId: string;
  requesterUserId: string;
  requesterOrgId: string | null;
  status: DataAccessRequestStatus;
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  capability: "view" | "use" | "download" | "derive" | "manage";
  subjectKind: "user" | "org";
  subjectId: string;
  decisionReason: string | null;
  expiresAt: string | null;
}

export interface DataUploadSession {
  id: string;
  assetId: string;
  version: string;
  locationKind: "platform-object" | "user-private-object";
  objectKey: string;
  uploadUrl: string;
  expiresAt: string;
}

export interface DataAssetInput {
  name: string;
  description?: string | null;
  providerOrgId?: string | null;
  tags?: string[];
  visibility: DataAssetVisibility;
  kind?: DataAssetKind;
  accessMode?: DataAccessMode;
  sensitivity?: DataSensitivity;
  elements?: string[];
}

export type CpDataImportSource =
  | { kind: "platform-object"; uploadSessionId: string }
  | { kind: "netdrive"; netdriveFileId: string }
  | { kind: "cp-local"; agentId: string; managedRootId: string; relativePath: string };

export interface DataReplicaInput {
  agentId: string;
  clusterId: string;
  locationKind: DataLocationKind;
  siteId: string;
  managedRootId?: string;
  relativePath?: string;
}

interface ApiEnvelope<T> {
  data: T;
  success: true;
}

interface ErrorEnvelope {
  error?: string | { code?: string; message?: string; details?: unknown };
  errors?: Array<{ code?: string; message?: string; details?: unknown }>;
}

interface Page<T> {
  limit: number;
  offset: number;
  total: number;
  [key: string]: T[] | number;
}

function requestHeaders(path: string, idempotencyKey?: string): Record<string, string> {
  const activeOrganizationId = path.startsWith("/cp/") ? getStoredActiveOrganizationId() : null;
  return authenticatedHeaders({
    "Content-Type": "application/json",
    ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    ...(activeOrganizationId ? { "X-KQ-Active-Organization": activeOrganizationId } : {}),
  });
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  idempotencyKey?: string,
): Promise<T> {
  if (init.method && path.startsWith("/cp/")) assertMobileMutationAllowed(path);
  const response = await fetchAuthed(path, () => ({
    credentials: "same-origin",
    ...init,
    headers: { ...requestHeaders(path, idempotencyKey), ...init.headers },
  }));
  const body = (await response.json().catch(() => null)) as ApiEnvelope<T> | ErrorEnvelope | null;
  if (!response.ok || !body || !("success" in body)) {
    const item =
      body && "error" in body
        ? typeof body.error === "object"
          ? body.error
          : (body.error ?? body.errors?.[0])
        : body && "errors" in body
          ? body.errors?.[0]
          : undefined;
    const code = typeof item === "object" && item?.code ? item.code : "HTTP_ERROR";
    const message =
      typeof item === "string"
        ? item
        : (item?.message ?? `Data Market request failed: HTTP ${response.status}`);
    const details = typeof item === "object" ? item?.details : undefined;
    throw new ApiError(response.status || 502, code, message, details);
  }
  return body.data;
}

function idempotencyKey(): string {
  return crypto.randomUUID();
}

function filePath(file: File): string {
  return file.name.replaceAll(/[\\/]+/g, "_") || "upload.bin";
}

export async function sha256File(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export const dataMarketClient = {
  catalog: (query: { limit?: number; offset?: number; query?: string; tag?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) params.set(key, String(value));
    }
    return request<{ assets: DataAssetSummary[]; limit: number; offset: number; total: number }>(
      `/data-market/catalog${params.size ? `?${params.toString()}` : ""}`,
    );
  },
  asset: (assetId: string) => request<DataAssetSummary>(`/data-market/assets/${assetId}`),
  version: (assetId: string, version: string) =>
    request<DataAssetVersion>(
      `/data-market/assets/${assetId}/versions/${encodeURIComponent(version)}`,
    ),
  files: (assetId: string, version: string) =>
    request<DataAssetFile[]>(
      `/data-market/assets/${assetId}/versions/${encodeURIComponent(version)}/files`,
    ),
  createPrivateAsset: (input: Omit<DataAssetInput, "visibility" | "providerOrgId">) =>
    request<DataAssetSummary>(
      "/data-market/private/assets",
      {
        body: JSON.stringify({
          accessMode: input.accessMode ?? "request",
          kind: input.kind ?? "scientific-dataset",
          sensitivity: input.sensitivity ?? "internal",
          tags: input.tags ?? [],
          elements: input.elements ?? [],
          ...input,
          visibility: "private",
        }),
        method: "POST",
      },
      idempotencyKey(),
    ),
  createCpAsset: (input: DataAssetInput) =>
    request<DataAssetSummary>(
      "/cp/data/assets",
      {
        body: JSON.stringify({
          accessMode: input.accessMode ?? "request",
          kind: input.kind ?? "scientific-dataset",
          sensitivity: input.sensitivity ?? "internal",
          tags: input.tags ?? [],
          ...input,
        }),
        method: "POST",
      },
      idempotencyKey(),
    ),
  createUploadSession: (
    assetId: string,
    input: { version: string; path: string; sizeBytes: number; mediaType: string },
  ) =>
    request<DataUploadSession>(
      `/data-market/assets/${assetId}/upload-sessions`,
      { body: JSON.stringify(input), method: "POST" },
      idempotencyKey(),
    ),
  commitUpload: (sessionId: string, sha256: string) =>
    request<DataAssetVersion>(`/data-market/upload-sessions/${sessionId}/commit`, {
      body: JSON.stringify({ sha256 }),
      method: "POST",
    }),
  uploadAssetFileWithSession: async (
    assetId: string,
    version: string,
    file: File,
  ): Promise<{ session: DataUploadSession; version: DataAssetVersion }> => {
    const mediaType = file.type || "application/octet-stream";
    const sha256 = await sha256File(file);
    const session = await dataMarketClient.createUploadSession(assetId, {
      mediaType,
      path: filePath(file),
      sizeBytes: file.size,
      version,
    });
    const put = await fetch(session.uploadUrl, {
      body: file,
      headers: { "Content-Type": mediaType },
      method: "PUT",
    });
    if (!put.ok) {
      throw new ApiError(put.status, "UPLOAD_FAILED", `Data upload failed: HTTP ${put.status}`);
    }
    return { session, version: await dataMarketClient.commitUpload(session.id, sha256) };
  },
  uploadAssetFile: async (
    assetId: string,
    version: string,
    file: File,
  ): Promise<DataAssetVersion> =>
    (await dataMarketClient.uploadAssetFileWithSession(assetId, version, file)).version,
  cpAssets: (query: { limit?: number; offset?: number; query?: string; tag?: string } = {}) =>
    request<Page<DataAssetSummary>>(`/cp/data/assets${pageQuery(query)}`) as Promise<{
      assets: DataAssetSummary[];
      limit: number;
      offset: number;
      total: number;
    }>,
  cpVersions: (assetId: string, query: { limit?: number; offset?: number } = {}) =>
    request<Page<DataAssetVersion>>(
      `/cp/data/assets/${assetId}/versions${pageQuery(query)}`,
    ) as Promise<{
      versions: DataAssetVersion[];
      limit: number;
      offset: number;
      total: number;
    }>,
  cpReplicas: (versionId: string, query: { limit?: number; offset?: number } = {}) =>
    request<Page<DataAssetReplica>>(
      `/cp/data/versions/${versionId}/replicas${pageQuery(query)}`,
    ) as Promise<{
      replicas: DataAssetReplica[];
      limit: number;
      offset: number;
      total: number;
    }>,
  cpImports: (query: { limit?: number; offset?: number } = {}) =>
    request<Page<DataAssetImport>>(`/cp/data/imports${pageQuery(query)}`) as Promise<{
      imports: DataAssetImport[];
      limit: number;
      offset: number;
      total: number;
    }>,
  startCpImport: (assetId: string, version: string, source: CpDataImportSource) =>
    request<{
      dataImport: DataAssetImport;
      dispatchState: "dispatched" | "queued";
      replayed: boolean;
      version: DataAssetVersion;
    }>(
      "/cp/data/imports",
      { body: JSON.stringify({ assetId, source, version }), method: "POST" },
      idempotencyKey(),
    ),
  createReplica: (versionId: string, input: DataReplicaInput) =>
    request<DataAssetReplica>(
      `/cp/data/versions/${versionId}/replicas`,
      { body: JSON.stringify(input), method: "POST" },
      idempotencyKey(),
    ),
  cpAccessRequests: (
    query: { limit?: number; offset?: number; status?: DataAccessRequestStatus } = {},
  ) =>
    request<Page<DataAccessRequest>>(`/cp/data/access-requests${pageQuery(query)}`) as Promise<{
      requests: DataAccessRequest[];
      limit: number;
      offset: number;
      total: number;
    }>,
  cpAccessRequest: (requestId: string) =>
    request<DataAccessRequest>(`/cp/data/access-requests/${requestId}`),
  reviewCpAccessRequest: (
    requestId: string,
    review: { decision: "approve" | "reject"; reason?: string; expiresAt?: string },
  ) =>
    request<{ request: DataAccessRequest }>(
      `/cp/data/access-requests/${requestId}/review`,
      { body: JSON.stringify(review), method: "POST" },
      idempotencyKey(),
    ),
  requestAccess: (assetId: string, reason: string | null) =>
    request<DataAccessRequest>(
      `/data-market/assets/${assetId}/access-requests`,
      { body: JSON.stringify({ reason }), method: "POST" },
      idempotencyKey(),
    ),
  myAccessRequests: (assetIds: string[]) =>
    request<{
      requests: DataAccessRequest[];
      activeUseAssetIds: string[];
    }>(`/data-market/access-requests/mine?assetIds=${assetIds.join(",")}`),
  requestOwnerEntitlement: (assetId: string, reason: string) =>
    request<DataAccessRequest>(
      `/data-market/private/assets/${assetId}/owner-entitlement-requests`,
      { body: JSON.stringify({ reason }), method: "POST" },
      idempotencyKey(),
    ),
};

function pageQuery(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.size ? `?${params.toString()}` : "";
}
