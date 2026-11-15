import {
  type ColumnDef,
  type FilterFn,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type OnChangeFn,
  type PaginationState,
  type Row,
  type SortingState,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import { NativeSelect } from "./native-select";
import { PaginationControls } from "./pagination-controls";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

export interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  globalFilter?: string;
  globalFilterFn?: FilterFn<TData>;
  onGlobalFilterChange?: (next: string) => void;
  getRowId?: (row: TData) => string;
  onRowClick?: (row: TData) => void;
  onRowDoubleClick?: (row: TData) => void;
  rowDataTestId?: (row: TData) => string;
  emptyState?: ReactNode;
  pageSize?: number;
  manualPagination?: boolean;
  manualSorting?: boolean;
  manualFiltering?: boolean;
  pagination?: PaginationState;
  onPaginationChange?: OnChangeFn<PaginationState>;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  rowCount?: number;
  hidePagination?: boolean;
  tableClassName?: string;
  renderRow?: (row: TData) => ReactNode;
}

export function DataTable<TData, TValue>({
  columns,
  data,
  globalFilter,
  globalFilterFn,
  onGlobalFilterChange,
  getRowId,
  onRowClick,
  onRowDoubleClick,
  rowDataTestId,
  emptyState,
  pageSize = 25,
  manualPagination = false,
  manualSorting = false,
  manualFiltering = false,
  pagination: controlledPagination,
  onPaginationChange,
  sorting: controlledSorting,
  onSortingChange,
  rowCount,
  hidePagination = false,
  tableClassName,
  renderRow,
}: DataTableProps<TData, TValue>) {
  const { t } = useTranslation();
  const [localSorting, setSorting] = useState<SortingState>([]);
  const table = useReactTable({
    data,
    columns,
    state: {
      sorting: controlledSorting ?? localSorting,
      globalFilter,
      ...(controlledPagination ? { pagination: controlledPagination } : {}),
    },
    onSortingChange: onSortingChange ?? setSorting,
    ...(onPaginationChange ? { onPaginationChange } : {}),
    manualPagination,
    manualSorting,
    manualFiltering,
    rowCount,
    enableSorting: !manualSorting || !!onSortingChange,
    onGlobalFilterChange,
    ...(globalFilterFn ? { globalFilterFn } : {}),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    getRowId: getRowId ? (row) => getRowId(row) : undefined,
    initialState: { pagination: { pageSize } },
  });
  const total = rowCount ?? table.getFilteredRowModel().rows.length;
  const pagination = table.getState().pagination;

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <Table className={cn("w-full text-sm", total > 0 && "min-w-[640px]", tableClassName)}>
          <TableHeader className="border-b border-border text-left text-xs text-muted-foreground">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className="px-4 py-3 font-medium"
                      scope="col"
                      aria-sort={
                        sorted === "asc"
                          ? "ascending"
                          : sorted === "desc"
                            ? "descending"
                            : undefined
                      }
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() && total > 0 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="-ml-2 h-auto min-h-8 whitespace-normal px-2 text-left font-medium"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {sorted === "asc" ? (
                            <ArrowUp aria-hidden="true" />
                          ) : sorted === "desc" ? (
                            <ArrowDown aria-hidden="true" />
                          ) : (
                            <ArrowUpDown aria-hidden="true" className="opacity-50" />
                          )}
                        </Button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="px-4 py-16">
                  <div className="flex items-center justify-center px-4 py-8 text-center text-sm text-muted-foreground">
                    {emptyState ?? t("common.empty")}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row: Row<TData>) => (
                <TableRow
                  key={row.id}
                  data-testid={rowDataTestId ? rowDataTestId(row.original) : undefined}
                  className={cn(
                    "border-t border-border last:border-b-0",
                    onRowClick && "cursor-pointer transition-colors hover:text-brand",
                  )}
                  onClick={() => onRowClick?.(row.original)}
                  onDoubleClick={() => onRowDoubleClick?.(row.original)}
                >
                  {renderRow ? (
                    <TableCell colSpan={columns.length}>{renderRow(row.original)}</TableCell>
                  ) : (
                    row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="px-4 py-3">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground" aria-live="polite">
        {t("ui.resultCount", { count: total })}
      </p>
      {!hidePagination && (total > pageSize || table.getPageCount() > 1) ? (
        <div className="kq-fill-row gap-3 text-xs text-muted-foreground">
          <label className="flex items-center gap-2">
            {t("common.pagination.rowsPerPage")}
            <NativeSelect
              value={pagination.pageSize}
              onChange={(event) => table.setPageSize(Number(event.target.value))}
              className="h-8 text-xs"
            >
              {[...new Set([10, 25, 50, 100, pageSize])]
                .sort((a, b) => a - b)
                .map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
            </NativeSelect>
          </label>
          <PaginationControls
            previous={{
              onClick: () => table.previousPage(),
              disabled: !table.getCanPreviousPage(),
            }}
            next={{
              onClick: () => table.nextPage(),
              disabled: !table.getCanNextPage(),
            }}
          >
            <span aria-live="polite" className="tabular-nums">
              {t("common.pagination.page", {
                page: table.getState().pagination.pageIndex + 1,
                pages: table.getPageCount(),
              })}
            </span>
          </PaginationControls>
        </div>
      ) : null}
    </div>
  );
}
