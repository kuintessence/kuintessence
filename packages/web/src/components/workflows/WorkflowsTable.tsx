import type { ColumnDef } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { relativeFromNow, statusLabel, statusToBadgeVariant } from "../../lib/format";
import { useMediaQuery } from "../../lib/use-media-query";
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
  const narrow = useMediaQuery("(max-width: 767px)");
  const columns = useMemo<ColumnDef<WorkflowRunRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col">
            <span className="max-w-[28rem] truncate font-medium" title={row.original.name}>
              {row.original.name}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground" title={row.original.id}>
              {row.original.id.slice(0, 8)}
            </span>
          </div>
        ),
      },
      {
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <Badge className="whitespace-nowrap" variant={statusToBadgeVariant(row.original.status)}>
            {statusLabel(row.original.status)}
          </Badge>
        ),
        sortingFn: "alphanumeric",
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span
            className="font-mono text-[11px] text-muted-foreground tabular-nums"
            title={row.original.createdAt}
          >
            {relativeFromNow(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [],
  );

  if (narrow) {
    return (
      <div className="space-y-2">
        {runs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card px-4 py-10 text-center text-sm text-muted-foreground">
            {emptyState ?? "No workflow runs match these filters."}
          </div>
        ) : (
          runs.map((run) => (
            <button
              key={run.id}
              type="button"
              data-testid={`workflow-row-${run.id}`}
              onClick={() => onRowClick(run)}
              className="flex w-full flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left shadow-sm transition-colors hover:bg-muted/30"
            >
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold" title={run.name}>
                  {run.name}
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                  {run.id.slice(0, 8)}
                </div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <Badge className="whitespace-nowrap" variant={statusToBadgeVariant(run.status)}>
                  {statusLabel(run.status)}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {relativeFromNow(run.createdAt)}
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
      data={runs}
      globalFilter={globalFilter}
      getRowId={(r) => r.id}
      rowDataTestId={(r) => `workflow-row-${r.id}`}
      onRowClick={onRowClick}
      emptyState={emptyState ?? "No workflow runs match these filters."}
    />
  );
}
