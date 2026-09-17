/**
 * Registry client.
 *
 * The server API is exposed at `/software/api/...` by the AIO nginx proxy. In dev
 * Vite proxies that API prefix while keeping `/software/...` pages in the SPA.
 *
 * The registry exposes workflow templates, structured usecase packages, and
 * software variants. The web UI treats `app-templates` with `specKind=spack`
 * as the Spack software catalog.
 */

import {
  ApiError,
  type SoftwareAssetSummary,
  type workflowDsl,
} from "@kuintessence/shared/browser";
import { assertMobileMutationAllowed } from "./mobile-management-policy";

const SOFTWARE_BASE = "/software/api";

function readAuthToken(): string | null {
  if (typeof localStorage === "undefined") return null;
  return localStorage.getItem("kq_token");
}

function authHeaders(): Record<string, string> {
  const tok = readAuthToken();
  const headers: Record<string, string> = tok ? { Authorization: `Bearer ${tok}` } : {};
  if (
    typeof window !== "undefined" &&
    /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname)
  ) {
    headers["X-Test-Principal"] = JSON.stringify({
      sub: localStorage.getItem("kq_email") ?? "web-admin",
      role: localStorage.getItem("kq_role") ?? "platform_admin",
      orgIds: ["demo-org"],
    });
  }
  return headers;
}

function writeHeaders(): Record<string, string> {
  return { "Content-Type": "application/json", ...authHeaders() };
}

export class SoftwareError extends ApiError {
  public readonly diagnosticMessage: string;

  constructor(status: number, message: string);
  constructor(status: number, code: string, message: string, details?: unknown);
  constructor(
    status: number,
    codeOrMessage: string,
    messageOrDetails?: string | unknown,
    details?: unknown,
  ) {
    const hasCode = typeof messageOrDetails === "string";
    const code = hasCode ? codeOrMessage : "HTTP_ERROR";
    const message = hasCode ? messageOrDetails : codeOrMessage;
    super(status, code, message, hasCode ? details : messageOrDetails);
    this.diagnosticMessage = message;
    this.name = "SoftwareError";
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  if (init?.method && init.method !== "GET") {
    assertMobileMutationAllowed(`/software${path}`);
  }
  let res: Response;
  try {
    res = await fetch(`${SOFTWARE_BASE}${path}`, {
      credentials: "same-origin",
      ...init,
      headers: init?.headers ?? authHeaders(),
    });
  } catch {
    throw new SoftwareError(503, "REGISTRY_UNREACHABLE", "Registry is unreachable");
  }

  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    throw new SoftwareError(
      res.ok ? 502 : res.status,
      "REGISTRY_INVALID_RESPONSE",
      "Registry returned non-JSON (is it running?)",
    );
  }

  const body = (await res.json()) as T & {
    error?: string | { code?: string; message?: string; details?: unknown; detail?: unknown };
    errors?: Array<{
      code?: string;
      message?: string;
      details?: unknown;
      detail?: unknown;
    }>;
  };
  if (!res.ok) {
    const item =
      typeof body?.error === "object" ? body.error : (body?.errors?.[0] ?? body?.error ?? null);
    const code = typeof item === "object" && item?.code ? item.code : "HTTP_ERROR";
    const message =
      typeof item === "string"
        ? item
        : (item?.message ?? (typeof item?.detail === "string" ? item.detail : res.statusText));
    const itemDetails =
      item !== null && typeof item === "object" ? (item.details ?? item.detail) : undefined;
    throw new SoftwareError(res.status, code, message, itemDetails);
  }
  return body;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  version: string;
  description: string | null;
  yamlContent: string;
  tags: string[];
  createdAt: string;
}

