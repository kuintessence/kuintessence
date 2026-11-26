import type { ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { compactUuid, relativeFromNow, statusLabel, statusToBadgeVariant } from "../../lib/format";
import { useCompactLayout } from "../../lib/use-compact-layout";
import { Badge } from "../ui/badge";
import { DataTable } from "../ui/data-table";

export interface WorkflowRunRow {
  id: string;
  name: string;
  status: string;
  createdAt: string;
}

export interface WorkflowsTableProps {
  runs: WorkflowRunRow[];
  globalFilter: string;
  onRowClick: (run: WorkflowRunRow) => void;
  emptyState?: ReactNode;
}

export function WorkflowsTable({
  runs,
  globalFilter,
  onRowClick,
  emptyState,
}: WorkflowsTableProps) {
  const { t, i18n } = useTranslation();
  const language = i18n?.resolvedLanguage ?? i18n?.language;
  const [measure, narrow] = useCompactLayout(704);
  const columns = useMemo<ColumnDef<WorkflowRunRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: t("jobs.overview.name"),
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col">
            <button
              type="button"
              className="max-w-[28rem] whitespace-normal text-left [overflow-wrap:anywhere] font-medium text-brand underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
              title={row.original.name}
              onClick={(event) => {
                event.stopPropagation();
                onRowClick(row.original);
              }}
            >
              {row.original.name}
            </button>
            <span
              className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]"
              title={row.original.id}
            >
              {compactUuid(row.original.id)}
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
        accessorKey: "createdAt",
        header: t("workflows.run.created"),
        cell: ({ row }) => (
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            title={row.original.createdAt}
          >
            {relativeFromNow(row.original.createdAt, undefined, language)}
          </span>
        ),
      },
    ],
    [t, language, onRowClick],
  );

  if (narrow) {
    return (
      <div ref={measure} className="divide-y divide-border">
        {runs.length === 0 ? (
          <div className=" border-border px-4 py-10 text-center text-sm text-muted-foreground">
            {emptyState ?? t("workflows.noMatches")}
          </div>
        ) : (
          runs.map((run) => (
            <button
              key={run.id}
              type="button"
              data-testid={`workflow-row-${run.id}`}
              onClick={() => onRowClick(run)}
              className="flex w-full flex-col gap-3 border-border p-4 text-left transition-colors"
            >
              <div className="min-w-0">
                <div className="text-sm font-semibold [overflow-wrap:anywhere]" title={run.name}>
                  {run.name}
                </div>
                <div className="mt-1 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                  {compactUuid(run.id)}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <Badge className="whitespace-nowrap" variant={statusToBadgeVariant(run.status)}>
                  {statusLabel(run.status, language)}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {relativeFromNow(run.createdAt, undefined, language)}
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
        data={runs}
        globalFilter={globalFilter}
        getRowId={(r) => r.id}
        rowDataTestId={(r) => `workflow-row-${r.id}`}
        onRowClick={onRowClick}
        emptyState={emptyState ?? t("workflows.noMatches")}
      />
    </div>
  );
}
