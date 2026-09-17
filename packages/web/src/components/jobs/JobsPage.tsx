import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Button } from "../ui/button";
import { Card, CardContent } from "../ui/card";
import { PageHeader, PageShell } from "../ui/page";
import { ImportJobJsonDialog } from "./ImportJobJsonDialog";
import { JobDetailSheet } from "./JobDetailSheet";
import { JobsTable } from "./JobsTable";
import { JobsToolbar } from "./JobsToolbar";
import { SubmitJobDialog } from "./SubmitJobDialog";
import type { AccessScopeFilter, JobRow, StatusFilter } from "./types";

interface JobsResp {
  jobs: JobRow[];
  total?: number;
  limit?: number;
  offset?: number;
}

const ACTIVE_REFETCH_MS = 5_000;
const IDLE_REFETCH_MS = 30_000;
const PAGE_SIZE = 25;

function isActiveStatus(status: string): boolean {
  const s = status.toUpperCase();
  return s === "PENDING" || s === "QUEUED" || s === "RUNNING";
}

export function jobsPath(input: {
  pageIndex: number;
  search: string;
  status: StatusFilter;
  scope: AccessScopeFilter;
  agentId?: string;
}): string {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(input.pageIndex * PAGE_SIZE),
    scope: input.scope,
  });
  const query = input.search.trim();
  if (query.length > 0) params.set("q", query);
  if (input.status !== "ALL") params.set("status", input.status.toLowerCase());
  if (input.agentId) params.set("agentId", input.agentId);
  return `/jobs?${params.toString()}`;
}

export interface JobsPageProps {
  agentId?: string;
  onClearAgentFilter?: () => void;
}

export function JobsPage({ agentId, onClearAgentFilter }: JobsPageProps = {}) {
  const { t } = useTranslation();
  const [search, setSearch] = useState<string>("");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [scope, setScope] = useState<AccessScopeFilter>("all");
  const [submitOpen, setSubmitOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [openUsecasePicker, setOpenUsecasePicker] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const queryPath = useMemo(
    () => jobsPath({ pageIndex, search, status, scope, agentId }),
    [agentId, pageIndex, search, status, scope],
  );

  const jobsQ = useQuery({
    queryKey: ["jobs-list", pageIndex, search, status, scope, agentId ?? null],
    queryFn: () => api.get<JobsResp>(queryPath),
    refetchInterval: (q) => {
      const data = q.state.data;
      const hasActive = data?.jobs?.some((j) => isActiveStatus(j.status));
      return hasActive ? ACTIVE_REFETCH_MS : IDLE_REFETCH_MS;
    },
  });

  const loadError = jobsQ.error as Error | null;
  const jobs = loadError ? [] : (jobsQ.data?.jobs ?? []);
  const total = loadError ? 0 : (jobsQ.data?.total ?? jobs.length);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pageStart = total === 0 ? 0 : pageIndex * PAGE_SIZE + 1;
  const pageEnd = Math.min(total, pageIndex * PAGE_SIZE + jobs.length);

  useEffect(() => {
    if (!jobsQ.data) {
      return;
    }
    if (pageIndex > 0 && pageIndex >= pageCount) {
      setPageIndex(pageCount - 1);
    }
  }, [jobsQ.data, pageCount, pageIndex]);

  useEffect(() => {
    if (!loadError) return;
    setActiveId(null);
    setSheetOpen(false);
  }, [loadError]);

  return (
    <PageShell data-testid="jobs-page">
      <PageHeader
        title={t("jobs.title")}
        subtitle={t("jobs.subtitle")}
        actions={
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            data-testid="jobs-count"
          >
            {t("jobs.countHint", { visible: jobs.length, total })}
          </span>
        }
      />

      <Card>
        <CardContent className="p-3 sm:p-4">
          <JobsToolbar
            search={search}
            onSearchChange={(next) => {
              setSearch(next);
              setPageIndex(0);
            }}
            status={status}
            onStatusChange={(next) => {
              setStatus(next);
              setPageIndex(0);
            }}
            scope={scope}
            onScopeChange={(next) => {
              setScope(next);
              setPageIndex(0);
            }}
            onSubmitJob={() => {
              if (loadError) return;
              setOpenUsecasePicker(false);
              setSubmitOpen(true);
            }}
            onImportJson={() => {
              if (loadError) return;
              setImportOpen(true);
            }}
            onCreateFromUsecase={() => {
              if (loadError) return;
              setOpenUsecasePicker(true);
              setSubmitOpen(true);
            }}
            actionsDisabled={Boolean(loadError)}
          />
        </CardContent>
      </Card>

      {agentId ? (
        <div
          className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-brand/30 bg-brand-soft px-3 py-2 text-sm"
          data-testid="jobs-agent-filter"
        >
          <span className="min-w-0 break-all">{t("jobs.agentFilter.active", { agentId })}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
            aria-label={t("jobs.agentFilter.clear")}
            title={t("jobs.agentFilter.clear")}
            onClick={onClearAgentFilter}
            data-testid="jobs-agent-filter-clear"
          >
            <X />
          </Button>
        </div>
      ) : null}

      {loadError ? (
        <div
          className="rounded-md border border-status-failed/40 bg-[color-mix(in_oklab,var(--status-failed)_10%,transparent)] p-3 text-sm"
          data-testid="jobs-list-error"
        >
          {toUserFacingError(
            loadError,
            t("jobs.loadFailed", { defaultValue: "无法加载作业列表，请稍后重试。" }),
          )}
        </div>
      ) : null}

      {loadError ? null : (
        <JobsTable
          jobs={jobs}
          onRowClick={(j) => {
            setActiveId(j.id);
            setSheetOpen(true);
          }}
        />
      )}

      {loadError ? null : (
        <div
          className="flex flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
          data-testid="jobs-pagination"
        >
          <span className="tabular-nums" data-testid="jobs-pagination-range">
            {t("jobs.pagination.range", {
              start: pageStart,
              end: pageEnd,
              total,
              defaultValue: `${pageStart}-${pageEnd} / ${total}`,
            })}
          </span>
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pageIndex === 0 || jobsQ.isFetching}
              onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
              data-testid="jobs-prev-page"
            >
              {t("jobs.pagination.previous", { defaultValue: "上一页" })}
            </Button>
            <span
              className="min-w-20 text-center text-xs tabular-nums"
              data-testid="jobs-page-index"
            >
              {t("jobs.pagination.page", {
                page: pageIndex + 1,
                pages: pageCount,
                defaultValue: `${pageIndex + 1} / ${pageCount}`,
              })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pageIndex + 1 >= pageCount || jobsQ.isFetching}
              onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
              data-testid="jobs-next-page"
            >
              {t("jobs.pagination.next", { defaultValue: "下一页" })}
            </Button>
          </div>
        </div>
      )}

      <JobDetailSheet
        jobId={activeId}
        open={sheetOpen}
        onOpenChange={(o) => {
          setSheetOpen(o);
          if (!o) setActiveId(null);
        }}
      />

      <ImportJobJsonDialog open={importOpen} onOpenChange={setImportOpen} />
      <SubmitJobDialog
        open={submitOpen}
        onOpenChange={(next) => {
          setSubmitOpen(next);
          if (!next) setOpenUsecasePicker(false);
        }}
        openUsecasePickerOnOpen={openUsecasePicker}
      />
    </PageShell>
  );
}