export interface WorkflowTemplatePage {
  templates: WorkflowTemplate[];
  tags: string[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

export interface UsecasePackagePage {
  usecasePackages: UsecasePackage[];
  tags: string[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
}

export interface WorkflowTemplateCreate {
  name: string;
  version: string;
  description?: string;
  yamlContent: string;
  tags?: string[];
}

export type WorkflowTemplateUpdate = WorkflowTemplateCreate;

export interface AppTemplate {
  id: string;
  name: string;
  version: string;
  description: string | null;
  spec: string;
  specKind: "spack" | "oci" | "module";
  tags: string[];
  createdAt: string;
}

export interface AppTemplateCreate {
  name: string;
  version: string;
  description?: string;
  spec: string;
  specKind: "spack" | "oci" | "module";
  tags?: string[];
}

export type AppTemplateUpdate = AppTemplateCreate;

export interface SpackSoftwareSpec {
  kind: "Spack";
  name: string;
  version?: string;
  compiler?: string;
  moduleName?: string;
  variantRef?: string;
  argumentList: string[];
}

export type TypedUsecaseInputType =
  | "String"
  | "Integer"
  | "Number"
  | "Boolean"
  | "Enum"
  | "File"
  | "FileBatch"
  | "Dataset";

export interface TypedUsecaseInput {
  descriptor: string;
  type: TypedUsecaseInputType;
  required: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  enum?: string[];
  dataRequirements?: {
    acceptedFormats: string[];
    requiredSchema?: string;
    requiredTags: string[];
    minBytes?: number;
    maxBytes?: number;
    accessModes: Array<"open" | "request" | "entitlement">;
    maxSensitivity?: "open" | "internal" | "restricted" | "regulated";
    localityRequired: boolean;
    dataAssets: Array<{
      kind:
        | "training-dataset"
        | "scientific-dataset"
        | "reference-data"
        | "model-artifact"
        | "pseudopotential"
        | "licensed-material";
      selector: string;
      version?: string;
    }>;
    allowUserPrivate: boolean;
  };
}

interface UsecasePackageSpecBase {
  usecase: {
    commandFile: string;
    inputSlots: Array<{
      kind: "Text" | "File";
      descriptor: string;
      refMaterials: Array<
        | { kind: "ArgRef"; descriptor: string; sort: number }
        | { kind: "EnvRef"; descriptor: string }
        | { kind: "FileInputRef"; descriptor: string }
        | { kind: "StdinRef"; descriptor: string }
      >;
    }>;
  };
  software:
    | SpackSoftwareSpec
    | { kind: "Singularity"; image: string; tag: string }
    | { kind: "Bare" };
  arguments: Array<{ descriptor: string; valueFormat: string }>;
  environments: Array<{ descriptor: string; key: string; valueFormat: string }>;
  filesomeInputs: Array<{
    descriptor: string;
    fileKind: { kind: "Normal"; name: string } | { kind: "Batched"; pattern: string };
  }>;
  filesomeOutputs?: Array<{
    descriptor: string;
    fileKind: { kind: "Normal"; name: string } | { kind: "Batched"; pattern: string };
  }>;
  valueOutputs?: unknown[];
}

export type UsecasePackageSpec = UsecasePackageSpecBase &
  (
    | { softwareRef?: never; inputs?: never }
    | {
        softwareRef: workflowDsl.AssetSelector;
        inputs: TypedUsecaseInput[];
      }
  );

export interface UsecasePackage {
  id: string;
  publishedSoftwareRevisionId?: string;
  name: string;
  version: string;
  description: string | null;
  spec: UsecasePackageSpec;
  createdAt: string;
}

export interface UsecasePackageCreate {
  name: string;
  version: string;
  description?: string;
  spec: UsecasePackageSpec;
}

export type UsecasePackageUpdate = UsecasePackageCreate;

export type SpackCatalogSource = "upstream" | "official" | "vendor";
export type SpackCatalogSourceFilter = SpackCatalogSource | "all";

export interface SpackVariantMetadata {
  name: string;
  default?: string;
  description?: string;
  values: string[];
}

export interface SpackPackageMetadata {
  name?: string;
  homepage?: string;
  licenses: string[];
  maintainers: string[];
  versions: string[];
  variants: SpackVariantMetadata[];
  dependencies: string[];
  provides: string[];
  conflicts: string[];
}

export interface SpackCompilerMetadata {
  spec: string;
  name: string;
  version?: string;
}

export interface SpackCatalogPackage {
  id?: string;
  name: string;
  source: SpackCatalogSource;
  description?: string | null;
  tags: string[];
  metadata?: SpackPackageMetadata;
  asset?: SoftwareAssetSummary;
  licensePolicy?: LicensePolicy;
  createdAt?: string;
  ownerOrgId?: string | null;
}

export interface LicensePolicy {
  classification: "open-source" | "source-available" | "proprietary" | "unknown";
  identifiers: Array<{ kind: "spdx" | "custom"; value: string }>;
  termsUrl?: string;
  noticeUrl?: string;
  provenance?: { source: string; reference: string };
  acceptanceRequired?: boolean;
  providerEntitlements?: Array<"source-access" | "install">;
  consumerEntitlements?: Array<"use">;
  redistribution?: "permitted" | "restricted" | "prohibited";
  autoInstall?: "allowed" | "denied" | "review-required";
}

export interface LicenseEntitlementClaim {
  id: string;
  licenseSubject: string;
  assetId: string | null;
  entitlement: "provider-source-install" | "consumer-use";
  claimantKind: "org" | "user";
  claimantId: string;
  providerOrgId: string | null;
  evidenceReference: string;
  evidenceSummary: string;
  status: "pending" | "approved" | "rejected" | "revoked" | "expired";
  submittedAt: string;
  expiresAt: string | null;
  decisionReason: string | null;
}

export interface RuntimeContractBinding {
  id: string;
  providerOrgId: string;
  agentId: string | null;
  clusterId: string | null;
  runtimeContractRef: string;
  runtimeProfileId: string;
  runtimeDigest: string;
  status: "active" | "revoked";
}

export interface LicensedMaterialMapping {
  id: string;
  providerOrgId: string;
  agentId: string;
  selector: string;
  materialName: string;
  materialVersion: string;
  elementSet: string[];
  fingerprint: string;
  status: "active" | "revoked";
}

export interface SpackCatalogPackageCreate {
  name: string;
  source: Exclude<SpackCatalogSource, "upstream">;
  description?: string;
  tags?: string[];
  packageFile?: string;
}

export type SpackCatalogPackageUpdate = SpackCatalogPackageCreate;

export interface SpackCatalog {
  source: string;
  sourceRepository: string;
  sourceRef: string;
  generatedAt: string;
  packageCount: number;
  upstreamCount: number;
  customCount: number;
  totalCount: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
  packages: SpackCatalogPackage[];
}

const WORKFLOW_TEMPLATE_FULL_LOAD_MAX_PAGES = 10;
const WORKFLOW_TEMPLATE_FULL_LOAD_PAGE_SIZE = 100;

export async function listWorkflowTemplatePage(
  input: { page?: number; pageSize?: number; q?: string; tag?: string } = {},
): Promise<WorkflowTemplatePage> {
  const params = new URLSearchParams();
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? 24));
  if (input.q?.trim()) params.set("q", input.q.trim());
  if (input.tag?.trim()) params.set("tag", input.tag.trim());
  const body = await requestJson<{
    workflowTemplates?: WorkflowTemplate[];
    templates?: WorkflowTemplate[];
    tags?: string[];
    total?: number;
    page?: number;
    pageSize?: number;
    totalPages?: number;
    hasNext?: boolean;
  }>(`/workflow-templates?${params.toString()}`);
  const templates = body.templates ?? body.workflowTemplates ?? [];
  const pageSize = body.pageSize ?? input.pageSize ?? 24;
  const total = body.total ?? templates.length;
  const page = body.page ?? input.page ?? 1;
  const totalPages = body.totalPages ?? Math.max(1, Math.ceil(total / pageSize));
  return {
    templates,
    tags: body.tags ?? [],
    total,
    page,
    pageSize,
    totalPages,
    hasNext: body.hasNext ?? page < totalPages,
  };
}

export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const templates = new Map<string, WorkflowTemplate>();
  let expectedTotal: number | null = null;
  for (let page = 1; page <= WORKFLOW_TEMPLATE_FULL_LOAD_MAX_PAGES; page += 1) {
    const result = await listWorkflowTemplatePage({
      page,
      pageSize: WORKFLOW_TEMPLATE_FULL_LOAD_PAGE_SIZE,
    });
    if (expectedTotal !== null && result.total !== expectedTotal) {
      throw new SoftwareError(
        409,
        "Workflow template list changed while loading. Refresh and try again.",
      );
    }
    expectedTotal = result.total;
    for (const template of result.templates) templates.set(template.id, template);
    if (!result.hasNext) {
      if (templates.size !== result.total) {
        throw new SoftwareError(
          409,
          "Workflow template list changed while loading. Refresh and try again.",
        );
      }
      return [...templates.values()];
    }
  }
  throw new SoftwareError(
    413,
    `Workflow template list exceeds ${WORKFLOW_TEMPLATE_FULL_LOAD_MAX_PAGES * WORKFLOW_TEMPLATE_FULL_LOAD_PAGE_SIZE} entries. Use paginated search instead.`,
  );
}

