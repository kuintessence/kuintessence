/**
 * CP Console API client.
 *
 * Thin typed layer over public `/platform/api/cp/*` (see `packages/server/src/routes/cp.ts`).
 * Mirrors the shared browser auth transport used by `api-client.ts` and
 * `software-client.ts` so cookie sessions and legacy Bearer fallback both work.
 *
 * The shapes here intentionally mirror the Server's CpConsoleService so that
 * the Web compiler refuses any drift between front/back. Backend definitions
 * live in `packages/server/src/services/cp-console.ts`.
 */

import { ApiError } from "@kuintessence/shared/browser";
import { authenticatedHeaders, fetchAuthed } from "./authenticated-fetch";
import { assertMobileMutationAllowed } from "./mobile-management-policy";

const ACTIVE_ORGANIZATION_STORAGE_KEY = "kq_active_organization_id";

function authHeaders(): Record<string, string> {
  const activeOrganizationId =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(ACTIVE_ORGANIZATION_STORAGE_KEY);
  return authenticatedHeaders(
    activeOrganizationId ? { "X-KQ-Active-Organization": activeOrganizationId } : {},
  );
}

export class CpApiError extends ApiError {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(status, code, message, details);
    this.name = "CpApiError";
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code = "HTTP_ERROR";
    let message = res.statusText || `HTTP ${res.status}`;
    let details: unknown;
    try {
      const body = (await res.json()) as {
        error?: string | { code?: string; message?: string; details?: unknown };
        errors?: Array<{ code?: string; message?: string; details?: unknown }>;
      };
      const item =
        typeof body.error === "object" ? body.error : (body.errors?.[0] ?? body.error ?? null);
      if (typeof item === "string") message = item;
      else if (item) {
        if (item.code) code = item.code;
        if (item.message) message = item.message;
        details = item.details;
      }
    } catch {
      // best-effort
    }
    throw new CpApiError(res.status, code, message, details);
  }
  return res.json() as Promise<T>;
}

function get<T>(path: string): Promise<T> {
  return fetchAuthed(`/cp${path}`, () => ({
    credentials: "same-origin",
    headers: authHeaders(),
  })).then(parse<T>);
}

function post<T>(path: string, body: unknown, headers: Record<string, string> = {}): Promise<T> {
  assertMobileMutationAllowed(`/cp${path}`);
  return fetchAuthed(`/cp${path}`, () => ({
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(), ...headers },
    body: JSON.stringify(body),
  })).then(parse<T>);
}

function put<T>(path: string, body: unknown): Promise<T> {
  assertMobileMutationAllowed(`/cp${path}`);
  return fetchAuthed(`/cp${path}`, () => ({
    credentials: "same-origin",
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  })).then(parse<T>);
}

