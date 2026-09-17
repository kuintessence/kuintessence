import type { ListedJob, SchedulerAdapter } from "@kuintessence/agent/adapters";
import type { LocalJobStore, LocalSoftwareCatalog } from "@kuintessence/agent/embedded";
import type { AgentGpuSample } from "@kuintessence/shared";
import { parseJobSpec } from "../../lib/local-scheduler";
import {
  type TuiAgent,
  type TuiBackend,
  type TuiBackendCapabilities,
  type TuiBackendInfo,
  type TuiJob,
  type TuiJobDetail,
  type TuiJobStatus,
  type TuiSoftware,
  type TuiSubmitResult,
  type TuiWorkflowDetail,
  type TuiWorkflowRun,
  UnsupportedInModeError,
} from "./types";

/** How many already-evicted (no longer in the scheduler queue) persisted jobs
 *  the local jobs list appends, newest first — keeps a long-lived store from
 *  cluttering the view. */
const EVICTED_HISTORY_LIMIT = 50;
const EVICTED_STATUS_REFRESH_LIMIT = 4;
const EVICTED_STATUS_REFRESH_MS = 10_000;

function toTuiStatus(raw: ListedJob["status"]): TuiJobStatus {
  // ListedJob's status set is already a subset of TuiJobStatus.
  return raw;
}

const KNOWN_STATUSES: readonly TuiJobStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "unknown",
];

/** Coerce a persisted (string) status from the SQLite store into a TuiJobStatus,
 *  defaulting to "unknown" for anything unexpected. */
function looseStatus(s: string): TuiJobStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(s) ? (s as TuiJobStatus) : "unknown";
}

function isAuthoritativeStatus(result: Awaited<ReturnType<SchedulerAdapter["status"]>>): boolean {
  return (
    result.status === "queued" ||
    result.status === "running" ||
    result.status === "completed" ||
    (result.status === "failed" && result.exitCode !== undefined)
  );
}

/** This node's live resource snapshot, sampled directly on the login node (no
 *  Server). All fields optional — a sampler returns what it can read. */
export interface LocalTelemetry {
  cpuPercent?: number;
  memoryUsedMb?: number;
  memoryTotalMb?: number;
  queueDepth?: number;
  diskUsedPercent?: number;
  gpus?: AgentGpuSample[];
}

/** Injected so the monitor's `nvidia-smi`/`df`/`/proc` reads stay out of the
 *  CLI's unit tests; the production sampler wraps `@kuintessence/agent/monitor`. */
export interface LocalResourceSampler {
  sample(): Promise<LocalTelemetry>;
}

/** Local workflow surface, injected by the backend selector when valid workflow
 *  specs are present. `list` enumerates the runnable workflow specs under the
 *  data dir; `submit` parses one spec and runs it on the embedded
 *  {@link LocalWorkflowRunner}. Kept abstract here so the backend stays free of
 *  fs/YAML/runner wiring and is unit-testable with fakes. Without this surface,
 *  the workflows capability stays off and the workflow methods reject. */
export interface LocalWorkflowSupport {
  list(): Promise<TuiWorkflowRun[]>;
  submit(idOrName: string): Promise<TuiSubmitResult>;
  /** Read back a recorded run's terminal per-node detail by its run id (the id
   *  {@link submit} returns). `null` when the run id is unknown. Optional: a
   *  support surface without run read-back leaves the detail view unsupported. */
  getDetail?(runId: string): Promise<TuiWorkflowDetail | null>;
}

/** Scenario 2: the all-in-one `kq` binary on an HPC login node. There is no
 *  Server — the TUI drives the locally-detected scheduler (Slurm/PBS/…) through a
 *  `@kuintessence/agent` adapter. Workflows use the injected local runner; the
 *  multi-agent registry (+SSH) remains unavailable. When a resource sampler is supplied, the
 *  Metrics pane lights up with this single node's CPU/mem/queue/disk/GPU. */
export class LocalBackend implements TuiBackend {
  readonly info: TuiBackendInfo;
  readonly capabilities: TuiBackendCapabilities;
  private readonly evictedStatusNextCheck = new Map<string, number>();

