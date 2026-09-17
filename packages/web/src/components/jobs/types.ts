/**
 * Job-related types shared by the Jobs page, JobDetailSheet, and workflow run view.
 */

export interface JobRow {
  id: string;
  name: string;
  status: string;
  submittedAt: string;
  accessScope?: JobAccessScope;
}

export interface JobDetail extends JobRow {
  command?: string | null;
  schedulerJobId?: string | null;
  agentId?: string | null;
  node?: string | null;
  reason?: string | null;
  workingDir?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  exitCode?: number | null;
  errorMessage?: string | null;
  resources?: { cpus?: number; memoryMb?: number } | null;
  appTemplateKey?: string | null;
  softwareRequirements?: Array<{ name: string; version?: string; installable?: boolean }> | null;
  usecasePackageId?: string | null;
  usecasePackageName?: string | null;
  usecasePackageVersion?: string | null;
  usecaseInputs?: Record<string, unknown> | null;
  inputStaging?: Array<{ fileMetadataId: string; stagePath: string; sourceUrl?: string }> | null;
  expectedOutputs?: Array<{ descriptor: string; path: string; isBatch: boolean }> | null;
  fileOutputDescriptors?: string[] | null;
  stdinText?: string | null;
}

export const STATUS_FILTERS = [
  "ALL",
  "PENDING",
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const ACCESS_SCOPE_FILTERS = [
  "all",
  "owner",
  "consumer_admin",
  "provider_operator",
  "platform",
] as const;

export type AccessScopeFilter = (typeof ACCESS_SCOPE_FILTERS)[number];
export type JobAccessScope = Exclude<AccessScopeFilter, "all"> | "authorization_service";
