import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { relativeFromNow, statusLabel, statusToBadgeVariant } from "../../lib/format";
import { useCompactLayout } from "../../lib/use-compact-layout";
import { Badge } from "../ui/badge";
import { DataTable } from "../ui/data-table";
import type { JobRow } from "./types";

export interface JobsTableProps {
  jobs: JobRow[];
  onRowClick: (job: JobRow) => void;
}

export function JobsTable({ jobs, onRowClick }: JobsTableProps) {
  const { t, i18n } = useTranslation();
  const language = i18n?.resolvedLanguage ?? i18n?.language;
  const [measure, narrow] = useCompactLayout(704);
  const columns = useMemo<ColumnDef<JobRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("jobs.overview.name"),
        cell: ({ row }) => (
          <div className="flex min-w-0 max-w-[28rem] flex-col">
            <button
              type="button"
              className="max-w-full whitespace-normal text-left [overflow-wrap:anywhere] font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              title={row.original.name}
              onClick={(event) => {
                event.stopPropagation();
                onRowClick(row.original);
              }}
            >
              {row.original.name}
            </button>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: t("dashboard.status"),
        cell: ({ row }) => (
          <Badge className="whitespace-nowrap" variant={statusToBadgeVariant(row.original.status)}>
            {statusLabel(row.original.status, language)}
          </Badge>
        ),
        sortingFn: "alphanumeric",
      },
      {
        accessorKey: "accessScope",
        header: t("jobs.scope.label"),
        cell: ({ row }) =>
          row.original.accessScope ? (
            <Badge variant="outline" className="whitespace-nowrap">
              {t(`jobs.scope.${row.original.accessScope}`)}
            </Badge>
          ) : null,
      },
      {
        accessorKey: "submittedAt",
        header: t("jobs.overview.submitted"),
        cell: ({ row }) => (
          <span
            className="whitespace-nowrap font-mono text-[11px] text-muted-foreground tabular-nums"
            title={row.original.submittedAt}
          >
            {relativeFromNow(row.original.submittedAt, undefined, language)}
          </span>
        ),
      },
    ],
    [t, language, onRowClick],
  );

  if (narrow) {
    return (
      <div ref={measure} className="divide-y divide-border">
        {jobs.length === 0 ? (
          <div className=" border-border px-4 py-10 text-center text-sm text-muted-foreground">
            {t("jobs.noMatches")}
          </div>
        ) : (
          jobs.map((job) => (
            <button
              key={job.id}
              type="button"
              data-testid={`job-row-${job.id}`}
              onClick={() => onRowClick(job)}
              className="flex w-full flex-col gap-3 border-border p-4 text-left transition-colors"
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold [overflow-wrap:anywhere]" title={job.name}>
                  {job.name}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                  <Badge className="whitespace-nowrap" variant={statusToBadgeVariant(job.status)}>
                    {statusLabel(job.status, language)}
                  </Badge>
                  {job.accessScope ? (
                    <Badge variant="outline">{t(`jobs.scope.${job.accessScope}`)}</Badge>
                  ) : null}
                </div>
                <span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground tabular-nums">
                  {relativeFromNow(job.submittedAt, undefined, language)}
                </span>
              </div>
            </button>
          ))
        )}
      </div>
    );
  }

  return (
    <div ref={measure}>
      <DataTable
        manualPagination
        manualSorting
        hidePagination
        columns={columns}
        data={jobs}
        getRowId={(j) => j.id}
        rowDataTestId={(j) => `job-row-${j.id}`}
        onRowClick={onRowClick}
        emptyState={t("jobs.noMatches")}
      />
    </div>
  );
}
