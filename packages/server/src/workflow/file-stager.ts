import type { WorkflowInputFile } from "./stage-inputs";

const STAGE_TIMEOUT_MS = 10 * 60_000;

/**
 * Interfaces for staging a workflow input file using the FileTransferRequest
 * (cloud_to_cluster) subsystem — the same path NetDrive transfers use, which
 * the agent already implements container-aware. Kept injected so the stager is
 * unit-testable without a live agent.
 */
export interface FileStagerDeps {
  dispatcher: {
    pushFileTransfer(
      agentId: string,
      requestId: string,
      payload: {
        direction: "cloud_to_cluster" | "cluster_to_cloud";
        sourceUrl?: string;
        targetPath?: string;
        totalBytes: number;
      },
    ): boolean;
  };
  transferRegistry: {
    register(
      requestId: string,
      listener: (e: { copiedBytes: number; state: string; error?: string }) => void,
      timeoutMs: number,
    ): void;
  };
  mintDownloadUrl: (
    actorUserId: string,
    fileId: string,
    context?: { jobId?: string; workflowRunId?: string; netdriveFileIds?: string[] },
  ) => Promise<{ downloadUrl: string }>;
  newTransferId: () => string;
}

/**
 * Build a workflow file stager: presign a MinIO GET URL for the file and drive a
 * cloud_to_cluster transfer to the placed agent, resolving when the agent
 * reports `succeeded` (rejecting on `failed` / closed channel). The returned
 * function is the `StageOne` used by stageWorkflowInputs.
 */
export function createFileStager(
  deps: FileStagerDeps,
): (
  agentId: string,
  actorUserId: string,
  file: WorkflowInputFile,
  targetPath: string,
  context?: { jobId?: string; workflowRunId?: string },
) => Promise<void> {
  return async (agentId, actorUserId, file, targetPath, context) => {
    const { downloadUrl } = await deps.mintDownloadUrl(actorUserId, file.fileMetadataId, {
      jobId: context?.jobId,
      workflowRunId: context?.workflowRunId,
      netdriveFileIds: [file.fileMetadataId],
    });
    const transferId = deps.newTransferId();
    return new Promise<void>((resolve, reject) => {
      deps.transferRegistry.register(
        transferId,
        (e) => {
          if (e.state === "succeeded") {
            resolve();
          } else if (e.state === "failed") {
            reject(new Error(e.error || "transfer failed"));
          }
        },
        STAGE_TIMEOUT_MS,
      );
      const queued = deps.dispatcher.pushFileTransfer(agentId, transferId, {
        direction: "cloud_to_cluster",
        sourceUrl: downloadUrl,
        targetPath,
        totalBytes: 0,
      });
      if (!queued) {
        reject(new Error("agent channel closed"));
      }
    });
  };
}
