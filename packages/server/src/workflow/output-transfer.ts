import { createHash } from "node:crypto";
import type { TransferCreate } from "@kuintessence/shared";
import type { TransferProgressEvent } from "../services/transfer-registry";

export interface OutputTransferInput {
  transferId: string;
  ownerId: string;
  source: string;
  target: string;
  agentId: string;
  jobId?: string;
  workflowRunId?: string;
  totalBytes?: number;
}

export interface OutputTransferRecord {
  userId: string;
  direction: string;
  source: string;
  target: string;
  agentId: string | null;
  jobId: string | null;
  workflowRunId: string | null;
  totalBytes: number | null;
  state: string;
  netdriveFileIds: string[];
}

export interface OutputTransferStore {
  ensure(input: OutputTransferInput): Promise<OutputTransferRecord | undefined>;
  activate(input: OutputTransferInput, previousState: "queued" | "failed"): Promise<boolean>;
  finish(input: OutputTransferInput, event: TransferProgressEvent): Promise<boolean>;
}

export interface OutputTransferRunner {
  start(
    ownerId: string,
    transferId: string,
    data: TransferCreate,
    onProgress: (event: TransferProgressEvent) => void,
  ): Promise<void>;
}

/** A separate UUID namespace prevents an artifact ID from also naming its transfer. */
export function sandboxArtifactTransferId(artifactId: string, replicaId: string): string {
  const bytes = createHash("sha256")
    .update(JSON.stringify(["kq-sandbox-transfer-v1", artifactId, replicaId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function waitForOutputTransfer(
  deps: { store: OutputTransferStore; runner: OutputTransferRunner },
  input: OutputTransferInput,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const saved = await deps.store.ensure(input);
  if (
    !saved ||
    saved.userId !== input.ownerId ||
    saved.direction !== "cluster_to_cloud" ||
    saved.source !== input.source ||
    saved.target !== input.target ||
    saved.agentId !== input.agentId ||
    saved.jobId !== (input.jobId ?? null) ||
    saved.workflowRunId !== (input.workflowRunId ?? null) ||
    (input.totalBytes !== undefined && saved.totalBytes !== input.totalBytes) ||
    saved.state === "cancelled"
  )
    throw new Error("Workflow output transfer cancelled or binding changed");
  signal?.throwIfAborted();
  if (saved.state === "succeeded") return saved.netdriveFileIds;
  if (saved.state === "queued" || saved.state === "failed") {
    if (!(await deps.store.activate(input, saved.state)))
      throw new Error("Workflow output transfer changed before dispatch");
  } else if (saved.state !== "running") {
    throw new Error("Workflow output transfer state unavailable");
  }
  signal?.throwIfAborted();
  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    let terminalStarted = false;
    const finish = (error?: unknown, ids: string[] = []) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", aborted);
      if (error !== undefined) reject(error);
      else resolve(ids);
    };
    const aborted = () => finish(new Error("Workflow publication wait interrupted"));
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) return aborted();
    void deps.runner
      .start(
        input.ownerId,
        input.transferId,
        {
          direction: "cluster_to_cloud",
          source: input.source,
          target: input.target,
          agentId: input.agentId,
          ...(input.jobId ? { jobId: input.jobId } : {}),
          ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
          ...(input.totalBytes !== undefined ? { totalBytes: input.totalBytes } : {}),
        },
        (event) => {
          if (settled || terminalStarted || event.state === "running") return;
          terminalStarted = true;
          void deps.store.finish(input, event).then(
            (saved) => {
              if (!saved) finish(new Error("Workflow transfer was cancelled or already finalized"));
              else if (event.state === "succeeded") finish(undefined, event.netdriveFileIds ?? []);
              else finish(new Error(event.error || "Workflow output transfer failed"));
            },
            (error: unknown) => finish(error),
          );
        },
      )
      .catch((error: unknown) => finish(error));
  });
}
