import type { ColumnDef } from "@tanstack/react-table";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { relativeFromNow, statusToBadgeVariant } from "../../lib/format";
import { useMediaQuery } from "../../lib/use-media-query";
import { Badge } from "../ui/badge";
import { DataTable } from "../ui/data-table";
import type { JobRow } from "./types";

export interface JobsTableProps {
  jobs: JobRow[];
  onRowClick: (job: JobRow) => void;
}

export function JobsTable({ jobs, onRowClick }: JobsTableProps) {
  const { t } = useTranslation();
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
        header: "Name",
        cell: ({ row }) => (
          <div className="flex min-w-0 max-w-[28rem] flex-col">
            <span className="truncate font-medium" title={row.original.name}>
              {row.original.name}
            </span>
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
        header: "Status",
        cell: ({ row }) => (
          <Badge className="whitespace-nowrap" variant={statusToBadgeVariant(row.original.status)}>
            {row.original.status}
          </Badge>
        ),
        sortingFn: "alphanumeric",
      },
      {
        accessorKey: "submittedAt",
        header: "Submitted",
        cell: ({ row }) => (
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            title={row.original.submittedAt}
          >
            {relativeFromNow(row.original.submittedAt)}
          </span>
        ),
      },
    ],
    [t],
  );

  if (narrow) {
    return (
      <div className="space-y-2">
        {jobs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            No jobs match these filters.
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
                    {job.status}
                  </Badge>
                  {job.accessScope ? (
                    <Badge variant="outline" className="max-w-36 truncate">
                      {t(`jobs.scope.${job.accessScope}`)}
                    </Badge>
                  ) : null}
                </div>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {relativeFromNow(job.submittedAt)}
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
      emptyState="No jobs match these filters."
    />
  );
}
