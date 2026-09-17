import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { PLATFORM_WS_BASE } from "./platform-paths";

/**
 * Wire envelope from `/platform/ws/jobs/:id` (matches packages/server/src/routes/ws.ts).
 */
interface JobStatusMessage {
  type: "job.status";
  jobId: string;
  status: string;
  schedulerJobId?: string | null;
  agentId?: string | null;
  ts?: string;
}

function isJobStatusMessage(value: unknown): value is JobStatusMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v.type === "job.status" && typeof v.jobId === "string" && typeof v.status === "string";
}

/**
 * Build the WebSocket URL for the Server. When a legacy browser-readable token is
 * present we keep the query fallback; otherwise the same-origin HttpOnly cookie
 * is sent by the browser during the WebSocket handshake.
 */
function buildWsUrl(jobId: string, token: string | null): string {
  // happy-dom doesn't always populate window.location, fall back gracefully.
  const loc = typeof window !== "undefined" ? window.location : undefined;
  const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
  const host = loc?.host || "localhost";
  const base = `${proto}//${host}${PLATFORM_WS_BASE}/jobs/${encodeURIComponent(jobId)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * Subscribe to real-time job status updates for `jobId`.
 *
 * - Opens a WebSocket to /platform/ws/jobs/:id with either a legacy query token or the
 *   same-origin HttpOnly auth cookie
 * - On every job.status message, merges the new fields into the
 *   ["job-detail", jobId] query cache so the UI updates without a refetch
 * - On a non-clean close, invalidates the query so TanStack Query falls
 *   back to its existing REST polling — the user always sees fresh data
 *   even if the WS layer is unreachable
 * - Cleans up on unmount or jobId change
 *
 * The hook returns nothing — its only side effect is on the query cache.
 * Callers that already use `useQuery(["job-detail", jobId], …)` see the
 * updates automatically.
 */
export function useJobStatusStream(jobId: string | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!jobId) return;
    const token = localStorage.getItem("kq_token");

    const ws = new WebSocket(buildWsUrl(jobId, token));
    let cancelled = false;

    ws.onmessage = (evt) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(typeof evt.data === "string" ? evt.data : "");
        if (!isJobStatusMessage(data)) return;
        if (data.jobId !== jobId) return;
        qc.setQueryData(["job-detail", jobId], (prev: unknown) => {
          const base = (typeof prev === "object" && prev !== null ? prev : {}) as Record<
            string,
            unknown
          >;
          return {
            ...base,
            id: jobId,
            status: data.status,
            schedulerJobId: data.schedulerJobId ?? base.schedulerJobId ?? null,
            agentId: data.agentId ?? base.agentId ?? null,
          };
        });
        // Also keep the list view in sync if it's mounted.
        qc.invalidateQueries({ queryKey: ["jobs-list"], exact: false });
      } catch {
        // Ignore non-JSON or malformed messages.
      }
    };

    ws.onclose = (evt) => {
      if (cancelled) return;
      // Code 1000 = clean close (we initiated it via cleanup). Anything else
      // means the connection died — fall back to REST polling by invalidating
      // the query so TanStack Query refetches on its next interval.
      if (evt.code !== 1000) {
        qc.invalidateQueries({ queryKey: ["job-detail", jobId] });
      }
    };

    ws.onerror = () => {
      // Errors are followed by a close event; the close handler does the work.
    };

    return () => {
      cancelled = true;
      try {
        ws.close(1000, "unmount");
      } catch {
        // ignore
      }
    };
  }, [jobId, qc]);
}

/**
 * Wire envelope from `/platform/ws/workflows/:runId`.
 */
interface WorkflowStateMessage {
  type: "workflow.step";
  runId: string;
  stepId: string;
  jobId: string;
  status: string;
  ts?: string;
}

function isWorkflowStateMessage(value: unknown): value is WorkflowStateMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "workflow.step" &&
    typeof v.runId === "string" &&
    typeof v.stepId === "string" &&
    typeof v.jobId === "string" &&
    typeof v.status === "string"
  );
}

function buildWorkflowWsUrl(runId: string, token: string | null): string {
  const loc = typeof window !== "undefined" ? window.location : undefined;
  const proto = loc?.protocol === "https:" ? "wss:" : "ws:";
  const host = loc?.host || "localhost";
  const base = `${proto}//${host}${PLATFORM_WS_BASE}/workflows/${encodeURIComponent(runId)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * Subscribe to real-time workflow run state updates for `runId`.
 *
 * Each matching message updates the ["workflow-step-status", runId] cache
 * and invalidates the ["workflow-run", runId] query. Non-clean closes also
 * invalidate the run query; polling is configured by query consumers.
 */
export function useWorkflowStatusStream(runId: string | null): void {
  const qc = useQueryClient();

  useEffect(() => {
    if (!runId) return;
    const token = localStorage.getItem("kq_token");

    const ws = new WebSocket(buildWorkflowWsUrl(runId, token));
    let cancelled = false;

    ws.onmessage = (evt) => {
      if (cancelled) return;
      try {
        const data = JSON.parse(typeof evt.data === "string" ? evt.data : "");
        if (!isWorkflowStateMessage(data)) return;
        if (data.runId !== runId) return;
        // Maintain a per-step status map for downstream consumers.
        qc.setQueryData(
          ["workflow-step-status", runId],
          (prev: Record<string, string> | undefined) => ({
            ...(prev ?? {}),
            [data.stepId]: data.status,
          }),
        );
        qc.invalidateQueries({ queryKey: ["workflow-run", runId] });
      } catch {
        // Ignore non-JSON messages.
      }
    };

    ws.onclose = (evt) => {
      if (cancelled) return;
      if (evt.code !== 1000) {
        qc.invalidateQueries({ queryKey: ["workflow-run", runId] });
      }
    };

    return () => {
      cancelled = true;
      try {
        ws.close(1000, "unmount");
      } catch {
        // ignore
      }
    };
  }, [runId, qc]);
}
