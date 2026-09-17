import type {
  AgentGpuSample,
  StepJobs,
  WorkflowRunGraph,
  WorkflowRunRecordResult,
} from "@kuintessence/shared";
import { type FetchLike, fetchRemoteSoftwareCatalog } from "../../commands/software";
import type { ApiClient } from "../../lib/api-client";
import type { CliConfig } from "../../lib/config";
import {
  buildJobWsUrl,
  buildWorkflowWsUrl,
  type JobWsFactory,
  type JobWsLike,
  subscribeJobStatus,
  subscribeWorkflowEvents,
} from "./job-status-stream";
import type {
  TuiAgent,
  TuiBackend,
  TuiBackendCapabilities,
  TuiBackendInfo,
  TuiJob,
  TuiJobDetail,
  TuiJobStatus,
  TuiSoftware,
  TuiSoftwarePage,
  TuiSoftwareQuery,
  TuiSubmitResult,
  TuiWorkflowDetail,
  TuiWorkflowRun,
  TuiWorkflowStep,
} from "./types";

interface RemoteJobListItem {
  id: string;
  name: string;
  status: string;
  submittedAt?: string;
  agentId?: string | null;
}

interface RemoteJobsList {
  jobs: RemoteJobListItem[];
}

interface RemoteWorkflowRow {
  id: string;
  name: string;
  status: string;
  createdAt?: string;
}

interface RemoteWorkflowDetail extends RemoteWorkflowRow {
  description?: string | null;
  graph?: WorkflowRunGraph | null;
  stepJobs?: StepJobs;
  result?: WorkflowRunRecordResult | null;
}

/** Use node results when available; otherwise only display nodes from the run graph. */
function toSteps(detail: RemoteWorkflowDetail): TuiWorkflowStep[] {
  if (detail.result) {
    return Object.entries(detail.result.status).map(([nodeId, status]) => {
      const values = detail.result?.values[nodeId]?.values ?? {};
      const info = Object.keys(values).length > 0 ? JSON.stringify(values) : undefined;
      return { id: nodeId, status, info };
    });
  }
  return (detail.graph?.nodes ?? []).map((node) => {
    const jobId = detail.stepJobs?.[node.id];
    return { id: node.id, status: "unknown", info: jobId ? `job ${jobId}` : undefined };
  });
}

interface RemoteAgentRow {
  agentId: string;
  siteName: string;
  schedulerType: string;
  schedulerVersion: string;
  status: string;
  cpuUsagePercent?: number | null;
  memoryUsedMb?: number | null;
  memoryTotalMb?: number | null;
  queueDepth?: number | null;
  maxConcurrentJobs?: number | null;
  diskUsedPercent?: number | null;
  gpus?: AgentGpuSample[];
  lastHeartbeat?: string | null;
}

/** Normalise a Server job-status string into the TUI's closed status set. */
function toTuiStatus(raw: string): TuiJobStatus {
  switch (raw.toLowerCase()) {
    case "queued":
    case "pending":
    case "submitted":
      return "queued";
    case "running":
    case "online":
    case "connected":
      return "running";
    case "completed":
    case "succeeded":
      return "completed";
    case "failed":
    case "offline":
    case "disconnected":
      return "failed";
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return "unknown";
  }
}

/** Scenario 1: the TUI as a client of a remote Server. Inherits all server-side
 *  auth/RBAC/desensitization — it merely renders what the API returns. */
export class RemoteBackend implements TuiBackend {
  readonly info: TuiBackendInfo;
  readonly capabilities: TuiBackendCapabilities = {
    jobs: true,
    submit: true,
    logs: true,
    workflows: true,
    agents: true,
    metrics: true,
    software: true,
    ssh: true,
  };

  private readonly serverUrl: string;
  private readonly token: string | undefined;
  private readonly wsFactory: JobWsFactory;

  constructor(
    private readonly client: ApiClient,
    private readonly config: CliConfig,
    wsFactory?: JobWsFactory,
    private readonly softwareFetch: FetchLike = (input, init) => fetch(input, init),
  ) {
    this.info = { mode: "remote", target: config.serverUrl };
    this.serverUrl = config.serverUrl;
    this.token = config.token;
    this.wsFactory = wsFactory ?? ((url) => new WebSocket(url) as unknown as JobWsLike);
  }

  async listJobs(): Promise<TuiJob[]> {
    const res = await this.client.get<RemoteJobsList>("/jobs");
    return res.jobs.map((j) => ({
      id: j.id,
      name: j.name,
      status: toTuiStatus(j.status),
      location: j.agentId ?? "—",
      submittedAt: j.submittedAt,
    }));
  }

  async cancelJob(id: string): Promise<void> {
    await this.client.post(`/jobs/${id}/cancel`, {});
  }

