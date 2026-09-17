import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CalendarClock,
  ExternalLink,
  FileInput,
  GitBranch,
  Layers3,
  Route,
  SlidersHorizontal,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { statusToBadgeVariant } from "../../lib/format";
import { toUserFacingError, toUserFacingExecutionFailure } from "../../lib/user-facing-error";
import { extractWorkflowInputModel } from "../../lib/workflow-input-config";
import { JobDetailSheet } from "../jobs/JobDetailSheet";
import type { JobDetail } from "../jobs/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
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

const POLLED_RUN_STATUSES = new Set(["submitted", "queued", "pending", "running", "cancelling"]);
const CANCELLABLE_RUN_STATUSES = new Set(["submitted", "queued", "pending", "running"]);

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

interface RunMetricProps {
  label: string;
  value: string | number;
  icon: ComponentType<{ className?: string }>;
}

function RunMetric({ label, value, icon: Icon }: RunMetricProps) {
  return (
    <div className="rounded-xl border border-border bg-card p-3 shadow-none">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <Icon className="h-4 w-4 text-brand" />
      </div>
      <div
        className="mt-2 truncate font-mono text-lg font-semibold tabular-nums"
        title={String(value)}
      >
        {value}
      </div>
    </div>
  );
}

function RunConfiguration({
  detail,
  icon: Icon,
  label,
  value,
}: {
  detail: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <Icon className="h-4 w-4 text-brand" />
        {label}
      </div>
      <p className="mt-2 text-lg font-semibold">{value}</p>
      <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground" title={detail}>
        {detail}
      </p>
    </section>
  );
}

export interface WorkflowDagViewProps {
  runId: string;
}

export function WorkflowDagView({ runId }: WorkflowDagViewProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

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
    mutationFn: () => api.post<WorkflowCancelResponse>(`/workflows/${runId}/cancel`, {}),
    onSuccess: (res) => {
      queryClient.setQueryData<WorkflowRunDetail>(["workflow-detail", runId], (run) =>
        run ? { ...run, status: res.status } : run,
      );
      queryClient.invalidateQueries({ queryKey: ["workflow-detail", runId] });
      toast.success("Workflow cancellation requested");
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
    () =>
      Object.values(stepJobs)
        .filter((jobId) => jobId.length > 0)
        .sort(),
    [stepJobs],
  );

  const jobsQ = useQuery({
    queryKey: ["workflow-jobs", runId, jobIds.join(",")],
    enabled: jobIds.length > 0,
    queryFn: async () => {
      const results = await Promise.all(
        jobIds.map(async (id) => {
          try {
            return await api.get<JobDetail>(`/jobs/${id}`);
          } catch {
            return null;
          }
        }),
      );
      return results.filter((j): j is JobDetail => j !== null);
    },
    refetchInterval: 5_000,
  });

  const jobsMap = useMemo(() => {
    const m = new Map<string, JobDetail>();
    for (const j of jobsQ.data ?? []) m.set(j.id, j);
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
        <Card className="rounded-xl shadow-none">
          <CardContent className="flex items-start gap-4 p-6">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-status-failed" />
            <div className="space-y-1">
              <h2 className="text-lg font-semibold">{headline}</h2>
              <p className="text-sm text-muted-foreground">{detail}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{runId}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="workflow-dag-view">
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {runQ.data ? (
                <Badge variant={statusToBadgeVariant(runQ.data.status)}>{runQ.data.status}</Badge>
              ) : null}
              <span
                className="rounded-full border border-border bg-background px-3 py-1 font-mono text-[11px] text-muted-foreground"
                title={runId}
                data-testid="run-meta"
              >
                {runId.slice(0, 8)}
                {runQ.data?.createdAt ? ` created ${runQ.data.createdAt}` : null}
              </span>
            </div>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {runQ.data?.name ?? "Workflow run"}
            </h2>
            {runQ.data?.description ? (
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                {runQ.data.description}
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {runQ.data && (canCancelRun || cancelInProgress) ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="workflow-cancel-run"
                disabled={!canCancelRun || cancelRun.isPending}
                onClick={() => cancelRun.mutate()}
              >
                <X />
                {cancelInProgress ? "Cancelling" : "Cancel run"}
              </Button>
            ) : null}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <RunMetric label="Nodes" value={graphNodeCount} icon={Layers3} />
        <RunMetric label="Edges" value={graphEdgeCount} icon={GitBranch} />
        <RunMetric label="Created" value={runQ.data?.createdAt ?? "loading"} icon={CalendarClock} />
      </div>

      {localizedError ? (
        <Card className="rounded-xl border-status-failed/40 bg-status-failed/5 shadow-none">
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
        <Card
          className="rounded-xl border-status-failed/40 bg-status-failed/5 shadow-none"
          data-testid="workflow-failure-details"
        >
          <CardHeader>
            <CardTitle>{t("workflows.run.failureDetails")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {failedNodes.map((failure) => (
              <section
                key={failure.nodeId}
                className="space-y-2 rounded-lg border border-status-failed/30 bg-background p-3"
                data-testid={`workflow-failure-node-${failure.nodeId}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-foreground">{failure.nodeName}</p>
                    <p className="truncate font-mono text-[11px] text-muted-foreground">
                      {failure.nodeId}
                    </p>
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
        <Card
          className="rounded-xl border-status-failed/40 bg-status-failed/5 shadow-none"
          data-testid="workflow-failure-details"
        >
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

      <Card className="rounded-xl shadow-none" data-testid="workflow-run-configuration">
        <CardHeader>
          <CardTitle>{t("workflows.run.configuration")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          <RunConfiguration
            icon={SlidersHorizontal}
            label={t("workflows.run.parameters")}
            value={String(runInputModel.values.length)}
            detail={runInputModel.values.map((item) => item.label).join(" · ") || "—"}
          />
          <RunConfiguration
            icon={FileInput}
            label={t("workflows.run.inputFiles")}
            value={String(runInputModel.files.length)}
            detail={
              runInputModel.files
                .map((item) => `${item.nodeName}/${item.descriptor}`)
                .join(" · ") || "—"
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
        </CardContent>
      </Card>

      {runQ.data?.graph && runQ.data.graph.nodes.length > 0 ? (
        <Card className="rounded-xl shadow-none" data-testid="workflow-graph-card">
          <CardHeader>
            <CardTitle className="text-foreground">Graph</CardTitle>
          </CardHeader>
          <CardContent>
            <WorkflowRunGraph graph={runQ.data.graph} statusByNode={liveStatusByNode} />
          </CardContent>
        </Card>
      ) : nodeStatuses.length > 0 ? (
        <Card className="rounded-xl shadow-none" data-testid="workflow-nodes-card">
          <CardHeader>
            <CardTitle className="text-foreground">Nodes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {nodeStatuses.map(([nodeId, status]) => {
              const values = runQ.data?.result?.values[nodeId]?.values ?? {};
              const jobId = stepJobs[nodeId];
              return (
                <div
                  key={nodeId}
                  data-testid={`workflow-node-${nodeId}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/20 p-3"
                >
                  <span className="font-mono text-xs">{nodeId}</span>
                  <div className="flex items-center gap-2">
                    {Object.keys(values).length > 0 ? (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {JSON.stringify(values)}
                      </span>
                    ) : null}
                    <Badge variant={statusToBadgeVariant(status)}>{status}</Badge>
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
                </div>
              );
            })}
          </CardContent>
        </Card>
      ) : (
        <Card className="rounded-xl shadow-none" data-testid="workflow-graph-empty">
          <CardHeader>
            <CardTitle className="text-foreground">Graph</CardTitle>
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
