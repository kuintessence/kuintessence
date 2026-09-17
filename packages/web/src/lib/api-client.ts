import {
  ApiError,
  type ApiErrorEnvelope,
  type MirrorCacheRecord,
  type SoftwareAccessRequest,
  type SoftwareAssetCapability,
  type SoftwareAssetImpact,
  type SoftwareAssetLifecycle,
  type SoftwareAssetRef,
  type SoftwareAssetSummary,
  type SoftwareAvailabilityRequest,
  type SoftwareAvailabilityResponse,
  type SoftwareGrantSubject,
  unwrapApiResponse,
} from "@kuintessence/shared/browser";
import { getStoredActiveOrganizationId } from "./active-organization";
import { authenticatedHeaders, fetchAuthed } from "./authenticated-fetch";
import { assertMobileMutationAllowed } from "./mobile-management-policy";

export { ApiError } from "@kuintessence/shared/browser";

function authHeaders(): Record<string, string> {
  const activeOrganizationId = getStoredActiveOrganizationId();
  return authenticatedHeaders(
    activeOrganizationId ? { "X-KQ-Active-Organization": activeOrganizationId } : {},
  );
}

export { refreshAuthSession } from "./authenticated-fetch";

async function request<T>(path: string, createInit: () => RequestInit): Promise<T> {
  const response = await fetchAuthed(path, createInit);
  return unwrapApiResponse<T>(response);
}

function mutationRequest<T>(path: string, createInit: () => RequestInit): Promise<T> {
  assertMobileMutationAllowed(path);
  return request<T>(path, createInit);
}

/**
 * Fetch a Server endpoint that returns a file body (e.g. CSV export) with the
 * Bearer auth header, and trigger a browser download. A plain `<a href>` can't
 * carry the Authorization header, so we fetch the blob then click a synthetic
 * anchor bound to an object URL.
 */
