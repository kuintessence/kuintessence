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
  resizable?: boolean;
  pinnedEndColumn?: string;
  caption?: string;
  scrollTestId?: string;
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
  resizable = false,
  pinnedEndColumn,
  caption,
  scrollTestId,
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
    enableColumnResizing: resizable,
    columnResizeMode: "onChange",
    defaultColumn: { minSize: 96, maxSize: 640 },
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
      <div className="min-w-0 overflow-x-auto overscroll-x-contain" data-testid={scrollTestId}>
        <Table
          className={cn(
            "w-full text-sm",
            resizable ? "table-fixed" : total > 0 && "min-w-[640px]",
            tableClassName,
          )}
          style={resizable ? { minWidth: table.getTotalSize() } : undefined}
        >
          {caption && <caption className="sr-only">{caption}</caption>}
          {resizable && (
            <colgroup>
              {table.getVisibleLeafColumns().map((column) => (
                <col key={column.id} style={{ width: column.getSize() }} />
              ))}
            </colgroup>
          )}
          <TableHeader className="border-b border-border text-left text-xs text-muted-foreground">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => {
                  const sorted = header.column.getIsSorted();
                  return (
                    <TableHead
                      key={header.id}
                      className={cn(
                        "relative px-4 py-2 font-medium",
                        header.column.id === pinnedEndColumn && "kq-pinned-end",
                      )}
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
                          className="-ml-2 h-auto min-h-8 max-w-full justify-start whitespace-normal px-2 text-left font-medium"
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
                      {header.column.getCanResize() && !header.isPlaceholder && (
                        <hr
                          tabIndex={0}
                          aria-label={t("ui.resizeColumn", {
                            column:
                              typeof header.column.columnDef.header === "string"
                                ? header.column.columnDef.header
                                : header.column.id,
                          })}
                          aria-orientation="vertical"
                          aria-valuemin={header.column.columnDef.minSize}
                          aria-valuemax={header.column.columnDef.maxSize}
                          aria-valuenow={Math.round(header.getSize())}
                          className="absolute inset-y-0 right-0 z-10 m-0 h-full w-3 cursor-col-resize touch-none select-none border-0 border-r border-border hover:border-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
                          onMouseDown={header.getResizeHandler()}
                          onTouchStart={header.getResizeHandler()}
                          onDoubleClick={() => header.column.resetSize()}
                          onKeyDown={(event) => {
                            if (event.key === "Home") {
                              event.preventDefault();
                              header.column.resetSize();
                              return;
                            }
                            const delta =
                              event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
                            if (!delta) return;
                            event.preventDefault();
                            const { minSize = 96, maxSize = 640 } = header.column.columnDef;
                            table.setColumnSizing((sizes) => ({
                              ...sizes,
                              [header.column.id]: Math.min(
                                maxSize,
                                Math.max(minSize, header.getSize() + delta),
                              ),
                            }));
                          }}
                        />
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
                      <TableCell
                        key={cell.id}
                        className={cn(
                          "px-4 py-3",
                          resizable && "[overflow-wrap:anywhere]",
                          cell.column.id === pinnedEndColumn && "kq-pinned-end",
                        )}
                      >
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
