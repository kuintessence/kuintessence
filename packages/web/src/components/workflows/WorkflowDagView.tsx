import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, ExternalLink, FileInput, Route, SlidersHorizontal, X } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { statusLabel, statusToBadgeVariant } from "../../lib/format";
import { toUserFacingError, toUserFacingExecutionFailure } from "../../lib/user-facing-error";
import { extractWorkflowInputModel } from "../../lib/workflow-input-config";
import { JobDetailSheet } from "../jobs/JobDetailSheet";
import type { JobDetail } from "../jobs/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { PageHeader } from "../ui/page";
import { WorkflowRunGraph } from "./WorkflowRunGraph";

interface WorkflowRunDetail {
  id: string;
  name: string;
  description: string | null;
  status: string;
  createdAt: string;
  stepJobs: Record<string, string>;
  /** Per-node execution results; may be absent before execution starts. */
  result?: {
    status: Record<string, string>;
    values: Record<
      string,
      {
        status: string;
        values: Record<string, unknown>;
        failure?: { message: string; jobId?: string; exitCode?: number };
      }
    >;
  } | null;
  /** Persisted orchestration graph; pending or local runs may not have one. */
  graph?: {
    nodes: { id: string; name: string; kind: string }[];
    edges: { source: string; target: string; when?: string }[];
  } | null;
  input?: {
    yaml?: string;
    federationReservationId?: string;
    placementConfig?: {
      plannerMode?: string;
      budgetCap?: number | null;
    };
  } | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

const POLLED_RUN_STATUSES = new Set([
  "submitted",
  "queued",
  "pending",
  "awaiting_approval",
  "running",
  "cancelling",
]);
const CANCELLABLE_RUN_STATUSES = new Set([
  "submitted",
  "queued",
  "pending",
  "awaiting_approval",
  "running",
]);

interface WorkflowCancelResponse {
  runId: string;
  status: string;
}

interface LocalizedRunError {
  message: string;
  title: string;
}

interface FailedNodeDetail {
  nodeId: string;
  nodeName: string;
  message: string | null;
  jobId: string | null;
  exitCode: number | null;
}

function localizedRunError(
  t: ReturnType<typeof useTranslation>["t"],
  code: string | null | undefined,
  message: string,
): LocalizedRunError {
  if (code === "WORKFLOW_PLACEMENT_FAILED") {
    return {
      title: t("workflows.run.errors.placementFailed.title", {
        defaultValue: "Workflow scheduling failed",
      }),
      message: t("workflows.run.errors.placementFailed.message", {
        defaultValue:
          "No compute resource satisfies the current scheduling and placement constraints.",
      }),
    };
  }
  if (code === "WORKFLOW_AUTHORIZATION_FAILED") {
    return {
      title: t("workflows.run.executionFailed"),
      message: toUserFacingError({ code: "AUTHORIZATION_DENIED", message }),
    };
  }
  if (code === "WORKFLOW_INTERRUPTED") {
    return {
      title: t("workflows.run.errors.interrupted.title"),
      message: t("workflows.run.errors.interrupted.message"),
    };
  }
  return {
    title: t("workflows.run.executionFailed"),
    message: toUserFacingExecutionFailure(message, t("workflows.run.failureUnavailable")),
  };
}

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "").toLowerCase();
}

function RunMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex min-w-0 items-baseline gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function RunConfiguration({
  detail,
  icon: Icon,
  label,
  value,
}: {
  detail: ReactNode;
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <section className="min-w-0 border-border p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-4 w-4 text-brand" />
        {label}
      </div>
      <p className="mt-2 text-lg font-semibold">{value}</p>
      <div className="mt-1 text-xs leading-5 text-muted-foreground [overflow-wrap:anywhere]">
        {detail}
      </div>
    </section>
  );
}

