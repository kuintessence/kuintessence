import type { StepJobs, WorkflowRunGraph, WorkflowRunRecordResult } from "@kuintessence/shared";
import type {
  TuiAgent,
  TuiJob,
  TuiJobDetail,
  TuiSoftware,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "../tui/backend/types";

/**
 * Pure mappers from the embedded kernel's {@link TuiBackend} shapes to the
 * Server-API JSON shapes the React SPA expects (see
 * `packages/web/src/lib/api-schemas/{jobs,workflows,agents}.ts`).
 *
 * The target shapes are mirrored here as plain interfaces rather than importing
 * the web package: `@kuintessence/web` is a leaf SPA with no library export
 * surface, and the SPA schemas are `.passthrough()` so the field names below are
 * the load-bearing contract. The kernel (`LocalBackend`) is leaner than the Server —
 * no agent registry, no placement trace, no live agent telemetry — so fields it
 * cannot supply are emitted as `null` (the SPA schemas tolerate `null`/absent),
 * letting the SPA degrade gracefully instead of throwing.
 */

export interface JobRow {
  id: string;
  name: string;
  status: string;
  submittedAt: string;
}

export interface JobDetail extends JobRow {
  command: string | null;
  schedulerJobId: string | null;
  agentId: string | null;
  node: string | null;
  startedAt: string | null;
  completedAt: string | null;
  exitCode: number | null;
  resources: { cpus?: number; memoryMb?: number } | null;
}

export interface WorkflowRunRow {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface WorkflowRunDetail extends WorkflowRunRow {
  description: string | null;
  result: WorkflowRunRecordResult | null;
  graph: WorkflowRunGraph | null;
  stepJobs: StepJobs;
}

export interface AgentRow {
  agentId: string;
  siteName: string;
  schedulerType: string;
  schedulerVersion: string;
  status: string;
  lastHeartbeat: string | null;
  cpuUsagePercent: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  maxConcurrentJobs: number | null;
  queueDepth: number | null;
}

/**
 * Installed-software row served under `/api/software/agents/:id/installed`.
 * The Server side returns rows keyed by spec; the kernel's catalog is a superset,
 * so we pass through its already-Server-friendly fields verbatim.
 */
export interface InstalledRow {
  name: string;
  version: string;
  hash: string;
  compiler: string | null;
  spec: string;
  reportedAt: string;
}

export function toJobRow(job: TuiJob): JobRow {
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    submittedAt: job.submittedAt ?? "",
  };
}

export function toJobDetail(detail: TuiJobDetail): JobDetail {
  const resources: { cpus?: number; memoryMb?: number } = {};
  if (typeof detail.cpus === "number") resources.cpus = detail.cpus;
  if (typeof detail.memoryMb === "number") resources.memoryMb = detail.memoryMb;
  const hasResources = resources.cpus !== undefined || resources.memoryMb !== undefined;
  return {
    id: detail.id,
    name: detail.name,
    status: detail.status,
    submittedAt: "",
    command: detail.command ?? null,
    schedulerJobId: detail.schedulerJobId ?? null,
    agentId: null,
    node: detail.node ?? null,
    startedAt: detail.startedAt ?? null,
    completedAt: detail.completedAt ?? null,
    exitCode: detail.exitCode ?? null,
    resources: hasResources ? resources : null,
  };
}

export function toWorkflowRunRow(run: TuiWorkflowRun): WorkflowRunRow {
  return {
    id: run.id,
    name: run.name,
    status: run.status,
    createdAt: run.createdAt ?? "",
  };
}

export function toWorkflowRunDetail(detail: TuiWorkflowDetail): WorkflowRunDetail {
  return {
    id: detail.id,
    name: detail.name,
    status: detail.status,
    createdAt: "",
    description: detail.description ?? null,
    result: detail.result ?? null,
    graph: detail.graph ?? null,
    stepJobs: detail.stepJobs ?? {},
  };
}

export function toAgentRow(agent: TuiAgent): AgentRow {
  const [schedulerType, ...rest] = agent.scheduler.split(" ");
  return {
    agentId: agent.id,
    siteName: agent.site,
    schedulerType: schedulerType ?? agent.scheduler,
    schedulerVersion: rest.join(" "),
    status: agent.status === "running" ? "online" : agent.status,
    lastHeartbeat: agent.lastHeartbeat ?? null,
    cpuUsagePercent: agent.cpuPercent ?? null,
    memoryUsedMb: agent.memoryUsedMb ?? null,
    memoryTotalMb: agent.memoryTotalMb ?? null,
    maxConcurrentJobs: agent.maxConcurrentJobs ?? null,
    queueDepth: agent.queueDepth ?? null,
  };
}

export function toInstalledRow(software: TuiSoftware): InstalledRow {
  if (!software.hash || !software.reportedAt) {
    throw new Error("local installed software is missing its Server contract fields");
  }
  return {
    name: software.name,
    version: software.versions[0] ?? "-",
    hash: software.hash,
    compiler: software.compiler ?? null,
    spec: software.spec ?? software.name,
    reportedAt: software.reportedAt,
  };
}
