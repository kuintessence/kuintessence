import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Download,
  FileInput,
  FileOutput,
  FolderOpen,
  HardDriveDownload,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api, downloadAuthedFile } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { JobDetail } from "./types";

interface JobFilesTabProps {
  job: JobDetail | undefined;
  loading: boolean;
}

interface NetDriveListResp {
  success: true;
  data: {
    files: Array<{
      id: string;
      path: string;
      size: number;
      mtime: string;
    }>;
    total: number;
  };
}

interface NetDriveDownloadUrlResp {
  success: true;
  data: {
    downloadUrl: string;
    expiresAt: string;
  };
}

function fileNameFromUsecaseInputs(
  inputs: Record<string, unknown> | null | undefined,
  fileMetadataId: string,
): string | null {
  for (const value of Object.values(inputs ?? {})) {
    if (Array.isArray(value)) {
      const found = value.find(
        (item) =>
          item &&
          typeof item === "object" &&
          "fileMetadataId" in item &&
          item.fileMetadataId === fileMetadataId,
      );
      if (found && typeof found === "object" && "fileMetadataName" in found) {
        return typeof found.fileMetadataName === "string" ? found.fileMetadataName : null;
      }
    } else if (
      value &&
      typeof value === "object" &&
      "fileMetadataId" in value &&
      value.fileMetadataId === fileMetadataId &&
      "fileMetadataName" in value
    ) {
      return typeof value.fileMetadataName === "string" ? value.fileMetadataName : null;
    }
  }
  return null;
}