  subscribeJobStatus(id: string, onStatus: (status: TuiJobStatus) => void): () => void {
    return subscribeJobStatus({
      url: buildJobWsUrl(this.serverUrl, id, this.token),
      wsFactory: this.wsFactory,
      onStatus: (raw) => onStatus(toTuiStatus(raw)),
    });
  }

  async getJobDetail(id: string): Promise<TuiJobDetail> {
    const j = await this.client.get<{
      id: string;
      name: string;
      status: string;
      schedulerJobId?: string | null;
      node?: string | null;
      reason?: string | null;
      startedAt?: string | null;
      completedAt?: string | null;
      exitCode?: number | null;
      command?: string | null;
      cpus?: number | null;
      memoryMb?: number | null;
      gpus?: number | null;
      wallTimeSec?: number | null;
    }>(`/jobs/${id}`);
    return {
      id: j.id,
      name: j.name,
      status: toTuiStatus(j.status),
      schedulerJobId: j.schedulerJobId ?? undefined,
      node: j.node ?? undefined,
      reason: j.reason ?? undefined,
      startedAt: j.startedAt ?? undefined,
      completedAt: j.completedAt ?? undefined,
      exitCode: j.exitCode ?? undefined,
      command: j.command ?? undefined,
      cpus: j.cpus ?? undefined,
      memoryMb: j.memoryMb ?? undefined,
      gpus: j.gpus ?? undefined,
      wallTimeSec: j.wallTimeSec ?? undefined,
    };
  }

  async submitFromSpec(raw: string): Promise<TuiSubmitResult> {
    let spec: unknown;
    try {
      spec = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Spec file is not valid JSON: ${err instanceof Error ? err.message : err}`);
    }
    const job = await this.client.post<{ id: string; name?: string }>("/jobs", spec);
    return { id: job.id, name: job.name };
  }

  async listWorkflows(): Promise<TuiWorkflowRun[]> {
    const res = await this.client.get<{ runs: RemoteWorkflowRow[] }>("/workflows");
    return res.runs.map((r) => ({
      id: r.id,
      name: r.name,
      status: toTuiStatus(r.status),
      createdAt: r.createdAt,
    }));
  }

  async getJobLogs(id: string, lines: number): Promise<string> {
    const r = await this.client.get<{ text: string }>(`/jobs/${id}/logs?text=1&lines=${lines}`);
    return r.text ?? "";
  }

  subscribeWorkflowStatus(id: string, onStep: () => void): () => void {
    return subscribeWorkflowEvents({
      url: buildWorkflowWsUrl(this.serverUrl, id, this.token),
      wsFactory: this.wsFactory,
      onStep,
    });
  }

  async submitWorkflow(yaml: string): Promise<TuiSubmitResult> {
    const r = await this.client.post<{ runId: string; name?: string }>("/workflows", { yaml });
    return { id: r.runId, name: r.name };
  }

  async getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    const r = await this.client.get<RemoteWorkflowDetail>(`/workflows/${id}`);
    return {
      id: r.id,
      name: r.name,
      status: toTuiStatus(r.status),
      description: r.description ?? undefined,
      steps: toSteps(r),
      result: r.result,
      graph: r.graph,
      stepJobs: r.stepJobs,
    };
  }

  async listAgents(): Promise<TuiAgent[]> {
    const res = await this.client.get<{ agents: RemoteAgentRow[] }>("/agents");
    return res.agents.map((a) => ({
      id: a.agentId,
      site: a.siteName,
      scheduler: `${a.schedulerType} ${a.schedulerVersion}`.trim(),
      status: toTuiStatus(a.status),
      cpuPercent: a.cpuUsagePercent ?? undefined,
      memoryUsedMb: a.memoryUsedMb ?? undefined,
      memoryTotalMb: a.memoryTotalMb ?? undefined,
      queueDepth: a.queueDepth ?? undefined,
      maxConcurrentJobs: a.maxConcurrentJobs ?? undefined,
      diskUsedPercent: a.diskUsedPercent ?? undefined,
      gpus: a.gpus,
      lastHeartbeat: a.lastHeartbeat ?? undefined,
    }));
  }

  async listSoftware(): Promise<TuiSoftware[]> {
    return (await this.listSoftwarePage({})).items;
  }

  async listSoftwarePage(query: TuiSoftwareQuery): Promise<TuiSoftwarePage> {
    const catalog = await fetchRemoteSoftwareCatalog(this.config, query, this.softwareFetch);
    return {
      items: catalog.packages.map((item) => ({
        id: item.id ?? `catalog:${item.source}:${item.name}`,
        name: item.name,
        source: item.source,
        versions: item.metadata?.versions ?? [],
        lifecycle: item.asset?.lifecycle ?? "catalog",
      })),
      page: catalog.page,
      pageSize: catalog.pageSize,
      totalCount: catalog.totalCount,
      totalPages: catalog.totalPages,
    };
  }
}
