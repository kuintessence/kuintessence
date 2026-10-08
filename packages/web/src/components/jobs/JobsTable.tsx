import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { relativeFromNow, statusLabel, statusToBadgeVariant } from "../../lib/format";
import { useMediaQuery } from "../../lib/use-media-query";
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
  const narrow = useMediaQuery("(max-width: 767px)");
  const columns = useMemo<ColumnDef<JobRow>[]>(
    () => [
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
        accessorKey: "name",
        header: t("jobs.overview.name"),
        cell: ({ row }) => (
          <div className="flex min-w-0 max-w-[28rem] flex-col">
            <button
              type="button"
              className="max-w-[28rem] truncate rounded-sm text-left font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              title={row.original.name}
              onClick={(event) => {
                event.stopPropagation();
                onRowClick(row.original);
              }}
            >
              {row.original.name}
            </button>
            <span
              className="truncate font-mono text-[11px] text-muted-foreground"
              title={row.original.id}
            >
              {row.original.id}
            </span>
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
        accessorKey: "submittedAt",
        header: t("jobs.overview.submitted"),
        cell: ({ row }) => (
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
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
      <div className="space-y-2">
        {jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            {t("jobs.noMatches")}
          </div>
        ) : (
          jobs.map((job) => (
            <button
              key={job.id}
              type="button"
              data-testid={`job-row-${job.id}`}
              onClick={() => onRowClick(job)}
              className="flex w-full flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/30"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold" title={job.name}>
                  {job.name}
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {job.id}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <Badge className="whitespace-nowrap" variant={statusToBadgeVariant(job.status)}>
                    {statusLabel(job.status, language)}
                  </Badge>
                  {job.accessScope ? (
                    <Badge variant="outline" className="max-w-36 truncate">
                      {t(`jobs.scope.${job.accessScope}`)}
                    </Badge>
                  ) : null}
                </div>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
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
    <DataTable
      columns={columns}
      data={jobs}
      getRowId={(j) => j.id}
      rowDataTestId={(j) => `job-row-${j.id}`}
      onRowClick={onRowClick}
      emptyState={t("jobs.noMatches")}
    />
  );
}