function NodeOutputs({ values }: { values: Record<string, unknown> }) {
  return (
    <dl className="min-w-0 divide-y divide-border empty:hidden">
      {Object.entries(values).map(([key, value]) => (
        <div
          key={key}
          className="grid min-w-0 gap-1 py-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-3"
        >
          <dt className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{key}</dt>
          <dd className="max-h-56 min-w-0 overflow-auto whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
            {typeof value === "string" && value !== "" ? value : JSON.stringify(value, null, 2)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export interface WorkflowDagViewProps {
  runId: string;
}

export function WorkflowDagView({ runId }: WorkflowDagViewProps) {
  const { t, i18n } = useTranslation();
  const language = i18n?.resolvedLanguage ?? i18n?.language;
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);

  const runQ = useQuery({
    queryKey: ["workflow-detail", runId],
    queryFn: () => api.get<WorkflowRunDetail>(`/workflows/${runId}`),
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 403) return failureCount < 30;
      // Don't retry on terminal client errors — the run id is bad or absent.
      if (err instanceof ApiError && err.status >= 400 && err.status < 500) return false;
      return failureCount < 3;
    },
    retryDelay: (attemptIndex, err) =>
      err instanceof ApiError && err.status === 403
        ? 500
        : Math.min(1_000 * 2 ** attemptIndex, 5_000),
    refetchInterval: (q) => {
      const status = normalizeStatus(q.state.data?.status);
      if (POLLED_RUN_STATUSES.has(status)) return 5_000;
      return false;
    },
  });

  const cancelRun = useMutation({
    mutationFn: (cancelId: string) =>
      api.post<WorkflowCancelResponse>(`/workflows/${cancelId}/cancel`, {}),
    onSuccess: (res, cancelId) => {
      queryClient.setQueryData<WorkflowRunDetail>(["workflow-detail", cancelId], (run) =>
        run ? { ...run, status: res.status } : run,
      );
      queryClient.invalidateQueries({ queryKey: ["workflow-detail", cancelId] });
      queryClient.invalidateQueries({ queryKey: ["workflows-list"] });
      toast.success(t("workflows.run.cancelRequested"));
    },
    onError: (err) => {
      toast.error(
        toUserFacingError(
          err,
          t("workflows.run.cancelFailed", { defaultValue: "无法取消工作流，请稍后重试。" }),
        ),
      );
    },
  });

  const stepJobs = runQ.data?.stepJobs ?? {};
  const jobIds = useMemo(
    () => [...new Set(Object.values(stepJobs))].filter((jobId) => jobId.length > 0).sort(),
    [stepJobs],
  );

  const jobsQ = useQuery({
    queryKey: ["workflow-jobs", runId, jobIds.join(",")],
    enabled: runQ.isSuccess && jobIds.length > 0,
    queryFn: async () => {
      const results = await Promise.allSettled(
        jobIds.map((id) => api.get<JobDetail>(`/jobs/${id}`)),
      );
      return {
        jobs: results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
        failedCount: results.filter((result) => result.status === "rejected").length,
      };
    },
    refetchInterval: (q) => {
      if (!runQ.isSuccess) return false;
      const runActive = POLLED_RUN_STATUSES.has(normalizeStatus(runQ.data?.status));
      const jobsActive = q.state.data?.jobs.some((job) =>
        POLLED_RUN_STATUSES.has(normalizeStatus(job.status)),
      );
      return runActive || jobsActive ? 5_000 : false;
    },
  });

  const jobsMap = useMemo(() => {
    const m = new Map<string, JobDetail>();
    for (const j of jobsQ.data?.jobs ?? []) m.set(j.id, j);
    return m;
  }, [jobsQ.data]);
  const liveStatusByNode = useMemo(
    () => ({
      ...(runQ.data?.result?.status ?? {}),
      ...Object.fromEntries(
        Object.entries(stepJobs).flatMap(([nodeId, jobId]) => {
          const status = jobsMap.get(jobId)?.status;
          return status ? [[nodeId, status]] : [];
        }),
      ),
    }),
    [jobsMap, runQ.data?.result?.status, stepJobs],
  );
  const failedNodes = useMemo<FailedNodeDetail[]>(() => {
    const result = runQ.data?.result;
    const graphNames = new Map(
      (runQ.data?.graph?.nodes ?? []).map((node) => [node.id, node.name] as const),
    );
    const failedNodeIds = new Set(
      Object.entries(result?.status ?? {}).flatMap(([nodeId, status]) =>
        nodeId !== "__run__" && normalizeStatus(status) === "failed" ? [nodeId] : [],
      ),
    );
    for (const [nodeId, jobId] of Object.entries(stepJobs)) {
      if (normalizeStatus(jobsMap.get(jobId)?.status) === "failed") failedNodeIds.add(nodeId);
    }
    return [...failedNodeIds].map((nodeId) => {
      const storedFailure = result?.values[nodeId]?.failure;
      const jobId = storedFailure?.jobId ?? stepJobs[nodeId] ?? null;
      const job = jobId ? jobsMap.get(jobId) : undefined;
      return {
        nodeId,
        nodeName: graphNames.get(nodeId) ?? nodeId,
        message: job?.errorMessage ?? job?.reason ?? storedFailure?.message ?? null,
        jobId,
        exitCode: job?.exitCode ?? storedFailure?.exitCode ?? null,
      };
    });
  }, [jobsMap, runQ.data?.graph?.nodes, runQ.data?.result, stepJobs]);
  const runInputModel = useMemo(
    () =>
      runQ.data?.input?.yaml
        ? extractWorkflowInputModel(runQ.data.input.yaml)
        : { files: [], values: [] },
    [runQ.data?.input?.yaml],
  );

  const runStatus = normalizeStatus(runQ.data?.status);
  const canCancelRun = CANCELLABLE_RUN_STATUSES.has(runStatus);
  const cancelInProgress = cancelRun.isPending || runStatus === "cancelling";
  const graphNodeCount = runQ.data?.graph?.nodes.length ?? "-";
  const graphEdgeCount = runQ.data?.graph?.edges.length ?? "-";
  const nodeStatuses = [
    ...new Set([...Object.keys(runQ.data?.result?.status ?? {}), ...Object.keys(stepJobs)]),
  ]
    .filter((nodeId) => nodeId !== "__run__")
    .map((nodeId) => [nodeId, liveStatusByNode[nodeId] || "unknown"] as const);
  const graph = runQ.data?.graph;
  const savedOutputs = Object.entries(runQ.data?.result?.values ?? {}).filter(
    ([nodeId, result]) => nodeId !== "__run__" && Object.keys(result.values).length > 0,
  );
  const localizedError =
    runQ.data?.errorMessage && runQ.data.errorCode !== "WORKFLOW_NODE_FAILED"
      ? localizedRunError(t, runQ.data.errorCode, runQ.data.errorMessage)
      : null;

  if (runQ.error) {
    const status = runQ.error instanceof ApiError ? runQ.error.status : 0;
    const headline =
      status === 404
        ? t("workflows.run.unavailable", {
            defaultValue:
              "This workflow run may not exist, have been deleted, or be unavailable to your account",
          })
        : status === 400
          ? t("workflows.run.invalidId", { defaultValue: "The workflow run ID is invalid" })
          : t("workflows.run.loadFailed", { defaultValue: "Unable to load the workflow run" });
    const detail = toUserFacingError(
      runQ.error,
      t("workflows.run.loadFailed", { defaultValue: "无法加载工作流运行记录，请稍后重试。" }),
    );
    return (
      <div className="space-y-4" data-testid="workflow-dag-view">
        <Card className=" ">
          <CardContent className="flex items-start gap-4 p-6">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-failed" />
            <div className="min-w-0 space-y-2">
              <h2 className="text-lg font-semibold">{headline}</h2>
              <p className="text-sm text-muted-foreground">{detail}</p>
              <p className="break-all font-mono text-[11px] text-muted-foreground">{runId}</p>
              <Button
                type="button"
                variant="outline"
                disabled={runQ.isFetching}
                data-testid="workflow-run-retry"
                onClick={() => void runQ.refetch()}
              >
                {runQ.isFetching ? t("common.loading") : t("globalError.retry")}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (runQ.isPending) {
    return (
      <Card data-testid="workflow-run-loading" role="status" className=" ">
        <CardContent className="p-6 text-sm text-muted-foreground">
          {t("common.loading")}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="workflow-dag-view">
      {jobsQ.data?.failedCount ? (
        <div
          role="alert"
          data-testid="workflow-jobs-error"
          className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm"
        >
          <p>{t("workflows.run.jobsLoadFailed", { count: jobsQ.data.failedCount })}</p>
          <Button
            type="button"
            variant="outline"
            disabled={jobsQ.isFetching}
            onClick={() => void jobsQ.refetch()}
          >
            {jobsQ.isFetching ? t("common.loading") : t("globalError.retry")}
          </Button>
        </div>
      ) : null}
      {runStatus === "awaiting_approval" ? (
        <div role="status" data-testid="workflow-awaiting-approval" className=" p-4 text-sm">
          {t("workflows.run.awaitingApproval")}
        </div>
      ) : null}
      <PageHeader
        title={runQ.data?.name ?? t("workflows.run.title")}
        subtitle={runQ.data?.description}
        meta={
          <>
            {runQ.data ? (
              <Badge variant={statusToBadgeVariant(runQ.data.status)}>
                {statusLabel(runQ.data.status, language)}
              </Badge>
            ) : null}
            <span
              className="min-w-0 select-all font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
              title={runId}
              data-testid="run-meta"
            >
              {runId}
            </span>
          </>
        }
        actions={
          <>
            {runQ.data &&
            (runQ.data.input?.federationReservationId
              ? runQ.data.status === "completed"
              : runQ.data.graph?.nodes.some((node) => node.kind === "Federation")) ? (
              <Button asChild variant="outline" size="sm">
                <a
                  href={`/federation?mediaWorkflow=${encodeURIComponent(runId)}&mediaKind=${runQ.data.input?.federationReservationId ? "task-result" : "task-input"}`}
                >
                  {t("federation.delivery.prepareFromWorkflow")}
                </a>
              </Button>
            ) : null}
            {runQ.data && (canCancelRun || cancelInProgress) ? (
              <Dialog
                open={cancelTarget === runId}
                onOpenChange={(open) => setCancelTarget(open ? runId : null)}
              >
                <DialogTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="workflow-cancel-run"
                    disabled={!canCancelRun || cancelRun.isPending}
                  >
                    <X />
                    {cancelInProgress ? t("workflows.run.cancelling") : t("workflows.run.cancel")}
                  </Button>
                </DialogTrigger>
                <DialogContent dismissible={!cancelRun.isPending} outsideDismissPolicy="never">
                  <DialogHeader>
                    <DialogTitle>
                      {t("workflows.run.cancelTitle", { name: runQ.data.name })}
                    </DialogTitle>
                    <DialogDescription>{t("workflows.run.cancelDescription")}</DialogDescription>
                  </DialogHeader>
                  <DialogFooter className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      disabled={cancelRun.isPending}
                      onClick={() => setCancelTarget(null)}
                    >
                      {t("workflows.run.keepRunning")}
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={!canCancelRun || cancelRun.isPending || cancelTarget !== runId}
                      data-testid="workflow-cancel-confirm"
                      onClick={() =>
                        cancelRun.mutate(runId, { onSuccess: () => setCancelTarget(null) })
                      }
                    >
                      {cancelRun.isPending
                        ? t("workflows.run.cancelling")
                        : t("workflows.run.cancel")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            ) : null}
          </>
        }
      />
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        <RunMetric label={t("workflows.run.nodes")} value={graphNodeCount} />
        <RunMetric label={t("workflows.run.edges")} value={graphEdgeCount} />
        <RunMetric
          label={t("workflows.run.created")}
          value={
            runQ.data?.createdAt
              ? new Date(runQ.data.createdAt).toLocaleString(language)
              : t("common.loading")
          }
        />
      </dl>

      {localizedError ? (
        <Card className=" ">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-failed" />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-status-failed">{localizedError.title}</p>
              </div>
              <p className="mt-1 break-words text-sm text-muted-foreground">
                {localizedError.message}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {failedNodes.length > 0 ? (
        <Card className=" " data-testid="workflow-failure-details">
          <CardHeader>
            <CardTitle>{t("workflows.run.failureDetails")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {failedNodes.map((failure) => (
              <section
                key={failure.nodeId}
                className="min-w-0 space-y-2 border-b border-border py-3"
                data-testid={`workflow-failure-node-${failure.nodeId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground [overflow-wrap:anywhere]">
                      {failure.nodeName}
                    </p>
                    {failure.nodeName !== failure.nodeId ? (
                      <p className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {failure.nodeId}
                      </p>
                    ) : null}
                  </div>
                  {failure.exitCode !== null ? (
                    <Badge variant="failed">
                      {t("workflows.run.exitCode", { value: failure.exitCode })}
                    </Badge>
                  ) : null}
                </div>
                <p className="whitespace-pre-wrap break-words font-mono text-xs text-foreground">
                  {toUserFacingExecutionFailure(
                    failure.message,
                    t("workflows.run.failureUnavailable"),
                  )}
                </p>
                {failure.jobId ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setActiveJobId(failure.jobId);
                      setSheetOpen(true);
                    }}
                  >
                    <ExternalLink />
                    {t("workflows.run.viewFailedJob")}
                  </Button>
                ) : null}
              </section>
            ))}
            <p className="text-xs text-muted-foreground">{t("workflows.run.failureGuidance")}</p>
          </CardContent>
        </Card>
      ) : runStatus === "failed" && !localizedError ? (
        <Card className=" " data-testid="workflow-failure-details">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-failed" />
            <div>
              <p className="font-medium text-status-failed">{t("workflows.run.failureDetails")}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("workflows.run.failureUnavailable")}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {graph && graph.nodes.length > 0 ? (
        <Card className=" " data-testid="workflow-graph-card">
          <CardHeader>
            <CardTitle className="text-foreground">{t("workflows.run.graph")}</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkflowRunGraph
              graph={graph}
              missingNodeStatus={POLLED_RUN_STATUSES.has(runStatus) ? "Pending" : "Unknown"}
              statusByNode={liveStatusByNode}
              jobIdsByNode={stepJobs}
            />
            {savedOutputs.length > 0 ? (
              <details className="mt-3 border-t border-border" data-testid="workflow-run-outputs">
                <summary className="cursor-pointer py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
                  {t("workflows.run.nodeOutputs")}
                </summary>
                <div className="divide-y divide-border">
                  {savedOutputs.map(([nodeId, result]) => (
                    <section key={nodeId} className="min-w-0 py-2">
                      <h4 className="font-mono text-sm font-medium [overflow-wrap:anywhere]">
                        {nodeId}
                      </h4>
                      <NodeOutputs values={result.values} />
                    </section>
                  ))}
                </div>
              </details>
            ) : null}
          </CardContent>
        </Card>
      ) : nodeStatuses.length > 0 ? (
        <Card className=" " data-testid="workflow-nodes-card">
          <CardHeader>
            <CardTitle className="text-foreground">{t("workflows.run.nodes")}</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border">
            {nodeStatuses.map(([nodeId, status]) => {
              const values = runQ.data?.result?.values[nodeId]?.values ?? {};
              const jobId = stepJobs[nodeId];
              return (
                <div
                  key={nodeId}
                  data-testid={`workflow-node-${nodeId}`}
                  className="min-w-0 space-y-2 py-3"
                >
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="min-w-0 font-mono text-sm [overflow-wrap:anywhere]">
                      {nodeId}
                    </span>
                    <Badge variant={statusToBadgeVariant(status)}>
                      {statusLabel(status, language)}
                    </Badge>
                    {jobId ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setActiveJobId(jobId);
                          setSheetOpen(true);
                        }}
                      >
                        <ExternalLink />
                        {t("workflows.run.viewFailedJob")}
                      </Button>
                    ) : null}
                  </div>
                  <NodeOutputs values={values} />
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : (
        <Card className=" " data-testid="workflow-graph-empty">
          <CardHeader>
            <CardTitle className="text-foreground">{t("workflows.run.graph")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {runQ.isPending
                ? t("common.loading")
                : POLLED_RUN_STATUSES.has(runStatus)
                  ? t("workflows.run.graphPending")
                  : t("workflows.run.graphUnavailable")}
            </p>
          </CardContent>
        </Card>
      )}

      <details className="border-b border-border" data-testid="workflow-run-configuration">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">
          {t("workflows.run.configuration")}
        </summary>
        <div className="grid gap-3 border-border p-4 md:grid-cols-3">
          <RunConfiguration
            icon={SlidersHorizontal}
            label={t("workflows.run.parameters")}
            value={String(runInputModel.values.length)}
            detail={
              runInputModel.values.length ? (
                <ul className="space-y-1">
                  {runInputModel.values.map((item) => (
                    <li key={item.key}>{item.label}</li>
                  ))}
                </ul>
              ) : (
                "—"
              )
            }
          />
          <RunConfiguration
            icon={FileInput}
            label={t("workflows.run.inputFiles")}
            value={String(runInputModel.files.length)}
            detail={
              runInputModel.files.length ? (
                <ul className="space-y-1">
                  {runInputModel.files.map((item) => (
                    <li key={item.key}>
                      {item.nodeName}/{item.descriptor}
                    </li>
                  ))}
                </ul>
              ) : (
                "—"
              )
            }
          />
          <RunConfiguration
            icon={Route}
            label={t("workflows.run.placement")}
            value={runQ.data?.input?.placementConfig?.plannerMode ?? "Global"}
            detail={
              runQ.data?.input?.placementConfig?.budgetCap == null
                ? t("workflows.run.noBudgetCap")
                : t("workflows.run.budgetCap", {
                    value: runQ.data.input.placementConfig.budgetCap,
                  })
            }
          />
        </div>
      </details>

      <JobDetailSheet
        jobId={activeJobId}
        open={sheetOpen}
        onOpenChange={(o) => {
          setSheetOpen(o);
          if (!o) setActiveJobId(null);
        }}
      />
    </div>
  );
}
