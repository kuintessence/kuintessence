import {
  History,
  Loader2,
  PackageCheck,
  Play,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { SoftwareOperation, SoftwareOperationAction } from "../../lib/cp-client";
import { toUserFacingError } from "../../lib/user-facing-error";
import { Badge, badgeVariants } from "../ui/badge";
import { Button } from "../ui/button";
import { NativeSelect } from "../ui/native-select";
import { RefreshButton } from "../ui/refresh-button";
import { SearchInput } from "../ui/search-input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";

export const SOFTWARE_OPERATION_ACTIONS: SoftwareOperationAction[] = [
  "install",
  "uninstall",
  "load",
  "import_preinstalled",
];

const COLLAPSED_OPERATION_HISTORY_LIMIT = 12;

const MAX_INLINE_OPERATION_FAILURE_LENGTH = 160;

export function policyRejectionMessage(
  reason: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (reason === "spec is empty") return t("cp.software.operations.policyReason.specEmpty");
  if (reason === "install lock enabled and no allowList configured") {
    return t("cp.software.operations.policyReason.lockWithoutAllowList");
  }
  if (/^spec '.+' matches denyList$/.test(reason)) {
    return t("cp.software.operations.policyReason.denyList");
  }
  if (/^spec '.+' not in allowList(?: while lock enabled)?$/.test(reason)) {
    return t("cp.software.operations.policyReason.allowList");
  }
  return t("cp.software.operations.policyReason.generic");
}

export function formatSoftwareOperationFailure(
  operation: SoftwareOperation,
  fallback: string,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return operation.status === "rejected" && isKnownPolicyRejection(operation.error)
    ? policyRejectionMessage(operation.error, t)
    : fallback;
}

function isKnownPolicyRejection(reason: string | null): reason is string {
  if (!reason) return false;
  return (
    reason === "spec is empty" ||
    reason === "install lock enabled and no allowList configured" ||
    /^spec '.+' matches denyList$/.test(reason) ||
    /^spec '.+' not in allowList(?: while lock enabled)?$/.test(reason)
  );
}

export function isFailedOperation(operation: SoftwareOperation): boolean {
  return operation.status === "failed" || operation.status === "rejected";
}

export function OperationHistory({
  controlChannelOnline,
  operations,
  actionFilter,
  onActionFilterChange,
  statusFilter,
  onStatusFilterChange,
  loading,
  error,
  onRefresh,
  onRetry,
  refreshing,
}: {
  controlChannelOnline: boolean;
  operations: SoftwareOperation[];
  actionFilter: SoftwareOperationAction | null;
  onActionFilterChange: (action: SoftwareOperationAction | null) => void;
  statusFilter: SoftwareOperation["status"] | null;
  onStatusFilterChange: (status: SoftwareOperation["status"] | null) => void;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
  onRetry: (operation: SoftwareOperation) => void;
  refreshing: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLowerCase();
  const filteredOperations =
    normalizedFilter.length === 0
      ? operations
      : operations.filter((operation) =>
          operationMatchesHistoryFilter(operation, normalizedFilter),
        );
  const visibleOperations = expanded
    ? filteredOperations
    : filteredOperations.slice(0, COLLAPSED_OPERATION_HISTORY_LIMIT);
  const hasHiddenOperations = filteredOperations.length > COLLAPSED_OPERATION_HISTORY_LIMIT;
  const showFilter =
    operations.length > COLLAPSED_OPERATION_HISTORY_LIMIT || normalizedFilter.length > 0;
  const hasServerFilter = actionFilter !== null || statusFilter !== null;
  const changeActionFilter = (action: SoftwareOperationAction | null) => {
    onActionFilterChange(action);
    setFilter("");
    setExpanded(false);
  };
  const clearStatusFilter = () => {
    onStatusFilterChange(null);
    setFilter("");
    setExpanded(false);
  };
  const clearAllServerFilters = () => {
    onActionFilterChange(null);
    onStatusFilterChange(null);
    setFilter("");
    setExpanded(false);
  };
  const activeServerFilters = hasServerFilter ? (
    <OperationHistoryActiveServerFilters
      actionFilter={actionFilter}
      onClearActionFilter={() => changeActionFilter(null)}
      statusFilter={statusFilter}
      onClearStatusFilter={clearStatusFilter}
      onClearAll={clearAllServerFilters}
    />
  ) : null;
  if (loading) {
    return (
      <div className="space-y-2">
        <OperationHistoryToolbar
          onRefresh={onRefresh}
          refreshing={refreshing}
          actionFilter={actionFilter}
          onActionFilterChange={changeActionFilter}
        />
        {activeServerFilters}
        <div className="text-sm text-muted-foreground">{t("cp.common.loading")}</div>
      </div>
    );
  }
  if (error && operations.length === 0) {
    return (
      <div className="space-y-2">
        <OperationHistoryToolbar
          onRefresh={onRefresh}
          refreshing={refreshing}
          actionFilter={actionFilter}
          onActionFilterChange={changeActionFilter}
        />
        {activeServerFilters}
        <div className=" px-3 py-2 text-sm text-status-failed">
          {toUserFacingError(error, t("cp.software.operations.failed"))}
        </div>
      </div>
    );
  }
  if (operations.length === 0) {
    return (
      <div className="space-y-2">
        <OperationHistoryToolbar
          onRefresh={onRefresh}
          refreshing={refreshing}
          actionFilter={actionFilter}
          onActionFilterChange={changeActionFilter}
        />
        {activeServerFilters}
        <div className="flex h-24 items-center justify-center border-border text-sm text-muted-foreground">
          <History className="h-4 w-4" />
          {t(
            hasServerFilter
              ? "cp.software.operations.historyFilterEmpty"
              : "cp.software.operations.empty",
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <OperationHistoryToolbar
        onRefresh={onRefresh}
        refreshing={refreshing}
        actionFilter={actionFilter}
        onActionFilterChange={changeActionFilter}
      />
      {activeServerFilters}
      {error ? (
        <div className=" px-3 py-2 text-xs text-status-failed">
          {toUserFacingError(error, t("cp.software.operations.failed"))}
        </div>
      ) : null}
      <OperationHistoryStatusSummary
        operations={operations}
        onStatusSelect={(status) => {
          onStatusFilterChange(status);
          setFilter("");
          setExpanded(false);
        }}
        statusFilter={statusFilter}
      />
      {showFilter ? (
        <div className="grid gap-1.5">
          <div className="relative">
            <SearchInput
              aria-label={t("cp.software.operations.historyFilterPlaceholder")}
              value={filter}
              onChange={(event) => {
                setFilter(event.target.value);
                setExpanded(false);
              }}
              placeholder={t("cp.software.operations.historyFilterPlaceholder")}
              className="pr-9 font-mono text-xs"
              data-testid="cp-software-operation-history-filter"
            />
            {normalizedFilter.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2 p-0"
                onClick={() => {
                  setFilter("");
                  setExpanded(false);
                }}
                title={t("cp.software.operations.historyFilterClear")}
                data-testid="cp-software-operation-history-filter-clear"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
          {normalizedFilter.length > 0 ? (
            <div className="text-xs text-muted-foreground">
              {t("cp.software.operations.historyFilterCount", {
                count: filteredOperations.length,
                total: operations.length,
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {visibleOperations.length > 0 ? (
        <div
          className="overflow-x-auto overscroll-x-contain border-border"
          data-testid="cp-software-history-table-scroll"
        >
          <Table className="min-w-[40rem] w-full text-xs">
            <TableHeader className=" text-left uppercase tracking-wide text-muted-foreground">
              <TableRow>
                <TableHead className="px-2 py-2">
                  {t("cp.software.operations.col.action")}
                </TableHead>
                <TableHead className="px-2 py-2">{t("cp.software.operations.col.spec")}</TableHead>
                <TableHead className="px-2 py-2">
                  {t("cp.software.operations.col.status")}
                </TableHead>
                <TableHead className="px-2 py-2">
                  {t("cp.software.operations.col.updatedAt")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleOperations.map((operation) => (
                <OperationHistoryRow
                  key={operation.id}
                  controlChannelOnline={controlChannelOnline}
                  operation={operation}
                  onRetry={onRetry}
                  retryDisabled={error !== null}
                />
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex h-20 items-center justify-center border-border text-sm text-muted-foreground">
          {t("cp.software.operations.historyFilterEmpty")}
        </div>
      )}
      {hasHiddenOperations ? (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded
              ? t("cp.software.operations.historyShowLess", {
                  count: COLLAPSED_OPERATION_HISTORY_LIMIT,
                })
              : t("cp.software.operations.historyShowAll", { count: filteredOperations.length })}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const SOFTWARE_OPERATION_STATUS_ORDER = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "rejected",
] satisfies SoftwareOperation["status"][];

function OperationHistoryStatusSummary({
  operations,
  onStatusSelect,
  statusFilter,
}: {
  operations: SoftwareOperation[];
  onStatusSelect: (status: SoftwareOperation["status"]) => void;
  statusFilter: SoftwareOperation["status"] | null;
}) {
  const { t } = useTranslation();
  const counts = countSoftwareOperationStatuses(operations);
  return (
    <div className="kq-fill-row gap-1.5" data-testid="cp-software-operation-status-summary">
      {SOFTWARE_OPERATION_STATUS_ORDER.map((status) => {
        const count = counts[status] ?? 0;
        if (count === 0) return null;
        return (
          <button
            key={status}
            type="button"
            className={`${badgeVariants({ variant: operationStatusVariant(status) })} ${
              statusFilter === status ? "ring-2 ring-[var(--ring)] ring-offset-1" : ""
            }`}
            onClick={() => onStatusSelect(status)}
            title={t("cp.software.operations.historyFilterStatus", {
              status: t(`cp.software.operations.status.${status}`),
            })}
            data-testid={`cp-software-operation-status-summary-${status}`}
          >
            {t(`cp.software.operations.status.${status}`)}: {count}
          </button>
        );
      })}
    </div>
  );
}

function countSoftwareOperationStatuses(
  operations: SoftwareOperation[],
): Partial<Record<SoftwareOperation["status"], number>> {
  const counts: Partial<Record<SoftwareOperation["status"], number>> = {};
  for (const operation of operations) {
    counts[operation.status] = (counts[operation.status] ?? 0) + 1;
  }
  return counts;
}

function operationMatchesHistoryFilter(
  operation: SoftwareOperation,
  normalizedFilter: string,
): boolean {
  return [
    operation.action,
    operation.status,
    operation.spec,
    operation.requestedBy ?? "",
    operation.exitCode === null ? "" : String(operation.exitCode),
  ].some((value) => value.toLowerCase().includes(normalizedFilter));
}

function OperationHistoryToolbar({
  onRefresh,
  refreshing,
  actionFilter,
  onActionFilterChange,
}: {
  onRefresh: () => void;
  refreshing: boolean;
  actionFilter: SoftwareOperationAction | null;
  onActionFilterChange: (action: SoftwareOperationAction | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-xs font-medium">{t("cp.software.operations.historyTitle")}</div>
      </div>
      <div className="kq-fill-row">
        <NativeSelect
          className="h-8 text-xs"
          value={actionFilter ?? "all"}
          onChange={(event) =>
            onActionFilterChange(
              event.target.value === "all" ? null : (event.target.value as SoftwareOperationAction),
            )
          }
          title={t("cp.software.operations.historyActionFilter")}
          data-testid="cp-software-operation-action-filter"
        >
          <option value="all">{t("cp.software.operations.historyActionFilterAll")}</option>
          {SOFTWARE_OPERATION_ACTIONS.map((action) => (
            <option key={action} value={action}>
              {t(`cp.software.operations.action.${action}`)}
            </option>
          ))}
        </NativeSelect>
        <RefreshButton
          type="button"
          variant="outline"
          onClick={onRefresh}
          disabled={refreshing}
          title={t("cp.software.operations.historyRefresh")}
          label={t("cp.software.operations.historyRefresh")}
        >
          <RefreshCw className={refreshing ? "animate-spin" : ""} />
        </RefreshButton>
      </div>
    </div>
  );
}

function OperationHistoryActiveServerFilters({
  actionFilter,
  onClearActionFilter,
  statusFilter,
  onClearStatusFilter,
  onClearAll,
}: {
  actionFilter: SoftwareOperationAction | null;
  onClearActionFilter: () => void;
  statusFilter: SoftwareOperation["status"] | null;
  onClearStatusFilter: () => void;
  onClearAll: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-2 border-border px-3 py-2 text-xs">
      <span className="font-medium text-muted-foreground">
        {t("cp.software.operations.historyServerFilters")}
      </span>
      {actionFilter ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1"
          onClick={onClearActionFilter}
          data-testid="cp-software-operation-action-filter-clear"
          title={t("cp.software.operations.historyServerActionFilterClear")}
        >
          {t("cp.software.operations.historyServerActionFilter", {
            action: t(`cp.software.operations.action.${actionFilter}`),
          })}
          <X className="h-3 w-3" />
        </button>
      ) : null}
      {statusFilter ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded border border-border bg-background px-2 py-1"
          onClick={onClearStatusFilter}
          data-testid="cp-software-operation-status-filter-clear"
          title={t("cp.software.operations.historyServerStatusFilterClear")}
        >
          {t("cp.software.operations.historyServerStatusFilter", {
            status: t(`cp.software.operations.status.${statusFilter}`),
          })}
          <X className="h-3 w-3" />
        </button>
      ) : null}
      {actionFilter && statusFilter ? (
        <button type="button" className="text-brand hover:underline" onClick={onClearAll}>
          {t("cp.software.operations.historyServerFiltersClearAll")}
        </button>
      ) : null}
    </div>
  );
}

function OperationHistoryRow({
  controlChannelOnline,
  operation,
  onRetry,
  retryDisabled,
}: {
  controlChannelOnline: boolean;
  operation: SoftwareOperation;
  onRetry: (operation: SoftwareOperation) => void;
  retryDisabled: boolean;
}) {
  const { t } = useTranslation();
  const deliveryUncertain = operation.status === "queued" && !controlChannelOnline;
  const failureSummary = operationFailureSummary(operation, t("cp.software.operations.failed"), t);
  const hasDetails =
    deliveryUncertain ||
    Boolean(operation.requestedBy) ||
    isFailedOperation(operation) ||
    operation.exitCode !== null;
  const retryable = !operation.auditOnly && isFailedOperation(operation);
  return (
    <>
      <TableRow className=" border-border" data-testid={`cp-software-operation-${operation.id}`}>
        <TableCell className="px-2 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span>
              <OperationActionIcon action={operation.action} />
              {operation.auditOnly
                ? t("cp.software.operations.sourceAudit")
                : t(`cp.software.operations.action.${operation.action}`)}
            </span>
            {retryable ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onRetry(operation)}
                title={t("cp.software.operations.retry")}
                disabled={retryDisabled}
                data-testid={`cp-software-operation-retry-${operation.id}`}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t("cp.software.operations.retry")}
              </Button>
            ) : null}
          </div>
        </TableCell>
        <TableCell className="max-w-64 truncate px-2 py-2 font-mono">{operation.spec}</TableCell>
        <TableCell
          className="px-2 py-2"
          data-testid={`cp-software-operation-status-${operation.id}`}
        >
          <OperationStatusBadge operation={operation} />
          {operation.auditStatus === "passed" ? (
            <div className="mt-1 max-w-56 text-[11px] text-muted-foreground">
              {t("cp.software.operations.auditNotInstalled")}
            </div>
          ) : null}
          {failureSummary ? (
            <div
              className="mt-1 max-w-56 truncate text-[11px] text-status-failed"
              data-testid={`cp-software-operation-error-summary-${operation.id}`}
              title={failureSummary}
            >
              {failureSummary}
            </div>
          ) : null}
          {deliveryUncertain ? (
            <div
              className="mt-1 max-w-56 truncate text-[11px] text-[var(--status-pending)]"
              data-testid={`cp-software-operation-delivery-summary-${operation.id}`}
              title={t("cp.software.operations.queuedDeliveryUncertain")}
            >
              {t("cp.software.operations.queuedDeliveryUncertainShort")}
            </div>
          ) : null}
        </TableCell>
        <TableCell className="px-2 py-2 font-mono text-muted-foreground">
          {new Date(operation.updatedAt).toLocaleString()}
        </TableCell>
      </TableRow>
      {hasDetails ? (
        <TableRow className=" border-border ">
          <TableCell colSpan={4} className="px-2 py-2">
            <details>
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                {t("cp.software.operations.details")}
              </summary>
              <div className="mt-2 grid gap-2 md:grid-cols-3">
                {deliveryUncertain ? (
                  <div className=" border-border p-2 text-xs text-muted-foreground md:col-span-3">
                    {t("cp.software.operations.queuedDeliveryUncertain")}
                  </div>
                ) : null}
                {isFailedOperation(operation) ? (
                  <div className=" p-2 text-xs text-status-failed md:col-span-3">
                    {formatSoftwareOperationFailure(
                      operation,
                      t("cp.software.operations.failed"),
                      t,
                    )}
                  </div>
                ) : null}
              </div>
              <div className="mt-2 text-xs text-muted-foreground">
                {t("cp.software.operations.requestedBy")}:{" "}
                <span className="font-mono">{operation.requestedBy ?? "-"}</span>
                {operation.exitCode !== null ? (
                  <>
                    {" · "}
                    {t("cp.software.operations.exitCode")}:{" "}
                    <span className="font-mono">{operation.exitCode}</span>
                  </>
                ) : null}
              </div>
            </details>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}

function operationFailureSummary(
  operation: SoftwareOperation,
  fallback: string,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  if (!isFailedOperation(operation)) return null;
  return truncateInlineText(
    formatSoftwareOperationFailure(operation, fallback, t),
    MAX_INLINE_OPERATION_FAILURE_LENGTH,
  );
}

function truncateInlineText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function OperationActionIcon({ action }: { action: SoftwareOperationAction }) {
  const className = "mr-1 inline h-3.5 w-3.5";
  if (action === "uninstall") return <Trash2 className={className} />;
  if (action === "load") return <PackageCheck className={className} />;
  if (action === "import_preinstalled") return <Upload className={className} />;
  return <Play className={className} />;
}

function OperationStatusBadge({ operation }: { operation: SoftwareOperation }) {
  const { t } = useTranslation();
  return (
    <Badge variant={operationStatusVariant(operation.status)}>
      {operation.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
      {operation.auditStatus === "passed"
        ? t("cp.software.operations.auditPassed")
        : t(`cp.software.operations.status.${operation.status}`)}
    </Badge>
  );
}

function operationStatusVariant(status: SoftwareOperation["status"]) {
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "rejected") return "failed";
  if (status === "running") return "brand";
  return "outline";
}