export async function getWorkflowTemplate(id: string): Promise<WorkflowTemplate> {
  return requestJson<WorkflowTemplate>(`/workflow-templates/${encodeURIComponent(id)}`);
}

export async function listLicenseEntitlementClaims(): Promise<LicenseEntitlementClaim[]> {
  const body = await requestJson<{ claims?: LicenseEntitlementClaim[] }>(
    "/license-entitlement-claims",
  );
  return body.claims ?? [];
}

export async function submitLicenseEntitlementClaim(payload: {
  licenseSubject: string;
  assetId?: string;
  entitlement: "provider-source-install" | "consumer-use";
  claimantKind: "org" | "user";
  claimantId: string;
  providerOrgId?: string;
  evidenceReference: string;
  evidenceSummary: string;
  expiresAt?: string;
}): Promise<LicenseEntitlementClaim> {
  return requestJson<LicenseEntitlementClaim>("/license-entitlement-claims", {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function decideLicenseEntitlementClaim(
  id: string,
  decision: "approved" | "rejected" | "revoked",
  reason: string,
): Promise<LicenseEntitlementClaim> {
  return requestJson<LicenseEntitlementClaim>(
    `/license-entitlement-claims/${encodeURIComponent(id)}/${decision}`,
    {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ reason }),
    },
  );
}

export async function listRuntimeContractBindings(
  providerOrgId?: string,
): Promise<RuntimeContractBinding[]> {
  const suffix = providerOrgId ? `?providerOrgId=${encodeURIComponent(providerOrgId)}` : "";
  const body = await requestJson<{ bindings?: RuntimeContractBinding[] }>(
    `/runtime-contract-bindings${suffix}`,
  );
  return body.bindings ?? [];
}

export async function bindRuntimeContract(payload: {
  providerOrgId: string;
  agentId?: string;
  clusterId?: string;
  runtimeContractRef: string;
  runtimeProfileId: string;
  runtimeDigest: string;
}): Promise<RuntimeContractBinding> {
  return requestJson<RuntimeContractBinding>("/runtime-contract-bindings", {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function listLicensedMaterialMappings(
  providerOrgId?: string,
): Promise<LicensedMaterialMapping[]> {
  const suffix = providerOrgId ? `?providerOrgId=${encodeURIComponent(providerOrgId)}` : "";
  const body = await requestJson<{ mappings?: LicensedMaterialMapping[] }>(
    `/licensed-material-mappings${suffix}`,
  );
  return body.mappings ?? [];
}

export async function registerLicensedMaterialMapping(payload: {
  providerOrgId: string;
  agentId: string;
  selector: string;
  materialName: string;
  materialVersion: string;
  elementSet: string[];
  fingerprint: string;
  auditMetadata?: Record<string, unknown>;
}): Promise<LicensedMaterialMapping> {
  return requestJson<LicensedMaterialMapping>("/licensed-material-mappings", {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function createWorkflowTemplate(
  payload: WorkflowTemplateCreate,
): Promise<WorkflowTemplate> {
  return requestJson<WorkflowTemplate>("/workflow-templates", {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function updateWorkflowTemplate(
  id: string,
  payload: WorkflowTemplateUpdate,
): Promise<WorkflowTemplate> {
  return requestJson<WorkflowTemplate>(`/workflow-templates/${id}`, {
    method: "PUT",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function deleteWorkflowTemplate(id: string): Promise<void> {
  await requestJson<WorkflowTemplate>(`/workflow-templates/${id}`, {
    method: "DELETE",
    headers: writeHeaders(),
  });
}

export async function listSpackCatalog(
  query = "",
  pageSize = 24,
  source: SpackCatalogSourceFilter = "all",
  page = 1,
): Promise<SpackCatalog> {
  const params = new URLSearchParams();
  if (query.trim()) params.set("q", query.trim());
  params.set("page", String(page));
  params.set("pageSize", String(pageSize));
  params.set("source", source);
  const suffix = params.toString();
  return requestJson<SpackCatalog>(`/spack/catalog${suffix ? `?${suffix}` : ""}`);
}

export async function parseSpackPackageFile(source: string): Promise<SpackPackageMetadata> {
  return requestJson<SpackPackageMetadata>("/spack/parse/package", {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify({ source }),
  });
}

export async function parseSpackCompilers(source: string): Promise<SpackCompilerMetadata[]> {
  const body = await requestJson<{ compilers?: SpackCompilerMetadata[] }>(
    "/spack/parse/compilers",
    {
      method: "POST",
      headers: writeHeaders(),
      body: JSON.stringify({ source }),
    },
  );
  return body.compilers ?? [];
}

export async function createSpackCatalogPackage(
  payload: SpackCatalogPackageCreate,
  orgId?: string,
): Promise<SpackCatalogPackage> {
  const suffix = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  return requestJson<SpackCatalogPackage>(`/spack/catalog/packages${suffix}`, {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function updateSpackCatalogPackage(
  id: string,
  payload: SpackCatalogPackageUpdate,
  orgId?: string,
): Promise<SpackCatalogPackage> {
  const suffix = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  return requestJson<SpackCatalogPackage>(`/spack/catalog/packages/${id}${suffix}`, {
    method: "PUT",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function deleteSpackCatalogPackage(id: string): Promise<void> {
  await requestJson<SpackCatalogPackage>(`/spack/catalog/packages/${id}`, {
    method: "DELETE",
    headers: writeHeaders(),
  });
}

export async function listAppTemplates(): Promise<AppTemplate[]> {
  const body = await requestJson<{ appTemplates?: AppTemplate[] }>("/app-templates");
  return body.appTemplates ?? [];
}

export async function createAppTemplate(payload: AppTemplateCreate): Promise<AppTemplate> {
  return requestJson<AppTemplate>("/app-templates", {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function updateAppTemplate(
  id: string,
  payload: AppTemplateUpdate,
): Promise<AppTemplate> {
  return requestJson<AppTemplate>(`/app-templates/${id}`, {
    method: "PUT",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function deleteAppTemplate(id: string): Promise<void> {
  await requestJson<AppTemplate>(`/app-templates/${id}`, {
    method: "DELETE",
    headers: writeHeaders(),
  });
}

export async function listUsecasePackages(
  input: { orgId?: string } = {},
): Promise<UsecasePackage[]> {
  const params = new URLSearchParams();
  if (input.orgId) params.set("orgId", input.orgId);
  const suffix = params.toString();
  const body = await requestJson<{ usecasePackages?: UsecasePackage[] }>(
    `/usecase-packages${suffix ? `?${suffix}` : ""}`,
  );
  return body.usecasePackages ?? [];
}

export async function listUsecasePackagePage(
  input: { orgId?: string; page?: number; pageSize?: number; q?: string; tag?: string } = {},
): Promise<UsecasePackagePage> {
  const params = new URLSearchParams();
  params.set("page", String(input.page ?? 1));
  params.set("pageSize", String(input.pageSize ?? 24));
  if (input.orgId) params.set("orgId", input.orgId);
  if (input.q?.trim()) params.set("q", input.q.trim());
  if (input.tag?.trim()) params.set("tag", input.tag.trim());
  const body = await requestJson<Partial<UsecasePackagePage>>(
    `/usecase-packages?${params.toString()}`,
  );
  const usecasePackages = body.usecasePackages ?? [];
  const pageSize = body.pageSize ?? input.pageSize ?? 24;
  const total = body.total ?? usecasePackages.length;
  const page = body.page ?? input.page ?? 1;
  const totalPages = body.totalPages ?? Math.max(1, Math.ceil(total / pageSize));
  return {
    usecasePackages,
    tags: body.tags ?? [],
    total,
    page,
    pageSize,
    totalPages,
    hasNext: body.hasNext ?? page < totalPages,
  };
}

export async function getUsecasePackage(id: string): Promise<UsecasePackage> {
  return requestJson<UsecasePackage>(`/usecase-packages/${encodeURIComponent(id)}`);
}

export async function createUsecasePackage(
  payload: UsecasePackageCreate,
  orgId?: string,
): Promise<UsecasePackage> {
  const suffix = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  return requestJson<UsecasePackage>(`/usecase-packages${suffix}`, {
    method: "POST",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function updateUsecasePackage(
  id: string,
  payload: UsecasePackageUpdate,
  orgId?: string,
): Promise<UsecasePackage> {
  const suffix = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
  return requestJson<UsecasePackage>(`/usecase-packages/${id}${suffix}`, {
    method: "PUT",
    headers: writeHeaders(),
    body: JSON.stringify(payload),
  });
}

export async function deleteUsecasePackage(id: string): Promise<void> {
  await requestJson<UsecasePackage>(`/usecase-packages/${id}`, {
    method: "DELETE",
    headers: writeHeaders(),
  });
}

export const PENDING_TEMPLATE_KEY = "kq.pending-template";

export interface PendingTemplate {
  yaml: string;
  source?: string;
}

export function stashPendingTemplate(t: PendingTemplate): void {
  if (typeof sessionStorage === "undefined") return;
  sessionStorage.setItem(PENDING_TEMPLATE_KEY, JSON.stringify(t));
}

export function consumePendingTemplate(): PendingTemplate | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(PENDING_TEMPLATE_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING_TEMPLATE_KEY);
  try {
    return JSON.parse(raw) as PendingTemplate;
  } catch {
    return null;
  }
}
