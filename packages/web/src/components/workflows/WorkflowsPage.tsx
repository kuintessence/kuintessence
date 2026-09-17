import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  CheckCircle2,
  CircleSlash2,
  FilePenLine,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { Input } from "../ui/input";
import { type WorkflowRunRow, WorkflowsTable } from "./WorkflowsTable";

interface WorkflowsResp {
  runs: WorkflowRunRow[];
  total?: number;
  limit?: number;
  offset?: number;
  summary?: Record<SummaryTone, number>;
}

interface WorkflowDraftRow {
  id: string;
  name: string;
  updatedAt: string;
}

const ACTIVE_REFETCH_MS = 5_000;
const IDLE_REFETCH_MS = 30_000;
const PAGE_SIZE = 25;

const WORKFLOW_FILTERS = ["ALL", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED"] as const;
type WorkflowFilter = (typeof WORKFLOW_FILTERS)[number];
type WorkflowBucket = "active" | "completed" | "failed" | "cancelled" | "other";
type SummaryTone = "active" | "completed" | "failed" | "cancelled";

export function isActiveWorkflowStatus(s: string): boolean {
  const u = s.toUpperCase();
  return (
    u === "SUBMITTED" ||
    u === "QUEUED" ||
    u === "PENDING" ||
    u === "AWAITING_APPROVAL" ||
    u === "RUNNING" ||
    u === "CANCELLING"
  );
}

function classifyStatus(status: string): WorkflowBucket {
  const normalized = status.toUpperCase();
  if (isActiveWorkflowStatus(normalized)) return "active";
  if (normalized === "COMPLETED" || normalized === "SUCCEEDED" || normalized === "DONE") {
    return "completed";
  }
  if (normalized === "FAILED" || normalized === "ERROR" || normalized === "WORKFLOW_INTERRUPTED") {
    return "failed";
  }
  if (normalized === "CANCELLED" || normalized === "CANCELED") return "cancelled";
  return "other";
}

function countByBucket(runs: WorkflowRunRow[], bucket: WorkflowBucket): number {
  return runs.filter((run) => classifyStatus(run.status) === bucket).length;
}

const SUMMARY_TONE_CLASS: Record<SummaryTone, string> = {
  active:
    "border-brand/30 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--brand)_14%,transparent),transparent_62%)] text-brand",
  completed:
    "border-status-succeeded/30 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--status-succeeded)_14%,transparent),transparent_62%)] text-[var(--status-succeeded)]",
  failed:
    "border-status-failed/30 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--status-failed)_13%,transparent),transparent_62%)] text-[var(--status-failed)]",
  cancelled:
    "border-status-cancelled/30 bg-[linear-gradient(135deg,color-mix(in_oklab,var(--status-cancelled)_13%,transparent),transparent_62%)] text-[var(--status-cancelled)]",
};

interface SummaryItem {
  key: SummaryTone;
  label: string;
  value: number | string;
  icon: ComponentType<{ className?: string }>;
}

export function WorkflowsPage() {
  const { t } = useTranslation();
  const [search, setSearch] = useState<string>("");
  const [status, setStatus] = useState<WorkflowFilter>("ALL");
  const [offset, setOffset] = useState(0);
  const navigate = useNavigate();

  const listPath = useMemo(() => {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
    const query = search.trim();
    if (query) params.set("q", query);
    if (status !== "ALL") params.set("status", status.toLowerCase());
    return `/workflows?${params.toString()}`;
  }, [offset, search, status]);

  const runsQ = useQuery({
    queryKey: ["workflows-list", { offset, search: search.trim(), status }],
    queryFn: () => api.get<WorkflowsResp>(listPath),
    refetchInterval: (q) => {
      const data = q.state.data;
      const hasActive = data?.runs?.some((r) => isActiveWorkflowStatus(r.status));
      return hasActive ? ACTIVE_REFETCH_MS : IDLE_REFETCH_MS;
    },
  });
  const draftsQ = useQuery({
    queryKey: ["workflow-drafts"],
    queryFn: () => api.get<{ drafts: WorkflowDraftRow[] }>("/workflows/drafts"),
  });

  const loadError = runsQ.error as Error | null;
  const runs = loadError ? [] : (runsQ.data?.runs ?? []);
  const total = loadError ? 0 : (runsQ.data?.total ?? runs.length);
  const active = loadError ? 0 : (runsQ.data?.summary?.active ?? countByBucket(runs, "active"));
  const completed = loadError
    ? 0
    : (runsQ.data?.summary?.completed ?? countByBucket(runs, "completed"));
  const failed = loadError ? 0 : (runsQ.data?.summary?.failed ?? countByBucket(runs, "failed"));
  const cancelled = loadError
    ? 0
    : (runsQ.data?.summary?.cancelled ?? countByBucket(runs, "cancelled"));
  const visibleValue = loadError ? "—" : runs.length;
  const totalValue = loadError ? "—" : total;

  useEffect(() => {
    if (runsQ.isLoading || runsQ.isFetching || loadError || offset === 0 || offset < total) return;
    setOffset(total === 0 ? 0 : Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
  }, [loadError, offset, runsQ.isFetching, runsQ.isLoading, total]);

  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilters = search.trim() !== "" || status !== "ALL";
  const emptyState = runsQ.isLoading
    ? t("workflows.loading")
    : hasFilters
      ? t("workflows.noMatches")
      : t("workflows.empty");
  const summary = [
    {
      key: "active",
      label: t("workflows.summary.active"),
      value: loadError ? "—" : active,
      icon: Activity,
    },
    {
      key: "completed",
      label: t("workflows.summary.completed"),
      value: loadError ? "—" : completed,
      icon: CheckCircle2,
    },
    {
      key: "failed",
      label: t("workflows.summary.failed"),
      value: loadError ? "—" : failed,
      icon: X,
    },
    {
      key: "cancelled",
      label: t("workflows.summary.cancelled"),
      value: loadError ? "—" : cancelled,
      icon: CircleSlash2,
    },
  ] satisfies SummaryItem[];

  return (
    <div className="space-y-5" data-testid="workflows-page">
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 space-y-2">
            <div
              className="inline-flex items-center gap-2 rounded-full border border-brand/25 bg-brand-soft px-3 py-1 text-xs font-medium text-brand"
              data-testid="workflows-count"
            >
              <Activity className="h-3.5 w-3.5" />
              {t("workflows.countHint", {
                visible: visibleValue,
                total: totalValue,
              })}
            </div>
            <div>
              <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
                {t("workflows.title")}
              </h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
                {t("workflows.subtitle")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => runsQ.refetch()}
              data-testid="workflows-refresh"
            >
              <RefreshCw className={cn(runsQ.isFetching && "animate-spin")} />
              {t("common.refresh", { defaultValue: "Refresh" })}
            </Button>
            {loadError ? (
              <Button disabled data-testid="workflows-new">
                <Plus />
                {t("workflows.newWorkflow")}
              </Button>
            ) : (
              <Button asChild data-testid="workflows-new">
                <Link to="/workflows/new">
                  <Plus />
                  {t("workflows.newWorkflow")}
                </Link>
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" data-testid="workflows-summary">
        {summary.map((item) => {
          const Icon = item.icon;
          return (
            <Card
              key={item.key}
              className={cn("overflow-hidden rounded-xl shadow-none", SUMMARY_TONE_CLASS[item.key])}
            >
              <CardContent className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <span className="block text-xs font-medium text-muted-foreground">
                    {item.label}
                  </span>
                  <span
                    className="mt-1 block font-mono text-2xl font-semibold tabular-nums text-foreground"
                    data-testid={`workflows-summary-${item.key}`}
                  >
                    {item.value}
                  </span>
                </div>
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-current/20 bg-card/70">
                  <Icon className="h-4 w-4" />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {(draftsQ.data?.drafts.length ?? 0) > 0 ? (
        <Card className="rounded-xl shadow-none" data-testid="workflow-drafts">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">{t("workflows.drafts.title")}</h3>
                <p className="text-xs text-muted-foreground">{t("workflows.drafts.description")}</p>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {draftsQ.data?.drafts.length ?? 0}
              </span>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {draftsQ.data?.drafts.map((draft) => (
                <div
                  key={draft.id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-muted/15 p-3"
                >
                  <FilePenLine className="h-4 w-4 shrink-0 text-brand" />
                  <a
                    className="min-w-0 flex-1"
                    href={`/workflows/new?draftId=${encodeURIComponent(draft.id)}`}
                  >
                    <span className="block truncate text-sm font-medium">{draft.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {new Date(draft.updatedAt).toLocaleString()}
                    </span>
                  </a>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    aria-label={t("common.delete")}
                    onClick={async () => {
                      try {
                        await api.delete(`/workflows/drafts/${draft.id}`);
                        await draftsQ.refetch();
                      } catch (error) {
                        toast.error(
                          toUserFacingError(
                            error,
                            t("workflows.drafts.deleteFailed", {
                              defaultValue: "无法删除工作流草稿，请稍后重试。",
                            }),
                          ),
                        );
                      }
                    }}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
      {draftsQ.error ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-status-failed/40 bg-status-failed/5 p-3 text-sm text-status-failed"
          data-testid="workflow-drafts-error"
          role="alert"
        >
          <span>
            {toUserFacingError(
              draftsQ.error,
              t("workflows.drafts.loadFailed", {
                defaultValue: "无法加载工作流草稿，请稍后重试。",
              }),
            )}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={() => draftsQ.refetch()}>
            <RefreshCw />
            {t("common.refresh")}
          </Button>
        </div>
      ) : null}

      <Card className="rounded-xl shadow-none">
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center">
              <div className="relative w-full sm:w-96">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setOffset(0);
                  }}
                  placeholder={t("workflows.searchPlaceholder")}
                  className="h-10 rounded-lg bg-background pl-9"
                  data-testid="workflows-search"
                />
              </div>
              <div
                className="flex max-w-full gap-1 overflow-x-auto rounded-lg border border-border bg-muted/30 p-1"
                data-testid="workflows-status-filter"
              >
                {WORKFLOW_FILTERS.map((s) => {
                  const selected = s === status;
                  return (
                    <button
                      key={s}
                      type="button"
                      data-testid={`workflows-chip-${s.toLowerCase()}`}
                      onClick={() => {
                        setStatus(s);
                        setOffset(0);
                      }}
                      className={cn(
                        "h-8 whitespace-nowrap rounded-md px-3 text-xs font-medium transition-colors",
                        selected
                          ? "bg-card text-foreground shadow-sm"
                          : "text-muted-foreground hover:bg-card/70 hover:text-foreground",
                      )}
                    >
                      {s === "ALL" ? t("common.all") : t(`workflows.filters.${s.toLowerCase()}`)}
                    </button>
                  );
                })}
              </div>
            </div>
            {hasFilters ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatus("ALL");
                  setOffset(0);
                }}
                data-testid="workflows-clear-filters"
              >
                <X />
                {t("workflows.clearFilters")}
              </Button>
            ) : null}
          </div>

          {loadError ? (
            <div
              className="rounded-lg border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
              data-testid="workflows-list-error"
            >
              {toUserFacingError(
                loadError,
                t("workflows.loadFailed", { defaultValue: "无法加载工作流列表，请稍后重试。" }),
              )}
            </div>
          ) : null}

          {loadError ? null : (
            <WorkflowsTable
              runs={runs}
              globalFilter=""
              onRowClick={(r) => navigate({ to: "/workflows/$runId", params: { runId: r.id } })}
              emptyState={emptyState}
            />
          )}
          {!loadError && total > PAGE_SIZE ? (
            <div
              className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4"
              data-testid="workflows-pagination"
            >
              <span className="text-sm text-muted-foreground">
                {t("workflows.pagination.page", { page, pages })}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={offset === 0 || runsQ.isFetching}
                  onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                  data-testid="workflows-previous-page"
                >
                  {t("common.previous")}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= total || runsQ.isFetching}
                  onClick={() => setOffset((value) => value + PAGE_SIZE)}
                  data-testid="workflows-next-page"
                >
                  {t("common.next")}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