export async function downloadAuthedFile(path: string, filename: string): Promise<void> {
  const res = await fetchAuthed(path, () => ({
    credentials: "same-origin",
    headers: authHeaders(),
  }));
  if (!res.ok) {
    const body = (await res.json().catch(() => ({
      error: { code: "DOWNLOAD_FAILED", message: `download failed: HTTP ${res.status}` },
    }))) as ApiErrorEnvelope;
    const error = body.error;
    throw new ApiError(
      res.status,
      typeof error === "object" ? (error.code ?? "DOWNLOAD_FAILED") : "DOWNLOAD_FAILED",
      typeof error === "string" ? error : (error?.message ?? `download failed: HTTP ${res.status}`),
      typeof error === "object" ? error.details : undefined,
    );
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const api = {
  get: <T>(path: string) =>
    request<T>(path, () => ({
      credentials: "same-origin",
      headers: authHeaders(),
    })),
  post: <T>(path: string, body?: unknown) =>
    mutationRequest<T>(path, () => ({
      credentials: "same-origin",
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    })),
  patch: <T>(path: string, body?: unknown) =>
    mutationRequest<T>(path, () => ({
      credentials: "same-origin",
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    })),
  put: <T>(path: string, body?: unknown) =>
    mutationRequest<T>(path, () => ({
      credentials: "same-origin",
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    })),
  delete: <T>(path: string) =>
    mutationRequest<T>(path, () => ({
      credentials: "same-origin",
      method: "DELETE",
      headers: authHeaders(),
    })),
};

export async function resolveSoftwareAvailability(
  payload: Omit<SoftwareAvailabilityRequest, "subject">,
): Promise<SoftwareAvailabilityResponse> {
  const body = await api.post<{ success: true; data: SoftwareAvailabilityResponse }>(
    "/software/resolve-availability",
    payload,
  );
  return body.data;
}

export async function listSoftwareReviewQueue(): Promise<SoftwareAssetSummary[]> {
  const body = await api.get<{ success: true; data: SoftwareAssetSummary[] }>(
    "/software/review-queue",
  );
  return body.data;
}

export async function submitSoftwareAsset(assetId: string, reason?: string) {
  const body = await api.post<{ success: true; data: SoftwareAssetSummary }>(
    `/software/assets/${assetId}/submit`,
    reason ? { reason } : {},
  );
  return body.data;
}

export async function reviewSoftwareAsset(
  assetId: string,
  decision: "approved" | "rejected",
  reason: string,
) {
  const body = await api.post<{ success: true; data: SoftwareAssetSummary }>(
    `/software/assets/${assetId}/review`,
    { decision, reason },
  );
  return body.data;
}

export async function forkOfficialSoftwareAsset(assetId: string) {
  const body = await api.post<{ success: true; data: SoftwareAssetSummary; reused: boolean }>(
    `/software/assets/${assetId}/fork-official`,
  );
  return body;
}

export async function updateSoftwareAssetLifecycle(
  assetId: string,
  lifecycle: SoftwareAssetLifecycle,
  reason: string,
  visibility?: "private" | "shared-to-orgs" | "platform-public" | "pending-review" | "hidden",
) {
  const body = await api.post<{ success: true; data: SoftwareAssetSummary }>(
    `/software/assets/${assetId}/lifecycle`,
    { lifecycle, reason, ...(visibility ? { visibility } : {}) },
  );
  return body.data;
}

export async function completeDownstreamSoftwareGrants(payload: {
  assetRef: SoftwareAssetRef;
  subject?: SoftwareGrantSubject;
  capabilities?: SoftwareAssetCapability[];
  reason?: string;
}) {
  const body = await api.post<{
    success: true;
    data: { root: SoftwareAssetSummary; completed: SoftwareAssetSummary[] };
  }>("/software/grants/complete-downstream", payload);
  return body.data;
}

export interface SoftwareReviewDetail {
  asset: SoftwareAssetSummary;
  latestRevision: {
    id: string;
    revision: number;
    payload: Record<string, unknown>;
    provenance: Record<string, unknown>;
    recipeSha256: string | null;
    createdBy: string | null;
    createdAt: string;
  } | null;
  previousRevision: {
    id: string;
    revision: number;
    payload: Record<string, unknown>;
    provenance: Record<string, unknown>;
    recipeSha256: string | null;
    createdBy: string | null;
    createdAt: string;
  } | null;
  officialFork: SoftwareAssetSummary | null;
  dependencyRefs: SoftwareAssetRef[];
  impact: SoftwareAssetImpact;
}

export async function listSoftwareAccessRequests(
  opts: { mine?: boolean; status?: "pending" | "approved" | "rejected" | "canceled" } = {},
): Promise<SoftwareAccessRequest[]> {
  const params = new URLSearchParams();
  if (opts.mine) params.set("mine", "true");
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString();
  const body = await api.get<{ success: true; data: SoftwareAccessRequest[] }>(
    qs ? `/software/access-requests?${qs}` : "/software/access-requests",
  );
  return body.data;
}

export async function createSoftwareAccessRequest(payload: {
  assetRef: SoftwareAssetRef;
  capability: "view" | "use" | "install";
  subject?: { kind: "user"; userId: string } | { kind: "org"; orgId: string };
  reason?: string;
}): Promise<SoftwareAccessRequest> {
  const body = await api.post<{ success: true; data: SoftwareAccessRequest }>(
    "/software/access-requests",
    payload,
  );
  return body.data;
}

export async function reviewSoftwareAccessRequest(
  requestId: string,
  decision: "approved" | "rejected",
  reason: string,
): Promise<SoftwareAccessRequest> {
  const body = await api.post<{ success: true; data: SoftwareAccessRequest }>(
    `/software/access-requests/${requestId}/review`,
    { decision, reason },
  );
  return body.data;
}

export async function getSoftwareReviewDetail(assetId: string): Promise<SoftwareReviewDetail> {
  const body = await api.get<{ success: true; data: SoftwareReviewDetail }>(
    `/software/assets/${assetId}/review-detail`,
  );
  return body.data;
}

export async function getSoftwareAssetImpact(assetId: string): Promise<SoftwareAssetImpact> {
  const body = await api.get<{ success: true; data: SoftwareAssetImpact }>(
    `/software/assets/${assetId}/impact`,
  );
  return body.data;
}

export async function listSoftwareMirrorCacheStatus(
  assetId?: string,
): Promise<MirrorCacheRecord[]> {
  const qs = assetId ? `?assetId=${encodeURIComponent(assetId)}` : "";
  const body = await api.get<{ success: true; data: MirrorCacheRecord[] }>(
    `/software/mirror-cache/status${qs}`,
  );
  return body.data;
}

interface NetDriveMinted {
  uploadUrl: string;
  storageKey: string;
  commitToken: string;
  expiresAt: string;
}

interface NetDriveCommitted {
  id: string;
  path: string;
  size: number;
  sha256: string;
  contentType: string;
  storageKey: string;
  mtime: string;
  createdAt: string;
}

const NETDRIVE_PATH_SAFE = /[^A-Za-z0-9._/-]+/g;

function netDriveSafePath(path: string): string {
  return path
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      const safe = segment.replace(NETDRIVE_PATH_SAFE, "_");
      return safe === "." || safe === ".." ? "_" : safe || "_";
    })
    .join("/");
}

export async function uploadFileToNetDrive(
  file: File,
  pathPrefix: string,
): Promise<NetDriveCommitted> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  const sha256 = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const safeName = netDriveSafePath(file.name);
  const safePrefix = netDriveSafePath(pathPrefix);
  const path = [safePrefix, safeName].filter(Boolean).join("/");
  const contentType = file.type || "application/octet-stream";

  const minted = await api.post<{ success: true; data: NetDriveMinted }>("/netdrive/upload-url", {
    path,
    size: file.size,
    contentType,
    sha256,
  });

  const putRes = await fetch(minted.data.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: file,
  });
  if (!putRes.ok) {
    throw new ApiError(putRes.status, "UPLOAD_FAILED", `S3 PUT failed: ${putRes.statusText}`);
  }
  const etag = putRes.headers.get("etag") ?? undefined;

  const committed = await api.post<{ success: true; data: NetDriveCommitted }>("/netdrive/files", {
    path,
    size: file.size,
    contentType,
    sha256,
    storageKey: minted.data.storageKey,
    commitToken: minted.data.commitToken,
    etag,
  });
  return committed.data;
}
