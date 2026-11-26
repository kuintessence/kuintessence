import type { ColumnDef } from "@tanstack/react-table";
import { Check, ChevronsUpDown, Expand, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useActiveOrganizationId } from "../../lib/active-organization";
import { getAuthState, subscribeAuthState } from "../../lib/auth";
import {
  readRecentSelections,
  recentSelectionKey,
  rememberSelection,
} from "../../lib/recent-selections";
import { cn } from "../../lib/utils";
import { Button } from "./button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./command";
import { ErrorState, LoadingState } from "./content-state";
import { DataTable, type DataTableProps } from "./data-table";
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from "./dialog";
import { ListToolbar } from "./list-toolbar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

export interface ResourceOption {
  value: string;
  label: string;
  description?: string;
  keywords?: string[];
  disabled?: boolean;
  disabledReason?: string;
}

type PickerTableQuery<T> = Pick<
  DataTableProps<T, unknown>,
  | "pagination"
  | "onPaginationChange"
  | "sorting"
  | "onSortingChange"
  | "rowCount"
  | "hidePagination"
>;

interface ResourcePickerDialogProps<T extends ResourceOption> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  options: T[];
  value: string[];
  onConfirm: (values: string[]) => void;
  title: string;
  multiple?: boolean;
  columns?: ColumnDef<T>[];
  filters?: ReactNode;
  filterOption?: (option: T) => boolean;
  search?: string;
  onSearchChange?: (query: string) => void;
  queryMode?: "local" | "server";
  tableQuery?: PickerTableQuery<T>;
  loading?: boolean;
  error?: ReactNode;
  onRetry?: () => void;
  busy?: boolean;
  closeOnConfirm?: boolean;
  confirmTestId?: string;
  confirmLabel?: string;
  selectionError?: { value: string; message: string } | null;
  rowTestId?: (option: T) => string;
  onDoubleClick?: (option: T) => void;
  "data-testid"?: string;
}

