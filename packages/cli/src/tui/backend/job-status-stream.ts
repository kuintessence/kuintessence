/**
 * Minimal WebSocket subscriptions for live pushes from the Server:
 *   - `/ws/jobs/:id`       envelope `{ type: "job.status", status, … }`
 *   - `/ws/workflows/:id`  envelope `{ type: "workflow.step", stepId, status, … }`
 *
 * Kept tiny and injectable so the lifecycle (open → message → close) is
 * unit-testable without a real socket, and so a failed open degrades silently
 * to the existing polling.
 */

/** The slice of the WebSocket API this module uses. Bun/browser `WebSocket`
 *  satisfies it structurally. */
export interface JobWsLike {
  addEventListener(type: "message", cb: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error" | "close", cb: () => void): void;
  close(): void;
}

export type JobWsFactory = (url: string) => JobWsLike;

function toWsBase(serverUrl: string): string {
  const trimmed = serverUrl.trim().replace(/\/+$/, "");
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  return trimmed;
}

/** Build the `ws(s)://…/ws/jobs/:id?token=` URL from the Server HTTP base URL. */
export function buildJobWsUrl(serverUrl: string, jobId: string, token?: string): string {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${toWsBase(serverUrl)}/ws/jobs/${jobId}${query}`;
}

/** Build the `ws(s)://…/ws/workflows/:id?token=` URL. */
export function buildWorkflowWsUrl(serverUrl: string, runId: string, token?: string): string {
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${toWsBase(serverUrl)}/ws/workflows/${runId}${query}`;
}

/**
 * Open a socket and deliver each parsed JSON frame to `onFrame`. Returns an
 * unsubscribe that closes the socket and suppresses further callbacks. Never
 * throws — a failed open is swallowed (the caller's polling stays live).
 */
function openWs(opts: {
  url: string;
  wsFactory: JobWsFactory;
  onFrame: (msg: Record<string, unknown>) => void;
}): () => void {
  let closed = false;
  let ws: JobWsLike | null = null;
  try {
    ws = opts.wsFactory(opts.url);
    ws.addEventListener("message", (ev) => {
      if (closed) return;
      try {
        const msg = JSON.parse(String(ev.data)) as Record<string, unknown>;
        opts.onFrame(msg);
      } catch {
        // Ignore malformed frames; polling remains the source of truth.
      }
    });
  } catch {
    // Open failed (offline, no WS support) — degrade to polling silently.
  }
  return () => {
    closed = true;
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}

/** Subscribe to a job's live status pushes. `onStatus` receives the raw status
 *  string from each `job.status` frame. */
export function subscribeJobStatus(opts: {
  url: string;
  wsFactory: JobWsFactory;
  onStatus: (rawStatus: string) => void;
}): () => void {
  return openWs({
    url: opts.url,
    wsFactory: opts.wsFactory,
    onFrame: (msg) => {
      if (msg.type === "job.status" && typeof msg.status === "string") {
        opts.onStatus(msg.status);
      }
    },
  });
}

/** Subscribe to a workflow run's step events. `onStep` fires for each
 *  `workflow.step` frame (the caller re-fetches the run's step tree). */
export function subscribeWorkflowEvents(opts: {
  url: string;
  wsFactory: JobWsFactory;
  onStep: () => void;
}): () => void {
  return openWs({
    url: opts.url,
    wsFactory: opts.wsFactory,
    onFrame: (msg) => {
      if (msg.type === "workflow.step") opts.onStep();
    },
  });
}
