import type {
  TuiAgent,
  TuiBackend,
  TuiBackendCapabilities,
  TuiBackendInfo,
  TuiJob,
  TuiJobDetail,
  TuiJobStatus,
  TuiSoftware,
  TuiSubmitResult,
  TuiWorkflowDetail,
  TuiWorkflowRun,
} from "./types";
import { UnsupportedInModeError } from "./types";

interface ExternalAgentOptions {
  /** Bearer token the agent's `serve` was started with, when it requires auth. */
  token?: string;
  /** Injectable fetch — the tests drive the real serve handler through this. */
  fetchImpl?: typeof fetch;
}

/**
 * Scenario 3: a remote `kq` driving a login-node `kq agent serve` over HTTP, no
 * Server. The mirror image of {@link createAgentServer}: every method maps to one
 * route of that contract. The agent runs the local scheduler, so capabilities
 * are the local-feasible subset (no agents-registry, no SSH, metrics absent);
 * they are read once at {@link create} time from `/capabilities` rather than
 * hard-coded, so the client honestly reflects whatever the agent reports.
 *
 * There is no push channel (the agent only exposes REST), so the subscribe
 * methods are no-ops and the TUI relies on polling — same as local mode.
 */
export class ExternalAgentBackend implements TuiBackend {
  readonly info: TuiBackendInfo;
  readonly capabilities: TuiBackendCapabilities;

  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  private constructor(
    baseUrl: string,
    info: TuiBackendInfo,
    capabilities: TuiBackendCapabilities,
    opts: ExternalAgentOptions,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.info = info;
    this.capabilities = capabilities;
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Build a fully-initialized backend by reading the agent's `/capabilities`
   *  and `/info` first, so the panes see the agent's real surface. The header
   *  target is the agent URL regardless of what `/info` reports as its own
   *  (local) target. */
  static async create(
    baseUrl: string,
    opts: ExternalAgentOptions = {},
  ): Promise<ExternalAgentBackend> {
    const normalized = baseUrl.replace(/\/$/, "");
    const probe = new ExternalAgentBackend(
      normalized,
      { mode: "remote", target: `agent ${normalized}` },
      EMPTY_CAPABILITIES,
      opts,
    );
    const capabilities = await probe.request<TuiBackendCapabilities>("GET", "/capabilities");
    await probe.request<TuiBackendInfo>("GET", "/info");
    return new ExternalAgentBackend(
      normalized,
      { mode: "remote", target: `agent ${normalized}` },
      capabilities,
      opts,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    if (!res.ok) {
      throw await this.toError(res);
    }
    return (await res.json()) as T;
  }

  /** Shape a non-2xx response: a 501 with `{ unsupported: true }` re-raises the
   *  agent's {@link UnsupportedInModeError}; anything else becomes a plain Error
   *  carrying the server's `{ error }` message when present. */
  private async toError(res: Response): Promise<Error> {
    let payload: { error?: string; unsupported?: boolean } = {};
    try {
      payload = (await res.json()) as typeof payload;
    } catch {
      payload = {};
    }
    if (res.status === 501 && payload.unsupported) {
      return new UnsupportedInModeError(payload.error ?? "feature", this.info.mode);
    }
    const message = payload.error ?? res.statusText ?? `HTTP ${res.status}`;
    return new Error(`agent request failed (${res.status}): ${message}`);
  }

  listJobs(): Promise<TuiJob[]> {
    return this.request<TuiJob[]>("GET", "/jobs");
  }

  async cancelJob(id: string): Promise<void> {
    await this.request<void>("DELETE", `/jobs/${encodeURIComponent(id)}`);
  }

  getJobDetail(id: string): Promise<TuiJobDetail> {
    return this.request<TuiJobDetail>("GET", `/jobs/${encodeURIComponent(id)}`);
  }

  subscribeJobStatus(_id: string, _onStatus: (status: TuiJobStatus) => void): () => void {
    return () => {};
  }

  submitFromSpec(raw: string): Promise<TuiSubmitResult> {
    return this.request<TuiSubmitResult>("POST", "/jobs", { spec: raw });
  }

  async getJobLogs(id: string, lines: number): Promise<string> {
    const r = await this.request<{ logs: string }>(
      "GET",
      `/jobs/${encodeURIComponent(id)}/logs?lines=${lines}`,
    );
    return r.logs ?? "";
  }

  listWorkflows(): Promise<TuiWorkflowRun[]> {
    return this.request<TuiWorkflowRun[]>("GET", "/workflows");
  }

  submitWorkflow(yaml: string): Promise<TuiSubmitResult> {
    return this.request<TuiSubmitResult>("POST", "/workflows", { yaml });
  }

  getWorkflowDetail(id: string): Promise<TuiWorkflowDetail> {
    return this.request<TuiWorkflowDetail>("GET", `/workflows/${encodeURIComponent(id)}`);
  }

  subscribeWorkflowStatus(_id: string, _onStep: () => void): () => void {
    return () => {};
  }

  listAgents(): Promise<TuiAgent[]> {
    return this.request<TuiAgent[]>("GET", "/agents");
  }

  listSoftware(): Promise<TuiSoftware[]> {
    return this.request<TuiSoftware[]>("GET", "/software");
  }
}

const EMPTY_CAPABILITIES: TuiBackendCapabilities = {
  jobs: false,
  submit: false,
  logs: false,
  workflows: false,
  agents: false,
  metrics: false,
  software: false,
  ssh: false,
};
