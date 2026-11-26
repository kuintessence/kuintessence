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
import { listAllNetDriveFiles } from "../../lib/netdrive-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshButton } from "../ui/refresh-button";
import type { JobDetail } from "./types";

interface JobFilesTabProps {
  job: JobDetail | undefined;
  loading: boolean;
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
  const needsCloudFiles =
    !!job &&
    !job.federationRunId &&
    ((job.inputStaging?.length ?? 0) > 0 || (job.fileOutputDescriptors?.length ?? 0) > 0);
  const cloudQ = useQuery({
    queryKey: ["job-files-netdrive", job?.id, job?.status],
    queryFn: listAllNetDriveFiles,
    enabled: needsCloudFiles,
    staleTime: 30_000,
  });

  if (loading || !job) {
    return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;
  }
  const inputs = job.inputStaging ?? [];
  const outputs = job.expectedOutputs ?? [];
  const cloudFiles = cloudQ.isSuccess ? (cloudQ.data?.data.files ?? []) : [];
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
  if (job.federationRunId) {
    const groups = Object.entries(job.federationOutputs ?? {}).filter(
      ([, files]) => files.length > 0,
    );
    return (
      <div className="divide-y divide-border" data-testid="federation-job-files">
        {groups.map(([descriptor, files]) => (
          <section key={descriptor} className="min-w-0 space-y-1 py-3">
            <h3 className="font-mono text-sm font-medium [overflow-wrap:anywhere]">{descriptor}</h3>
            <ul className="divide-y divide-border">
              {files.map((file) => (
                <li
                  key={file.fileMetadataId}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2"
                >
                  <span className="min-w-0 text-sm [overflow-wrap:anywhere]">
                    {file.fileMetadataName}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={t("jobs.files.downloadOutput", {
                      name: `${descriptor}/${file.fileMetadataName}`,
                    })}
                    onClick={() =>
                      void handleCloudDownload(file.fileMetadataId, file.fileMetadataName)
                    }
                  >
                    <Download className="size-4" />
                    {t("common.download")}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {groups.length === 0 ? (
          <p className="py-3 text-sm text-muted-foreground">
            {t(
              ["completed", "failed", "cancelled"].includes(job.status.toLowerCase())
                ? "jobs.remoteOutputsEmpty"
                : "jobs.remoteOutputsPending",
            )}
          </p>
        ) : null}
      </div>
    );
  }
  if (inputs.length === 0 && outputs.length === 0) {
    return (
      <div className=" border-border p-4 text-sm text-muted-foreground">
        {t("jobs.files.empty", { defaultValue: "This job has no staged files." })}
      </div>
    );
  }
  return (
    <div className="@container grid min-w-0 grid-cols-1 gap-4" data-testid="job-files-tab">
      {needsCloudFiles ? (
        <div className="flex justify-end">
          <RefreshButton
            type="button"
            variant="outline"
            disabled={cloudQ.isFetching}
            onClick={() => void cloudQ.refetch()}
            data-testid="job-files-refresh"
            label={
              cloudQ.isFetching
                ? t("common.loading")
                : cloudError
                  ? t("common.retry")
                  : t("common.refresh")
            }
          ></RefreshButton>
        </div>
      ) : null}
      {cloudError ? (
        <div
          className="flex items-start gap-2 p-3 text-xs"
          data-testid="job-files-netdrive-error"
          role="alert"
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
          <div className=" border-border p-3 text-xs text-muted-foreground">
            {t("jobs.files.noInputs", { defaultValue: "No input files staged." })}
          </div>
        ) : (
          <div className="min-w-0 text-sm">
            <div className="hidden @lg:grid @lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)_auto] text-left text-[11px] uppercase text-muted-foreground">
              <div className="px-3 py-2 font-medium">
                {t("jobs.files.source", { defaultValue: "Source" })}
              </div>
              <div className="px-3 py-2 font-medium">
                {t("jobs.files.stagePath", { defaultValue: "Stage path" })}
              </div>
              <div className="w-24" />
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
                    className="grid min-w-0 gap-y-2 py-3 @lg:grid-cols-[minmax(0,1.25fr)_minmax(0,0.9fr)_auto] @lg:items-start"
                  >
                    <div className="min-w-0 @lg:px-3">
                      <div className="text-xs text-muted-foreground @lg:hidden">
                        {t("jobs.files.source")}
                      </div>
                      <div className="font-mono text-xs [overflow-wrap:anywhere]" title={source}>
                        {source}
                      </div>
                    </div>
                    <div className="min-w-0 @lg:px-3">
                      <div className="text-xs text-muted-foreground @lg:hidden">
                        {t("jobs.files.stagePath")}
                      </div>
                      <div
                        className="font-mono text-xs [overflow-wrap:anywhere]"
                        title={file.stagePath}
                      >
                        {file.stagePath}
                      </div>
                    </div>
                    <div className="@lg:w-24 @lg:px-2">
                      <div className="flex gap-1 @lg:justify-end">
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
          <div className=" border-border p-3 text-xs text-muted-foreground">
            {t("jobs.files.noOutputs", { defaultValue: "No output files declared." })}
          </div>
        ) : (
          <div className="grid min-w-0 grid-cols-1 divide-y divide-border">
            {outputs.map((output) => {
              if (!job.fileOutputDescriptors?.includes(output.descriptor)) {
                const value = job.collectedOutputs?.[output.descriptor];
                return (
                  <div
                    key={output.descriptor}
                    className="min-w-0 space-y-2 py-3"
                    data-testid={`job-text-output-${output.descriptor}`}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-medium">
                      <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                        {output.path}
                      </span>
                      <Badge variant="outline">{t("jobs.files.textResult")}</Badge>
                    </div>
                    {typeof value === "string" ? (
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] py-2 font-mono text-xs">
                        {value || t("jobs.files.emptyTextResult")}
                      </pre>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {t("jobs.files.textResultUnavailable")}
                      </p>
                    )}
                  </div>
                );
              }
              const actualFiles = uniqueFilesByPath(
                findOutputCloudFiles(cloudFiles, job, output.path),
              );
              const outputPrefix = outputCloudPrefix(job, output.path);
              const canDownloadCluster = !!job.agentId && !!job.workingDir && !isGlob(output.path);
              return (
                <div key={`${output.descriptor}:${output.path}`} className="py-3">
                  <div className="grid min-w-0 gap-3 @xl:grid-cols-[minmax(0,1fr)_minmax(0,0.85fr)_auto] @xl:items-start">
                    <div className="min-w-0">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                        <div
                          className="font-mono text-sm font-medium [overflow-wrap:anywhere]"
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
                        className="mt-1 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
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
                              className="h-auto min-h-8 min-w-0 justify-start whitespace-normal px-1 py-1 text-left font-mono text-xs"
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
                              <span className="min-w-0 [overflow-wrap:anywhere]">
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
                    <div className="flex gap-1 @lg:justify-end">
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
    message = t("jobs.files.notPublishedUnverified", {
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
      className="text-xs [overflow-wrap:anywhere]"
      data-testid={`job-file-output-diagnostic-${descriptor}`}
    >
      {!netdriveLoading && !netdriveError ? (
        <div className="font-medium text-muted-foreground">
          {t("jobs.files.notPublished", { defaultValue: "Not published" })}
        </div>
      ) : null}
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
