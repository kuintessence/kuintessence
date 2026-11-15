import type { ColumnDef } from "@tanstack/react-table";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "./button";
import { EmptyState, ErrorState, LoadingState } from "./content-state";
import { DataTable, type DataTableProps } from "./data-table";
import { ListToolbar } from "./list-toolbar";

interface CollectionViewProps<T> {
  data: T[];
  queryMode?: "local" | "server";
  columns?: ColumnDef<T>[];
  renderItem?: (item: T) => ReactNode;
  getKey: (item: T) => string;
  matches?: (item: T, query: string) => boolean;
  search?: string;
  onSearchChange?: (query: string) => void;
  filters?: ReactNode;
  actions?: ReactNode;
  loading?: boolean;
  error?: ReactNode;
  errorTestId?: string;
  emptyTestId?: string;
  onRetry?: () => void;
  table?: Omit<DataTableProps<T, unknown>, "columns" | "data">;
  contentClassName?: string;
  "data-testid"?: string;
}

export function CollectionView<T>({
  data,
  queryMode = "local",
  columns,
  renderItem,
  getKey,
  matches,
  search,
  onSearchChange,
  filters,
  actions,
  loading,
  error,
  onRetry,
  errorTestId,
  emptyTestId,
  table,
  contentClassName,
  ...props
}: CollectionViewProps<T>) {
  const { t } = useTranslation();
  const [localSearch, setLocalSearch] = useState("");
  const query = search ?? localSearch;
  const changeSearch = onSearchChange ?? setLocalSearch;
  const server = queryMode === "server";
  const filtered =
    matches && !server
      ? data.filter((item) => matches(item, query.trim().toLocaleLowerCase()))
      : data;
  return (
    <div className="min-w-0 space-y-4">
      <ListToolbar
        search={{
          value: query,
          "aria-label": t("ui.search"),
          placeholder: t("ui.searchPlaceholder"),
          onChange: (event) => changeSearch(event.target.value),
        }}
        actions={actions}
      >
        {filters}
      </ListToolbar>
      {error ? (
        <ErrorState
          data-testid={errorTestId}
          actions={
            onRetry ? (
              <Button type="button" onClick={onRetry}>
                {t("common.retry")}
              </Button>
            ) : null
          }
        >
          {error}
        </ErrorState>
      ) : loading ? (
        <LoadingState>{t("common.loading")}</LoadingState>
      ) : columns ? (
        <DataTable
          {...table}
          columns={columns}
          renderRow={renderItem}
          data={filtered}
          getRowId={getKey}
          globalFilter={matches || server ? undefined : query}
          manualFiltering={server || table?.manualFiltering}
          manualPagination={server || table?.manualPagination}
          manualSorting={server || table?.manualSorting}
        />
      ) : filtered.length ? (
        <div className={contentClassName ?? "divide-y divide-border"} {...props}>
          {filtered.map((item) => (
            <div key={getKey(item)}>{renderItem?.(item)}</div>
          ))}
        </div>
      ) : (
        <EmptyState
          data-testid={emptyTestId}
          title={query ? t("ui.noMatches") : t("common.empty")}
          actions={
            query ? (
              <Button type="button" variant="ghost" onClick={() => changeSearch("")}>
                {t("ui.clearFilters")}
              </Button>
            ) : undefined
          }
        />
      )}
      {!columns && !loading && !error ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {t("ui.resultCount", { count: filtered.length })}
        </p>
      ) : null}
    </div>
  );
}