function del(path: string): Promise<void> {
  assertMobileMutationAllowed(`/cp${path}`);
  return fetchAuthed(`/cp${path}`, () => ({
    credentials: "same-origin",
    method: "DELETE",
    headers: { ...authHeaders() },
  })).then(async (res) => {
    if (res.status === 204) return;
    await parse<unknown>(res);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain shapes — mirror packages/server/src/services/cp-console.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface DashboardKpis {
  windowFrom: string;
  windowTo: string;
  jobsCompleted: number;
  jobsFailed: number;
  bytesTransferred: number;
  queueDepthPeak: number;
  agentsHealthy: number;
  agentsSick: number;
  agentsOffline: number;
  topUsers: Array<{
    userId: string;
    jobs: number;
    displayName: string | null;
    email: string | null;
    organizationName: string | null;
  }>;
  topApps: Array<{ appKey: string; jobs: number }>;
}

export interface SoftwarePolicy {
  cluster: string;
  whitelist: string[];
  blacklist: string[];
  locked: boolean;
}

export type SoftwarePolicyList = "whitelist" | "blacklist";

export interface SoftwarePolicyEdit {
  cluster: string;
  list: SoftwarePolicyList;
  specs: string[];
}

export type InstallMode =
  | "preinstalled-only"
  | "trusted-public-auto-install"
  | "explicit-install-grant";

export interface MirrorInput {
  name: string;
  url: string;
  priority?: number;
}

export interface PolicyOverlayInput {
  installMode: InstallMode;
  allowList: string[];
  denyList: string[];
  lockEnabled: boolean;
  trustedPublicAutoInstall: boolean;
  usecaseDefaultAllow: boolean;
  usecaseAllowList: string[];
  usecaseDenyList: string[];
  mirrors: MirrorInput[];
  preinstallList: string[];
}

export interface ProviderPolicyInput extends PolicyOverlayInput {
  providerOrgId?: string;
}

export interface PolicyOverlayView extends PolicyOverlayInput {
  scope: "provider" | "cluster" | "agent";
  providerOrgId: string | null;
  clusterId: string | null;
  agentId: string | null;
  version: string;
  updatedAt: string | null;
}

export interface CpSoftwareAgentView {
  agentId: string;
  cluster: string;
  siteId: string | null;
  providerOrgId: string | null;
  status: string;
  runtimeStatus: string;
  controlChannelOnline: boolean;
  lastHeartbeat: string | null;
  schedulerType: string;
  schedulerVersion: string;
  providerPolicy: PolicyOverlayView | null;
  clusterPolicy: PolicyOverlayView | null;
  agentPolicy: PolicyOverlayView | null;
  effectivePolicy: PolicyOverlayInput;
  installedCount: number;
  installedSpecs: string[];
  preinstalledMappings: Array<{
    id: string;
    localSpec: string;
    assetId: string;
    confidence: string;
    auditedBy: string | null;
    auditedAt: string | null;
  }>;
}

export interface CpSoftwareClusterView {
  cluster: string;
  providerOrgId: string | null;
  clusterPolicy: PolicyOverlayView | null;
  agents: CpSoftwareAgentView[];
  lockedAgents: number;
  mirrorCount: number;
  preinstallCount: number;
  installedCount: number;
  installModes: InstallMode[];
}

export interface CpSoftwareOverview {
  providerOrgIds: string[];
  providerPolicy: PolicyOverlayView | null;
  clusters: CpSoftwareClusterView[];
  agents: CpSoftwareAgentView[];
  summary: {
    clusters: number;
    agents: number;
    lockedAgents: number;
    overrides: number;
    mirrors: number;
    preinstalledSpecs: number;
    installedSpecs: number;
  };
}

export interface SoftwareAvailabilityNode {
  agentId: string;
  siteName: string;
  providerOrgId: string | null;
  status: string;
  installedSpec?: string;
  installMode?: InstallMode;
  reasons: string[];
}

export interface SoftwareAvailabilityPreview {
  spec: string;
  installedAvailable: SoftwareAvailabilityNode[];
  installableAvailable: SoftwareAvailabilityNode[];
  blocked: SoftwareAvailabilityNode[];
  explanations: string[];
  concretizedDag?: {
    rootSpec: string;
    contextKey: string;
    dependencies: Array<{ name: string; spec: string; virtual: boolean; providers: string[] }>;
    generatedAt: string;
    cached: boolean;
  };
}

export interface AvailabilityPreviewRequest {
  rawSpec: string;
  usecaseRef?: {
    id?: string;
    name?: string;
    version?: string;
  };
  targetAgentIds?: string[];
  installable?: boolean;
}

export interface CpUser {
  id: string;
  email: string;
  role: string;
  suspended?: boolean;
  quota?: number;
}

export interface CpUsersPage {
  total: number;
  items: CpUser[];
}

export interface AuditEntry {
  id?: string;
  createdAt?: string;
  actor?: string;
  action?: string;
  target?: string;
  // The server returns Array<unknown> — the UI defensively renders any string-y
  // fields it finds. This shape is what we expect in the happy path.
  [k: string]: unknown;
}

export interface AuditSearchPage {
  total: number;
  items: AuditEntry[];
}

export interface CpAgent {
  id: string;
  hostname: string;
  siteId: string;
  status: string;
}

export interface CpAgentCert {
  id: string;
  fingerprintSha256: string;
  subjectCn: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  issuedBy: string | null;
}

export type AgentRegistrationScheduler = "slurm" | "pbs-pro" | "torque" | "kubernetes";

export interface AgentRegistrationProviderOrg {
  id: string;
  name: string;
}

export interface AgentRegistrationContext {
  providerOrgs: AgentRegistrationProviderOrg[];
  isPlatformWide: boolean;
  schedulers: AgentRegistrationScheduler[];
}

export interface AgentRegistrationTokenCreate {
  providerOrgId: string;
  agentId: string;
  siteName: string;
  expiresInSec: number;
}

export interface AgentRegistrationToken {
  id: string;
  agentId: string;
  siteName: string;
  providerOrgId: string;
  token: string;
  expiresAt: string;
}

export interface ActiveAgentRegistrationToken {
  id: string;
  agentId: string;
  siteName: string;
  providerOrgId: string;
  expiresAt: string;
  createdAt: string;
}

export type SoftwareOperationAction = "install" | "uninstall" | "load" | "import_preinstalled";
export type SoftwareOperationStatus = "queued" | "running" | "succeeded" | "failed" | "rejected";

export interface SoftwareOperation {
  id: string;
  agentId: string;
  requestedBy: string | null;
  action: SoftwareOperationAction;
  spec: string;
  status: SoftwareOperationStatus;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  error: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

export interface SoftwareOperationRequest {
  agentId: string;
  action: SoftwareOperationAction;
  spec: string;
  idempotencyKey: string;
}

export interface SoftwareOperationBatchRequest {
  agentId: string;
  action: Extract<SoftwareOperationAction, "install" | "import_preinstalled">;
  specs: string[];
  idempotencyKey: string;
}

export interface SoftwareOperationBatchSummary {
  inputCount: number;
  nonEmptyCount: number;
  uniqueSpecCount: number;
  ignoredEmptyCount: number;
  ignoredDuplicateCount: number;
}

export interface SoftwareOperationBatchResponse {
  items: SoftwareOperation[];
  summary: SoftwareOperationBatchSummary;
}

export interface PreinstalledMappingReviewRequest {
  agentId: string;
  mappingId: string;
  decision: "approve" | "reject";
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoints
// ─────────────────────────────────────────────────────────────────────────────

export async function getDashboardKpis(): Promise<DashboardKpis> {
  const body = await get<{ kpis: DashboardKpis }>("/dashboard");
  return body.kpis;
}

export async function listSoftwarePolicies(): Promise<SoftwarePolicy[]> {
  const body = await get<{ items: SoftwarePolicy[] }>("/software/policies");
  return body.items;
}

export async function getSoftwareOverview(): Promise<CpSoftwareOverview> {
  return get<CpSoftwareOverview>("/software/overview");
}

export async function editSoftwarePolicy(payload: SoftwarePolicyEdit): Promise<void> {
  await post<{ ok: boolean }>("/software/policies", payload);
}

export async function saveProviderSoftwarePolicy(
  payload: ProviderPolicyInput,
): Promise<CpSoftwareOverview> {
  return put<CpSoftwareOverview>("/software/policies/provider", payload);
}

export async function saveClusterSoftwarePolicy(
  clusterId: string,
  payload: PolicyOverlayInput,
): Promise<CpSoftwareOverview> {
  return put<CpSoftwareOverview>(
    `/software/policies/clusters/${encodeURIComponent(clusterId)}`,
    payload,
  );
}

export async function saveAgentSoftwarePolicy(
  agentId: string,
  payload: PolicyOverlayInput,
): Promise<CpSoftwareOverview> {
  return put<CpSoftwareOverview>(
    `/software/policies/agents/${encodeURIComponent(agentId)}`,
    payload,
  );
}

export async function previewSoftwareAvailability(
  payload: AvailabilityPreviewRequest,
): Promise<SoftwareAvailabilityPreview> {
  return post<SoftwareAvailabilityPreview>("/software/availability-preview", payload);
}

export async function listSoftwareOperations(q: {
  agentId?: string;
  action?: SoftwareOperationAction;
  limit?: number;
  status?: SoftwareOperationStatus;
}): Promise<SoftwareOperation[]> {
  const params = new URLSearchParams();
  if (q.agentId != null && q.agentId !== "") params.set("agentId", q.agentId);
  if (q.action != null) params.set("action", q.action);
  if (q.limit != null) params.set("limit", String(q.limit));
  if (q.status != null) params.set("status", q.status);
  const suffix = params.toString() ? `?${params}` : "";
  const body = await get<{ items: SoftwareOperation[] }>(`/software/operations${suffix}`);
  return body.items;
}

export async function requestSoftwareOperation(
  payload: SoftwareOperationRequest,
): Promise<SoftwareOperation> {
  const { idempotencyKey, ...body } = payload;
  return post<SoftwareOperation>("/software/operations", body, {
    "Idempotency-Key": idempotencyKey,
  });
}

export async function requestSoftwareOperationsBatch(
  payload: SoftwareOperationBatchRequest,
): Promise<SoftwareOperationBatchResponse> {
  const { idempotencyKey, ...body } = payload;
  return post<SoftwareOperationBatchResponse>("/software/operations/batch", body, {
    "Idempotency-Key": idempotencyKey,
  });
}

export async function reviewPreinstalledMapping(
  payload: PreinstalledMappingReviewRequest,
): Promise<CpSoftwareOverview> {
  return post<CpSoftwareOverview>(
    `/software/preinstalled-mappings/${encodeURIComponent(payload.mappingId)}/review`,
    {
      agentId: payload.agentId,
      decision: payload.decision,
    },
  );
}

export interface ListUsersQuery {
  search?: string;
  limit?: number;
  offset?: number;
}

export async function listUsers(q: ListUsersQuery): Promise<CpUsersPage> {
  const params = new URLSearchParams();
  if (q.search != null && q.search !== "") params.set("search", q.search);
  if (q.limit != null) params.set("limit", String(q.limit));
  if (q.offset != null) params.set("offset", String(q.offset));
  const qs = params.toString();
  return get<CpUsersPage>(qs ? `/users?${qs}` : "/users");
}

export async function setUserSuspended(userId: string, suspended: boolean): Promise<void> {
  await post<{ ok: boolean }>(`/users/${encodeURIComponent(userId)}/suspend`, { suspended });
}

export async function setUserQuota(userId: string, quota: number): Promise<void> {
  await post<{ ok: boolean }>(`/users/${encodeURIComponent(userId)}/quota`, { quota });
}

export interface AuditSearchQuery {
  from: string;
  to: string;
  text?: string;
  limit?: number;
  offset?: number;
}

export async function searchAudit(q: AuditSearchQuery): Promise<AuditSearchPage> {
  return post<AuditSearchPage>("/audit/search", q);
}

export async function listAgents(): Promise<CpAgent[]> {
  const body = await get<{ items: CpAgent[] }>("/agents");
  return body.items;
}

export async function listCpAgentCerts(agentId: string): Promise<CpAgentCert[]> {
  const body = await get<{ certs: CpAgentCert[] }>(`/agents/${encodeURIComponent(agentId)}/certs`);
  return body.certs;
}

export async function revokeCpAgentCert(
  agentId: string,
  fingerprintSha256: string,
  reason?: string,
): Promise<void> {
  await post<{ success: true }>(
    `/agents/${encodeURIComponent(agentId)}/certs/${encodeURIComponent(fingerprintSha256)}/revoke`,
    reason ? { reason } : {},
  );
}

export async function getAgentRegistrationContext(): Promise<AgentRegistrationContext> {
  return get<AgentRegistrationContext>("/agent-registration-context");
}

export async function listActiveAgentRegistrationTokens(): Promise<ActiveAgentRegistrationToken[]> {
  const body = await get<{ items: ActiveAgentRegistrationToken[] }>("/agent-registration-tokens");
  return body.items;
}

export async function createAgentRegistrationToken(
  payload: AgentRegistrationTokenCreate,
): Promise<AgentRegistrationToken> {
  return post<AgentRegistrationToken>("/agent-registration-tokens", payload);
}

export async function revokeAgentRegistrationToken(id: string): Promise<void> {
  await del(`/agent-registration-tokens/${encodeURIComponent(id)}`);
}
