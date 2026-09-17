import type { PlacementTrace } from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CircleStop } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { useJobStatusStream } from "../../lib/use-job-status-stream";
import { toUserFacingError } from "../../lib/user-facing-error";
import { PlacementPipelineView } from "../scheduler";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { JobFilesTab } from "./JobFilesTab";
import { JobLogsTab } from "./JobLogsTab";
import { JobOverviewTab } from "./JobOverviewTab";
import { JobResourcesTab } from "./JobResourcesTab";
import type { JobDetail } from "./types";

const REFRESH_MS = 5_000;

export interface JobDetailSheetProps {
  jobId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Slide-in job detail panel shared by the Jobs page and workflow job links.
 * Open/close is controlled by the caller.
 */
export function JobDetailSheet({ jobId, open, onOpenChange }: JobDetailSheetProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detailQ = useQuery({
    queryKey: ["job-detail", jobId],
    queryFn: () => api.get<JobDetail>(`/jobs/${jobId}`),
    enabled: !!jobId && open,
    retry: (failureCount, err) => {
      // Don't retry on terminal client errors — the job id is bad or absent.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return failureCount < 3;
    },
    // Real-time updates arrive via /platform/ws/jobs/:id while the sheet is
    // open. Polling is kept as a safety net for non-terminal states in case
    // the WS layer is unreachable (e.g. middleboxes blocking upgrade) — the
    // hook also invalidates this query on non-clean WS close.
    refetchInterval: (q) => {
      const status = q.state.data?.status?.toUpperCase();
      if (status === "PENDING" || status === "QUEUED" || status === "RUNNING") return REFRESH_MS;
      return false;
    },
  });

  const cancelJob = useMutation({
    mutationFn: async () => {
      if (!jobId) throw new Error(t("jobs.cancelMissingId"));
      return api.post<JobDetail>(`/jobs/${jobId}/cancel`, {});
    },
    onSuccess: (job) => {
      queryClient.setQueryData(["job-detail", jobId], job);
      queryClient.invalidateQueries({ queryKey: ["jobs-list"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(t("jobs.cancelled", { name: job.name }));
    },
    onError: (err) => {
      toast.error(toUserFacingError(err, t("jobs.cancelFailed")));
    },
  });

  // Subscribe to live status pushes only while the sheet is open and we have
  // a valid jobId. The hook is a no-op when jobId is null.
  useJobStatusStream(open && jobId && detailQ.isSuccess ? jobId : null);

  // Load the persisted placement trace when available. The tab stays hidden
  // without trace data, including when the endpoint returns 404.
  const traceQ = useQuery({
    queryKey: ["job-placement", jobId],
    queryFn: () => api.get<PlacementTrace>(`/jobs/${jobId}/placement`),
    enabled: !!jobId && open && detailQ.isSuccess,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return failureCount < 2;
    },
  });
  const hasTrace = !!traceQ.data;
  const status = detailQ.data?.status.toUpperCase();
  const canCancel = status === "PENDING" || status === "QUEUED" || status === "RUNNING";

  const errorBlock = detailQ.error
    ? (() => {
        const err = detailQ.error;
        const status = err instanceof ApiError ? err.status : 0;
        const headline =
          status === 404
            ? t("jobs.error.notFound", { defaultValue: "Job not found" })
            : status === 400
              ? t("jobs.error.badId", { defaultValue: "Invalid job id" })
              : t("jobs.error.generic", { defaultValue: "Failed to load job" });
        const detail = toUserFacingError(
          err,
          t("jobs.error.generic", { defaultValue: "无法加载作业详情，请稍后重试。" }),
        );
        return (
          <div
            className="flex items-start gap-3 rounded-md border border-border bg-card p-4"
            data-testid="job-detail-error"
            role="alert"
          >
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-failed" />
            <div className="space-y-1">
              <h3 className="text-sm font-semibold">{headline}</h3>
              <p className="text-sm text-muted-foreground">{detail}</p>
              {jobId ? (
                <p className="font-mono text-[11px] text-muted-foreground">{jobId}</p>
              ) : null}
            </div>
          </div>
        );
      })()
    : null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent data-testid="job-detail-sheet">
        <SheetHeader className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <SheetTitle className="min-w-0 flex-1 truncate" title={detailQ.data?.name ?? "Job"}>
              {detailQ.data?.name ?? "Job"}
            </SheetTitle>
            {detailQ.data?.status ? <Badge variant="outline">{detailQ.data.status}</Badge> : null}
            {canCancel ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={cancelJob.isPending}
                onClick={() => {
                  if (window.confirm(t("jobs.cancelConfirm", { name: detailQ.data?.name }))) {
                    cancelJob.mutate();
                  }
                }}
                data-testid="job-cancel-button"
              >
                <CircleStop />
                {cancelJob.isPending ? t("jobs.cancelling") : t("jobs.cancel")}
              </Button>
            ) : null}
            {detailQ.data?.accessScope ? (
              <Badge variant="outline">{t(`jobs.scope.${detailQ.data.accessScope}`)}</Badge>
            ) : null}
          </div>
          <SheetDescription className="truncate font-mono text-xs" title={jobId ?? undefined}>
            {jobId ?? ""}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="min-w-0">
          {errorBlock}
          {jobId && !detailQ.error ? (
            <Tabs defaultValue="overview" className="space-y-4">
              <TabsList className="max-w-full overflow-x-auto">
                <TabsTrigger value="overview" data-testid="tab-overview">
                  {t("jobs.tab.overview")}
                </TabsTrigger>
                <TabsTrigger value="logs" data-testid="tab-logs">
                  {t("jobs.tab.logs")}
                </TabsTrigger>
                <TabsTrigger value="resources" data-testid="tab-resources">
                  {t("jobs.tab.resources")}
                </TabsTrigger>
                <TabsTrigger value="files" data-testid="tab-files">
                  {t("jobs.tab.files", { defaultValue: "Files" })}
                </TabsTrigger>
                {hasTrace ? (
                  <TabsTrigger value="placement" data-testid="tab-placement">
                    {t("scheduler.placement.tab.label", { defaultValue: "Placement" })}
                  </TabsTrigger>
                ) : null}
              </TabsList>
              <TabsContent value="overview">
                <JobOverviewTab job={detailQ.data} loading={detailQ.isLoading} />
              </TabsContent>
              <TabsContent value="logs">
                <JobLogsTab jobId={jobId} />
              </TabsContent>
              <TabsContent value="resources">
                <JobResourcesTab job={detailQ.data} loading={detailQ.isLoading} />
              </TabsContent>
              <TabsContent value="files">
                <JobFilesTab job={detailQ.data} loading={detailQ.isLoading} />
              </TabsContent>
              {hasTrace ? (
                <TabsContent value="placement">
                  <PlacementPipelineView trace={traceQ.data ?? null} />
                </TabsContent>
              ) : null}
            </Tabs>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
