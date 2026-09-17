/**
 * The data surface the TUI panes depend on. Two implementations satisfy it:
 *
 *  - {@link RemoteBackend} — talks to a remote Server over REST/WS (scenario 1:
 *    TUI as a client of a central server).
 *  - {@link LocalBackend} — drives the local scheduler (Slurm/PBS/…) directly
 *    via a `@kuintessence/agent` adapter (scenario 2: the all-in-one `kq`
 *    binary on an HPC login node, no Server required).
 *
 * Panes never branch on which backend they hold; they render whatever the
 * backend returns and disable actions the backend declares unsupported.
 */

import type {
  AgentGpuSample,
  StepJobs,
  WorkflowRunGraph,
  WorkflowRunRecordResult,
} from "@kuintessence/shared";

export type TuiJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export interface TuiJob {
  /** Identifier used for detail/cancel — a Server job id (remote) or a scheduler
   *  job id (local). Opaque to the panes. */
  id: string;
  name: string;
  status: TuiJobStatus;
  /** Where it runs: agent/site (remote) or partition/queue (local). */
  location: string;
  submittedAt?: string;
}

export interface TuiWorkflowRun {
  id: string;
  name: string;
  status: TuiJobStatus;
  createdAt?: string;
}

export interface TuiAgent {
  id: string;
  site: string;
  scheduler: string;
  status: TuiJobStatus;
  /** Live resource snapshot (Server agent row). Absent until the agent reports. */
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  queueDepth?: number;
  maxConcurrentJobs?: number;
  /** Latest disk usage + per-GPU telemetry (Server `agent_metrics`). Remote mode
   *  only — local mode has no agent registry, so these stay absent/empty. */
  diskUsedPercent?: number;
  gpus?: AgentGpuSample[];
  /** ISO time of the agent's last heartbeat (Server row). Drives a "last seen"
   *  staleness hint; absent in local mode (the synthetic node is always live). */
  lastHeartbeat?: string;
}

export interface TuiSoftware {
  /** Catalog package id when present, otherwise a source-qualified key. */
  id: string;
  name: string;
  source: string;
  versions: string[];
  lifecycle: string;
  /** Local installed catalogs may expose a concrete Spack spec. */
  spec?: string;
  /** Present only when the backing catalog has real governance lock state. */
  locked?: boolean;
  /** Installed-spec fields exposed by local Spack and the Server-compatible GUI API. */
  hash?: string;
  compiler?: string | null;
  reportedAt?: string;
}

export interface TuiSoftwareQuery {
  page?: number;
  pageSize?: number;
  query?: string;
}