  constructor(
    private readonly adapter: SchedulerAdapter,
    private readonly sampler?: LocalResourceSampler,
    /** Label for this node's synthetic Metrics row — the login-node hostname
     *  when known (filled by the backend selector), else "local". */
    private readonly nodeId: string = "local",
    /** Optional SQLite persistence: remembers kq-submitted jobs across restarts
     *  and after they leave the scheduler queue. Absent → pure live querying. */
    private readonly store?: LocalJobStore,
    /** Read-only Spack/module probe for this login node. Absent → the Software
     *  pane stays empty (`listSoftware` returns `[]`). */
    private readonly catalog?: LocalSoftwareCatalog,
    /** Whether `catalog.detect()` found spack/module on this node. Precomputed
     *  by the selector (detection is async; the capability is sync). */
    softwareDetected = false,
    /** Local workflow surface. When supplied, the Workflows pane is enabled and
     *  list/submit use the embedded runner; otherwise workflows stay disabled. */
    private readonly workflows?: LocalWorkflowSupport,
  ) {
    this.info = { mode: "local", target: `${adapter.type} ${adapter.version}`.trim() };
    this.capabilities = {
      jobs: typeof adapter.listJobs === "function",
      submit: true,
      logs: typeof adapter.getJobLogs === "function",
      workflows: workflows !== undefined,
      agents: false,
      metrics: sampler !== undefined,
      software: softwareDetected,
      ssh: false,
    };
  }

  async listJobs(): Promise<TuiJob[]> {
    if (!this.adapter.listJobs) {
      throw new UnsupportedInModeError(`job listing on ${this.adapter.type}`, "local");
    }
    const live = await this.adapter.listJobs();
    const liveJobs: TuiJob[] = live.map((j) => {
      const persistedStatus = this.store?.findBySchedulerId(j.schedulerJobId)?.status;
      const status = persistedStatus === "cancelled" ? "cancelled" : toTuiStatus(j.status);
      if (persistedStatus !== "cancelled") {
        this.store?.updateStatusBySchedulerId(j.schedulerJobId, j.status);
      }
      return {
        id: j.schedulerJobId,
        name: j.name,
        status,
        location: j.queue ?? "—",
        submittedAt: j.submittedAt,
      };
    });
    if (!this.store) return liveJobs;

    // Append persisted kq jobs that have already left the live queue.
    const liveIds = new Set(live.map((j) => j.schedulerJobId));
    // Cap the historical tail so a long-lived store doesn't grow the list
    // unboundedly; recent evicted jobs are the useful ones. `list` is
    // newest-first, so the first row for a (possibly recycled) scheduler id wins.
    const seen = new Set<string>(liveIds);
    const evicted: TuiJob[] = [];
    const now = Date.now();
    let refreshCount = 0;
    for (const p of this.store.list(EVICTED_HISTORY_LIMIT)) {
      if (p.schedulerJobId === undefined || seen.has(p.schedulerJobId)) continue;
      seen.add(p.schedulerJobId);
      let status = looseStatus(p.status);
      const active = status === "queued" || status === "running";
      const refreshDue = (this.evictedStatusNextCheck.get(p.schedulerJobId) ?? 0) <= now;
      if (active && refreshDue && refreshCount < EVICTED_STATUS_REFRESH_LIMIT) {
        refreshCount += 1;
        this.evictedStatusNextCheck.set(p.schedulerJobId, now + EVICTED_STATUS_REFRESH_MS);
        try {
          const latest = await this.adapter.status(p.schedulerJobId);
          if (isAuthoritativeStatus(latest)) {
            status = latest.status;
            this.store.updateStatusBySchedulerId(p.schedulerJobId, status, latest.exitCode);
            if (status !== "queued" && status !== "running") {
              this.evictedStatusNextCheck.delete(p.schedulerJobId);
            }
          }
        } catch {
          // Keep the last scheduler-confirmed state when accounting is temporarily unavailable.
        }
      }
      evicted.push({
        id: p.schedulerJobId,
        name: p.name ?? p.schedulerJobId,
        status,
        location: "—",
        submittedAt: p.submittedAt.toISOString(),
      });
    }
    return [...liveJobs, ...evicted];
  }

  async cancelJob(id: string): Promise<void> {
    await this.adapter.cancel(id);
    // Record the cancellation so the job doesn't linger with a stale running/
    // queued status once it drops out of the live scheduler queue.
    this.store?.updateStatusBySchedulerId(id, "cancelled");
  }

  subscribeJobStatus(_id: string, _onStatus: (status: TuiJobStatus) => void): () => void {
    // No Server push channel in local mode; the detail view polls via getJobDetail.
    return () => {};
  }

