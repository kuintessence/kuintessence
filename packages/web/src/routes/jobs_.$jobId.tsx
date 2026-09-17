import type { PlacementTrace } from "@kuintessence/shared/browser";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { AlertCircle, CircleStop, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { JobFilesTab } from "../components/jobs/JobFilesTab";
import { JobLogsTab } from "../components/jobs/JobLogsTab";
import { JobOverviewTab } from "../components/jobs/JobOverviewTab";
import { JobResourcesTab } from "../components/jobs/JobResourcesTab";
import type { JobDetail } from "../components/jobs/types";
import { ProtectedRoute } from "../components/ProtectedRoute";
import { PlacementPipelineView } from "../components/scheduler";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { PageHeader, PageShell } from "../components/ui/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { ApiError, api } from "../lib/api-client";
import { statusToBadgeVariant } from "../lib/format";
import { useJobStatusStream } from "../lib/use-job-status-stream";
import { toUserFacingError } from "../lib/user-facing-error";

const REFRESH_MS = 5_000;

export function JobDetailPage({ jobId }: { jobId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const detailQ = useQuery({
    queryKey: ["job-detail", jobId],
    queryFn: () => api.get<JobDetail>(`/jobs/${jobId}`),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.status.toUpperCase();
      return status === "PENDING" || status === "QUEUED" || status === "RUNNING"
        ? REFRESH_MS
        : false;
    },
  });
  const traceQ = useQuery({
    queryKey: ["job-placement", jobId],
    queryFn: () => api.get<PlacementTrace>(`/jobs/${jobId}/placement`),
    enabled: detailQ.isSuccess,
    retry: (failureCount, error) => {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
      return failureCount < 2;
    },
  });
  const cancelJob = useMutation({
    mutationFn: () => api.post<JobDetail>(`/jobs/${jobId}/cancel`, {}),
    onSuccess: (job) => {
      queryClient.setQueryData(["job-detail", jobId], job);
      void queryClient.invalidateQueries({ queryKey: ["jobs-list"] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success(t("jobs.cancelled", { name: job.name }));
    },
    onError: (error) => {
      toast.error(toUserFacingError(error, t("jobs.cancelFailed")));
    },
  });
  useJobStatusStream(detailQ.isSuccess ? jobId : null);

  if (detailQ.isPending) {
    return (
      <PageShell data-testid="job-detail-loading">
        <PageHeader title={t("jobs.detail.loadingTitle")} subtitle={jobId} />
        <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
      </PageShell>
    );
  }
  if (detailQ.error) {
    return <JobDetailError jobId={jobId} error={detailQ.error} onRetry={() => detailQ.refetch()} />;
  }
  const job = detailQ.data;
  if (!job) return null;
  const status = job.status.toUpperCase();
  const canCancel = status === "PENDING" || status === "QUEUED" || status === "RUNNING";

  return (
    <PageShell data-testid="job-detail-page">
      <PageHeader
        title={job.name}
        subtitle={job.id}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusToBadgeVariant(job.status)}>{job.status}</Badge>
            {job.accessScope ? (
              <Badge variant="outline">{t(`jobs.scope.${job.accessScope}`)}</Badge>
            ) : null}
            {canCancel ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={cancelJob.isPending}
                onClick={() => {
                  if (window.confirm(t("jobs.cancelConfirm", { name: job.name })))
                    cancelJob.mutate();
                }}
              >
                <CircleStop />
                {cancelJob.isPending ? t("jobs.cancelling") : t("jobs.cancel")}
              </Button>
            ) : null}
          </div>
        }
      />
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="overview">{t("jobs.tab.overview")}</TabsTrigger>
          <TabsTrigger value="logs">{t("jobs.tab.logs")}</TabsTrigger>
          <TabsTrigger value="resources">{t("jobs.tab.resources")}</TabsTrigger>
          <TabsTrigger value="files">{t("jobs.tab.files")}</TabsTrigger>
          {traceQ.data ? (
            <TabsTrigger value="placement">{t("scheduler.placement.tab.label")}</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="overview">
          <JobOverviewTab job={job} loading={false} />
        </TabsContent>
        <TabsContent value="logs">
          <JobLogsTab jobId={jobId} />
        </TabsContent>
        <TabsContent value="resources">
          <JobResourcesTab job={job} loading={false} />
        </TabsContent>
        <TabsContent value="files">
          <JobFilesTab job={job} loading={false} />
        </TabsContent>
        {traceQ.data ? (
          <TabsContent value="placement">
            <PlacementPipelineView trace={traceQ.data} />
          </TabsContent>
        ) : null}
      </Tabs>
    </PageShell>
  );
}

function JobDetailError({
  error,
  jobId,
  onRetry,
}: {
  error: Error;
  jobId: string;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const status = error instanceof ApiError ? error.status : 0;
  const title =
    status === 404
      ? t("jobs.error.notFound")
      : status === 403
        ? t("jobs.error.forbidden")
        : status === 400
          ? t("jobs.error.badId")
          : t("jobs.error.generic");
  const retryable = status === 0 || status >= 500;
  return (
    <PageShell data-testid="job-detail-error">
      <PageHeader title={title} subtitle={jobId} />
      <div
        className="flex items-start gap-3 rounded-md border border-status-failed/40 p-4"
        role="alert"
      >
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-failed" />
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {toUserFacingError(error, t("jobs.error.generic"))}
          </p>
          {retryable ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw />
              {t("common.retry")}
            </Button>
          ) : null}
        </div>
      </div>
    </PageShell>
  );
}

function JobDetailRoutePage() {
  const { jobId } = Route.useParams();
  return <JobDetailPage jobId={jobId} />;
}

export const Route = createFileRoute("/jobs_/$jobId")({
  component: () => (
    <ProtectedRoute>
      <JobDetailRoutePage />
    </ProtectedRoute>
  ),
});