export function JobFilesTab({ job, loading }: JobFilesTabProps) {
  const { t } = useTranslation();
  const cloudQ = useQuery({
    queryKey: ["job-files-netdrive", job?.id],
    queryFn: () => api.get<NetDriveListResp>("/netdrive/files"),
    enabled:
      !!job && ((job.inputStaging?.length ?? 0) > 0 || (job.expectedOutputs?.length ?? 0) > 0),
    staleTime: 30_000,
  });

  if (loading || !job) {
    return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  const inputs = job.inputStaging ?? [];
  const outputs = job.expectedOutputs ?? [];
  const cloudFiles = cloudQ.data?.data.files ?? [];
  const cloudError = cloudQ.error
    ? toUserFacingError(
        cloudQ.error,
        t("jobs.files.netdriveLoadFailed", {
          defaultValue: "无法验证 NetDrive 文件，请稍后重试。",
        }),
      )
    : null;
  const cloudActionsDisabled = cloudQ.isLoading || Boolean(cloudError);
  const cloudFileById = new Map(cloudFiles.map((file) => [file.id, file]));
  const handleCloudDownload = async (fileId: string, filename: string) => {
    try {
      const minted = await api.get<NetDriveDownloadUrlResp>(
        `/netdrive/files/${encodeURIComponent(fileId)}/download-url`,
      );
      downloadFromUrl(minted.data.downloadUrl, filename);
    } catch (err) {
      toast.error(toUserFacingError(err, t("jobs.files.downloadFailed")));
    }
  };
  const handleClusterDownload = async (outputPath: string) => {
    if (!job.agentId || !job.workingDir) return;
    const absolutePath = joinPosix(job.workingDir, outputPath);
    try {
      await downloadAuthedFile(
        `/files/cluster/download?agentId=${encodeURIComponent(job.agentId)}&path=${encodeURIComponent(absolutePath)}`,
        filenameFromPath(outputPath),
      );
    } catch (err) {
      toast.error(toUserFacingError(err, t("jobs.files.downloadFailed")));
    }
  };
  if (inputs.length === 0 && outputs.length === 0) {
    return (
      <div className="rounded-md border border-border p-4 text-sm text-muted-foreground">
        {t("jobs.files.empty", { defaultValue: "This job has no staged files." })}
      </div>
    );
  }
  return (
    <div className="grid gap-4" data-testid="job-files-tab">
      {cloudError ? (
        <div
          className="flex items-start gap-2 rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-xs"
          data-testid="job-files-netdrive-error"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />
          <div className="min-w-0">
            <div className="font-medium">
              {t("jobs.files.netdriveLoadFailed", {
                defaultValue: "Unable to verify NetDrive artifacts.",
              })}
            </div>
            <div className="mt-1 break-words text-muted-foreground">{cloudError}</div>
          </div>
        </div>
      ) : null}
      <section className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileInput className="h-4 w-4 text-muted-foreground" />
          {t("jobs.files.inputs", { defaultValue: "Input files" })}
        </div>
        {inputs.length === 0 ? (
          <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
            {t("jobs.files.noInputs", { defaultValue: "No input files staged." })}
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border border-border bg-card text-sm">
            <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)_5.5rem] bg-muted/40 text-left text-[11px] uppercase text-muted-foreground">
              <div className="px-3 py-2 font-medium">
                {t("jobs.files.source", { defaultValue: "Source" })}
              </div>
              <div className="px-3 py-2 font-medium">
                {t("jobs.files.stagePath", { defaultValue: "Stage path" })}
              </div>
              <div className="px-3 py-2 font-medium" />
            </div>
            <div className="divide-y divide-border">
              {inputs.map((file) => {
                const cloudFile = cloudFileById.get(file.fileMetadataId);
                const source =
                  cloudFile?.path ??
                  fileNameFromUsecaseInputs(job.usecaseInputs, file.fileMetadataId) ??
                  file.fileMetadataId;
                return (
                  <div
                    key={`${file.fileMetadataId}:${file.stagePath}`}
                    className="grid min-w-0 grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)_5.5rem] items-center"
                  >
                    <div className="min-w-0 px-3 py-3">
                      <div className="truncate font-mono text-xs" title={source}>
                        {source}
                      </div>
                    </div>
                    <div className="min-w-0 px-3 py-3">
                      <div className="truncate font-mono text-xs" title={file.stagePath}>
                        {file.stagePath}
                      </div>
                    </div>
                    <div className="px-2 py-2 text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("jobs.files.downloadInput", { name: source })}
                          title={t("jobs.files.downloadInput", { name: source })}
                          data-testid={`job-file-input-download-${file.fileMetadataId}`}
                          disabled={cloudActionsDisabled}
                          onClick={() =>
                            !cloudActionsDisabled &&
                            handleCloudDownload(file.fileMetadataId, filenameFromPath(source))
                          }
                        >
                          <Download />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("jobs.files.openCloudDirectory", { path: source })}
                          title={t("jobs.files.openCloudDirectory", { path: source })}
                          data-testid={`job-file-input-open-${file.fileMetadataId}`}
                          disabled={cloudActionsDisabled}
                          onClick={() =>
                            !cloudActionsDisabled &&
                            openCloudDirectory({
                              fileId: file.fileMetadataId,
                              prefix: cloudFile ? parentPath(cloudFile.path) : undefined,
                            })
                          }
                        >
                          <FolderOpen />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
      <section className="space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <FileOutput className="h-4 w-4 text-muted-foreground" />
          {t("jobs.files.outputs", { defaultValue: "Expected outputs" })}
        </div>
        {outputs.length === 0 ? (
          <div className="rounded-md border border-border p-3 text-xs text-muted-foreground">
            {t("jobs.files.noOutputs", { defaultValue: "No output files declared." })}
          </div>
        ) : (
          <div className="grid gap-2">
            {outputs.map((output) => {
              const actualFiles = uniqueFilesByPath(
                findOutputCloudFiles(cloudFiles, job, output.path),
              );
              const outputPrefix = outputCloudPrefix(job, output.path);
              const canDownloadCluster = !!job.agentId && !!job.workingDir && !isGlob(output.path);
              return (
                <div
                  key={`${output.descriptor}:${output.path}`}
                  className="rounded-md border border-border bg-card p-3"
                >
                  <div className="grid min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(12rem,0.75fr)_auto] md:items-start">
                    <div className="min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <div
                          className="truncate font-mono text-sm font-medium"
                          title={output.descriptor}
                        >
                          {output.descriptor}
                        </div>
                        <Badge variant="outline" className="shrink-0">
                          {output.isBatch
                            ? t("jobs.files.batch", { defaultValue: "Batch" })
                            : t("jobs.files.single", { defaultValue: "Single" })}
                        </Badge>
                      </div>
                      <div
                        className="mt-1 truncate font-mono text-xs text-muted-foreground"
                        title={output.path}
                      >
                        {output.path}
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">
                        {t("jobs.files.actualFiles", { defaultValue: "Actual files" })}
                      </div>
                      {actualFiles.length > 0 ? (
                        <div className="grid gap-1">
                          {actualFiles.map((file) => (
                            <Button
                              key={file.id}
                              variant="ghost"
                              size="sm"
                              className="h-7 min-w-0 justify-start px-2 font-mono text-xs"
                              aria-label={t("jobs.files.downloadOutput", {
                                name: file.path,
                              })}
                              title={t("jobs.files.downloadOutput", { name: file.path })}
                              data-testid={`job-file-output-download-cloud-${output.descriptor}-${file.id}`}
                              onClick={() =>
                                handleCloudDownload(file.id, filenameFromPath(file.path))
                              }
                            >
                              <Download />
                              <span className="min-w-0 truncate">
                                {filenameFromPath(file.path)}
                              </span>
                            </Button>
                          ))}
                        </div>
                      ) : (
                        <OutputPublicationDiagnostic
                          descriptor={output.descriptor}
                          job={job}
                          outputPrefix={outputPrefix}
                          netdriveLoading={cloudQ.isLoading}
                          netdriveError={cloudError}
                        />
                      )}
                    </div>
                    <div className="flex justify-end gap-1">
                      {canDownloadCluster ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("jobs.files.downloadClusterOutput", {
                            name: output.path,
                          })}
                          title={t("jobs.files.downloadClusterOutput", { name: output.path })}
                          data-testid={`job-file-output-download-cluster-${output.descriptor}`}
                          onClick={() => handleClusterDownload(output.path)}
                        >
                          <HardDriveDownload />
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t("jobs.files.openCloudDirectory", { path: outputPrefix })}
                        title={t("jobs.files.openCloudDirectory", { path: outputPrefix })}
                        data-testid={`job-file-output-open-${output.descriptor}`}
                        disabled={cloudActionsDisabled}
                        onClick={() =>
                          !cloudActionsDisabled && openCloudDirectory({ prefix: outputPrefix })
                        }
                      >
                        <FolderOpen />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function OutputPublicationDiagnostic({
  descriptor,
  job,
  outputPrefix,
  netdriveLoading,
  netdriveError,
}: {
  descriptor: string;
  job: JobDetail;
  outputPrefix: string;
  netdriveLoading: boolean;
  netdriveError: string | null;
}) {
  const { t } = useTranslation();
  const status = job.status.toLowerCase();
  let message: string;
  if (netdriveLoading) {
    message = t("jobs.files.notPublishedChecking", {
      defaultValue: "Checking NetDrive publication.",
    });
  } else if (netdriveError) {
    message = t("jobs.files.notPublishedUnknown", {
      defaultValue: "NetDrive listing failed, so artifact publication cannot be verified.",
    });
  } else if (status === "failed" && job.errorMessage) {
    message = t("jobs.files.notPublishedFailedReason", {
      defaultValue: "作业在发布此输出前失败，请查看作业日志。",
    });
  } else if (status === "failed") {
    message = t("jobs.files.notPublishedFailed", {
      defaultValue: "Job failed before this output was published.",
    });
  } else if (status === "cancelled" || status === "canceled") {
    message = t("jobs.files.notPublishedCancelled", {
      defaultValue: "Job was cancelled before this output was published.",
    });
  } else if (status === "running" || status === "queued" || status === "pending") {
    message = t("jobs.files.notPublishedPending", {
      defaultValue: "Job has not reached terminal output collection yet.",
    });
  } else if (status === "completed") {
    message = t("jobs.files.notPublishedCompleted", {
      defaultValue:
        "Job completed, but no matching NetDrive artifact was found under {{prefix}}. Check output collection logs or download from cluster storage.",
      prefix: outputPrefix,
    });
  } else {
    message = t("jobs.files.notPublishedUnknown", {
      defaultValue: "No matching NetDrive artifact was found.",
    });
  }
  return (
    <div
      className="rounded-md border border-dashed border-border bg-muted/30 p-2 text-xs"
      data-testid={`job-file-output-diagnostic-${descriptor}`}
    >
      <div className="font-medium text-muted-foreground">
        {t("jobs.files.notPublished", { defaultValue: "Not published" })}
      </div>
      <div className="mt-1 text-muted-foreground">{message}</div>
    </div>
  );
}

function downloadFromUrl(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function filenameFromPath(value: string): string {
  return value.split("/").filter(Boolean).pop() ?? "download";
}

function parentPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.length > 0 ? `${parts.join("/")}/` : "";
}

function joinPosix(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function openCloudDirectory(input: { prefix?: string; fileId?: string }): void {
  const params = new URLSearchParams();
  if (input.prefix !== undefined) params.set("cloudPrefix", input.prefix);
  if (input.fileId) params.set("cloudFileId", input.fileId);
  window.location.assign(`/files?${params.toString()}`);
}

function outputCloudPrefix(job: JobDetail, outputPath: string): string {
  const runDir = job.workingDir ? filenameFromPath(job.workingDir) : job.id;
  return parentPath(`outputs/${runDir}/${outputPath.replace(/\*/g, "")}`);
}

function findOutputCloudFiles(
  files: Array<{ id: string; path: string; size: number; mtime: string }>,
  job: JobDetail,
  outputPath: string,
): Array<{ id: string; path: string; size: number; mtime: string }> {
  const runDir = job.workingDir ? filenameFromPath(job.workingDir) : job.id;
  const scopedPatterns = [
    `${job.id}/${outputPath}`,
    `outputs/${job.id}/${outputPath}`,
    `outputs/${runDir}/${outputPath}`,
  ].map((pattern) => globPattern(pattern.replace(/^\/+/, "")));
  const scoped = files.filter((file) => scopedPatterns.some((pattern) => pattern.test(file.path)));
  if (scoped.length > 0) return scoped;
  if (isGlob(outputPath)) return [];
  const fallbackPath = outputPath.replace(/^\/+/, "");
  return files.filter((file) => file.path === fallbackPath);
}

function uniqueFilesByPath(
  files: Array<{ id: string; path: string; size: number; mtime: string }>,
): Array<{ id: string; path: string; size: number; mtime: string }> {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) return false;
    seen.add(file.path);
    return true;
  });
}

function globPattern(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`(^|/)${escaped}$`);
}

function isGlob(path: string): boolean {
  return path.includes("*");
}