  async getJobDetail(id: string): Promise<TuiJobDetail> {
    // The scheduler job id is the row id in local mode. The persisted record (if
    // any) supplies the human name the scheduler status doesn't carry, and is
    // the fallback when the scheduler can no longer resolve an evicted job.
    const persisted = this.store?.findBySchedulerId(id);
    // Submit-time resource request, surfaced from the store (the scheduler
    // status call doesn't return it).
    const request = persisted
      ? {
          command: persisted.command,
          cpus: persisted.cpus,
          memoryMb: persisted.memoryMb,
          gpus: persisted.gpus,
          wallTimeSec: persisted.wallTimeSec,
        }
      : {};
    let s: Awaited<ReturnType<SchedulerAdapter["status"]>> | undefined;
    try {
      s = await this.adapter.status(id);
    } catch (err) {
      if (persisted) {
        return {
          id,
          name: persisted.name ?? id,
          status: looseStatus(persisted.status),
          schedulerJobId: id,
          exitCode: persisted.exitCode,
          ...request,
        };
      }
      throw err;
    }
    const authoritative = isAuthoritativeStatus(s);
    const locallyCancelled = persisted?.status === "cancelled";
    const status: TuiJobStatus = locallyCancelled
      ? "cancelled"
      : authoritative
        ? s.status
        : persisted
          ? looseStatus(persisted.status)
          : "unknown";
    const exitCode = authoritative ? s.exitCode : persisted?.exitCode;
    if (authoritative) {
      this.store?.updateStatusBySchedulerId(id, status, exitCode);
    }
    return {
      id,
      name: persisted?.name ?? id,
      status,
      schedulerJobId: id,
      exitCode,
      node: s.node,
      startedAt: s.startedAt,
      reason: s.reason,
      message: locallyCancelled || (!authoritative && persisted) ? undefined : s.message,
      ...request,
    };
  }

  async submitFromSpec(raw: string): Promise<TuiSubmitResult> {
    const spec = parseJobSpec(raw);
    const result = await this.adapter.submit(spec);
    this.store?.record({
      jobId: spec.jobId,
      schedulerJobId: result.schedulerJobId,
      name: spec.name,
      status: "queued",
      command: spec.command,
      cpus: spec.cpus,
      memoryMb: spec.memoryMb,
      gpus: spec.gpus,
      // 0 = scheduler default / no limit; store as unset so detail omits it.
      wallTimeSec: spec.wallTimeSec || undefined,
      submittedAt: new Date(),
    });
    return { id: result.schedulerJobId, name: spec.name };
  }

  getJobLogs(id: string, lines: number): Promise<string> {
    if (!this.adapter.getJobLogs) {
      return Promise.reject(
        new UnsupportedInModeError(`job logs on ${this.adapter.type}`, "local"),
      );
    }
    return this.adapter.getJobLogs(id, lines);
  }

  listWorkflows(): Promise<TuiWorkflowRun[]> {
    if (!this.workflows) {
      return Promise.reject(new UnsupportedInModeError("workflows", "local"));
    }
    return this.workflows.list();
  }

  /** In local mode the argument is a workflow spec id/name (a file under the
   *  data dir's `workflows/`), NOT raw YAML — the runner reads + parses the file.
   *  The remote backend treats this argument as raw YAML; panes pass whatever the
   *  active backend listed (an id here), so the two stay compatible. */
  submitWorkflow(idOrName: string): Promise<TuiSubmitResult> {
    if (!this.workflows) {
      return Promise.reject(new UnsupportedInModeError("workflows", "local"));
    }
    return this.workflows.submit(idOrName);
  }

  /** Read back a recorded local run's terminal per-node detail. The id is the
   *  run id {@link submitWorkflow} returned. Unsupported when no workflow surface
   *  (or no read-back) is wired; rejects with an Error when the id is unknown
   *  (mirroring the remote backend's 404 → throw). */
  async getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    if (!this.workflows?.getDetail) {
      throw new UnsupportedInModeError("workflows", "local");
    }
    const detail = await this.workflows.getDetail(id);
    if (!detail) {
      throw new Error(`workflow run "${id}" not found`);
    }
    return detail;
  }

  subscribeWorkflowStatus(_id: string, _onStep: () => void): () => void {
    return () => {};
  }

  async listAgents(): Promise<TuiAgent[]> {
    if (!this.sampler) {
      throw new UnsupportedInModeError("agents", "local");
    }
    const t = await this.sampler.sample();
    return [
      {
        id: this.nodeId,
        site: this.adapter.type,
        scheduler: `${this.adapter.type} ${this.adapter.version}`.trim(),
        status: "running",
        cpuPercent: t.cpuPercent,
        memoryUsedMb: t.memoryUsedMb,
        memoryTotalMb: t.memoryTotalMb,
        queueDepth: t.queueDepth,
        diskUsedPercent: t.diskUsedPercent,
        gpus: t.gpus,
      },
    ];
  }

  async listSoftware(): Promise<TuiSoftware[]> {
    if (!this.catalog) return [];
    const entries = await this.catalog.listInstalled();
    const reportedAt = new Date().toISOString();
    return entries.map((e) => ({
      id: `${e.source}/${e.hash}`,
      name: e.name,
      source: e.source,
      versions: [e.version],
      lifecycle: "installed",
      spec: e.spec,
      hash: e.hash,
      compiler: e.compiler ?? null,
      reportedAt,
    }));
  }
}
