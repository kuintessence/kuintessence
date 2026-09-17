import type {
  EffectiveSandboxPolicy,
  PlannerMode,
  SandboxLanguage,
  SandboxPolicyOverlay,
  SandboxRuntimeProfile,
  ScriptAttestation,
  ScriptInputSpec,
  ScriptOutputSpec,
  SoftwareAssetLifecycle,
  SoftwareAssetPayload,
  SoftwareAssetVisibility,
} from "@kuintessence/shared/browser";
import { api } from "./api-client";

export type SandboxScriptPayload = Extract<SoftwareAssetPayload, { kind: "sandbox-script" }>;

export interface SandboxScriptAsset {
  id: string;
  kind: "sandbox-script";
  name: string;
  version: string;
  source: string;
  lifecycle: SoftwareAssetLifecycle;
  visibility: SoftwareAssetVisibility;
  ownerUserId: string | null;
  ownerOrgId: string | null;
  providerOrgId: string | null;
  payload: SandboxScriptPayload;
  trustedForGlobalUse: boolean;
  sharedAccountEligible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxScriptRevision {
  id: string;
  assetId: string;
  revision: number;
  payload: SandboxScriptPayload;
  provenance: Record<string, unknown>;
  contentSha256: string | null;
  createdBy: string | null;
  createdAt: string;
}

export interface SandboxScriptDetail {
  asset: SandboxScriptAsset;
  revisions: SandboxScriptRevision[];
  attestations: ScriptAttestation[];
}

export interface SandboxScriptWrite {
  name: string;
  version: string;
  language: SandboxLanguage;
  runtimeProfileId: string;
  entrypoint: string;
  content: string;
  inputs: Record<string, ScriptInputSpec>;
  outputs: Record<string, ScriptOutputSpec>;
}

export interface SandboxTestRunResult {
  runId: string;
  name: string;
  status: "submitted" | "awaiting_approval";
}

export interface SandboxAccountCandidate {
  id: string;
  providerOrgId: string;
  agentId: string;
  displayName: string;
  backendType: "unix" | "kubernetes";
  schedulerType: string;
  siteName: string;
}

export interface SandboxExecutionAccount {
  id: string;
  providerOrgId: string;
  agentId: string;
  displayName: string;
  backendType: "unix" | "kubernetes";
  username: string | null;
  uid: number | null;
  gid: number | null;
  schedulerAccount: string | null;
  allowedQueues: string[];
  namespace: string | null;
  serviceAccount: string | null;
  quotaPolicy: Record<string, string>;
  sharedService: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SandboxAccountMappingView {
  mapping: {
    id: string;
    userId: string;
    accountId: string;
    status: "pending" | "approved" | "rejected" | "revoked" | "expired";
    isDefault: boolean;
    requestedAt: string;
    expiresAt: string | null;
  };
  account: {
    id: string;
    providerOrgId: string;
    agentId: string;
    displayName: string;
    backendType: "unix" | "kubernetes";
    username: string | null;
    schedulerAccount: string | null;
    allowedQueues: string[];
    namespace: string | null;
    serviceAccount: string | null;
    enabled: boolean;
  };
}

export interface SandboxAgentSecurityView {
  agentId: string;
  siteName: string;
  providerOrgId: string | null;
  clusterId: string | null;
  schedulerType: string;
  status: string;
  rootMode: boolean;
  sandboxReadiness: "ready" | "degraded" | "critical";
  sandboxCapabilities: Record<string, unknown>;
}

export interface SandboxPolicyOverlayView {
  id: string;
  scope: "platform" | "provider" | "cluster" | "agent";
  providerOrgId: string | null;
  clusterId: string | null;
  agentId: string | null;
  policy: SandboxPolicyOverlay;
}

export async function listSandboxScripts(): Promise<SandboxScriptAsset[]> {
  const body = await api.get<{ success: true; data: SandboxScriptAsset[] }>("/sandbox/scripts");
  return body.data;
}

export async function getSandboxScript(id: string): Promise<SandboxScriptDetail> {
  const body = await api.get<{ success: true; data: SandboxScriptDetail }>(
    `/sandbox/scripts/${id}`,
  );
  return body.data;
}

export async function createSandboxScript(
  input: SandboxScriptWrite,
): Promise<{ asset: SandboxScriptAsset; revision: SandboxScriptRevision }> {
  const body = await api.post<{
    success: true;
    data: { asset: SandboxScriptAsset; revision: SandboxScriptRevision };
  }>("/sandbox/scripts", input);
  return body.data;
}

export async function createSandboxScriptRevision(
  id: string,
  input: SandboxScriptWrite & { changelog?: string },
): Promise<SandboxScriptRevision> {
  const body = await api.post<{ success: true; data: SandboxScriptRevision }>(
    `/sandbox/scripts/${id}/revisions`,
    input,
  );
  return body.data;
}

export async function deleteSandboxScript(id: string): Promise<void> {
  await api.delete(`/sandbox/scripts/${id}`);
}

export async function listSandboxRuntimeProfiles(): Promise<SandboxRuntimeProfile[]> {
  const body = await api.get<{ success: true; data: SandboxRuntimeProfile[] }>(
    "/sandbox/runtime-profiles",
  );
  return body.data;
}

export async function renderSandboxPrompt(
  id: string,
  input: {
    locale: "zh-CN" | "en-US";
    sourceApp?: string;
    targetApp?: string;
    usecase?: string;
  },
): Promise<string> {
  const body = await api.post<{ success: true; data: { prompt: string } }>(
    `/sandbox/scripts/${id}/render-prompt`,
    input,
  );
  return body.data.prompt;
}

export async function runSandboxScriptTest(
  id: string,
  input: { fixtures: Record<string, unknown>; mappingId?: string; plannerMode: PlannerMode },
): Promise<SandboxTestRunResult> {
  const body = await api.post<{ success: true; data: SandboxTestRunResult }>(
    `/sandbox/scripts/${id}/test-runs`,
    input,
  );
  return body.data;
}

export async function listSandboxAccountCandidates(): Promise<SandboxAccountCandidate[]> {
  const body = await api.get<{ success: true; data: SandboxAccountCandidate[] }>(
    "/sandbox/account-candidates",
  );
  return body.data;
}

export async function listSandboxExecutionAccounts(): Promise<SandboxExecutionAccount[]> {
  const body = await api.get<{ success: true; data: SandboxExecutionAccount[] }>(
    "/sandbox/accounts",
  );
  return body.data;
}

export async function listSandboxAccountMappings(): Promise<SandboxAccountMappingView[]> {
  const body = await api.get<{ success: true; data: SandboxAccountMappingView[] }>(
    "/sandbox/account-mappings",
  );
  return body.data;
}

export async function requestSandboxAccountMapping(accountId: string): Promise<void> {
  await api.post("/sandbox/account-mappings", { accountId });
}

export async function setDefaultSandboxAccountMapping(mappingId: string): Promise<void> {
  await api.put(`/sandbox/account-mappings/${mappingId}/default`, {});
}

export async function listSandboxMappingReviewQueue(): Promise<SandboxAccountMappingView[]> {
  const body = await api.get<{ success: true; data: SandboxAccountMappingView[] }>(
    "/sandbox/account-mapping-review-queue",
  );
  return body.data;
}

export async function reviewSandboxAccountMapping(
  mappingId: string,
  status: "approved" | "rejected" | "revoked",
): Promise<void> {
  await api.patch(`/sandbox/account-mappings/${mappingId}`, { status });
}

export async function listSandboxAgentSecurityViews(): Promise<SandboxAgentSecurityView[]> {
  const body = await api.get<{ agents: SandboxAgentSecurityView[] }>("/agents");
  return body.agents;
}

export async function getEffectiveSandboxPolicy(agentId: string): Promise<EffectiveSandboxPolicy> {
  const body = await api.get<{ success: true; data: EffectiveSandboxPolicy }>(
    `/sandbox/policies/effective/${encodeURIComponent(agentId)}`,
  );
  return body.data;
}

export async function listSandboxPolicyOverlays(): Promise<SandboxPolicyOverlayView[]> {
  const body = await api.get<{ success: true; data: SandboxPolicyOverlayView[] }>(
    "/sandbox/policies",
  );
  return body.data;
}

export async function updatePlatformSandboxPolicy(policy: SandboxPolicyOverlay): Promise<void> {
  await api.put("/sandbox/policies/platform", { policy });
}