export interface TuiSoftwarePage {
  items: TuiSoftware[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

export interface TuiJobDetail {
  id: string;
  name: string;
  status: TuiJobStatus;
  schedulerJobId?: string;
  startedAt?: string;
  completedAt?: string;
  exitCode?: number;
  /** Allocated node / node-list when the scheduler reports it (Slurm `nodes`). */
  node?: string;
  /** Scheduler reason a job is pending/blocked (Slurm `state_reason`). */
  reason?: string;
  /** Submit-time resource request, when known (local mode, from the SQLite
   *  store — the scheduler status doesn't carry these back). */
  command?: string;
  cpus?: number;
  memoryMb?: number;
  gpus?: number;
  /** Wall-clock time limit in seconds, when the submit spec set one. */
  wallTimeSec?: number;
  /** Extra context — e.g. a scheduler state message in local mode. */
  message?: string;
}

export interface TuiWorkflowStep {
  id: string;
  status: string;
  /** Extra node context, such as produced values. */
  info?: string;
}

export interface TuiWorkflowDetail {
  id: string;
  name: string;
  status: TuiJobStatus;
  description?: string;
  steps: TuiWorkflowStep[];
  /** Structured run data for consumers; never reconstructed from display-only step info. */
  result?: WorkflowRunRecordResult | null;
  graph?: WorkflowRunGraph | null;
  stepJobs?: StepJobs;
}

export interface TuiBackendCapabilities {
  /** Listing/cancelling jobs — always true (the P0 vertical slice). */
  jobs: boolean;
  /** Submitting a job from a spec file. */
  submit: boolean;
  /** Viewing a job's stdout/stderr tail. Server-only — local mode doesn't track
   *  scheduler output paths. */
  logs: boolean;
  workflows: boolean;
  agents: boolean;
  /** Per-agent resource dashboard (reuses the agents data). Server-only. */
  metrics: boolean;
  software: boolean;
  /** Opening an interactive SSH shell to an agent via the Server gateway. Server-only
   *  — local mode runs on the login node itself, so SSH is moot. */
  ssh: boolean;
}

export interface TuiSubmitResult {
  id: string;
  name?: string;
}

export interface TuiBackendInfo {
  mode: "remote" | "local";
  /** Human-readable target for the header: server URL (remote) or scheduler
   *  type+version (local). */
  target: string;
}

export interface TuiBackend {
  readonly info: TuiBackendInfo;
  readonly capabilities: TuiBackendCapabilities;

  listJobs(): Promise<TuiJob[]>;
  cancelJob(id: string): Promise<void>;
  /** Fetch a single job's enriched detail. Remote reads the Server record; local
   *  queries the scheduler (`adapter.status`) for live status + exit code. */
  getJobDetail(id: string): Promise<TuiJobDetail>;
  /** Subscribe to live status pushes for a job (Server WS). Returns an unsubscribe.
   *  Local mode has no Server push channel, so it returns a no-op and relies on
   *  polling. Best-effort: a failed connection degrades to polling silently. */
  subscribeJobStatus(id: string, onStatus: (status: TuiJobStatus) => void): () => void;
  /** Submit a job from raw spec-file contents (JSON). Remote passes it through
   *  to the Server; local maps it to the agent JobSpec and calls the scheduler. */
  submitFromSpec(raw: string): Promise<TuiSubmitResult>;
  /** Tail a job's combined stdout/stderr (Server-only). Local throws
   *  {@link UnsupportedInModeError}. */
  getJobLogs(id: string, lines: number): Promise<string>;
  /** Server-only (workflows capability). Local mode throws {@link UnsupportedInModeError}. */
  listWorkflows(): Promise<TuiWorkflowRun[]>;
  /** Submit a workflow run from raw YAML (Server-only). Returns the run id. Local
   *  mode throws {@link UnsupportedInModeError}. */
  submitWorkflow(yaml: string): Promise<TuiSubmitResult>;
  /** Server-only. Fetch a single run's step/node tree. */
  getWorkflowDetail(id: string): Promise<TuiWorkflowDetail>;
  /** Subscribe to live step events for a workflow run (Server WS). `onStep` fires
   *  on each step change; the caller re-fetches the tree. Returns unsubscribe.
   *  Local mode returns a no-op. */
  subscribeWorkflowStatus(id: string, onStep: () => void): () => void;
  /** Server-only (agents capability). Local mode throws {@link UnsupportedInModeError}. */
  listAgents(): Promise<TuiAgent[]>;
  /** Server-only (software capability). Local mode throws {@link UnsupportedInModeError}. */
  listSoftware(): Promise<TuiSoftware[]>;
  /** Catalog-aware remote listing. When absent, the App wraps `listSoftware()`
   *  as a single local page and applies its filter client-side. */
  listSoftwarePage?(query: TuiSoftwareQuery): Promise<TuiSoftwarePage>;
}

/** Raised when a pane requests something the active backend cannot do (e.g.
 *  workflows in local mode). Panes catch this and render a friendly notice. */
export class UnsupportedInModeError extends Error {
  constructor(
    public readonly feature: string,
    public readonly mode: TuiBackendInfo["mode"],
  ) {
    super(`"${feature}" is not available in ${mode} mode`);
    this.name = "UnsupportedInModeError";
  }
}