export function ResourcePickerDialog<T extends ResourceOption>({
  open,
  onOpenChange,
  options,
  value,
  onConfirm,
  title,
  multiple = false,
  columns,
  filters,
  filterOption,
  search,
  onSearchChange,
  queryMode = "local",
  tableQuery,
  loading,
  error,
  onRetry,
  busy,
  closeOnConfirm = true,
  confirmTestId,
  confirmLabel,
  selectionError,
  rowTestId,
  onDoubleClick,
  "data-testid": testId,
}: ResourcePickerDialogProps<T>) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const [localQuery, setQuery] = useState(search ?? "");
  const query = search ?? localQuery;
  const selectionName = useId();
  const previousOpen = useRef(false);
  useEffect(() => {
    if (open && !previousOpen.current) {
      setDraft(value);
      setQuery(search ?? "");
    }
    previousOpen.current = open;
  }, [open, value, search]);
  const select = (option: T) => {
    if (option.disabled || busy) return;
    setDraft((current) =>
      multiple
        ? current.includes(option.value)
          ? current.filter((id) => id !== option.value)
          : [...current, option.value]
        : [option.value],
    );
  };
  const valid =
    (multiple || draft.length > 0) &&
    draft.every((id) => options.some((o) => o.value === id && !o.disabled));
  const selectionColumn: ColumnDef<T> = {
    id: "selection",
    enableSorting: false,
    header: () => <span className="sr-only">{t("ui.choose")}</span>,
    cell: ({ row }) => (
      <input
        type={multiple ? "checkbox" : "radio"}
        name={selectionName}
        checked={draft.includes(row.original.value)}
        disabled={row.original.disabled || busy}
        aria-label={row.original.label}
        onClick={(event) => event.stopPropagation()}
        onChange={() => select(row.original)}
      />
    ),
  };
  const defaultColumns: ColumnDef<T>[] = [
    {
      id: "label",
      accessorFn: (option) => option.label,
      header: t("ui.name"),
      cell: ({ row }) => (
        <div className="min-w-0 space-y-1">
          <span className={row.original.disabled ? "text-muted-foreground" : "font-medium"}>
            {row.original.label}
          </span>
          {row.original.description ? (
            <p className="text-xs text-muted-foreground">{row.original.description}</p>
          ) : null}
          {row.original.disabledReason ? (
            <p className="text-xs text-status-failed">{row.original.disabledReason}</p>
          ) : null}
        </div>
      ),
      filterFn: (row, _columnId, filter: string) =>
        [
          row.original.label,
          row.original.value,
          row.original.description,
          ...(row.original.keywords ?? []),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(filter.trim().toLocaleLowerCase()),
    },
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[min(calc(100vw-1rem),64rem)]"
        data-testid={testId}
        aria-describedby={undefined}
        dismissible={!busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <ListToolbar
            search={{
              value: query,
              "aria-label": t("ui.search"),
              placeholder: t("ui.searchPlaceholder"),
              onChange: (event) => {
                setQuery(event.target.value);
                onSearchChange?.(event.target.value);
              },
            }}
          >
            {filters}
          </ListToolbar>
          {error ? (
            <ErrorState
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
          ) : (
            <DataTable
              columns={[selectionColumn, ...(columns ?? defaultColumns)]}
              tableClassName={
                columns
                  ? undefined
                  : "min-w-0 table-fixed [&_th:first-child]:w-12 [&_td]:break-words"
              }
              {...tableQuery}
              manualFiltering={queryMode === "server"}
              manualPagination={queryMode === "server"}
              manualSorting={queryMode === "server"}
              data={filterOption && queryMode === "local" ? options.filter(filterOption) : options}
              getRowId={(option) => option.value}
              rowDataTestId={rowTestId}
              globalFilter={queryMode === "server" ? undefined : query}
              onRowClick={busy ? undefined : select}
              onRowDoubleClick={
                busy
                  ? undefined
                  : (option) => {
                      if (!option.disabled) onDoubleClick?.(option);
                    }
              }
              globalFilterFn={(row, _id, needle: string) =>
                [
                  row.original.label,
                  row.original.value,
                  row.original.description,
                  ...(row.original.keywords ?? []),
                ]
                  .join(" ")
                  .toLocaleLowerCase()
                  .includes(needle.trim().toLocaleLowerCase())
              }
              pageSize={10}
            />
          )}
        </DialogBody>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border p-4">
          <div className="min-w-0 text-xs text-muted-foreground" aria-live="polite">
            {t("ui.selectedCount", { count: draft.length })}
            <span className="ml-2 [overflow-wrap:anywhere]">
              {draft
                .map((id) => options.find((option) => option.value === id)?.label ?? id)
                .join(", ")}
            </span>
            {!loading && !error && selectionError && draft.includes(selectionError.value) ? (
              <p role="alert" className="mt-1 text-status-failed">
                {selectionError.message}
              </p>
            ) : null}
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              data-testid={confirmTestId}
              disabled={!valid || loading || !!error || busy}
              onClick={() => {
                onConfirm(draft);
                if (closeOnConfirm) onOpenChange(false);
              }}
            >
              {confirmLabel ?? t("common.confirm")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export interface ResourceSelectProps<T extends ResourceOption> {
  options: T[];
  value: string;
  onValueChange: (value: string) => void;
  id?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  searchable?: boolean;
  recent?: boolean;
  resourceType?: string;
  clearable?: boolean;
  expandable?: boolean;
  presentation?: "dropdown" | "dialog";
  renderOption?: (option: T) => ReactNode;
  renderSelected?: (option: T) => ReactNode;
  columns?: ColumnDef<T>[];
  filters?: ReactNode;
  filterOption?: (option: T) => boolean;
  search?: string;
  onSearchChange?: (query: string) => void;
  queryMode?: "local" | "server";
  tableQuery?: PickerTableQuery<T>;
  loading?: boolean;
  error?: ReactNode;
  onRetry?: () => void;
  "data-testid"?: string;
  "aria-label"?: string;
  "aria-required"?: boolean;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling";
}

export function ResourceSelect<T extends ResourceOption>({
  options,
  value,
  onValueChange,
  id,
  name,
  label,
  placeholder,
  disabled,
  required,
  className,
  searchable = true,
  recent = false,
  resourceType = "resource",
  clearable = false,
  expandable = false,
  presentation = "dropdown",
  renderOption,
  renderSelected,
  columns,
  filters,
  filterOption,
  search,
  onSearchChange,
  queryMode = "local",
  tableQuery,
  loading,
  error,
  onRetry,
  ...aria
}: ResourceSelectProps<T>) {
  const { t } = useTranslation();
  const userId = useSyncExternalStore(
    subscribeAuthState,
    () => getAuthState().email ?? "",
    () => "",
  );
  const organizationId = useActiveOrganizationId();
  const scope = { userId, organizationId, resourceType };

  const scopeKey = recentSelectionKey(scope);
  const [recentState, setRecentState] = useState<{ key: string; ids: string[] }>({
    key: "",
    ids: [],
  });
  const recentIds = recentState.key === scopeKey ? recentState.ids : [];
  const [open, setOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [localQuery, setQuery] = useState(search ?? "");
  const query = search ?? localQuery;
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setRecentState({
      key: scopeKey,
      ids: recent && userId ? readRecentSelections({ userId, organizationId, resourceType }) : [],
    });
  }, [recent, userId, organizationId, resourceType, scopeKey]);
  const selected = options.find((option) => option.value === value);
  const visibleRecents =
    !query.trim() && recent
      ? recentIds.flatMap((key) =>
          options.filter((option) => option.value === key && !option.disabled),
        )
      : [];
  const choose = (key: string) => {
    const option = options.find((candidate) => candidate.value === key);
    if (key && (!option || option.disabled)) return;
    if (recent && userId && key)
      setRecentState({ key: scopeKey, ids: rememberSelection(scope, key) });
    onValueChange(key);
    setOpen(false);
  };
  const title = label ?? aria["aria-label"] ?? placeholder ?? t("ui.choose");
  const item = (option: T) => (
    <CommandItem
      key={option.value}
      value={option.value}
      keywords={[option.label, option.description ?? "", ...(option.keywords ?? [])]}
      disabled={option.disabled}
      onSelect={() => choose(option.value)}
    >
      <Check
        className={cn("h-4 w-4 shrink-0", value === option.value ? "opacity-100" : "opacity-0")}
        aria-hidden
      />
      <div className="min-w-0 flex-1 break-words">
        {renderOption ? (
          renderOption(option)
        ) : (
          <>
            <span>{option.label}</span>
            {option.description ? (
              <p className="mt-1 text-xs text-muted-foreground">{option.description}</p>
            ) : null}
          </>
        )}
        {option.disabledReason ? (
          <p className="mt-1 text-xs text-status-failed">{option.disabledReason}</p>
        ) : null}
      </div>
    </CommandItem>
  );
  const trigger = (
    <Button
      ref={triggerRef}
      id={id}
      value={value}
      aria-required={required}
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={presentation === "dialog" ? dialogOpen : open}
      aria-haspopup="dialog"
      aria-label={label}
      disabled={disabled}
      className={cn("w-full min-w-0 justify-between font-normal", className)}
      onClick={presentation === "dialog" ? () => setDialogOpen(true) : undefined}
      {...aria}
      aria-invalid={
        aria["aria-invalid"] ??
        (value && !loading && !error && (!selected || selected.disabled) ? true : undefined)
      }
    >
      <span className="min-w-0 truncate text-left">
        {selected
          ? (renderSelected?.(selected) ?? selected.label)
          : value || placeholder || t("ui.choose")}
      </span>
      <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
    </Button>
  );
  return (
    <>
      {name || required ? (
        <select
          aria-hidden
          tabIndex={-1}
          className="sr-only"
          name={name}
          required={required}
          disabled={disabled}
          value={selected && !selected.disabled ? value : ""}
          onChange={(event) => choose(event.target.value)}
          onInvalid={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
        >
          <option value="" />
          {options.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
        </select>
      ) : null}
      {presentation === "dialog" ? (
        trigger
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
          <PopoverContent
            aria-label={title}
            onCloseAutoFocus={(event) => {
              if (dialogOpen) event.preventDefault();
            }}
          >
            <Command
              tabIndex={searchable ? undefined : 0}
              shouldFilter={queryMode === "local"}
              label={t("ui.search")}
            >
              {searchable ? (
                <CommandInput
                  value={query}
                  onValueChange={(next) => {
                    setQuery(next);
                    onSearchChange?.(next);
                  }}
                  placeholder={t("ui.searchPlaceholder")}
                  aria-label={t("ui.search")}
                />
              ) : null}
              {error ? (
                <ErrorState
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
              ) : (
                <CommandList aria-label={title}>
                  <CommandEmpty className="px-3 py-8 text-center text-sm text-muted-foreground">
                    {t("ui.noMatches")}
                  </CommandEmpty>
                  {visibleRecents.length ? (
                    <CommandGroup heading={t("ui.recent")}>{visibleRecents.map(item)}</CommandGroup>
                  ) : null}
                  <CommandGroup heading={visibleRecents.length ? t("ui.allOptions") : undefined}>
                    {options
                      .filter((option) => !visibleRecents.some((r) => r.value === option.value))
                      .map(item)}
                  </CommandGroup>
                </CommandList>
              )}
            </Command>
            {clearable || expandable ? (
              <div className="flex flex-wrap justify-between gap-2 border-t border-border p-2">
                {clearable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    disabled={required || !value}
                    onClick={() => choose("")}
                  >
                    <X className="h-4 w-4" />
                    {t("ui.clear")}
                  </Button>
                ) : null}
                {expandable ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      setDialogOpen(true);
                    }}
                  >
                    <Expand className="h-4 w-4" />
                    {t("ui.expand")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </PopoverContent>
        </Popover>
      )}
      {value && !loading && !error && (!selected || selected.disabled) ? (
        <p role="alert" className="text-xs text-status-failed">
          {selected?.disabledReason ?? t("ui.unavailable")}
        </p>
      ) : null}
      <ResourcePickerDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        options={options}
        value={value ? [value] : []}
        onConfirm={(values) => choose(values[0] ?? "")}
        title={title}
        columns={columns}
        filters={filters}
        filterOption={filterOption}
        search={query}
        onSearchChange={(next) => {
          setQuery(next);
          onSearchChange?.(next);
        }}
        queryMode={queryMode}
        tableQuery={tableQuery}
        loading={loading}
        error={error}
        onRetry={onRetry}
      />
    </>
  );
}
